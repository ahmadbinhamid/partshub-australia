// services/ebay/ebay.api.condition.test.js
//
// Regression guard for Task 2's normalizeCondition fixes:
//   - "USED" must map to USED_EXCELLENT (3000, a real eBay Motors parts
//     grade), not USED_GOOD (5000, one of eBay's MEDIA grades — books,
//     DVDs, games — not accepted by most parts categories).
//   - A falsy condition must throw (naming the SKU), not silently default
//     to FOR_PARTS_OR_NOT_WORKING — a blank condition field is a listing
//     that needs attention, not a part that's actually broken.
//
// Pure function, no Mongo/Redis/network involved.
//
// Run with: node --test src/services/ebay/ebay.api.condition.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeCondition } = require("./ebay.api.service");

test('normalizeCondition("USED") === "USED_EXCELLENT"', () => {
  assert.equal(normalizeCondition("USED"), "USED_EXCELLENT");
});

test("normalizeCondition passes a specific enum value through unchanged", () => {
  assert.equal(normalizeCondition("USED_GOOD"), "USED_GOOD");
  assert.equal(normalizeCondition("NEW"), "NEW");
});

test("normalizeCondition(undefined) throws, naming the SKU when given one", () => {
  assert.throws(() => normalizeCondition(undefined, "SKU-123"), /SKU-123/);
});

test("normalizeCondition(null) throws even with no SKU available", () => {
  assert.throws(() => normalizeCondition(null), /condition is required/i);
});

test("normalizeCondition's thrown error is classified as a per-item data failure, not transport/auth", () => {
  let caught = null;
  try {
    normalizeCondition("", "SKU-456");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.equal(caught.status, 400);
});
