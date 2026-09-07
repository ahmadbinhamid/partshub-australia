// services/marketplace/adapters/google.adapter.js
//
// Implements the marketplace adapter interface for Google Shopping
// (Merchant API). Mirrors ebay.adapter.js's shape and conventions — see
// that file's own module header for the shared contract every adapter
// conforms to (registry.js is the source of truth for what's required).
//
// Google is feed-shaped, not listing-shaped: there is no offer/publish
// lifecycle the way eBay has create-offer/publish-offer as separate steps.
// publish() and update() are both just productInputs.insert (Merchant API's
// own upsert semantics) — kept as two exports only because the registry
// contract requires both; they do the same thing here.
//
// NOTE on API shape confidence: this adapter originally targeted v1beta,
// written without live Google credentials to verify against. Migrated to
// v1 after v1beta was actually discontinued (2026-02-28) and a real connect
// attempt surfaced it — see google.merchant.api.service.js and
// google.datasource.service.js's own comments. Confirmed against real API
// responses/errors (not guessed) during that and subsequent live pushes:
// `channel` field removal (ProductInput and PrimaryProductDataSource),
// `gtin` -> `gtins` rename, and `availabilityFor`'s enum (a real
// productInputs.insert rejected the old lowercase "in stock" with 400
// INVALID_ARGUMENT — see that function's own comment for the fix). What's
// STILL not verified against a live call: the rest of ProductAttributes'
// field names/casing (price, condition, shippingLabel, customLabel0-4,
// googleProductCategory) — cross-check buildProductInputFromResolved's full
// payload against a real successful productInputs.insert response before
// relying on those.

const { logger } = require("../../../loaders/logging");
const config = require("../../../config");
const ChannelConnection = require("../../../models/ChannelConnection");
const googleOauthService = require("../../google/google.oauth.service");
const googleMerchantApi = require("../../google/google.merchant.api.service");
const { resolveProductUrl, resolveIdentifiers } = require("../listing.resolver");
const { MARKETPLACE_PLATFORM } = require("../../../constants/marketplace.constants");

// TASK 2: Google will silently ACCEPT a productInputs.insert whose imageLink
// isn't a public HTTPS URL and only disapprove the product later (async,
// off this app's radar) — the exact same silent-failure shape eBay already
// guards against on its own side (ebay.api.service.js#resolveImageUrls:
// warns and drops non-HTTPS entries, throws if nothing usable is left).
// Google has no such guard today. Mirrors eBay's status/code convention
// (see ebay.adapter.js's ConditionUnverifiedError) so this is classified as
// a per-item data problem, not a transport failure — status 400 keeps
// circuitBreaker.js#isTransportOrAuthFailure from tripping the breaker over
// a bad photo, and sync.service.js already writes a ChannelSyncLog FAILURE
// row for any thrown adapter error, keyed by this error's `.code`, so no
// separate logging call is needed here.
class GoogleImageValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleImageValidationError";
    this.status = 400;
    this.code = "INVALID_IMAGE_URL";
  }
}

// Deliberately stricter than "starts with https://" (what eBay's own check
// uses) — an absolute-URL parse also catches a value that merely CONTAINS
// that prefix without actually being one (e.g. a relative path someone
// concatenated wrong), which a plain startsWith would let through as a
// false "looks fine".
function isAbsoluteHttpsUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

const key = MARKETPLACE_PLATFORM.GOOGLE;

const manifest = {
  key,
  name: "Google Shopping",
  logo: null,
  description: "Publish your catalogue to Google Shopping via the Merchant API.",
  status: "active",
  authType: "oauth",
  setupSteps: [
    "Connect your Google Merchant Center account via OAuth",
    "Confirm your feed label, content language, and target country",
    "A product data source is created automatically on connect",
  ],
  requiredTenantData: ["merchant_id", "feed_label", "content_language", "target_country"],
  // TASK 5: Merchant Center requires a claimed AND verified website with
  // real product pages — a tenant with no verified default Domain has
  // nothing for Google to crawl/verify, and every product push would end
  // up disapproved. Absent/false (the registry contract's default for any
  // adapter that doesn't set this — see registry.js's own header) means a
  // platform genuinely doesn't need one; eBay never sets this. Read by
  // channel.service.js#listChannelsForTenant (marks the channel
  // unavailable with a reason) and google.controller.js#getConnectUrl
  // (refuses to start OAuth at all) — see server/docs/channel-architecture.md §9.
  requiresStorefront: true,
};

const capabilities = {
  publish: true,
  inventory: true,
  batch: true,
  orders: false,
  webhooks: false,
  inboundInventory: false,
  variants: true,
};

// Google Merchant Center expires a product that isn't refreshed within 30
// days (https://support.google.com/merchants/answer/6324473's own guidance:
// "you should update or refresh them with a regular cadence (at least every
// 30 days)"). Deliberately defaults UNDER that cap — see
// config/index.js#channels.refreshIntervalDays's own comment — to leave
// headroom for a missed sweep run or a transient failure before Google's
// real deadline hits. Consumed by refresh.service.js / channel.worker.js;
// see registry.js's interface comment for the field's generic contract.
const refreshIntervalDays = config.channels.refreshIntervalDays;

// Follows the GENERIC contract (registry.js), unlike eBay's deliberately
// non-generic loadSettings (see that file's own comment on why it never
// returns null) — Google has no legacy pre-ChannelConnection source to
// preserve compatibility with, so there's no reason to deviate: a tenant
// with no ChannelConnection row at all returns null, and
// sync.service.js#syncListing's existing "not connected" skip path (already
// there for exactly this contract — see that file) handles it without ever
// reaching publish()/update() at all.
async function loadSettings(tenantId) {
  const conn = await ChannelConnection.findOne({ tenant_id: tenantId, platform: key })
    .select("+access_token_ct +refresh_token_ct")
    .lean();
  return conn || null;
}

function assertConfigured(settings) {
  if (!settings?.refresh_token_ct || !settings?.merchant_id || !settings?.data_source_id) {
    throw new Error(
      `[GoogleAdapter] Google Shopping is not fully configured for this tenant (missing refresh token, ` +
        `merchant_id, or data_source_id) — reconnect via Settings.`,
    );
  }
}

// v1's product resource id format DROPS the channel segment entirely —
// contentLanguage~feedLabel~offerId (confirmed against the real API's own
// migration docs; the old v1beta format was
// channel~contentLanguage~feedLabel~offerId). Getting this wrong is
// silent: a wrong resource name 404s on delete, and end() already (validly)
// treats 404 as "already gone" success — so a stale 4-segment name would
// never actually remove the listing from Google while looking like it did.
// This is just our OWN identifier string composition, not itself an API
// request field.
function buildProductResourceName(settings, sku) {
  return `${settings.content_language}~${settings.feed_label}~${sku}`;
}

// Full Merchant API resource name (accounts/{merchant}/products/{name}) —
// needed by productInputs.delete (end()), which addresses a product by its
// complete path, unlike insert (which takes the short name as `offerId` in
// the request body and derives the rest from channel/dataSource).
function buildFullProductResourceName(settings, sku) {
  return `accounts/${settings.merchant_id}/products/${buildProductResourceName(settings, sku)}`;
}

// Merchant API v1's Availability is a real ALL_CAPS enum (IN_STOCK /
// OUT_OF_STOCK / PREORDER / LIMITED_AVAILABILITY / BACKORDER) — NOT the
// classic Content API's literal lowercase strings ("in stock"/"out of
// stock") this originally shipped with, based on that historical shape
// without a live call to verify against (see this file's own module NOTE).
// Confirmed live: a real productInputs.insert call rejected "in stock" with
// 400 INVALID_ARGUMENT — cross-checked against Google's own generated
// client library docs (google.shopping.merchant.products.v1.Availability)
// to get the exact enum names, not guessed a second time.
function availabilityFor(quantity) {
  return quantity > 0 ? "IN_STOCK" : "OUT_OF_STOCK";
}

// Decision 2 (identifiers): gtin when present; otherwise mpn+brand when
// BOTH present; otherwise identifierExists: false. Never invents/derives an
// identifier — resolveIdentifiers (listing.resolver.js) only ever returns
// what's actually stored. Logged at debug so which branch fired is
// traceable without being noisy at info level for the common case.
function applyIdentifiers(attributes, identifiers, sku) {
  if (identifiers.gtin) {
    // v1 renamed ProductAttributes.gtin -> gtins (now an array) — see
    // buildProductInputFromResolved's own comment on the v1 migration.
    // This app only ever has one GTIN per listing.
    attributes.gtins = [identifiers.gtin];
    logger.debug(`[GoogleAdapter] ${sku}: identifier branch = gtin`);
    return;
  }
  if (identifiers.mpn && identifiers.brand) {
    attributes.mpn = identifiers.mpn;
    attributes.brand = identifiers.brand;
    logger.debug(`[GoogleAdapter] ${sku}: identifier branch = mpn+brand`);
    return;
  }
  attributes.identifierExists = false;
  logger.debug(`[GoogleAdapter] ${sku}: identifier branch = identifierExists:false (no gtin, no complete mpn+brand pair)`);
}

// Builds the full ProductInput resource body. `productUrl` and
// `identifiers` are resolved by the caller (publish/update/publishBatch) —
// kept out of this pure builder so it stays a plain, easily-testable
// function with no DB access of its own.
//
// TASK 1 (this run) / TASK 2 (previous run): throws GoogleImageValidationError
// (never invents a placeholder — see that class's own comment) whenever
// there is no usable public HTTPS primary image — a present-but-unusable
// URL (non-HTTPS, malformed) AND a product with zero photos at all are
// BOTH rejected here now, the same way and for the same reason: Google's
// real API accepts a null/bad imageLink at insert time and only
// disapproves the product later, asynchronously, off this app's radar — a
// photo-less product fails that exact same way, just as reliably as a bad
// URL does, so leaving it unvalidated was the same silent-failure gap this
// whole check exists to close. (Previously left as pre-existing behavior —
// corrected this run; see google.adapter.publish.test.js/
// google.adapter.batch.test.js, whose `attachments: []` fixtures were
// updated alongside this to include a real HTTPS photo, and
// google.adapter.image-validation.test.js's own new zero-photo test.) A
// non-HTTPS ADDITIONAL image is still just dropped with a warning, not
// fatal — Google can still list the product on its primary photo alone.
function buildProductInputFromResolved(resolved, settings, quantity, identifiers, productUrl) {
  const { sku, title, description, price, photos, listing } = resolved;

  const rawUrls = (photos || []).map((p) => (typeof p === "string" ? p : p?.url)).filter(Boolean);
  const primaryImageUrl = rawUrls[0] || null;

  if (!isAbsoluteHttpsUrl(primaryImageUrl)) {
    throw new GoogleImageValidationError(
      `[GoogleAdapter] ${sku}: primary image is not a usable public HTTPS URL` +
        (primaryImageUrl ? ` (got "${primaryImageUrl}")` : " (product has no images)") +
        " — Google Shopping requires a real, publicly reachable https:// image. Check UPLOADS_URL.",
    );
  }

  const additionalImageUrls = rawUrls.slice(1).filter((url) => {
    if (isAbsoluteHttpsUrl(url)) return true;
    logger.warn(`[GoogleAdapter] ${sku}: dropping non-HTTPS additional image URL ("${url}") — Google Shopping only accepts public HTTPS image URLs`);
    return false;
  });

  const attributes = {
    title,
    description,
    link: productUrl,
    imageLink: primaryImageUrl,
    ...(additionalImageUrls.length > 0 ? { additionalImageLinks: additionalImageUrls } : {}),
    availability: availabilityFor(quantity),
    condition: listing.condition || "new",
    price: {
      amountMicros: String(Math.round((price || 0) * 1_000_000)),
      currencyCode: settings.target_country ? currencyForCountry(settings.target_country) : "USD",
    },
    ...(listing.google_product_category ? { googleProductCategory: listing.google_product_category } : {}),
    ...(listing.shipping_label ? { shippingLabel: listing.shipping_label } : {}),
    ...(listing.custom_label_0 ? { customLabel0: listing.custom_label_0 } : {}),
    ...(listing.custom_label_1 ? { customLabel1: listing.custom_label_1 } : {}),
    ...(listing.custom_label_2 ? { customLabel2: listing.custom_label_2 } : {}),
    ...(listing.custom_label_3 ? { customLabel3: listing.custom_label_3 } : {}),
    ...(listing.custom_label_4 ? { customLabel4: listing.custom_label_4 } : {}),
  };

  applyIdentifiers(attributes, identifiers, sku);

  // v1 removed `channel` from ProductInput entirely (confirmed against the
  // real API's migration guide — see google.merchant.api.service.js's own
  // comment on the v1beta -> v1 migration this app went through, forced by
  // Google discontinuing v1beta on 2026-02-28). feedLabel/contentLanguage/
  // offerId are unchanged.
  return {
    contentLanguage: settings.content_language,
    feedLabel: settings.feed_label,
    offerId: sku,
    productAttributes: attributes,
  };
}

// NOTE: no dedicated currency-per-country map/config exists anywhere else
// in this codebase to reuse (unlike ebay.constants.js#EBAY_MARKETPLACE_CURRENCY,
// which exists for eBay's own marketplace ids) — this is a minimal,
// same-shaped fallback covering the handful of countries this app's own
// tenants are realistically in, defaulting to USD. Extend as new target
// countries are actually connected, same spirit as the eBay map's own
// currencyForMarketplace.
const COUNTRY_CURRENCY = { AU: "AUD", US: "USD", GB: "GBP", NZ: "NZD", CA: "CAD" };
function currencyForCountry(countryCode) {
  return COUNTRY_CURRENCY[countryCode] || "USD";
}

// Decision 3 (untracked stock): a product with stock_control off must never
// reach Google at all, not be published as in_stock. Enforced HERE (in the
// adapter, per this run's own instruction), signaled back to
// sync.service.js#syncListing as an explicit `{ skipped, reason }` result —
// additive to the existing success/{external_listing_id,...}/throw contract
// every adapter already returns; eBay's adapter never sets this, so
// syncListing's new handling of it (see that file) is a no-op for eBay.
function isUntrackedStock(resolved) {
  return resolved.product?.stock_control === false;
}

async function resolveQuantity(resolved) {
  const { getTotalStockForProductVariant } = require("../../inventory.service");
  const { product, variant } = resolved;
  return getTotalStockForProductVariant(product._id, variant ? variant._id : null);
}

async function publishOrUpdate(resolved, settings) {
  assertConfigured(settings);

  if (isUntrackedStock(resolved)) {
    logger.info(`[GoogleAdapter] ${resolved.sku}: stock_control is off — excluded from Google Shopping, not published as in_stock`);
    return { skipped: true, reason: "untracked_stock" };
  }

  const { listing, product } = resolved;
  const quantity = await resolveQuantity(resolved);
  const identifiers = resolveIdentifiers(listing, product);
  // Fails loudly (throws) if the tenant has no resolvable host (verified
  // default domain or linkDomain fallback) or the product has no slug —
  // see listing.resolver.js#resolveProductUrl's own comment.
  const productUrl = await resolveProductUrl(listing.tenant_id, product.slug, resolved.sku, key);

  const token = await googleOauthService.getValidAccessToken(settings);
  if (!token) throw new Error(`[GoogleAdapter] ${resolved.sku}: could not obtain a valid Google access token`);

  const productInput = buildProductInputFromResolved(resolved, settings, quantity, identifiers, productUrl);
  await googleMerchantApi.insertProductInput(token, settings, productInput);
  logger.info(`[GoogleAdapter] product input upserted: ${resolved.sku} (qty: ${quantity}, availability: ${productInput.productAttributes.availability})`);

  return {
    external_listing_id: buildProductResourceName(settings, resolved.sku),
    external_offer_id: null,
    quantity,
  };
}

async function publish(resolved, _settings, _hooks, _seq) {
  return publishOrUpdate(resolved, _settings);
}

async function update(resolved, _settings, _hooks, _seq) {
  return publishOrUpdate(resolved, _settings);
}

async function end(listing) {
  const productId = listing.product?._id || listing.product;
  if (!productId) {
    logger.warn("[GoogleAdapter] end called with no resolvable product — nothing to withdraw");
    return;
  }

  const Product = require("../../../models/Product");
  const product = await Product.findById(productId).select("_id sku slug tenant_id").lean();
  if (!product) {
    logger.warn(`[GoogleAdapter] end: product not found for listing ${listing._id} — cannot resolve tenant, nothing to withdraw`);
    return;
  }

  const settings = await loadSettings(product.tenant_id);
  if (!settings) {
    logger.warn(`[GoogleAdapter] end: tenant ${product.tenant_id} has no Google connection — nothing to withdraw`);
    return;
  }

  const sku = listing.store_sku || product.sku || `ph-${product._id}`;
  const token = await googleOauthService.getValidAccessToken(settings);
  if (!token) throw new Error(`[GoogleAdapter] end: could not obtain a valid Google access token for tenant ${product.tenant_id}`);

  await googleMerchantApi.deleteProductInput(token, settings, buildFullProductResourceName(settings, sku));
  logger.info(`[GoogleAdapter] listing ended: ${sku}`);
}

// Batch path (Task 3) — see google.merchant.api.service.js's own NOTE on why
// this is per-item calls under bounded concurrency rather than a single
// physical batch HTTP request (no documented Merchant API batch endpoint
// for productInputs). Returns one result per input item, in the SAME
// order, so sync.service.js#syncBatch can map results back to the listings
// it built `resolvedList` from without needing a shared key.
const BATCH_CONCURRENCY = 10;

async function publishBatch(resolvedList, settings) {
  assertConfigured(settings);

  const token = await googleOauthService.getValidAccessToken(settings);
  if (!token) throw new Error("[GoogleAdapter] publishBatch: could not obtain a valid Google access token");

  const results = new Array(resolvedList.length);

  async function processOne(index) {
    const resolved = resolvedList[index];
    try {
      if (isUntrackedStock(resolved)) {
        logger.info(`[GoogleAdapter] ${resolved.sku}: stock_control is off — excluded from Google Shopping (batch)`);
        results[index] = { skipped: true, reason: "untracked_stock" };
        return;
      }

      const { listing, product } = resolved;
      const quantity = await resolveQuantity(resolved);
      const identifiers = resolveIdentifiers(listing, product);
      const productUrl = await resolveProductUrl(listing.tenant_id, product.slug, resolved.sku, key);

      const productInput = buildProductInputFromResolved(resolved, settings, quantity, identifiers, productUrl);
      await googleMerchantApi.insertProductInput(token, settings, productInput);

      results[index] = {
        ok: true,
        external_listing_id: buildProductResourceName(settings, resolved.sku),
        external_offer_id: null,
        quantity,
      };
    } catch (err) {
      logger.warn(`[GoogleAdapter] batch item failed: ${resolved?.sku}: ${err.message}`);
      results[index] = { ok: false, error: err.message, status: err.status ?? null };
    }
  }

  // Simple bounded-concurrency pool — no new dependency for this (e.g.
  // p-limit); a chunk is already small (see sync.service.js's own
  // CHANNEL_BATCH_CHUNK_SIZE), so a hand-rolled worker pool over an index
  // cursor is enough.
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < resolvedList.length) {
      const i = nextIndex++;
      await processOne(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, resolvedList.length) }, () => worker()));

  return results;
}

module.exports = {
  key,
  manifest,
  capabilities,
  loadSettings,
  publish,
  update,
  end,
  publishBatch,
  refreshIntervalDays,
  // Exported for tests.
  buildProductInputFromResolved,
  buildProductResourceName,
  buildFullProductResourceName,
  applyIdentifiers,
  availabilityFor,
  isAbsoluteHttpsUrl,
  GoogleImageValidationError,
};
