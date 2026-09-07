// services/ebay/ebay.settings.service.js
//
// Public contract (every exported function's shape/return value) is
// UNCHANGED from the pre-ChannelConnection version — every consumer
// (ebay.api.service.js, ebay.adapter.js, sync.service.js, controllers, ...)
// keeps reading/writing the exact same plain object shape it always has
// (marketplace_id, sandbox, refresh_token, connection_status, ...). This is
// the ONLY file that knows storage moved to ChannelConnection (see
// models/ChannelConnection.js) — see server/docs/channel-architecture.md.
//
// Migration strategy — lazy read-through, because the system is live:
//   read:  ChannelConnection first; if absent, read legacy EbaySettings,
//          upsert it into ChannelConnection (idempotent), return that.
//   write: ChannelConnection ONLY (after ensuring migration has happened,
//          so a partial update never creates a ChannelConnection row that's
//          missing fields an already-connected tenant had in EbaySettings).
//
// EbaySettings.js itself is left in place, untouched, as the legacy source
// — not deleted in this run. server/scripts/migrateEbaySettingsToChannelConnection.js
// does the same migration in bulk, so this lazy path finishes early for
// whichever tenants are actively used before that script ever runs.

const crypto = require("crypto");
const ChannelConnection = require("../../models/ChannelConnection");
const EbaySettings = require("../../models/EbaySettings");
const { logger } = require("../../loaders/logging");
const { encrypt, decrypt } = require("../../utils/crypto/tokenCipher");
const { EBAY_CONNECTION_STATUS } = require("../../constants/ebay.constants");
const { CHANNEL_CONNECTION_STATUS } = require("../../constants/channel.constants");
const { MARKETPLACE_PLATFORM } = require("../../constants/marketplace.constants");

const PLATFORM = MARKETPLACE_PLATFORM.EBAY;
const SECRET_FIELDS = "+refresh_token_ciphertext +refresh_token_iv +refresh_token_tag";
const CONN_SECRET_FIELDS = "+refresh_token_ct";

// ── ciphertext packing ───────────────────────────────────────────────────────
//
// tokenCipher.encrypt() returns {ciphertext, iv, tag} — three base64
// strings. ChannelConnection's generic contract (see ChannelConnection.js)
// has a single refresh_token_ct string shared across every future platform's
// cipher shape, so the three parts are packed into one delimited string
// here rather than widening that schema for one platform.
// NOTE: base64 alphabets never contain ".", so joining/splitting on "." is
// unambiguous and reversible.
function packCiphertext({ ciphertext, iv, tag }) {
  if (!ciphertext) return null;
  return `${iv}.${tag}.${ciphertext}`;
}

function unpackCiphertext(packed) {
  if (!packed) return { ciphertext: null, iv: null, tag: null };
  const [iv, tag, ciphertext] = packed.split(".");
  return { ciphertext, iv, tag };
}

// ── status <-> legacy connection_status ──────────────────────────────────────
//
// 'degraded' (circuit breaker — see ChannelConnection.js) has no legacy
// equivalent; mapped to ERROR (closest meaning: "something is currently
// wrong with this connection") rather than inventing a new enum value the
// frontend's ebaySettings.ts type doesn't know about — see the invariant
// against frontend changes in this run.
// NOTE: token_expired/revoked are never actually written anywhere in this
// codebase (grepped before writing this) — CONNECTED/NOT_CONNECTED/ERROR
// are the only legacy values ever set, so the mapping only needs to be
// faithful for those three.
function statusToLegacy(status) {
  switch (status) {
    case CHANNEL_CONNECTION_STATUS.CONNECTED:
      return EBAY_CONNECTION_STATUS.CONNECTED;
    case CHANNEL_CONNECTION_STATUS.DEGRADED:
    case CHANNEL_CONNECTION_STATUS.ERROR:
      return EBAY_CONNECTION_STATUS.ERROR;
    case CHANNEL_CONNECTION_STATUS.DISCONNECTED:
    default:
      return EBAY_CONNECTION_STATUS.NOT_CONNECTED;
  }
}

function legacyToStatus(connectionStatus) {
  switch (connectionStatus) {
    case EBAY_CONNECTION_STATUS.CONNECTED:
      return CHANNEL_CONNECTION_STATUS.CONNECTED;
    case EBAY_CONNECTION_STATUS.ERROR:
    case EBAY_CONNECTION_STATUS.TOKEN_EXPIRED:
    case EBAY_CONNECTION_STATUS.REVOKED:
      return CHANNEL_CONNECTION_STATUS.ERROR;
    default:
      return CHANNEL_CONNECTION_STATUS.DISCONNECTED;
  }
}

// Translates a ChannelConnection (base + eBay discriminator fields, lean
// object, secret fields selected) into the exact shape every existing
// consumer already expects from this service.
function toLegacyShape(conn) {
  if (!conn) return {};
  const refresh_token = decrypt(unpackCiphertext(conn.refresh_token_ct));

  return {
    _id: conn._id,
    tenant_id: conn.tenant_id,
    connection_status: statusToLegacy(conn.status),
    connected_at: conn.connected_at ?? null,
    last_error: conn.last_error ?? null,

    marketplace_id: conn.marketplace_id ?? "EBAY_AU",
    sandbox: conn.sandbox ?? false,

    merchant_location_key: conn.merchant_location_key ?? null,
    fulfillment_policy_id: conn.fulfillment_policy_id ?? null,
    payment_policy_id: conn.payment_policy_id ?? null,
    return_policy_id: conn.return_policy_id ?? null,

    warehouse_street: conn.warehouse_street ?? null,
    warehouse_city: conn.warehouse_city ?? null,
    warehouse_state: conn.warehouse_state ?? null,
    warehouse_postcode: conn.warehouse_postcode ?? null,
    warehouse_country: conn.warehouse_country ?? "AU",
    warehouse_phone: conn.warehouse_phone ?? null,

    fallback_image_url: conn.fallback_image_url ?? null,

    webhook_token: conn.webhook_token ?? null,
    verification_token: conn.verification_token ?? null,

    created_at: conn.created_at,
    updated_at: conn.updated_at,

    refresh_token,
  };
}

// Builds the ChannelConnection field set for a tenant from their legacy
// EbaySettings doc — used by both the lazy per-tenant migration below and
// (independently) by the bulk migration script.
function fieldsFromLegacy(legacy) {
  const hasToken = !!legacy.refresh_token_ciphertext;
  // Edge case: a legacy row with a null/empty token must migrate as
  // 'disconnected', never 'connected' — connection_status on the legacy row
  // itself isn't trusted for this (it could be stale/out of sync), the
  // actual presence of a token is.
  const status = hasToken
    ? (legacy.connection_status === EBAY_CONNECTION_STATUS.ERROR
        ? CHANNEL_CONNECTION_STATUS.ERROR
        : CHANNEL_CONNECTION_STATUS.CONNECTED)
    : CHANNEL_CONNECTION_STATUS.DISCONNECTED;

  return {
    tenant_id: legacy.tenant_id,
    platform: PLATFORM,
    status,
    // Copied VERBATIM — packed as-is from the legacy ciphertext/iv/tag,
    // never decrypted/re-encrypted (see tokenCipher.js, left unchanged).
    refresh_token_ct: packCiphertext({
      ciphertext: legacy.refresh_token_ciphertext,
      iv: legacy.refresh_token_iv,
      tag: legacy.refresh_token_tag,
    }),
    connected_at: legacy.connected_at ?? null,
    last_error: legacy.last_error ?? null,
    webhook_token: legacy.webhook_token ?? null,
    marketplace_id: legacy.marketplace_id ?? "EBAY_AU",
    sandbox: legacy.sandbox ?? false,
    merchant_location_key: legacy.merchant_location_key ?? null,
    fulfillment_policy_id: legacy.fulfillment_policy_id ?? null,
    payment_policy_id: legacy.payment_policy_id ?? null,
    return_policy_id: legacy.return_policy_id ?? null,
    warehouse_street: legacy.warehouse_street ?? null,
    warehouse_city: legacy.warehouse_city ?? null,
    warehouse_state: legacy.warehouse_state ?? null,
    warehouse_postcode: legacy.warehouse_postcode ?? null,
    warehouse_country: legacy.warehouse_country ?? "AU",
    warehouse_phone: legacy.warehouse_phone ?? null,
    fallback_image_url: legacy.fallback_image_url ?? null,
    verification_token: legacy.verification_token ?? null,
  };
}

// Idempotent, race-safe: two concurrent requests for the same tenant must
// never create duplicate ChannelConnection docs. Relies on the
// {tenant_id, platform} unique index — $setOnInsert means a doc that
// already exists (created by a racing call, or by a direct write like
// oauthCallback -> upsertSettings) is returned untouched, never clobbered.
async function migrateFromLegacy(tenantId) {
  const legacy = await EbaySettings.findOne({ tenant_id: tenantId }).select(SECRET_FIELDS).lean();
  if (!legacy) return null;

  const fields = fieldsFromLegacy(legacy);
  try {
    return await ChannelConnection.findOneAndUpdate(
      { tenant_id: tenantId, platform: PLATFORM },
      { $setOnInsert: fields },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
      .select(CONN_SECRET_FIELDS)
      .lean();
  } catch (err) {
    if (err.code === 11000) {
      // Lost the race — another request's upsert (or migration script run)
      // won. Re-read instead of erroring; that doc is what we want anyway.
      return ChannelConnection.findOne({ tenant_id: tenantId, platform: PLATFORM }).select(CONN_SECRET_FIELDS).lean();
    }
    throw err;
  }
}

// Ensures a ChannelConnection row exists for this tenant before a write is
// applied — without this, a partial `upsertSettings` update (e.g. "just
// change the warehouse phone number") on a tenant who has an existing,
// already-connected legacy EbaySettings row but no ChannelConnection row yet
// would create a bare ChannelConnection missing the refresh_token/policies/
// etc. that tenant already had, silently orphaning their live eBay
// connection. Never throws into the caller — see getSettings' own comment.
async function ensureMigrated(tenantId) {
  const existing = await ChannelConnection.findOne({ tenant_id: tenantId, platform: PLATFORM }).select("_id").lean();
  if (existing) return;
  await migrateFromLegacy(tenantId);
}

// ── legacy fallback (EbaySettings-only reads) ────────────────────────────────
//
// Used only when a ChannelConnection read/write itself errors — see
// getSettings' catch block. Deliberately duplicates the pre-migration
// getSettings body rather than sharing code with the new path, so a
// ChannelConnection outage can never take the fallback down with it.
function withDecryptedRefreshTokenLegacy(doc) {
  if (!doc) return doc;
  const refresh_token = decrypt({
    ciphertext: doc.refresh_token_ciphertext,
    iv: doc.refresh_token_iv,
    tag: doc.refresh_token_tag,
  });
  const { refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, ...rest } = doc;
  return { ...rest, refresh_token };
}

async function legacyGetSettings(tenantId) {
  const doc = await EbaySettings.findOne({ tenant_id: tenantId }).select(SECRET_FIELDS).lean();
  return withDecryptedRefreshTokenLegacy(doc) || {};
}

// ── public API (unchanged shape) ─────────────────────────────────────────────

async function getSettings(tenantId) {
  try {
    let conn = await ChannelConnection.findOne({ tenant_id: tenantId, platform: PLATFORM })
      .select(CONN_SECRET_FIELDS)
      .lean();
    if (!conn) conn = await migrateFromLegacy(tenantId);
    return toLegacyShape(conn);
  } catch (err) {
    // The lazy migration must never throw into the caller's request path —
    // fall back to reading EbaySettings directly, same as before this
    // migration existed.
    logger.warn("[ebay.settings] ChannelConnection read failed — falling back to legacy EbaySettings", {
      tenantId: String(tenantId),
      error: err.message,
    });
    return legacyGetSettings(tenantId);
  }
}

async function upsertSettings(tenantId, update) {
  await ensureMigrated(tenantId).catch((err) =>
    logger.warn("[ebay.settings] ensureMigrated failed before write — proceeding anyway", {
      tenantId: String(tenantId),
      error: err.message,
    }),
  );

  const { refresh_token, ...rest } = update;
  const setFields = { ...rest };

  if (refresh_token !== undefined) {
    const { ciphertext, iv, tag } = encrypt(refresh_token);
    setFields.refresh_token_ct = packCiphertext({ ciphertext, iv, tag });
    setFields.status = refresh_token ? CHANNEL_CONNECTION_STATUS.CONNECTED : CHANNEL_CONNECTION_STATUS.DISCONNECTED;
    setFields.connected_at = refresh_token ? new Date() : null;
    if (refresh_token) setFields.last_error = null;
  }

  const conn = await ChannelConnection.findOneAndUpdate(
    { tenant_id: tenantId, platform: PLATFORM },
    { $set: setFields, $setOnInsert: { tenant_id: tenantId, platform: PLATFORM } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
    .select(CONN_SECRET_FIELDS)
    .lean();

  logger.info("[ebay.settings] Settings updated", { tenantId: String(tenantId), fields: Object.keys(setFields) });
  return toLegacyShape(conn);
}

// Records a connection failure surfaced by the API/poller (e.g. a revoked or
// expired refresh_token) so Settings can show it instead of failing silently.
// Signature unchanged: `status` is still an EBAY_CONNECTION_STATUS value —
// translated to the generic ChannelConnection status internally.
async function markConnectionError(tenantId, { status = EBAY_CONNECTION_STATUS.ERROR, message } = {}) {
  await ensureMigrated(tenantId).catch(() => {});
  await ChannelConnection.updateOne(
    { tenant_id: tenantId, platform: PLATFORM },
    { $set: { status: legacyToStatus(status), last_error: message ?? null }, $setOnInsert: { tenant_id: tenantId, platform: PLATFORM } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  logger.warn("[ebay.settings] Connection marked as errored", { tenantId: String(tenantId), status, message });
}

async function ensureVerificationToken(tenantId) {
  await ensureMigrated(tenantId).catch(() => {});
  let conn = await ChannelConnection.findOne({ tenant_id: tenantId, platform: PLATFORM });
  if (!conn) conn = new ChannelConnection({ tenant_id: tenantId, platform: PLATFORM });

  if (!conn.verification_token) {
    conn.verification_token = crypto.randomBytes(32).toString("hex");
    await conn.save();
    logger.info("[ebay.settings] Verification token generated and saved", { tenantId: String(tenantId) });
  }

  return conn.verification_token;
}

// Opaque, unguessable identifier used in the shared webhook URL's query
// string in place of this tenant's real _id (see ChannelConnection.webhook_token).
async function ensureWebhookToken(tenantId) {
  await ensureMigrated(tenantId).catch(() => {});
  let conn = await ChannelConnection.findOne({ tenant_id: tenantId, platform: PLATFORM });
  if (!conn) conn = new ChannelConnection({ tenant_id: tenantId, platform: PLATFORM });

  if (!conn.webhook_token) {
    conn.webhook_token = crypto.randomBytes(24).toString("hex");
    await conn.save();
    logger.info("[ebay.settings] Webhook token generated and saved", { tenantId: String(tenantId) });
  }

  return conn.webhook_token;
}

// Resolves the tenant/settings pair a webhook delivery belongs to, purely
// from the opaque token in its URL — the real tenant_id never appears there.
// Falls back to EbaySettings so a tenant who set up their webhook long ago
// and hasn't triggered any other lazy migration yet (no GET/PUT to Settings
// since this deploy) still resolves correctly — a real eBay webhook delivery
// must keep working immediately after deploy, not just after the migration
// script has run.
async function findByWebhookToken(webhookToken) {
  if (!webhookToken) return null;

  const conn = await ChannelConnection.findOne({ webhook_token: webhookToken, platform: PLATFORM })
    .select(CONN_SECRET_FIELDS)
    .lean();
  if (conn) return toLegacyShape(conn);

  const legacy = await EbaySettings.findOne({ webhook_token: webhookToken }).select(SECRET_FIELDS).lean();
  if (!legacy) return null;

  try {
    const migrated = await migrateFromLegacy(legacy.tenant_id);
    return toLegacyShape(migrated);
  } catch (err) {
    logger.warn("[ebay.settings] migrateFromLegacy failed during webhook lookup — using legacy shape directly", {
      error: err.message,
    });
    return withDecryptedRefreshTokenLegacy(legacy);
  }
}

// Every tenant that has completed enough setup to actually call eBay's API —
// used by the worker's poll loop and anywhere else that needs to iterate
// "every eBay-enabled store" rather than operate on one already-known
// tenant. Sourced from EbaySettings (the legacy list is authoritative until
// the migration script runs — every already-connected tenant has a row
// there), lazily migrating each one into ChannelConnection along the way, so
// the poll loop opportunistically finishes the migration even before the
// script runs. Also includes any tenant connected directly through
// ChannelConnection with no legacy row at all (e.g. onboarded after this
// migration).
async function listConfiguredTenants() {
  const legacyDocs = await EbaySettings.find({ refresh_token_ciphertext: { $ne: null } }).select(SECRET_FIELDS).lean();
  const results = [];
  const seenTenantIds = new Set();

  for (const legacy of legacyDocs) {
    seenTenantIds.add(String(legacy.tenant_id));
    try {
      let conn = await ChannelConnection.findOne({ tenant_id: legacy.tenant_id, platform: PLATFORM })
        .select(CONN_SECRET_FIELDS)
        .lean();
      if (!conn) conn = await migrateFromLegacy(legacy.tenant_id);
      results.push(toLegacyShape(conn));
    } catch (err) {
      logger.warn("[ebay.settings] ChannelConnection read failed while listing configured tenants — using legacy row", {
        tenantId: String(legacy.tenant_id),
        error: err.message,
      });
      results.push(withDecryptedRefreshTokenLegacy(legacy));
    }
  }

  const directConns = await ChannelConnection.find({
    platform: PLATFORM,
    refresh_token_ct: { $ne: null },
    tenant_id: { $nin: legacyDocs.map((d) => d.tenant_id) },
  })
    .select(CONN_SECRET_FIELDS)
    .lean();

  for (const conn of directConns) {
    if (seenTenantIds.has(String(conn.tenant_id))) continue;
    results.push(toLegacyShape(conn));
  }

  return results;
}

module.exports = {
  getSettings,
  upsertSettings,
  markConnectionError,
  ensureVerificationToken,
  ensureWebhookToken,
  findByWebhookToken,
  listConfiguredTenants,
  // Exported for server/scripts/migrateEbaySettingsToChannelConnection.js so
  // the bulk migration script and this file's own lazy read-through share
  // ONE implementation of "how to turn a legacy EbaySettings doc into a
  // ChannelConnection", rather than two that can drift apart.
  fieldsFromLegacy,
  migrateFromLegacy,
};
