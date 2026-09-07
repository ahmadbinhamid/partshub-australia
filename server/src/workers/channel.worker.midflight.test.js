// workers/channel.worker.midflight.test.js
//
// Regression guard for the mid-flight debounce swallow: while a
// sync_listing job for listing L is ACTIVE, a stock change's fan-out call
// (same debounced jobId `sync:<platform>:L` — see channel.queue.js) is
// silently swallowed by Bull's own "same jobId already exists" behavior —
// the active job's eventual push reflects a now-stale quantity, and
// nothing ever corrects it. recoverMidFlightChange (channel.worker.js)
// fixes this: after a job COMPLETES (successfully applied a sync), it
// re-reads the listing's current push_seq and re-enqueues if it's moved
// past the seq that job applied.
//
// Uses a REAL Bull queue (Redis) — this is fundamentally testing Bull's
// own same-jobId/event-ordering semantics (see channel.worker.js's own
// comment on the verified bull@4.16.5 ordering), which can't be faithfully
// stubbed. marketplace/sync.service's syncListing and getListingPushSeq are
// mocked directly (module properties, both accessed via property access at
// call time in channel.worker.js — not destructured — so mock timing
// relative to require order doesn't matter here). No Mongo connection is
// ever opened.
//
// Run with: node --test src/workers/channel.worker.midflight.test.js

const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const marketplaceSync = require("../services/marketplace/sync.service");
const { enqueueChannelJob } = require("../queues/channel.queue");
const { attachSyncListingProcessor } = require("./channel.worker");

// Waits `ms` beyond whatever's already happened, to give a WRONGFUL async
// side effect (a re-enqueue that shouldn't happen) a fair chance to show up
// before asserting it didn't.
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockListingPushSeq(getter) {
  mock.method(marketplaceSync, "getListingPushSeq", async () => getter());
}

test("a stock change arriving while a job is active results in a second job that pushes the newer quantity", async (t) => {
  const platform = `test-midflight-recover-${crypto.randomUUID()}`;
  const listingId = `listing-${crypto.randomUUID()}`;
  let pushSeq = 1;
  mockListingPushSeq(() => pushSeq);

  const appliedSeqs = [];
  let queue;
  mock.method(marketplaceSync, "syncListing", async (id, seq) => {
    appliedSeqs.push(seq);
    if (seq === 1) {
      // Simulate the race directly: while job 1 is "active" (i.e. right
      // here, mid-processor), a fan-out call bumps push_seq and tries to
      // enqueue under the SAME debounced jobId — confirm it's swallowed
      // (no new/second job appears) before this job goes on to complete.
      pushSeq = 2;
      const before = await queue.getJobCounts();
      await enqueueChannelJob(platform, "sync_listing", { listingId, seq: 2 });
      const after = await queue.getJobCounts();
      assert.equal(
        before.waiting + before.active + before.delayed,
        after.waiting + after.active + after.delayed,
        "an enqueue for the same listing while job 1 is active must be swallowed, not create a second job",
      );
    }
    return { ok: true };
  });

  queue = attachSyncListingProcessor({ key: platform });
  t.after(async () => {
    await queue.close();
  });

  const secondJobDone = new Promise((resolve) => {
    let completions = 0;
    queue.on("completed", () => {
      completions++;
      if (completions === 2) resolve();
    });
  });

  await enqueueChannelJob(platform, "sync_listing", { listingId, seq: 1 }, { delay: 0 });
  await secondJobDone;

  assert.deepEqual(appliedSeqs, [1, 2], "the recovered second job must apply the newer seq (2), not repeat seq 1");
});

test("no re-enqueue when push_seq equals the applied seq", async (t) => {
  const platform = `test-midflight-noop-${crypto.randomUUID()}`;
  const listingId = `listing-${crypto.randomUUID()}`;
  mockListingPushSeq(() => 7); // unchanged — matches the seq the job applies

  const appliedSeqs = [];
  mock.method(marketplaceSync, "syncListing", async (id, seq) => {
    appliedSeqs.push(seq);
    return { ok: true };
  });

  const queue = attachSyncListingProcessor({ key: platform });
  t.after(async () => {
    await queue.close();
  });

  const firstCompleted = new Promise((resolve) => queue.once("completed", resolve));
  await enqueueChannelJob(platform, "sync_listing", { listingId, seq: 7 }, { delay: 0 });
  await firstCompleted;

  // Nothing SHOULD happen after this — give a would-be wrongful
  // re-enqueue a fair chance to show up before asserting it didn't.
  await wait(300);

  assert.deepEqual(appliedSeqs, [7], "an unchanged push_seq must never trigger a recovery re-enqueue");
});

test("a failed job does not trigger a re-enqueue", async (t) => {
  const platform = `test-midflight-failed-${crypto.randomUUID()}`;
  const listingId = `listing-${crypto.randomUUID()}`;
  // Even though push_seq HAS moved past what this (failed) job would have
  // applied, a failure must never trigger recovery — retries/the circuit
  // breaker own that, not this path.
  mockListingPushSeq(() => 99);

  const appliedSeqs = [];
  mock.method(marketplaceSync, "syncListing", async (id, seq) => {
    appliedSeqs.push(seq);
    throw new Error("simulated failure");
  });

  const queue = attachSyncListingProcessor({ key: platform });
  t.after(async () => {
    await queue.close();
  });

  const failed = new Promise((resolve) => queue.once("failed", resolve));
  await enqueueChannelJob(platform, "sync_listing", { listingId, seq: 1 }, { attempts: 1, delay: 0 });
  await failed;

  await wait(300);

  assert.deepEqual(appliedSeqs, [1], "a failed job must never trigger a recovery re-enqueue, regardless of push_seq");
});
