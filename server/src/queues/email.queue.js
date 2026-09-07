// src/queues/email.queue.js

const Queue = require("bull");
const config = require("../config");
const { logger } = require("../loaders/logging");

const redisOpts = {
  ...(config.redis.url
    ? { url: config.redis.url }
    : { host: config.redis.host, port: config.redis.port }),
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
};

// Constructed LAZILY (on first real access to `emailQueue`, e.g.
// email.worker.js's own top-level destructure, or enqueueEmailJob's first
// call) rather than eagerly at module load. Found live: `new Queue(...)`
// opens a real ioredis connection almost immediately — a socket that
// nothing in this module (or Bull itself) ever closes — so merely
// REQUIRING this file (e.g. transitively via services/email/email.service.js,
// pulled in by product.service.js, refund.service.js, and anything else
// that just wants to send an email) was enough to leave a real Redis
// socket open for the rest of the process's life. In `npm test`'s
// `--test-concurrency=1` run (one child process per file, but that child
// process still has to actually EXIT for the runner to move to the next
// file) that open socket is exactly what was hanging both
// controllers/product.controller.fanout.test.js and
// services/refund.reconciliation.service.test.js — traced via
// process._getActiveHandles() showing a lingering `Socket` to
// 127.0.0.1:6379 after every other explicit connection (Mongo, in
// particular) had been closed. See channel.queue.js's own `getQueue` for
// the existing lazy-per-platform precedent this now matches — a
// require()-time side effect this expensive (a real network connection)
// belongs behind a call, not a bare module-level `new Queue()`.
//
// Getter-based (not a `getEmailQueue()` function) so every existing
// call site — `const { emailQueue } = require(...)` in email.worker.js /
// platform.worker.js, `emailQueue.process(...)`, `.isReady()`, `.on(...)`
// — keeps working completely unchanged; only the TIMING of construction
// moves from "at require()" to "at first property access", which for
// those workers is the exact same moment as before (their own top-level
// destructure runs immediately after requiring this module).
let _emailQueue = null;
function ensureEmailQueue() {
  if (_emailQueue) return _emailQueue;
  _emailQueue = new Queue("email", { redis: redisOpts });
  _emailQueue.on("error", (err) => {
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") return;
    logger.error("[emailQueue] unexpected error", { error: err.message, stack: err.stack });
  });
  return _emailQueue;
}

async function enqueueEmailJob(payload, opts = {}) {
  const job = ensureEmailQueue().add("send", payload, {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: true,
    timeout: 30000,
    ...opts,
  });

  // Fail fast if Redis is unreachable — don't block the request for 97s
  const deadline = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("Email queue unavailable: Redis not reachable")), 4000)
  );
  return Promise.race([job, deadline]);
}

module.exports = {
  get emailQueue() {
    return ensureEmailQueue();
  },
  enqueueEmailJob,
};
