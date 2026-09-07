// services/marketplace/listing.query.service.js
//
// Platform-AGNOSTIC listing browse/read/delete/push — the counterpart to
// each platform's own CREATE endpoint (ebay.listing.service.js, google's
// upcoming equivalent), which stay platform-specific because the fields a
// tenant fills in to author a NEW listing genuinely differ per platform
// (eBay: category/fitment/policies; Google: GTIN/MPN/condition, mostly
// derived from the product itself). Browsing, reading, deleting, and
// re-pushing an EXISTING listing don't have that problem — a
// MarketplaceListing is a MarketplaceListing regardless of platform, and
// sync.service.js#endListing / the sync_listing job already dispatch
// generically via the adapter registry. This file is what the Listings
// page and the Products page's per-product channel badges use instead of
// going through one platform's own (e.g. eBay's) listing routes, so a
// Google listing shows up in the exact same places an eBay one does.

const mongoose = require("mongoose");
const MarketplaceListing = require("../../models/MarketplaceListing");
const { endListing } = require("./sync.service");
const { enqueueChannelJob } = require("../../queues/channel.queue");
const { buildWordSearchOr } = require("../../utils/regex");
const ebaySettingsService = require("../ebay/ebay.settings.service");
const { buildEbayItemUrl } = require("../ebay/ebay.listing.service");
const { MARKETPLACE_PLATFORM, LISTING_SYNC_STATUS } = require("../../constants/marketplace.constants");

// The two states that mean "something's actually wrong with this listing"
// (matches channel.service.js#listChannelsForTenant's own needs_attention
// definition, and listingStatus.ts's warn/danger badge variants on the
// frontend) — everything else (not_listed/pending/synced/out_of_stock) is a
// normal state, not an attention-worthy one.
const NEEDS_ATTENTION_STATUSES = [LISTING_SYNC_STATUS.ERROR, LISTING_SYNC_STATUS.PRICE_LOCKED];

// Same aggregation shape as ebay.listing.service.js#listListings (search
// against the populated product's title/sku can't be done via .find()+populate
// — mirrors inventory.service.js's listInventory pattern), just not scoped
// to one platform. `platform` is an optional filter, not a requirement — the
// default (omitted) returns every platform mixed together, which is exactly
// what the Listings page's main table wants.
async function listListings(
  { skip, limit, product, product_in, platform, state, sync_status, needs_attention, search } = {},
  tenantId,
) {
  const match = { tenant_id: tenantId };
  if (platform) match.platform = platform;
  if (product) match.product = mongoose.Types.ObjectId.createFromHexString(product);
  // Batch lookup for "which of these specific products have a listing on any
  // channel" (the Products page's Channels column) — bypasses skip/limit,
  // same reasoning as ebay.listing.service.js's own product_in handling: the
  // caller already bounded the input to one page's worth of product ids, not
  // "give me some page of the whole listings table".
  if (product_in?.length) {
    match.product = { $in: product_in.map((id) => mongoose.Types.ObjectId.createFromHexString(id)) };
  }
  if (state) match.state = state;
  // needs_attention takes precedence over a plain sync_status — the
  // Listings page's "Needs attention" segmented tab passes this instead of
  // (never alongside, in practice) a single sync_status value.
  if (needs_attention) match.sync_status = { $in: NEEDS_ATTENTION_STATUSES };
  else if (sync_status) match.sync_status = sync_status;

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: "products",
        localField: "product",
        foreignField: "_id",
        as: "product",
        pipeline: [{ $project: { title: 1, slug: 1, sku: 1, price: 1 } }],
      },
    },
    { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "productvariants",
        localField: "variant",
        foreignField: "_id",
        as: "variant",
        pipeline: [{ $project: { display_name: 1, sku: 1 } }],
      },
    },
    { $unwind: { path: "$variant", preserveNullAndEmptyArrays: true } },
  ];

  if (search) {
    pipeline.push({
      $match: {
        $or: buildWordSearchOr(
          ["product.title", "product.sku", "title_override", "store_sku", "item_specifics.mpn", "item_specifics.brand"],
          search,
        ),
      },
    });
  }

  const countPipeline = [...pipeline, { $count: "total" }];
  pipeline.push({ $sort: { created_at: -1 } });
  if (!product_in?.length) pipeline.push({ $skip: skip }, { $limit: limit });

  const [items, countResult] = await Promise.all([
    MarketplaceListing.aggregate(pipeline),
    MarketplaceListing.aggregate(countPipeline),
  ]);

  // eBay item URL enrichment only applies to eBay rows — every other
  // platform's row just doesn't get the field, same as it never having been
  // set. Settings are only fetched if at least one eBay row is present, so a
  // tenant with a Google-only page of results doesn't pay for an unused
  // eBay.settings lookup.
  const hasEbayRows = items.some((item) => item.platform === MARKETPLACE_PLATFORM.EBAY);
  const ebaySettings = hasEbayRows ? await ebaySettingsService.getSettings(tenantId) : null;
  const shapedItems = items.map((item) =>
    item.platform === MARKETPLACE_PLATFORM.EBAY
      ? { ...item, ebay_item_url: buildEbayItemUrl(item.external_listing_id, ebaySettings) }
      : item,
  );

  return { items: shapedItems, total: countResult[0]?.total || 0 };
}

// Fields projected onto each nested listing summary — shared between the
// two aggregation passes below so their $group stages stay identical.
const GROUPED_LISTING_PROJECTION = {
  _id: "$_id",
  platform: "$platform",
  state: "$state",
  sync_status: "$sync_status",
  synced_at: "$synced_at",
  sync_error: "$sync_error",
  external_listing_id: "$external_listing_id",
  condition: "$condition",
  store_sku: "$store_sku",
  updated_at: "$updated_at",
};

// TASK 6: one row per PRODUCT instead of one per listing — a product on two
// channels currently renders as two disconnected rows with no relationship
// between them; at real catalogue size that's ~2x the rows and a product's
// overall state is split across them.
//
// TASK 3 (this run) — filter/grey-cell ambiguity fix: platform/state/
// sync_status/search now determine which PRODUCTS qualify (a product
// appears only if at least one of its listings matches every active
// filter), never which of a QUALIFYING product's channels are shown. Once
// a product qualifies, its row always carries its FULL listing set across
// every platform. Previously the same filters were applied directly to the
// listing rows before grouping, so an active platform filter silently
// dropped a qualifying product's OTHER listings out of its own row —
// leaving a grey "not listed" cell that could mean either "genuinely not
// listed" or "filtered out", indistinguishably. Implemented as two
// aggregation passes: (1) find the page of distinct qualifying product ids
// (filtered, exactly as before), (2) re-fetch every listing for exactly
// those product ids with NO filters — the full-picture pass a grey cell's
// meaning now depends on.
async function listListingsGroupedByProduct(
  { skip, limit, product, product_in, platform, state, sync_status, needs_attention, search } = {},
  tenantId,
) {
  const match = { tenant_id: tenantId };
  if (platform) match.platform = platform;
  if (product) match.product = mongoose.Types.ObjectId.createFromHexString(product);
  if (product_in?.length) {
    match.product = { $in: product_in.map((id) => mongoose.Types.ObjectId.createFromHexString(id)) };
  }
  if (state) match.state = state;
  // See listListings' identical NOTE — needs_attention takes precedence.
  if (needs_attention) match.sync_status = { $in: NEEDS_ATTENTION_STATUSES };
  else if (sync_status) match.sync_status = sync_status;

  // ── Pass 1: which products qualify (filtered), paginated ──────────────────
  const findPipeline = [
    { $match: match },
    {
      $lookup: {
        from: "products",
        localField: "product",
        foreignField: "_id",
        as: "product",
        pipeline: [{ $project: { _id: 1 } }],
      },
    },
    { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
  ];

  if (search) {
    findPipeline.push({
      $match: {
        $or: buildWordSearchOr(
          ["product.title", "product.sku", "title_override", "store_sku", "item_specifics.mpn", "item_specifics.brand"],
          search,
        ),
      },
    });
  }

  findPipeline.push(
    { $group: { _id: "$product._id", latest_updated_at: { $max: "$updated_at" } } },
    { $sort: { latest_updated_at: -1 } },
  );

  const countPipeline = [...findPipeline, { $count: "total" }];
  findPipeline.push({ $skip: skip }, { $limit: limit });

  const [idRows, countResult] = await Promise.all([
    MarketplaceListing.aggregate(findPipeline),
    MarketplaceListing.aggregate(countPipeline),
  ]);
  const total = countResult[0]?.total || 0;

  const pageProductIds = idRows.map((r) => r._id).filter(Boolean);
  if (!pageProductIds.length) return { items: [], total };

  // ── Pass 2: the FULL, unfiltered listing set for exactly those products ───
  const fullPipeline = [
    { $match: { tenant_id: tenantId, product: { $in: pageProductIds } } },
    {
      $lookup: {
        from: "products",
        localField: "product",
        foreignField: "_id",
        as: "product",
        pipeline: [{ $project: { title: 1, slug: 1, sku: 1, price: 1 } }],
      },
    },
    { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: "$product._id",
        product: { $first: "$product" },
        listings: { $push: GROUPED_LISTING_PROJECTION },
      },
    },
  ];

  const groups = await MarketplaceListing.aggregate(fullPipeline);

  // Pass 2's own aggregate doesn't promise it returns groups in Pass 1's
  // relevance order — re-order explicitly rather than relying on it.
  const groupsById = new Map(groups.map((g) => [String(g._id), g]));
  const orderedGroups = pageProductIds.map((id) => groupsById.get(String(id))).filter(Boolean);

  // eBay item URL enrichment, same as listListings above — only for eBay
  // rows within each group's nested listings, and only fetched at all if at
  // least one is present on this page.
  const hasEbayRows = orderedGroups.some((g) => g.listings.some((l) => l.platform === MARKETPLACE_PLATFORM.EBAY));
  const ebaySettings = hasEbayRows ? await ebaySettingsService.getSettings(tenantId) : null;

  const items = orderedGroups.map((g) => ({
    product: g.product,
    listings: g.listings.map((l) =>
      l.platform === MARKETPLACE_PLATFORM.EBAY
        ? { ...l, ebay_item_url: buildEbayItemUrl(l.external_listing_id, ebaySettings) }
        : l,
    ),
  }));

  return { items, total };
}

async function getListingById(id, tenantId) {
  return MarketplaceListing.findOne({ _id: id, tenant_id: tenantId })
    .populate({
      path: "product",
      select: "title slug sku price brand mpn attachments vehicle stock_control",
      populate: { path: "attachments" },
    })
    .populate({
      path: "variant",
      select: "display_name sku price attachments",
      populate: { path: "attachments" },
    })
    .populate("photo_overrides");
}

// Mirrors ebay.listing.controller.js#deleteListing's own two-step shape
// (withdraw from the platform if it's ever actually gone live, then soft
// delete locally) — generalized via endListing's existing per-adapter
// dispatch instead of anything eBay-specific.
async function deleteListing(id, tenantId, { logger } = {}) {
  const listing = await MarketplaceListing.findOne({ _id: id, tenant_id: tenantId });
  if (!listing) return null;

  if (listing.external_listing_id || listing.external_offer_id) {
    const result = await endListing(listing._id);
    if (result?.error && logger) {
      logger.warn(`[listing.query.service] ${listing.platform} withdrawal failed for ${listing._id}: ${result.error}`);
    }
  }

  await listing.softDelete();
  return listing;
}

// Re-enqueues sync_listing for whichever platform this listing belongs to.
// seq: null — a manual "push"/retry action has no stock-change fencing
// token behind it, same convention syncListing itself already documents for
// any caller outside the stock-change fan-out path.
async function pushListing(id, tenantId) {
  const listing = await MarketplaceListing.findOne({ _id: id, tenant_id: tenantId }).select("platform");
  if (!listing) return null;
  await enqueueChannelJob(listing.platform, "sync_listing", { listingId: listing._id.toString(), seq: null });
  return listing;
}

module.exports = { listListings, listListingsGroupedByProduct, getListingById, deleteListing, pushListing };
