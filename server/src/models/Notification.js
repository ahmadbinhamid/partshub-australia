// models/Notification.js
//
// One document per (event, recipient) — not one shared doc with a
// recipients array — so per-user read state is a plain field. See
// services/notification.service.js for who gets notified and when.

const { model, Schema } = require("mongoose");
const { buildSchema } = require("./base.model");

const notificationSchema = buildSchema({
  tenant_id: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
  user_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
  // "order.new" today — other event types can reuse this same model/shape
  // later without a schema change.
  type: { type: String, required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: { type: Schema.Types.Mixed, default: {} },
  read_at: { type: Date, default: null },
});

notificationSchema.index({ user_id: 1, created_at: -1 });
notificationSchema.index({ user_id: 1, read_at: 1 });

module.exports = model("Notification", notificationSchema);
