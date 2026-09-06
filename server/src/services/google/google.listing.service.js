// services/google/google.listing.service.js
//
// CREATE/UPDATE only for MarketplaceListing documents (google discriminator)
// — browsing, reading, deleting, and pushing an existing listing go through
// the platform-agnostic services/marketplace/listing.query.service.js
// instead (see that file's own module header for why). This file is
// intentionally much smaller than ebay.listing.service.js: Google's adapter
// (adapters/google.adapter.js#buildProductInputFromResolved) already derives
// title/description/price/photos straight from the product, and reads
// feed_label/content_language from the tenant's own ChannelConnection (the
// feed-level settings chosen once at connect time), never from a listing's
// own fields — so there's nothing to ask for per listing except the
// genuinely per-product attributes: GTIN, MPN, condition, and Google's own
// product category. This is the "lightweight toggle" listing flow.

const MarketplaceListing = require("../../models/MarketplaceListing");
const Product = require("../../models/Product");
const { MARKETPLACE_PLATFORM, LISTING_STATE } = require("../../constants/marketplace.constants");

async function createListing(payload, tenantId) {
  const {
    product,
    variant = null,
    google_product_category = null,
    gtin = null,
    mpn = null,
    condition = null,
    shipping_label = null,
  } = payload;

  const productDoc = await Product.findOne({ _id: product, tenant_id: tenantId }).select("_id");
  if (!productDoc) throw Object.assign(new Error("Product not found"), { status: 404 });

  // Idempotency — mirrors ebay.listing.service.js#createListing's own
  // check-then-create (see that file's comment on the Aug 2026 duplicate-
  // listing incident this guards against): a double-click on "List on
  // Google Shopping" must return the existing listing, not a raw duplicate-
  // key error or a second record racing the same product/variant/platform.
  const existing = await MarketplaceListing.findOne({
    tenant_id: tenantId,
    product,
    variant,
    platform: MARKETPLACE_PLATFORM.GOOGLE,
  });
  if (existing) return existing;

  try {
    // state: ACTIVE (not DRAFT) — unlike eBay's multi-step form-then-push
    // flow, this IS the push action (see google.listing.controller.js,
    // which enqueues sync_listing right after this call): the listing is
    // "live" the moment the toggle is clicked, not a draft awaiting a
    // separate explicit publish step. Also means a transient first-sync
    // failure still leaves it ACTIVE and eligible for the refresh sweep /
    // manual retry, rather than stuck DRAFT and silently excluded.
    return await MarketplaceListing.create({
      tenant_id: tenantId,
      platform: MARKETPLACE_PLATFORM.GOOGLE,
      product,
      variant,
      state: LISTING_STATE.ACTIVE,
      google_product_category,
      gtin,
      mpn,
      condition,
      shipping_label,
    });
  } catch (err) {
    // Same non-atomic check-then-create race as eBay's — the unique index
    // on (product, variant, platform) still catches a true simultaneous
    // double-submit; recover by returning whichever request actually won.
    if (err.code === 11000 && err.keyPattern?.product) {
      const winner = await MarketplaceListing.findOne({
        tenant_id: tenantId,
        product,
        variant,
        platform: MARKETPLACE_PLATFORM.GOOGLE,
      });
      if (winner) return winner;
    }
    throw err;
  }
}

async function updateListing(id, payload, tenantId) {
  const allowed = [
    "title_override", "description_override", "price_override", "photo_overrides",
    "google_product_category", "gtin", "mpn", "condition", "shipping_label",
    "custom_label_0", "custom_label_1", "custom_label_2", "custom_label_3", "custom_label_4",
    "state",
  ];

  const update = {};
  for (const key of allowed) {
    if (payload[key] !== undefined) update[key] = payload[key];
  }
  if (update.price_override != null) update.price_override = Number(update.price_override);

  return MarketplaceListing.findOneAndUpdate({ _id: id, tenant_id: tenantId }, { $set: update }, { new: true, strict: false })
    .populate("product", "title slug sku price brand attachments")
    .populate("variant", "display_name sku price attachments")
    .populate("photo_overrides");
}

module.exports = { createListing, updateListing };
