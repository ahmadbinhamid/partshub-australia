// services/marketplace/adapters/google.adapter.contract.test.js
//
// Verifies the Google adapter conforms to registry.js's documented contract
// (key, manifest, capabilities, loadSettings/publish/update/end/publishBatch),
// and exercises the pure, no-I/O building blocks directly (identifier
// branching, availability mapping, resource-name shape) without touching
// Mongo, Redis, or the network.
//
// Run with: node --test src/services/marketplace/adapters/google.adapter.contract.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const googleAdapter = require("./google.adapter");

test("google adapter: exports the full registry contract with correct types", () => {
  assert.equal(googleAdapter.key, "google");

  assert.equal(typeof googleAdapter.manifest, "object");
  for (const field of ["key", "name", "logo", "description", "status", "authType", "setupSteps", "requiredTenantData"]) {
    assert.ok(field in googleAdapter.manifest, `manifest.${field} must be present`);
  }
  assert.equal(googleAdapter.manifest.key, "google");

  assert.deepEqual(googleAdapter.capabilities, {
    publish: true,
    inventory: true,
    batch: true,
    orders: false,
    webhooks: false,
    inboundInventory: false,
    variants: true,
  });

  for (const fn of ["loadSettings", "publish", "update", "end", "publishBatch"]) {
    assert.equal(typeof googleAdapter[fn], "function", `${fn} must be a function`);
  }
});

test("applyIdentifiers: gtin present -> gtins (array) only", () => {
  const attrs = {};
  googleAdapter.applyIdentifiers(attrs, { gtin: "012345678905", mpn: "MPN1", brand: "Acme" }, "SKU1");
  assert.deepEqual(attrs.gtins, ["012345678905"]);
  assert.equal(attrs.mpn, undefined);
  assert.equal(attrs.identifierExists, undefined);
});

test("applyIdentifiers: no gtin, but mpn+brand present -> both mpn and brand", () => {
  const attrs = {};
  googleAdapter.applyIdentifiers(attrs, { gtin: null, mpn: "MPN1", brand: "Acme" }, "SKU1");
  assert.equal(attrs.gtins, undefined);
  assert.equal(attrs.mpn, "MPN1");
  assert.equal(attrs.brand, "Acme");
  assert.equal(attrs.identifierExists, undefined);
});

test("applyIdentifiers: mpn without brand (incomplete pair) -> identifierExists false, mpn NOT sent alone", () => {
  const attrs = {};
  googleAdapter.applyIdentifiers(attrs, { gtin: null, mpn: "MPN1", brand: null }, "SKU1");
  assert.equal(attrs.mpn, undefined);
  assert.equal(attrs.brand, undefined);
  assert.equal(attrs.identifierExists, false);
});

test("applyIdentifiers: neither gtin nor a complete mpn+brand pair -> identifierExists false", () => {
  const attrs = {};
  googleAdapter.applyIdentifiers(attrs, { gtin: null, mpn: null, brand: null }, "SKU1");
  assert.equal(attrs.identifierExists, false);
  assert.equal(attrs.gtins, undefined);
  assert.equal(attrs.mpn, undefined);
});

test("availabilityFor: quantity 0 -> OUT_OF_STOCK; quantity > 0 -> IN_STOCK (v1 enum, not the old lowercase Content API strings)", () => {
  assert.equal(googleAdapter.availabilityFor(0), "OUT_OF_STOCK");
  assert.equal(googleAdapter.availabilityFor(1), "IN_STOCK");
  assert.equal(googleAdapter.availabilityFor(500), "IN_STOCK");
});

test("buildProductResourceName / buildFullProductResourceName: contentLanguage~feedLabel~offerId shape (v1 — no channel segment)", () => {
  const settings = { merchant_id: "123", feed_label: "AU", content_language: "en" };
  assert.equal(googleAdapter.buildProductResourceName(settings, "SKU-1"), "en~AU~SKU-1");
  assert.equal(
    googleAdapter.buildFullProductResourceName(settings, "SKU-1"),
    "accounts/123/products/en~AU~SKU-1",
  );
});
