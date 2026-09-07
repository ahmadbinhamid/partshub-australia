// models/ChannelConnection.js
//
// Channel-agnostic replacement for EbaySettings — one record per
// (tenant, platform), discriminated by `platform` the same way
// MarketplaceListing is. See server/docs/channel-architecture.md for the
// migration strategy (lazy read-through from EbaySettings, see
// services/ebay/ebay.settings.service.js) and why EbaySettings itself is
// left in place, untouched, as the legacy source during the transition.
//
// discriminatorKey not forwarded by buildSchema (see MarketplaceListing.js's
// own note on this) — built directly with `new Schema` for the same reason.

const { model, Schema } = require("mongoose");
const softDeletePlugin = require("./plugins/softDelete.plugin");
const { stripInternalFields } = require("./base.model");
const { CHANNEL_CONNECTION_STATUS } = require("../constants/channel.constants");
const { MARKETPLACE_PLATFORM } = require("../constants/marketplace.constants");

const baseSchema = new Schema(
  {
    tenant_id: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    platform: { type: String, required: true },

    status: {
      type: String,
      enum: Object.values(CHANNEL_CONNECTION_STATUS),
      default: CHANNEL_CONNECTION_STATUS.DISCONNECTED,
    },

    // Platform-side account identifier (eBay has none today — resolved via
    // the refresh token itself — but Google Merchant Center / Meta Shop
    // both need one; kept generic and unused by eBay for now).
    external_account_id: { type: String, default: null },

    // Generic encrypted-credential slots — see utils/crypto/tokenCipher.js.
    // A single string per token (not the {ciphertext, iv, tag} triple
    // tokenCipher.encrypt() returns) so this stays one shared shape across
    // every future platform's cipher output; each consumer packs/unpacks its
    // own triple into this string (see
    // ebay.settings.service.js#packCiphertext/unpackCiphertext) rather than
    // widening this schema per-platform.
    access_token_ct: { type: String, default: null, select: false },
    refresh_token_ct: { type: String, default: null, select: false },
    token_expires_at: { type: Date, default: null },

    // Opaque, unguessable identifier embedded in a shared inbound-webhook
    // URL's query string in place of this tenant's real _id — see
    // EbaySettings.webhook_token's original comment. Globally unique (not
    // just per tenant+platform): the URL carries no tenant id of its own, so
    // this is the ONLY lookup key an inbound webhook delivery can be
    // resolved by.
    webhook_token: { type: String, default: null },

    connected_at: { type: Date, default: null },
    last_error: { type: String, default: null },

    // Circuit breaker (see queues/channel.queue.js / services/marketplace/
    // circuitBreaker.js) — only transport/auth-level failures (5xx, network,
    // 401/403) increment this; per-item validation failures (400s, bad
    // category, missing GTIN) never do, since those are product-data
    // problems, not evidence the connection itself is unhealthy.
    consecutive_failures: { type: Number, default: 0 },
    last_success_at: { type: Date, default: null },
    // Set when an operator (or the breaker itself) has paused this
    // platform's queue for this tenant; cleared by the explicit resume path.
    disabled_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    discriminatorKey: "platform",
  },
);

baseSchema.plugin(softDeletePlugin);
baseSchema.set("toJSON", { transform: stripInternalFields });
baseSchema.set("toObject", { transform: stripInternalFields });

baseSchema.index({ tenant_id: 1, platform: 1 }, { unique: true });
// See webhook_token's own comment above — must be globally unique, but only
// while it actually holds a real token. `sparse: true` does NOT achieve
// that here: sparse only excludes documents where the field is entirely
// ABSENT, but every ChannelConnection has webhook_token explicitly set to
// `null` (present, not absent — the schema default, applied on every
// insert), so a plain sparse+unique index still collides every
// never-subscribed connection against every other one (confirmed live
// while writing this — see MarketplaceListing.js's external_listing_id/
// external_offer_id indexes, fixed the same way for the identical reason).
// partialFilterExpression actually tests the VALUE, not just presence, and
// correctly excludes null.
baseSchema.index(
  { webhook_token: 1 },
  { unique: true, partialFilterExpression: { webhook_token: { $type: "string" } } },
);

const ChannelConnection = model("ChannelConnection", baseSchema);

// ── eBay discriminator ───────────────────────────────────────────────────────
//
// Carries every field EbaySettings.js holds that's eBay-specific — see that
// file's own comments for what each one is for. Faithfully ported, not
// renamed, so ebay.settings.service.js's translation layer (see
// toLegacyShape) is a straight field-for-field mapping.

const ebaySchema = new Schema({
  marketplace_id: { type: String, default: "EBAY_AU" },
  sandbox: { type: Boolean, default: false },

  merchant_location_key: { type: String, default: null },
  fulfillment_policy_id: { type: String, default: null },
  payment_policy_id: { type: String, default: null },
  return_policy_id: { type: String, default: null },

  warehouse_street: { type: String, default: null },
  warehouse_city: { type: String, default: null },
  warehouse_state: { type: String, default: null },
  warehouse_postcode: { type: String, default: null },
  warehouse_country: { type: String, default: "AU" },
  warehouse_phone: { type: String, default: null },

  fallback_image_url: { type: String, default: null },

  // The HMAC secret eBay's webhook deliveries are signed with — distinct
  // from the generic base `webhook_token` (the opaque id in the callback
  // URL). See EbaySettings.verification_token's original comment.
  verification_token: { type: String, default: null },
});

// Mongoose registers every discriminator as its own compiled model under
// the NAME given here, in the same global registry as every other model —
// NOT scoped to this base model. MarketplaceListing already registers a
// discriminator literally named "ebay" (see MarketplaceListing.js) for its
// own eBay-specific listing fields; reusing that same name here would throw
// OverwriteModelError the second time this file loads (confirmed while
// writing this — see git history for the exact error).
// `discriminator(name, schema, value)`'s 3rd argument decouples the
// registered model NAME from the VALUE actually stored in the
// discriminatorKey (`platform`) field, so this still discriminates on
// platform: "ebay" — MARKETPLACE_PLATFORM.EBAY, matching every query
// elsewhere in this codebase — while registering under a name that can't
// collide with MarketplaceListing's own "ebay" discriminator.
ChannelConnection.discriminator("ChannelConnectionEbay", ebaySchema, MARKETPLACE_PLATFORM.EBAY);

// ── Google (Merchant API) discriminator ──────────────────────────────────────

const googleSchema = new Schema({
  merchant_id: { type: String, default: null },
  data_source_id: { type: String, default: null },
  feed_label: { type: String, default: null },
  content_language: { type: String, default: null },
  target_country: { type: String, default: null },
});

// Same naming-collision reason as the eBay discriminator above — and the
// same collision would happen against MarketplaceListing's OWN "google"
// discriminator (see models/MarketplaceListing.js) if this were registered
// under the bare name "google", exactly like "ebay" collided there.
// Registered as "ChannelConnectionGoogle" (model name) while still
// discriminating on platform: "google" (MARKETPLACE_PLATFORM.GOOGLE, the 3rd
// argument) — every query elsewhere (`{ platform: "google" }`) is unaffected.
ChannelConnection.discriminator("ChannelConnectionGoogle", googleSchema, MARKETPLACE_PLATFORM.GOOGLE);

module.exports = ChannelConnection;
