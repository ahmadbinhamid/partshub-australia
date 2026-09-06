// services/marketplace/adapters/google.adapter.publish.test.js
//
// Exercises publish()/loadSettings() end to end against real fixtures
// (Mongo — this is unavoidable here: resolveProductUrl needs a real Domain
// query, resolveQuantity needs real Inventory records, and the whole point
// of several of these tests is proving the adapter reads real stored data
// correctly), with `fetch` stubbed so no real network call is ever made.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/marketplace/adapters/google.adapter.publish.test.js

const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../../config");

require("../../../models/index");
const Product = require("../../../models/Product");
const Location = require("../../../models/Location");
const Inventory = require("../../../models/Inventory");
const Domain = require("../../../models/Domain");
const MarketplaceListing = require("../../../models/MarketplaceListing");
const ChannelConnection = require("../../../models/ChannelConnection");
const ChannelSyncLog = require("../../../models/ChannelSyncLog");
const { encrypt } = require("../../../utils/crypto/tokenCipher");
const { packCiphertext } = require("../../../utils/crypto/tokenCipher");
const { DOMAIN_STATUS } = require("../../../constants/domain.constants");
const { resolveListing } = require("../listing.resolver");
const registry = require("../registry");

const googleAdapter = require("./google.adapter");
registry.register(googleAdapter);

// Records every call made to the stubbed fetch so assertions can inspect
// what was actually sent, without a real network call ever happening.
let fetchCalls = [];
function installFetchStub(handler) {
  fetchCalls = [];
  mock.method(global, "fetch", async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    return handler(String(url), opts);
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const VALID_MERCHANT_API_HANDLER = (url) => {
  if (url.includes("productInputs:insert")) return jsonResponse(200, { name: "accounts/merchant123/productInputs/x" });
  if (url.includes("/products/")) return jsonResponse(200, {});
  return jsonResponse(404, { error: "unhandled in test stub" });
};

async function makeFixture({ stockControl = true, stockCount = 5, withDomain = true, gtin = null, mpn = null, brand = null } = {}) {
  const suffix = crypto.randomUUID();
  const tenantId = new mongoose.Types.ObjectId();

  if (withDomain) {
    await Domain.create({
      tenant_id: tenantId,
      hostname: `store-${suffix}.example.com`,
      status: DOMAIN_STATUS.ACTIVE,
      is_default: true,
      verification_token: crypto.randomUUID(),
    });
  }

  const product = await Product.create({
    tenant_id: tenantId,
    title: `Google Test ${suffix}`,
    slug: `google-test-${suffix}`,
    sku: `GOOG-${suffix}`,
    status: "active",
    stock_control: stockControl,
    brand,
  });

  if (stockControl) {
    const location = await Location.create({ tenant_id: tenantId, name: `Loc ${suffix}` });
    await Inventory.create({ product: product._id, variant: null, location: location._id, stock_count: stockCount });
  }

  const listing = await MarketplaceListing.create({
    tenant_id: tenantId,
    product: product._id,
    variant: null,
    platform: "google",
    state: "active",
    gtin,
    mpn,
    condition: "new",
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

  return { tenantId, product, listing };
}

// TASK 1 (this run): a real, usable HTTPS image — every fixture below now
// carries one so these tests exercise the actual success path (a product
// with NO image is a rejection now, not a null-imageLink success — see
// google.adapter.image-validation.test.js for that case specifically).
const VALID_HTTPS_IMAGE_URL = "https://cdn.example.com/photo.jpg";

async function resolveFor(listing, product, { photos = [{ type: "image", url: VALID_HTTPS_IMAGE_URL }] } = {}) {
  const populatedProduct = { ...product.toObject(), attachments: photos };
  return resolveListing(listing, populatedProduct, null);
}

test("google adapter: publish() with gtin sends only gtin, no mpn/brand/identifierExists", async (t) => {
  await mongoose.connect(config.mongoUri);
  installFetchStub(VALID_MERCHANT_API_HANDLER);
  t.after(() => mongoose.disconnect());

  const { tenantId, product, listing } = await makeFixture({ gtin: "012345678905" });
  const settings = await googleAdapter.loadSettings(tenantId);
  const resolved = await resolveFor(listing, product);

  const result = await googleAdapter.publish(resolved, settings, {}, null);
  assert.ok(result.external_listing_id.includes("GOOG-") || result.external_listing_id.includes(product.sku));
  assert.equal(result.external_offer_id, null);

  const insertCall = fetchCalls.find((c) => c.url.includes("productInputs:insert"));
  const body = JSON.parse(insertCall.opts.body);
  assert.deepEqual(body.productAttributes.gtins, ["012345678905"]);
  assert.equal(body.productAttributes.mpn, undefined);
  assert.equal(body.productAttributes.identifierExists, undefined);
});

test("google adapter: publish() with no gtin but mpn+brand sends both", async (t) => {
  await mongoose.connect(config.mongoUri);
  installFetchStub(VALID_MERCHANT_API_HANDLER);
  t.after(() => mongoose.disconnect());

  const { tenantId, product, listing } = await makeFixture({ mpn: "MPN-1", brand: "AcmeParts" });
  const settings = await googleAdapter.loadSettings(tenantId);
  const resolved = await resolveFor(listing, product);

  await googleAdapter.publish(resolved, settings, {}, null);

  const body = JSON.parse(fetchCalls.find((c) => c.url.includes("productInputs:insert")).opts.body);
  assert.equal(body.productAttributes.mpn, "MPN-1");
  assert.equal(body.productAttributes.brand, "AcmeParts");
  assert.equal(body.productAttributes.gtins, undefined);
});

test("google adapter: publish() with no identifiers at all sets identifierExists: false", async (t) => {
  await mongoose.connect(config.mongoUri);
  installFetchStub(VALID_MERCHANT_API_HANDLER);
  t.after(() => mongoose.disconnect());

  const { tenantId, product, listing } = await makeFixture({});
  const settings = await googleAdapter.loadSettings(tenantId);
  const resolved = await resolveFor(listing, product);

  await googleAdapter.publish(resolved, settings, {}, null);

  const body = JSON.parse(fetchCalls.find((c) => c.url.includes("productInputs:insert")).opts.body);
  assert.equal(body.productAttributes.identifierExists, false);
  assert.equal(body.productAttributes.gtins, undefined);
  assert.equal(body.productAttributes.mpn, undefined);
});

test("google adapter: quantity 0 -> OUT_OF_STOCK; quantity > 0 -> IN_STOCK (v1 enum)", async (t) => {
  await mongoose.connect(config.mongoUri);
  installFetchStub(VALID_MERCHANT_API_HANDLER);
  t.after(() => mongoose.disconnect());

  const zero = await makeFixture({ stockCount: 0 });
  const settingsZero = await googleAdapter.loadSettings(zero.tenantId);
  const resolvedZero = await resolveFor(zero.listing, zero.product);
  const resultZero = await googleAdapter.publish(resolvedZero, settingsZero, {}, null);
  assert.equal(resultZero.quantity, 0);
  let body = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
  assert.equal(body.productAttributes.availability, "OUT_OF_STOCK");

  const some = await makeFixture({ stockCount: 7 });
  const settingsSome = await googleAdapter.loadSettings(some.tenantId);
  const resolvedSome = await resolveFor(some.listing, some.product);
  const resultSome = await googleAdapter.publish(resolvedSome, settingsSome, {}, null);
  assert.equal(resultSome.quantity, 7);
  body = JSON.parse(fetchCalls[fetchCalls.length - 1].opts.body);
  assert.equal(body.productAttributes.availability, "IN_STOCK");
});

test("google adapter: untracked stock (stock_control off) is skipped, never pushed as in_stock, no Merchant API call made", async (t) => {
  await mongoose.connect(config.mongoUri);
  installFetchStub(VALID_MERCHANT_API_HANDLER);
  t.after(() => mongoose.disconnect());

  const { tenantId, product, listing } = await makeFixture({ stockControl: false });
  const settings = await googleAdapter.loadSettings(tenantId);
  const resolved = await resolveFor(listing, product);

  const result = await googleAdapter.publish(resolved, settings, {}, null);
  assert.deepEqual(result, { skipped: true, reason: "untracked_stock" });
  assert.equal(fetchCalls.length, 0, "no Merchant API call must happen for an untracked-stock product");
});

test("google adapter: a listing with no resolvable public product URL (no default domain, no linkDomain) fails loudly (throws), never pushes", async (t) => {
  await mongoose.connect(config.mongoUri);
  installFetchStub(VALID_MERCHANT_API_HANDLER);
  t.after(() => mongoose.disconnect());

  const originalLinkDomain = config.payment.linkDomain;
  config.payment.linkDomain = null;
  t.after(() => {
    config.payment.linkDomain = originalLinkDomain;
  });

  const { tenantId, product, listing } = await makeFixture({ withDomain: false });
  const settings = await googleAdapter.loadSettings(tenantId);
  const resolved = await resolveFor(listing, product);

  await assert.rejects(() => googleAdapter.publish(resolved, settings, {}, null), /No verified default domain/);
  assert.equal(fetchCalls.length, 0, "no Merchant API call must happen when the product URL can't be resolved");
});

// TASK 1 (this run): a product with ZERO photos is now rejected the same
// way a bad-URL photo is — Google's real API accepts a null imageLink and
// only disapproves the product later, so a photo-less product used to fail
// exactly as silently as a bad-URL one did before TASK 2 (previous run)
// closed that gap. This is the end-to-end counterpart to
// google.adapter.image-validation.test.js's pure-builder version of the
// same case.
test("google adapter: a product with ZERO photos fails loudly (GoogleImageValidationError), never pushes", async (t) => {
  await mongoose.connect(config.mongoUri);
  installFetchStub(VALID_MERCHANT_API_HANDLER);
  t.after(() => mongoose.disconnect());

  const { tenantId, product, listing } = await makeFixture({});
  const settings = await googleAdapter.loadSettings(tenantId);
  const resolved = await resolveFor(listing, product, { photos: [] });

  await assert.rejects(
    () => googleAdapter.publish(resolved, settings, {}, null),
    (err) => {
      assert.ok(err instanceof googleAdapter.GoogleImageValidationError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "INVALID_IMAGE_URL");
      assert.match(err.message, /no images/);
      return true;
    },
  );
  assert.equal(fetchCalls.length, 0, "no Merchant API call must happen for a photo-less product");
});

test("google adapter: loadSettings returns null for a tenant with no ChannelConnection, and sync.service's not-connected path handles it without throwing", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  const settings = await googleAdapter.loadSettings(tenantId);
  assert.equal(settings, null);

  // Full integration through the generic dispatcher — proves
  // sync.service.js#syncListing's existing "not connected" skip path
  // (built for the generic contract already) handles Google's null
  // loadSettings without an unhandled rejection.
  const marketplaceSync = require("../sync.service");
  const product = await Product.create({
    tenant_id: tenantId,
    title: "No connection test",
    slug: `no-conn-${crypto.randomUUID()}`,
    sku: `NOCONN-${crypto.randomUUID()}`,
    status: "active",
    stock_control: true,
  });
  const listing = await MarketplaceListing.create({
    tenant_id: tenantId,
    product: product._id,
    variant: null,
    platform: "google",
    state: "active",
    feed_label: "AU",
    content_language: "en",
  });

  const result = await marketplaceSync.syncListing(listing._id.toString(), null);
  assert.deepEqual(result, { skipped: true, reason: "not_connected" });
});

test("google adapter, via sync.service.js: untracked-stock skip writes a ChannelSyncLog 'skipped' row and marks the listing NOT_LISTED, without throwing", async (t) => {
  await mongoose.connect(config.mongoUri);
  installFetchStub(VALID_MERCHANT_API_HANDLER);
  t.after(() => mongoose.disconnect());

  // logSuccesses must be true for this run so the (non-failure) skip row
  // actually gets written — see sync.service.js#logSyncEvent.
  const originalLogSuccesses = config.channels.logSuccesses;
  config.channels.logSuccesses = true;
  t.after(() => {
    config.channels.logSuccesses = originalLogSuccesses;
  });

  const { listing } = await makeFixture({ stockControl: false });
  const marketplaceSync = require("../sync.service");

  const result = await marketplaceSync.syncListing(listing._id.toString(), null);
  assert.deepEqual(result, { skipped: true, reason: "untracked_stock" });

  const updated = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(updated.sync_status, "not_listed");

  const logRow = await ChannelSyncLog.findOne({ entity_id: listing._id, platform: "google" }).sort({ created_at: -1 }).lean();
  assert.ok(logRow, "a ChannelSyncLog row must exist for the skip");
  assert.equal(logRow.status, "skipped");
  assert.equal(logRow.error_code, "untracked_stock");
});
