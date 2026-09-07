// services/google/google.merchant.api.circuitbreaker.test.js
//
// Task 6: "a 503 from the Merchant API increments the circuit breaker; a
// 400 item validation error does not." Exercised through the REAL
// end-to-end path (sync.service.js#syncListing -> google.adapter.js ->
// google.merchant.api.service.js), not just the classifier function in
// isolation, so this proves the actual ChannelConnection.consecutive_failures
// counter behaves correctly, not just that the error carries the right
// `.status`.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/google/google.merchant.api.circuitbreaker.test.js

const test = require("node:test");
const { mock, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../config");

require("../../models/index");
const Product = require("../../models/Product");
const Attachment = require("../../models/Attachment");
const Location = require("../../models/Location");
const Inventory = require("../../models/Inventory");
const Domain = require("../../models/Domain");
const MarketplaceListing = require("../../models/MarketplaceListing");
const ChannelConnection = require("../../models/ChannelConnection");
const { encrypt, packCiphertext } = require("../../utils/crypto/tokenCipher");
const { DOMAIN_STATUS } = require("../../constants/domain.constants");
const registry = require("../marketplace/registry");
const googleAdapter = require("../marketplace/adapters/google.adapter");
registry.register(googleAdapter);
const marketplaceSync = require("../marketplace/sync.service");

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// TASK 1 (a later run): this fixture's product needs a real photo now that
// a zero-photo product is itself a (400, non-breaker) rejection — without
// one, both tests below would fail before ever reaching the simulated
// 503/400 Merchant API response they exist to test. Attachment.url is a
// virtual built from config.uploads.url; overridden to a fake https host
// for the life of this file (restored after) since this env's real
// UPLOADS_URL is plain http://. Same fix as
// google.adapter.batch.test.js's own makeTenantWithListings.
let originalUploadsUrl;
before(() => {
  originalUploadsUrl = config.uploads.url;
  config.uploads.url = "https://cdn.example.com";
});
after(() => {
  config.uploads.url = originalUploadsUrl;
});

async function makeFixture() {
  const suffix = crypto.randomUUID();
  const tenantId = new mongoose.Types.ObjectId();

  await Domain.create({
    tenant_id: tenantId,
    hostname: `cb-${suffix}.example.com`,
    status: DOMAIN_STATUS.ACTIVE,
    is_default: true,
    verification_token: crypto.randomUUID(),
  });

  const attachment = await Attachment.create({
    tenant_id: tenantId,
    uid: `cb-photo-${suffix}`,
    file_name: `cb-photo-${suffix}.jpg`,
    type: "image",
  });

  const product = await Product.create({
    tenant_id: tenantId,
    title: `CB test ${suffix}`,
    slug: `cb-test-${suffix}`,
    sku: `CB-${suffix}`,
    status: "active",
    stock_control: true,
    attachments: [attachment._id],
  });
  const location = await Location.create({ tenant_id: tenantId, name: `Loc ${suffix}` });
  await Inventory.create({ product: product._id, variant: null, location: location._id, stock_count: 2 });

  const listing = await MarketplaceListing.create({
    tenant_id: tenantId,
    product: product._id,
    variant: null,
    platform: "google",
    state: "active",
    feed_label: "AU",
    content_language: "en",
  });

  const encAccess = encrypt("fake-access-token");
  const encRefresh = encrypt("fake-refresh-token");
  await ChannelConnection.collection.insertOne({
    tenant_id: tenantId,
    platform: "google",
    status: "connected",
    access_token_ct: packCiphertext(encAccess),
    refresh_token_ct: packCiphertext(encRefresh),
    token_expires_at: new Date(Date.now() + 3600_000),
    merchant_id: "merchant123",
    data_source_id: "ds1",
    feed_label: "AU",
    content_language: "en",
    target_country: "AU",
    consecutive_failures: 0,
    created_at: new Date(),
    updated_at: new Date(),
  });

  return { tenantId, listing };
}

test("a 503 from the Merchant API increments consecutive_failures on ChannelConnection", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  mock.method(global, "fetch", async () => jsonResponse(503, { error: { message: "backend unavailable" } }));

  const { tenantId, listing } = await makeFixture();

  await assert.rejects(() => marketplaceSync.syncListing(listing._id.toString(), null));

  const conn = await ChannelConnection.findOne({ tenant_id: tenantId }).lean();
  assert.equal(conn.consecutive_failures, 1);
});

test("a 400 item-validation error from the Merchant API does NOT increment consecutive_failures", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  mock.method(global, "fetch", async () => jsonResponse(400, { error: { message: "invalid googleProductCategory" } }));

  const { tenantId, listing } = await makeFixture();

  await assert.rejects(() => marketplaceSync.syncListing(listing._id.toString(), null));

  const conn = await ChannelConnection.findOne({ tenant_id: tenantId }).lean();
  assert.equal(conn.consecutive_failures, 0, "a 400-level item validation error must never trip the breaker");
});
