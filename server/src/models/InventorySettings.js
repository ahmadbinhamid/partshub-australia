// models/InventorySettings.js

const { model, Schema } = require("mongoose");
const { buildSchema } = require("./base.model");

const inventorySettingsSchema = buildSchema(
  {
    // Was a single global singleton (`key: "global"`, unique-indexed) shared
    // by every tenant — one tenant changing low_stock_threshold (or any
    // other field here) silently changed it for every other tenant too,
    // since there was only ever one document in this collection. Replaced
    // with one document per tenant, same upsert-on-first-access pattern.
    // Found live, the moment a second real tenant existed.
    tenant_id: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, unique: true },

    low_stock_threshold: { type: Number, default: 10 },
    email_notifications: { type: Boolean, default: false },
    notification_email: { type: String, default: null },
    // "HH:MM", UTC — the frontend enters/displays this in Australia/Sydney
    // local time and converts at the load/save boundary (src/utils/timezone.ts
    // on the frontend). No per-tenant timezone field exists anywhere in this
    // single-market app, so Sydney is a hardcoded assumption, not read from
    // here — this field itself carries no timezone info, it's UTC by
    // convention only.
    notification_send_time: { type: String, default: "09:00" },
    // Dedup for the low-stock digest sweep (services/inventory-digest.service.js)
    // — set once per UTC calendar day a digest actually resolves (sent OR
    // correctly determined to have zero low-stock items), so a tenant is
    // never checked more than once per day regardless of how often the sweep
    // itself runs.
    last_digest_sent_at: { type: Date, default: null },
  },
  { softDelete: false },
);

inventorySettingsSchema.statics.getOrCreate = async function (tenantId) {
  // findOneAndUpdate with upsert is atomic — no race condition
  return this.findOneAndUpdate(
    { tenant_id: tenantId },
    { $setOnInsert: { tenant_id: tenantId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

module.exports = model("InventorySettings", inventorySettingsSchema);
