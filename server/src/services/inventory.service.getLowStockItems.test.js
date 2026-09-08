// services/inventory.service.getLowStockItems.test.js
//
// getLowStockItems powers the low-stock digest email (see
// inventory-digest.service.js) — same aggregation shape as
// dashboard.service.js#getStockCounts, deliberately kept identical so the
// dashboard's "low stock" tile and the digest email never disagree about
// what counts as "low". Each boundary case below pairs a fixture that
// SHOULD be included with a sibling that shouldn't, so an off-by-one in the
// $gt/$lte aggregation stage would actually turn a specific assertion red,
// not just change an array length.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/inventory.service.getLowStockItems.test.js

const test = require("node:test");
const { before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../config");

const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const Inventory = require("../models/Inventory");
const Location = require("../models/Location");
const { getLowStockItems } = require("./inventory.service");

before(() => mongoose.connect(config.mongoUri));
after(() => mongoose.disconnect());

async function makeProduct(tenantId, overrides = {}) {
  const suffix = crypto.randomUUID();
  return Product.create({
    tenant_id: tenantId,
    title: `Low stock test ${suffix}`,
    slug: `low-stock-test-${suffix}`,
    sku: `LS-${suffix}`,
    price: 42,
    status: "active",
    ...overrides,
  });
}

// Registers cleanup for every doc created in the test so fixtures never leak
// into the dev DB across runs (see inventory-digest.service.test.js's own
// note on t.after firing in registration order, not LIFO — cleanup here is
// deliberately the LAST thing registered in each test for that reason).
function cleanupOnExit(t, { products = [], variants = [], locations = [] } = {}) {
  t.after(async () => {
    const productIds = products.map((p) => p._id);
    const locationIds = locations.map((l) => l._id);
    await Inventory.deleteMany({ $or: [{ product: { $in: productIds } }, { location: { $in: locationIds } }] });
    await ProductVariant.deleteMany({ _id: { $in: variants.map((v) => v._id) } });
    await Product.deleteMany({ _id: { $in: productIds } });
    await Location.deleteMany({ _id: { $in: locationIds } });
  });
}

test("getLowStockItems: threshold boundary — at threshold included, above excluded, zero (out of stock) excluded", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const location = await Location.create({ tenant_id: tenantId, name: `Loc ${crypto.randomUUID()}` });

  const atThreshold = await makeProduct(tenantId);
  const aboveThreshold = await makeProduct(tenantId);
  const outOfStock = await makeProduct(tenantId);
  cleanupOnExit(t, { products: [atThreshold, aboveThreshold, outOfStock], locations: [location] });

  await Inventory.create({ product: atThreshold._id, variant: null, location: location._id, stock_count: 5 });
  await Inventory.create({ product: aboveThreshold._id, variant: null, location: location._id, stock_count: 6 });
  await Inventory.create({ product: outOfStock._id, variant: null, location: location._id, stock_count: 0 });

  const items = await getLowStockItems(tenantId, 5);
  const ids = items.map((i) => i.product_id.toString());

  assert.ok(ids.includes(atThreshold._id.toString()), "stock exactly at threshold must be included (lte)");
  assert.ok(!ids.includes(aboveThreshold._id.toString()), "stock above threshold must be excluded");
  assert.ok(!ids.includes(outOfStock._id.toString()), "zero stock is out-of-stock, not low-stock — must be excluded");

  const atThresholdRow = items.find((i) => i.product_id.toString() === atThreshold._id.toString());
  assert.equal(atThresholdRow.stock, 5);
  assert.equal(atThresholdRow.title, atThreshold.title);
});

test("getLowStockItems: multi-location stock is summed before comparing against threshold", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const locationA = await Location.create({ tenant_id: tenantId, name: `Loc A ${crypto.randomUUID()}` });
  const locationB = await Location.create({ tenant_id: tenantId, name: `Loc B ${crypto.randomUUID()}` });

  const product = await makeProduct(tenantId);
  cleanupOnExit(t, { products: [product], locations: [locationA, locationB] });

  // 3 + 3 = 6 total, ABOVE a threshold of 5 — must NOT show up as low stock
  // even though each individual location's count (3) would be under 5 on
  // its own. Proves the aggregation sums across locations, not per-location.
  await Inventory.create({ product: product._id, variant: null, location: locationA._id, stock_count: 3 });
  await Inventory.create({ product: product._id, variant: null, location: locationB._id, stock_count: 3 });

  const items = await getLowStockItems(tenantId, 5);
  assert.ok(
    !items.some((i) => i.product_id.toString() === product._id.toString()),
    "summed stock (6) is above the threshold (5) — must not be flagged low",
  );

  // Now drop location B to push the combined total under threshold.
  await Inventory.updateOne({ product: product._id, location: locationB._id }, { stock_count: 1 });
  const itemsAfter = await getLowStockItems(tenantId, 5);
  const row = itemsAfter.find((i) => i.product_id.toString() === product._id.toString());
  assert.ok(row, "summed stock (4) is at/under the threshold (5) — must now be flagged low");
  assert.equal(row.stock, 4);
});

test("getLowStockItems: a variant's own SKU wins over the parent product's SKU", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const location = await Location.create({ tenant_id: tenantId, name: `Loc ${crypto.randomUUID()}` });
  const product = await makeProduct(tenantId, { has_variants: true });
  const variant = await ProductVariant.create({
    tenant_id: tenantId,
    product: product._id,
    display_name: "Red / Large",
    sku: `VAR-${crypto.randomUUID()}`,
  });
  cleanupOnExit(t, { products: [product], variants: [variant], locations: [location] });

  await Inventory.create({ product: product._id, variant: variant._id, location: location._id, stock_count: 2 });

  const items = await getLowStockItems(tenantId, 5);
  const row = items.find((i) => i.variant_id?.toString() === variant._id.toString());
  assert.ok(row, "variant-level low-stock row must be present");
  assert.equal(row.sku, variant.sku, "variant's own SKU must be used, not the parent product's");
  assert.equal(row.variant_name, "Red / Large");
});

test("getLowStockItems: a variant with no SKU of its own falls back to the parent product's SKU", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const location = await Location.create({ tenant_id: tenantId, name: `Loc ${crypto.randomUUID()}` });
  const product = await makeProduct(tenantId, { has_variants: true });
  const variant = await ProductVariant.create({
    tenant_id: tenantId,
    product: product._id,
    display_name: "No SKU variant",
    sku: null,
  });
  cleanupOnExit(t, { products: [product], variants: [variant], locations: [location] });

  await Inventory.create({ product: product._id, variant: variant._id, location: location._id, stock_count: 1 });

  const items = await getLowStockItems(tenantId, 5);
  const row = items.find((i) => i.variant_id?.toString() === variant._id.toString());
  assert.equal(row.sku, product.sku, "falls back to the product's SKU when the variant has none");
});

test("getLowStockItems: scoped to the requesting tenant only", async (t) => {
  const tenantA = new mongoose.Types.ObjectId();
  const tenantB = new mongoose.Types.ObjectId();
  const locationA = await Location.create({ tenant_id: tenantA, name: `Loc A ${crypto.randomUUID()}` });

  const productB = await makeProduct(tenantB);
  cleanupOnExit(t, { products: [productB], locations: [locationA] });

  await Inventory.create({ product: productB._id, variant: null, location: locationA._id, stock_count: 1 });

  const itemsForA = await getLowStockItems(tenantA, 5);
  assert.ok(
    !itemsForA.some((i) => i.product_id.toString() === productB._id.toString()),
    "tenant A's query must never return tenant B's low-stock product",
  );
});

test("getLowStockItems: a soft-deleted product is excluded", async (t) => {
  const tenantId = new mongoose.Types.ObjectId();
  const location = await Location.create({ tenant_id: tenantId, name: `Loc ${crypto.randomUUID()}` });
  const product = await makeProduct(tenantId);
  cleanupOnExit(t, { products: [product], locations: [location] });

  await Inventory.create({ product: product._id, variant: null, location: location._id, stock_count: 1 });

  product.deleted_at = new Date();
  await product.save();

  const items = await getLowStockItems(tenantId, 5);
  assert.ok(
    !items.some((i) => i.product_id.toString() === product._id.toString()),
    "a soft-deleted product must never appear in the digest",
  );
});
