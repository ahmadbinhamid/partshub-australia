// services/marketplace/adapters/ebay.adapter.condition.test.js
//
// Regression guard for Task 1's core fix: resolveCategoryCondition must
// stop treating "we could not verify this condition" and "we verified it
// and it's fine" as the same outcome. Before this fix, an empty policy list
// or a lookup that threw both silently fell back to the raw, unverified
// condition and let it through to eBay, which only ever caught the
// mismatch much later at publishOffer (errorId 25021) — see the function's
// own comment in ebay.adapter.js for the incident that exposed it.
//
// No Mongo/Redis needed: getConditionPolicies (ebay.catalog.service.js) is
// mocked directly (module property, patched BEFORE ebay.adapter.js is
// first required so its destructured reference picks up the mock — same
// pattern used throughout this codebase's test suite for destructured
// imports). circuitBreaker.js is required only for its pure, synchronous
// isTransportOrAuthFailure classifier — requiring it (a Mongoose model
// definition, not a query) needs no live connection.
//
// Run with: node --test src/services/marketplace/adapters/ebay.adapter.condition.test.js

const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");

const catalogService = require("../../ebay/ebay.catalog.service");
const getConditionPoliciesMock = mock.method(catalogService, "getConditionPolicies", async () => ({ conditions: [] }));

const loggingModule = require("../../../loaders/logging");
const warnSpy = mock.method(loggingModule.logger, "warn", () => {});

const { resolveCategoryCondition, ConditionUnverifiedError } = require("./ebay.adapter");
const circuitBreaker = require("../circuitBreaker");

const FAKE_SETTINGS = { tenant_id: "t1", marketplace_id: "EBAY_AU", sandbox: false };

test("policy list contains the fallback condition -> used as-is, no warning logged", async () => {
  warnSpy.mock.resetCalls();
  getConditionPoliciesMock.mock.mockImplementation(async () => ({
    conditions: [{ conditionId: "USED_GOOD" }, { conditionId: "NEW" }],
  }));

  const result = await resolveCategoryCondition("NEW", "12345", FAKE_SETTINGS, "SKU-1");
  assert.equal(result, "NEW");
  assert.equal(warnSpy.mock.callCount(), 0, "the verified happy path must stay silent");
});

test("policy list excludes USED_GOOD but includes USED_EXCELLENT -> USED_EXCELLENT chosen", async () => {
  warnSpy.mock.resetCalls();
  getConditionPoliciesMock.mock.mockImplementation(async () => ({
    conditions: [{ conditionId: "USED_EXCELLENT" }, { conditionId: "USED_ACCEPTABLE" }],
  }));

  // Raw stored condition is the SPECIFIC enum "USED_GOOD" (passes through
  // normalizeCondition unchanged — only the generic "USED" gets remapped,
  // see Task 2), which this category's policy list doesn't accept — forces
  // the CONDITION_FALLBACK_ORDER.used search, which (post Task 2's
  // reordering) must land on USED_EXCELLENT (a real parts grade), not
  // whatever the old media-grade-first order would have picked.
  const result = await resolveCategoryCondition("USED_GOOD", "12345", FAKE_SETTINGS, "SKU-2");
  assert.equal(result, "USED_EXCELLENT");
  assert.equal(warnSpy.mock.callCount(), 1, "picking a fallback within the family is worth a warning");
});

test("empty policy list -> throws ConditionUnverifiedError classified as a per-item data failure, not transport/auth", async () => {
  warnSpy.mock.resetCalls();
  getConditionPoliciesMock.mock.mockImplementation(async () => ({ conditions: [] }));

  await assert.rejects(
    () => resolveCategoryCondition("NEW", "12345", FAKE_SETTINGS, "SKU-3"),
    (err) => {
      assert.ok(err instanceof ConditionUnverifiedError);
      assert.equal(err.code, "CONDITION_UNVERIFIED");
      assert.equal(err.status, 400);
      // This is the assertion that actually matters for the circuit
      // breaker: a bad/unverifiable condition on ONE listing must never
      // count toward pausing sync for every other listing on this tenant.
      assert.equal(circuitBreaker.isTransportOrAuthFailure(err), false, "must NOT count toward the circuit breaker");
      return true;
    },
  );
  assert.ok(warnSpy.mock.callCount() >= 1, "an unverified condition must be logged, not just thrown silently");
});

test("policy lookup throws -> same treatment as an empty list", async () => {
  warnSpy.mock.resetCalls();
  getConditionPoliciesMock.mock.mockImplementation(async () => {
    throw new Error("network blip");
  });

  await assert.rejects(
    () => resolveCategoryCondition("NEW", "12345", FAKE_SETTINGS, "SKU-4"),
    (err) => {
      assert.ok(err instanceof ConditionUnverifiedError);
      assert.equal(err.code, "CONDITION_UNVERIFIED");
      assert.equal(err.status, 400);
      assert.match(err.message, /network blip/, "the underlying lookup error must be visible in the thrown message");
      assert.equal(circuitBreaker.isTransportOrAuthFailure(err), false);
      return true;
    },
  );
  assert.ok(warnSpy.mock.callCount() >= 1);
});
