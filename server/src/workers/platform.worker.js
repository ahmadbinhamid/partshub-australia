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

const { emailQueue } = require("../queues/email.queue");
const { render } = require("../services/email/templateLoader");
const { sendEmail } = require("../services/email/mailer");

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
