// services/ebay/ebay.catalog.service.test.js
//
// Regression guard for the sandbox/production Metadata-API URL bug: a
// sandbox-connected tenant's own (environment-specific) access token was
// being sent to eBay's PRODUCTION Metadata API — see metadataBaseFor's own
// comment in ebay.catalog.service.js for the full incident. eBay rejects
// that outright, the lookup silently failed, resolveCategoryCondition
// (ebay.adapter.js) fell back to the raw unverified condition, and the
// mismatch only ever surfaced much later at publishOffer (errorId 25021).
// Also guards the per-tenant/environment cache key so a sandbox tenant's
// cached policy list can never be served to a production tenant, or vice
// versa.
//
// No Mongo/Redis needed: getAccessToken is mocked directly (module
// property, patched BEFORE ebay.catalog.service.js is first required so
// its destructured reference picks up the mock — same pattern used
// throughout this codebase's test suite for destructured imports), and
// global.fetch is stubbed for the actual Metadata API call.
//
// Run with: node --test src/services/ebay/ebay.catalog.service.test.js

const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");

const ebayApiService = require("./ebay.api.service");
mock.method(ebayApiService, "getAccessToken", async (settings) => `fake-token-${settings.tenant_id}`);

const { getConditionPolicies } = require("./ebay.catalog.service");

const originalFetch = global.fetch;
test.after(() => {
  global.fetch = originalFetch;
});

function conditionPolicyResponse(categoryId) {
  return {
    ok: true,
    json: async () => ({
      itemConditionPolicies: [{ categoryId, conditionRequired: true, itemConditions: [{ conditionId: "1000" }] }],
    }),
  };
}

test("getConditionPolicies: settings.sandbox = true hits the SANDBOX metadata host", async () => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return conditionPolicyResponse("11111");
  };

  await getConditionPolicies("11111", {
    tenant_id: `tenant-sandbox-${Date.now()}`,
    sandbox: true,
    marketplace_id: "EBAY_AU",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api\.sandbox\.ebay\.com\//, "must hit the sandbox host, not production");
});

test("getConditionPolicies: settings.sandbox = false hits the PRODUCTION metadata host", async () => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return conditionPolicyResponse("22222");
  };

  await getConditionPolicies("22222", {
    tenant_id: `tenant-prod-${Date.now()}`,
    sandbox: false,
    marketplace_id: "EBAY_AU",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api\.ebay\.com\//, "must hit the production host, not sandbox");
  assert.doesNotMatch(calls[0], /sandbox/);
});

test("getConditionPolicies: the cache never serves a sandbox tenant's result to a production tenant", async () => {
  const sandboxTenantId = `tenant-cache-sandbox-${Date.now()}`;
  const prodTenantId = `tenant-cache-prod-${Date.now()}`;
  const categoryId = "33333";
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return conditionPolicyResponse(categoryId);
  };

  // Same categoryId, same marketplace, DIFFERENT tenant + environment.
  await getConditionPolicies(categoryId, { tenant_id: sandboxTenantId, sandbox: true, marketplace_id: "EBAY_AU" });
  await getConditionPolicies(categoryId, { tenant_id: prodTenantId, sandbox: false, marketplace_id: "EBAY_AU" });

  // If the cache key collapsed these onto the same entry, the second call
  // would never hit the network at all (served from the first's cache) —
  // both must have gone through, and to their respective hosts.
  assert.equal(calls.length, 2, "a distinct tenant+environment must never be served from another's cache entry");
  assert.match(calls[0], /^https:\/\/api\.sandbox\.ebay\.com\//);
  assert.match(calls[1], /^https:\/\/api\.ebay\.com\//);

  // Calling AGAIN for the sandbox tenant with the same category must be
  // served from ITS OWN cache (no third network call) — proves caching
  // itself still works, this isn't just "never cache anything".
  await getConditionPolicies(categoryId, { tenant_id: sandboxTenantId, sandbox: true, marketplace_id: "EBAY_AU" });
  assert.equal(calls.length, 2, "a repeat call for the same tenant+environment+category must be served from cache");
});
