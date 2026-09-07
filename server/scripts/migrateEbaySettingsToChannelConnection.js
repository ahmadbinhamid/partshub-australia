// scripts/migrateEbaySettingsToChannelConnection.js
//
// Bulk-migrates every tenant's EbaySettings row into ChannelConnection (see
// services/ebay/ebay.settings.service.js for the lazy per-tenant read-through
// this duplicates in bulk, and server/docs/channel-architecture.md for the
// overall migration strategy/deploy order).
//
// Idempotent: a tenant that already has a ChannelConnection row for
// platform "ebay" is skipped entirely, never overwritten — running this
// script twice (or running it after the lazy path has already migrated some
// tenants on its own) is always safe.
//
// Usage:
//   node scripts/migrateEbaySettingsToChannelConnection.js [--dry-run] [--tenant=<tenantId>]
//
//   --dry-run          Print what would be migrated; writes nothing.
//   --tenant=<id>       Only migrate this one tenant.
//
// run({ dryRun, tenantId }) is exported (mongoose connect/disconnect left to
// the caller) so scripts/migrateEbaySettingsToChannelConnection.test.js can
// exercise it directly against a live test connection, instead of shelling
// out to this file as a subprocess.

const EbaySettings = require("../src/models/EbaySettings");
const ChannelConnection = require("../src/models/ChannelConnection");
const { fieldsFromLegacy, migrateFromLegacy } = require("../src/services/ebay/ebay.settings.service");
const { MARKETPLACE_PLATFORM } = require("../src/constants/marketplace.constants");

const PLATFORM = MARKETPLACE_PLATFORM.EBAY;

async function run({ dryRun = false, tenantId = null, log = console.log, logError = console.error } = {}) {
  const query = tenantId ? { tenant_id: tenantId } : {};
  const legacyDocs = await EbaySettings.find(query)
    .select("+refresh_token_ciphertext +refresh_token_iv +refresh_token_tag")
    .lean();

  if (!legacyDocs.length) {
    log(tenantId ? `No EbaySettings row found for tenant ${tenantId}` : "No EbaySettings rows found — nothing to migrate");
    return { migrated: 0, skipped: 0, errored: 0 };
  }

  log(`Found ${legacyDocs.length} EbaySettings row(s) to consider`);

  let migrated = 0;
  let skipped = 0;
  let errored = 0;

  for (const legacy of legacyDocs) {
    const rowTenantId = legacy.tenant_id;
    try {
      const existing = await ChannelConnection.findOne({ tenant_id: rowTenantId, platform: PLATFORM }).select("_id").lean();
      if (existing) {
        log(`  [SKIP] tenant ${rowTenantId}: ChannelConnection already exists`);
        skipped++;
        continue;
      }

      const fields = fieldsFromLegacy(legacy);
      if (dryRun) {
        log(`  [DRY RUN] would create ChannelConnection for tenant ${rowTenantId}: status=${fields.status}, marketplace_id=${fields.marketplace_id}`);
        migrated++;
        continue;
      }

      // migrateFromLegacy re-reads EbaySettings itself and upserts with
      // $setOnInsert (race-safe — see its own comment), same idempotent path
      // the lazy per-tenant read-through uses. Re-reading here instead of
      // inserting `fields` directly keeps this script and the lazy path
      // provably doing the exact same thing, not two implementations that
      // could drift.
      const conn = await migrateFromLegacy(rowTenantId);
      if (!conn) {
        log(`  [SKIP] tenant ${rowTenantId}: no longer has an EbaySettings row (raced with a delete?)`);
        skipped++;
        continue;
      }
      log(`  [OK] tenant ${rowTenantId}: migrated (status=${conn.status})`);
      migrated++;
    } catch (err) {
      logError(`  [ERROR] tenant ${rowTenantId}: ${err.message}`);
      errored++;
    }
  }

  log(`\nDone — ${migrated} ${dryRun ? "would be migrated" : "migrated"}, ${skipped} skipped (already migrated), ${errored} errored.`);
  return { migrated, skipped, errored };
}

module.exports = { run };

if (require.main === module) {
  require("dotenv").config();
  const mongoose = require("mongoose");
  const config = require("../src/config");
  require("../src/models/index"); // register all schemas

  const dryRun = process.argv.includes("--dry-run");
  const tenantArg = process.argv.find((a) => a.startsWith("--tenant="));
  const tenantId = tenantArg ? tenantArg.split("=")[1] : null;

  (async () => {
    await mongoose.connect(config.mongoUri);
    console.log(`Connected to MongoDB${dryRun ? " (--dry-run: no writes will be made)" : ""}`);
    await run({ dryRun, tenantId });
    await mongoose.disconnect();
  })().catch((err) => {
    console.error("migrateEbaySettingsToChannelConnection failed:", err);
    process.exit(1);
  });
}
