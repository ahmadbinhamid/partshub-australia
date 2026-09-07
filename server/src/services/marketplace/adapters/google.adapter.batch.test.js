// services/marketplace/adapters/google.adapter.batch.test.js
//
// Task 3 (batch path) coverage: a per-item failure inside publishBatch must
// not fail the rest of the batch, and sync.service.js#syncBatch must
// respect each listing's own fencing token (push_seq/last_pushed_seq),
// dropping a stale one exactly like syncListing does for a single listing.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/marketplace/adapters/google.adapter.batch.test.js

const test = require("node:test");
const { mock, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../../config");

require("../../../models/index");
const Product = require("../../../models/Product");
const Attachment = require("../../../models/Attachment");
const Location = require("../../../models/Location");
const Inventory = require("../../../models/Inventory");
const Domain = require("../../../models/Domain");
const MarketplaceListing = require("../../../models/MarketplaceListing");
const ChannelConnection = require("../../../models/ChannelConnection");
const ChannelSyncLog = require("../../../models/ChannelSyncLog");
const { encrypt, packCiphertext } = require("../../../utils/crypto/tokenCipher");
const { DOMAIN_STATUS } = require("../../../constants/domain.constants");
const { resolveListing } = require("../listing.resolver");
const registry = require("../registry");

const googleAdapter = require("./google.adapter");
registry.register(googleAdapter);

const marketplaceSync = require("../sync.service");

function installFetchStub(handler) {
  mock.method(global, "fetch", async (url, opts) => handler(String(url), opts));
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// TASK 1 (this run): a zero-photo product is now rejected the same way a
// bad-URL one is (see google.adapter.js#buildProductInputFromResolved's own
// comment) — makeTenantWithListings below gives every product a real
// Attachment so sync.service.js#syncBatch's own real Mongoose population
// resolves an actual usable image, exercising the real success path rather
// than the (now-rejected) photo-less one. Attachment.url is a virtual built
// from config.uploads.url (utils/attachment.js#buildAttachmentUrl) — this
// env's real UPLOADS_URL is plain http://, so it's overridden to a fake
// https:// host for the life of this file, restored after.
let originalUploadsUrl;
before(() => {
  originalUploadsUrl = config.uploads.url;
  config.uploads.url = "https://cdn.example.com";
});
after(() => {
  config.uploads.url = originalUploadsUrl;
});

async function makeTenantWithListings(count) {
  const suffix = crypto.randomUUID();
  const tenantId = new mongoose.Types.ObjectId();

  await Domain.create({
    tenant_id: tenantId,
    hostname: `batch-${suffix}.example.com`,
    status: DOMAIN_STATUS.ACTIVE,
    is_default: true,
    verification_token: crypto.randomUUID(),
  });

  const location = await Location.create({ tenant_id: tenantId, name: `Loc ${suffix}` });

  const listings = [];
  for (let i = 0; i < count; i++) {
    const attachment = await Attachment.create({
      tenant_id: tenantId,
      uid: `batch-photo-${i}-${suffix}`,
      file_name: `batch-photo-${i}-${suffix}.jpg`,
      type: "image",
    });
    const product = await Product.create({
      tenant_id: tenantId,
      title: `Batch product ${i} ${suffix}`,
      slug: `batch-${i}-${suffix}`,
      sku: `BATCH-${i}-${suffix}`,
      status: "active",
      stock_control: true,
      attachments: [attachment._id],
    });
    await Inventory.create({ product: product._id, variant: null, location: location._id, stock_count: 3 });
    const listing = await MarketplaceListing.create({
      tenant_id: tenantId,
      product: product._id,
      variant: null,
      platform: "google",
      state: "active",
      feed_label: "AU",
      content_language: "en",
    });
    listings.push({ product, listing });
  }

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

  return { tenantId, listings };
}

test("publishBatch: a per-item failure is isolated — the rest of the batch still succeeds", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const { tenantId, listings } = await makeTenantWithListings(3);
  const failingSku = (await listings[1].product).sku;

  installFetchStub((url, opts) => {
    if (url.includes("productInputs:insert")) {
      const body = JSON.parse(opts.body);
      if (body.offerId === failingSku) return jsonResponse(400, { error: { message: "bad category" } });
      return jsonResponse(200, { name: "accounts/merchant123/productInputs/x" });
    }
    return jsonResponse(404, {});
  });

  const settings = await googleAdapter.loadSettings(tenantId);
  const resolvedList = await Promise.all(
    listings.map(({ listing, product }) =>
      resolveListing(listing, { ...product.toObject(), attachments: [{ type: "image", url: "https://cdn.example.com/photo.jpg" }] }, null),
    ),
  );

  const results = await googleAdapter.publishBatch(resolvedList, settings);
  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].status, 400);
  assert.equal(results[2].ok, true, "the item AFTER the failing one must still have been processed, not aborted");
});

test("sync.service.js#syncBatch: a per-item failure logs a ChannelSyncLog row for that item and the rest of the batch still succeeds", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const { tenantId, listings } = await makeTenantWithListings(3);
  const failingProduct = await listings[1].product;

  installFetchStub((url, opts) => {
    if (url.includes("productInputs:insert")) {
      const body = JSON.parse(opts.body);
      if (body.offerId === failingProduct.sku) return jsonResponse(400, { error: { message: "bad category" } });
      return jsonResponse(200, { name: "accounts/merchant123/productInputs/x" });
    }
    return jsonResponse(404, {});
  });

  const result = await marketplaceSync.syncBatch("google", tenantId);
  assert.equal(result.ok, true);
  assert.equal(result.processed, 3);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);

  const failLog = await ChannelSyncLog.findOne({ entity_id: listings[1].listing._id, status: "failure" }).lean();
  assert.ok(failLog, "the failing item must have its own ChannelSyncLog failure row");

  const succeededListing = await MarketplaceListing.findById(listings[0].listing._id).lean();
  assert.equal(succeededListing.sync_status, "synced");
});

test("sync.service.js#syncBatch: respects the per-listing fencing token — a stale seq is dropped, not pushed", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  // A stale-seq skip is logged via the SKIPPED status, which
  // logSyncEvent only writes when config.channels.logSuccesses is true
  // (failures are always logged; skips/successes are opt-in — see
  // sync.service.js) — needed here so the log-row assertion below has
  // something to find.
  const originalLogSuccesses = config.channels.logSuccesses;
  config.channels.logSuccesses = true;
  t.after(() => {
    config.channels.logSuccesses = originalLogSuccesses;
  });

  const { tenantId, listings } = await makeTenantWithListings(1);
  const { listing } = listings[0];

  // Simulate "something newer already landed" between the cursor read and
  // dispatch: bump push_seq (what the cursor will read as this item's
  // "seq to apply") but set last_pushed_seq even HIGHER — exactly the
  // state a newer single-listing sync_listing job landing concurrently
  // would leave behind.
  await MarketplaceListing.updateOne({ _id: listing._id }, { $set: { push_seq: 3, last_pushed_seq: 5 } });

  const calls = [];
  installFetchStub((url, opts) => {
    if (url.includes("productInputs:insert")) calls.push(JSON.parse(opts.body));
    return jsonResponse(200, { name: "x" });
  });

  const result = await marketplaceSync.syncBatch("google", tenantId);
  assert.equal(result.skipped, 1, "the stale item must be counted as skipped");
  assert.equal(result.succeeded, 0);
  assert.equal(calls.length, 0, "a stale-seq item must never actually be pushed to the Merchant API");

  const logRow = await ChannelSyncLog.findOne({ entity_id: listing._id }).lean();
  assert.equal(logRow.status, "skipped");
  assert.equal(logRow.error_code, "stale_seq");

  // last_pushed_seq must be untouched — still 5, not regressed to 3.
  const after = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(after.last_pushed_seq, 5);
});
