// services/ebay/ebay.settings.migration-script.test.js
//
// Regression guard for scripts/migrateEbaySettingsToChannelConnection.js:
// --dry-run writes nothing, and a real run is idempotent (a second run
// skips a tenant it already migrated, never overwriting it). Requires the
// script's `run()` directly (mongoose connect/disconnect handled here, same
// as this script's own CLI entry point does) rather than shelling out to it
// as a subprocess.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/ebay/ebay.settings.migration-script.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../config");

require("../../models/index");
const EbaySettings = require("../../models/EbaySettings");
const ChannelConnection = require("../../models/ChannelConnection");
const { encrypt } = require("../../utils/crypto/tokenCipher");
const { run } = require("../../../scripts/migrateEbaySettingsToChannelConnection");

const noop = () => {};

test("migrateEbaySettingsToChannelConnection: --dry-run writes nothing, a real run is idempotent", async (t) => {
  await mongoose.connect(config.mongoUri);

  const suffix = crypto.randomUUID();
  const tenantId = new mongoose.Types.ObjectId();
  const { ciphertext, iv, tag } = encrypt(`script-token-${suffix}`);

  await EbaySettings.create({
    tenant_id: tenantId,
    refresh_token_ciphertext: ciphertext,
    refresh_token_iv: iv,
    refresh_token_tag: tag,
    connection_status: "connected",
    marketplace_id: "EBAY_AU",
    // EbaySettings.webhook_token is unique+sparse — sparse only excludes a
    // field that's entirely ABSENT, not one present with value null, so two
    // rows both defaulting to null (any tenant that's never called
    // ensureWebhookToken) collide. Explicit here so this test never depends
    // on being the only such row in a shared dev database (confirmed live
    // while writing this test).
    webhook_token: `wt-${suffix}`,
  });

  const dryRunResult = await run({ dryRun: true, tenantId: tenantId.toString(), log: noop, logError: noop });
  assert.equal(dryRunResult.migrated, 1, "dry run must report 1 tenant it would migrate");
  assert.equal(
    await ChannelConnection.findOne({ tenant_id: tenantId }).lean(),
    null,
    "--dry-run must not create a ChannelConnection document",
  );

  const realRunResult = await run({ dryRun: false, tenantId: tenantId.toString(), log: noop, logError: noop });
  assert.equal(realRunResult.migrated, 1);
  const conns = await ChannelConnection.find({ tenant_id: tenantId }).lean();
  assert.equal(conns.length, 1, "exactly one ChannelConnection must be created");

  const secondRunResult = await run({ dryRun: false, tenantId: tenantId.toString(), log: noop, logError: noop });
  assert.equal(secondRunResult.migrated, 0, "re-running must not re-migrate an already-migrated tenant");
  assert.equal(secondRunResult.skipped, 1, "re-running must report the tenant as skipped");
  const connsAfterRerun = await ChannelConnection.find({ tenant_id: tenantId }).lean();
  assert.equal(connsAfterRerun.length, 1, "re-running must not create a duplicate ChannelConnection document");

  await EbaySettings.deleteMany({ tenant_id: tenantId });
  await ChannelConnection.deleteMany({ tenant_id: tenantId });
  await mongoose.disconnect();
});
