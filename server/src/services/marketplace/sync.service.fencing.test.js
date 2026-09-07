// services/marketplace/sync.service.fencing.test.js
//
// Regression guard for the "second writer path" gap: the old push_quantity
// job was the only fenced writer — sync_listing (fanned out by every manual
// stock correction) ran at concurrency 2 with no seq at all, so a stale
// sync_listing job could still land after a newer one and, in the old
// snapshot-quantity design, overwrite a correct value with a stale one.
// sync_listing is now the ONLY writer path and carries the same seq fence
// (see ebay.adapter.js's module header comment) — this tests that fence
// directly at the sync.service.js#syncListing layer, where the drop
// actually happens.
//
// Registers a fake "ebay" adapter (not the real ebayAdapter) so this
// exercises only the fencing/dispatch logic, without needing real eBay
// credentials — same reasoning as mocking ebayApi.* elsewhere in this suite.
//
// RERUN HYGIENE: the adapter's fake update() used to return HARDCODED
// external_listing_id/external_offer_id ("L1"/"O1") — syncListing's success
// path writes those back onto the listing, and MarketplaceListing has a
// UNIQUE partial index on both fields (see that model's own comment on why:
// two DRAFT listings silently sharing one real eBay offer, found live).
// Every run left its listing sitting in Mongo with "L1"/"O1" still on it,
// forever (no cleanup at all) — so the NEXT run's attempt to write those
// same two literal values onto a brand-new listing document collided with
// the still-there previous one, and had to be cleared by hand before this
// file (or the full suite, stuck sequentially behind it) would run at all.
// Fixed two ways, together: (1) the fake external ids are unique per RUN
// (suffixed the same way every other id in this file already is), so nothing
// this test writes can ever collide with a previous run's leftovers even if
// cleanup somehow didn't happen; (2) an explicit `t.after` now deletes
// exactly what this test created, so nothing is left behind for a future
// run to collide with in the first place. Belt and suspenders — either one
// alone would have been enough, but a fenced writer-path test is exactly
// the kind of thing worth not leaving to just one of the two.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/marketplace/sync.service.fencing.test.js

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

// Unique per process (not just per test run) — see the module header's
// "RERUN HYGIENE" note. registry.register happens once at module load, so
// this can't be suffixed per-test the way the listing's own ids are; a
// fresh random pair every time this file is loaded is enough on its own to
// never collide with a previous run's now-deleted (see t.after below) row.
const FAKE_EXTERNAL_LISTING_ID = `L-fencing-${crypto.randomUUID()}`;
const FAKE_EXTERNAL_OFFER_ID = `O-fencing-${crypto.randomUUID()}`;
const updateSpy = mock.fn(async () => ({
  external_listing_id: FAKE_EXTERNAL_LISTING_ID,
  external_offer_id: FAKE_EXTERNAL_OFFER_ID,
  quantity: 3,
}));
registry.register({ key: "ebay", publish: mock.fn(), update: updateSpy, end: mock.fn() });

const { syncListing } = require("./sync.service");

test("sync_listing fencing: a stale seq is dropped before the adapter is ever called; a fresh seq applies normally", async (t) => {
  await mongoose.connect(config.mongoUri);

  const Product = require("../../models/Product");
  const MarketplaceListing = require("../../models/MarketplaceListing");
  const { MARKETPLACE_PLATFORM, LISTING_STATE } = require("../../constants/marketplace.constants");

  const suffix = crypto.randomUUID();
  const tenantId = new mongoose.Types.ObjectId();

  const product = await Product.create({
    tenant_id: tenantId,
    title: `Sync fencing test ${suffix}`,
    slug: `sync-fencing-test-${suffix}`,
    sku: `FENCE2-${suffix}`,
    status: "active",
  });

  const listing = await MarketplaceListing.create({
    tenant_id: tenantId,
    product: product._id,
    variant: null,
    platform: MARKETPLACE_PLATFORM.EBAY,
    state: LISTING_STATE.ACTIVE,
    external_listing_id: `L-${suffix}`,
    external_offer_id: `O-${suffix}`,
    condition: "NEW",
    last_pushed_seq: 5,
  });

  // Actually delete what THIS test created — not soft-delete (which would
  // still leave external_listing_id/external_offer_id sitting there,
  // exactly the collision this whole fix is about) — a hard delete, same
  // as the model's own unique index treats "really gone" for that purpose.
  // One combined `t.after` (delete THEN disconnect, explicitly sequenced)
  // rather than two separate hooks — Node's test runner doesn't document an
  // ordering guarantee across multiple `t.after` calls on the same test
  // worth relying on.
  t.after(async () => {
    await MarketplaceListing.deleteOne({ _id: listing._id });
    await Product.deleteOne({ _id: product._id });
    await mongoose.disconnect();
  });

  const callsBefore = updateSpy.mock.callCount();

  const staleResult = await syncListing(listing._id.toString(), 3);
  assert.deepEqual(staleResult, { skipped: true, reason: "stale_seq" });
  assert.equal(updateSpy.mock.callCount(), callsBefore, "a stale-seq job must never call the adapter at all");

  const freshResult = await syncListing(listing._id.toString(), 6);
  assert.equal(freshResult.ok, true);
  assert.equal(updateSpy.mock.callCount(), callsBefore + 1, "a fresh-seq job must call the adapter");
});
