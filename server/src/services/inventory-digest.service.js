// services/inventory-digest.service.js
//
// The "Inventory Settings" modal (threshold, email toggle, recipient, daily
// send time) has always saved correctly — nothing anywhere in this codebase
// ever actually read those settings and sent anything. This is that missing
// piece: sweeps every tenant's InventorySettings once per
// config.inventory.digestSweepIntervalMinutes, and sends that tenant's
// low-stock digest exactly once per UTC calendar day, at whatever wall-clock
// time (Sydney-local, converted to UTC at save time — see
// src/utils/timezone.ts on the frontend) the tenant configured.
//
// Wired as a repeatable job (`low_stock_digest_sweep`) on the shared
// emailQueue in workers/platform.worker.js — mirrors this file's own role
// against refresh.service.js's for channel.worker.js's `refresh_stale` sweep
// (a tenant-sweep service the worker calls into, never queries a model
// directly itself, per this repo's own layering convention).

const { logger } = require("../loaders/logging");
const config = require("../config");
const InventorySettings = require("../models/InventorySettings");
const inventoryService = require("./inventory.service");
const { getCompanyProfile } = require("./tenantSettings.service");
const emailService = require("./email/email.service");

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// "HH:MM" (UTC, as stored) -> minutes since UTC midnight.
function minutesOfDay(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Sweeps every tenant with email_notifications on. Never throws for an
// individual tenant's own trouble (a bad DB read, a send failure) — must
// not abort the sweep for every other tenant — see the per-tenant try/catch
// below, same shape as refresh.service.js#sweepStaleListings.
async function sweepLowStockDigests() {
  // NOTE: checked first, before any query — same "as cheap and complete an
  // escape hatch as possible" reasoning as refresh.service.js's own kill
  // switch check.
  if (!config.inventory.digestSweepEnabled) {
    logger.info("[inventory-digest.service] sweep disabled via INVENTORY_DIGEST_SWEEP_ENABLED — skipping");
    return { skipped: true, reason: "sweep_disabled" };
  }

  const now = new Date();
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = startOfUtcDay(now);

  // Cursor, not .find() into an array — workers/platform.worker.js runs
  // with a 256MB heap cap (docker-compose.yml), and this must scale with
  // tenant count regardless.
  const cursor = InventorySettings.find({ email_notifications: true }).cursor();

  const summary = { sent: 0, skipped: 0, errored: 0 };
  for (let settings = await cursor.next(); settings != null; settings = await cursor.next()) {
    try {
      const result = await maybeSendDigest(settings, nowMinutes, today);
      if (result === "sent") summary.sent++;
      else summary.skipped++;
    } catch (err) {
      summary.errored++;
      logger.error(`[inventory-digest.service] tenant ${settings.tenant_id}: digest failed: ${err.message}`, {
        stack: err.stack,
      });
    }
  }

  logger.info(
    `[inventory-digest.service] sweep complete: ${summary.sent} sent, ${summary.skipped} skipped, ${summary.errored} errored`,
  );
  return { ok: true, ...summary };
}

async function maybeSendDigest(settings, nowMinutes, today) {
  const tenantId = settings.tenant_id;

  // Dedup — never more than once per UTC calendar day, regardless of how
  // often the sweep itself runs.
  if (settings.last_digest_sent_at && settings.last_digest_sent_at >= today) {
    return "already_sent_today";
  }

  // NOTE (judgment call): no upper bound on this check — just "is it past
  // the tenant's configured time yet today". A [send_time, send_time +
  // interval) window would NOT self-heal a sweep that missed a tenant's
  // exact minute (worker restart, a slow prior tick) until the next day;
  // the dedup check above is what actually prevents a double-send, so the
  // window's upper bound wasn't adding real protection — only a footgun for
  // a delayed worker. A missed tenant just gets caught on the next
  // successful sweep run, same day.
  const sendMinutes = minutesOfDay(settings.notification_send_time);
  if (nowMinutes < sendMinutes) {
    return "not_due";
  }

  if (!settings.notification_email) {
    logger.warn(
      `[inventory-digest.service] tenant ${tenantId}: email_notifications is on but notification_email is empty — skipping`,
    );
    return "no_recipient";
  }

  const items = await inventoryService.getLowStockItems(tenantId, settings.low_stock_threshold);

  if (items.length === 0) {
    // NOTE (judgment call): still stamped as "done for today" even though
    // no email goes out — an empty "0 items low" email is noise, and NOT
    // stamping would mean re-querying a permanently-healthy tenant on
    // every single sweep tick for the rest of the day. Tradeoff: a stock
    // drop later the same day waits until tomorrow's digest — acceptable
    // for a once-daily summary feature.
    settings.last_digest_sent_at = new Date();
    await settings.save();
    return "no_low_stock";
  }

  const companyProfile = await getCompanyProfile(tenantId);
  await emailService.sendLowStockDigest({
    to: settings.notification_email,
    items,
    companyProfile,
    tenantId,
  });

  settings.last_digest_sent_at = new Date();
  await settings.save();
  return "sent";
}

module.exports = { sweepLowStockDigests, maybeSendDigest };
