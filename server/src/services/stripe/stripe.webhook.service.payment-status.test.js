// services/stripe/stripe.webhook.service.payment-status.test.js
//
// Regression test for a real bug found live (not in this test suite):
// handlePaymentSucceeded — the ONE webhook that marks a storefront order (or
// a manual order's payment-link top-up) as paid — only ever wrote the
// LEGACY `order.status` field. It never wrote `order.payment_status`, the
// field refund.service.js#createRefund's admission check actually gates on
// (REFUNDABLE_PAYMENT_STATUSES). payment_status stays stuck at its schema
// default ("pending_payment") for every order paid through this path,
// forever — meaning a fully, genuinely paid order was silently unrefundable
// through the entire redesigned refund system. The same gap existed in
// createManualOrder, recordOrderPayment, and the eBay order importer.
//
// This is exactly why none of the other refund test files caught it: every
// one of them hand-constructs its Order fixture with payment_status: "paid"
// set directly, bypassing the real order lifecycle entirely. This test
// deliberately does NOT do that — it creates an order the way
// createStorefrontOrder would (payment_status left at its default), then
// drives the REAL handlePaymentSucceeded webhook handler, then proves a
// refund can actually be admitted afterward — reproducing the live bug
// end-to-end and proving the fix closes it.
//
// Needs a live Mongo connection — run with:
//   node --test src/services/stripe/stripe.webhook.service.payment-status.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const config = require("../../config");
const Order = require("../../models/Order");
const Payment = require("../../models/Payment");
const Refund = require("../../models/Refund");
const stripeKeysService = require("../stripe/stripe.keys.service");
const { ORDER_PAYMENT_STATUS } = require("../../constants/order.constants");
// This test drives the REAL handlePaymentSucceeded webhook handler, which
// really does send an order-confirmation email (services/email/email.service.js
// -> queues/email.queue.js) — a genuine, real Bull queue gets constructed
// (lazily, on that first real send — see email.queue.js's own comment on
// why it's lazy at all now), not a mock. `.close()` it in `finally` below,
// same as refund.service.ledger-violation.test.js does for its own genuine
// use of the real "ebay" queue — found live: without this, the process
// never exits on its own (confirmed via process._getActiveHandles()
// showing 3 lingering Sockets, matching Bull's own client/subscriber/bclient
// connections for one Queue instance), which was hanging the full suite at
// exactly this file. Deliberately NOT destructured up here — that would
// force eager construction at module load for a queue this file might not
// even end up using, exactly what email.queue.js's own laziness exists to
// avoid; accessed once, in `finally`, only after it's already certain the
// queue was actually used.
const emailQueueModule = require("../../queues/email.queue");

test("handlePaymentSucceeded sets payment_status, not just the legacy status field", async (t) => {
  await mongoose.connect(config.mongoUri);

  // list() must be a plain (non-async) function returning something that's
  // BOTH thenable (for `await stripe.refunds.list(...)`) and directly
  // async-iterable (for findExistingStripeRefund's `for await` auto-
  // pagination) on the same value — see stripe.webhook.service.fixture.test.js's
  // makeListResponse for the full reasoning (a hang and a "not async
  // iterable" TypeError were both hit live building that mock the first
  // time).
  function makeListResponse(items) {
    const response = {
      data: items,
      async *[Symbol.asyncIterator]() {
        for (const item of items) yield item;
      },
    };
    response.then = (resolve) => resolve({ data: items });
    return response;
  }
  t.mock.method(stripeKeysService, "getStripeClient", async () => ({
    paymentIntents: {
      retrieve: async () => ({ payment_method: null }),
    },
    refunds: {
      list: () => makeListResponse([]),
      create: async () => ({ id: `re_test_${crypto.randomUUID()}` }),
    },
  }));
  const refundService = require("../refund.service");
  const { handleEvent } = require("./stripe.webhook.service");

  const suffix = crypto.randomUUID();
  const UNIT_PRICE = 2000;

  // Deliberately mirrors createStorefrontOrder's real shape — payment_status
  // is left at its schema default (pending_payment), exactly like real
  // order creation does, NOT hand-set to "paid" like every other test
  // fixture in this suite.
  const TEST_TENANT_ID = new mongoose.Types.ObjectId();
  const order = await Order.create({
    tenant_id: TEST_TENANT_ID,
    order_number: `TEST-PAYSTATUS-${suffix}`,
    invoice_number: `TEST-PAYSTATUS-INV-${suffix}`,
    items: [
      {
        product: new mongoose.Types.ObjectId(),
        variant: null,
        name: "Payment status regression item",
        sku: null,
        unit_price: UNIT_PRICE,
        quantity: 1,
        discount_amount: 0,
      },
    ],
    customer: { name: "Payment Status Test", email: "test@example.com", phone: null },
    delivery_method: "pickup",
    subtotal: UNIT_PRICE,
    shipping_cost: 0,
    tax_amount: Math.round(UNIT_PRICE / 11),
    total: UNIT_PRICE,
    currency: "aud",
    channel: "storefront",
    // status defaults to pending_payment, payment_status defaults to
    // pending_payment — exactly what a real just-checked-out order looks
    // like before Stripe confirms.
    guest_access_token: crypto.randomBytes(16).toString("hex"),
  });
  order.item_ids_migrated_at = new Date();
  await order.save();
  const itemId = order.items[0]._id.toString();

  const intentId = `pi_test_${suffix}`;
  const payment = await Payment.create({
    tenant_id: TEST_TENANT_ID,
    order: order._id,
    provider: "stripe",
    payment_method: null,
    amount: UNIT_PRICE,
    amount_refunded: 0,
    currency: "aud",
    status: "pending",
    stripe_payment_intent_id: intentId,
  });

  try {
    await t.test("before the webhook: neither field is paid", async () => {
      const fresh = await Order.findById(order._id);
      assert.equal(fresh.payment_status, ORDER_PAYMENT_STATUS.PENDING_PAYMENT);
    });

    // The real webhook handler, driven through the real dispatcher — not a
    // hand-set fixture and not calling the handler function directly.
    await handleEvent(
      {
        id: `evt_paystatus_${suffix}`,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: intentId,
            amount_received: UNIT_PRICE,
            amount: UNIT_PRICE,
            currency: "aud",
          },
        },
      },
      TEST_TENANT_ID,
    );

    await t.test("after the webhook: payment_status is PAID, not just the legacy status", async () => {
      const fresh = await Order.findById(order._id);
      assert.equal(fresh.status, "paid", "sanity check — the legacy field was always working");
      assert.equal(
        fresh.payment_status,
        ORDER_PAYMENT_STATUS.PAID,
        "the field createRefund actually gates admission on must be updated by the SAME event that pays the order",
      );
    });

    await t.test("a refund can now actually be admitted — reproducing and closing the live bug", async () => {
      // Before the fix, this threw 'Order payment_status "pending_payment"
      // is not refundable' — the exact live symptom. It must not throw now.
      // status ends at PROCESSING, not SUCCEEDED — this is a Stripe
      // allocation, and settlement only confirms via a SEPARATE webhook
      // (charge.refunded), by design (§3.7's "do NOT apply effects
      // optimistically"). Reaching PROCESSING at all is the proof: admission
      // was granted.
      const refund = await refundService.createRefund(
        order._id.toString(),
        {
          idempotency_key: `payment-status-regression-${suffix}`,
          scope: "line_items",
          lines: [{ order_item_id: itemId, quantity: 1, restock: false }],
          reason: "customer_request",
        },
        null,
        TEST_TENANT_ID,
      );
      assert.equal(refund.status, "processing");
    });
  } finally {
    const StripeProcessedEvent = require("../../models/StripeProcessedEvent");
    await StripeProcessedEvent.deleteOne({ stripe_event_id: `evt_paystatus_${suffix}` });
    await Refund.deleteMany({ order: order._id });
    await Payment.deleteMany({ order: order._id });
    await Order.deleteOne({ _id: order._id });
    // handlePaymentSucceeded (above) always sends an order-confirmation
    // email for this fixture, so the real queue is already constructed by
    // this point either way — .close() it before disconnecting.
    await emailQueueModule.emailQueue.close();
    await mongoose.disconnect();
  }
});
