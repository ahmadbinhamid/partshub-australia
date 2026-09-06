// services/refund.service.ledger-violation.test.js
//
// Corrections round — the belt-and-braces invariant check (findLedgerViolation)
// now lives inside applyRefundEffects (so it covers the Stripe webhook path
// too, not just createRefund's manual branch — see refund.service.js's own
// comment there). This proves the self-healing side of it: when a refund
// that already applied its effects (restocked stock, pushed an eBay
// quantity update) turns out to violate the invariant, the auto-void must
// actually REVERSE those effects, not just flip a status flag — a refund
// whose restock was silently left in place after being "voided" would leave
// physical stock counts wrong forever.
//
// The violation is manufactured directly (a second Refund document created
// via Refund.create, bypassing createRefund's own admission validation)
// rather than raced into existence — this check exists precisely as a
// backstop against exactly this kind of bypass (a bug in the lock, a manual
// DB edit, anything), so exercising it this way is the honest way to test
// it, not a shortcut.
//
// eBay push is exercised for real (via the ebay Bull queue — no live eBay
// API call happens from enqueuing alone) rather than mocked, using the
// `ph-<productId>` fallback SKU format that resolves straight to ids
// without needing a real Product/ProductVariant document. Needs a live
// Mongo connection AND a reachable Redis (same one ebay.worker.js/
// stripe.worker.js already depend on) — run with:
//   node --test src/services/refund.service.ledger-violation.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../config");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const Refund = require("../models/Refund");
const Location = require("../models/Location");
const Inventory = require("../models/Inventory");
const MarketplaceListing = require("../models/MarketplaceListing");
const { ebayQueue } = require("../queues/ebay.queue");
const refundService = require("./refund.service");
const { REFUND_STATUS } = require("../constants/refund.constants");
const { MARKETPLACE_PLATFORM, LISTING_STATE } = require("../constants/marketplace.constants");

// fanOutMarketplaceInventory (inventory.service.js) skips any listing whose
// platform has no registered adapter (registry.has(...)) rather than
// throwing — silently, by design, so one unknown platform never aborts
// every other listing's fan-out. This test never used to register one at
// all, so its restock/reversal pushes were being silently skipped
// regardless of the MarketplaceListing/job-name fixes above — same
// registry.register pattern sync.service.fencing.test.js already uses for
// exactly this reason.
const registry = require("./marketplace/registry");
if (!registry.has(MARKETPLACE_PLATFORM.EBAY)) {
  registry.register({ key: MARKETPLACE_PLATFORM.EBAY, publish: async () => {}, update: async () => {}, end: async () => {} });
}

const UNIT_PRICE = 1000; // $10.00/unit
const LINE_QUANTITY = 2; // order has 2 units total on the one line
const TEST_TENANT_ID = new mongoose.Types.ObjectId();

// CORRECTIONS (found while investigating the full-test-suite hang — this
// file was unreachable behind an earlier stall for long enough that nobody
// had actually seen its real pass/fail status until now):
// 1. The "eBay was re-pushed" assertion below used to count raw Bull jobs
//    named "push_quantity" carrying `{ sku }` — an older, now fully
//    superseded mechanism. The current, generic, one-writer-path push (see
//    inventory.service.js#fanOutMarketplaceInventory, and
//    sync.service.fencing.test.js's own header comment on the same
//    history) enqueues a job named "sync_listing" carrying
//    `{ listingId, seq }` — no `sku` at all — and only ever fires for a
//    product that actually HAS an ACTIVE MarketplaceListing row on that
//    platform, which this test's fixture never created. Fixed by creating
//    a real ACTIVE eBay MarketplaceListing (below) and registering a fake
//    "ebay" adapter (fanOutMarketplaceInventory skips any platform with no
//    registered adapter — same pattern sync.service.fencing.test.js uses).
// 2. Even with both of those fixed, a raw job COUNT is still the wrong
//    signal — channel.queue.js#enqueueChannelJobDirect deliberately
//    debounces rapid-fire sync_listing calls for the SAME listing into ONE
//    Bull job (see channel.queue.debounce.test.js), and refund1's push,
//    refund2's apply, and refund2's reversal all target the same listing
//    within milliseconds of each other — so the final assertion checks
//    `MarketplaceListing.push_seq` instead (fanOutMarketplaceInventory
//    claims a fresh fencing token on every real attempt, unconditionally,
//    regardless of whether Bull's own debounce later collapses the
//    resulting job) — see that assertion's own comment.

test("ledger violation: effects already applied, then auto-voided — restock re-deducted and eBay re-pushed", async (t) => {
  await mongoose.connect(config.mongoUri);

  const productId = new mongoose.Types.ObjectId();
  const sku = `ph-${productId.toHexString()}`; // fallback SKU format — resolves to {productId} with no real Product doc needed
  const suffix = crypto.randomUUID();

  const location = await Location.create({ tenant_id: TEST_TENANT_ID, name: `Test Location ${suffix}` });
  const STARTING_STOCK = 10;
  const inventory = await Inventory.create({
    product: productId,
    variant: null,
    location: location._id,
    stock_count: STARTING_STOCK,
  });

  const order = await Order.create({
    tenant_id: TEST_TENANT_ID,
    order_number: `TEST-LEDGER-${suffix}`,
    invoice_number: `TEST-LEDGER-INV-${suffix}`,
    items: [
      {
        product: productId,
        variant: null,
        name: "Ledger violation test item",
        sku,
        unit_price: UNIT_PRICE,
        quantity: LINE_QUANTITY,
        discount_amount: 0,
      },
    ],
    customer: { name: "Ledger Violation Test", email: null, phone: null },
    delivery_method: "pickup",
    subtotal: UNIT_PRICE * LINE_QUANTITY,
    shipping_cost: 0,
    tax_amount: Math.round((UNIT_PRICE * LINE_QUANTITY) / 11),
    total: UNIT_PRICE * LINE_QUANTITY,
    currency: "aud",
    channel: "manual",
    payment_status: "paid",
    fulfillment_status: "pending",
    guest_access_token: crypto.randomBytes(16).toString("hex"),
  });
  order.item_ids_migrated_at = new Date();
  await order.save();
  const itemId = order.items[0]._id.toString();

  const payment = await Payment.create({
    tenant_id: TEST_TENANT_ID,
    order: order._id,
    provider: "manual",
    payment_method: "cash",
    amount: order.total,
    amount_refunded: 0,
    currency: "aud",
    status: "succeeded",
    paid_at: new Date(),
  });

  // fanOutMarketplaceInventory only ever enqueues a push for a product that
  // actually HAS an ACTIVE listing on that platform (see that function's
  // own MarketplaceListing.find query) — without this, refund1/refund2's
  // restock/reversal would silently push to nobody, regardless of job name.
  const listing = await MarketplaceListing.create({
    tenant_id: TEST_TENANT_ID,
    product: productId,
    variant: null,
    platform: MARKETPLACE_PLATFORM.EBAY,
    state: LISTING_STATE.ACTIVE,
    condition: "NEW",
  });
  const listingId = listing._id.toString();

  try {
    // ── Refund 1: legitimate, 1 of 2 units, through the real createRefund
    // path — leaves 1 unit genuinely refundable. ──────────────────────────
    const refund1 = await refundService.createRefund(
      order._id.toString(),
      {
        idempotency_key: `ledger-test-1-${suffix}`,
        scope: "line_items",
        lines: [{ order_item_id: itemId, quantity: 1, restock: true }],
        reason: "customer_request",
      },
      null,
      TEST_TENANT_ID,
    );
    assert.equal(refund1.status, REFUND_STATUS.SUCCEEDED);

    const afterRefund1 = await Inventory.findById(inventory._id);
    assert.equal(afterRefund1.stock_count, STARTING_STOCK + 1, "refund 1's restock must have credited 1 unit");

    const seqBeforeViolatingRefund = (await MarketplaceListing.findById(listing._id).select("push_seq").lean()).push_seq;

    // ── Refund 2: manufactured directly, bypassing createRefund's own
    // admission validation entirely (simulating a bug in the lock, a manual
    // DB edit — whatever gets a bad refund into "succeeded" despite already
    // exceeding the line's quantity: 1 (refund 1) + 2 (this one) = 3 > 2).
    const refundNumber = await refundService.nextRefundNumber(TEST_TENANT_ID);
    const refund2 = await Refund.create({
      tenant_id: TEST_TENANT_ID,
      order: order._id,
      payment: payment._id,
      amount: UNIT_PRICE * 2,
      reason: "customer_request",
      status: REFUND_STATUS.SUCCEEDED,
      initiated_via: "admin_api",
      initiated_by: null,
      payment_allocations: [{ payment: payment._id, amount: UNIT_PRICE * 2, provider: "manual", settled: true }],
      refund_number: refundNumber,
      scope: "line_items",
      lines: [
        {
          order_item_id: order.items[0]._id,
          sku,
          name: order.items[0].name,
          quantity: 2, // the over-claim — only 1 unit was actually left
          unit_price: UNIT_PRICE,
          line_discount: 0,
          order_discount_share: 0,
          line_amount: UNIT_PRICE * 2,
          gst_amount: Math.round((UNIT_PRICE * 2) / 11),
          restock: true,
        },
      ],
      items_amount: UNIT_PRICE * 2,
      gst_amount: Math.round((UNIT_PRICE * 2) / 11),
      total_amount: UNIT_PRICE * 2,
      idempotency_key: `ledger-test-2-${suffix}`,
    });

    // applyRefundEffects runs refund2's restock (unconditionally, before the
    // invariant check — see that function's own comment), THEN detects the
    // violation and auto-voids, reversing the restock it just applied.
    const settled = await refundService.applyRefundEffects(refund2._id);

    await t.test("the violating refund is auto-voided and flagged", () => {
      assert.equal(settled.status, REFUND_STATUS.VOIDED, "must self-heal by voiding, not leaving the ledger wrong");
      assert.equal(settled.needs_reconciliation, true, "must be flagged for admin attention, not silently voided");
    });

    await t.test("the restock refund 2 applied is fully reversed", async () => {
      const freshRefund2 = await Refund.findById(refund2._id);
      assert.equal(freshRefund2.lines[0].restock_applied_at, null, "restock_applied_at must be cleared by the void reversal");

      const finalInventory = await Inventory.findById(inventory._id);
      assert.equal(
        finalInventory.stock_count,
        STARTING_STOCK + 1,
        "final stock must reflect ONLY refund 1's restock — refund 2's +2 applied then -2 reversed nets to zero",
      );
    });

    await t.test("the order's ledger reflects only the legitimate refund 1", async () => {
      const freshOrder = await Order.findById(order._id);
      assert.equal(
        freshOrder.items[0].quantity_refunded,
        1,
        "voided refund 2 must be excluded from the recompute — only refund 1's 1 unit counts",
      );
    });

    await t.test("eBay was re-pushed for both the apply and the void reversal", async () => {
      // CORRECTED (found while investigating the full-suite hang — see the
      // module comment): a raw Bull job COUNT is the wrong signal here.
      // channel.queue.js#enqueueChannelJobDirect deliberately debounces
      // rapid-fire sync_listing calls for the SAME listing into ONE Bull
      // job (by design — see channel.queue.debounce.test.js) — refund1's
      // push, refund2's apply, and refund2's reversal all target this same
      // listing within milliseconds of each other, so they collapse to far
      // fewer raw queue entries than the number of times a push was
      // actually ATTEMPTED, and a job-count assertion here would be
      // asserting against the debounce feature itself, not against
      // anything refund.service.js does. `push_seq` is the right signal
      // instead: fanOutMarketplaceInventory claims a fresh fencing token
      // (`$inc: { push_seq: 1 }`) on every real attempt, unconditionally,
      // regardless of whether Bull ultimately collapses the resulting job
      // — exactly the "was a push attempted" fact this test cares about,
      // and immune to debounce timing, to a real background worker racing
      // to consume/remove the job before this assertion runs, or to
      // anything else about the queue's own internal state.
      const seqAfter = (await MarketplaceListing.findById(listing._id).select("push_seq").lean()).push_seq;
      assert.equal(
        seqAfter - seqBeforeViolatingRefund,
        2,
        "refund 2's own applyRefundEffects call must attempt exactly 2 pushes: one for its restock, one for the void's re-deduction",
      );
    });
  } finally {
    const jobs = await ebayQueue.getJobs(["waiting", "active", "completed", "failed", "delayed"], 0, -1);
    await Promise.all(jobs.filter((j) => j.data?.listingId === listingId).map((j) => j.remove().catch(() => {})));

    await Refund.deleteMany({ order: order._id });
    await Payment.deleteMany({ order: order._id });
    await Order.deleteOne({ _id: order._id });
    await Inventory.deleteOne({ _id: inventory._id });
    await MarketplaceListing.deleteOne({ _id: listing._id });
    await Location.deleteOne({ _id: location._id });
    // This test deliberately exercises the REAL "ebay" Bull queue (see the
    // module header) rather than mocking it — queues/ebay.queue.js's
    // `ebayQueue` is lazy now (constructed on first real access, not at
    // require time — see that file's own comment), but THIS test genuinely
    // does access it for real, so it genuinely does need closing here, same
    // as channel.worker.midflight.test.js's own precedent for a real Bull
    // queue a test opened directly.
    await ebayQueue.close();
    await mongoose.disconnect();
  }
});
