// services/marketplace/registry.js
//
// Adapter registry. Each platform registers itself at startup; the sync
// dispatcher resolves the right adapter by listing.platform at runtime.
//
// Every adapter is expected to export (see adapters/ebay.adapter.js for the
// reference implementation):
//   key            - platform key, e.g. "ebay"
//   manifest       - { key, name, logo, description, status, authType, setupSteps, requiredTenantData,
//                      requiresStorefront }
//                      requiresStorefront - optional <boolean>, default false.
//                      Declares that this platform needs the tenant to have
//                      a verified storefront domain of their own before it
//                      can work at all (Google Shopping: Merchant Center
//                      requires a claimed+verified website — see
//                      google.adapter.js's manifest and
//                      services/marketplace/channel.service.js#listChannelsForTenant,
//                      which marks the channel unavailable with a reason
//                      instead of letting a tenant connect and silently get
//                      every product disapproved). Absent means false — an
//                      adapter that doesn't need one (eBay) needs zero
//                      changes.
//   capabilities   - { publish, inventory, batch, orders, webhooks, inboundInventory, variants }
//   loadSettings(tenantId) -> resolved connection/settings object, or null
//   publish(...) / update(...) / end(...)
//   publishBatch(...)        - optional
//   refreshIntervalDays      - optional <number|null>. Declares that this
//                              platform expires a listing that isn't
//                              refreshed within this many days (e.g. Google
//                              Merchant Center: 30 — see
//                              services/marketplace/refresh.service.js's own
//                              module header for the incident this closes).
//                              null/absent means "this platform never
//                              expires listings" (eBay) — the refresh sweep
//                              (refresh.service.js, wired in
//                              workers/channel.worker.js) treats a missing
//                              field as opt-out, so an adapter that never
//                              sets this needs zero changes.

const adapters = new Map();

function register(adapter) {
  if (!adapter.key) throw new Error("Marketplace adapter must have a key property");
  adapters.set(adapter.key, adapter);
}

function has(platform) {
  return adapters.has(platform);
}

function getAdapter(platform) {
  const adapter = adapters.get(platform);
  if (!adapter) throw new Error(`No marketplace adapter registered for: ${platform}`);
  return adapter;
}

// Every registered adapter's manifest — used by GET /api/v1/channels to
// present the full catalogue of platforms (connected or not) to the tenant.
function list() {
  return Array.from(adapters.values()).map((adapter) => adapter.manifest);
}

// Every registered adapter object itself (not just its manifest) — used by
// workers/channel.worker.js to attach a queue processor per platform.
function getAll() {
  return Array.from(adapters.values());
}

// Alias kept for readability at call sites that are really asking "give me
// the adapter for this platform" (getAdapter) vs. "get(key)" per the task's
// own naming — same function.
function get(platform) {
  return getAdapter(platform);
}

module.exports = { register, has, getAdapter, get, list, getAll };
