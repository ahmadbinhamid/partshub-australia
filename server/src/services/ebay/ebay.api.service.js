// services/ebay/ebay.api.service.js
// Pure eBay API communication layer — no database access, no orchestration
//
// Multi-tenant: client_id/client_secret belong to OUR eBay Application
// (config.ebay.*, shared across every tenant, like a Stripe platform key).
// Everything else — refresh_token, marketplace, sandbox, policies, warehouse
// address — is per-tenant and passed in as a `settings` object (the shape
// returned by ebay.settings.service.js#getSettings(tenantId)). OAuth tokens
// are cached per-tenant (keyed by tenant_id), not as a single global value.

const config = require("../../config");
const { logger } = require("../../loaders/logging");
const { EBAY_SCOPES, currencyForMarketplace } = require("../../constants/ebay.constants");

// eBay's error envelope for a rejected Inventory/Offer API call is
// `{ errors: [{ errorId, message, longMessage, parameters }, ...] }`. Callers
// that only care about "did this fail" can still just read `.message`
// (unchanged format: "<action> failed: <status> <raw body>"), but anything
// that needs to branch on a specific eBay error code (e.g. recovering from
// "offer already exists", or treating "price locked by an active sale" as
// non-fatal) can check `.errorId(code)` instead of parsing the message string.
class EbayApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "EbayApiError";
    this.status = status;
    this.errors = parseEbayErrorBody(body);
  }

  hasErrorId(code) {
    return this.errors.some((e) => e.errorId === code);
  }
}

// eBay's error body is documented JSON, but isn't guaranteed to parse that
// way (a gateway timeout or an unrelated 5xx can return plain text/HTML) —
// fall back to an empty list rather than let a malformed body crash the
// error-handling path itself.
function parseEbayErrorBody(body) {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed.errors) ? parsed.errors : [];
  } catch {
    return [];
  }
}

async function throwEbayApiError(action, res) {
  const text = await res.text();
  throw new EbayApiError(`${action} failed: ${res.status} ${text}`, { status: res.status, body: text });
}

// Strip HTML tags and collapse whitespace for fields that only accept plain text
function toPlainText(html, maxLen = 4000) {
  return (html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

// ── Base URLs ────────────────────────────────────────────────────────────────
// EBAY_API_BASE_URL/EBAY_TAXONOMY_BASE_URL remain a global override (e.g. for
// a proxy) when set; otherwise derived from each tenant's own `sandbox` flag.
function apiBaseUrlFor(sandbox) {
  return config.ebay.apiBaseUrl || (sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com");
}
function taxonomyBaseUrlFor(sandbox) {
  return config.ebay.taxonomyBaseUrl || `${apiBaseUrlFor(sandbox)}/commerce/taxonomy/v1`;
}
function inventoryBaseFor(sandbox) {
  return `${apiBaseUrlFor(sandbox)}/sell/inventory/v1`;
}
function fulfillmentBaseFor(sandbox) {
  return `${apiBaseUrlFor(sandbox)}/sell/fulfillment/v1`;
}
function tokenEndpointFor(sandbox) {
  return `${apiBaseUrlFor(sandbox)}/identity/v1/oauth2/token`;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// Token caches keyed by tenant_id — a single global variable would leak one
// tenant's access token into every other tenant's API calls.
const _tokenCache = new Map(); // tenantId -> { token, expiry }
const _appTokenCache = new Map(); // tenantId -> { token, expiry }

// Catalog/Taxonomy tokens use client_credentials (the app's own credentials,
// no seller consent involved) — genuinely app-level, safe to share globally.
let _cachedCatalogToken = null;
let _catalogTokenExpiry = 0;
let _cachedCategoryTreeId = null;

// Called after a tenant (re)connects via OAuth so a stale access token minted
// against their previous refresh_token can never be served from cache.
function clearTokenCache(tenantId) {
  const key = String(tenantId);
  _tokenCache.delete(key);
  _appTokenCache.delete(key);
}

function credentialsConfigured(settings) {
  return !!(config.ebay.clientId && config.ebay.clientSecret && settings?.refresh_token);
}

async function getAccessToken(settings) {
  if (!credentialsConfigured(settings)) {
    logger.warn("[eBay] Credentials not configured — skipping token fetch");
    return null;
  }

  const key = String(settings.tenant_id);
  const now = Date.now();
  const cached = _tokenCache.get(key);
  if (cached && now < cached.expiry - 30_000) return cached.token;

  const credentials = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: settings.refresh_token,
    scope: `${EBAY_SCOPES.SELL_INVENTORY} ${EBAY_SCOPES.SELL_ACCOUNT} ${EBAY_SCOPES.SELL_FULFILLMENT}`,
  });

  const res = await fetch(tokenEndpointFor(settings.sandbox), {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error(`[eBay] Token fetch failed for tenant ${key}: ${res.status} ${text}`);
    return null;
  }

  const data = await res.json();
  _tokenCache.set(key, { token: data.access_token, expiry: now + (data.expires_in || 7200) * 1000 });
  return data.access_token;
}

async function getAppToken(settings) {
  const key = String(settings?.tenant_id);
  const now = Date.now();
  const cached = _appTokenCache.get(key);
  if (cached && now < cached.expiry - 30_000) return cached.token;

  if (!credentialsConfigured(settings)) {
    logger.warn("[eBay] Credentials not configured — skipping notification token fetch");
    return null;
  }

  const credentials = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString("base64");

  // Uses refresh_token grant so the notification scope rides on the seller's existing OAuth consent
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: settings.refresh_token,
    scope: EBAY_SCOPES.NOTIFICATION_SUBSCRIPTION,
  });

  const res = await fetch(tokenEndpointFor(settings.sandbox), {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error(`[eBay] Notification token fetch failed for tenant ${key}: ${res.status} ${text}`);
    return null;
  }

  const data = await res.json();
  _appTokenCache.set(key, { token: data.access_token, expiry: now + (data.expires_in || 7200) * 1000 });
  return data.access_token;
}

// App token scoped for Taxonomy / Catalog APIs (client_credentials, base scope)
// — not tenant-specific, cached once for the whole process.
// Catalog/Taxonomy calls always use PRODUCTION app credentials + the
// PRODUCTION token endpoint (see the fetch below and taxonomyBaseUrlFor's
// own callers) — this is intentional even for an otherwise all-sandbox
// setup, since eBay's sandbox taxonomy tree doesn't work. Practically, this
// means a developer running a sandbox-only tenant still needs real
// PRODUCTION EBAY_CLIENT_ID/EBAY_CLIENT_SECRET (App ID + Cert ID) in .env
// for anything that touches categories/aspects — see server/.env.example
// and server/docs/ebay-setup.md. Get eBay to reject those specifically
// (invalid_client) and this used to surface as a bare, unhelpful 500 from
// GET /api/v1/ebay/category-aspects — see ebay.controller.js#getCategoryAspects,
// which now maps this to a 502 naming the actual cause.
async function getCatalogToken() {
  const now = Date.now();
  if (_cachedCatalogToken && now < _catalogTokenExpiry - 30_000) return _cachedCatalogToken;

  if (!config.ebay.clientId || !config.ebay.clientSecret) {
    logger.warn("[eBay] App credentials not configured — skipping catalog token fetch");
    return null;
  }

  const credentials = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString("base64");

  const body = new URLSearchParams({ grant_type: "client_credentials", scope: EBAY_SCOPES.BASE });

  // Catalog/Taxonomy calls are never sandboxed per-tenant today — production
  // app credentials against the production endpoint.
  const res = await fetch(tokenEndpointFor(false), {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    // Never log `credentials` (the Basic auth header) or clientSecret
    // itself — only the App ID (not sensitive the way Cert ID/secret is)
    // and whatever eBay's own response body says.
    let isInvalidClient = false;
    try {
      isInvalidClient = JSON.parse(text)?.error === "invalid_client";
    } catch {
      // Not JSON — fall through, treated as a generic failure below.
    }

    if (isInvalidClient) {
      logger.error(
        `[eBay] Catalog token fetch rejected (invalid_client) for App ID "${config.ebay.clientId}" — ` +
          "taxonomy/catalog calls require PRODUCTION eBay app keys (App ID + Cert ID) even when the " +
          "tenant itself is sandbox-connected. Check EBAY_CLIENT_ID/EBAY_CLIENT_SECRET are your app's " +
          "PRODUCTION keyset, not the Sandbox one.",
      );
      const err = new Error(
        "eBay rejected the configured app credentials (invalid_client). Catalog/taxonomy calls require " +
          "PRODUCTION eBay app keys (App ID + Cert ID), even for an otherwise sandbox-connected tenant.",
      );
      // Surfaces as a clear 502 (not a bare 500) via systemfailure()'s
      // generic err.status handling — see ebay.controller.js#getCategoryAspects.
      err.status = 502;
      err.code = "EBAY_APP_CREDENTIALS_REJECTED";
      throw err;
    }

    logger.error(`[eBay] Catalog token fetch failed: ${res.status} ${text}`);
    return null;
  }

  const data = await res.json();
  _cachedCatalogToken = data.access_token;
  _catalogTokenExpiry = now + (data.expires_in || 7200) * 1000;
  return _cachedCatalogToken;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MARKETPLACE_LANGUAGE = {
  EBAY_US: "en-US",
  EBAY_AU: "en-AU",
  EBAY_GB: "en-GB",
  EBAY_DE: "de-DE",
  EBAY_FR: "fr-FR",
};

function ebayHeaders(token, marketplaceId, extra = {}) {
  const contentLanguage = MARKETPLACE_LANGUAGE[marketplaceId] || "en-US";
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Language": contentLanguage,
    "Accept-Language": contentLanguage,
    "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    ...extra,
  };
}

async function upsertInventoryItem(token, settings, inventoryItem) {
  const { sku } = inventoryItem;

  const imageUrls = inventoryItem.product?.imageUrls || [];
  if (!imageUrls.length) {
    throw new Error(
      "No HTTPS image URLs found. Add images to the listing's Photos section and ensure UPLOADS_URL in .env is set to your public HTTPS URL (e.g. https://yourdomain.com/uploads).",
    );
  }

  const res = await fetch(
    `${inventoryBaseFor(settings.sandbox)}/inventory_item/${encodeURIComponent(sku)}`,
    {
      method: "PUT",
      headers: ebayHeaders(token, settings.marketplace_id),
      body: JSON.stringify(inventoryItem),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upsert inventory_item failed: ${res.status} ${text}`);
  }
  return { ok: true };
}

// ── Resolved-based builders (used by EbayAdapter / MarketplaceListing path) ──

function resolveImageUrls(photos, settings) {
  const uploadsUrl = config.uploads.url;
  const allUrls = (photos || [])
    .filter((a) => a && a.type === "image" && (a.url || a.file_name))
    .map((a) => {
      if (a.url && a.url.startsWith("http")) return a.url;
      const name = a.file_name;
      if (!name) return null;
      return `${uploadsUrl}/${name}`;
    })
    .filter(Boolean)
    .slice(0, 12);

  const httpsUrls = allUrls.filter((url) => url.startsWith("https://"));

  if (httpsUrls.length > 0) return httpsUrls;

  // In sandbox/dev, fall back to this tenant's fallback image so the sync
  // flow can be tested without a public HTTPS upload server. Production
  // requires real images.
  if (settings?.sandbox && settings?.fallback_image_url) {
    if (allUrls.length > 0) {
      logger.warn(
        `[eBay] resolveImageUrls: ${allUrls.length} image(s) found but none are HTTPS — ` +
        `using fallback image for sandbox. In production set UPLOADS_URL to your public HTTPS URL.`,
      );
    }
    return [settings.fallback_image_url];
  }

  if (allUrls.length > 0) {
    logger.warn(
      `[eBay] resolveImageUrls: ${allUrls.length} image(s) found but none are HTTPS. ` +
      `Set UPLOADS_URL to your public HTTPS URL (e.g. https://yourdomain.com/uploads).`,
    );
  }

  return [];
}

// Our UI stores "NEW" or "USED". "NEW" is valid as-is; "USED" is not an eBay
// enum — map it to USED_GOOD as the safe default. Any other stored value is
// assumed to already be a valid eBay condition enum (for future granularity).
// "USED" maps to USED_EXCELLENT (3000), not USED_GOOD (5000) — 4000/5000/
// 6000 are eBay's MEDIA condition grades (books, DVDs, games); most eBay
// Motors parts categories only accept 3000/6000/7000, so defaulting to a
// media-only grade was silently wrong for this app's whole domain (auto
// parts). See CONDITION_FALLBACK_ORDER in ebay.adapter.js for the matching
// fix to the per-category fallback search order.
//
// A falsy condition used to silently default to FOR_PARTS_OR_NOT_WORKING —
// listing a part as broken because a field was left blank is a bad failure
// mode nobody would notice until a buyer complained. Throws instead
// (naming the SKU when the caller has one), so it surfaces as a listing
// that needs attention. Every call site (ebay.adapter.js's
// resolveCategoryCondition, buildInventoryItemFromResolved below) is only
// ever reached from sync.service.js#syncListing's try/catch, which already
// classifies and records ANY thrown error as a per-item sync failure — this
// is not a new crash risk, just a more honest one than silently guessing
// "broken".
function normalizeCondition(condition, sku = null) {
  if (!condition) {
    const err = new Error(`Item condition is required${sku ? ` for SKU ${sku}` : ""} — set a condition before publishing to eBay`);
    // A missing condition is a per-item listing-data problem, never
    // evidence the eBay connection itself is broken — see
    // circuitBreaker.js#isTransportOrAuthFailure, which only counts
    // >=500/401/403 (or no status at all) toward the breaker. Set here
    // rather than at each call site so nothing that forgets to classify it
    // accidentally trips the breaker on a blank condition field.
    err.status = 400;
    throw err;
  }
  if (condition === "USED") return "USED_EXCELLENT";
  return condition;
}

// Builds Make/Model/Series/Year aspects strictly from the vehicle entered on
// the Product itself (Product Details > Vehicle section, captured once at
// product creation) — never from the listing's own Vehicle Fitment table.
//
// That table can legitimately hold several distinct compatible vehicles for
// the buyer-facing description/compatibility chart, but eBay's Make/Model/
// Series aspects are single-value (cardinality SINGLE) in motor-parts
// categories — sending more than one value is rejected with errorId 25002
// ("Model should contain only one value"). This used to paper over that by
// taking the fitment table's first row for Make/Model/Series and min/max-ing
// the year across every row, which silently substituted whatever the first
// row happened to be (and a blended year range spanning models it was never
// actually true for) in place of what the seller entered for this part —
// see bug report "Incorrect Vehicle Fitment Mapping to eBay Item Specifics".
function buildVehicleAspects(product) {
  const vehicle = product?.vehicle;
  if (!vehicle || (!vehicle.make && !vehicle.model)) return {};

  const aspects = {};
  if (vehicle.make) aspects["Make"] = [String(vehicle.make).trim()];
  if (vehicle.model) aspects["Model"] = [String(vehicle.model).trim()];
  if (vehicle.model_code) aspects["Series"] = [String(vehicle.model_code).trim()];
  if (vehicle.year_from != null) {
    const yearTo = vehicle.year_to != null ? vehicle.year_to : vehicle.year_from;
    aspects["Year"] = [yearTo !== vehicle.year_from ? `${vehicle.year_from}-${yearTo}` : String(vehicle.year_from)];
  }
  return aspects;
}

function buildInventoryItemFromResolved(resolved, quantity = 0, conditionOverride = null, settings = null) {
  const { sku, title, description, brand, photos, listing, product } = resolved;
  const imageUrls = resolveImageUrls(photos, settings);
  const condition = conditionOverride || normalizeCondition(listing.condition, sku);

  // Resolve brand/mpn once — used for both aspects and the product-level fields.
  // eBay validates Brand/MPN as a pair at the product level (error 25002 if one
  // is present without the other), so we default the missing side rather than
  // omitting one.
  const specs = listing.item_specifics || {};
  const resolvedBrand = (specs.brand || brand || "").trim();
  const resolvedMpn = (specs.mpn || "").trim();

  const hasBrand = !!resolvedBrand;
  const hasMpn = !!resolvedMpn;
  const productBrand = hasBrand ? resolvedBrand : hasMpn ? "Unbranded" : null;
  const productMpn = hasMpn ? resolvedMpn : hasBrand ? "Does Not Apply" : null;

  // Map stored item_specifics to eBay aspect format
  const aspects = {};
  if (productBrand) aspects["Brand"] = [productBrand];
  if (productMpn) aspects["Manufacturer Part Number"] = [productMpn];
  const rawSpn = specs.superseded_part_number;
  const spnArr = (Array.isArray(rawSpn) ? rawSpn : rawSpn != null ? [rawSpn] : [])
    .map((s) => (s == null ? "" : String(s).trim()))
    .filter((s) => s !== "" && s !== "null");
  // Same class of error as buildVehicleAspects above (errorId 25002):
  // "Superseded Part Number" is cardinality SINGLE in eBay's motor-parts
  // category schema, even though this app's own data model allows several
  // (a part can legitimately supersede/be superseded by more than one other
  // part number — see MarketplaceListing.js's superseded_part_number array).
  // Sending the whole array got every affected listing stuck in a
  // permanent sync Error ("Superseded Part Number should contain only one
  // value. Remove the extra values and try again."). Only the first entry
  // is sent to eBay; the rest still show on this app's own product page,
  // just not as an eBay item specific — no dynamic per-category cardinality
  // lookup here, matching how Brand/MPN/Authenticity/Warranty/Make/Model/
  // Series/Year are all already handled as single-value in this function.
  if (spnArr.length > 0) aspects["Superseded Part Number"] = [spnArr[0]];
  // Dedicated authenticity / warranty fields (override dynamic aspects of same name)
  if (specs.authenticity) aspects["Authenticity"] = [String(specs.authenticity)];
  if (specs.warranty) aspects["Warranty"] = [String(specs.warranty)];

  // Make/Model/Series/Year from the product's own vehicle field — see
  // buildVehicleAspects for why this deliberately ignores listing.fitment.
  const vehicleAspects = buildVehicleAspects(product);
  for (const [name, value] of Object.entries(vehicleAspects)) {
    if (!aspects[name]) aspects[name] = value;
  }

  // Dynamic aspects from Taxonomy API (stored as Map on listing document)
  const dynamicAspects = specs.aspects instanceof Map
    ? Object.fromEntries(specs.aspects)
    : (typeof specs.aspects === "object" && specs.aspects !== null ? specs.aspects : {});
  for (const [name, value] of Object.entries(dynamicAspects)) {
    if (value && !aspects[name]) aspects[name] = [String(value)];
  }

  // packageWeightAndSize — only included when at least one dimension/weight is set
  const pkg = listing.package || {};
  const hasAnyDimension = pkg.length || pkg.width || pkg.height;
  const hasWeight = pkg.weight != null && String(pkg.weight).trim() !== "";
  const packageWeightAndSize =
    hasAnyDimension || hasWeight
      ? {
          ...(hasAnyDimension
            ? {
                dimensions: {
                  ...(pkg.length ? { length: Number(pkg.length) } : {}),
                  ...(pkg.width ? { width: Number(pkg.width) } : {}),
                  ...(pkg.height ? { height: Number(pkg.height) } : {}),
                  unit: "CENTIMETER",
                },
              }
            : {}),
          ...(hasWeight
            ? { weight: { value: Number(pkg.weight), unit: "KILOGRAM" } }
            : {}),
        }
      : null;

  return {
    sku,
    // null quantity means "this merchant doesn't track stock for this
    // product" (Product.stock_control === false — see
    // ebay.adapter.js#resolveQuantity). Omitting the whole availability
    // block rather than sending a fabricated number keeps eBay's own
    // quantity as whatever the seller set directly there, instead of this
    // app overwriting it with a guess it has no real basis for.
    ...(quantity != null ? { availability: { shipToLocationAvailability: { quantity } } } : {}),
    condition,
    ...(packageWeightAndSize ? { packageWeightAndSize } : {}),
    product: {
      title,
      // Inventory API product.description is plain-text only, max 4000 chars.
      // The full HTML listing description lives in the offer's listingDescription.
      description: toPlainText(description || title) || title,
      imageUrls,
      // Brand and MPN must always be paired — eBay rejects one without the other (error 25002)
      ...(productBrand ? { brand: productBrand, mpn: productMpn } : {}),
      ...(Object.keys(aspects).length > 0 ? { aspects } : {}),
    },
  };
}

function buildOfferFromResolved(resolved, settings, quantity = 1) {
  const { sku, price, description, title, listing } = resolved;

  // Policy IDs: listing-level override ?? this tenant's EbaySettings default
  const fulfillmentPolicyId = listing.fulfillment_policy_id || settings.fulfillment_policy_id;
  const paymentPolicyId = listing.payment_policy_id || settings.payment_policy_id;
  const returnPolicyId = listing.return_policy_id || settings.return_policy_id;
  const merchantLocationKey = listing.merchant_location_key || settings.merchant_location_key;

  // Was hardcoded "AUD" regardless of this tenant's configured marketplace —
  // EbaySettings.marketplace_id has no enum restricting it to AU, so a
  // tenant on EBAY_US/EBAY_GB/etc. would publish offers in the wrong
  // currency, which eBay is likely to reject for that marketplace. Found live.
  const currency = currencyForMarketplace(settings.marketplace_id);

  // require_immediate_payment cannot be set per-offer in the eBay Inventory API —
  // it is governed by the payment policy (paymentPolicyId). To enforce it, enable
  // "Require immediate payment" on the eBay payment policy itself via Seller Hub.
  // listing.require_immediate_payment is intentionally not forwarded here.

  return {
    sku,
    marketplaceId: settings.marketplace_id,
    format: listing.format || "FIXED_PRICE",
    // See buildInventoryItemFromResolved's comment — null means "don't
    // touch eBay's quantity for this untracked-stock product."
    ...(quantity != null ? { availableQuantity: quantity } : {}),
    ...(listing.ebay_category_id ? { categoryId: listing.ebay_category_id } : {}),
    listingDescription: description || title,
    pricingSummary: {
      price: { value: String(price || 0), currency },
    },
    listingPolicies: {
      ...(fulfillmentPolicyId ? { fulfillmentPolicyId } : {}),
      ...(paymentPolicyId ? { paymentPolicyId } : {}),
      ...(returnPolicyId ? { returnPolicyId } : {}),
      ...(listing.accept_best_offer ? {
        bestOfferTerms: {
          bestOfferEnabled: true,
          ...(listing.min_best_offer != null ? {
            autoDeclinePrice: { value: String(listing.min_best_offer), currency },
          } : {}),
        },
      } : {}),
    },
    ...(merchantLocationKey ? { merchantLocationKey } : {}),
  };
}

async function createOffer(token, settings, offerBody) {
  const res = await fetch(`${inventoryBaseFor(settings.sandbox)}/offer`, {
    method: "POST",
    headers: ebayHeaders(token, settings.marketplace_id),
    body: JSON.stringify(offerBody),
  });

  if (!res.ok) await throwEbayApiError("createOffer", res);

  const data = await res.json();
  return data.offerId;
}

async function updateOffer(token, settings, offerId, offerBody) {
  const res = await fetch(
    `${inventoryBaseFor(settings.sandbox)}/offer/${encodeURIComponent(offerId)}`,
    {
      method: "PUT",
      headers: ebayHeaders(token, settings.marketplace_id),
      body: JSON.stringify(offerBody),
    },
  );

  if (!res.ok) await throwEbayApiError("updateOffer", res);
  return { ok: true };
}

// ── Step 3: Publish ───────────────────────────────────────────────────────────

async function publishOffer(token, settings, offerId) {
  const res = await fetch(
    `${inventoryBaseFor(settings.sandbox)}/offer/${encodeURIComponent(offerId)}/publish`,
    {
      method: "POST",
      headers: ebayHeaders(token, settings.marketplace_id),
      body: JSON.stringify({}),
    },
  );

  if (!res.ok) await throwEbayApiError("publishOffer", res);

  const data = await res.json();
  return data.listingId;
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteProduct(settings, sku, offerId = null) {
  if (!credentialsConfigured(settings)) {
    logger.warn("[eBay] deleteProduct skipped — credentials not configured");
    return { skipped: true };
  }

  const token = await getAccessToken(settings);
  if (!token) return { error: "Could not obtain access token" };

  try {
    // Step 1 — withdraw the offer first (eBay blocks inventory item deletion while an offer exists)
    if (offerId) {
      const offerRes = await fetch(
        `${inventoryBaseFor(settings.sandbox)}/offer/${encodeURIComponent(offerId)}`,
        { method: "DELETE", headers: ebayHeaders(token, settings.marketplace_id) },
      );
      if (!offerRes.ok && offerRes.status !== 404) {
        const text = await offerRes.text();
        logger.error(`[eBay] deleteProduct withdraw offer ${offerId} failed: ${offerRes.status} ${text}`);
        return { error: `withdraw offer failed: ${offerRes.status}: ${text}` };
      }
      logger.info(`[eBay] offer withdrawn: ${offerId}`);
    }

    // Step 2 — delete the inventory item
    const res = await fetch(
      `${inventoryBaseFor(settings.sandbox)}/inventory_item/${encodeURIComponent(sku)}`,
      { method: "DELETE", headers: ebayHeaders(token, settings.marketplace_id) },
    );

    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      logger.error(`[eBay] deleteProduct ${sku} failed: ${res.status} ${text}`);
      return { error: `${res.status}: ${text}` };
    }

    logger.info(`[eBay] inventory_item deleted: ${sku}`);
    return { ok: true };
  } catch (err) {
    logger.error(`[eBay] deleteProduct error: ${err.message}`);
    return { error: err.message };
  }
}

// ── Merchant Location ─────────────────────────────────────────────────────────

// Lists this tenant's existing merchant locations on eBay — used right after
// OAuth connect to auto-fill merchant_location_key from a location the seller
// already set up (e.g. via eBay's own seller hub), instead of requiring them
// to type the key in manually.
async function getInventoryLocations(token, settings) {
  const res = await fetch(
    `${inventoryBaseFor(settings.sandbox)}/location?limit=100`,
    { headers: ebayHeaders(token, settings.marketplace_id) },
  );

  if (!res.ok) await throwEbayApiError("getInventoryLocations", res);

  const body = await res.json();
  return body.locations || [];
}

async function ensureLocation(token, settings) {
  const key = settings.merchant_location_key;
  if (!key) throw new Error("This tenant has no merchant_location_key set — configure it in eBay settings first");

  const checkRes = await fetch(
    `${inventoryBaseFor(settings.sandbox)}/location/${encodeURIComponent(key)}`,
    { headers: ebayHeaders(token, settings.marketplace_id) },
  );

  if (checkRes.ok) {
    logger.debug(`[eBay] merchant location "${key}" already exists`);
    return;
  }

  if (checkRes.status !== 404) {
    const text = await checkRes.text();
    throw new Error(`GET location/${key} failed: ${checkRes.status} ${text}`);
  }

  // Location doesn't exist — build from this tenant's warehouse address
  const missing = [];
  if (!settings.warehouse_street) missing.push("warehouse_street");
  if (!settings.warehouse_city) missing.push("warehouse_city");
  if (!settings.warehouse_state) missing.push("warehouse_state");
  if (!settings.warehouse_postcode) missing.push("warehouse_postcode");

  if (missing.length) {
    throw new Error(
      `Merchant location "${key}" does not exist on eBay and cannot be auto-created. ` +
      `Set these fields in this tenant's eBay settings: ${missing.join(", ")}`,
    );
  }

  const body = {
    location: {
      address: {
        addressLine1: settings.warehouse_street,
        city: settings.warehouse_city,
        stateOrProvince: settings.warehouse_state,
        postalCode: settings.warehouse_postcode,
        country: settings.warehouse_country,
      },
    },
    locationTypes: ["WAREHOUSE"],
    name: key,
    merchantLocationStatus: "ENABLED",
    ...(settings.warehouse_phone ? { phone: settings.warehouse_phone } : {}),
  };

  const createRes = await fetch(
    `${inventoryBaseFor(settings.sandbox)}/location/${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: ebayHeaders(token, settings.marketplace_id),
      body: JSON.stringify(body),
    },
  );

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Create merchant location "${key}" failed: ${createRes.status} ${text}`);
  }

  logger.info(`[eBay] merchant location created: "${key}" (${settings.warehouse_city}, ${settings.warehouse_state})`);
}

// ── Fulfillment / Orders ──────────────────────────────────────────────────────

async function getOrders(settings, { limit = 50, offset = 0 } = {}) {
  const token = await getAccessToken(settings);
  if (!token) throw new Error("[eBay] getOrders: could not obtain access token");

  const url = `${fulfillmentBaseFor(settings.sandbox)}/order?filter=orderfulfillmentstatus%3A%7BNOT_STARTED%7CIN_PROGRESS%7D&limit=${limit}&offset=${offset}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": settings.marketplace_id,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    // Thrown (not swallowed) so an auth/scope failure surfaces as a failed
    // Bull job instead of silently looking like "no new orders".
    throw new Error(`[eBay] getOrders failed: ${res.status} ${text}`);
  }

  return res.json();
}

// getOrders only fetches one page (default limit=50) — a tenant with more
// than 50 open (NOT_STARTED/IN_PROGRESS) orders (extended outage, high
// volume) silently only had the first page processed per poll, and the
// overflow was never guaranteed to surface on a later poll if the backlog
// stayed above 50. This walks every page using eBay's own `total`, capped at
// MAX_PAGES as a defensive bound against an unexpected/misbehaving response
// looping forever (same concern as getAllInventoryItems's pagination below).
const MAX_ORDER_PAGES = 100; // 100 * 200 = 20,000 open orders — generous ceiling
async function getAllOpenOrders(settings, { pageSize = 200 } = {}) {
  const orders = [];
  let offset = 0;

  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    const data = await getOrders(settings, { limit: pageSize, offset });
    const batch = data.orders || [];
    orders.push(...batch);

    const total = typeof data.total === "number" ? data.total : orders.length;
    offset += pageSize;
    if (orders.length >= total || batch.length < pageSize) break;
  }

  return orders;
}

// Bulk-fetches every inventory item on the account (paginated) so the
// inventory-sync poller can diff eBay's live quantities against ours in a
// handful of calls instead of one GET per SKU.
// MAX_INVENTORY_PAGES bounds what was previously a `while (true)` loop whose
// only exit condition was a batch smaller than pageSize — if eBay ever
// returned a full page regardless of the requested offset (an API bug, or
// an account with a genuinely unexpected number of items), this looped
// forever, growing `items` unboundedly and blocking that tenant's inventory
// job indefinitely. Now fails loudly instead.
const MAX_INVENTORY_PAGES = 500; // 500 * 100 = 50,000 items — generous ceiling
// Returns { items, complete }. `complete: false` means the fetch stopped
// before covering the whole account (a short/empty page came back while
// eBay's own reported `total` says more items exist) — a transient API
// hiccup, not proof those SKUs are actually gone. Callers that use a
// missing-from-eBay result to decide "delete this listing" (see
// ebay.inventory-sync.service.js#handleMissingFromEbay) must skip that
// decision entirely for the cycle when complete is false, or a flaky page
// read could wrongly delete a listing that's still live. Found live: the
// stock-corruption incident this whole file's fencing/reconciliation logic
// exists to prevent was a version of exactly this kind of "trust one
// possibly-incomplete read" mistake.
async function getAllInventoryItems(settings, { pageSize = 100 } = {}) {
  const token = await getAccessToken(settings);
  if (!token) throw new Error("[eBay] getAllInventoryItems: could not obtain access token");

  const items = [];
  let offset = 0;
  let reportedTotal = null;

  for (let page = 0; page < MAX_INVENTORY_PAGES; page++) {
    const res = await fetch(
      `${inventoryBaseFor(settings.sandbox)}/inventory_item?limit=${pageSize}&offset=${offset}`,
      { headers: ebayHeaders(token, settings.marketplace_id) },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[eBay] getAllInventoryItems failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    const batch = data.inventoryItems || [];
    if (typeof data.total === "number") reportedTotal = data.total;
    items.push(...batch);

    if (batch.length < pageSize) {
      const complete = reportedTotal == null || items.length >= reportedTotal;
      return { items, complete };
    }
    offset += pageSize;
  }

  throw new Error(
    `[eBay] getAllInventoryItems: exceeded ${MAX_INVENTORY_PAGES} pages (${MAX_INVENTORY_PAGES * pageSize} items) — aborting, offset pagination may not be terminating`,
  );
}

// ── Taxonomy ──────────────────────────────────────────────────────────────────
// Not tenant-scoped — client_credentials app token, same category tree
// regardless of which tenant is asking (categories are eBay-marketplace-wide,
// not seller-specific). marketplaceId still matters (different sites have
// different trees), so it's passed explicitly rather than pulled from a
// per-tenant settings object.

async function getDefaultCategoryTreeId(marketplaceId = "EBAY_AU") {
  if (_cachedCategoryTreeId) return _cachedCategoryTreeId;

  const token = await getCatalogToken();
  const res = await fetch(
    `${taxonomyBaseUrlFor(false)}/get_default_category_tree_id?marketplace_id=${marketplaceId}`,
    { headers: ebayHeaders(token, marketplaceId) },
  );
  if (!res.ok) {
    const text = await res.text();
    logger.error(`[eBay] getDefaultCategoryTreeId failed: ${res.status} ${text}`);
    throw new Error(`Failed to resolve eBay category tree: ${res.status}`);
  }
  const data = await res.json();
  _cachedCategoryTreeId = data.categoryTreeId;
  logger.debug(`[eBay] Category tree ID for ${marketplaceId}: ${_cachedCategoryTreeId}`);
  return _cachedCategoryTreeId;
}

async function getItemAspectsForCategory(categoryId, marketplaceId = "EBAY_AU") {
  const token = await getCatalogToken();
  const treeId = await getDefaultCategoryTreeId(marketplaceId);
  const res = await fetch(
    `${taxonomyBaseUrlFor(false)}/category_tree/${treeId}/get_item_aspects_for_category?category_id=${categoryId}`,
    { headers: ebayHeaders(token, marketplaceId) },
  );
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400) {
      logger.warn(`[eBay] getItemAspectsForCategory(${categoryId}) bad category ID: ${text}`);
      return [];
    }
    logger.error(`[eBay] getItemAspectsForCategory(${categoryId}) failed: ${res.status} ${text}`);
    throw new Error(`Failed to fetch category aspects: ${res.status}`);
  }
  const data = await res.json();
  const aspects = (data.aspects || []).map((a) => ({
    name: a.localizedAspectName,
    required: a.aspectConstraint?.aspectRequired === true,
    mode: a.aspectConstraint?.aspectMode || "FREE_TEXT",
    cardinality: a.aspectConstraint?.itemToAspectCardinality || "SINGLE",
    values: (a.aspectValues || []).map((v) => v.localizedValue),
  }));
  logger.info(`[eBay] Fetched ${aspects.length} aspects for category ${categoryId}`);
  return aspects;
}

module.exports = {
  EbayApiError,
  credentialsConfigured,
  getAccessToken,
  getAppToken,
  getCatalogToken,
  tokenEndpointFor,
  clearTokenCache,
  getOrders,
  getAllOpenOrders,
  getAllInventoryItems,
  ebayHeaders,
  apiBaseUrlFor,
  inventoryBaseFor,
  buildInventoryItemFromResolved,
  normalizeCondition,
  upsertInventoryItem,
  buildOfferFromResolved,
  createOffer,
  updateOffer,
  publishOffer,
  deleteProduct,
  getInventoryLocations,
  ensureLocation,
  getDefaultCategoryTreeId,
  getItemAspectsForCategory,
};
