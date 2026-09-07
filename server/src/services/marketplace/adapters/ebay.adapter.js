// services/marketplace/adapters/ebay.adapter.js
//
// Implements the marketplace adapter interface for eBay.
// Wraps the existing eBay API service so the underlying HTTP sequence
// (upsert inventory item → create/recover offer → publish) is unchanged.
//
// Multi-tenant: `settings` (an EbaySettings doc, see ebay.settings.service.js)
// carries this tenant's refresh_token/marketplace/policies and is threaded
// into every eBay API call instead of a single global credential.
//
// Interface:
//   key                                            -> "ebay"
//   manifest                                        -> catalogue entry (see registry.js#list)
//   capabilities                                    -> { publish, inventory, batch, orders, webhooks, inboundInventory, variants }
//   loadSettings(tenantId)                          -> resolved eBay settings, or null if never connected
//   publish(resolved, settings, hooks?, seq?)      -> { external_listing_id, external_offer_id, quantity }
//   update(resolved, settings, hooks?, seq?)       -> { external_listing_id, external_offer_id, quantity }
//   end(listing)                                   -> void
//
// There is no separate lightweight "just push a quantity" entry point
// anymore (the old pushInventory/push_quantity job) — every quantity push,
// whatever triggered it, goes through publish/update via the sync_listing
// job, so there's exactly one writer path and one fencing check (`seq` vs
// MarketplaceListing.last_pushed_seq) instead of two independently-fenced
// (or worse, one unfenced) ones. See inventory.service.js#fanOutMarketplaceInventory
// and marketplace/sync.service.js#syncListing.
//
// hooks.onOfferCreated(offerId) is invoked as soon as an offer ID is known,
// before the (separate, failure-prone) publish call — lets the caller persist
// it immediately so a later failure doesn't cause a retry to recreate the offer.

const { logger } = require("../../../loaders/logging");
const {
  EbayApiError,
  credentialsConfigured,
  getAccessToken,
  buildInventoryItemFromResolved,
  normalizeCondition,
  buildOfferFromResolved,
  upsertInventoryItem,
  createOffer,
  updateOffer,
  publishOffer,
  deleteProduct,
  ensureLocation,
} = require("../../ebay/ebay.api.service");
const { getConditionPolicies } = require("../../ebay/ebay.catalog.service");
const { getSettings: getEbaySettings } = require("../../ebay/ebay.settings.service");
const { EBAY_ERROR_CODE } = require("../../../constants/ebay.constants");
const { getTotalStockForProductVariant } = require("../../inventory.service");
const { resolveSku } = require("../listing.resolver");
const Product = require("../../../models/Product");
const ProductVariant = require("../../../models/ProductVariant");
const MarketplaceListing = require("../../../models/MarketplaceListing");

const key = "ebay";

// GET /api/v1/channels merges this with the tenant's ChannelConnection
// status/health (see channel.controller.js) — logo is left null, not a path
// into assets/branding (no eBay asset exists there), since the frontend
// isn't touched in this run and can decide how to render an icon for it.
const manifest = {
  key,
  name: "eBay",
  logo: null,
  description: "Publish listings and sync inventory with eBay.",
  status: "active",
  authType: "oauth",
  setupSteps: [
    "Connect your eBay seller account via OAuth",
    "Set your eBay marketplace and warehouse address",
    "Choose default fulfillment/payment/return business policies",
  ],
  requiredTenantData: ["marketplace_id", "warehouse_address", "business_policies"],
};

const capabilities = {
  publish: true,
  inventory: true,
  batch: false,
  orders: true,
  webhooks: true,
  inboundInventory: true,
  variants: true,
};

// Resolves this tenant's eBay settings for the generic sync dispatcher (see
// sync.service.js). Deliberately mirrors getEbaySettings' own contract
// exactly (an object — possibly with every field null/default for a never-
// connected tenant — never `null` itself), NOT the newer generic
// loadSettings contract's "null means not connected" convention.
// NOTE: an eBay tenant with active listings but no credentials configured
// still reaches publish()/update() below exactly as it always has, and gets
// the same "credentials not configured" thrown error (retried by Bull same
// as today) — the generic "not connected" skip in sync.service.js is for
// adapters whose loadSettings legitimately returns null (a platform with no
// resolvable settings at all), which never happens for eBay. Changing that
// would be an observable behavior change for eBay this migration must avoid.
async function loadSettings(tenantId) {
  return getEbaySettings(tenantId);
}

// Keeps MarketplaceListing.ebay_synced_quantity current whenever WE push a
// quantity to eBay, so the inventory-sync poller (ebay.inventory-sync.service.js)
// can tell "eBay changed since we last touched it" apart from "we're the ones
// who just changed it" — without this, our own push would look identical to
// a manual edit on eBay's side and get redundantly (and confusingly) diffed.
// Called ONLY after the eBay write has confirmed success — see publish()/
// update() below — never preemptively.
//
// updateMany, not updateOne — reconcileEbayInventoryForTenant's own comment
// documents that duplicate listings CAN share one {tenant_id, product,
// variant, platform} combo if the unique index protecting that is ever
// missing (found live once already). With updateOne, only whichever
// duplicate the query happens to match first gets its baseline stamped and
// the other silently drifts forever, undetected. updateMany keeps every
// duplicate's baseline consistent even in that degraded state — belt and
// suspenders on top of the index actually being correct.
async function updateSyncBaseline(productId, variantId, quantity, tenantId, seq = null) {
  await MarketplaceListing.updateMany(
    { tenant_id: tenantId, product: productId, variant: variantId || null, platform: key },
    {
      $set: {
        // TODO(dual-write): remove ebay_synced_quantity/ebay_synced_at after
        // backfill — synced_quantity/synced_at (base schema, generic) are
        // the replacement. Both are written during the transition so a
        // rollback to pre-migration code (which only reads
        // ebay_synced_quantity) keeps working.
        ebay_synced_quantity: quantity,
        ebay_synced_at: new Date(),
        ebay_pending_reconcile_qty: null,
        synced_quantity: quantity,
        synced_at: new Date(),
        ...(seq != null ? { last_pushed_seq: seq } : {}),
      },
    },
    // ebay_synced_quantity/ebay_synced_at/ebay_pending_reconcile_qty are
    // eBay-discriminator-only fields (declared on ebaySchema, not
    // MarketplaceListing's base schema) — a base-model update casts against
    // the base schema only and silently drops anything it doesn't recognize
    // under Mongoose's default strict mode. synced_quantity/synced_at/
    // last_pushed_seq no longer need this (moved to the base schema), but
    // the still-discriminator-only fields above do.
    { strict: false },
  );
}

// Preferred fallback order when the stored condition isn't accepted for the
// listing's category — e.g. "USED_GOOD" is invalid for a primary category
// that only allows "USED_ACCEPTABLE" (eBay error 25021). We stay within the
// same condition family (new-like vs. used-like) rather than jumping across.
// used family ordered 3000 (USED_EXCELLENT) first, not 5000 (USED_GOOD):
// 4000/5000/6000 are eBay's MEDIA grades (books, DVDs, games) — most eBay
// Motors parts categories don't accept them at all, only 3000/6000/7000, so
// leading with a media-only grade picked the wrong one whenever a category
// happened to accept more than one used-family id. See normalizeCondition's
// own comment in ebay.api.service.js for the matching default-mapping fix.
const CONDITION_FALLBACK_ORDER = {
  new: ["NEW", "NEW_OTHER", "LIKE_NEW", "CERTIFIED_REFURBISHED", "EXCELLENT_REFURBISHED", "VERY_GOOD_REFURBISHED", "GOOD_REFURBISHED", "SELLER_REFURBISHED"],
  used: ["USED_EXCELLENT", "USED_VERY_GOOD", "USED_GOOD", "USED_ACCEPTABLE", "FOR_PARTS_OR_NOT_WORKING"],
};

// Thrown by resolveCategoryCondition when a listing's condition could not be
// verified against eBay's per-category policy — the lookup either threw or
// came back with no accepted conditions at all. `.status = 400` is what
// circuitBreaker.js's isTransportOrAuthFailure keys off to classify this as
// a per-item data problem, not a transport/auth failure (same convention as
// every other 400-level rejection) — a bad/unverifiable condition on ONE
// listing says nothing about whether this tenant's eBay connection itself
// is healthy, and must never pause syncing for every other listing.
// `.code` is a stable, machine-readable identifier that flows through into
// the listing's ChannelSyncLog row (see sync.service.js's catch block).
class ConditionUnverifiedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConditionUnverifiedError";
    this.status = 400;
    this.code = "CONDITION_UNVERIFIED";
  }
}

// Resolves the stored listing condition to one eBay actually accepts for the
// listing's primary category, cross-checking against the Sell Metadata API's
// per-category condition policy instead of assuming a static mapping is
// always valid (it isn't — accepted conditions vary by category).
//
// "We could not verify this" and "we verified this and it's fine" used to
// both silently resolve to the same fallback condition — an empty policy
// list, or the lookup itself throwing, both just returned the raw,
// unverified condition and let it through to eBay, which only ever caught
// the mismatch much later, at publishOffer, with a far less useful error
// (25021 — see this function's own git history for the incident that
// exposed it: a sandbox/production Metadata-API URL mismatch made every
// lookup fail, silently, for a sandbox-connected tenant). Both are now a
// hard failure — a wrong/unverifiable condition is a listing-data problem
// the merchant must fix, not something worth silently guessing at and
// deferring to a much more confusing eBay-side rejection.
async function resolveCategoryCondition(rawCondition, categoryId, settings, sku = null) {
  const fallback = normalizeCondition(rawCondition, sku);
  if (!categoryId) {
    // publish() throws on a missing ebay_category_id immediately after this
    // call anyway (update() logs+skips the offer step) — nothing to verify
    // against without one, so this stays a silent early return, just made
    // traceable for anyone debugging why verification never ran.
    logger.debug(`[EbayAdapter] resolveCategoryCondition: no ebay_category_id yet — using "${fallback}" unverified`);
    return fallback;
  }

  const marketplaceId = settings?.marketplace_id || "unknown";
  const sandbox = !!settings?.sandbox;

  let conditions;
  try {
    ({ conditions } = await getConditionPolicies(categoryId, settings));
  } catch (err) {
    logger.warn(
      `[EbayAdapter] condition policy lookup failed for category ${categoryId} (marketplace ${marketplaceId}, sandbox=${sandbox}): ${err.message}`,
    );
    throw new ConditionUnverifiedError(
      `Could not verify item condition for eBay category ${categoryId}: condition policy lookup failed (${err.message})`,
    );
  }

  const validIds = conditions.map((c) => c.conditionId);

  if (validIds.length === 0) {
    logger.warn(
      `[EbayAdapter] condition policy lookup for category ${categoryId} (marketplace ${marketplaceId}, sandbox=${sandbox}) returned no accepted conditions`,
    );
    throw new ConditionUnverifiedError(
      `Could not verify item condition for eBay category ${categoryId}: eBay returned no accepted conditions for this category`,
    );
  }

  // Verified — happy path, stays silent so logs don't get noisy.
  if (validIds.includes(fallback)) return fallback;

  const family = fallback === "NEW" ? "new" : "used";
  const preferred = CONDITION_FALLBACK_ORDER[family].find((c) => validIds.includes(c));
  if (preferred) {
    logger.warn(`[EbayAdapter] condition "${fallback}" invalid for category ${categoryId} — using "${preferred}" instead`);
    return preferred;
  }

  logger.warn(`[EbayAdapter] condition "${fallback}" invalid for category ${categoryId} and no same-family match — using "${validIds[0]}" instead`);
  return validIds[0];
}

function isPriceLockedBySaleError(err) {
  return err instanceof EbayApiError && err.hasErrorId(EBAY_ERROR_CODE.PRICE_LOCKED_BY_ACTIVE_SALE);
}

// A stored external_offer_id eBay no longer recognizes — deleted/expired on
// eBay's side, or a stale/bad ID. See EBAY_ERROR_CODE's comment for why two
// codes both mean this.
function isOfferMissingError(err) {
  return (
    err instanceof EbayApiError &&
    (err.hasErrorId(EBAY_ERROR_CODE.OFFER_NOT_FOUND_INPUT) || err.hasErrorId(EBAY_ERROR_CODE.OFFER_NOT_FOUND_RESOURCE))
  );
}

// updateOffer, tolerant of eBay rejecting the price/quantity revision because
// the offer is part of an active sale (error 25019) — that's not something
// retrying or erroring out helps with, it resolves itself once the sale ends
// or is reconfigured on eBay, so this is treated as a soft skip (logged, not
// thrown) rather than the same hard failure as every other updateOffer error.
async function updateOfferTolerant(token, settings, offerId, offerBody, sku) {
  try {
    await updateOffer(token, settings, offerId, offerBody);
    return { priceLocked: false };
  } catch (err) {
    if (!isPriceLockedBySaleError(err)) throw err;
    logger.warn(`[EbayAdapter] ${sku}: price update skipped — offer ${offerId} is part of an active eBay sale`);
    return { priceLocked: true };
  }
}

// Creates a fresh offer, recovering from eBay reporting one already exists
// for this SKU (25002 — extracts the offerId eBay reports back and switches
// to updateOffer instead). Shared by publish()'s "no offerId yet" branch and
// both publish()/update()'s "stored offerId is dead" recovery below, so
// there's exactly one place that knows how to stand up an offer from
// scratch.
async function createOrRecoverOffer(token, settings, offerBody, sku) {
  try {
    const offerId = await createOffer(token, settings, offerBody);
    return { offerId, priceLocked: false };
  } catch (createErr) {
    const existingMatch = createErr.message.match(/"name":"offerId","value":"(\d+)"/);
    if (!existingMatch) throw createErr;
    const offerId = existingMatch[1];
    logger.warn(`[EbayAdapter] offer already exists (${offerId}), switching to updateOffer`);
    const { priceLocked } = await updateOfferTolerant(token, settings, offerId, offerBody, sku);
    return { offerId, priceLocked };
  }
}

// null means "don't send eBay a quantity at all" — a merchant with
// stock_control=false has explicitly said they don't track this product's
// stock, so any number this app sends is a fabrication. The previous
// behavior (Math.max(total, 1), i.e. "always claim at least 1 available")
// wrote a number to eBay with no real basis. Leaving eBay's own quantity
// alone — set by the seller directly, or left at whatever it already was —
// is the honest option. Callers must skip the quantity portion of the sync
// entirely when this returns null (see buildInventoryItemFromResolved /
// buildOfferFromResolved in ebay.api.service.js) and must not call
// updateSyncBaseline, since there is no expected-eBay-quantity to track for
// an untracked-stock product.
async function resolveQuantity(resolved) {
  const { product, variant } = resolved;
  if (!product.stock_control) return null;
  return getTotalStockForProductVariant(product._id, variant ? variant._id : null);
}

async function publish(resolved, settings, hooks = {}, seq = null) {
  if (!credentialsConfigured(settings)) {
    throw new Error("[EbayAdapter] eBay credentials not configured for this tenant");
  }

  const token = await getAccessToken(settings);
  if (!token) throw new Error("[EbayAdapter] Could not obtain eBay access token");

  const { listing } = resolved;
  const quantity = await resolveQuantity(resolved);

  // Push 0 normally — an item genuinely out of stock still gets its true
  // quantity written to eBay. Refusing to write here (the old behavior)
  // meant eBay kept selling stock we don't have; the listing stays alive at
  // 0 via eBay's own out-of-stock handling, not by us hiding the number.
  // marketplace/sync.service.js sets sync_status OUT_OF_STOCK for
  // visibility, but only after this write succeeds — see its own comment.

  // Step 1 — inventory item
  const condition = await resolveCategoryCondition(listing.condition, listing.ebay_category_id, settings, resolved.sku);
  const inventoryItem = buildInventoryItemFromResolved(resolved, quantity, condition, settings);
  await upsertInventoryItem(token, settings, inventoryItem);
  logger.info(`[EbayAdapter] inventory_item upserted: ${resolved.sku} (qty: ${quantity ?? "untracked"})`);
  // null quantity (stock_control=false) has nothing to track a baseline
  // for — see resolveQuantity's comment.
  if (quantity != null) {
    await updateSyncBaseline(resolved.product._id, resolved.variant?._id, quantity, listing.tenant_id, seq);
  }

  if (!listing.ebay_category_id) {
    throw new Error(`[EbayAdapter] ${resolved.sku}: ebay_category_id is required to publish`);
  }

  // Step 2 — ensure merchant location exists (creates it from this tenant's
  // warehouse address if missing)
  await ensureLocation(token, settings);

  // Step 4 — create/update offer (recover from 25002 if it already exists,
  // or from the stored offerId being dead on eBay's side — see
  // isOfferMissingError)
  logger.info(`[EbayAdapter] using categoryId: "${listing.ebay_category_id}"`);
  const offerBody = buildOfferFromResolved(resolved, settings, quantity);
  let offerId = listing.external_offer_id || null;
  let priceLocked = false;

  if (offerId) {
    try {
      ({ priceLocked } = await updateOfferTolerant(token, settings, offerId, offerBody, resolved.sku));
      if (!priceLocked) logger.info(`[EbayAdapter] offer updated: ${offerId}`);
    } catch (err) {
      if (!isOfferMissingError(err)) throw err;
      logger.warn(`[EbayAdapter] ${resolved.sku}: stored offer ${offerId} no longer exists on eBay — recreating`);
      ({ offerId, priceLocked } = await createOrRecoverOffer(token, settings, offerBody, resolved.sku));
      logger.info(`[EbayAdapter] offer recreated: ${offerId}`);
    }
  } else {
    ({ offerId, priceLocked } = await createOrRecoverOffer(token, settings, offerBody, resolved.sku));
    logger.info(`[EbayAdapter] offer created: ${offerId}`);
  }

  // Persist the offer ID immediately, before the publish call — otherwise a
  // publishOffer() failure/timeout leaves the local doc unaware the offer
  // already exists, and a retry would call createOffer() again for the same
  // SKU, producing a second offer on eBay.
  await hooks.onOfferCreated?.(offerId);

  // Step 5 — publish
  const listingId = await publishOffer(token, settings, offerId);
  logger.info(`[EbayAdapter] offer published, listingId: ${listingId}`);

  return {
    external_listing_id: listingId,
    external_offer_id: offerId,
    quantity,
    ...(priceLocked ? { priceLocked: true } : {}),
  };
}

async function update(resolved, settings, hooks = {}, seq = null) {
  if (!credentialsConfigured(settings)) {
    throw new Error("[EbayAdapter] eBay credentials not configured for this tenant");
  }

  const token = await getAccessToken(settings);
  if (!token) throw new Error("[EbayAdapter] Could not obtain eBay access token");

  const { listing } = resolved;
  const quantity = await resolveQuantity(resolved);

  // Push 0 normally — see the matching comment in publish() above.

  // Step 1 — sync inventory item
  const condition = await resolveCategoryCondition(listing.condition, listing.ebay_category_id, settings, resolved.sku);
  const inventoryItem = buildInventoryItemFromResolved(resolved, quantity, condition, settings);
  await upsertInventoryItem(token, settings, inventoryItem);
  logger.info(`[EbayAdapter] inventory_item upserted (update): ${resolved.sku} (qty: ${quantity ?? "untracked"})`);
  if (quantity != null) {
    await updateSyncBaseline(resolved.product._id, resolved.variant?._id, quantity, listing.tenant_id, seq);
  }

  if (!listing.ebay_category_id) {
    logger.warn(`[EbayAdapter] ${resolved.sku}: ebay_category_id missing — skipping offer update`);
    return {
      external_listing_id: listing.external_listing_id || null,
      external_offer_id: listing.external_offer_id || null,
      quantity,
    };
  }

  // Step 2 — update offer (recover from the stored offerId being dead on
  // eBay's side — see isOfferMissingError — the same as the "lost the
  // offerId entirely" path just below)
  const offerBody = buildOfferFromResolved(resolved, settings, quantity);
  let offerId = listing.external_offer_id || null;

  if (offerId) {
    try {
      const { priceLocked } = await updateOfferTolerant(token, settings, offerId, offerBody, resolved.sku);
      if (!priceLocked) logger.info(`[EbayAdapter] offer updated: ${offerId}`);
      return {
        external_listing_id: listing.external_listing_id || null,
        external_offer_id: offerId,
        quantity,
        ...(priceLocked ? { priceLocked: true } : {}),
      };
    } catch (err) {
      if (!isOfferMissingError(err)) throw err;
      logger.warn(`[EbayAdapter] ${resolved.sku}: stored offer ${offerId} no longer exists on eBay — recreating`);
      offerId = null;
    }
  }

  // Listing is "active" but we lost the offerId (or the stored one was dead
  // on eBay's side, above) — re-create and re-publish
  const { offerId: newOfferId, priceLocked } = await createOrRecoverOffer(token, settings, offerBody, resolved.sku);
  offerId = newOfferId;
  // Persist immediately — see the comment in publish() for why this can't
  // wait until after publishOffer() succeeds.
  await hooks.onOfferCreated?.(offerId);
  const listingId = await publishOffer(token, settings, offerId);
  return {
    external_listing_id: listingId,
    external_offer_id: offerId,
    quantity,
    ...(priceLocked ? { priceLocked: true } : {}),
  };
}

async function end(listing) {
  const offerId = listing.external_offer_id || null;

  let sku = listing.store_sku || null;
  const productId = listing.product?._id || listing.product;
  const variantId = listing.variant?._id || listing.variant || null;
  const [product, variant] = await Promise.all([
    Product.findById(productId).select("_id sku tenant_id").lean(),
    variantId ? ProductVariant.findById(variantId).select("_id sku").lean() : Promise.resolve(null),
  ]);
  if (!sku && product) sku = resolveSku(listing, product, variant);

  if (!sku) {
    logger.warn("[EbayAdapter] end called with no resolvable SKU — nothing to withdraw");
    return;
  }
  if (!product) {
    logger.warn(`[EbayAdapter] end: product not found for listing ${listing._id} — cannot resolve tenant, nothing to withdraw`);
    return;
  }

  const settings = await getEbaySettings(product.tenant_id);
  const result = await deleteProduct(settings, sku, offerId);
  if (result.error) throw new Error(result.error);
  logger.info(`[EbayAdapter] listing ended: ${sku}`);
}

module.exports = {
  key,
  manifest,
  capabilities,
  loadSettings,
  publish,
  update,
  end,
  // Exported for tests (ebay.adapter.condition.test.js) — not part of the
  // generic adapter contract.
  resolveCategoryCondition,
  ConditionUnverifiedError,
};
