// models/Payment.js
//
// Amounts are integer cents. stripe_client_secret is deliberately NOT a
// field here — it's returned once from the create-intent response and
// never persisted.

const { model, Schema } = require("mongoose");
const { buildSchema } = require("./base.model");
const { PAYMENT_PROVIDER, PAYMENT_METHOD, PAYMENT_STATUS } = require("../constants/payment.constants");

const paymentSchema = buildSchema({
  // Backfilled onto every existing Payment by scripts/backfillTenantId.js —
  // stripe_payment_intent_id's unique index below is compound with this.
  tenant_id: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
  provider: {
    type: String,
    enum: Object.values(PAYMENT_PROVIDER),
    default: PAYMENT_PROVIDER.STRIPE,
  },
  // Only Stripe payments have one — uniqueness/partial-filtering handled by
  // the explicit compound index below, not a field-level sparse index.
  stripe_payment_intent_id: {
    type: String,
    required: function () {
      return this.provider === PAYMENT_PROVIDER.STRIPE;
    },
  },

  // Human-facing detail for manual payments (cash, card terminal, bank
  // transfer, ...) — always null for Stripe, which is inherently a card.
  payment_method: {
    type: String,
    enum: [...Object.values(PAYMENT_METHOD), null],
    default: null,
  },

  amount: { type: Number, required: true }, // cents
  amount_refunded: { type: Number, default: 0 }, // cents
  currency: { type: String, required: true, default: "aud" },

  status: {
    type: String,
    enum: Object.values(PAYMENT_STATUS),
    default: PAYMENT_STATUS.PENDING,
  },

  card_brand: { type: String, default: null },
  card_last4: { type: String, default: null },
  failure_reason: { type: String, default: null },
  paid_at: { type: Date, default: null },

  // Set only after the order/stock side of handlePaymentSucceeded actually
  // completes (stripe.webhook.service.js) — distinct from `status ===
  // SUCCEEDED`, which is saved earlier. There's no DB transaction spanning
  // the Payment and Order writes (this deployment runs standalone MongoDB,
  // no replica set — Mongoose sessions aren't usable), so a failure between
  // the two must be independently retryable: a webhook retry that finds
  // status already SUCCEEDED but this still null resumes the order/stock
  // update instead of short-circuiting as "already handled" with the order
  // left stuck at pending_payment forever. Found live.
  order_effects_applied_at: { type: Date, default: null },
});

// payment.service.js's various { order } lookups all sort by created_at —
// this compound index covers both; still serves a plain { order } query too
// (compound indexes support their own prefix).
paymentSchema.index({ order: 1, created_at: -1 });
// partialFilterExpression, NOT sparse — some existing Payment docs have
// stripe_payment_intent_id stored as literal null (not absent), and sparse
// only excludes a field that's entirely unset, not one explicitly null (see
// Refund.js's extensive comment on the identical issue). $type excludes both.
paymentSchema.index(
  { tenant_id: 1, stripe_payment_intent_id: 1 },
  { unique: true, partialFilterExpression: { stripe_payment_intent_id: { $type: "string" } } },
);

module.exports = model("Payment", paymentSchema);
