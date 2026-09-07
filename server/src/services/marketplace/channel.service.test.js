// services/marketplace/channel.service.test.js
//
// Regression guard: POST /api/v1/channels/:platform/retry/:logId
// (channel.service.js#retryChannelLog) must always actually enqueue a job —
// even when a failed job for that exact listing is still sitting under the
// debounced jobId (`sync:<platform>:<listingId>`). retryChannelLog bypasses
// the debounce entirely (see channel.queue.js's bypassDebounce option)
// specifically so a manual retry is never silently swallowed by whatever
// state that jobId happens to be in.
//
// Needs a live Mongo connection AND a reachable Redis — run with:
//   node --test src/services/marketplace/channel.service.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../config");

require("../../models/index");
const ChannelSyncLog = require("../../models/ChannelSyncLog");
const { getQueue } = require("../../queues/channel.queue");
const { retryChannelLog } = require("./channel.service");
const { CHANNEL_SYNC_LOG_STATUS } = require("../../constants/channel.constants");

test("retryChannelLog enqueues a fresh job even when a failed job for that listing already exists", async (t) => {
  await mongoose.connect(config.mongoUri);

  const platform = `test-retry-${crypto.randomUUID()}`;
  const tenantId = new mongoose.Types.ObjectId();
  const listingId = new mongoose.Types.ObjectId();
  const jobId = `sync:${platform}:${listingId.toString()}`;
  const queue = getQueue(platform);
  t.after(async () => {
    await queue.close();
    await mongoose.disconnect();
  });

  // Force a job into the FAILED state under the debounced jobId for this
  // listing — added directly (not via enqueueChannelJob) with
  // removeOnFail: false so it's guaranteed to still be sitting there,
  // unambiguously reproducing "a failed job for that listing already
  // exists" rather than relying on timing against the queue's own cleanup.
  queue.process("sync_listing", 1, async () => {
    throw new Error("boom");
  });
  await queue.add(
    "sync_listing",
    { listingId: listingId.toString() },
    { jobId, attempts: 1, removeOnFail: false },
  );
  await new Promise((resolve) => queue.once("failed", resolve));

  const stuckJob = await queue.getJob(jobId);
  assert.ok(stuckJob, "sanity check: the failed job must still be sitting there under the debounced jobId");
  assert.equal(await stuckJob.getState(), "failed");

  const log = await ChannelSyncLog.create({
    tenant_id: tenantId,
    platform,
    job_type: "update",
    entity_type: "MarketplaceListing",
    entity_id: listingId,
    status: CHANNEL_SYNC_LOG_STATUS.FAILURE,
    error_message: "boom",
  });

  const result = await retryChannelLog(tenantId, platform, log._id);
  assert.equal(result.requeued, true);
  assert.equal(result.listingId, listingId.toString());

  // The retry must have actually created a NEW, runnable job — not been
  // silently swallowed by the pre-existing failed job's jobId.
  const jobCounts = await queue.getJobCounts();
  assert.ok(
    jobCounts.waiting + jobCounts.active + jobCounts.delayed >= 1,
    "retry must enqueue a real, runnable job rather than being dropped",
  );

  // And it must not have needed (or touched) the debounced jobId at all —
  // the stuck failed job is still exactly where it was.
  const stillStuck = await queue.getJob(jobId);
  assert.ok(stillStuck);
  assert.equal(await stillStuck.getState(), "failed");

  await ChannelSyncLog.deleteMany({ tenant_id: tenantId });
});
