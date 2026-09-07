// models/MarketplaceListing.js
//
// Base model + discriminators for per-platform listings.
// buildSchema is not used here because it doesn't forward discriminatorKey.
// We apply the soft-delete plugin and timestamps manually to match conventions.

const { model, Schema } = require("mongoose");
const softDeletePlugin = require("./plugins/softDelete.plugin");
const { stripInternalFields } = require("./base.model");
const {
  MARKETPLACE_PLATFORM,
  LISTING_STATE,
  LISTING_SYNC_STATUS,
} = require("../constants/marketplace.constants");

// ── Base schema ─────────────────────────────────────────────────────────────

const baseSchema = new Schema(
  {
    // Denormalized from product.tenant_id at creation — avoids a populate
    // just to scope admin list/read queries by tenant.
    tenant_id: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    variant: {
      type: Schema.Types.ObjectId,
      ref: "ProductVariant",
      default: null,
    },

    // Per-channel content overrides — null/empty => inherit from Product at publish time
    title_override: { type: String, default: null },
    description_override: { type: String, default: null },
    price_override: { type: Number, default: null },
    photo_overrides: [{ type: Schema.Types.ObjectId, ref: "Attachment" }],

    // Lifecycle state
    state: {
      type: String,
      enum: Object.values(LISTING_STATE),
      default: LISTING_STATE.DRAFT,
    },

    // Sync state — shared across all platforms
    sync_status: {
      type: String,
      enum: Object.values(LISTING_SYNC_STATUS),
      default: LISTING_SYNC_STATUS.NOT_LISTED,
    },
    synced_at: { type: Date, default: null },
    sync_error: { type: String, default: null },

    // Fencing tokens for outbound quantity pushes — see the eBay adapter's
    // original comment (still accurate) on why this exists: standard
    // fencing-token pattern for idempotent, order-sensitive async writers
    // (Kleppmann, "Designing Data-Intensive Applications" ch. 9). Used to be
    // declared only on the eBay discriminator even though
    // marketplace/sync.service.js#syncListing reads them generically for
    // EVERY platform — a non-eBay listing would read `undefined` here and
    // the stale-job fence would silently never trip. Moved to the base
    // schema so every platform gets a real fencing token.
    //
    // Legacy eBay documents written before this migration have no
    // push_seq/last_pushed_seq at all at the base level. Mongoose applies
    // this default on hydrated (non-lean) reads even for docs missing the
    // field, but NOT on `.lean()` reads — every comparison site coalesces
    // with `?? 0` regardless, rather than depending on that distinction.
    push_seq: { type: Number, default: 0 },
    last_pushed_seq: { type: Number, default: 0 },

    // Generic loop-prevention baseline — "what we currently believe this
    // platform shows", set only after a confirmed push/reconcile, analogous
    // to (and replacing, long-term) the eBay-only ebay_synced_quantity below.
    // null until the first push/reconcile establishes a baseline.
    // TODO(dual-write): once every write site is updated and
    // ebay_synced_quantity is backfilled from this field for old rows, drop
    // ebay_synced_quantity from the eBay discriminator entirely.
    synced_quantity: { type: Number, default: null },

    // Generic external identifiers (eBay listingId/offerId, Amazon ASIN, etc.)
    external_listing_id: { type: String, default: null },
    external_offer_id: { type: String, default: null },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    discriminatorKey: "platform",
  },
);

baseSchema.plugin(softDeletePlugin);
baseSchema.set("toJSON", { transform: stripInternalFields });
baseSchema.set("toObject", { transform: stripInternalFields });

// One listing per (product, variant, platform). A null variant is a distinct
// value in MongoDB sparse compound indexes — we rely on partial filtering here
// to treat null as a concrete value so (productA, null, ebay) is unique.
baseSchema.index(
  { product: 1, variant: 1, platform: 1 },
  {
    unique: true,
    partialFilterExpression: { deleted_at: null },
  },
);

// Safety net against duplicate eBay offers/listings ending up attached to two
// different MarketplaceListing docs (e.g. a retried sync recreating an offer
// whose ID was never persisted) — found live as the root cause of a runaway
// stock-drift incident (Aug 2026): two DRAFT listings for the same product
// both independently recovered onto the same real eBay offer via the
// "offer already exists" retry path, and nothing in the DB stopped it.
//
// `sparse: true` does NOT correctly exclude these fields' null state —
// sparse only skips documents where the field is entirely ABSENT, but every
// DRAFT listing has this field explicitly set to `null` (present, not
// absent), so a plain sparse+unique index still collides every draft
// against every other draft. Use partialFilterExpression instead, which can
// actually test the VALUE (not just presence) and correctly excludes null.
// Also excludes soft-deleted docs (same as the compound index above) — an
// ended/removed listing's old external id shouldn't block a live one from
// ever using it, and old soft-deleted test/junk data shouldn't either.
baseSchema.index(
  { external_listing_id: 1 },
  {
    unique: true,
    partialFilterExpression: { external_listing_id: { $type: "string" }, deleted_at: null },
  },
);
baseSchema.index(
  { external_offer_id: 1 },
  {
    unique: true,
    partialFilterExpression: { external_offer_id: { $type: "string" }, deleted_at: null },
  },
);

// Channel-agnostic query patterns (health dashboards, per-platform listing
// counts, "most recently synced" views — see channel.controller.js /
// channel.queue.js circuit breaker) — background: true so index build never
// blocks writes on this collection in production.
baseSchema.index({ tenant_id: 1, platform: 1, sync_status: 1 }, { background: true });
baseSchema.index({ tenant_id: 1, platform: 1, synced_at: -1 }, { background: true });

const MarketplaceListing = model("MarketplaceListing", baseSchema);

// ── eBay discriminator ───────────────────────────────────────────────────────

const ebaySchema = new Schema({
  ebay_category_id: { type: String, default: null },
  store_category_id: { type: String, default: null },
  store_sku: { type: String, default: null },

  condition: { type: String, default: "NEW" },
  condition_notes: { type: String, default: "" },

  item_specifics: {
    brand: { type: String, default: null },
    mpn: { type: String, default: null },
    superseded_part_number: [{ type: String }],
    aspects: { type: Map, of: String, default: {} },
    authenticity: { type: String, default: null },
    warranty: { type: String, default: null },
  },

  fitment: [
    {
      make: { type: String, default: "" },
      model: { type: String, default: "" },
      model_code: { type: String, default: "" },
      year_from: { type: Number, default: null },
      year_to: { type: Number, default: null },
    },
  ],

  format: {
    type: String,
    enum: ["FIXED_PRICE", "AUCTION"],
    default: "FIXED_PRICE",
  },
  // null => derive from live inventory at publish time
  quantity_available: { type: Number, default: null },
  // OUR EXPECTED eBay quantity — not "eBay's quantity as of our last
  // confirmed push", despite that being this field's original intent. Two
  // different kinds of writes land here: (1) a confirmed push we made
  // ourselves (publish/update/sync_listing), which genuinely IS a confirmed
  // eBay value; and (2) inventory.service.js#adjustStockBySku's stamp after
  // an eBay-originated sale, which is our own best guess at what eBay's
  // count must now be, not something eBay told us. That guess is usually
  // right but is provably wrong on an oversell — see adjustStockBySku's own
  // comment for the exact scenario. Treat this field as "what we currently
  // believe eBay shows", not as a verified fact, when reasoning about it.
  // null until the first push/reconcile establishes a baseline. Comparing
  // eBay's live quantity against this value (not against local stock
  // directly) is what lets the inventory-sync poller tell "eBay changed
  // since we last touched it" apart from "we're the ones who changed it".
  //
  // DEPRECATED: superseded by the generic `synced_quantity` on the base
  // schema. Kept here during the transition — every write site dual-writes
  // both fields (see e.g. ebay.adapter.js#updateSyncBaseline), and every
  // read site should prefer `synced_quantity ?? ebay_synced_quantity ??
  // null` — so a rollback to pre-migration code (which only knows this
  // field) keeps working, and so ebay.inventory-sync.service.js's existing
  // poller (untouched by this migration, still reads this field directly)
  // keeps seeing an accurate baseline.
  // TODO(dual-write): remove after ebay_synced_quantity backfill.
  ebay_synced_quantity: { type: Number, default: null },
  // When ebay_synced_quantity was last confirmed by an actual eBay API
  // response (a successful push, or a reconciliation poll's read) — not a
  // guess. Informational/debugging aid for the reconciliation flow.
  ebay_synced_at: { type: Date, default: null },
  // Consecutive inventory-sync polls where this listing's SKU was absent
  // from eBay's own inventory list — i.e. it was deleted/ended directly on
  // eBay, not through this app. Reset to 0 whenever it's seen again; a small
  // streak (not a single miss) is required before we auto-delete locally, so
  // one transient eBay API hiccup can't wrongly delete a live listing.
  ebay_missing_polls: { type: Number, default: 0 },
  // A quantity drift seen by the inventory-sync poller that hasn't yet been
  // confirmed on a second consecutive poll — see ebay_missing_polls above
  // for the same debounce idea applied to a different signal. eBay's own
  // GetInventoryItem API can lag behind an order it JUST processed (found
  // live: a sale dropped local stock 1->0, eBay's API still read 1 for
  // several minutes after), which used to look identical to a seller
  // manually raising the quantity in Seller Hub and get "corrected" back —
  // silently undoing a real sale. Requiring the same drift to still be
  // there on the NEXT poll (~15 min later, long enough for eBay's read side
  // to catch up) before applying it filters that false positive out while
  // still catching genuine manual edits, just one cycle later.
  ebay_pending_reconcile_qty: { type: Number, default: null },
  // push_seq / last_pushed_seq moved to the base schema — see its comment
  // there — since sync.service.js reads them generically for every platform.
  listing_duration: { type: String, default: "GTC" },
  accept_best_offer: { type: Boolean, default: false },
  min_best_offer: { type: Number, default: null },

  // Business policy IDs — null => fall back to EbaySettings singleton defaults
  fulfillment_policy_id: { type: String, default: null },
  payment_policy_id: { type: String, default: null },
  return_policy_id: { type: String, default: null },
  require_immediate_payment: { type: Boolean, default: true },

  item_location_zip: { type: String, default: null },
  package: {
    length: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    weight: { type: Number, default: null },
  },
});

MarketplaceListing.discriminator(MARKETPLACE_PLATFORM.EBAY, ebaySchema);

// ── Google (Merchant API) discriminator ──────────────────────────────────────
//
// Google is feed-shaped, not listing-shaped — there's no offer/publish
// lifecycle the way eBay has one. external_listing_id holds the Merchant
// API product resource name (channel~contentLanguage~feedLabel~offerId — see
// google.adapter.js); external_offer_id is left null for every Google
// listing, same as it would be for a listing that's never had an offer
// created — the base schema's partial unique index on external_offer_id
// already excludes null (`partialFilterExpression: { external_offer_id: {
// $type: "string" }, ... }` above), so every Google listing sharing null
// there doesn't collide.
const googleSchema = new Schema({
  // Google's own taxonomy id (https://support.google.com/merchants/answer/6324436)
  // — a completely different concept from eBay's category id, not reused.
  google_product_category: { type: String, default: null },
  gtin: { type: String, default: null },
  mpn: { type: String, default: null },
  // Google's own condition enum ("new" | "refurbished" | "used") — lowercase,
  // unlike eBay's ConditionEnum strings; kept as its own field rather than
  // sharing a name with the eBay discriminator's `condition` to avoid
  // implying they're interchangeable.
  condition: { type: String, default: null },
  feed_label: { type: String, default: null },
  content_language: { type: String, default: null },
  shipping_label: { type: String, default: null },
  custom_label_0: { type: String, default: null },
  custom_label_1: { type: String, default: null },
  custom_label_2: { type: String, default: null },
  custom_label_3: { type: String, default: null },
  custom_label_4: { type: String, default: null },
});

MarketplaceListing.discriminator(MARKETPLACE_PLATFORM.GOOGLE, googleSchema);

module.exports = MarketplaceListing;
