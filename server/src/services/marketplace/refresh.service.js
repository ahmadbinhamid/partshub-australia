// services/marketplace/refresh.service.js
//
// Some channels (Google Merchant Center among them) silently expire a
// product that isn't refreshed within a regular cadence — Google's own
// docs: "you should update or refresh them with a regular cadence (at least
// every 30 days)". Our own sync only fires on a stock change or at connect
// time, and most auto parts have stable stock — so a listing that never
// changes quietly drops off the channel after 30 days, with no error, no
// log, and nothing surfaced in the UI. This sweep closes that gap by
// periodically finding any listing whose `synced_at` has gone stale (per
// the adapter's own declared `refreshIntervalDays` — see registry.js's
// interface comment) and re-pushing it through the EXISTING sync_batch
// path (sync.service.js#syncBatch), rather than any new push mechanism —
// so it inherits that path's chunking, fencing, circuit breaker, and
// ChannelSyncLog behavior for free.
//
// Wired as a repeatable job (`refresh_stale`) in workers/channel.worker.js,
// attached ONLY for an adapter that declares refreshIntervalDays — see that
// file's own comment. eBay's adapter never sets this field, so eBay is
// entirely unaffected: no query ever runs for it, no schedule is ever
// registered for it.

const { logger } = require("../../loaders/logging");
const MarketplaceListing = require("../../models/MarketplaceListing");
const ChannelConnection = require("../../models/ChannelConnection");
const config = require("../../config");
const registry = require("./registry");
// Accessed via the module object (registry.getAdapter / channelQueue.
// enqueueChannelJob), not destructured, so a test can mock.method() either
// one — mock.method only intercepts a property read at CALL time, and a
// destructured `const { fn } = require(...)` captures the original
// reference before any mock is installed (same caveat documented in
// channel.worker.midflight.test.js).
const channelQueue = require("../../queues/channel.queue");
const circuitBreaker = require("./circuitBreaker");
const { LISTING_STATE } = require("../../constants/marketplace.constants");

// Re-pushes every stale listing for every usable tenant connected to
// `platformKey`. Returns a small summary object; never throws for an
// individual tenant's own trouble (a bad tenant must not abort the sweep
// for every other tenant on the same platform) — see sweepTenant's own
// try/catch.
async function sweepStaleListings(platformKey) {
  // NOTE: checked FIRST, before even resolving the adapter — the kill
  // switch must short-circuit the sweep as completely and cheaply as
  // possible (no query, no adapter lookup) so it's a genuine "do nothing"
  // escape hatch, not just a skip buried after other work has already run.
  if (!config.channels.refreshSweepEnabled) {
    logger.info(`[refresh.service] refresh sweep disabled via CHANNEL_REFRESH_SWEEP_ENABLED — skipping ${platformKey}`);
    return { skipped: true, reason: "sweep_disabled" };
  }

  const adapter = registry.getAdapter(platformKey);

  // NOTE: absent/null is opt-out, not "refresh immediately". A platform
  // that never declares refreshIntervalDays (eBay) must never be swept —
  // treating a missing field as e.g. 0 would instead sweep EVERY listing
  // on that platform ever synced. eBay's own adapter is never edited to add
  // this field (see this file's own module header); the scheduler and this
  // service both treat "missing" as the platform's own explicit choice.
  const refreshIntervalDays = adapter.refreshIntervalDays;
  if (!refreshIntervalDays) {
    logger.info(`[refresh.service] "${platformKey}" declares no refreshIntervalDays — sweep is a no-op`);
    return { skipped: true, reason: "not_applicable" };
  }

  const staleBefore = new Date(Date.now() - refreshIntervalDays * 24 * 60 * 60 * 1000);
  const chunkSize = config.channels.batchChunkSize;

  // One ChannelConnection per (tenant, platform) — see that model's unique
  // index — so this cursor visits each connected tenant exactly once.
  // Cursor rather than a plain find(): while a platform is unlikely to have
  // as many TENANTS as any one tenant has listings, there's no reason to
  // load them all into memory either when a cursor costs nothing extra.
  const connectionCursor = ChannelConnection.find({ platform: platformKey }).select("tenant_id").lean().cursor();

  for (let conn = await connectionCursor.next(); conn != null; conn = await connectionCursor.next()) {
    try {
      await sweepTenant(platformKey, conn.tenant_id, staleBefore, chunkSize);
    } catch (err) {
      // A single tenant's own failure (a bad DB read, an unexpected
      // exception) must not abort the sweep for every other tenant on this
      // platform's queue — logged loudly, never swallowed silently.
      logger.error(`[refresh.service] ${platformKey}/${conn.tenant_id}: sweep failed: ${err.message}`);
    }
  }

  return { ok: true };
}

async function sweepTenant(platformKey, tenantId, staleBefore, chunkSize) {
  const adapter = registry.getAdapter(platformKey);

  // Reuse the EXACT "not connected" / "circuit open" determinations
  // sync.service.js#syncListing and #syncBatch already make, rather than
  // reimplementing either: `loadSettings` resolving to null IS this
  // codebase's generic-contract definition of "not connected" (see
  // registry.js); circuitBreaker.isOpen IS the definition of
  // "breaker-gated". A tenant whose connection row exists but is otherwise
  // disconnected/unconfigured is caught by whichever of these the adapter
  // itself actually checks — the same as every other sync path in this app.
  const settings = typeof adapter.loadSettings === "function" ? await adapter.loadSettings(tenantId) : null;
  if (settings === null) {
    logger.info(`[refresh.service] ${platformKey}/${tenantId}: not connected — skipping sweep`);
    return;
  }

  if (await circuitBreaker.isOpen(tenantId, platformKey)) {
    logger.info(`[refresh.service] ${platformKey}/${tenantId}: circuit open — skipping sweep`);
    return;
  }

  // NOTE: `synced_at: null` means "never successfully pushed" — that
  // listing is unpublished, not stale, and belongs to the normal publish
  // path (syncListing / syncBatch's own full-catalogue pass), not this
  // sweep. It is NOT enough to just never explicitly select null — MongoDB's
  // BSON type ordering places Null BELOW Date, so a bare `{ $lt: staleBefore
  // }` on a Date field actually MATCHES `null` (null sorts as "less than"
  // any Date). `$ne: null` is required alongside `$lt` to correctly exclude
  // it — verified against this exact gotcha while writing this, not assumed.
  const cursor = MarketplaceListing.find({
    tenant_id: tenantId,
    platform: platformKey,
    state: LISTING_STATE.ACTIVE,
    synced_at: { $ne: null, $lt: staleBefore },
  })
    .select("_id")
    .lean()
    .cursor();

  let staleCount = 0;
  let jobsEnqueued = 0;
  let chunk = [];

  const flush = async () => {
    if (!chunk.length) return;
    // Dispatched through the EXISTING sync_batch job type/processor (see
    // channel.worker.js#attachSyncBatchProcessor and
    // sync.service.js#syncBatch's new `listingIds` opt) — not a new job
    // type of its own — so a refresh re-push gets that path's existing
    // chunking-internal fencing re-check, circuit breaker wiring, and
    // ChannelSyncLog rows for free, instead of a second parallel
    // implementation of all of that. "sync_batch" never matches
    // channel.queue.js's debounce condition (keyed to the literal string
    // "sync_listing" — verified, not assumed, while wiring this), so this
    // is unaffected by the sync_listing debounce jobId logic.
    await channelQueue.enqueueChannelJob(platformKey, "sync_batch", { tenantId, listingIds: chunk });
    jobsEnqueued++;
    chunk = [];
  };

  for (let listing = await cursor.next(); listing != null; listing = await cursor.next()) {
    staleCount++;
    chunk.push(listing._id);
    if (chunk.length >= chunkSize) await flush();
  }
  await flush();

  // The only visibility anyone gets into whether this job is doing
  // anything — one line per tenant, always logged (not gated behind
  // config.channels.logSuccesses, which only governs per-listing
  // ChannelSyncLog rows, not this summary).
  logger.info(
    `[refresh.service] ${platformKey}/${tenantId}: ${staleCount} stale listing(s) found, ${jobsEnqueued} sync_batch job(s) enqueued`,
  );
}

module.exports = { sweepStaleListings };
