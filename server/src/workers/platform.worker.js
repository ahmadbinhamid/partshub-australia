// src/workers/platform.worker.js
//
// Merged email + search worker — both are low-volume, unrelated job types
// that don't need a dedicated process each; combined here to cut down the
// number of always-on worker containers. Processing logic is unchanged from
// the old workers/email.worker.js and workers/search.worker.js, just both
// attached in one process.

require("dotenv").config();
const { connectMongo } = require("../loaders/mongoose");
require("../models/index"); // register all schemas before any populate()/query
const { logger } = require("../loaders/logging");
const config = require("../config");

const { emailQueue } = require("../queues/email.queue");
const { render } = require("../services/email/templateLoader");
const { sendEmail } = require("../services/email/mailer");
const inventoryDigestService = require("../services/inventory-digest.service");

const { searchQueue } = require("../queues/search.queue");
const { ensureProductsCollection } = require("../services/search/product.search.schema");
const { indexProduct, deleteProductFromIndex } = require("../services/search/product.search.service");
const Product = require("../models/Product");

connectMongo().catch((err) => {
  logger.error(`[platformWorker] MongoDB connection failed: ${err.message}`);
  process.exit(1);
});

ensureProductsCollection().catch((err) => {
  logger.error(`[platformWorker] failed to ensure Typesense collection: ${err.message}`);
});

// ── email ─────────────────────────────────────────────────────────────────────

// NOTE: use the *named* processor: 'send'
emailQueue.process("send", 5, async (job) => {
  const { to, subject, template, variables, from, fromName, tenantId, text, attachments } = job.data;

  const html = render(template, variables);
  const ok = await sendEmail({ from, fromName, tenantId, to, subject, html, text, attachments });
  if (!ok) throw new Error("Failed to send email");

  return true;
});

emailQueue.isReady().then(() => logger.info("[emailQueue] ready"));
emailQueue.on("completed", (job) => logger.info(`[emailQueue] completed ${job.id}`));
emailQueue.on("failed", (job, err) => logger.error(`[emailQueue] failed ${job?.id}: ${err?.message}`));

// ── low stock digest ─────────────────────────────────────────────────────────
//
// Reuses the existing emailQueue (a distinct job name, "send" is untouched)
// rather than a whole new queue file — same reasoning channel.worker.js uses
// putting its own refresh_stale sweep on the same per-platform queue as
// sync_listing, not a separate one.

emailQueue.process("low_stock_digest_sweep", 1, async () => {
  logger.info("[emailQueue] low_stock_digest_sweep starting");
  return inventoryDigestService.sweepLowStockDigests();
});

emailQueue.isReady().then(async () => {
  // Bull keys a repeatable job by its INTERVAL, not just its jobId — clear
  // any stale schedule before re-registering, same gotcha
  // channel.worker.js#attachRefreshStaleScheduler already documents, or a
  // config change (INVENTORY_DIGEST_SWEEP_INTERVAL_MINUTES) leaves two
  // schedules running side by side in Redis.
  const existing = await emailQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === "low_stock_digest_sweep") {
      await emailQueue.removeRepeatableByKey(job.key);
      logger.info(`[emailQueue] removed stale low_stock_digest_sweep schedule: ${job.key}`);
    }
  }

  emailQueue.add(
    "low_stock_digest_sweep",
    {},
    {
      repeat: { every: config.inventory.digestSweepIntervalMinutes * 60 * 1000 },
      jobId: "low_stock_digest_sweep_repeat",
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
    },
  );
});

// ── search ────────────────────────────────────────────────────────────────────

// Re-fetches the product at process time (rather than trusting the payload)
// so a job that sat in the queue for a while still indexes the latest state.
searchQueue.process("index_product", 4, async (job) => {
  const { productId } = job.data;
  // findById already excludes soft-deleted docs (softDelete.plugin's default
  // query filter), so a null here means "deleted since this job was
  // enqueued" — clean up the index instead of throwing.
  const product = await Product.findById(productId);
  if (!product) {
    await deleteProductFromIndex(productId);
    return;
  }
  await indexProduct(product);
});

searchQueue.process("delete_product", 4, async (job) => {
  const { productId } = job.data;
  await deleteProductFromIndex(productId);
});

searchQueue.isReady().then(() => logger.info("[searchQueue] ready"));
searchQueue.on("completed", (job) => logger.info(`[searchQueue] completed job ${job.id} (${job.name})`));
searchQueue.on("failed", (job, err) => logger.error(`[searchQueue] failed job ${job?.id} (${job?.name}): ${err?.message}`));
