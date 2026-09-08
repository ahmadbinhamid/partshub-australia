// services/inventory-digest.service.test.js
//
// The sweep + per-tenant send-time/dedup logic. Mocks emailService's own
// sendLowStockDigest (never touches a real Redis/SMTP path) so these tests
// only exercise inventory-digest.service.js's own decision logic — same
// mocking boundary refresh.service.js's own test suite uses for its
// downstream sync call.
//
// notification_send_time is compared against the REAL current UTC clock
// (no injected "now" — matches refresh.service.js, which doesn't have one
// either), so fixtures set their send_time relative to Date.now() rather
// than a fixed clock value.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/inventory-digest.service.test.js

const test = require("node:test");
const { before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../config");

const InventorySettings = require("../models/InventorySettings");
const Product = require("../models/Product");
const Inventory = require("../models/Inventory");
const Location = require("../models/Location");

const emailServiceModule = require("./email/email.service");

// A single connection for the whole file rather than per-test connect/
// disconnect: node:test runs multiple t.after() hooks in REGISTRATION order
// (not LIFO), so a per-test `t.after(() => mongoose.disconnect())` registered
// early would fire before a later-registered cleanup delete, breaking it.
before(() => mongoose.connect(config.mongoUri));
after(() => mongoose.disconnect());

function hhmm(date) {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

async function makeLowStockFixture(tenantId, threshold = 5) {
  const location = await Location.create({ tenant_id: tenantId, name: `Digest test loc ${crypto.randomUUID()}` });
  const product = await Product.create({
    tenant_id: tenantId,
    title: `Digest test product ${crypto.randomUUID()}`,
    slug: `digest-test-${crypto.randomUUID()}`,
    sku: `DIG-${crypto.randomUUID()}`,
    price: 10,
    status: "active",
  });
  await Inventory.create({ product: product._id, variant: null, location: location._id, stock_count: threshold - 1 });
  return { location, product };
}

test("inventory-digest.service: kill switch — no query, no send, when digestSweepEnabled is false", async (t) => {
  const originalEnabled = config.inventory.digestSweepEnabled;
  config.inventory.digestSweepEnabled = false;
  t.after(() => {
    config.inventory.digestSweepEnabled = originalEnabled;
  });

  const findSpy = mock.method(InventorySettings, "find", () => {
    throw new Error("must not query InventorySettings when the sweep is disabled");
  });
  t.after(() => findSpy.mock.restore());

  // Fresh require AFTER the config flip and the mock are both in place —
  // sweepLowStockDigests reads config.inventory.digestSweepEnabled at call
  // time (module-level `require("../config")` returns the same live object
  // either way, since Node caches modules by reference).
  const { sweepLowStockDigests } = require("./inventory-digest.service");
  const result = await sweepLowStockDigests();

  assert.deepEqual(result, { skipped: true, reason: "sweep_disabled" });
});

test("inventory-digest.service: not due yet — never sends, never stamps last_digest_sent_at", async (t) => {
  const { maybeSendDigest } = require("./inventory-digest.service");
  const sendSpy = mock.method(emailServiceModule, "sendLowStockDigest", async () => {
    throw new Error("must not be called — this tenant is not due yet");
  });
  t.after(() => sendSpy.mock.restore());

  const tenantId = new mongoose.Types.ObjectId();
  // 2 hours in the future (UTC) — never "due" relative to nowMinutes.
  const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const settings = await InventorySettings.create({
    tenant_id: tenantId,
    email_notifications: true,
    notification_email: "owner@example.com",
    notification_send_time: hhmm(future),
    low_stock_threshold: 5,
  });
  t.after(() => InventorySettings.deleteOne({ _id: settings._id }));

  const now = new Date();
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const result = await maybeSendDigest(settings, nowMinutes, today);
  assert.equal(result, "not_due");
  assert.equal(sendSpy.mock.calls.length, 0);

  const fresh = await InventorySettings.findById(settings._id);
  assert.equal(fresh.last_digest_sent_at, null);
});

test("inventory-digest.service: due now, has low stock — sends once with the right items, stamps last_digest_sent_at", async (t) => {
  const { maybeSendDigest } = require("./inventory-digest.service");
  const sendSpy = mock.method(emailServiceModule, "sendLowStockDigest", async () => ({ queued: true }));
  t.after(() => sendSpy.mock.restore());

  const tenantId = new mongoose.Types.ObjectId();
  const { product } = await makeLowStockFixture(tenantId, 5);
  t.after(async () => {
    await Product.deleteOne({ _id: product._id });
    await Inventory.deleteMany({ product: product._id });
  });

  const now = new Date();
  const settings = await InventorySettings.create({
    tenant_id: tenantId,
    email_notifications: true,
    notification_email: "owner@example.com",
    notification_send_time: hhmm(now),
    low_stock_threshold: 5,
  });
  t.after(() => InventorySettings.deleteOne({ _id: settings._id }));

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const result = await maybeSendDigest(settings, nowMinutes, today);
  assert.equal(result, "sent");
  assert.equal(sendSpy.mock.calls.length, 1);
  const callArgs = sendSpy.mock.calls[0].arguments[0];
  assert.equal(callArgs.to, "owner@example.com");
  assert.equal(callArgs.tenantId.toString(), tenantId.toString());
  assert.ok(callArgs.items.some((i) => i.title === product.title));

  const fresh = await InventorySettings.findById(settings._id);
  assert.ok(fresh.last_digest_sent_at, "last_digest_sent_at must be stamped after a real send");
});

test("inventory-digest.service: due now, zero low-stock items — no send, but still stamps (dedup for the day)", async (t) => {
  const { maybeSendDigest } = require("./inventory-digest.service");
  const sendSpy = mock.method(emailServiceModule, "sendLowStockDigest", async () => {
    throw new Error("must not be called — zero items are low stock");
  });
  t.after(() => sendSpy.mock.restore());

  const tenantId = new mongoose.Types.ObjectId();
  const now = new Date();
  const settings = await InventorySettings.create({
    tenant_id: tenantId,
    email_notifications: true,
    notification_email: "owner@example.com",
    notification_send_time: hhmm(now),
    low_stock_threshold: 5,
  });
  t.after(() => InventorySettings.deleteOne({ _id: settings._id }));

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const result = await maybeSendDigest(settings, nowMinutes, today);
  assert.equal(result, "no_low_stock");
  assert.equal(sendSpy.mock.calls.length, 0);

  const fresh = await InventorySettings.findById(settings._id);
  assert.ok(fresh.last_digest_sent_at, "still stamped even with zero items, so this tenant isn't re-checked all day");
});

test("inventory-digest.service: dedup — already sent today, does not send again even though the time matches", async (t) => {
  const { maybeSendDigest } = require("./inventory-digest.service");
  const sendSpy = mock.method(emailServiceModule, "sendLowStockDigest", async () => {
    throw new Error("must not be called — already sent today");
  });
  t.after(() => sendSpy.mock.restore());

  const tenantId = new mongoose.Types.ObjectId();
  const now = new Date();
  const settings = await InventorySettings.create({
    tenant_id: tenantId,
    email_notifications: true,
    notification_email: "owner@example.com",
    notification_send_time: hhmm(now),
    low_stock_threshold: 5,
    last_digest_sent_at: new Date(now.getTime() - 60 * 1000), // 1 min ago, same day
  });
  t.after(() => InventorySettings.deleteOne({ _id: settings._id }));

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const result = await maybeSendDigest(settings, nowMinutes, today);
  assert.equal(result, "already_sent_today");
  assert.equal(sendSpy.mock.calls.length, 0);
});

test("inventory-digest.service: dedup resets across a day rollover — sent yesterday sends again today", async (t) => {
  const { maybeSendDigest } = require("./inventory-digest.service");
  const sendSpy = mock.method(emailServiceModule, "sendLowStockDigest", async () => ({ queued: true }));
  t.after(() => sendSpy.mock.restore());

  const tenantId = new mongoose.Types.ObjectId();
  const { product } = await makeLowStockFixture(tenantId, 5);
  t.after(async () => {
    await Product.deleteOne({ _id: product._id });
    await Inventory.deleteMany({ product: product._id });
  });

  const now = new Date();
  const settings = await InventorySettings.create({
    tenant_id: tenantId,
    email_notifications: true,
    notification_email: "owner@example.com",
    notification_send_time: hhmm(now),
    low_stock_threshold: 5,
    last_digest_sent_at: new Date(now.getTime() - 25 * 60 * 60 * 1000), // > 24h ago
  });
  t.after(() => InventorySettings.deleteOne({ _id: settings._id }));

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const result = await maybeSendDigest(settings, nowMinutes, today);
  assert.equal(result, "sent");
  assert.equal(sendSpy.mock.calls.length, 1);
});

test("inventory-digest.service: notification_email empty — skips with no send, even though email_notifications is on", async (t) => {
  const { maybeSendDigest } = require("./inventory-digest.service");
  const sendSpy = mock.method(emailServiceModule, "sendLowStockDigest", async () => {
    throw new Error("must not be called — no recipient configured");
  });
  t.after(() => sendSpy.mock.restore());

  const tenantId = new mongoose.Types.ObjectId();
  const now = new Date();
  const settings = await InventorySettings.create({
    tenant_id: tenantId,
    email_notifications: true,
    notification_email: null,
    notification_send_time: hhmm(now),
    low_stock_threshold: 5,
  });
  t.after(() => InventorySettings.deleteOne({ _id: settings._id }));

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const result = await maybeSendDigest(settings, nowMinutes, today);
  assert.equal(result, "no_recipient");
  assert.equal(sendSpy.mock.calls.length, 0);
});

test("inventory-digest.service: full sweep — one tenant's failure does not block another tenant's send", async (t) => {
  const inventoryServiceModule = require("./inventory.service");
  const sendSpy = mock.method(emailServiceModule, "sendLowStockDigest", async () => ({ queued: true }));
  t.after(() => sendSpy.mock.restore());

  const tenantBad = new mongoose.Types.ObjectId();
  const tenantGood = new mongoose.Types.ObjectId();
  const { product: goodProduct } = await makeLowStockFixture(tenantGood, 5);
  t.after(async () => {
    await Product.deleteOne({ _id: goodProduct._id });
    await Inventory.deleteMany({ product: goodProduct._id });
  });

  const now = new Date();
  const settingsBad = await InventorySettings.create({
    tenant_id: tenantBad,
    email_notifications: true,
    notification_email: "bad@example.com",
    notification_send_time: hhmm(now),
    low_stock_threshold: 5,
  });
  const settingsGood = await InventorySettings.create({
    tenant_id: tenantGood,
    email_notifications: true,
    notification_email: "good@example.com",
    notification_send_time: hhmm(now),
    low_stock_threshold: 5,
  });
  t.after(async () => {
    await InventorySettings.deleteMany({ _id: { $in: [settingsBad._id, settingsGood._id] } });
  });

  const originalGetLowStockItems = inventoryServiceModule.getLowStockItems.bind(inventoryServiceModule);
  const getLowStockSpy = mock.method(inventoryServiceModule, "getLowStockItems", async (tenantId, threshold) => {
    if (tenantId.toString() === tenantBad.toString()) {
      throw new Error("simulated DB failure for tenantBad");
    }
    return originalGetLowStockItems(tenantId, threshold);
  });
  t.after(() => getLowStockSpy.mock.restore());

  const { sweepLowStockDigests } = require("./inventory-digest.service");
  const result = await sweepLowStockDigests();

  assert.equal(result.sent, 1, "the good tenant must still get its digest");
  assert.equal(result.errored, 1, "the bad tenant's failure must be counted, not swallowed silently or thrown");
});
