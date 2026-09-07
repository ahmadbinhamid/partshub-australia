// services/marketplace/refresh.service.test.js
//
// Coverage for the stale-listing refresh sweep (see refresh.service.js's
// own module header for why this exists: Google Merchant Center expires a
// listing that isn't refreshed within 30 days, and this app's own sync only
// fires on a stock change or at connect time).
//
// Each test registers its OWN fake adapter under a unique platform key
// (crypto.randomUUID()-suffixed) directly against the registry — same
// pattern as sync.service.fencing.test.js — so nothing here touches the
// real "ebay"/"google" adapters or their real credentials.
//
// The "no query / no jobs" tests (declared-opt-out, kill switch) use
// t.mock.method (test-scoped — auto-restored when that test ends, so a
// tripwire mock can never leak into a later test in this file) to prove NO
// database call and NO enqueue happens at all — no Mongo connection is even
// opened for those two. Every other test needs a live Mongo connection
// (real ChannelConnection/MarketplaceListing documents — chunking and
// staleness-filtering correctness is exactly what's under test, so faking
// Mongoose's query/cursor internals would test less than the real thing)
// but mocks channelQueue.enqueueChannelJob throughout to avoid needing Redis.
//
// Run with: node --test src/services/marketplace/refresh.service.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../config");

require("../../models/index");
const MarketplaceListing = require("../../models/MarketplaceListing");
const ChannelConnection = require("../../models/ChannelConnection");
const { LISTING_STATE } = require("../../constants/marketplace.constants");
const { CHANNEL_CONNECTION_STATUS } = require("../../constants/channel.constants");
const registry = require("./registry");
const channelQueue = require("../../queues/channel.queue");
const { sweepStaleListings } = require("./refresh.service");

function registerFakeAdapter(platformKey, refreshIntervalDays) {
  registry.register({
    key: platformKey,
    refreshIntervalDays,
    // Mirrors the generic contract every real adapter already follows
    // (see registry.js): null for "not connected". Also treats an
    // explicitly DISCONNECTED status as "not connected" — a reasonable
    // real adapter's own check, and exactly what lets this file test the
    // "disconnected tenant is skipped" rule via ChannelConnection.status
    // rather than via "no row at all" (the only case the real Google
    // adapter itself currently distinguishes).
    async loadSettings(tenantId) {
      const conn = await ChannelConnection.findOne({ tenant_id: tenantId, platform: platformKey }).lean();
      if (!conn || conn.status === CHANNEL_CONNECTION_STATUS.DISCONNECTED) return null;
      return conn;
    },
  });
}

async function makeTenantConnection(platformKey, status = CHANNEL_CONNECTION_STATUS.CONNECTED) {
  const tenantId = new mongoose.Types.ObjectId();
  await ChannelConnection.collection.insertOne({
    tenant_id: tenantId,
    platform: platformKey,
    status,
    consecutive_failures: 0,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return tenantId;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// insertMany (not .create()) — a test-fixture platform key is never a
// registered discriminator, and Model.create() looks up a discriminator by
// the discriminatorKey value and throws "Discriminator ... not found" for
// anything unregistered; insertMany bypasses that discriminator resolution
// and just writes the base-schema fields directly, which is all these
// tests need.
async function makeListing(tenantId, platformKey, { state = LISTING_STATE.ACTIVE, syncedAt } = {}) {
  const _id = new mongoose.Types.ObjectId();
  await MarketplaceListing.insertMany([
    {
      _id,
      tenant_id: tenantId,
      product: new mongoose.Types.ObjectId(),
      variant: null,
      platform: platformKey,
      state,
      synced_at: syncedAt,
    },
  ]);
  return _id;
}

test("refresh.service: a platform whose adapter declares no refreshIntervalDays is skipped entirely — no query, no jobs enqueued", async (t) => {
  const platformKey = `test-refresh-no-cadence-${crypto.randomUUID()}`;
  registerFakeAdapter(platformKey, null);

  t.mock.method(ChannelConnection, "find", () => {
    throw new Error("must not query ChannelConnection for a platform with no refreshIntervalDays");
  });
  t.mock.method(channelQueue, "enqueueChannelJob", async () => {
    throw new Error("must not enqueue anything for a platform with no refreshIntervalDays");
  });

  const result = await sweepStaleListings(platformKey);
  assert.deepEqual(result, { skipped: true, reason: "not_applicable" });
});

test("refresh.service: the kill switch disables the sweep entirely — no query, no jobs enqueued", async (t) => {
  const platformKey = `test-refresh-kill-switch-${crypto.randomUUID()}`;
  registerFakeAdapter(platformKey, 10);

  const original = config.channels.refreshSweepEnabled;
  config.channels.refreshSweepEnabled = false;
  t.after(() => {
    config.channels.refreshSweepEnabled = original;
  });

  t.mock.method(ChannelConnection, "find", () => {
    throw new Error("must not query ChannelConnection while the kill switch is off");
  });
  t.mock.method(channelQueue, "enqueueChannelJob", async () => {
    throw new Error("must not enqueue anything while the kill switch is off");
  });

  const result = await sweepStaleListings(platformKey);
  assert.deepEqual(result, { skipped: true, reason: "sweep_disabled" });
});

test("refresh.service: listings older than the threshold are enqueued; listings inside it are not", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const platformKey = `test-refresh-threshold-${crypto.randomUUID()}`;
  registerFakeAdapter(platformKey, 10);
  const tenantId = await makeTenantConnection(platformKey);

  const staleId = await makeListing(tenantId, platformKey, { syncedAt: daysAgo(20) });
  const freshId = await makeListing(tenantId, platformKey, { syncedAt: daysAgo(2) });

  const calls = [];
  t.mock.method(channelQueue, "enqueueChannelJob", async (...args) => {
    calls.push(args);
    return { id: "fake" };
  });

  await sweepStaleListings(platformKey);

  assert.equal(calls.length, 1, "exactly one sync_batch job must be enqueued");
  const [platform, jobName, payload] = calls[0];
  assert.equal(platform, platformKey);
  assert.equal(jobName, "sync_batch");
  assert.equal(String(payload.tenantId), String(tenantId));
  const idsAsStrings = payload.listingIds.map(String);
  assert.deepEqual(idsAsStrings, [String(staleId)], "only the stale listing must be enqueued");
  assert.ok(!idsAsStrings.includes(String(freshId)), "a listing synced inside the threshold must never be enqueued");
});

test("refresh.service: a listing with synced_at: null (never published) is NOT enqueued", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const platformKey = `test-refresh-null-synced-${crypto.randomUUID()}`;
  registerFakeAdapter(platformKey, 10);
  const tenantId = await makeTenantConnection(platformKey);

  await makeListing(tenantId, platformKey, { syncedAt: null });

  const calls = [];
  t.mock.method(channelQueue, "enqueueChannelJob", async (...args) => {
    calls.push(args);
    return { id: "fake" };
  });

  await sweepStaleListings(platformKey);

  assert.equal(calls.length, 0, "a never-published listing (synced_at: null) must never be treated as stale");
});

test("refresh.service: a listing in a non-active state is NOT enqueued", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const platformKey = `test-refresh-non-active-${crypto.randomUUID()}`;
  registerFakeAdapter(platformKey, 10);
  const tenantId = await makeTenantConnection(platformKey);

  await makeListing(tenantId, platformKey, { state: LISTING_STATE.DRAFT, syncedAt: daysAgo(90) });
  await makeListing(tenantId, platformKey, { state: LISTING_STATE.ENDED, syncedAt: daysAgo(90) });

  const calls = [];
  t.mock.method(channelQueue, "enqueueChannelJob", async (...args) => {
    calls.push(args);
    return { id: "fake" };
  });

  await sweepStaleListings(platformKey);

  assert.equal(calls.length, 0, "a draft/ended listing must never be swept, no matter how old its synced_at is");
});

test("refresh.service: a tenant with a disconnected connection is skipped", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const platformKey = `test-refresh-disconnected-${crypto.randomUUID()}`;
  registerFakeAdapter(platformKey, 10);
  const tenantId = await makeTenantConnection(platformKey, CHANNEL_CONNECTION_STATUS.DISCONNECTED);
  await makeListing(tenantId, platformKey, { syncedAt: daysAgo(90) });

  const calls = [];
  t.mock.method(channelQueue, "enqueueChannelJob", async (...args) => {
    calls.push(args);
    return { id: "fake" };
  });

  await sweepStaleListings(platformKey);

  assert.equal(calls.length, 0, "a disconnected tenant's stale listings must never be enqueued");
});

test("refresh.service: a tenant with a breaker-gated (circuit open) connection is skipped", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const platformKey = `test-refresh-breaker-gated-${crypto.randomUUID()}`;
  registerFakeAdapter(platformKey, 10);
  // DEGRADED is exactly what circuitBreaker.js#isOpen checks for — reusing
  // the real circuitBreaker.isOpen (not re-implemented), so this connection
  // is otherwise perfectly "connected" from loadSettings' own point of view.
  const tenantId = await makeTenantConnection(platformKey, CHANNEL_CONNECTION_STATUS.DEGRADED);
  await makeListing(tenantId, platformKey, { syncedAt: daysAgo(90) });

  const calls = [];
  t.mock.method(channelQueue, "enqueueChannelJob", async (...args) => {
    calls.push(args);
    return { id: "fake" };
  });

  await sweepStaleListings(platformKey);

  assert.equal(calls.length, 0, "a breaker-gated tenant's stale listings must never be enqueued");
});

test("refresh.service: chunking — 1,200 stale listings at chunk size 500 produces 3 batch jobs", async (t) => {
  await mongoose.connect(config.mongoUri);
  t.after(() => mongoose.disconnect());

  const originalChunkSize = config.channels.batchChunkSize;
  config.channels.batchChunkSize = 500;
  t.after(() => {
    config.channels.batchChunkSize = originalChunkSize;
  });

  const platformKey = `test-refresh-chunking-${crypto.randomUUID()}`;
  registerFakeAdapter(platformKey, 10);
  const tenantId = await makeTenantConnection(platformKey);

  const docs = Array.from({ length: 1200 }, () => ({
    tenant_id: tenantId,
    product: new mongoose.Types.ObjectId(),
    variant: null,
    platform: platformKey,
    state: LISTING_STATE.ACTIVE,
    synced_at: daysAgo(90),
    sync_status: "synced",
    push_seq: 0,
    last_pushed_seq: 0,
  }));
  await MarketplaceListing.insertMany(docs);

  const calls = [];
  t.mock.method(channelQueue, "enqueueChannelJob", async (...args) => {
    calls.push(args);
    return { id: "fake" };
  });

  await sweepStaleListings(platformKey);

  assert.equal(calls.length, 3, "1200 stale listings at a chunk size of 500 must produce exactly 3 sync_batch jobs");
  const chunkSizes = calls.map(([, , payload]) => payload.listingIds.length).sort((a, b) => b - a);
  assert.deepEqual(chunkSizes, [500, 500, 200]);

  const allIds = new Set(calls.flatMap(([, , payload]) => payload.listingIds.map(String)));
  assert.equal(allIds.size, 1200, "every stale listing must be enqueued exactly once, across all chunks");
});

test("refresh.service: refresh_stale (and the sync_batch jobs it enqueues) never collapse into the sync_listing debounce jobId", async (t) => {
  const platform = `test-refresh-debounce-${crypto.randomUUID()}`;
  const queue = channelQueue.getQueue(platform);
  t.after(() => queue.close());

  // channel.queue.js's debounce condition is keyed to the literal string
  // "sync_listing" (verified by reading that file — see
  // refresh.service.js's own comment) — a "refresh_stale" (or "sync_batch")
  // job name never matches it, so two enqueues never collapse into one
  // debounced jobId the way two sync_listing calls for the same listing
  // would. Proven directly here rather than assumed: two back-to-back
  // enqueues under each job name must get two DISTINCT Bull job ids.
  const refreshJobA = await channelQueue.enqueueChannelJobDirect(platform, "refresh_stale", {}, { delay: 0 });
  const refreshJobB = await channelQueue.enqueueChannelJobDirect(platform, "refresh_stale", {}, { delay: 0 });
  assert.notEqual(refreshJobA.id, refreshJobB.id, "two refresh_stale enqueues must never collapse into the same jobId");

  const batchJobA = await channelQueue.enqueueChannelJobDirect(platform, "sync_batch", { tenantId: "t1", listingIds: ["a"] }, { delay: 0 });
  const batchJobB = await channelQueue.enqueueChannelJobDirect(platform, "sync_batch", { tenantId: "t1", listingIds: ["a"] }, { delay: 0 });
  assert.notEqual(batchJobA.id, batchJobB.id, "two sync_batch enqueues (even with identical payloads) must never collapse into the same jobId");
});
