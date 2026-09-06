// services/marketplace/channel.service.js
//
// DB-facing logic behind the GET /api/v1/channels* routes — see
// controllers/channel.controller.js for the thin HTTP layer on top.

const registry = require("./registry");
const ChannelConnection = require("../../models/ChannelConnection");
const ChannelSyncLog = require("../../models/ChannelSyncLog");
const MarketplaceListing = require("../../models/MarketplaceListing");
const { enqueueChannelJob } = require("../../queues/channel.queue");
const { CHANNEL_CONNECTION_STATUS } = require("../../constants/channel.constants");

function storefrontUnavailableReason(manifestName) {
  return `${manifestName} requires a verified storefront domain — connect and verify one under Settings > Domains before connecting ${manifestName}.`;
}

// TASK 5 (requiresStorefront capability): generic, platform-agnostic check
// — driven entirely by the adapter's own `manifest.requiresStorefront` flag
// (registry.js's own header documents the contract), not a Google-specific
// branch. A future Meta Shop adapter that also sets `requiresStorefront:
// true` needs ZERO new code here or at any of this function's call sites
// (listChannelsForTenant below, google.controller.js#getConnectUrl) — same
// "generic layer, platform-specific code just calls it" shape as
// circuitBreaker.js / registry.js everywhere else in this file.
async function checkStorefrontRequirement(tenantId, platform) {
  const adapter = registry.get(platform);
  if (!adapter.manifest?.requiresStorefront) return { ok: true };

  const domainService = require("../domain.service");
  const hasDomain = await domainService.hasVerifiedDefaultDomain(tenantId);
  if (hasDomain) return { ok: true };

  return { ok: false, reason: storefrontUnavailableReason(adapter.manifest.name) };
}

// Every registered adapter's manifest, merged with this tenant's own
// connection status/health/listing counts for it — the catalogue view GET
// /api/v1/channels renders (connected AND not-yet-connected platforms both
// appear, so the frontend can offer "Connect" for one the tenant hasn't set
// up yet).
async function listChannelsForTenant(tenantId) {
  const manifests = registry.list();

  // Storefront-verification is the SAME check regardless of which (if any)
  // manifest needs it, so it's resolved once for this tenant — never a
  // per-manifest query — and only actually run at all if at least one
  // registered platform sets requiresStorefront (today: Google only; eBay
  // never triggers this query).
  const anyRequiresStorefront = manifests.some((m) => m.requiresStorefront);
  const [connections, listingCounts, hasVerifiedDomain] = await Promise.all([
    ChannelConnection.find({ tenant_id: tenantId }).lean(),
    MarketplaceListing.aggregate([
      { $match: { tenant_id: tenantId } },
      { $group: { _id: { platform: "$platform", sync_status: "$sync_status" }, count: { $sum: 1 } } },
    ]),
    anyRequiresStorefront ? require("../domain.service").hasVerifiedDefaultDomain(tenantId) : Promise.resolve(true),
  ]);

  const connByPlatform = new Map(connections.map((c) => [c.platform, c]));
  const countsByPlatform = new Map();
  for (const row of listingCounts) {
    const { platform, sync_status } = row._id;
    if (!countsByPlatform.has(platform)) countsByPlatform.set(platform, {});
    countsByPlatform.get(platform)[sync_status] = row.count;
  }

  return manifests.map((manifest) => {
    const adapter = registry.get(manifest.key);
    const conn = connByPlatform.get(manifest.key) || null;

    // TASK 5: a channel a tenant can't actually use (missing storefront
    // requirement) is marked unavailable with a human-readable reason,
    // rather than letting them connect and silently get every product
    // disapproved — see checkStorefrontRequirement's own comment.
    const storefrontOk = !manifest.requiresStorefront || hasVerifiedDomain;

    return {
      ...manifest,
      capabilities: adapter.capabilities,
      available: storefrontOk,
      unavailable_reason: storefrontOk ? null : storefrontUnavailableReason(manifest.name),
      connection: {
        status: conn?.status || CHANNEL_CONNECTION_STATUS.DISCONNECTED,
        connected_at: conn?.connected_at || null,
        last_error: conn?.last_error || null,
      },
      health: {
        consecutive_failures: conn?.consecutive_failures || 0,
        last_success_at: conn?.last_success_at || null,
      },
      listing_counts: countsByPlatform.get(manifest.key) || {},
    };
  });
}

async function getChannelLogs(tenantId, platform, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    ChannelSyncLog.find({ tenant_id: tenantId, platform }).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    ChannelSyncLog.countDocuments({ tenant_id: tenantId, platform }),
  ]);

  return { items, total, page, pageSize: limit, totalPages: Math.ceil(total / limit) };
}

// Re-enqueues the listing behind a failed (or skipped) log row — a fresh
// sync_listing job with no fencing seq (null), same as an explicit manual
// "resync this listing" action elsewhere in this codebase, so it always
// applies rather than being dropped by the seq fence.
//
// bypassDebounce: true — a manual retry must always actually enqueue a job.
// The debounced jobId (`sync:<platform>:<listingId>`) may currently be
// occupied by the very failed job this retry exists to recover from, or by
// an unrelated in-flight debounced job for the same listing; either way
// this needs its own fresh, immediate job rather than folding into (or
// being silently dropped by) whatever's already sitting under that id.
async function retryChannelLog(tenantId, platform, logId) {
  const log = await ChannelSyncLog.findOne({ _id: logId, tenant_id: tenantId, platform }).lean();
  if (!log) return null;
  if (!log.entity_id || log.entity_type !== "MarketplaceListing") {
    const err = new Error("This log entry has no associated listing to retry");
    err.status = 400;
    throw err;
  }

  await enqueueChannelJob(platform, "sync_listing", { listingId: log.entity_id.toString(), seq: null }, { bypassDebounce: true });
  return { requeued: true, listingId: log.entity_id.toString() };
}

module.exports = { listChannelsForTenant, getChannelLogs, retryChannelLog, checkStorefrontRequirement };
