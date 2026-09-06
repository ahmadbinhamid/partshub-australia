// src/queues/search.queue.js

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

// Lazy, same reasoning and same getter-based shape as email.queue.js's own
// `emailQueue` — see that file's comment for the full story (found live:
// requiring this module used to open a real, never-closed Redis socket
// immediately — this was the SECOND of the two eager queues confirmed
// hanging controllers/product.controller.fanout.test.js, alongside
// email.queue.js).
let _searchQueue = null;
function ensureSearchQueue() {
  if (_searchQueue) return _searchQueue;
  _searchQueue = new Queue("search", { redis: redisOpts });
  _searchQueue.on("error", (err) => {
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") return;
    logger.error("[searchQueue] unexpected error", { error: err.message, stack: err.stack });
  });
  return _searchQueue;
}

// Fire-and-forget from product CRUD (see product.controller.js) — a slow or
// unreachable Redis/Typesense must never block a product save.
async function enqueueSearchJob(type, payload, opts = {}) {
  const job = ensureSearchQueue().add(type, payload, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    timeout: 30_000,
    ...opts,
  });

  const deadline = new Promise((_, rej) =>
    setTimeout(
      () => rej(new Error("Search queue unavailable: Redis not reachable")),
      4000,
    ),
  );

  return Promise.race([job, deadline]);
}

module.exports = {
  get searchQueue() {
    return ensureSearchQueue();
  },
  enqueueSearchJob,
};
