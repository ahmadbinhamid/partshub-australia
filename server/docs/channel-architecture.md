# Channel architecture

This document describes the channel-agnostic layer that replaces eBay-specific
plumbing throughout the marketplace-sync stack, so Google Shopping and Meta
Shop (built later) plug into the same contract eBay now does. It covers the
adapter contract, the data model, the job/queue flow, the deploy order, and
the rollback procedure.

eBay's own behavior is unchanged end-to-end by this migration — every
existing eBay flow (publish, update, end, inventory push, inventory
poll-back, order ingest, webhooks, refunds) still works exactly as it did
before. What changed is *where* the generic parts of that plumbing live.

## 1. Adapter contract

Every marketplace adapter (`services/marketplace/adapters/*.adapter.js`)
exports:

```js
{
  key,            // platform key, e.g. "ebay"
  manifest,       // { key, name, logo, description, status, authType, setupSteps, requiredTenantData }
  capabilities,   // { publish, inventory, batch, orders, webhooks, inboundInventory, variants }
  loadSettings(tenantId), // -> resolved connection/settings object, or null if not connected
  publish(resolved, settings, hooks?, seq?),
  update(resolved, settings, hooks?, seq?),
  end(listing),
  publishBatch(...), // optional — omitted by eBay
}
```

`registry.js` (`services/marketplace/registry.js`) holds every registered
adapter:

- `register(adapter)` — called once at process startup (see
  `services/marketplace/registerAdapters.js`, used by both the API process
  and the channel worker).
- `has(platform)` / `get(platform)` (alias: `getAdapter`) — `get` throws a
  clear "No marketplace adapter registered for: X" error for an unknown
  platform; `has` is the non-throwing check used by fan-out and the channel
  routes.
- `list()` — every registered adapter's `manifest`, used by `GET
  /api/v1/channels`.
- `getAll()` — every registered adapter object, used by the worker to attach
  a queue processor per platform.

`services/marketplace/sync.service.js` is the platform-agnostic dispatcher.
It no longer has any eBay-specific branching: it resolves the adapter via
the registry, calls `adapter.loadSettings(tenantId)` instead of a hardcoded
per-platform switch, and guards on `adapter.capabilities.inventory` so a
catalog-only adapter's inventory-refresh jobs become a clean no-op instead of
a crash. A tenant with no connection at all (`loadSettings` resolves to
`null`) is a clean "not connected" skip, never an unhandled rejection.

eBay's own adapter (`adapters/ebay.adapter.js`) still owns every eBay HTTP
call exactly as before; the only additions are `manifest`, `capabilities`
(`publish`/`inventory`/`orders`/`webhooks`/`inboundInventory`/`variants`:
`true`, `batch`: `false`), and `loadSettings`, which just wraps the existing
`ebay.settings.service.js#getSettings` — see the `// NOTE:` in that file for
why it deliberately never returns `null` (an unconfigured eBay tenant still
gets today's exact "credentials not configured" error/retry behavior, not
the new generic skip, since that's what "zero behavior change" requires).

## 2. Data model

### MarketplaceListing (existing collection, unchanged name)

`push_seq` / `last_pushed_seq` moved from the eBay discriminator onto the
**base** schema (default `0`) — `sync.service.js` reads them for every
platform, so a non-eBay listing used to silently get `undefined` fencing
values. A generic `synced_quantity` field was added to the base schema as
the channel-agnostic loop-prevention baseline.

`ebay_synced_quantity` stays on the eBay discriminator, marked deprecated.
During the transition every write site dual-writes both
`ebay_synced_quantity` (deprecated) and `synced_quantity` (generic) —
search for `TODO(dual-write)` to find every site. The read convention going
forward is `synced_quantity ?? ebay_synced_quantity ?? null`.
`ebay.inventory-sync.service.js` (the existing eBay-only reconciliation
poller) was left reading `ebay_synced_quantity` directly — untouched, since
generalizing that poller isn't in scope here and the dual-write keeps it
accurate regardless.

Every fencing comparison coalesces with `?? 0` rather than assuming Mongoose
applies the schema default on every read path (it does on a hydrated
document, not on `.lean()`).

New indexes (background): `{ tenant_id, platform, sync_status }` and
`{ tenant_id, platform, synced_at: -1 }`.

### ChannelConnection (new collection, discriminator key `platform`)

Replaces `EbaySettings` as the channel-agnostic connection record. Base
schema: `tenant_id`, `platform`, `status`
(`connected`/`disconnected`/`degraded`/`error`), `external_account_id`,
`access_token_ct` / `refresh_token_ct` (single packed ciphertext string per
token — see §3), `token_expires_at`, `webhook_token`, `connected_at`,
`last_error`, `consecutive_failures`, `last_success_at`, `disabled_at`.
Unique index on `{ tenant_id, platform }`; a separate global unique+sparse
index on `webhook_token` (it has no tenant in its own URL, so it must be
resolvable on its own — see §3).

The eBay discriminator carries every eBay-specific field from
`EbaySettings.js` verbatim: `marketplace_id`, `sandbox`,
`merchant_location_key`, the three business policy ids, the warehouse
address fields, `fallback_image_url`, `verification_token`.

It's registered under the Mongoose model name `ChannelConnectionEbay`, not
`ebay` — `MarketplaceListing` already has a discriminator model literally
named `ebay`, and Mongoose discriminator names are unique per connection,
not per base model, so reusing the same name throws `OverwriteModelError`.
The 3rd argument to `.discriminator(name, schema, value)` keeps the actual
stored `platform` value as `"ebay"` (`MARKETPLACE_PLATFORM.EBAY`) — every
query elsewhere is unaffected.

### ChannelSyncLog (new collection)

Append-only audit trail written from `sync.service.js`: `tenant_id`,
`platform`, `job_type`, `entity_type`, `entity_id`, `status`
(`success`/`failure`/`skipped`), `attempt`, `error_code`, `error_message`,
`request_summary`, `duration_ms`. TTL index on `created_at`
(`config.channels.syncLogTtlDays`, default 30). Failures are always logged
in full; successes/skips only when `config.channels.logSuccesses` is set
(default `false`), so a full catalogue sync doesn't write thousands of rows.
All log writes are wrapped in try/catch — logging can never break a job.

### EbaySettings (existing collection, untouched)

Left in place as the legacy source of truth during the transition — not
deleted, not modified. See §4.

## 3. Migration strategy: EbaySettings → ChannelConnection

Lazy read-through, because the system is live and cannot take a maintenance
window:

- **Read** (`ebay.settings.service.js#getSettings`): look up
  `ChannelConnection { tenant_id, platform: "ebay" }`. If absent, read the
  legacy `EbaySettings` doc, upsert it into `ChannelConnection` (idempotent —
  `findOneAndUpdate` with `$setOnInsert`, protected by the unique index; a
  concurrent duplicate-key error is caught and re-read rather than erring),
  and return that.
- **Write** (`upsertSettings`, `markConnectionError`,
  `ensureVerificationToken`, `ensureWebhookToken`): `ChannelConnection`
  only — but `upsertSettings` first calls `ensureMigrated`, which runs the
  same lazy migration if no `ChannelConnection` row exists yet. Without
  this, a partial update (e.g. "just change the warehouse phone number") on
  a tenant who's already connected via the legacy row, but hasn't triggered
  a lazy migration yet, would silently create a bare `ChannelConnection`
  missing their refresh token — orphaning a live connection.
- **`findByWebhookToken`**: tries `ChannelConnection` first, falls back to
  `EbaySettings` (and lazily migrates on the way) — a real inbound eBay
  webhook delivery must resolve correctly immediately after this code
  deploys, for every already-connected tenant, none of whom have a
  `ChannelConnection` row yet at that point.
- **`listConfiguredTenants`**: sourced from `EbaySettings` (authoritative
  until the bulk migration script runs), lazily migrating each tenant along
  the way; also includes any tenant connected directly through
  `ChannelConnection` with no legacy row at all.
- The lazy migration **never throws into the caller's request path** — every
  call site falls back to reading `EbaySettings` directly on failure.

**Public shape is unchanged.** `getSettings`/`upsertSettings`/
`findByWebhookToken` still return the exact same field names/values
(`marketplace_id`, `sandbox`, `connection_status`, `refresh_token`, ...) as
before — the frontend (`ebaySettingsService.ts` et al) is untouched and
still reads this shape. `toLegacyShape()`/`fieldsFromLegacy()` in
`ebay.settings.service.js` are the one place that translates between the two
models.

**Token ciphertext**: `tokenCipher.js` is unchanged and still produces
`{ ciphertext, iv, tag }`. `ChannelConnection`'s generic contract has a
single `refresh_token_ct` string (shared across every future platform's
cipher shape), so the three parts are packed into one delimited string
(`"<iv>.<tag>.<ciphertext>"`, base64 never contains `.`) rather than
widening the schema for one platform. This is a repackaging, not a
decrypt/re-encrypt — the underlying AES-GCM ciphertext bytes are copied
verbatim.

**Bulk migration script** —
`server/scripts/migrateEbaySettingsToChannelConnection.js`:

```
node scripts/migrateEbaySettingsToChannelConnection.js [--dry-run] [--tenant=<tenantId>]
```

Idempotent (skips a tenant that already has a `ChannelConnection`, never
overwrites it), `--dry-run` writes nothing, logs a per-tenant and summary
count. Exports `run({ dryRun, tenantId, log, logError })` so it's testable
directly rather than only as a subprocess — see
`src/services/ebay/ebay.settings.migration-script.test.js`.

## 4. Job / queue flow

`queues/channel.queue.js` exports a `queues` map keyed by platform and
`enqueueChannelJob(platform, jobName, payload, opts)`. eBay's Bull queue
name stays exactly `"ebay"` (job names `sync_listing`/`poll_orders`/
`poll_inventory` unchanged too) — there can be jobs already sitting in Redis
at deploy time, and renaming the queue would orphan them.

`sync_listing` jobs are debounced: `jobId: sync:<platform>:<listingId>`,
`delay: config.channels.debounceMs` (default 5000ms), `removeOnComplete:
true` (**mandatory** — a completed job with a custom jobId stays in Redis's
completed set otherwise, and a later `.add()` with the same id is silently
ignored forever), `removeOnFail: false`. N rapid calls for the same listing
collapse into one job; the eventual job re-reads the listing's *current*
`push_seq` at execution time rather than trusting whichever payload's `seq`
happened to win the dedup, so this is safe. The old job-payload shape
(`{ listingId, seq }`) is unchanged and still processed correctly by the
worker.

`queues/ebay.queue.js` is now a thin shim: `enqueueEbayJob` calls
`channel.queue.js`'s `enqueueChannelJobDirect("ebay", ...)` (the real
implementation, bypassing override-checking), and the module registers
itself as the `"ebay"` override on `channel.queue.js` so a caller of the
generic `enqueueChannelJob("ebay", ...)` (e.g.
`inventory.service.js#fanOutMarketplaceInventory`) is transparently routed
through the exact same function object several **pre-existing tests**
already mock directly (`ebay.inventory-sync.service.test.js`,
`inventory.service.oversell.test.js` both patch
`ebay.queue.js#enqueueEbayJob`). This indirection exists purely so those
tests keep intercepting real eBay-bound enqueue calls without being edited
— it has no effect on production behavior (both paths hit the identical Bull
queue with identical job options either way).

Per-queue rate limiting (`limiter: { max, duration }`) is read from
`config.channels.rateLimits[platform]`; eBay's has never had one, so it
stays unset by default — set `EBAY_QUEUE_RATE_MAX`/`_DURATION_MS` to opt in.

### Inventory fan-out

`inventory.service.js#fanOutMarketplaceInventory` now calls
`enqueueChannelJob(listing.platform, ...)` instead of a hardcoded
`enqueueEbayJob`. It iterates every active listing across every platform for
a product; a listing whose platform has no registered adapter is skipped
with a warning (never throws), and each platform's enqueue is wrapped
individually so one platform's failure never blocks another's.

### Circuit breaker (`services/marketplace/circuitBreaker.js`)

Per-`(tenant, platform)`, backed by `ChannelConnection.consecutive_failures`/
`status`. Only transport/auth-level failures count (`status >= 500`, `401`,
`403`, or no HTTP status at all i.e. a network/timeout error) — a 400-level
per-item validation failure (bad category, missing GTIN) never does, since
that's a product-data problem, not evidence the connection is broken. At
`config.channels.circuitBreakerThreshold` (default 10) consecutive counted
failures, `status` flips to `degraded` and `sync.service.js#syncListing`
skips further syncs for that tenant+platform until an explicit `resume()`
(used by the reconnect/manual-sync flow) or the reconnect flow clears it.

**Deliberate deviation from a literal reading of "pause that platform's
queue":** eBay's Bull queue is shared across every tenant. A literal
`queue.pause()` on breaker-trip would stall every *other* tenant's eBay sync
because of *one* tenant's broken credentials — a worse outage than the one
the breaker exists to prevent. Implemented instead as a per-tenant gate
`sync.service.js` checks before calling the adapter, which gets the same
practical effect (stop hammering a confirmed-broken connection) without the
cross-tenant blast radius.

### Worker consolidation (`workers/channel.worker.js`)

Registers every adapter, then attaches a `sync_listing` processor per
platform's queue at per-platform concurrency (`SYNC_LISTING_CONCURRENCY` —
eBay stays at `1`, its existing concurrency, unchanged). eBay's
`poll_orders`/`poll_inventory` handlers and their repeatable schedules are
wired directly (not part of the generic per-platform loop — no other
platform has an equivalent yet), ported unchanged from the old
`ebay.worker.js`. Handles `SIGTERM`/`SIGINT`: Bull's `Queue#close()` already
stops picking up new jobs and waits for active ones before resolving; the
handler sequences that against closing the Mongo connection, then exits.

`workers/ebay.worker.js` is now a thin delegate:
`startChannelWorker({ platforms: ["ebay"] })` — kept as a separate entry
point purely so the *old* docker-compose (`worker-ebay: node
src/workers/ebay.worker.js`) keeps booting correctly if the code deploy
lands before the compose file change does (see §5).

`workers/platform.worker.js` merges the old `email.worker.js` and
`search.worker.js` into one process — both are low-volume, unrelated job
types that don't need a dedicated container each. Processing logic itself is
unchanged.

## 5. API routes (additive only)

`GET /api/v1/channels` — every registered adapter's manifest merged with
this tenant's connection status, capabilities, health
(`consecutive_failures`, `last_success_at`), and listing counts by
`sync_status`.

`GET /api/v1/channels/:platform/logs` — paginated `ChannelSyncLog`.

`POST /api/v1/channels/:platform/retry/:logId` — re-enqueues the listing
behind a failed/skipped log row (fresh `sync_listing` job, no fencing seq).

`:platform` is validated against the registry; an unknown platform is a
404. Registered in `routes/index.js` behind the same `auth()` middleware the
eBay routes use. `routes/ebay.routes.js` itself is untouched.

## 6. Deploy order

1. **Deploy the code** (this migration). `EbaySettings` keeps working as the
   read/write source for any tenant not yet lazily migrated;
   `ChannelConnection` starts filling in on demand. `worker-ebay` (old
   compose) and `worker-channels` (new compose) both work correctly against
   the *current* production database at this point — nothing here depends
   on the migration script having run.
2. **Run the migration script** (optional but recommended before decommissioning
   `EbaySettings` reads):
   `node scripts/migrateEbaySettingsToChannelConnection.js` (drop `--dry-run`
   once the printed plan looks right). Safe to run repeatedly; safe to run
   while the app is live and taking traffic.
3. **Switch docker-compose**: replace `worker-ebay` with `worker-channels`
   (`node src/workers/channel.worker.js`), merge `worker-email`/
   `worker-search` into `worker-platform`. `worker-stripe` is untouched.
   `workers/ebay.worker.js` keeps working if this step is delayed relative
   to step 1 — it's a fully-functional restricted delegate to
   `channel.worker.js`, not a stub.

## 7. Rollback

- **Step 3 (compose) rollback**: revert `docker-compose.yml` to
  `worker-ebay`/`worker-email`/`worker-search`. `workers/ebay.worker.js`
  (step 1's code) still runs the exact same eBay processing as
  `channel.worker.js` restricted to eBay — no functional loss.
  `workers/email.worker.js`/`search.worker.js` were left in place, untouched,
  specifically so this rollback direction has something to point back at.
- **Step 2 (migration script) rollback**: none needed — it's additive-only
  (`ChannelConnection` rows) and never modifies or deletes `EbaySettings`.
  If a migrated `ChannelConnection` row is ever suspected wrong for a
  tenant, delete just that row; the lazy read-through will re-derive it from
  `EbaySettings` on the next read.
- **Step 1 (code) rollback**: reverting to the pre-migration code is safe as
  long as `EbaySettings` still has accurate data for every tenant that
  connected *before* the rollback point. A tenant who connects/reconnects
  *after* this migration deployed (writing only to `ChannelConnection`) would
  lose that specific update on a full code rollback — for that
  narrow window, re-run the OAuth connect flow once the rollback is live to
  re-populate `EbaySettings`. This is the same category of risk any
  storage-migrating deploy carries; `EbaySettings` is deliberately kept
  fully intact (not deleted, not migration-locked) specifically to keep this
  rollback path open.

## 8. `// NOTE:` decisions

A few ambiguous calls made in favor of the most backward-compatible option,
each with an inline `// NOTE:`/comment at the site:

- `ebay.adapter.js#loadSettings` never returns `null` (unlike the generic
  contract's convention) — an unconfigured eBay tenant keeps getting today's
  exact "credentials not configured" thrown error, not the new generic
  "not connected" skip.
- Circuit breaker trip is a per-tenant gate in `sync.service.js`, not a
  literal Bull `queue.pause()` — see §4.
- `ChannelConnection`'s eBay discriminator is registered as model name
  `ChannelConnectionEbay` (value still `"ebay"`) to avoid colliding with
  `MarketplaceListing`'s own `"ebay"` discriminator in Mongoose's global
  model registry.
- `degraded` (`ChannelConnection.status`, new) maps to legacy
  `connection_status: "error"` in `ebay.settings.service.js#getSettings` —
  the old enum has no equivalent value, and the frontend's `ebaySettings.ts`
  type isn't touched in this run.
- `access_token_ct`/`refresh_token_ct` each pack tokenCipher's
  `{ ciphertext, iv, tag }` triple into one delimited string, rather than
  widening `ChannelConnection`'s schema per-platform.

## 9. Google Shopping (second channel)

Added additively on top of everything above — eBay's own behavior is
unchanged; see §11 for exactly what was touched in the shared layer and why
each change is safe for eBay.

### Adapter (`adapters/google.adapter.js`)

Google is **feed-shaped, not listing-shaped**: there's no create-offer/
publish-offer sequence the way eBay has one. `publish()` and `update()` are
both just `productInputs.insert` (Merchant API's own upsert semantics) —
kept as two exports only because the registry contract requires both.
`external_offer_id` is always `null`; `external_listing_id` holds the
Merchant API product resource name's short form
(`contentLanguage~feedLabel~offerId`, literally — see
`buildProductResourceName`). Originally `channel~contentLanguage~feedLabel~offerId`
under v1beta; the `channel` segment (and the `channel`/`gtin` fields
elsewhere) were removed when this integration migrated to v1 after Google
discontinued v1beta on 2026-02-28 — see §9's own migration note below and
`google.merchant.api.service.js`'s module comment.

`loadSettings` follows the **generic** contract (returns `null` for a
tenant with no `ChannelConnection`) — unlike eBay's adapter, which
deliberately never does (see §8's first bullet). Google has no legacy
pre-`ChannelConnection` source to stay compatible with, so there's no reason
to deviate; `sync.service.js`'s existing "not connected" skip path (already
built for this exact contract) handles it.

Capabilities: `{ publish: true, inventory: true, batch: true, orders:
false, webhooks: false, inboundInventory: false, variants: true }`. No
order/webhook support in this run — Google Shopping isn't itself an
order-taking channel the way eBay is.

**v1beta → v1 migration (found live, 2026-09-05):** this integration was
originally written against Merchant API v1beta. Google discontinued
v1beta on 2026-02-28; a real connect attempt against the live API
surfaced this as a 409 `V1BETA_RAMP_DOWN` on `dataSources.list`, after an
earlier 400 on `dataSources.create` (`PrimaryProductDataSource.channel`
already rejecting `"ONLINE"` — v1beta was evidently rejecting some writes
even before the hard cutover). Fixed by moving both
`google.merchant.api.service.js` and `google.datasource.service.js`'s base
URLs from `/v1beta` to `/v1`, and updating every place the schema itself
changed (confirmed against Google's own migration guide and the real API
responses, not guessed):
- `PrimaryProductDataSource.channel` — **removed** in v1 (replaced by an
  optional `legacyLocal` boolean for local-only feeds; omitted here since
  this integration is never local-only).
- `ProductInput.channel` — **removed** in v1 entirely; no replacement
  needed at this level.
- `ProductAttributes.gtin` (string) → `ProductAttributes.gtins` (array) —
  `applyIdentifiers` now sends `[identifiers.gtin]`.
- The product resource id format dropped the channel segment:
  `channel~contentLanguage~feedLabel~offerId` (v1beta) →
  `contentLanguage~feedLabel~offerId` (v1) — see
  `buildProductResourceName`. Getting this one wrong is silent: a
  wrong/stale resource name 404s on delete, and `end()` already (validly)
  treats 404 as "already gone" success — so it would have looked like
  every `end()` call worked while never actually removing anything from
  Google.
- `google.controller.js#oauthCallback`'s catch block now also logs
  `err.cause` (where Node's `fetch` puts the real underlying reason for a
  generic "fetch failed" TypeError) — found live: an unrelated local
  IPv6-routing timeout to `merchantapi.googleapis.com` was indistinguishable
  from a real API rejection until this was added. Unrelated fix, applied
  alongside since it was in the same debugging session:
  `config/index.js` now sets `dns.setDefaultResultOrder("ipv4first")`
  process-wide (every entrypoint requires config first) so a broken/absent
  IPv6 route to any outbound host doesn't silently eat ~10s per call before
  falling back.

**GCP project developer registration (found live, same debugging session):**
past the v1 migration, a fresh GCP project's very first `dataSources.create`
call still failed — 401 `UNAUTHENTICATED`, reason `GCP_NOT_REGISTERED`.
Google requires a one-time `developerRegistration.registerGcp` call
(`accounts/v1/accounts/{merchantId}/developerRegistration:registerGcp`)
before ANY of a GCP project's Merchant API calls are trusted by a given
Merchant Center account — see
[the registration guide](https://developers.google.com/merchant/api/guides/quickstart/registration).
`google.datasource.service.js#createDataSource` now auto-recovers: on a
`GCP_NOT_REGISTERED` 401 specifically (never any other 401), it calls
`registerGcp` once and retries the create exactly once (a `retrying` guard
prevents any loop) — every future first-time connect self-heals through
this without needing manual intervention.

**⚠️ Real architectural constraint, not just a one-off fix** — confirmed
against Google's own docs: *"Each Google Cloud project can only be
registered with a single Merchant Center account at any given time"* —
registering a second, different account returns `ALREADY_REGISTERED`. This
app's `GOOGLE_CLIENT_ID` is **one shared GCP project across every tenant**
(mirrors `config.ebay`'s shared-app-credentials model — see §1). Under the
Merchant API's real constraints as they exist today, **that means only ONE
tenant's Merchant Center account can be connected at a time** under this
project — a second tenant's connect attempt will hit `registerGcp`'s
`ALREADY_REGISTERED` and surface a clear `GCP_REGISTRATION_CONFLICT` error
(not a silent failure) rather than actually connecting. This needs a real
decision before onboarding a second real tenant: a separate GCP project per
tenant (more setup, but straightforward), or pursuing Google's Multi-Client
Account model (the mechanism real multi-merchant platforms use), or some
other resolution — not something to route around quietly in code.

**Product decisions baked into the adapter** (not re-litigated per listing):

- **Public URL** (`listing.resolver.js#resolveProductUrl`): the storefront
  (`pha-storefront`) is a separate repo; its product route is `/product/:slug`
  (**singular** — confirmed against its `src/App.tsx`). Host resolution, in
  order: (1) the tenant's **default** verified `Domain`
  (`is_default: true`, `DOMAIN_STATUS.ACTIVE` — a non-default active domain
  does not count); (2) `<tenant.slug, hyphens stripped>.${config.payment.linkDomain}`
  — the same per-tenant host `stripe.payment.service.js#buildPaymentBaseUrl`
  already builds for payment links, reused rather than invented fresh. Throws
  — naming the SKU — only when neither resolves: no default verified `Domain`
  **and** no `PAYMENT_LINK_DOMAIN` configured, or the product has no `slug`
  at all (`Product.slug` is not a required field).
- **Identifiers** (`listing.resolver.js#resolveIdentifiers` +
  `google.adapter.js#applyIdentifiers`): `gtin` when present; else `mpn` +
  `brand` only when **both** are present; else `identifierExists: false`.
  Never invents/derives a value.
- **Untracked stock**: a product with `stock_control` off is excluded from
  Google entirely — enforced in the adapter (`isUntrackedStock`), signaled
  back to `sync.service.js` as `{ skipped: true, reason: "untracked_stock"
  }` (see §11), never published as `IN_STOCK`.
- **Availability**: `quantity > 0` → `"IN_STOCK"`; `0` → `"OUT_OF_STOCK"` —
  Merchant API v1's real ALL_CAPS enum. Originally shipped as the classic
  Content API's literal lowercase strings ("in stock"/"out of stock", the
  most-documented historical shape at the time, explicitly flagged as
  unverified — see `google.adapter.js`'s own module `NOTE`); a real
  `productInputs.insert` call confirmed that guess wrong (400
  `INVALID_ARGUMENT` on the `availability` field) and it was fixed against
  Google's own client library docs for the exact enum names.

### Services (`services/google/`)

- `google.oauth.service.js` — consent URL + code exchange + **proactive**
  token refresh, persisted to `ChannelConnection` (unlike eBay, which keeps
  access tokens purely in an in-memory per-tenant cache — see
  `ebay.api.service.js#getAccessToken` — Google's is durable across process
  restarts). A concurrent-refresh race for the same tenant is de-duplicated
  in-process via an in-flight-promise `Map` keyed by tenant id
  (`_refreshInFlight`) — two jobs racing await the SAME refresh rather than
  both hitting Google and both writing back. This is an in-process
  optimization only; two separate **worker processes** could still both
  refresh around the same moment — safe (Mongo's single-document writes are
  atomic, and a "losing" token is simply not reused past its own real
  expiry), just not fully eliminated, since that would need a Redis-backed
  distributed lock this run doesn't add.
- `google.merchant.api.service.js` — pure Merchant API HTTP layer
  (`insertProductInput`, `deleteProductInput`). No documented multi-item
  batch endpoint exists for `productInputs` (unlike the older Content API's
  `products.custombatch`) — `publishBatch` (adapter) calls this once per
  item under bounded concurrency instead of guessing at an endpoint shape
  that might not exist.
- `google.datasource.service.js` — creates/resolves the tenant's primary
  product data source. Called during **connect**
  (`google.oauth.service.js#completeConnection`), not lazily on first sync —
  a data source must exist before any push succeeds.

`packCiphertext`/`unpackCiphertext` were extracted from
`ebay.settings.service.js` (which had its own private copy) into
`utils/crypto/tokenCipher.js` as a shared, generic util — Google's new code
uses the shared version; `ebay.settings.service.js`'s own copy is
**deliberately left untouched** (this run may not edit anything under
`services/ebay/`), so it's temporarily duplicated rather than unified. A
future pass that's allowed to touch that file should switch it to import
the shared copy and delete its own.

### Batch sync (`sync_batch`)

A full catalogue sync is thousands of products — one `sync_listing` job per
product isn't acceptable for a feed channel.

- `sync.service.js#syncBatch(platform, tenantId)` reads the tenant's
  `ACTIVE` listings for a platform via a **Mongo cursor** (never loads the
  whole catalogue into memory), in chunks of
  `config.channels.batchChunkSize` (default 500, env
  `CHANNEL_BATCH_CHUNK_SIZE`).
- Per chunk: resolves each listing, re-checks each one's fencing token in
  **one batched query** (not per-item) right before dispatch — a listing
  whose `last_pushed_seq` has moved past the `push_seq` captured off the
  cursor was already synced more recently by something else (typically a
  single-listing job) and is dropped, exactly like `syncListing`'s own
  `seq < last_pushed_seq` check, just re-verified fresh instead of trusting
  a value read possibly much earlier in the cursor pass. A successful
  write uses `$max` on `last_pushed_seq`, never a blind `$set`, so it can
  never regress it backward either.
- Calls `adapter.publishBatch(resolvedChunk, settings)` **once per chunk**;
  every item's own success/failure/skip is recorded individually
  (`ChannelSyncLog` row per failure/skip; success respects
  `config.channels.logSuccesses` same as `syncListing`) — a per-item failure
  never fails the rest of the chunk, and never trips the circuit breaker
  (that's a product-data problem, not a connection-health one — only the
  *chunk dispatch call itself* throwing counts toward the breaker, in
  `syncBatch`'s own `catch`).
- Queue wiring (`channel.worker.js#attachSyncBatchProcessor`): attached only
  for an adapter with `capabilities.batch === true` and a real
  `publishBatch` export. `sync_batch` jobs carry `{ tenantId }` and get
  Bull's default auto-generated id/opts — **no debounce jobId** (that logic
  in `channel.queue.js` is keyed to the literal string `"sync_listing"`, so
  it was verified to need zero changes for a new job type to safely avoid
  it — see §11). Concurrency defaults to 1 per platform
  (`DEFAULT_BATCH_CONCURRENCY`) — a full-catalogue sync is already
  internally chunked/concurrent; running many tenants' full syncs at once
  on one platform's queue would just contend with itself.
- Triggered once, automatically, right after a successful Google connect
  (`google.controller.js#oauthCallback`) — this run doesn't add a separate
  manual "resync everything" admin route, since nothing else needed one yet
  (see that controller's own `NOTE`). A future manual-trigger route would
  just call `enqueueChannelJob(platform, "sync_batch", { tenantId })` the
  same way.

### Refresh sweep (`refresh_stale`)

Google Merchant Center expires a product that isn't refreshed within a
regular cadence — Google's own guidance: "you should update or refresh them
with a regular cadence (at least every 30 days)". This app's own sync only
fires on a stock change or at connect time, and most auto parts have stable
stock, so a listing that never changes would otherwise quietly drop off
Google after 30 days — no error, no log, nothing in the UI. Closed by:

- **`refreshIntervalDays`** — a new *optional* field on the adapter contract
  (see §1 / `registry.js`'s interface comment): `<number|null>`, the number
  of days after `synced_at` before a listing counts as stale for this
  platform. `null`/absent means "this platform never expires listings".
  Google's adapter sets it to `config.channels.refreshIntervalDays` (default
  **25** — deliberately under Google's real 30-day cap, to leave headroom
  for a missed sweep run or a transient failure before the actual deadline).
  eBay's adapter is **never edited** to add this field — absent is opt-out,
  and the scheduler/sweep both treat "missing" as that platform's explicit
  choice, so an adapter that never sets it needs zero code changes.
- **`services/marketplace/refresh.service.js#sweepStaleListings(platformKey)`**
  — for each tenant with a `ChannelConnection` for that platform, finds
  `MarketplaceListing` docs where `state: active` and
  `synced_at < now - refreshIntervalDays` via a Mongo **cursor**, chunks
  them at `config.channels.batchChunkSize` (the SAME constant `syncBatch`
  uses — no second chunk-size constant introduced), and enqueues one
  `sync_batch` job per chunk with `{ tenantId, listingIds }`. Re-uses the
  EXISTING `sync_batch` job/processor (see `sync.service.js#syncBatch`'s new
  `opts.listingIds`, additive — an existing caller passing no `listingIds`
  is unaffected and still means "every ACTIVE listing") rather than adding a
  second push mechanism, so a refresh re-push inherits that path's chunking,
  fencing (`processBatchChunk`'s existing batched re-check), circuit
  breaker wiring, and `ChannelSyncLog` rows for free.
  - `synced_at: null` (never successfully published) is explicitly excluded
    via `{ $ne: null, $lt: staleBefore }`, not just `{ $lt: staleBefore }`
    alone — MongoDB's BSON type ordering places `Null` **below** `Date`, so
    a bare `$lt` on a Date field actually matches `null` too. That listing
    belongs to the normal publish path, not this sweep.
  - Reuses the exact "not connected" (`adapter.loadSettings` resolving to
    `null`) and "breaker gated" (`circuitBreaker.isOpen`) determinations
    `sync.service.js#syncListing`/`syncBatch` already make — not
    reimplemented here — to skip a tenant whose connection isn't usable.
  - Logs one summary line per tenant (`N stale listing(s) found, M
    sync_batch job(s) enqueued`) — the only visibility into whether the
    sweep is doing anything.
  - A kill switch (`config.channels.refreshSweepEnabled`, env
    `CHANNEL_REFRESH_SWEEP_ENABLED`, default `true`) is checked FIRST, at
    sweep time — so it takes effect on the very next scheduled run with no
    restart/redeploy needed to unregister the repeatable job itself.
- **`workers/channel.worker.js#attachRefreshStaleScheduler`** — registers a
  `refresh_stale` processor + repeatable job (`config.channels.
  refreshSweepIntervalHours`, env `CHANNEL_REFRESH_SWEEP_INTERVAL_HOURS`,
  default **24** hours), following the SAME pattern as eBay's
  `poll_orders`/`poll_inventory` (`attachEbayPolling`), including the same
  stale-repeatable-schedule cleanup on boot (Bull keys a repeatable job by
  its interval, not just its jobId — changing the interval between deploys
  would otherwise register a second schedule in Redis alongside the old
  one). Attached in `startChannelWorker`'s per-adapter loop, gated ONLY on
  `adapter.refreshIntervalDays` being truthy — eBay ends up with no
  `refresh_stale` processor and no repeatable schedule at all, verified live
  (booted the worker with both adapters registered: Google's queue shows a
  `refresh_stale` repeatable job, eBay's shows only its existing
  `poll_orders`/`poll_inventory` — see the verification report).
  `refresh_stale`'s own repeatable registration calls `queue.add()` directly
  (same as `poll_orders`/`poll_inventory`), never going through
  `enqueueChannelJob`, so `channel.queue.js`'s debounce logic (keyed to the
  literal string `"sync_listing"` — see §11) never enters into it at all;
  the `sync_batch` jobs the sweep itself enqueues go through
  `enqueueChannelJob` normally but, same as the post-connect full sync,
  never match that debounce condition either.
- Shutdown: `refresh_stale`'s processor is attached to the SAME per-platform
  queue object `attachSyncListingProcessor` already pushed into
  `activeQueues` — `shutdown()`'s existing `Promise.all(activeQueues.map(q
  => q.close()))` drains it with zero changes needed there.

### Routes

`routes/google.routes.js` — OAuth connect flow only
(`GET /oauth/connect-url`, `GET /oauth/callback`), mirroring
`ebay.routes.js`'s own OAuth section. Status/logs/retry are already generic
— `GET /api/v1/channels`, `GET /api/v1/channels/:platform/logs`,
`POST /api/v1/channels/:platform/retry/:logId` all already work for Google
with zero Google-specific code, once `registerAdapters.js` registers the
adapter — that's the entire point of the generic layer built in §1–§8.

## 10. What a third channel (e.g. Meta Shop) would need

Everything in §1–§8 (queues, `ChannelSyncLog`, circuit breaker, generic
routes) — nothing there is eBay- or Google-specific, and needs zero changes.
A third adapter needs to actually build:

1. **The adapter itself** — `key`, `manifest`, `capabilities`,
   `loadSettings`, `publish`/`update`/`end`, optionally `publishBatch`. Use
   whichever generic contract fits: eBay's (`loadSettings` never `null`) if
   there's a legacy pre-`ChannelConnection` source to stay compatible with;
   Google's (`loadSettings` returns `null` for "not connected") otherwise —
   Google's is the one to default to for a genuinely new integration.
2. **Its own OAuth/credential flow** — reuse
   `utils/crypto/tokenCipher.js#packCiphertext`/`unpackCiphertext` for the
   single-string `*_ct` slots on `ChannelConnection`; do NOT hardcode a base
   URL inside any function that receives a tenant-scoped token/settings if
   the platform has more than one real environment (see
   `ebay.environment-invariants.test.js` for the eBay incident this guards
   against, and `google.environment-invariants.test.js` for the adapted
   version covering "token cached in a bare module-level variable" instead,
   for a platform with no separate environments).
3. **A `ChannelConnection` discriminator** — remember the naming-collision
   fix: register it as `"ChannelConnection<Name>"` (not the bare platform
   key), with the platform value as the 3rd argument to `.discriminator()`
   — see §8's 3rd bullet and `models/ChannelConnection.js`'s own comment.
   Same for a `MarketplaceListing` discriminator if the platform has its own
   listing-level fields.
4. **Attach `.status` to every thrown error** from the platform's own HTTP
   layer, following `circuitBreaker.js#isTransportOrAuthFailure`'s existing
   rule (>=500/401/403 counts; everything else, including no status at all
   from a well-formed rejection, doesn't) — this is what makes the breaker
   and `ChannelSyncLog` classification work correctly with zero
   platform-specific code in the generic layer.
5. **Error out loudly, never guess**, for anything the platform requires
   that this app can't currently resolve with confidence (see
   `resolveProductUrl`'s own reasoning) — a wrong/guessed value pushed live
   is worse than a clear, actionable failure.
6. Register it in `registerAdapters.js`, add its routes (OAuth + whatever
   metadata lookups it actually needs — never duplicate the generic
   `/api/v1/channels` routes), and its own `config.<platform>` block.
7. **Opt into the refresh sweep, only if this platform actually expires
   stale listings** (see §9's "Refresh sweep" subsection) — export a
   `refreshIntervalDays: <number>` field from the adapter (a sensible
   default, configurable via your own `config.<platform>` block, kept
   comfortably under whatever cadence the platform's own docs require).
   That single field is the entire integration: `refresh.service.js` and
   `channel.worker.js#attachRefreshStaleScheduler` both already key off it
   generically. Leave it unset entirely if the platform has no such
   concept (most won't) — absent/null is a real, first-class opt-out, not
   a TODO.

## 11. Generic-layer changes made for Google (eBay impact, file by file)

Every file below was touched because Google genuinely needed it (the second
group of bullets covers the later refresh-sweep addition specifically) —
per this run's own invariants, each change is additive or capability-gated,
and every existing eBay test still passes unmodified (see the verification
report). Nothing under `services/ebay/` or `adapters/ebay.adapter.js` was
touched at all.

- **`listing.resolver.js`** — added `resolveProductUrl`/`resolveIdentifiers`
  as new exports. `resolveListing` (eBay's only entry point here) is
  byte-for-byte unchanged.
- **`sync.service.js`** — added `syncBatch`/`processBatchChunk`/
  `getListingPushSeq` (new exports); added ONE new branch in `syncListing`
  gated on `ids?.skipped` (an adapter opting into the new "skip this sync
  entirely" signal) — eBay's adapter never sets this field, so the branch
  is dead code for eBay, verified by every existing eBay-path test still
  passing. Also threads `err.code` into `logSyncEvent`'s existing call
  (was always `null` before for every adapter — additive, no behavior
  change for a plain `Error`).
- **`channel.worker.js`** — added `attachSyncBatchProcessor` /
  `SYNC_BATCH_CONCURRENCY`, called only for an adapter that declares
  `capabilities.batch`. eBay's `attachSyncListingProcessor` call and its
  own concurrency/mid-flight-recovery logic are unchanged.
- **`channel.queue.js`** — **not modified**. Verified (not assumed) that
  the existing debounce condition is keyed to the literal string
  `"sync_listing"` (`jobName === "sync_listing"`), so a `"sync_batch"` job
  never matches it and never inherits the debounce jobId — no code change
  needed for this invariant to hold.
- **`registerAdapters.js`** — one added `registry.register(googleAdapter)`
  line.
- **`models/MarketplaceListing.js` / `models/ChannelConnection.js`** — new
  `google` discriminators only; the base schemas and the `ebay`
  discriminators are unchanged.
- **`constants/marketplace.constants.js`** — added `GOOGLE: "google"` to
  the enum; `EBAY` unchanged.
- **`config/index.js`** — added a `google` block; `ebay`/`channels` blocks
  unchanged.
- **`utils/crypto/tokenCipher.js`** — added `packCiphertext`/
  `unpackCiphertext` as new exports (extracted from
  `ebay.settings.service.js`'s own private copy, left in place — see §9).
  `encrypt`/`decrypt` unchanged.
- **`routes/index.js`** — one added `router.use("/google", ...)` line;
  the `/ebay` line is untouched.

**Refresh sweep (later addition, same invariants):**

- **`services/marketplace/refresh.service.js`** (new file) —
  `sweepStaleListings`, the entire sweep implementation (see §9's "Refresh
  sweep" subsection).
- **`registry.js`** — documented `refreshIntervalDays` in the interface
  comment block only; no code change (the field is read directly off
  whatever adapter object `getAdapter` returns, same as `capabilities`).
- **`adapters/google.adapter.js`** — added `refreshIntervalDays` (new
  export, reading `config.channels.refreshIntervalDays`) and the `config`
  require it needed. Nothing else in the file changed.
- **`sync.service.js`** — `syncBatch` gained an *optional*
  `opts.listingIds` filter (additive: restricts the cursor to a specific
  id set instead of "every ACTIVE listing" — an existing caller passing no
  `listingIds`, including every existing test and the post-connect full
  sync, is unaffected).
- **`channel.worker.js`** — added `attachRefreshStaleScheduler` (called
  only for `adapter.refreshIntervalDays` truthy — eBay's adapter never
  sets it, so eBay is unaffected) and threaded `job.data.listingIds`
  through `attachSyncBatchProcessor`'s existing `sync_batch` processor
  into `syncBatch`'s new opt (a job with no `listingIds`, e.g. the
  post-connect full sync, behaves exactly as before). Also added a
  `config` require (previously unused in this file).
- **`config/index.js`** — added `refreshIntervalDays` /
  `refreshSweepIntervalHours` / `refreshSweepEnabled` to the existing
  `channels` block; every other key in that block is unchanged.
- **`.env.example`** — documented the 3 new `CHANNEL_REFRESH_*` vars;
  nothing existing was changed.
