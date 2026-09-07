// models/ChannelSyncLog.js
//
// Append-only audit trail for channel adapter jobs (publish/update/end/
// inventory push, etc.) — written from services/marketplace/sync.service.js.
// Failures are always logged in full; successes only when
// config.channels.logSuccesses is set, since a full catalogue sync can be
// thousands of listings and most of those rows would never be read.
//
// TTL index on created_at — rows older than config.channels.syncLogTtlDays
// are dropped automatically by Mongo's background TTL monitor, so this
// collection doesn't grow unbounded.

const { Schema } = require("mongoose");
const { buildSchema } = require("./base.model");
const config = require("../config");
const { CHANNEL_SYNC_LOG_STATUS } = require("../constants/channel.constants");

const channelSyncLogSchema = buildSchema(
  {
    tenant_id: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    platform: { type: String, required: true },
    job_type: { type: String, required: true },
    entity_type: { type: String, default: null },
    entity_id: { type: Schema.Types.ObjectId, default: null },

    status: {
      type: String,
      enum: Object.values(CHANNEL_SYNC_LOG_STATUS),
      required: true,
    },
    attempt: { type: Number, default: 1 },
    error_code: { type: String, default: null },
    error_message: { type: String, default: null },
    // Small, non-sensitive snapshot of the request/response for debugging —
    // never the raw payload (which can carry tenant credentials/PII).
    request_summary: { type: Schema.Types.Mixed, default: null },
    duration_ms: { type: Number, default: null },
  },
  { softDelete: false },
);

channelSyncLogSchema.index({ tenant_id: 1, platform: 1, created_at: -1 });
// expireAfterSeconds must be a fixed number at index-creation time — Mongo
// doesn't support reading it from an env var at query time, so a changed
// config.channels.syncLogTtlDays only takes effect for a NEW index (drop +
// recreate), not retroactively for an already-created one.
channelSyncLogSchema.index(
  { created_at: 1 },
  { expireAfterSeconds: config.channels.syncLogTtlDays * 24 * 60 * 60, background: true },
);

module.exports = require("mongoose").model("ChannelSyncLog", channelSyncLogSchema);
