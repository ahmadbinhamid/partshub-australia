// src/queues/stripe.queue.js

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
// immediately, which was hanging test files that only wanted an unrelated
// service several requires away from this one).
let _stripeQueue = null;
function ensureStripeQueue() {
  if (_stripeQueue) return _stripeQueue;
  _stripeQueue = new Queue("stripe", { redis: redisOpts });
  _stripeQueue.on("error", (err) => {
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") return;
    logger.error("[stripeQueue] unexpected error", { error: err.message, stack: err.stack });
  });
  return _stripeQueue;
}

module.exports = {
  get stripeQueue() {
    return ensureStripeQueue();
  },
};
