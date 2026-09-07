// services/google/google.merchant.api.service.js
//
// Pure Merchant API HTTP layer — no DB access, no orchestration. Mirrors
// ebay.api.service.js's shape: every function takes an already-valid access
// token plus a per-tenant `settings` object, never caches a token or any
// tenant-scoped state at module level.

const { logger } = require("../../loaders/logging");

// v1beta was discontinued by Google on 2026-02-28 — see
// google.datasource.service.js's own comment on the same migration.
const MERCHANT_API_BASE = "https://merchantapi.googleapis.com/products/v1";

// NOTE on base URLs and the eBay environment-invariants precedent: this
// module's base URL constants are NOT the same class of bug
// ebay.environment-invariants.test.js guards against (a tenant-scoped
// TOKEN paired with a base URL hardcoded to the WRONG of two environments).
// Google's Merchant API has no sandbox/production URL split the way eBay
// does — a Merchant Center "test account" changes which merchant_id you
// push to, not the API host — so there is no second environment's base URL
// this could be wrong against. What IS tenant-scoped (the access token) is
// always threaded through as a per-call argument below, never cached or
// hardcoded at module level.

function headersFor(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// Attaches `.status` (the HTTP status code) to the thrown error so
// circuitBreaker.js's isTransportOrAuthFailure can classify it — 5xx/401/403
// count toward the breaker, a 400-level item validation error does not. See
// that file's own comment for the exact rule this follows.
async function throwForResponse(res, action) {
  const text = await res.text();
  logger.error(`[google.merchant] ${action} failed`, { status: res.status, body: text });
  const err = new Error(`Google Merchant API ${action} failed: ${res.status} ${text}`);
  err.status = res.status;
  throw err;
}

// productInputs.insert — creates or fully replaces a product input under
// the tenant's data source (both create and update go through this same
// call; Merchant API has no separate "update" verb for product inputs —
// mirrors how eBay's own upsertInventoryItem is a single upsert call too).
// `productInput` is the full ProductInput resource body — see
// google.adapter.js#buildProductInputFromResolved.
async function insertProductInput(token, settings, productInput) {
  const { merchant_id, data_source_id } = settings;
  const dataSourceName = `accounts/${merchant_id}/dataSources/${data_source_id}`;
  const url =
    `${MERCHANT_API_BASE}/accounts/${merchant_id}/productInputs:insert` +
    `?dataSource=${encodeURIComponent(dataSourceName)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: headersFor(token),
    body: JSON.stringify(productInput),
  });

  if (!res.ok) await throwForResponse(res, "productInputs.insert");
  return res.json();
}

// productInputs.delete — addressed by the product input's full resource
// name (channel~contentLanguage~feedLabel~offerId under
// accounts/{merchant}/productInputs/{name} — see google.adapter.js for how
// that name is built and stored as external_listing_id). A 404 (already
// gone on Google's side) is treated the same as success — end() is
// idempotent, same convention as ebay.adapter.js#end tolerating an
// already-missing offer.
async function deleteProductInput(token, settings, productResourceName) {
  const { merchant_id, data_source_id } = settings;
  const dataSourceName = `accounts/${merchant_id}/dataSources/${data_source_id}`;
  const url =
    `${MERCHANT_API_BASE}/${productResourceName}` +
    `?dataSource=${encodeURIComponent(dataSourceName)}`;

  const res = await fetch(url, { method: "DELETE", headers: headersFor(token) });
  if (!res.ok && res.status !== 404) await throwForResponse(res, "productInputs.delete");
}

// NOTE: the Merchant API (merchantapi.googleapis.com) does not expose a
// documented multi-item batch endpoint for productInputs the way the older
// Content API's products.custombatch did. Rather than guess at an endpoint
// shape that may not exist and risk silently failing against the real API,
// google.adapter.js#publishBatch calls insertProductInput once per item
// (with bounded concurrency), while still tracking every item's success/
// failure individually and processing a whole chunk as ONE queue job — see
// that function's own comment. If the Merchant API grows a real batch
// endpoint later, this is the one place to change.
module.exports = { insertProductInput, deleteProductInput };
