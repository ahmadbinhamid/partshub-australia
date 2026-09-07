// services/marketplace/sync.service.legacy-fencing.test.js
//
// Regression guard for Task 1's core bug: push_seq/last_pushed_seq used to
// live only on the eBay discriminator even though sync.service.js reads
// them generically for every platform — a document written before they
// moved to the base schema (see MarketplaceListing.js) has NO
// last_pushed_seq field in its stored BSON at all. This proves the fencing
// check still behaves correctly (stale jobs dropped, fresh jobs applied)
// against a document inserted the way a genuinely legacy doc would look —
// bypassing Mongoose entirely so no schema default gets written at insert
// time, exercising whatever this repo actually falls back to on read
// (Mongoose's own hydration default, and/or the explicit `?? 0` coalescing
// at every comparison site) rather than assuming which one applies.
//
// Registers a fake "ebay" adapter (not the real ebayAdapter), same pattern
// as sync.service.fencing.test.js, so this exercises only the fencing/
// dispatch logic without needing real eBay credentials.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/marketplace/sync.service.legacy-fencing.test.js

const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../config");

require("../../models/index"); // registers all schemas — syncListing populates Attachment via product.attachments
const registry = require("./registry");
const ebaySettingsService = require("../ebay/ebay.settings.service");
mock.method(ebaySettingsService, "getSettings", async () => ({ tenant_id: null, sandbox: true, marketplace_id: "EBAY_AU" }));

// Randomized (not a fixed "L1"/"O1" literal) — MarketplaceListing has a
// partial unique index on external_listing_id/external_offer_id across
// every non-deleted document, and this suite shares a database with
// sync.service.fencing.test.js, whose own fake adapter mock returns a fixed
// "L1"/"O1" — a fixed value here would collide with that test's leftover
// data (or with a previous run of this same test).
const mockSuffix = crypto.randomUUID();
const updateSpy = mock.fn(async () => ({
  external_listing_id: `L1-${mockSuffix}`,
  external_offer_id: `O1-${mockSuffix}`,
  quantity: 3,
}));
registry.register({ key: "ebay", publish: mock.fn(), update: updateSpy, end: mock.fn() });

const { syncListing } = require("./sync.service");

test("sync_listing fencing: a legacy document with NO last_pushed_seq field at all still fences correctly", async (t) => {
  await mongoose.connect(config.mongoUri);

  const Product = require("../../models/Product");
  const { MARKETPLACE_PLATFORM, LISTING_STATE } = require("../../constants/marketplace.constants");

  const suffix = crypto.randomUUID();
  const tenantId = new mongoose.Types.ObjectId();

  const product = await Product.create({
    tenant_id: tenantId,
    title: `Legacy fencing test ${suffix}`,
    slug: `legacy-fencing-test-${suffix}`,
    sku: `LFENCE-${suffix}`,
    status: "active",
  });

  // Raw insert, bypassing Mongoose entirely — no push_seq/last_pushed_seq
  // field is written at all, simulating a document created before this
  // migration moved those fields onto the base schema.
  const insertResult = await mongoose.connection.db.collection("marketplacelistings").insertOne({
    tenant_id: tenantId,
    product: product._id,
    variant: null,
    platform: MARKETPLACE_PLATFORM.EBAY,
    state: LISTING_STATE.ACTIVE,
    sync_status: "synced",
    external_listing_id: `L-${suffix}`,
    external_offer_id: `O-${suffix}`,
    condition: "NEW",
    created_at: new Date(),
    updated_at: new Date(),
  });
  const listingId = insertResult.insertedId.toString();

  // Cleanup — this file's ids were already randomized (see the module
  // comment above) so a leftover row was never going to collide with a
  // future run, but nothing here was ever actually deleted either; that's
  // still unbounded growth in a shared database for no reason. Hard-delete
  // (matching the raw insert above, which bypassed Mongoose/soft-delete
  // too) rather than soft-delete. One combined `t.after` (delete THEN
  // disconnect, explicitly sequenced) rather than two separate hooks —
  // Node's test runner doesn't document an ordering guarantee across
  // multiple `t.after` calls on the same test worth relying on.
  t.after(async () => {
    await mongoose.connection.db.collection("marketplacelistings").deleteOne({ _id: insertResult.insertedId });
    await Product.deleteOne({ _id: product._id });
    await mongoose.disconnect();
  });

  const raw = await mongoose.connection.db.collection("marketplacelistings").findOne({ _id: insertResult.insertedId });
  assert.equal(raw.last_pushed_seq, undefined, "sanity check: the raw stored doc must have no last_pushed_seq field");

  const callsBefore = updateSpy.mock.callCount();

  // A negative seq is unambiguously "older than whatever baseline a legacy
  // doc effectively has" (0, whether via explicit coalescing or Mongoose's
  // own hydration default) — must be dropped, never applied.
  const staleResult = await syncListing(listingId, -1);
  assert.deepEqual(staleResult, { skipped: true, reason: "stale_seq" });
  assert.equal(updateSpy.mock.callCount(), callsBefore, "a stale-seq job must never call the adapter for a legacy document");

  const freshResult = await syncListing(listingId, 1);
  assert.equal(freshResult.ok, true);
  assert.equal(updateSpy.mock.callCount(), callsBefore + 1, "a fresh-seq job must call the adapter even for a legacy document");
});
