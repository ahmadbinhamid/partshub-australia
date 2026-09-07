// queues/channel.queue.debounce.test.js
//
// Regression guard for Task 4's debounce contract: N rapid sync_listing
// enqueues for the SAME listing collapse into exactly one Bull job (keyed
// by jobId `sync:<platform>:<listingId>`, removeOnComplete: true —
// mandatory per the Bull gotcha documented in channel.queue.js), and the
// job-payload shape ({ listingId, seq }) — unchanged since before this
// migration — still round-trips through enqueueChannelJob correctly.
//
// Needs a live Redis connection (see queues/channel.queue.js) — run with:
//   node --test src/queues/channel.queue.debounce.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { enqueueChannelJob, getQueue } = require("./channel.queue");

const queue = getQueue("ebay");

// Bull's underlying ioredis client keeps its connection open indefinitely by
// design — without closing it, this process never exits on its own, which
// hangs any multi-file `node --test` run waiting on this one.
test.after(async () => {
  await queue.close();
});

test("debounced sync_listing enqueue collapses N rapid calls into one job, carrying the old {listingId, seq} payload shape", async (t) => {
  const listingId = `debounce-test-${crypto.randomUUID()}`;
  const jobId = `sync:ebay:${listingId}`;

  // Guard against a stale job left behind by a previous failed run under
  // this exact id (won't happen in practice — the id is randomized above —
  // but keeps this test self-cleaning either way).
  const preExisting = await queue.getJob(jobId);
  if (preExisting) await preExisting.remove();

  await Promise.all([
    enqueueChannelJob("ebay", "sync_listing", { listingId, seq: 1 }),
    enqueueChannelJob("ebay", "sync_listing", { listingId, seq: 2 }),
    enqueueChannelJob("ebay", "sync_listing", { listingId, seq: 3 }),
    enqueueChannelJob("ebay", "sync_listing", { listingId, seq: 4 }),
    enqueueChannelJob("ebay", "sync_listing", { listingId, seq: 5 }),
  ]);

  const job = await queue.getJob(jobId);
  assert.ok(job, "exactly one job must exist under the debounced jobId");
  assert.equal(job.opts.delay > 0, true, "the debounced job must carry a delay");
  assert.equal(job.opts.removeOnComplete, true, "removeOnComplete must be true — see channel.queue.js's Bull gotcha comment");
  // removeOnFail: true (not false) — a failed job left sitting under this
  // jobId would otherwise permanently block every future sync_listing call
  // for this listing (add() returns the existing job for a jobId present in
  // ANY state, including failed). ChannelSyncLog is the durable failure
  // record now, so nothing is lost by letting Bull drop it. See the
  // "still be re-enqueued" test below for the actual failure scenario.
  assert.equal(job.opts.removeOnFail, true);

  // Old-shape payload ({ listingId, seq }) — whichever of the N rapid calls
  // actually won the dedup, its data is still the same shape a
  // pre-migration job always carried; the worker re-reads current state
  // rather than trusting this seq anyway (see sync.service.js#syncListing).
  assert.deepEqual(Object.keys(job.data).sort(), ["listingId", "seq"].sort());
  assert.equal(job.data.listingId, listingId);

  await job.remove();
});

test("a listing whose debounced sync_listing job has failed (exhausted its retries) can still be re-enqueued", async (t) => {
  // A dedicated platform/queue (not "ebay") so this test can attach its own
  // processor and force a real failure without interfering with anything
  // else using the shared "ebay" queue.
  const platform = `test-fail-reenqueue-${crypto.randomUUID()}`;
  const listingId = `fail-reenqueue-${crypto.randomUUID()}`;
  const jobId = `sync:${platform}:${listingId}`;
  const testQueue = getQueue(platform);
  t.after(async () => {
    await testQueue.close();
  });

  let attempts = 0;
  testQueue.process("sync_listing", 1, async () => {
    attempts++;
    if (attempts === 1) throw new Error("simulated failure");
    return { ok: true };
  });

  // First enqueue: attempts:1 so it fails on the very first (and only) try,
  // no retry/backoff wait. delay:10 keeps the test fast — the debounce
  // mechanism itself isn't what's under test here.
  await enqueueChannelJob(platform, "sync_listing", { listingId }, { attempts: 1, delay: 10 });
  await new Promise((resolve) => testQueue.once("failed", resolve));
  assert.equal(attempts, 1);

  // The Bull gotcha this fixes: add() returns the EXISTING job for a jobId
  // present in ANY state, including "failed" — without removeOnFail: true
  // (and the defensive cleanup for jobs that failed before this fix
  // deployed), this second call would be silently swallowed forever and the
  // listing could never sync again, with no error raised anywhere.
  await enqueueChannelJob(platform, "sync_listing", { listingId }, { delay: 10 });

  const result = await new Promise((resolve) => testQueue.once("completed", (job, r) => resolve(r)));
  assert.equal(attempts, 2, "the re-enqueued job must have actually run a second attempt, not been dropped");
  assert.deepEqual(result, { ok: true });

  // Confirm the jobId itself isn't left stuck for a third call either.
  const afterCompletion = await testQueue.getJob(jobId);
  assert.equal(afterCompletion, null, "removeOnComplete must still clear the slot after a successful re-enqueue");
});
