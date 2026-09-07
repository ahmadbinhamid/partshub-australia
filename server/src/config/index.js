// config/index.js

require("dotenv").config();

const dns = require("dns");
const path = require("path");

// Some networks (including this one, found live — merchantapi.googleapis.com
// timed out over IPv6 while IPv4 connected instantly) advertise a AAAA
// record for a host that doesn't actually route, and Node's fetch/undici
// doesn't fall back to IPv4 fast enough — it just hangs until its own
// connect timeout (~10s) and throws a generic "fetch failed" with no useful
// detail. Preferring IPv4 first (still allows IPv6 for hosts that DO route
// it) avoids that class of failure for every outbound call this process
// makes — Google, eBay, Stripe, SMTP, everything — not just Google's. Set
// here (not per-entrypoint) since every process (API server, every worker)
// requires config first.
dns.setDefaultResultOrder("ipv4first");

const get = (key, def) => process.env[key] ?? def;
const getNum = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const config = {
  env: get("NODE_ENV", "development"),
  appEnv: get("APP_ENV", "development"),
  port: getNum("PORT", 7000),
  mongoUri: get("MONGO_URI", "mongodb://localhost:27017/partshub-australia"),
  logLevel: get("LOG_LEVEL", "info"),

  jwt: {
    secret: get("JWT_SECRET", "change_me"),
    expiresIn: get("JWT_EXPIRES_IN", "2h"),
  },

  security: {
    // 32-byte hex string (64 hex chars) — `openssl rand -hex 32`. Used to
    // encrypt long-lived third-party credentials at rest (currently: each
    // tenant's eBay refresh_token — see utils/crypto/tokenCipher.js).
    encryptionKey: get("ENCRYPTION_KEY", null),
  },

  otp: {
    expiryMinutes: getNum("OTP_EXPIRY_MINUTES", 2),
  },

  passwordReset: {
    expiryMinutes: getNum("PASSWORD_RESET_EXPIRY_MINUTES", 15),
  },

  redis: {
    url: get("REDIS_URL", null),
    host: get("REDIS_HOST", "127.0.0.1"),
    port: getNum("REDIS_PORT", 6379),
  },

  smtp: {
    host: get("SMTP_HOST", "sandbox.smtp.mailtrap.io"),
    port: getNum("SMTP_PORT", 2525),
    user: get("SMTP_USER"),
    pass: get("SMTP_PASS"),
    alertsTo: get("ALERTS_TO"),
    // Conservative defaults for shared/free SMTP sandboxes (e.g. Mailtrap
    // testing plans) that throttle to a handful of messages per second.
    // Bump these via env once on a real provider with higher limits.
    maxConnections: getNum("SMTP_MAX_CONNECTIONS", 1),
    rateLimit: getNum("SMTP_RATE_LIMIT", 1),
    rateDeltaMs: getNum("SMTP_RATE_DELTA_MS", 1000),
  },

  emailBrand: {
    fromName: get("EMAIL_FROM_NAME", "Vision Dock"),
    fromEmail: get("EMAIL_FROM", "no-reply@vision-dock.test"),
    supportEmail: get("SUPPORT_EMAIL", "support@vision-dock.test"),
    appName: get("APP_NAME", "Vision Dock"),
    // Admin dashboard — used by internal-account emails (e.g. accountVerified's login link).
    clientUrl: get("CLIENT_URL", "http://localhost:3000"),
    // Storefront base URL, for any customer-facing email that needs to link back to it.
    storefrontUrl: get("STOREFRONT_URL", "http://localhost:5174"),
  },

  payment: {
    // Apex domain payment links are built under — "payment.<domain>" for
    // tenants on PAYMENT_DOMAIN_MODE.DEFAULT, "<tenant-slug>.<domain>" for
    // VENDOR_SLUG (see stripe.payment.service.js#buildPaymentBaseUrl). Both
    // hosts need DNS (a wildcard covers VENDOR_SLUG) and TLS pointed at the
    // same nginx/backend as CLIENT_URL — see nginx/nginx.conf. Left unset in
    // local dev, where every payment link just falls back to CLIENT_URL.
    linkDomain: get("PAYMENT_LINK_DOMAIN", null),
  },

  cors: {
    // comma-separated list like: http://localhost:3000,https://staging.example.com
    allowedOrigins: (get("CORS_ALLOWED_ORIGINS", "") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  uploads: {
    // Resolve relative to this file so the path is stable regardless of where node is invoked from
    dir: get("UPLOADS_DIR", path.join(__dirname, "../../uploads")),
    url: get("UPLOADS_URL", "http://localhost:7000/uploads"),
  },

  ebay: {
    // Multi-tenant — client_id/client_secret belong to OUR eBay Application
    // (shared across every tenant, like a Stripe platform key) and stay
    // global. Everything seller-specific (refresh_token, marketplace,
    // sandbox, policies, warehouse address, webhook token) now lives per-
    // tenant on the EbaySettings model — see ebay.settings.service.js.
    clientId: get("EBAY_CLIENT_ID", null),
    clientSecret: get("EBAY_CLIENT_SECRET", null),
    // Global override (e.g. a proxy) — normally left unset so each tenant's
    // own `sandbox` flag derives the right base URL (see ebay.api.service.js).
    apiBaseUrl: get("EBAY_API_BASE_URL"),
    taxonomyBaseUrl: get("EBAY_TAXONOMY_BASE_URL"),
    // eBay's "RuName" — a redirect-URL identifier you register once in the
    // eBay Developer Portal against this application, pointed at
    // /api/v1/ebay/oauth/callback. Required for the OAuth consent flow
    // (ebay.oauth.service.js) — eBay will not redirect anywhere else.
    redirectUri: get("EBAY_REDIRECT_URI", null),
  },

  google: {
    // Multi-tenant, mirroring config.ebay's shape — client_id/client_secret
    // belong to OUR Google Cloud OAuth client (shared across every tenant,
    // like a Stripe platform key) and stay global. Everything seller-
    // specific (merchant_id, data source, tokens) lives per-tenant on
    // ChannelConnection — see services/google/google.oauth.service.js.
    clientId: get("GOOGLE_CLIENT_ID", null),
    clientSecret: get("GOOGLE_CLIENT_SECRET", null),
    // The URL Google redirects back to after consent — for this Google
    // Cloud OAuth client, this really is a literal URL (unlike eBay's
    // RuName indirection), registered in the Google Cloud Console against
    // this client, pointed at /api/v1/google/oauth/callback.
    redirectUri: get("GOOGLE_REDIRECT_URI", null),
  },

  channels: {
    // ChannelSyncLog TTL — see models/ChannelSyncLog.js.
    syncLogTtlDays: getNum("CHANNEL_SYNC_LOG_TTL_DAYS", 30),
    // Full catalogue syncs can be thousands of listings; logging every
    // success would flood the collection for no operational benefit (see
    // channel.constants.js and sync.service.js). Failures are always logged
    // in full regardless of this flag.
    logSuccesses: get("CHANNEL_LOG_SUCCESSES", "false") === "true",
    // Consecutive transport/auth failures before a platform's queue is
    // paused — see ChannelConnection.consecutive_failures and
    // services/marketplace/circuitBreaker.js.
    circuitBreakerThreshold: getNum("CHANNEL_CIRCUIT_BREAKER_THRESHOLD", 10),
    // Debounced sync_listing enqueue delay — see queues/channel.queue.js.
    // Matches Bull's existing default id/delay pattern already used for
    // eBay before this migration (no prior explicit value, so this is the
    // first time it's configurable rather than hardcoded).
    debounceMs: getNum("CHANNEL_SYNC_DEBOUNCE_MS", 5000),
    // sync_batch chunk size (Task 3, Google Shopping) — how many listings
    // sync.service.js#syncBatch reads off its Mongo cursor before dispatching
    // adapter.publishBatch for that chunk. Kept modest so a single batch
    // call/timeout stays bounded regardless of catalogue size.
    batchChunkSize: getNum("CHANNEL_BATCH_CHUNK_SIZE", 500),
    // Per-queue Bull limiter ({max, duration}), keyed by platform — see
    // queues/channel.queue.js. eBay's queue has never had a limiter (the old
    // queues/ebay.queue.js never set one), so it stays unset by default
    // here too — only set EBAY_QUEUE_RATE_MAX/_DURATION_MS if you actually
    // want to newly throttle it; leaving both unset preserves eBay's current
    // unrestricted throughput exactly, per this migration's zero-behavior-
    // change invariant.
    rateLimits: {
      ebay:
        getNum("EBAY_QUEUE_RATE_MAX", 0) > 0
          ? { max: getNum("EBAY_QUEUE_RATE_MAX", 0), duration: getNum("EBAY_QUEUE_RATE_DURATION_MS", 1000) }
          : null,
    },
    // Refresh sweep (services/marketplace/refresh.service.js) — closes the
    // gap where a channel that expires stale listings (Google Merchant
    // Center: 30 days) never gets re-pushed because our own sync only fires
    // on a stock change or at connect time. Only consumed by an adapter that
    // opts in via its own `refreshIntervalDays` field (see registry.js's
    // interface comment) — eBay never expires listings and never reads this.
    // Deliberately under Google's real 30-day cap by default, to leave
    // headroom for a missed sweep run or a transient failure before the
    // real deadline hits.
    refreshIntervalDays: getNum("CHANNEL_REFRESH_INTERVAL_DAYS", 25),
    // How often the refresh_stale repeatable job actually runs, per platform
    // that opts in — see workers/channel.worker.js#attachRefreshStaleScheduler.
    refreshSweepIntervalHours: getNum("CHANNEL_REFRESH_SWEEP_INTERVAL_HOURS", 24),
    // Kill switch — checked at sweep TIME (refresh.service.js#sweepStaleListings),
    // not at schedule-registration time, so flipping this takes effect on
    // the very next scheduled run with no restart/redeploy needed to
    // unregister the repeatable job itself.
    refreshSweepEnabled: get("CHANNEL_REFRESH_SWEEP_ENABLED", "true") === "true",
  },

  stripe: {
    // BYOK — no platform-level secret/webhook/publishable key anymore; each
    // tenant supplies their own via Settings → Payment Account, stored
    // encrypted on their Tenant document (see stripe.keys.service.js).
    // Only the default currency stays global/env-configurable.
    currency: get("STRIPE_CURRENCY", "aud"),
    // Local-dev-only fallback for `stripe listen`, which mints a fresh
    // whsec_ every session that can never match a tenant's real stored
    // secret. Tried ONLY after the tenant's own secret fails, and ONLY
    // outside production — see payment.controller.js#handleWebhook. Paste
    // whatever `stripe listen` prints into this env var each session.
    devWebhookSecret: get("STRIPE_DEV_WEBHOOK_SECRET", null),
  },

  typesense: {
    // Self-hosted (docker-compose service `typesense`) — one shared cluster,
    // every tenant's products live in the same `products` collection scoped
    // by a `tenant_id` field (same shared-DB pattern as Mongo).
    host: get("TYPESENSE_HOST", "localhost"),
    port: getNum("TYPESENSE_PORT", 8108),
    protocol: get("TYPESENSE_PROTOCOL", "http"),
    apiKey: get("TYPESENSE_API_KEY", "xyz"),
    connectionTimeoutSeconds: getNum("TYPESENSE_TIMEOUT_SECONDS", 5),
  },
};

module.exports = config;
