// services/marketplace/circuitBreaker.test.js
//
// Regression guard for Task 7: only transport/auth-level failures (5xx,
// network, 401/403) count toward the breaker — a 400-level per-item
// validation failure (bad category, missing GTIN, etc.) is a product data
// problem, not evidence the connection is unhealthy, and must never trip
// it. Also covers the explicit resume path clearing a tripped breaker.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/marketplace/circuitBreaker.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const config = require("../../config");

require("../../models/index");
const ChannelConnection = require("../../models/ChannelConnection");
const circuitBreaker = require("./circuitBreaker");

function transportError(status) {
  const err = new Error("transport failure");
  err.status = status;
  return err;
}

function validationError() {
  const err = new Error("Missing required field: GTIN");
  err.status = 400;
  return err;
}

test("circuit breaker: item validation errors never trip it, transport/auth errors do at the threshold", async (t) => {
  await mongoose.connect(config.mongoUri);

  const tenantId = new mongoose.Types.ObjectId();
  const platform = "ebay";
  const threshold = config.channels.circuitBreakerThreshold;

  // A burst of 400-level validation failures — well past the threshold —
  // must never increment consecutive_failures at all.
  for (let i = 0; i < threshold + 5; i++) {
    await circuitBreaker.recordFailure(tenantId, platform, validationError());
  }
  assert.equal(await circuitBreaker.isOpen(tenantId, platform), false, "validation errors must never open the circuit");
  const afterValidation = await ChannelConnection.findOne({ tenant_id: tenantId, platform }).lean();
  assert.equal(afterValidation, null, "validation errors that never count must never even create a ChannelConnection row");

  // Fewer than threshold transport errors — not tripped yet.
  for (let i = 0; i < threshold - 1; i++) {
    await circuitBreaker.recordFailure(tenantId, platform, transportError(503));
  }
  assert.equal(await circuitBreaker.isOpen(tenantId, platform), false, "must not trip before reaching the threshold");

  // One more (401, exercising the auth branch, not just 5xx) reaches the
  // threshold and trips it.
  const { tripped } = await circuitBreaker.recordFailure(tenantId, platform, transportError(401));
  assert.equal(tripped, true);
  assert.equal(await circuitBreaker.isOpen(tenantId, platform), true, "must be open once the threshold is reached");

  // A success does NOT resume a tripped breaker on its own — only an
  // explicit resume (or the next failure that never comes) does; recordSuccess
  // itself is what a normal successful adapter call reports, exercised on its
  // own contract here: it resets consecutive_failures and marks CONNECTED.
  await circuitBreaker.recordSuccess(tenantId, platform);
  const afterSuccess = await ChannelConnection.findOne({ tenant_id: tenantId, platform }).lean();
  assert.equal(afterSuccess.consecutive_failures, 0);
  assert.equal(afterSuccess.status, "connected");
  assert.ok(afterSuccess.last_success_at);

  // Explicit resume path — trip it again, then resume.
  for (let i = 0; i < threshold; i++) {
    await circuitBreaker.recordFailure(tenantId, platform, transportError(500));
  }
  assert.equal(await circuitBreaker.isOpen(tenantId, platform), true);
  await circuitBreaker.resume(tenantId, platform);
  assert.equal(await circuitBreaker.isOpen(tenantId, platform), false);
  const afterResume = await ChannelConnection.findOne({ tenant_id: tenantId, platform }).lean();
  assert.equal(afterResume.consecutive_failures, 0);
  assert.equal(afterResume.last_error, null);

  await ChannelConnection.deleteMany({ tenant_id: tenantId });
  await mongoose.disconnect();
});
