// src/workers/ebay.worker.js
//
// Thin delegate to workers/channel.worker.js, restricted to the "ebay"
// platform — kept as a separate entry point so the OLD docker-compose
// (worker-ebay: node src/workers/ebay.worker.js) keeps booting correctly if
// deployed before the compose change (worker-ebay -> worker-channels)
// lands. All actual job processing (sync_listing, poll_orders,
// poll_inventory) lives in channel.worker.js now.

const { startChannelWorker, shutdown } = require("./channel.worker");
const { logger } = require("../loaders/logging");

startChannelWorker({ platforms: ["ebay"] }).catch((err) => {
  logger.error(`[ebayWorker] failed to start: ${err.message}`);
  process.exit(1);
});

// NOTE (lint fix): see channel.worker.js's own identical comment —
// shutdown() already contains its own try/catch + process.exit(), so this
// never actually rejects.
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
