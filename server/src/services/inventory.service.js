// services/inventory.service.js

const mongoose = require("mongoose");
const Inventory = require("../models/Inventory");
const InventoryHistory = require("../models/InventoryHistory");
const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const { enqueueChannelJob } = require("../queues/channel.queue");
const { logger } = require("../loaders/logging");
const { ADJUSTMENT_TYPE } = require("../constants/inventory.constants");
const { buildWordSearchOr } = require("../utils/regex");

// ── List / aggregation ────────────────────────────────────────────────────────

// tenantId is required — Inventory has no tenant_id field of its own (see
// Inventory.js), so scoping goes through this $match on product.tenant_id
// right after the product $lookup. Previously entirely unscoped: any
// authenticated admin, from any tenant, saw every OTHER tenant's inventory
// on this list. Found live, the moment a second real tenant existed.
async function listInventory(tenantId, { page = 1, limit = 20, search, location, product, variant } = {}) {
  if (!tenantId) throw new Error("[inventory.service] listInventory: tenantId is required");
  const skip = (page - 1) * limit;

  const preFilters = [];
  if (product) {
    preFilters.push({ $match: { product: mongoose.Types.ObjectId.createFromHexString(product) } });
  }
  if (variant === "null") {
    preFilters.push({ $match: { variant: null } });
  } else if (variant) {
    preFilters.push({ $match: { variant: mongoose.Types.ObjectId.createFromHexString(variant) } });
  }

  const pipeline = [
    ...preFilters,
    {
      $lookup: {
        from: "products",
        localField: "product",
        foreignField: "_id",
        as: "product",
      },
    },
    { $unwind: { path: "$product", preserveNullAndEmptyArrays: false } },
    { $match: { "product.deleted_at": null, "product.tenant_id": tenantId } },
    {
      $lookup: {
        from: "productvariants",
        localField: "variant",
        foreignField: "_id",
        as: "variant",
      },
    },
    { $addFields: { variant: { $arrayElemAt: ["$variant", 0] } } },
    {
      $lookup: {
        from: "locations",
        localField: "location",
        foreignField: "_id",
        as: "location",
      },
    },
    { $unwind: { path: "$location", preserveNullAndEmptyArrays: false } },
    {
      $lookup: {
        from: "attachments",
        localField: "product.attachments",
        foreignField: "_id",
        as: "product.attachments",
      },
    },
  ];

  if (search) {
    pipeline.push({
      $match: {
        $or: buildWordSearchOr(
          ["product.title", "product.sku", "variant.sku", "variant.display_name"],
          search,
        ),
      },
    });
  }

  if (location) {
    pipeline.push({
      $match: {
        "location._id": mongoose.Types.ObjectId.createFromHexString(location),
      },
    });
  }

  const countPipeline = [...pipeline, { $count: "total" }];
  pipeline.push(
    { $sort: { "product.title": 1 } },
    { $skip: skip },
    { $limit: limit },
  );

  const [items, countResult] = await Promise.all([
    Inventory.aggregate(pipeline, { withDeleted: false }),
    Inventory.aggregate(countPipeline, { withDeleted: false }),
  ]);

  const total = countResult[0]?.total || 0;

  return {
    items,
    total,
    page,
    pageSize: limit,
    totalPages: Math.ceil(total / limit),
  };
}

// Fan-out: enqueue a sync_listing job for every active MarketplaceListing tied
// to this product/variant — the ONE place in the app that pushes a stock
// change to a marketplace. tenantId is mandatory (not "scope it if you
// happened to pass one") — every other MarketplaceListing query in this
// codebase is tenant-scoped unconditionally (see feedback_service_layer),
// and silently falling back to an unscoped query on a missing tenantId is
// exactly the kind of gap that's bitten this app before.
//
// Claims a fencing token (MarketplaceListing.push_seq) atomically for each
// listing before enqueueing, and carries it in the job data — sync_listing's
// worker drops any job whose seq is older than what's already landed (see
// MarketplaceListing.js's push_seq/last_pushed_seq schema comment). This is
// the ONLY place that claims that token, so every caller that changes stock
// (manual corrections, Stripe sales via order-stock-sync.service.js,
// eBay-originated sales) goes through one consistently-fenced writer path —
// no second, unfenced way to push a quantity to a marketplace.
//
// Returns one result per listing found, so callers that need to know
// whether a push was actually queued (e.g. order-stock-sync.service.js
// setting a line item's ebay_sync_status) don't have to re-query.
async function fanOutMarketplaceInventory(productId, variantId, tenantId) {
  if (!tenantId) {
    throw new Error("[inventory.service] fanOutMarketplaceInventory: tenantId is required");
  }

  const results = [];
  try {
    // Lazy-require to avoid circular dep at module load time
    const MarketplaceListing = require("../models/MarketplaceListing");
    const { LISTING_STATE } = require("../constants/marketplace.constants");
    const registry = require("./marketplace/registry");

    const listings = await MarketplaceListing.find({
      product: productId,
      variant: variantId || null,
      tenant_id: tenantId,
      state: LISTING_STATE.ACTIVE,
    }).select("_id platform").lean();

    for (const listing of listings) {
      // A listing can outlive its adapter being registered (e.g. a platform
      // temporarily disabled in this worker process) — skip it rather than
      // let one unknown platform throw and abort every other listing's
      // fan-out below.
      if (!registry.has(listing.platform)) {
        logger.warn(`[inventory.service] fan-out skipped: no adapter registered for platform "${listing.platform}" (listing ${listing._id})`);
        results.push({ listingId: listing._id.toString(), platform: listing.platform, queued: false, error: "no_adapter" });
        continue;
      }

      try {
        // push_seq now lives on the base schema (see MarketplaceListing.js)
        // so every platform gets a real fencing token — no strict: false
        // needed here any more.
        const updated = await MarketplaceListing.findOneAndUpdate(
          { _id: listing._id, tenant_id: tenantId },
          { $inc: { push_seq: 1 } },
          { new: true },
        ).select("push_seq");
        const seq = updated ? (updated.push_seq ?? null) : null;

        await enqueueChannelJob(listing.platform, "sync_listing", { listingId: listing._id.toString(), seq });
        logger.info(`[inventory.service] fan-out queued sync_listing for ${listing._id} (${listing.platform}, seq ${seq})`);
        results.push({ listingId: listing._id.toString(), platform: listing.platform, queued: true, seq });
      } catch (qErr) {
        logger.warn(`[inventory.service] fan-out queue unavailable for listing ${listing._id}`, {
          error: qErr.message,
        });
        results.push({ listingId: listing._id.toString(), platform: listing.platform, queued: false, error: qErr.message });
      }
    }
  } catch (err) {
    logger.warn("[inventory.service] fanOutMarketplaceInventory error", { error: err.message });
  }
  return results;
}

// ── Record CRUD ───────────────────────────────────────────────────────────────

async function fetchPopulatedRecord(id) {
  return Inventory.findById(id)
    .populate("product", "title slug attachments")
    .populate("variant", "display_name sku combination")
    .populate("location", "name address");
}

// tenantId required — Inventory has no tenant_id of its own, so ownership
// is verified via the record's product. Previously a bare findById with no
// check at all: any authenticated admin, from any tenant, could adjust/set
// stock or read history on ANY OTHER tenant's inventory record just by
// knowing (or enumerating) a valid ObjectId — a write vulnerability, not
// just a read leak. Found live.
async function findRecord(id, tenantId) {
  const record = await Inventory.findById(id);
  if (!record) return null;
  const owned = await Product.exists({ _id: record.product, tenant_id: tenantId });
  if (!owned) return null;
  return record;
}

// tenantId required — verifies both `product` AND `location` actually
// belong to this tenant before creating/upserting an Inventory record
// linking them. Previously unchecked: any tenant could pass another
// tenant's product or location id here and create a phantom stock record
// linked to it. Found live.
async function ensureRecord({ product, location, variant }, tenantId) {
  const Location = require("../models/Location");
  const [ownsProduct, ownsLocation] = await Promise.all([
    Product.exists({ _id: product, tenant_id: tenantId }),
    Location.exists({ _id: location, tenant_id: tenantId }),
  ]);
  if (!ownsProduct || !ownsLocation) return null;

  return Inventory.findOneAndUpdate(
    { product, location, variant: variant || null },
    {
      $setOnInsert: {
        product,
        location,
        variant: variant || null,
        stock_count: 0,
        stock_reserved: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

// Compare-and-swap retry instead of a plain read-then-.save(): two
// concurrent adjustments on the same record (e.g. a real-time eBay webhook
// deduction racing the inventory-reconciliation poll, or a Stripe sale
// racing an eBay order-poll deduction) previously both read the same
// stock_count, computed independently, and the second .save() silently
// clobbered the first — no error, no warning, lost stock movement. This
// re-reads and retries on conflict instead of trusting an in-memory value
// that may already be stale by the time it writes.
async function adjustStock(record, { adjustment, reason, type, userId, tenantId, skipMarketplaceFanOut = false }) {
  let current = record;
  let stock_before, stock_after, updated;

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    stock_before = current.stock_count;
    stock_after = Math.max(0, stock_before + adjustment);

    updated = await Inventory.findOneAndUpdate(
      { _id: current._id, stock_count: stock_before },
      { $set: { stock_count: stock_after } },
      { new: true },
    );
    if (updated) break;

    current = await Inventory.findById(record._id);
    if (!current) {
      throw new Error(`[inventory.service] adjustStock: record ${record._id} no longer exists`);
    }
  }

  if (!updated) {
    throw new Error(
      `[inventory.service] adjustStock: record ${record._id} still conflicting after ${MAX_ATTEMPTS} attempts — high contention`,
    );
  }

  // Keep the caller's in-memory document consistent with what was actually
  // persisted (callers like adjustStockForSku read record.stock_count
  // afterward via the returned stock_after, but some also hold onto `record`).
  record.stock_count = stock_after;

  // `adjustment` here is always the TRUE requested delta, never silently
  // rewritten to whatever actually fit — stock_after is clamped at 0
  // above, but the history row must still say what was actually asked for.
  // clamped_shortfall carries the uncovered amount separately, so a row
  // never reads as "adjustment: -1, stock_before: 0, stock_after: 0" (looks
  // like nothing happened) when what really happened was an oversell.
  const clamped_shortfall = stock_before + adjustment < 0 ? Math.abs(stock_before + adjustment) : 0;

  await InventoryHistory.create({
    inventory: record._id,
    product: record.product,
    variant: record.variant,
    location: record.location,
    adjustment,
    stock_before,
    stock_after,
    clamped_shortfall,
    reason: reason || null,
    type: type || "other",
    user: userId || null,
  });

  // Every stock change — manual correction or a sale/refund driving this via
  // adjustStockForSku below — should keep the listing's sync_status (and, if
  // it just hit/left zero, quantity on eBay) current. Centralized here
  // instead of at each call site so no adjustment path can forget it.
  // skipMarketplaceFanOut: true for the one case where pushing back to eBay
  // would be pointless/wrong — accepting a PendingReconciliation row applies
  // a delta that came FROM eBay in the first place (see
  // pendingReconciliation.service.js#acceptReconciliation); re-announcing
  // eBay's own number back to eBay is a no-op at best.
  const marketplaceResults = skipMarketplaceFanOut
    ? []
    : await fanOutMarketplaceInventory(record.product, record.variant, tenantId);

  return { record, stock_before, stock_after, marketplaceResults };
}

// This is an absolute set (not a delta), so unlike adjustStock() there's
// nothing to retry on conflict — but the pre-write value still needs to be
// read atomically with the write itself, or a concurrent adjustment landing
// between a plain read and this save would silently vanish AND get logged
// with a wrong stock_before in the audit trail.
async function setStock(record, { stock_count, reason, userId, tenantId }) {
  const newCount = Math.round(Number(stock_count));

  const previous = await Inventory.findOneAndUpdate(
    { _id: record._id },
    { $set: { stock_count: newCount } },
    { new: false },
  );
  if (!previous) {
    throw new Error(`[inventory.service] setStock: record ${record._id} no longer exists`);
  }
  const stock_before = previous.stock_count;
  record.stock_count = newCount;

  await InventoryHistory.create({
    inventory: record._id,
    product: record.product,
    variant: record.variant,
    location: record.location,
    adjustment: newCount - stock_before,
    stock_before,
    stock_after: newCount,
    reason: reason || null,
    type: "correction",
    user: userId || null,
  });

  await fanOutMarketplaceInventory(record.product, record.variant, tenantId);

  return { record, stock_before, stock_after: newCount };
}

async function getHistory(inventoryId) {
  return InventoryHistory.find({ inventory: inventoryId })
    .populate("user", "first_name last_name email")
    .populate("location", "name")
    .sort({ created_at: -1 })
    .limit(100);
}

async function getTotalStockForProductVariant(productId, variantId) {
  const records = await Inventory.find({
    product: productId,
    variant: variantId || null,
  }).lean();
  return records.reduce((sum, r) => sum + (r.stock_count || 0), 0);
}

// Product-level rollup across all variants/locations — used for the
// product detail page's stock badge, unlike the variant-scoped helper above.
async function getTotalStockForProduct(productId) {
  const records = await Inventory.find({ product: productId }).lean();
  return records.reduce((sum, r) => sum + (r.stock_count || 0), 0);
}

// ── SKU-based stock adjustment (used by eBay webhook and Stripe payment/refund) ─

const FALLBACK_SKU_RE = /^ph-([0-9a-f]{24})(?:-([0-9a-f]{24}))?$/;

// tenantId is required — SKUs are only unique PER TENANT (see Product.js's
// {tenant_id, sku} unique index), never globally. An unscoped lookup here
// previously meant two tenants sharing the same generic SKU string (common
// for auto-part codes) could corrupt each other's stock: found live, see
// git history for this comment. The fallback `ph-<productId>` form is exempt
// since it already carries an unambiguous product id, but the id it embeds
// still isn't verified as belonging to tenantId here — callers that need
// that guarantee (e.g. order import) do their own tenant check on the
// resolved ids, same as ever.
async function resolveSkuToIds(sku, tenantId) {
  if (!tenantId) throw new Error("[inventory.service] resolveSkuToIds: tenantId is required");

  const match = sku.match(FALLBACK_SKU_RE);
  if (match) {
    return { productId: match[1], variantId: match[2] || null };
  }

  const variant = await ProductVariant.findOne({ sku, tenant_id: tenantId }).lean();
  if (variant) {
    return { productId: variant.product.toString(), variantId: variant._id.toString() };
  }

  const product = await Product.findOne({ sku, tenant_id: tenantId }).lean();
  if (product) {
    return { productId: product._id.toString(), variantId: null };
  }

  return null;
}

// Generic core: deducts/credits stock for a SKU across its location records
// (largest-stock-first for deductions, same as before), under a caller-supplied
// reason/type/userId. Unlike the old eBay-only version, this:
//   - returns stock_before/stock_after per adjustment (previously computed by
//     adjustStock() but silently discarded)
//   - returns `shortfall` — how much of a deduction could NOT be covered by
//     available stock, instead of silently clamping to 0 and hiding an oversell
//   - returns `totalStockAfter` — the SKU's new total across all locations,
//     which callers pushing quantity to a marketplace need as the absolute
//     value to send (eBay's inventory API takes an absolute quantity, not a delta)
async function adjustStockForSku(sku, delta, { reason, type, userId = null, tenantId, skipMarketplaceFanOut = false } = {}) {
  const ids = await resolveSkuToIds(sku, tenantId);
  if (!ids) {
    logger.warn(`[inventory.service] SKU not found: ${sku}`);
    return null;
  }

  const { productId, variantId } = ids;
  const records = await Inventory.find({
    product: productId,
    variant: variantId || null,
  }).sort({ stock_count: -1 });

  if (!records.length) {
    logger.warn(`[inventory.service] No inventory records for SKU: ${sku}`);
    return null;
  }

  const adjustments = [];
  let shortfall = 0;

  // Last non-empty fan-out result seen across every adjustStock() call this
  // invocation makes — every one of those calls targets the same
  // product/variant, so they all fan out to the same set of listings; the
  // last one is as representative as any. Callers (e.g.
  // order-stock-sync.service.js) use this instead of making their own
  // separate push, so there's exactly one enqueue per real stock change.
  let marketplaceResults = [];

  if (delta < 0) {
    let remaining = Math.abs(delta);
    let lastRecord = null;
    for (const record of records) {
      lastRecord = record;
      if (remaining <= 0) break;
      const deduct = Math.min(remaining, record.stock_count);
      if (deduct === 0) continue;
      const { stock_before, stock_after, marketplaceResults: mr } = await adjustStock(record, {
        adjustment: -deduct,
        reason,
        type,
        userId,
        tenantId,
        skipMarketplaceFanOut,
      });
      remaining -= deduct;
      adjustments.push({ recordId: record._id, adjustment: -deduct, stock_before, stock_after });
      if (mr.length) marketplaceResults = mr;
    }
    shortfall = remaining;
    if (shortfall > 0) {
      logger.warn(`[inventory.service] oversold SKU ${sku} by ${shortfall}`);
      // Every record is out of stock but `remaining` units were still
      // requested — attribute the shortfall to the last record checked so
      // the audit trail has a row that actually says an oversell happened
      // (adjustment: -remaining, clamped_shortfall: remaining), instead of
      // the attempt vanishing with no InventoryHistory entry at all. Forced
      // skipMarketplaceFanOut: true regardless of the caller's own flag —
      // this row represents zero real stock movement (0 -> 0), so it has
      // nothing new to push; any real quantity change from this same call
      // already triggered its own fan-out from the loop above.
      const { stock_before, stock_after } = await adjustStock(lastRecord, {
        adjustment: -remaining,
        reason,
        type,
        userId,
        tenantId,
        skipMarketplaceFanOut: true,
      });
      adjustments.push({ recordId: lastRecord._id, adjustment: -remaining, stock_before, stock_after });
    }
  } else {
    const { stock_before, stock_after, marketplaceResults: mr } = await adjustStock(records[0], {
      adjustment: delta,
      reason,
      type,
      userId,
      tenantId,
      skipMarketplaceFanOut,
    });
    adjustments.push({ recordId: records[0]._id, adjustment: delta, stock_before, stock_after });
    marketplaceResults = mr;
  }

  const totalStockAfter = await getTotalStockForProductVariant(productId, variantId);

  return { productId, variantId, adjustments, shortfall, totalStockAfter, marketplaceResults };
}

// Thin wrapper preserving the original eBay behavior and return shape.
async function adjustStockBySku(sku, delta, tenantId) {
  const result = await adjustStockForSku(sku, delta, {
    reason:
      delta < 0
        ? `eBay sale (SKU: ${sku})`
        : `eBay cancellation/return (SKU: ${sku})`,
    type: ADJUSTMENT_TYPE.EBAY_SALE,
    userId: null,
    tenantId,
  });
  if (!result) return null;

  // Stamp MarketplaceListing.ebay_synced_quantity synchronously with the
  // post-adjustment total, right here, instead of relying solely on the
  // async sync_listing queue job (fanned out by adjustStock() above) to get
  // around to it. This function is ONLY ever called for an eBay-originated
  // event (a real sale/cancellation eBay itself already told us about — see
  // ebay.orders.service.js / ebay.webhook.service.js, the only two
  // callers), so this total is usually an accurate reflection of what
  // eBay's quantity now is — but it's still OUR BEST GUESS at eBay's state,
  // not a confirmed read of it (see the field's own schema comment on
  // MarketplaceListing.js). It's provably wrong on an oversell: eBay shows
  // 1, our local record had already drifted to 0 (stale for whatever
  // reason), a sale lands anyway — local stock clamps at 0 (see
  // clamped_shortfall on InventoryHistory), this stamp writes 0 as the new
  // baseline, and the real pre-existing 1-vs-0 drift is silently erased
  // instead of ever surfacing for review. Deliberately kept anyway (an
  // earlier draft of this fix considered deleting it entirely) — removing
  // it would mean this baseline goes stale after every ordinary eBay sale
  // until some unrelated future push happens, which would make the NEXT
  // reconciliation poll flag every single normal sale as a "possible manual
  // edit" needing human review — pure noise, and a worse failure mode than
  // the rare oversell case above. The actual incident this baseline
  // stamping caused (Aug 2026: a poll ran before eBay's OWN read-side had
  // caught up to a sale it had just processed, saw baseline-vs-stale-eBay-
  // read as a fresh drift, and re-applied it) is fixed at the read side
  // instead — see ebay.inventory-sync.service.js's two-consecutive-poll
  // confirmation before anything is even flagged, plus the fact that a
  // confirmed drift now only ever creates a PendingReconciliation row for a
  // human to review, never an automatic stock mutation.
  try {
    const MarketplaceListing = require("../models/MarketplaceListing");
    const { MARKETPLACE_PLATFORM } = require("../constants/marketplace.constants");
    await MarketplaceListing.updateOne(
      {
        tenant_id: tenantId,
        product: result.productId,
        variant: result.variantId || null,
        platform: MARKETPLACE_PLATFORM.EBAY,
      },
      {
        $set: {
          // TODO(dual-write): remove ebay_synced_quantity/ebay_synced_at
          // after backfill — see MarketplaceListing.js. synced_quantity/
          // synced_at (base schema) are the generic replacement.
          ebay_synced_quantity: result.totalStockAfter,
          ebay_synced_at: new Date(),
          synced_quantity: result.totalStockAfter,
          synced_at: new Date(),
        },
      },
      // ebay_synced_quantity/ebay_synced_at are still declared on the eBay
      // DISCRIMINATOR schema only, not MarketplaceListing's own base schema —
      // Model.updateOne() called on the base model casts $set against only
      // the base schema's paths, and in strict mode (the default) silently
      // DROPS any field it doesn't recognize, with no error and a
      // misleadingly successful modifiedCount. Confirmed live while adding
      // this fix's tests: this stamp had been silently doing nothing.
      // strict: false is the same fix ebay.listing.service.js#updateListing
      // already uses for the same reason — keeping the pattern consistent
      // rather than switching to MarketplaceListing.discriminators[...].
      { strict: false },
    );
  } catch (err) {
    logger.warn(`[inventory.service] failed to update ebay_synced_quantity baseline for SKU ${sku}: ${err.message}`);
  }

  return {
    productId: result.productId,
    variantId: result.variantId,
    adjustments: result.adjustments.map(({ recordId, adjustment }) => ({ recordId, adjustment })),
  };
}

module.exports = {
  listInventory,
  fanOutMarketplaceInventory,
  fetchPopulatedRecord,
  findRecord,
  ensureRecord,
  adjustStock,
  setStock,
  getHistory,
  getTotalStockForProductVariant,
  getTotalStockForProduct,
  resolveSkuToIds,
  adjustStockForSku,
  adjustStockBySku,
};
