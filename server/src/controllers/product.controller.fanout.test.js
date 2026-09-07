// controllers/product.controller.fanout.test.js
//
// Regression guard for TASK 1: updateProduct/updateVariant must fan out to
// marketplace listings ONLY when a field a channel payload actually reads
// changed (title/description/price/brand/mpn/condition/attachments on the
// product; price/sku/attachments on a variant) — never on an unrelated
// field, and never in a way that fails the HTTP response if the queue call
// itself fails.
//
// Calls the exported controller functions directly with plain fake
// req/res objects (this repo has no supertest/app-level HTTP test harness
// and "no npm dependencies" is a hard constraint for this change) — same
// spirit as inventory.service.fanout.test.js, one level up the call stack.
//
// Needs a live Mongo connection — run with:
//   node --test src/controllers/product.controller.fanout.test.js
//
// HISTORY: this file used to hang `npm test`'s full `--test-concurrency=1`
// run indefinitely (confirmed via `ps` while stuck: minutes elapsed, still
// sitting on this file). Traced (by bisecting product.controller.js's
// require graph against a plain mongoose connect/disconnect,
// process._getActiveHandles() showing a lingering Redis Socket) to
// product.service.js -> services/email/email.service.js ->
// queues/email.queue.js constructing a real `new Queue("email", ...)` at
// require time — a real ioredis connection nothing ever closed, completely
// unrelated to anything updateProduct/updateVariant themselves do.
// services/refund.reconciliation.service.test.js turned out to hang the
// SAME way, via the same email.service.js require, one hop further through
// refund.service.js.
//
// FIXED AT THE ROOT (see queues/email.queue.js, queues/search.queue.js,
// queues/channel.queue.js's existing getQueue): every Bull queue in this
// repo is now constructed LAZILY, on first real use, not at require() time
// — a getter-backed export for email/search (channel.queue.js's own
// getQueue already worked this way). Requiring product.controller.js (or
// anything else) no longer opens any Redis connection on its own, so this
// file goes back to the plain, ordinary `mock.method()` shape every other
// test in this repo already uses (inventory.service.fanout.test.js, right
// next to this one) — no require.cache stubbing needed any more.
const test = require("node:test");
const { mock, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../config");

const channelQueueModule = require("../queues/channel.queue");
const enqueueSpy = mock.method(channelQueueModule, "enqueueChannelJob", async (platform) => {
  if (platform === "google" && enqueueSpy.__failGoogle) {
    throw new Error("simulated google queue outage");
  }
  return { id: `fake-job-${platform}` };
});

const searchQueueModule = require("../queues/search.queue");
mock.method(searchQueueModule, "enqueueSearchJob", async () => ({ id: "fake-search-job" }));

const registry = require("../services/marketplace/registry");
registry.register({ key: "ebay", publish: async () => {}, update: async () => {}, end: async () => {} });
registry.register({ key: "google", publish: async () => {}, update: async () => {}, end: async () => {} });

const productController = require("./product.controller");

// getPopulatedProduct/getPopulatedVariant (called at the end of every
// controller path under test) populate "attachments"/"categories"/
// "digital_file" — Mongoose needs those models registered on this
// connection before a populate touching them will resolve, which normally
// happens as a side effect of the app's full route/controller graph
// loading at boot. This test only requires product.controller.js directly,
// so it never pulls those model files in on its own; require them
// explicitly rather than let populate fail with a MissingSchemaError.
require("../models/Attachment");
require("../models/Category");

// One connection for the whole file (matching the single-connect/disconnect
// shape every other *.test.js in this repo uses) rather than one per test —
// avoids cycling the Mongo driver's connection/monitor setup 4x in one
// process.
before(async () => {
  await mongoose.connect(config.mongoUri);
});

after(async () => {
  await mongoose.disconnect();
});

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function setup() {
  const Product = require("../models/Product");
  const ProductVariant = require("../models/ProductVariant");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const { LISTING_STATE } = require("../constants/marketplace.constants");

  const suffix = crypto.randomUUID();
  const tenantId = new mongoose.Types.ObjectId();

  const product = await Product.create({
    tenant_id: tenantId,
    title: `Task1 fan-out test ${suffix}`,
    slug: `task1-fanout-${suffix}`,
    sku: `T1FO-${suffix}`,
    price: 100,
    status: "active",
  });

  await MarketplaceListing.create({
    tenant_id: tenantId,
    product: product._id,
    variant: null,
    platform: "ebay",
    state: LISTING_STATE.ACTIVE,
    condition: "NEW",
  });
  await MarketplaceListing.create({
    tenant_id: tenantId,
    product: product._id,
    variant: null,
    platform: "google",
    state: LISTING_STATE.ACTIVE,
    condition: "new",
  });

  return { Product, ProductVariant, MarketplaceListing, LISTING_STATE, tenantId, product };
}

test("updateProduct: a price change fans out to both an eBay and a Google listing", async (t) => {
  const { tenantId, product } = await setup();
  enqueueSpy.mock.resetCalls();

  const req = {
    params: { id: product._id.toString() },
    tenantId,
    user: { _id: new mongoose.Types.ObjectId() },
    body: { price: "149.99" },
  };
  const res = fakeRes();

  await productController.updateProduct(req, res);

  assert.equal(res.statusCode, 200);
  const platforms = enqueueSpy.mock.calls
    .filter((c) => c.arguments[1] === "sync_listing")
    .map((c) => c.arguments[0])
    .sort();
  assert.deepEqual(platforms, ["ebay", "google"], "a price change must queue sync_listing for both listings");
});

test("updateProduct: an irrelevant-field edit fans out to nothing", async (t) => {
  const { tenantId, product } = await setup();
  enqueueSpy.mock.resetCalls();

  const req = {
    params: { id: product._id.toString() },
    tenantId,
    user: { _id: new mongoose.Types.ObjectId() },
    // is_taxable/stock_control/tags are never read by listing.resolver.js
    // or any adapter — must not queue anything.
    body: { is_taxable: true, stock_control: false, tags: ["a", "b"] },
  };
  const res = fakeRes();

  await productController.updateProduct(req, res);

  assert.equal(res.statusCode, 200);
  const syncCalls = enqueueSpy.mock.calls.filter((c) => c.arguments[1] === "sync_listing");
  assert.equal(syncCalls.length, 0, "an edit to fields no adapter reads must not fan out");
});

test("updateProduct: a queue failure does not fail the request", async (t) => {
  const { tenantId, product } = await setup();
  enqueueSpy.mock.resetCalls();
  enqueueSpy.__failGoogle = true;

  const req = {
    params: { id: product._id.toString() },
    tenantId,
    user: { _id: new mongoose.Types.ObjectId() },
    body: { title: "A brand new title" },
  };
  const res = fakeRes();

  await productController.updateProduct(req, res);

  enqueueSpy.__failGoogle = false;

  assert.equal(res.statusCode, 200, "google's simulated queue outage must not fail the product update response");
  assert.equal(res.body.status, "Success");
  const ebayCalls = enqueueSpy.mock.calls.filter((c) => c.arguments[0] === "ebay" && c.arguments[1] === "sync_listing");
  assert.equal(ebayCalls.length, 1, "ebay's own fan-out must still have been attempted independently of google's failure");
});

test("updateVariant: a variant price change fans out only for that variant's own listing", async (t) => {
  const { ProductVariant, MarketplaceListing, LISTING_STATE, tenantId, product } = await setup();
  enqueueSpy.mock.resetCalls();

  const variant = await ProductVariant.create({
    tenant_id: tenantId,
    product: product._id,
    combination: [{ option: "Size", value: "L" }],
    price: 50,
  });
  const otherVariant = await ProductVariant.create({
    tenant_id: tenantId,
    product: product._id,
    combination: [{ option: "Size", value: "M" }],
    price: 40,
  });

  const listing = await MarketplaceListing.create({
    tenant_id: tenantId,
    product: product._id,
    variant: variant._id,
    platform: "ebay",
    state: LISTING_STATE.ACTIVE,
    condition: "NEW",
  });
  const otherListing = await MarketplaceListing.create({
    tenant_id: tenantId,
    product: product._id,
    variant: otherVariant._id,
    platform: "ebay",
    state: LISTING_STATE.ACTIVE,
    condition: "NEW",
  });

  const req = {
    params: { id: product._id.toString(), variantId: variant._id.toString() },
    tenantId,
    user: { _id: new mongoose.Types.ObjectId() },
    body: { price: "65.00" },
  };
  const res = fakeRes();

  await productController.updateVariant(req, res);

  assert.equal(res.statusCode, 200);
  const syncCalls = enqueueSpy.mock.calls.filter((c) => c.arguments[1] === "sync_listing");
  assert.equal(syncCalls.length, 1, "only the edited variant's own listing should be fanned out to");
  assert.equal(syncCalls[0].arguments[2].listingId, listing._id.toString());
  assert.notEqual(syncCalls[0].arguments[2].listingId, otherListing._id.toString());
});
