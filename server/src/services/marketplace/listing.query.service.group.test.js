// services/marketplace/listing.query.service.group.test.js
//
// TASK 6: listListingsGroupedByProduct returns one row per PRODUCT with all
// of that product's listings nested under it, instead of one row per
// listing — and paginates over distinct products, not listing rows.
//
// TASK 3 (this run): a filter (platform/state/sync_status/search) narrows
// WHICH PRODUCTS qualify for a page, never which of a qualifying product's
// channels are shown in its row — a product's row always carries its FULL
// listing set. See listing.query.service.js#listListingsGroupedByProduct's
// own comment for why (a grey "not listed" cell must always mean exactly
// that, never "filtered out").
//
// Needs a live Mongo connection — run with:
//   node --test src/services/marketplace/listing.query.service.group.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../config");

require("../../models/index");
const Product = require("../../models/Product");
const MarketplaceListing = require("../../models/MarketplaceListing");
const { LISTING_STATE } = require("../../constants/marketplace.constants");
const { listListingsGroupedByProduct } = require("./listing.query.service");

async function makeProduct(tenantId, overrides = {}) {
  const suffix = crypto.randomUUID();
  return Product.create({
    tenant_id: tenantId,
    title: `Group test ${suffix}`,
    slug: `group-test-${suffix}`,
    sku: `GRP-${suffix}`,
    price: 42,
    status: "active",
    ...overrides,
  });
}

test("listListingsGroupedByProduct: a product on two channels returns ONE row with both listings nested", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  const product = await makeProduct(tenantId);

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

  const { items, total } = await listListingsGroupedByProduct({ skip: 0, limit: 20 }, tenantId);

  assert.equal(total, 1, "one distinct product, not two listing rows");
  assert.equal(items.length, 1);
  assert.equal(items[0].product._id.toString(), product._id.toString());
  const platforms = items[0].listings.map((l) => l.platform).sort();
  assert.deepEqual(platforms, ["ebay", "google"]);
});

test("listListingsGroupedByProduct: two separate products stay as two separate rows", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  const productA = await makeProduct(tenantId);
  const productB = await makeProduct(tenantId);

  await MarketplaceListing.create({
    tenant_id: tenantId,
    product: productA._id,
    variant: null,
    platform: "ebay",
    state: LISTING_STATE.ACTIVE,
    condition: "NEW",
  });
  await MarketplaceListing.create({
    tenant_id: tenantId,
    product: productB._id,
    variant: null,
    platform: "ebay",
    state: LISTING_STATE.ACTIVE,
    condition: "NEW",
  });

  const { items, total } = await listListingsGroupedByProduct({ skip: 0, limit: 20 }, tenantId);
  assert.equal(total, 2);
  assert.equal(items.length, 2);
  for (const item of items) assert.equal(item.listings.length, 1);
});

test("listListingsGroupedByProduct: platform filter narrows WHICH PRODUCTS qualify, but a qualifying product's row still shows its FULL channel picture", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  const productWithBoth = await makeProduct(tenantId);
  const productWithEbayOnly = await makeProduct(tenantId);

  await MarketplaceListing.create({ tenant_id: tenantId, product: productWithBoth._id, variant: null, platform: "ebay", state: LISTING_STATE.ACTIVE, condition: "NEW" });
  await MarketplaceListing.create({ tenant_id: tenantId, product: productWithBoth._id, variant: null, platform: "google", state: LISTING_STATE.ACTIVE, condition: "new" });
  await MarketplaceListing.create({ tenant_id: tenantId, product: productWithEbayOnly._id, variant: null, platform: "ebay", state: LISTING_STATE.ACTIVE, condition: "NEW" });

  const { items, total } = await listListingsGroupedByProduct({ skip: 0, limit: 20, platform: "google" }, tenantId);
  assert.equal(total, 1, "only the product with a matching google listing should qualify for the page");
  assert.equal(items[0].product._id.toString(), productWithBoth._id.toString());

  // TASK 3: the row must NOT be silently narrowed to just the google
  // listing — its ebay listing (which doesn't match the filter) must still
  // be present, so an absent THIRD channel on this row is unambiguously
  // "not listed", never "filtered out by the platform dropdown".
  const platforms = items[0].listings.map((l) => l.platform).sort();
  assert.deepEqual(platforms, ["ebay", "google"], "a qualifying product's row must show ALL its listings, not just the one that matched the filter");
});

test("listListingsGroupedByProduct: pagination (skip/limit) counts DISTINCT PRODUCTS, not listing rows", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const tenantId = new mongoose.Types.ObjectId();
  // 3 products, each with 2 listings (ebay + google) = 6 listing rows total,
  // but only 3 distinct products.
  for (let i = 0; i < 3; i++) {
    const product = await makeProduct(tenantId);
    await MarketplaceListing.create({ tenant_id: tenantId, product: product._id, variant: null, platform: "ebay", state: LISTING_STATE.ACTIVE, condition: "NEW" });
    await MarketplaceListing.create({ tenant_id: tenantId, product: product._id, variant: null, platform: "google", state: LISTING_STATE.ACTIVE, condition: "new" });
  }

  const page1 = await listListingsGroupedByProduct({ skip: 0, limit: 2 }, tenantId);
  assert.equal(page1.total, 3);
  assert.equal(page1.items.length, 2, "limit: 2 must return 2 PRODUCT rows, not 2 listing rows");

  const page2 = await listListingsGroupedByProduct({ skip: 2, limit: 2 }, tenantId);
  assert.equal(page2.items.length, 1);
});
