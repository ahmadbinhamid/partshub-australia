// services/marketplace/channel.service.storefront.test.js
//
// TASK 5 (requiresStorefront capability): a tenant with no verified default
// Domain must see Google Shopping marked unavailable (with a clear reason)
// in GET /api/v1/channels, and checkStorefrontRequirement — the same
// generic, manifest-driven check — must refuse the same tenant a connect
// attempt. eBay (no requiresStorefront) must be completely unaffected.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/marketplace/channel.service.storefront.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../config");

require("../../models/index");
const Domain = require("../../models/Domain");
const registry = require("./registry");
const googleAdapter = require("./adapters/google.adapter");
registry.register(googleAdapter);
registry.register({ key: "ebay", manifest: { key: "ebay", name: "eBay" }, capabilities: {}, publish: async () => {}, update: async () => {}, end: async () => {} });

const { listChannelsForTenant, checkStorefrontRequirement } = require("./channel.service");

test("google.adapter.js manifest: requiresStorefront is true", () => {
  assert.equal(googleAdapter.manifest.requiresStorefront, true);
});

test("checkStorefrontRequirement: a platform with no requiresStorefront flag is always ok, regardless of Domain state", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  const result = await checkStorefrontRequirement(tenantId, "ebay");
  assert.deepEqual(result, { ok: true });
});

test("checkStorefrontRequirement: google, tenant with NO verified default Domain -> not ok, with a human-readable reason", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  const result = await checkStorefrontRequirement(tenantId, "google");
  assert.equal(result.ok, false);
  assert.match(result.reason, /verified storefront domain/);
  assert.match(result.reason, /Google Shopping/);
});

test("checkStorefrontRequirement: google, tenant WITH a verified default Domain -> ok", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  await Domain.create({
    tenant_id: tenantId,
    hostname: `store-${crypto.randomUUID()}.example.com`,
    status: "active",
    is_default: true,
    verification_token: crypto.randomUUID(),
  });

  const result = await checkStorefrontRequirement(tenantId, "google");
  assert.deepEqual(result, { ok: true });
});

test("checkStorefrontRequirement: google, tenant with a Domain that is verified but NOT default -> still not ok", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  await Domain.create({
    tenant_id: tenantId,
    hostname: `store-${crypto.randomUUID()}.example.com`,
    status: "active",
    is_default: false,
    verification_token: crypto.randomUUID(),
  });

  const result = await checkStorefrontRequirement(tenantId, "google");
  assert.equal(result.ok, false);
});

test("listChannelsForTenant: marks google unavailable with a reason for a tenant with no verified Domain, and leaves ebay unaffected", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  const channels = await listChannelsForTenant(tenantId);
  const google = channels.find((c) => c.key === "google");
  const ebay = channels.find((c) => c.key === "ebay");

  assert.equal(google.available, false);
  assert.match(google.unavailable_reason, /verified storefront domain/);

  assert.equal(ebay.available, true);
  assert.equal(ebay.unavailable_reason, null);
});

test("listChannelsForTenant: google becomes available once the tenant has a verified default Domain", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  await Domain.create({
    tenant_id: tenantId,
    hostname: `store-${crypto.randomUUID()}.example.com`,
    status: "active",
    is_default: true,
    verification_token: crypto.randomUUID(),
  });

  const channels = await listChannelsForTenant(tenantId);
  const google = channels.find((c) => c.key === "google");
  assert.equal(google.available, true);
  assert.equal(google.unavailable_reason, null);
});
