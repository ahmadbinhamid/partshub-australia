// scripts/auditUnreversedRestocks.js
//
// TASK 2 — READ-ONLY audit. No writes to Mongo, no Stripe writes, no --fix
// flag. Investigates the real-world blast radius of the voidRefund
// tenant-guard bug fixed this round: handleChargeRefundUpdated's tenant-
// mismatch check unconditionally compared refund.tenant_id against
// tenantId, but refund.reconciliation.service.js's stuck-refund sweep calls
// it with NO tenantId at all (mirroring reconcileStripeRefund's own
// signature, which has none) — so that guard always failed for the sweep's
// calls specifically.
//
// ── What "affected" actually means (verified from the code, not assumed) ──
//
// handleChargeRefundUpdated's restock-reversal branch (the voidRefund call)
// only runs when refund.effects_applied_at is already set — i.e. the
// restock already happened. Tracing every place that sets
// effects_applied_at (applyRefundEffects, called from settleRefund,
// reconcileStripeRefund, and stripe.webhook.service's dashboard-issued-
// refund path) shows EVERY one of them sets refund.status = SUCCEEDED at
// the same time or immediately before. And refund.status is only ever set
// to PROCESSING once, in settleRefund, and never set back to PROCESSING
// from any later status — so a refund with effects_applied_at set can never
// be in status PROCESSING again.
//
// refund.reconciliation.service.js's sweep only selects
// `status: { $in: [PENDING, PROCESSING] }`. Combined with the above: a
// refund the SWEEP calls handleChargeRefundUpdated on can never have
// effects_applied_at set, so the sweep specifically could never have
// reached voidRefund's restock-reversal branch — only the earlier
// "refund never got its effects applied — just mark it FAILED" branch
// (also blocked by the same guard bug, but with no stock consequence: no
// effects means nothing to reverse). See the "STUCK-IN-PROCESSING" section
// below for that actual, verified consequence, kept separate from the
// stock-inflation check since it isn't a stock problem.
//
// So the true "restock applied but never reversed, stock now inflated"
// signature is NOT sweep-specific — it's just: a refund whose restock
// really did apply (effects_applied_at set, at least one line with
// restock_applied_at set) and whose status is still SUCCEEDED (never
// VOIDED), where the underlying Stripe refund is — right now, per Stripe
// itself, not per anything stored locally — failed or canceled. Only Stripe
// can say that; nothing local records it. This script checks broadly
// (regardless of which code path a hypothetical webhook/sweep call came
// through) since that's the only way to actually find real damage, not just
// re-derive the (mathematically empty, per the proof above) sweep-only
// subset.
//
// ── The correction path, if this ever finds something (NOT called here) ──
//
// refund.service.js#voidRefund — reverses the restock via syncOrderStock
// (DIRECTION.DEDUCT), which fans out through the normal
// fanOutMarketplaceInventory path (eBay + Google), then flips
// refund.status to VOIDED and recomputes the order ledger. That is the ONLY
// function that should ever be used to correct a finding from this script —
// never a direct Inventory.stock_count write, which would skip the eBay/
// Google fan-out entirely and leave marketplace listings still wrong.
//
// Usage:
//   node scripts/auditUnreversedRestocks.js [--tenant=<tenantId>] [--summary]
//
//   --tenant=<id>   Restrict to one tenant.
//   --summary       Print only the summary block, not the per-refund detail.

"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const config = require("../src/config");
const Refund = require("../src/models/Refund");
const Order = require("../src/models/Order");
const Tenant = require("../src/models/Tenant");
const Inventory = require("../src/models/Inventory");
const MarketplaceListing = require("../src/models/MarketplaceListing");
const { REFUND_STATUS } = require("../src/constants/refund.constants");
const { PAYMENT_PROVIDER } = require("../src/constants/payment.constants");
const { resolveSkuToIds } = require("../src/services/inventory.service");
const stripeKeysService = require("../src/services/stripe/stripe.keys.service");
const { RESERVATION_STALE_AFTER_MS } = require("../src/services/refund.service");
const { formatOrderNumber } = require("../src/utils/orderNumberFormat");

function parseArgs(argv) {
  const args = { tenant: null, summary: false };
  for (const arg of argv) {
    if (arg === "--summary") {
      args.summary = true;
    } else if (arg.startsWith("--tenant=")) {
      args.tenant = arg.slice("--tenant=".length);
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Usage: node scripts/auditUnreversedRestocks.js [--tenant=<tenantId>] [--summary]");
      process.exit(1);
    }
  }
  return args;
}

// Cache one Stripe client (or the reason it's unavailable) per tenant —
// several refunds commonly belong to the same tenant.
function makeStripeClientCache() {
  const cache = new Map();
  return async (tenantId) => {
    const key = String(tenantId);
    if (cache.has(key)) return cache.get(key);
    let result;
    try {
      result = { client: await stripeKeysService.getStripeClient(tenantId), error: null };
    } catch (err) {
      // NOTE: a tenant with no Stripe key configured at all (or a stale/
      // revoked one) throws here — that's a legitimate, expected outcome
      // for plenty of tenants (never connected Stripe, or connected a
      // provider other than Stripe), not a script bug. Recorded as
      // "could not verify" rather than treated as either affected or clean.
      result = { client: null, error: err.message };
    }
    cache.set(key, result);
    return result;
  };
}

async function findRestockCandidates(tenantFilter) {
  const query = {
    status: REFUND_STATUS.SUCCEEDED,
    effects_applied_at: { $ne: null },
    "lines.restock_applied_at": { $ne: null },
    "payment_allocations.provider": PAYMENT_PROVIDER.STRIPE,
  };
  if (tenantFilter) query.tenant_id = tenantFilter;
  return Refund.find(query).lean();
}

async function verifyAgainstStripe(refund, getStripeClientCached) {
  const { client, error } = await getStripeClientCached(refund.tenant_id);
  if (!client) {
    return { checkable: false, reason: error || "no Stripe client available", affectedAllocations: [] };
  }

  const affectedAllocations = [];
  for (const alloc of refund.payment_allocations) {
    if (alloc.provider !== PAYMENT_PROVIDER.STRIPE || !alloc.stripe_refund_id) continue;
    try {
      const sr = await client.refunds.retrieve(alloc.stripe_refund_id);
      // Same trigger condition handleChargeRefundUpdated itself uses — see
      // that function's own `if (sr.status !== "failed" && sr.status !==
      // "canceled") return;` guard.
      if (sr.status === "failed" || sr.status === "canceled") {
        affectedAllocations.push({ stripe_refund_id: alloc.stripe_refund_id, stripe_status: sr.status });
      }
    } catch (err) {
      if (err.code === "resource_missing") {
        // Matches handleChargeRefundUpdated's own resource_missing handling
        // in the reconciliation sweep — Stripe has no record of this
        // refund at all any more, which the sweep treats the same as
        // "canceled".
        affectedAllocations.push({ stripe_refund_id: alloc.stripe_refund_id, stripe_status: "resource_missing" });
      } else {
        return { checkable: false, reason: `Stripe error on ${alloc.stripe_refund_id}: ${err.message}`, affectedAllocations: [] };
      }
    }
  }
  return { checkable: true, reason: null, affectedAllocations };
}

async function buildReportRow(refund) {
  const [tenant, order] = await Promise.all([
    Tenant.findById(refund.tenant_id).select("name").lean(),
    Order.findById(refund.order).select("order_number order_number_prefix").lean(),
  ]);

  const restockedLines = refund.lines.filter((l) => l.restock_applied_at && l.sku);
  const skuRows = [];
  for (const line of restockedLines) {
    const resolved = await resolveSkuToIds(line.sku, refund.tenant_id).catch(() => null);
    let currentStock = null;
    let listings = [];
    if (resolved) {
      const invQuery = { product: resolved.productId, variant: resolved.variantId };
      const invRecords = await Inventory.find(invQuery).select("stock_count location").lean();
      currentStock = invRecords.reduce((sum, r) => sum + (r.stock_count || 0), 0);

      listings = await MarketplaceListing.find({
        tenant_id: refund.tenant_id,
        product: resolved.productId,
        variant: resolved.variantId,
      })
        .select("platform synced_quantity")
        .lean();
    }
    skuRows.push({
      sku: line.sku,
      quantityThatShouldHaveBeenReversed: line.quantity,
      currentLocalStock: currentStock,
      listings: listings.map((l) => ({ platform: l.platform, synced_quantity: l.synced_quantity })),
    });
  }

  return {
    tenant: tenant ? { id: String(refund.tenant_id), name: tenant.name } : { id: String(refund.tenant_id), name: "(tenant not found)" },
    orderNumber: order ? formatOrderNumber(order.order_number_prefix, order.order_number) : "(order not found)",
    refundId: String(refund._id),
    refundNumber: refund.refund_number,
    skuRows,
  };
}

// ── Secondary, non-stock finding — kept fully separate from the primary
// "stock inflated" answer, see the module header's "STUCK-IN-PROCESSING"
// note. Reported for completeness because it IS the actual, verified real-
// world consequence of the same guard bug for the sweep specifically.
async function findStuckProcessingRefunds(tenantFilter, getStripeClientCached) {
  const cutoff = new Date(Date.now() - RESERVATION_STALE_AFTER_MS);
  const query = {
    status: { $in: [REFUND_STATUS.PENDING, REFUND_STATUS.PROCESSING] },
    created_at: { $lt: cutoff },
    "payment_allocations.provider": PAYMENT_PROVIDER.STRIPE,
  };
  if (tenantFilter) query.tenant_id = tenantFilter;
  const stuck = await Refund.find(query).lean();

  const results = [];
  for (const refund of stuck) {
    if (refund.status !== REFUND_STATUS.PROCESSING) continue; // PENDING has its own resume path, unaffected by this bug
    const { affectedAllocations, checkable, reason } = await verifyAgainstStripe(refund, getStripeClientCached);
    if (checkable && affectedAllocations.length > 0) {
      results.push({ refund, affectedAllocations });
    } else if (!checkable) {
      results.push({ refund, uncheckable: reason });
    }
  }
  return results;
}

async function main() {
  const { tenant: tenantFilter, summary } = parseArgs(process.argv.slice(2));

  await mongoose.connect(config.mongoUri);
  console.log(`Connected to ${config.mongoUri}`);
  if (tenantFilter) console.log(`Filtering to tenant ${tenantFilter}`);
  console.log("");

  const getStripeClientCached = makeStripeClientCache();

  // ── PRIMARY: restock applied, refund still SUCCEEDED, Stripe says the
  // underlying refund actually failed/canceled — the real "should have
  // been auto-reversed, wasn't" signature. ──────────────────────────────
  console.log("=".repeat(78));
  console.log("PRIMARY: refunds whose restock was applied but never reversed");
  console.log("=".repeat(78));

  const candidates = await findRestockCandidates(tenantFilter);
  console.log(`Candidates (restock applied, status still SUCCEEDED, has a Stripe allocation): ${candidates.length}`);

  const affected = [];
  const uncheckable = [];
  for (const refund of candidates) {
    const result = await verifyAgainstStripe(refund, getStripeClientCached);
    if (!result.checkable) {
      uncheckable.push({ refund, reason: result.reason });
    } else if (result.affectedAllocations.length > 0) {
      affected.push({ refund, affectedAllocations: result.affectedAllocations });
    }
  }

  if (uncheckable.length > 0) {
    console.log(`\n${uncheckable.length} candidate(s) could not be verified against Stripe (reported, not counted as affected or clean):`);
    for (const { refund, reason } of uncheckable) {
      console.log(`  - refund ${refund.refund_number} (tenant ${refund.tenant_id}): ${reason}`);
    }
  }

  if (affected.length === 0) {
    console.log("\n*** ZERO refunds found matching the unreversed-restock signature. ***");
    console.log("*** No stock inflation from this bug was found in this database. ***");
  } else {
    console.log(`\n${affected.length} refund(s) AFFECTED — restock applied, never reversed, Stripe confirms it should have been:\n`);

    const bySkuSet = new Set();
    const inflatedByTenant = new Map();

    for (const { refund, affectedAllocations } of affected) {
      const row = await buildReportRow(refund);
      const tenantKey = row.tenant.id;
      let tenantInflated = inflatedByTenant.get(tenantKey) || 0;

      if (!summary) {
        console.log("-".repeat(78));
        console.log(`Tenant:      ${row.tenant.name} (${row.tenant.id})`);
        console.log(`Order:       ${row.orderNumber}`);
        console.log(`Refund:      ${row.refundNumber} (${row.refundId})`);
        console.log(`Stripe:      ${affectedAllocations.map((a) => `${a.stripe_refund_id} -> ${a.stripe_status}`).join(", ")}`);
        for (const sku of row.skuRows) {
          console.log(`  SKU ${sku.sku}: should reverse ${sku.quantityThatShouldHaveBeenReversed} unit(s), current local stock ${sku.currentLocalStock ?? "(unresolved)"}`);
          for (const listing of sku.listings) {
            console.log(`    - ${listing.platform}: synced_quantity=${listing.synced_quantity}`);
          }
        }
      }

      for (const sku of row.skuRows) {
        bySkuSet.add(sku.sku);
        tenantInflated += sku.quantityThatShouldHaveBeenReversed || 0;
      }
      inflatedByTenant.set(tenantKey, tenantInflated);
    }

    console.log("\n" + "=".repeat(78));
    console.log("SUMMARY");
    console.log("=".repeat(78));
    console.log(`Refunds affected:        ${affected.length}`);
    console.log(`Distinct SKUs affected:  ${bySkuSet.size}`);
    console.log("Inflated units by tenant:");
    for (const [tenantId, units] of inflatedByTenant.entries()) {
      console.log(`  ${tenantId}: ${units} unit(s)`);
    }
  }

  // ── SECONDARY: refunds permanently stuck in PROCESSING — the actual,
  // verified real-world consequence of the sweep's guard bug (see module
  // header). No stock impact; included for completeness. ────────────────
  console.log("\n" + "=".repeat(78));
  console.log("SECONDARY (informational, NOT a stock problem): refunds stuck in PROCESSING");
  console.log("that the sweep should have resolved (marked FAILED) but the guard bug blocked");
  console.log("=".repeat(78));

  const stuckResults = await findStuckProcessingRefunds(tenantFilter, getStripeClientCached);
  const stuckAffected = stuckResults.filter((r) => !r.uncheckable);
  const stuckUncheckable = stuckResults.filter((r) => r.uncheckable);

  if (stuckAffected.length === 0) {
    console.log("*** ZERO refunds found stuck in PROCESSING with a resolvable Stripe status. ***");
  } else {
    console.log(`${stuckAffected.length} refund(s) stuck in PROCESSING, Stripe already shows failed/canceled/missing:`);
    if (!summary) {
      for (const { refund, affectedAllocations } of stuckAffected) {
        console.log(`  - refund ${refund.refund_number} (tenant ${refund.tenant_id}, order ${refund.order}): ${affectedAllocations.map((a) => `${a.stripe_refund_id} -> ${a.stripe_status}`).join(", ")}`);
      }
    }
    console.log("These will now resolve correctly on the next reconciliation sweep run (post-fix) — no manual action needed.");
  }
  if (stuckUncheckable.length > 0) {
    console.log(`${stuckUncheckable.length} stuck-PROCESSING refund(s) could not be verified against Stripe:`);
    for (const { refund, uncheckable: reason } of stuckUncheckable) {
      console.log(`  - refund ${refund.refund_number} (tenant ${refund.tenant_id}): ${reason}`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("auditUnreversedRestocks failed:", err);
  process.exitCode = 1;
});
