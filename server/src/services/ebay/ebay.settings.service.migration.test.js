// services/ebay/ebay.settings.service.migration.test.js
//
// Regression guard for Task 2's lazy read-through: getSettings() migrates a
// legacy EbaySettings row into ChannelConnection on first read, returns the
// exact same shape either way, and concurrent calls for the same
// never-yet-migrated tenant never create duplicate ChannelConnection docs
// (race-safe via the unique {tenant_id, platform} index + findOneAndUpdate
// upsert + re-read on a duplicate-key error — see
// ebay.settings.service.js#migrateFromLegacy).
//
// Needs a live Mongo connection — run with:
//   node --test src/services/ebay/ebay.settings.service.migration.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../config");

require("../../models/index");
const EbaySettings = require("../../models/EbaySettings");
const ChannelConnection = require("../../models/ChannelConnection");
const { encrypt } = require("../../utils/crypto/tokenCipher");
const svc = require("./ebay.settings.service");

test("lazy EbaySettings -> ChannelConnection read-through: identical shape, idempotent under concurrency", async (t) => {
  await mongoose.connect(config.mongoUri);

  const suffix = crypto.randomUUID();
  const tenantId = new mongoose.Types.ObjectId();
  const { ciphertext, iv, tag } = encrypt(`token-${suffix}`);

  await EbaySettings.create({
    tenant_id: tenantId,
    refresh_token_ciphertext: ciphertext,
    refresh_token_iv: iv,
    refresh_token_tag: tag,
    connection_status: "connected",
    connected_at: new Date(),
    marketplace_id: "EBAY_GB",
    sandbox: true,
    fulfillment_policy_id: `FUL-${suffix}`,
    warehouse_city: "London",
    // EbaySettings.webhook_token is unique+sparse — sparse only excludes a
    // field that's entirely ABSENT, not one present with value null, so two
    // rows both defaulting to null (any tenant that's never called
    // ensureWebhookToken) collide. Explicit here so this test never depends
    // on being the only such row in a shared dev database (confirmed live
    // while writing this test).
    webhook_token: `wt-${suffix}`,
  });

  assert.equal(await ChannelConnection.findOne({ tenant_id: tenantId }).lean(), null, "no ChannelConnection yet");

  // 10 concurrent reads for a tenant with no ChannelConnection row yet —
  // must never create duplicates, and every one must resolve to the
  // identical shape.
  const results = await Promise.all(Array.from({ length: 10 }, () => svc.getSettings(tenantId)));

  for (const settings of results) {
    assert.equal(settings.marketplace_id, "EBAY_GB");
    assert.equal(settings.warehouse_city, "London");
    assert.equal(settings.fulfillment_policy_id, `FUL-${suffix}`);
    assert.equal(settings.refresh_token, `token-${suffix}`);
    assert.equal(settings.connection_status, "connected");
  }

  const conns = await ChannelConnection.find({ tenant_id: tenantId }).lean();
  assert.equal(conns.length, 1, "exactly one ChannelConnection must exist after concurrent lazy migration");

  await EbaySettings.deleteMany({ tenant_id: tenantId });
  await ChannelConnection.deleteMany({ tenant_id: tenantId });
  await mongoose.disconnect();
});

test("a legacy row with a null/empty refresh token migrates as disconnected, never connected", async (t) => {
  await mongoose.connect(config.mongoUri);

  const tenantId = new mongoose.Types.ObjectId();
  await EbaySettings.create({
    tenant_id: tenantId,
    connection_status: "not_connected",
    // See the other test's comment above on why this can't be left at its
    // null default.
    webhook_token: `wt-${crypto.randomUUID()}`,
  });

  const settings = await svc.getSettings(tenantId);
  assert.equal(settings.connection_status, "not_connected");
  assert.equal(settings.refresh_token, null);

  const conn = await ChannelConnection.findOne({ tenant_id: tenantId }).lean();
  assert.equal(conn.status, "disconnected");

  await EbaySettings.deleteMany({ tenant_id: tenantId });
  await ChannelConnection.deleteMany({ tenant_id: tenantId });
  await mongoose.disconnect();
});
