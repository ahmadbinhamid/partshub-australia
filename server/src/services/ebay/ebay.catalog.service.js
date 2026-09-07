// services/ebay/ebay.catalog.service.js
// eBay Taxonomy (category suggestions) and Sell Metadata (condition policies)
//
// Category tree/suggestions use the app-level catalog token (client_credentials
// — no seller consent involved, so not tenant-scoped); condition policies use
// the seller's own access token and so need that tenant's settings.

const { getAccessToken, getCatalogToken, ebayHeaders, apiBaseUrlFor } = require("./ebay.api.service");
const { logger } = require("../../loaders/logging");

const TAXONOMY_BASE = `${apiBaseUrlFor(false)}/commerce/taxonomy/v1`;

// Unlike TAXONOMY_BASE above (paired with getCatalogToken()'s app-level
// client_credentials token, which is ALSO always production — see that
// function's own comment), condition policies are fetched with the
// TENANT's own seller access token, which IS environment-specific — a
// sandbox-connected tenant has a sandbox token. Hardcoding this to
// production the same way TAXONOMY_BASE is would send a sandbox token to
// eBay's production Metadata API, which eBay rejects outright — the
// lookup fails, resolveCategoryCondition (ebay.adapter.js) silently falls
// back to the raw, unvalidated condition, and eBay only ever catches the
// resulting invalid condition much later at publishOffer (errorId 25021).
// Computed per-call (not a module constant) so it can follow each tenant's
// own sandbox flag.
function metadataBaseFor(sandbox) {
  return `${apiBaseUrlFor(sandbox)}/sell/metadata/v1`;
}

// ── In-memory caches ──────────────────────────────────────────────────────────

let _treeId = null;

const _conditionCache = new Map();
const CONDITION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Category tree ID (cached indefinitely — eBay tree IDs are very stable) ────

async function getCategoryTreeId(token, marketplaceId) {
  if (_treeId) return _treeId;

  const res = await fetch(
    `${TAXONOMY_BASE}/get_default_category_tree_id?marketplace_id=${marketplaceId}`,
    { headers: ebayHeaders(token, marketplaceId) },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getDefaultCategoryTreeId failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  _treeId = data.categoryTreeId;
  logger.info(`[eBay catalog] cached category tree id: ${_treeId}`);
  return _treeId;
}

// ── Category suggestions ──────────────────────────────────────────────────────
// Sandbox caveat: eBay's getCategorySuggestions endpoint is not functional in
// sandbox — it returns boilerplate rather than real suggestions. When this
// tenant's sandbox flag is true we return a { sandbox: true } sentinel so the
// frontend can fall back to the manual ID input without showing fake data.

async function getCategorySuggestions(q, settings) {
  if (settings?.sandbox) {
    return { sandbox: true, suggestions: [] };
  }

  const marketplaceId = settings?.marketplace_id || "EBAY_AU";
  const token = await getCatalogToken();
  if (!token) throw new Error("Could not obtain eBay catalog token");

  const treeId = await getCategoryTreeId(token, marketplaceId);
  const url = `${TAXONOMY_BASE}/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(q)}`;

  const res = await fetch(url, { headers: ebayHeaders(token, marketplaceId) });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getCategorySuggestions failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  const suggestions = (data.categorySuggestions || []).map((s) => {
    // Ancestors arrive in arbitrary order — sort ascending by tree level
    const ancestors = (s.categoryTreeNodeAncestors || [])
      .slice()
      .sort((a, b) => a.categoryTreeNodeLevel - b.categoryTreeNodeLevel);
    const breadcrumb = [
      ...ancestors.map((a) => a.categoryName),
      s.category.categoryName,
    ].join(" › ");
    return {
      categoryId: s.category.categoryId,
      categoryName: s.category.categoryName,
      breadcrumb,
    };
  });

  return { sandbox: false, suggestions };
}

// ── Condition ID → ConditionEnum mapping ─────────────────────────────────────
// The Sell Metadata API returns numeric conditionIds (e.g. 1000, 7000) but
// the Sell Inventory API's inventory_item endpoint expects the string enum
// (e.g. "NEW", "FOR_PARTS_OR_NOT_WORKING"). We remap at this layer so the
// stored ebay_condition value is always the enum string the Inventory API needs.

const CONDITION_ID_TO_ENUM = {
  1000: "NEW",
  1500: "NEW_OTHER",
  1750: "NEW_WITH_DEFECTS",
  2000: "CERTIFIED_REFURBISHED",
  2010: "EXCELLENT_REFURBISHED",
  2020: "VERY_GOOD_REFURBISHED",
  2030: "GOOD_REFURBISHED",
  2500: "SELLER_REFURBISHED",
  2750: "LIKE_NEW",
  3000: "USED_EXCELLENT",
  4000: "USED_VERY_GOOD",
  5000: "USED_GOOD",
  6000: "USED_ACCEPTABLE",
  7000: "FOR_PARTS_OR_NOT_WORKING",
};

// ── Condition policies ────────────────────────────────────────────────────────
// Uses the Sell Metadata API filtered to a single categoryId so we never
// download the full tree. Standard conditions are available with the seller
// access token; refurbished conditions (SELLER_REFURBISHED, etc.) would
// additionally require the sell.inventory scope to be reflected.

async function getConditionPolicies(categoryId, settings) {
  // Cache key must be unique per (tenant, environment, marketplace) — a
  // sandbox tenant's condition policies must never be served to a
  // production tenant, or vice versa (they can genuinely differ — see
  // metadataBaseFor's own comment above). tenant_id is present on every
  // REAL connected tenant's settings object (see
  // ebay.settings.service.js#toLegacyShape, which always sets it from the
  // ChannelConnection/EbaySettings doc it read), but a tenant with no
  // connection at all — never went through OAuth, no legacy EbaySettings
  // row either — resolves to `{}`, so tenant_id is undefined. Rather than
  // let every such caller collapse onto one shared, unscoped cache key
  // (`undefined:...`), skip caching entirely for that case; there's nothing
  // useful to cache against anyway (getAccessToken below will fail for it).
  const canCache = settings?.tenant_id != null;
  const cacheKey = canCache
    ? `${settings.tenant_id}:${!!settings.sandbox}:${settings.marketplace_id}:${categoryId}`
    : null;

  if (canCache) {
    const cached = _conditionCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) return cached.data;
  }

  const token = await getAccessToken(settings);
  if (!token) throw new Error("Could not obtain eBay access token");

  const marketplaceId = settings.marketplace_id;
  // filter=categoryIds:{id} selects exactly this one category
  const filter = `categoryIds:{${categoryId}}`;
  const url = `${metadataBaseFor(settings.sandbox)}/marketplace/${marketplaceId}/get_item_condition_policies?filter=${encodeURIComponent(filter)}`;

  const res = await fetch(url, { headers: ebayHeaders(token, marketplaceId) });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getItemConditionPolicies failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const policies = data.itemConditionPolicies || [];
  const policy = policies.find((p) => p.categoryId === categoryId) || policies[0];

  const result = policy
    ? {
        conditionRequired: !!policy.conditionRequired,
        conditions: (policy.itemConditions || []).map((c) => ({
          // conditionId here is the ConditionEnum string the Inventory API accepts,
          // not the raw numeric id — callers store this directly as ebay_condition.
          conditionId: CONDITION_ID_TO_ENUM[Number(c.conditionId)] || String(c.conditionId),
          conditionDescription: c.conditionDescription,
        })),
      }
    : { conditionRequired: false, conditions: [] };

  if (canCache) {
    _conditionCache.set(cacheKey, { data: result, expiry: Date.now() + CONDITION_TTL_MS });
  }
  return result;
}

module.exports = { getCategorySuggestions, getConditionPolicies };
