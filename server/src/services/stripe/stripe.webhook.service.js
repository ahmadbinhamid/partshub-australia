// services/stripe/stripe.webhook.service.js
//
// Signature verification, idempotency, and event dispatch for incoming
// Stripe webhooks. Mirrors ebay.webhook.service.js's shape: unauthenticated
// route (see routes wiring), raw-body signature check, and an atomic
// unique-index "claim" collection (StripeProcessedEvent) instead of a
// read-then-write existence check.
//
// BYOK — each tenant has their own Stripe account, so there is no shared
// platform webhook endpoint anymore. The tenant is resolved from an opaque
// `?wt=` token in the URL (payment.controller.js#handleWebhook, mirroring
// ebay.controller.js's webhook redesign) BEFORE signature verification, so
// the right tenant's own webhook secret can be used to verify it. Once
// resolved, tenantId is the source of truth for every downstream call — no
// more Connect-only event.account field to cross-check against.

const Payment = require("../../models/Payment");
const Order = require("../../models/Order");
const Refund = require("../../models/Refund");
const StripeProcessedEvent = require("../../models/StripeProcessedEvent");
const stripeKeysService = require("./stripe.keys.service");
const { syncOrderStock, DIRECTION } = require("../order-stock-sync.service");
const { getTotalPaidForOrder } = require("../payment.service");
const refundService = require("../refund.service");
const emailService = require("../email/email.service");
const { getCompanyProfile } = require("../tenantSettings.service");
const { PAYMENT_STATUS, PAYMENT_PROVIDER } = require("../../constants/payment.constants");
const { ORDER_CHANNEL, ORDER_DELIVERY_METHOD } = require("../../constants/order.constants");
const { REFUND_REASON, REFUND_STATUS } = require("../../constants/refund.constants");
const { derivePaymentStatus } = require("../../utils/paymentStatus");
const { formatOrderNumber } = require("../../utils/orderNumberFormat");
const { logger } = require("../../loaders/logging");

// Stripe.webhooks.constructEvent is a static helper (pure HMAC verification,
// no API call) — no per-tenant Stripe client/API key needed here, just the
// tenant's own webhook signing secret (resolved by the caller via the
// opaque `wt` token in the URL).
const Stripe = require("stripe");

function constructEvent(rawBody, signatureHeader, webhookSecret) {
  return Stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
}

// Verifies against each candidate secret in order, returning on the first
// match. Real use case: local `stripe listen` testing against a BYOK tenant
// — the tenant's real secret is always tried first (and is all a production
// deployment ever has, since the caller only adds a second candidate outside
// production), so this changes nothing about how a real webhook delivery is
// verified. Throws the FIRST candidate's error if every one fails, since
// that's the one that actually matters (the tenant's real secret).
function constructEventWithFallback(rawBody, signatureHeader, candidateSecrets) {
  let firstError;
  for (const secret of candidateSecrets.filter(Boolean)) {
    try {
      return constructEvent(rawBody, signatureHeader, secret);
    } catch (err) {
      firstError = firstError || err;
    }
  }
  throw firstError || new Error("No webhook secret configured");
}

// Atomic claim: throws E11000 if this event id was already processed, which
// the caller treats as "already handled, no-op" rather than an error.
async function claimEvent(event, tenantId) {
  try {
    await StripeProcessedEvent.create({
      stripe_event_id: event.id,
      type: event.type,
      tenant_id: tenantId,
    });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
}

async function handleEvent(event, tenantId) {
  const isNew = await claimEvent(event, tenantId);
  if (!isNew) {
    logger.info(`[stripe.webhook] duplicate event ignored: ${event.id} (${event.type})`);
    return;
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        return await handlePaymentSucceeded(event.data.object, tenantId);
      case "payment_intent.payment_failed":
        return await handlePaymentFailed(event.data.object);
      case "charge.refunded":
        return await handleChargeRefunded(event.data.object, tenantId);
      case "charge.refund.updated":
        return await handleChargeRefundUpdated(event.data.object, tenantId);
      default:
        logger.info(`[stripe.webhook] unhandled event type: ${event.type}`);
    }
  } catch (err) {
    // Processing failed after the claim was already made — release it so
    // the 500 we return causes Stripe to retry this same event instead of
    // it being silently treated as "already handled" forever.
    await StripeProcessedEvent.deleteOne({ stripe_event_id: event.id });
    throw err;
  }
}

async function handlePaymentSucceeded(intent, tenantId) {
  const payment = await Payment.findOne({ stripe_payment_intent_id: intent.id });
  if (!payment) {
    logger.error(`[stripe.webhook] payment_intent.succeeded for unknown intent ${intent.id}`);
    return;
  }
  // Fully handled only when BOTH the payment record and the order/stock
  // side effects are done — checking status alone meant a retry after the
  // order/stock step failed (payment already saved as SUCCEEDED, but
  // order.save() below never completed) hit this guard and returned
  // immediately, leaving the order stuck at pending_payment forever despite
  // Stripe having actually captured the money. Found live.
  if (payment.status === PAYMENT_STATUS.SUCCEEDED && payment.order_effects_applied_at) return;

  // +guest_access_token: needed to build the customer-facing "view order"
  // link in the confirmation email below — excluded by default (select: false).
  const order = await Order.findById(payment.order).select("+guest_access_token");
  if (!order) {
    logger.error(`[stripe.webhook] order ${payment.order} missing for intent ${intent.id}`);
    return;
  }

  // Defense-in-depth: the local Payment/Order lookup above is what actually
  // resolves which tenant this event belongs to (stripe_payment_intent_id is
  // globally unique regardless of whose account it lives in) — this just
  // confirms that matches the tenant whose webhook URL/secret Stripe
  // delivered against, catching a misconfigured webhook or a future bug
  // before it can apply effects to the wrong tenant's order.
  if (String(order.tenant_id) !== String(tenantId)) {
    logger.error(
      `[stripe.webhook] tenant mismatch on intent ${intent.id}: webhook tenant=${tenantId}, ` +
        `resolved order's tenant=${order.tenant_id} — refusing to apply effects`,
    );
    return;
  }

  // Skipped entirely on a resume (payment.status already SUCCEEDED from a
  // prior attempt, only order_effects_applied_at was missing) — re-running
  // the mismatch check or re-fetching the intent would be harmless but
  // pointless; only the order/stock side below still needs finishing.
  if (payment.status !== PAYMENT_STATUS.SUCCEEDED) {
    // Trust nothing from the intent except what Stripe says was actually
    // captured — verify it matches what we billed for before marking paid.
    // Compared against this Payment doc's own `amount` (what we told Stripe
    // to charge when the intent was created), NOT order.total — an intent
    // for a manual sale's remaining balance is legitimately less than the total.
    const expectedAmount = payment.amount;
    const amountReceived = intent.amount_received ?? intent.amount;
    const amountMismatch = amountReceived !== expectedAmount;
    const currencyMismatch = intent.currency !== order.currency;
    if (amountMismatch || currencyMismatch) {
      // Funds were captured (this event only fires on success) — FAILED would
      // wrongly imply no money moved, so flag for manual review instead.
      payment.status = PAYMENT_STATUS.MANUAL_REVIEW;
      payment.failure_reason = [
        amountMismatch ? `Amount mismatch: received ${amountReceived}, expected ${expectedAmount}` : null,
        currencyMismatch ? `Currency mismatch: received ${intent.currency}, expected ${order.currency}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      await payment.save();
      logger.error(
        `[stripe.webhook] MISMATCH order ${order.order_number}: ${payment.failure_reason} — needs manual review`,
      );
      return; // do not mark paid, do not touch stock
    }

    // The webhook payload only carries payment_method as a bare ID, not the
    // expanded object — so re-retrieve the intent with expand to read card
    // details. Expand `payment_method` directly (a top-level expandable field
    // on PaymentIntent) rather than nesting through `latest_charge` — Stripe
    // rejects "latest_charge.payment_method" as an unsupported expand path.
    // Never rely on the legacy `charges.data[]` shape either way.
    const stripe = await stripeKeysService.getStripeClient(tenantId);
    const fullIntent = await stripe.paymentIntents.retrieve(intent.id, { expand: ["payment_method"] });
    const paymentMethod =
      fullIntent.payment_method && typeof fullIntent.payment_method === "object"
        ? fullIntent.payment_method
        : null;

    payment.status = PAYMENT_STATUS.SUCCEEDED;
    payment.amount = amountReceived;
    payment.paid_at = new Date();
    payment.card_brand = paymentMethod?.card?.brand || null;
    payment.card_last4 = paymentMethod?.card?.last4 || null;
    await payment.save();
  }

  // Recomputed across every succeeded payment on the order, not hardcoded to
  // PAID — this same webhook fires for a manual sale's payment-link
  // remainder too, where a prior deposit means this payment might not be
  // the last money owed... though in practice it always is, since nothing
  // else currently lets more than one payment attempt be in flight at once.
  const totalPaidCents = await getTotalPaidForOrder(order._id);
  const derivedStatus = derivePaymentStatus(totalPaidCents, order.total);
  order.status = derivedStatus;
  // §1.2/§9 — payment_status is the field refund.service.js#createRefund
  // actually gates admission on (REFUNDABLE_PAYMENT_STATUSES). Found live:
  // this webhook — the ONE place that marks a storefront order (or a manual
  // order's payment-link top-up) as paid — was only ever writing the LEGACY
  // `status` field, never this one. payment_status stays stuck at its
  // schema default ("pending_payment") for every order paid through this
  // path, forever, since nothing else sets it until a refund is attempted —
  // which is exactly what createRefund's own admission check then rejects,
  // even for a fully, genuinely paid order. ORDER_STATUS and
  // ORDER_PAYMENT_STATUS share identical string values for every payment
  // state (see order.constants.js) — derivePaymentStatus's return value is
  // valid for both fields directly, no re-mapping needed.
  order.payment_status = derivedStatus;

  // Manual/in-store sales already had their stock deducted in full at
  // creation time (the goods left with the customer then, regardless of how
  // much was actually collected) — deducting again here on a payment-link
  // top-up would double-count it. Only storefront/eBay orders wait for a
  // Stripe payment to confirm before stock ever moves.
  if (order.channel !== ORDER_CHANNEL.MANUAL) {
    const { hasShortfall, note } = await syncOrderStock(order, DIRECTION.DEDUCT);
    if (hasShortfall) {
      order.has_stock_issue = true;
      order.stock_issue_note = note;
    }
  }

  await order.save();

  // Marks this payment's order/stock effects as durably complete. No
  // transaction spans this and the order.save() above (see the field's
  // schema comment) — a crash in the narrow window between them would
  // leave this unset and a retry would redo the stock deduction. Accepted:
  // far narrower and rarer than the bug this replaces (any transient error
  // anywhere in this handler permanently stranding the order as unpaid).
  payment.order_effects_applied_at = new Date();
  await payment.save();

  logger.info(`[stripe.webhook] order ${order.order_number} marked ${order.status} (intent ${intent.id})`);

  // Manual/in-store sales get their invoice via the explicit "Send Email"
  // button (order.service.js#sendOrderNotification) — never this automatic
  // storefront-checkout confirmation, which assumes a storefront/eBay order
  // shape (e.g. sendOrderConfirmation's copy) that doesn't fit an in-person sale.
  if (order.channel === ORDER_CHANNEL.MANUAL) return;

  // Best-effort — never let an email hiccup fail this webhook. Throwing here
  // would make handleEvent release the processed-event claim and cause
  // Stripe to redeliver, but payment.status is already SUCCEEDED by then, so
  // the retry would short-circuit above and this email would never resend
  // anyway. Log and move on instead.
  try {
    const isPickup = order.delivery_method === ORDER_DELIVERY_METHOD.PICKUP;
    const companyProfile = await getCompanyProfile(order.tenant_id);
    if (isPickup) {
      await emailService.sendOrderReceivedPickup({
        to: order.customer.email,
        name: order.customer.name,
        orderNumber: formatOrderNumber(order.order_number_prefix, order.order_number),
        companyProfile,
        tenantId: order.tenant_id,
      });
    } else {
      await emailService.sendOrderConfirmation({
        to: order.customer.email,
        name: order.customer.name,
        orderNumber: formatOrderNumber(order.order_number_prefix, order.order_number),
        companyProfile,
        tenantId: order.tenant_id,
      });
    }
  } catch (err) {
    logger.error(`[stripe.webhook] failed to send order confirmation email for ${order.order_number}`, {
      error: err.message,
    });
  }
}

async function handlePaymentFailed(intent) {
  const payment = await Payment.findOne({ stripe_payment_intent_id: intent.id });
  if (!payment) {
    logger.warn(`[stripe.webhook] payment_intent.payment_failed for unknown intent ${intent.id}`);
    return;
  }
  if (payment.status === PAYMENT_STATUS.SUCCEEDED) return; // never downgrade a completed payment

  payment.status = PAYMENT_STATUS.FAILED;
  payment.failure_reason = intent.last_payment_error?.message || "Payment failed";
  await payment.save();
  // Order stays pending_payment — the storefront can retry on the same order/intent.
}

// Stripe's refund `reason` values don't line up with ours — used only when
// reconciling a refund we didn't create ourselves (dashboard-issued).
function mapStripeReasonToOurs(stripeReason) {
  const map = {
    duplicate: REFUND_REASON.DUPLICATE_PAYMENT,
    fraudulent: REFUND_REASON.FRAUD_SUSPECTED,
    requested_by_customer: REFUND_REASON.CUSTOMER_REQUEST,
  };
  return map[stripeReason] || REFUND_REASON.OTHER;
}

// refund-redesign-spec.md §4.1 — rewritten to look up by
// payment_allocations.stripe_refund_id (now indexed and unique — see
// Refund.js) instead of the legacy top-level field, and to apply effects
// through refund.service.js's derived-state applyRefundEffects rather than
// hand-rolling payment.amount_refunded/order.status here directly.
//
// Fires for every refund on a charge — including ones we just created
// ourselves via refund.service.js#createRefund (which also calls Stripe
// directly) — so this MUST reconcile by stripe_refund_id rather than
// blindly re-applying effects, or our own admin-initiated refunds would
// double-count/restock here.
//
// Still lists refunds for the payment intent rather than reading a single
// id off the event, unlike handleChargeRefundUpdated below — charge.refunds
// is not reliably expanded on the Charge object across API versions (see
// the original version of this comment, kept accurate below), and this
// event fires once per CHARGE, potentially covering several refunds at
// once. handleChargeRefundUpdated (§4.2) is the leaner, non-listing path
// for a single refund's own status transitions once it exists.
async function handleChargeRefunded(charge, tenantId) {
  const payment = await Payment.findOne({ stripe_payment_intent_id: charge.payment_intent });
  if (!payment) {
    logger.warn(`[stripe.webhook] charge.refunded for unknown intent ${charge.payment_intent}`);
    return;
  }

  const order = await Order.findById(payment.order);
  if (!order) return;

  if (String(order.tenant_id) !== String(tenantId)) {
    logger.error(
      `[stripe.webhook] tenant mismatch on charge.refunded for intent ${charge.payment_intent}: ` +
        `webhook tenant=${tenantId}, resolved order's tenant=${order.tenant_id} — refusing to apply effects`,
    );
    return;
  }

  // charge.refunds is NOT auto-expanded on the Charge object as of Stripe API
  // version 2022-11-15+ — and the payload shape follows the API version
  // configured on the Stripe account/webhook endpoint, not our SDK-pinned
  // apiVersion, so charge.refunds?.data can be silently absent here even
  // though our code is pinned to a version that (in the SDK docs) still
  // shows it. Never rely on optional sub-objects being present in webhook
  // payloads — re-fetch explicitly instead.
  const stripe = await stripeKeysService.getStripeClient(tenantId);
  const { data: stripeRefunds } = await stripe.refunds.list({ payment_intent: charge.payment_intent });

  for (const sr of stripeRefunds) {
    await reconcileStripeRefund(sr, payment, order);
  }
}

// One Stripe refund object reconciled against our Refund collection.
async function reconcileStripeRefund(sr, payment, order) {
  const existing = await Refund.findOne({ "payment_allocations.stripe_refund_id": sr.id });

  if (existing) {
    // Already tracked via our own createRefund (admin_api) — only confirm
    // this allocation's settlement, never re-apply effects a second time
    // (applyRefundEffects' own ledger recompute is idempotent regardless,
    // but the restock/eBay leg is guarded by effects_applied_at precisely
    // so redelivery like this can't double-run it).
    const allocation = existing.payment_allocations.find((a) => a.stripe_refund_id === sr.id);
    if (allocation && !allocation.settled && sr.status === "succeeded") {
      allocation.settled = true;
      await existing.save();
    }
    const allSettled = existing.payment_allocations.every((a) => a.settled);
    if (allSettled && existing.status === REFUND_STATUS.PROCESSING) {
      // status = SUCCEEDED must be saved BEFORE applyRefundEffects runs:
      // its recomputeLedger only counts refunds via getSucceededRefunds, so
      // if this refund isn't SUCCEEDED yet when its own recompute runs, its
      // own contribution is silently excluded from
      // order.items[].quantity_refunded. (Tried reordering this once —
      // broke refund.service.concurrency.test.js. Reverted — see
      // settleRefund's matching comment in refund.service.js.) A sweep to
      // auto-retry a refund stuck SUCCEEDED-with-effects-never-applied was
      // also tried and reverted — see refund.reconciliation.service.js's
      // own comment on why (indistinguishable from old, legitimately fine
      // historical refunds; re-running it against one auto-voided a real
      // settled refund in testing). Accepted as a residual gap.
      existing.status = REFUND_STATUS.SUCCEEDED;
      await existing.save();
      await refundService.applyRefundEffects(existing._id);
    }
    return;
  }

  // Unknown stripe_refund_id => issued directly from the Stripe dashboard,
  // bypassing our API entirely. Recorded as scope: "amount" with
  // needs_reconciliation: true (§4.1) — no admin user in our system
  // initiated it and no restock option was ever presented to anyone, so
  // stock is deliberately left untouched; an admin can restock manually via
  // the inventory screen if the return applies. RefundHistoryList.tsx badges
  // needs_reconciliation so this is never mistaken for a fully-attributed
  // item refund.
  //
  // Guarded by the unique index on payment_allocations.stripe_refund_id
  // (§1.3), not a read-then-act check — catches E11000 as "another delivery
  // won the race" rather than an error, closing the race the old
  // stripe_refund_id-with-no-index version of this code was exposed to.
  let created;
  try {
    const refundNumber = await refundService.nextRefundNumber(order.tenant_id);
    created = await Refund.create({
      tenant_id: order.tenant_id,
      order: order._id,
      payment: payment._id, // legacy field, kept populated during the transition
      amount: sr.amount,
      reason: mapStripeReasonToOurs(sr.reason),
      status: sr.status === "succeeded" ? REFUND_STATUS.SUCCEEDED : REFUND_STATUS.PROCESSING,
      initiated_via: "stripe_dashboard",
      initiated_by: null,
      refund_number: refundNumber,
      scope: "amount",
      lines: [],
      items_amount: 0,
      gst_amount: Math.round(sr.amount / 11),
      total_amount: sr.amount,
      payment_allocations: [
        {
          payment: payment._id,
          amount: sr.amount,
          provider: PAYMENT_PROVIDER.STRIPE,
          stripe_refund_id: sr.id,
          settled: sr.status === "succeeded",
        },
      ],
      needs_reconciliation: true,
    });
  } catch (err) {
    if (err.code === 11000) {
      logger.info(`[stripe.webhook] concurrent charge.refunded delivery already recorded refund for ${sr.id}`);
      return;
    }
    throw err;
  }

  if (created.status === REFUND_STATUS.SUCCEEDED) {
    await refundService.applyRefundEffects(created._id);
  }
}

// refund-redesign-spec.md §4.2 — new subscription. event.data.object for
// charge.refund.updated is the Stripe Refund object itself (not a Charge),
// so this needs no list() call at all — it names the specific refund
// directly. Requires enabling this event type on the Stripe webhook
// endpoint's configuration in the Dashboard (Developers → Webhooks → this
// endpoint → "+ Select events" → charge.refund.updated) — not something
// this codebase can turn on by itself.
async function handleChargeRefundUpdated(sr, tenantId) {
  if (sr.status !== "failed" && sr.status !== "canceled") return; // only a reversal is actionable here

  const refund = await Refund.findOne({ "payment_allocations.stripe_refund_id": sr.id });
  if (!refund) {
    logger.warn(`[stripe.webhook] charge.refund.updated for unknown stripe refund ${sr.id}`);
    return;
  }

  // Same defense-in-depth check as handlePaymentSucceeded/handleChargeRefunded
  // — refuse to act on a refund that doesn't belong to the tenant whose
  // webhook endpoint/secret Stripe just delivered against.
  //
  // NOTE (Task 3 fix): only enforced when a tenantId was actually supplied.
  // Unlike handlePaymentSucceeded/handleChargeRefunded (only ever called
  // from handleEvent's webhook dispatcher, always with a real tenantId),
  // this function is ALSO called directly by
  // refund.reconciliation.service.js#reconcileStuckRefunds with no
  // tenantId at all (mirrors reconcileStripeRefund(sr, payment, order),
  // which has no tenantId parameter to begin with) — that caller already
  // resolved `refund` via its own trusted, DB-driven lookup, not from
  // unauthenticated webhook input, so there's no external tenant claim to
  // cross-check against. Before this fix the unconditional strict-equal
  // check compared refund.tenant_id against the string "undefined" and
  // always failed for that caller — meaning the reconciliation sweep's
  // auto-reversal never actually ran, not just this test's direct call.
  if (tenantId != null && String(refund.tenant_id) !== String(tenantId)) {
    logger.error(
      `[stripe.webhook] tenant mismatch on charge.refund.updated for stripe refund ${sr.id}: ` +
        `webhook tenant=${tenantId}, resolved refund's tenant=${refund.tenant_id} — refusing to apply effects`,
    );
    return;
  }

  if (!refund.effects_applied_at) {
    // Never actually applied (was still processing) — nothing to reverse,
    // just record that it didn't go through.
    refund.status = REFUND_STATUS.FAILED;
    refund.failure_reason = `Stripe refund ${sr.status}`;
    await refund.save();
    logger.error(
      `[stripe.webhook] refund ${refund.refund_number} failed at Stripe (${sr.status}) before its effects were ever applied`,
    );
    return;
  }

  // Effects were already applied (customer credited, stock restocked) and
  // Stripe itself reversed the refund afterward — without this, we'd be
  // left having restocked goods and credited a customer who was never
  // actually paid back. Auto-reverse via the same void path an admin would
  // use (§3.8), and alert loudly — this is exactly the scenario §4.2 exists
  // to catch automatically instead of relying on someone noticing.
  // source: "stripe_reversal" — this is the one legitimate exception to
  // voidRefund's "never void a settled Stripe refund" guard (corrections
  // round). Everywhere else, a settled Stripe allocation means real money
  // already moved and can't be un-refunded; HERE, Stripe itself is
  // reporting that this specific refund just moved to failed/canceled —
  // i.e. the money genuinely came back — so voiding to match that is
  // correct, not a desync.
  await refundService.voidRefund(
    refund._id,
    {
      reason: `Auto-reversed: Stripe refund ${sr.id} transitioned to ${sr.status} after effects were already applied`,
      userId: null,
      source: "stripe_reversal",
    },
    refund.tenant_id,
  );
  logger.error(
    `[stripe.webhook] ALERT: refund ${refund.refund_number} (order ${refund.order}) was auto-reversed — ` +
      `Stripe's refund ${sr.id} moved to "${sr.status}" after we had already credited the customer and/or ` +
      `restocked. Review this order manually.`,
  );
}

module.exports = {
  constructEvent,
  constructEventWithFallback,
  handleEvent,
  // Exported for refund.reconciliation.service.js (corrections round) — the
  // stuck-refund sweep reconciles a Stripe-allocation refund whose webhook
  // never arrived by re-fetching its real status from Stripe and running it
  // through the exact same handlers a webhook delivery would have used
  // (reconcileStripeRefund for a succeeded/still-pending refund,
  // handleChargeRefundUpdated for a failed/canceled one), rather than
  // duplicating either's logic.
  reconcileStripeRefund,
  handleChargeRefundUpdated,
};
