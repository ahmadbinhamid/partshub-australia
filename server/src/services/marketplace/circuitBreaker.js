// services/marketplace/circuitBreaker.js
//
// Per-tenant, per-platform circuit breaker backed by ChannelConnection
// (consecutive_failures/status/last_success_at — see models/ChannelConnection.js).
// Used by sync.service.js around every adapter call.
//
// NOTE on scope: the task this was built from describes tripping the
// breaker as "pause that platform's queue". Taken literally (Bull's
// queue.pause()) that would stop EVERY tenant's jobs on that platform's
// shared Bull queue — one tenant's broken eBay credentials would silently
// stall every other tenant's eBay sync too, which is a much worse outage
// than the one this breaker exists to contain. Implemented instead as a
// per-(tenant, platform) gate that sync.service.js checks before calling
// the adapter — isOpen() below — which gets the intended effect (stop
// hammering a connection that's confirmed broken) without the cross-tenant
// blast radius. See server/docs/channel-architecture.md.

const ChannelConnection = require("../../models/ChannelConnection");
const { logger } = require("../../loaders/logging");
const config = require("../../config");
const { CHANNEL_CONNECTION_STATUS } = require("../../constants/channel.constants");

// Only transport/auth-level failures count toward the breaker — a 5xx, a
// network/timeout/DNS error (no HTTP status at all), or 401/403. Per-item
// validation failures (400-level: bad category, missing GTIN, etc.) are
// product data problems, not evidence the connection itself is unhealthy,
// and must never trip the breaker. Duck-typed on `.status`/`.statusCode`
// rather than importing any platform-specific error class, so this stays
// usable by every adapter, not just eBay's EbayApiError.
function isTransportOrAuthFailure(err) {
  const status = err?.status ?? err?.statusCode;
  if (status != null) return status >= 500 || status === 401 || status === 403;
  // No HTTP status at all — a thrown network/timeout/programming error, not
  // a well-formed API rejection. Treated as transport-level: an adapter that
  // can't even complete a request is at least as concerning as one getting
  // 5xx responses back.
  return true;
}

async function recordSuccess(tenantId, platform) {
  await ChannelConnection.updateOne(
    { tenant_id: tenantId, platform },
    {
      $set: { consecutive_failures: 0, last_success_at: new Date(), status: CHANNEL_CONNECTION_STATUS.CONNECTED, last_error: null },
    },
  );
}

// Returns { tripped } so callers can log/act on the transition specifically,
// not just the fact that a failure happened.
// upsert: true here relies on the adapter's own loadSettings (called
// earlier in the SAME sync.service.js#syncListing invocation, before this
// can ever be reached) having already migrated/created a fully-populated
// ChannelConnection row — see ebay.settings.service.js's lazy read-through.
// A future adapter that calls recordFailure without resolving settings
// through an equivalent migration path first would get a bare row here
// (tenant_id/platform/consecutive_failures only), and ensureMigrated would
// then see "a row already exists" and skip populating the rest — keep
// settings resolution ahead of failure recording for any new adapter.
async function recordFailure(tenantId, platform, err) {
  if (!isTransportOrAuthFailure(err)) return { tripped: false, counted: false };

  const threshold = config.channels.circuitBreakerThreshold;
  const updated = await ChannelConnection.findOneAndUpdate(
    { tenant_id: tenantId, platform },
    { $inc: { consecutive_failures: 1 }, $set: { last_error: err.message } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  const failures = updated?.consecutive_failures ?? 0;
  if (failures < threshold) return { tripped: false, counted: true };

  if (updated.status !== CHANNEL_CONNECTION_STATUS.DEGRADED) {
    await ChannelConnection.updateOne(
      { tenant_id: tenantId, platform },
      { $set: { status: CHANNEL_CONNECTION_STATUS.DEGRADED, last_error: err.message } },
    );
    logger.error(`[circuitBreaker] ${platform}/${tenantId}: tripped after ${failures} consecutive transport/auth failures — pausing sync for this tenant`);
  }
  return { tripped: true, counted: true };
}

async function isOpen(tenantId, platform) {
  const conn = await ChannelConnection.findOne({ tenant_id: tenantId, platform }).select("status").lean();
  return conn?.status === CHANNEL_CONNECTION_STATUS.DEGRADED;
}

// Explicit resume path — used by the reconnect/manual-sync flow (see
// channel.controller.js#retry and a fresh successful OAuth reconnect) to
// clear a tripped breaker rather than waiting for it to self-heal.
async function resume(tenantId, platform) {
  await ChannelConnection.updateOne(
    { tenant_id: tenantId, platform },
    { $set: { status: CHANNEL_CONNECTION_STATUS.CONNECTED, consecutive_failures: 0, last_error: null } },
  );
  logger.info(`[circuitBreaker] ${platform}/${tenantId}: resumed`);
}

module.exports = { isTransportOrAuthFailure, recordSuccess, recordFailure, isOpen, resume };
