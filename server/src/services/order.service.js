// services/order.service.js

const crypto = require("crypto");
const Order = require("../models/Order");
const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const Customer = require("../models/Customer");
const Payment = require("../models/Payment");
const Counter = require("../models/Counter");
const Refund = require("../models/Refund");
const Tenant = require("../models/Tenant");
const { tenantCounterKey } = require("../utils/tenantCounterKey");
const { buildWordSearchOr } = require("../utils/regex");
const { formatCentsAsDollars } = require("../utils/currency");
const { formatOrderNumber, stripOrderNumberPrefix } = require("../utils/orderNumberFormat");
const { getTotalStockForProductVariant, resolveSkuToIds } = require("./inventory.service");
const { syncOrderStock, DIRECTION } = require("./order-stock-sync.service");
const { getTotalPaidForOrder, getTotalRefundedForOrder, getPaymentsForOrder } = require("./payment.service");
const {
  ORDER_STATUS,
  ORDER_CHANNEL,
  ORDER_DELIVERY_METHOD,
  ORDER_FULFILLMENT_STATUS,
  ORDER_PAYMENT_STATUS,
} = require("../constants/order.constants");
const { PAYMENT_PROVIDER, PAYMENT_STATUS, ORDER_PAYMENT_CHOICE } = require("../constants/payment.constants");
const { ADJUSTMENT_TYPE } = require("../constants/inventory.constants");
const { currencyForMarketplace } = require("../constants/ebay.constants");
const { derivePaymentStatus, deriveLegacyOrderStatus } = require("../utils/paymentStatus");
const { mapEbayOrder } = require("./ebay/ebay.order.mapper");
const { createPaymentLinkForOrder } = require("./stripe/stripe.payment.service");
const { logger } = require("../loaders/logging");
const emailService = require("./email/email.service");
const { buildInvoicePdfBuffer } = require("../utils/pdf/invoicePdf");
const { getCompanyProfile } = require("./tenantSettings.service");
const notificationService = require("./notification.service");

// GST-inclusive AU retail pricing: GST component = price / 11, never added on top.
const GST_DIVISOR = 11;

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// Counter._id is namespaced per tenant (see tenantCounterKey) so two
// tenants' sequences never share or collide — see Counter.js's own comment.
// Stores just the zero-padded number, no "ORD-" baked in — the prefix is
// applied at render time only (dashboard does it in the frontend; the PDF
// invoice and transactional emails go through utils/orderNumberFormat.js
// since the frontend never touches those). Previously borrowed tenant.code
// as the prefix, which meant an order number and a SKU could look identical
// (e.g. "PHA-00278" either way) — confusing on invoices/support tickets
// where both appear; dropping any prefix from storage sidesteps that too.
async function nextOrderNumber(tenantId) {
  const counter = await Counter.findOneAndUpdate(
    { _id: tenantCounterKey(tenantId, "order_number") },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return String(counter.seq).padStart(5, "0");
}

// Own sequence, own counter — kept separate from order_number so an
// invoice's numbering never has to assume "one order = one invoice" (see
// the comment on Order.invoice_number).
async function nextInvoiceNumber(tenantId) {
  const counter = await Counter.findOneAndUpdate(
    { _id: tenantCounterKey(tenantId, "invoice_number") },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return String(counter.seq).padStart(5, "0");
}

function generateGuestAccessToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Re-derives price/availability from the DB for every line item — the
// storefront's cart totals are never trusted for what gets charged.
async function resolveOrderItem({ product: productId, variant: variantId, quantity }, tenantId) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw httpError("Invalid quantity", 400);
  }

  const product = await Product.findOne({ _id: productId, tenant_id: tenantId });
  if (!product || !product.is_published_online) {
    throw httpError("Product not available", 400);
  }

  let variant = null;
  let unitPriceDollars = product.price;
  let sku = product.sku;
  let name = product.title;

  if (variantId) {
    variant = await ProductVariant.findOne({ _id: variantId, product: productId, tenant_id: tenantId });
    if (!variant) {
      throw httpError("Product variant not available", 400);
    }
    unitPriceDollars = variant.price ?? unitPriceDollars;
    sku = variant.sku || sku;
    name = `${product.title} — ${variant.display_name}`;
  }

  if (product.stock_control) {
    const available = await getTotalStockForProductVariant(productId, variantId || null);
    if (available < quantity) {
      throw httpError(`Insufficient stock for "${name}" — only ${available} left`, 400);
    }
  }

  return {
    product: product._id,
    variant: variant ? variant._id : null,
    name,
    sku,
    unit_price: Math.round(unitPriceDollars * 100), // dollars -> cents
    shipping_cost: product.shipping_cost ?? 0, // dollars, per-unit freight cost
    quantity,
  };
}

// Resolves one line for a manual/in-store sale created from the admin
// dashboard. Unlike resolveOrderItem (storefront), doesn't require
// is_published_online — staff can sell draft/unlisted stock — and accepts a
// per-line discount entered by the staff member.
async function resolveManualOrderItem(
  { product: productId, variant: variantId, quantity, discount_amount = 0, note = null },
  tenantId,
) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw httpError("Invalid quantity", 400);
  }

  // Product/variant lookups are independent of each other — run them
  // concurrently rather than one-after-another, since createManualOrder
  // itself already fans this whole function out across every line item.
  const [product, variant] = await Promise.all([
    Product.findOne({ _id: productId, tenant_id: tenantId }),
    variantId
      ? ProductVariant.findOne({ _id: variantId, product: productId, tenant_id: tenantId })
      : Promise.resolve(null),
  ]);
  if (!product) {
    throw httpError("Product not found", 400);
  }
  if (variantId && !variant) {
    throw httpError("Product variant not found", 400);
  }

  let unitPriceDollars = product.price;
  let sku = product.sku;
  let name = product.title;

  if (variant) {
    unitPriceDollars = variant.price ?? unitPriceDollars;
    sku = variant.sku || sku;
    name = `${product.title} — ${variant.display_name}`;
  }

  if (product.stock_control) {
    const available = await getTotalStockForProductVariant(productId, variantId || null);
    if (available < quantity) {
      throw httpError(`Insufficient stock for "${name}" — only ${available} left`, 400);
    }
  }

  const unitPriceCents = Math.round(unitPriceDollars * 100);
  const lineSubtotalCents = unitPriceCents * quantity;
  const discountCents = Math.round(discount_amount * 100);
  if (discountCents < 0 || discountCents > lineSubtotalCents) {
    throw httpError(`Discount for "${name}" cannot exceed the line subtotal`, 400);
  }

  return {
    product: product._id,
    variant: variant ? variant._id : null,
    name,
    sku,
    unit_price: unitPriceCents,
    shipping_cost: product.shipping_cost ?? 0, // dollars, per-unit freight cost
    quantity,
    discount_amount: discountCents,
    note: note || null,
  };
}

// Admin-created in-person/counter sale — always linked to a known Customer
// record (found via search or just created on the fly by the caller), always
// channel MANUAL, and settled with whatever the staff member collected at
// the register rather than a Stripe payment intent. Stock is decremented
// immediately (unlike storefront, which waits for the Stripe webhook)
// because the goods leave with the customer now regardless of how much of
// the invoice is actually paid.
async function createManualOrder(
  {
    customer_id,
    items,
    delivery_method = ORDER_DELIVERY_METHOD.PICKUP,
    shipping_address,
    billing_address,
    note,
    amount_paid = 0,
    payment_method,
    shipping_cost: shippingCostOverride,
  },
  tenant,
) {
  const customer = await Customer.findOne({ _id: customer_id, tenant_id: tenant._id });
  if (!customer) {
    throw httpError("Customer not found", 400);
  }
  if (!Array.isArray(items) || !items.length) {
    throw httpError("Order must contain at least one item", 400);
  }

  // Each line item's own product/variant/stock lookups are independent of
  // every other line item — resolving them concurrently instead of one at a
  // time is what actually made multi-item in-store sales slow to create.
  const resolvedItems = await Promise.all(items.map((item) => resolveManualOrderItem(item, tenant._id)));

  const isPickup = delivery_method === ORDER_DELIVERY_METHOD.PICKUP;
  const subtotal = resolvedItems.reduce(
    (sum, i) => sum + (i.unit_price * i.quantity - i.discount_amount),
    0,
  );
  // Nothing to ship for pickup — skip the per-item shipping cost entirely
  // rather than charging for shipping that never happens. Mirrors createOrder
  // (storefront checkout) so a staff-created delivery order isn't silently free freight.
  // The staff member can override the computed total on the review step
  // (e.g. a bulky/oversized item quoted a flat rate) — shippingCostOverride
  // wins over the per-item sum when provided.
  const shipping_cost = isPickup
    ? 0
    : shippingCostOverride != null
      ? Math.round(shippingCostOverride * 100)
      : Math.round(
          resolvedItems.reduce((sum, i) => sum + i.shipping_cost * i.quantity, 0) * 100, // dollars -> cents
        );
  const tax_amount = Math.round(subtotal / GST_DIVISOR); // GST already included in subtotal, display-only
  const total = subtotal + shipping_cost;

  // "payment_link" means nothing is collected now — the customer pays later
  // via a Stripe-hosted link generated separately (see
  // createPaymentLinkForOrder) — so any amount_paid sent alongside it is
  // ignored rather than trusted.
  const isPaymentLink = payment_method === ORDER_PAYMENT_CHOICE.PAYMENT_LINK;
  const amountPaidCents = isPaymentLink ? 0 : Math.round(amount_paid * 100);
  if (amountPaidCents < 0 || amountPaidCents > total) {
    throw httpError("Amount paid cannot exceed the order total", 400);
  }

  const order = await Order.create({
    tenant_id: tenant._id,
    order_number: await nextOrderNumber(tenant._id),
    order_number_prefix: tenant.order_number_prefix,
    invoice_number: await nextInvoiceNumber(tenant._id),
    invoice_number_prefix: tenant.invoice_number_prefix,
    items: resolvedItems,
    customer: {
      name: customer.name,
      company_name: customer.company_name || null,
      email: customer.email || null,
      phone: customer.phone || null,
    },
    customer_id: customer._id,
    delivery_method,
    shipping_address: isPickup ? null : shipping_address,
    billing_address: isPickup ? null : billing_address || null,
    note: note || null,
    subtotal,
    shipping_cost,
    tax_amount,
    total,
    currency: "aud",
    // §1.2/§9 — payment_status alongside the legacy status (see
    // stripe.webhook.service.js#handlePaymentSucceeded's own comment on why
    // this pairing is required everywhere status gets a payment-derived
    // value: createRefund's admission check gates on payment_status
    // specifically, not status).
    status: derivePaymentStatus(amountPaidCents, total),
    payment_status: derivePaymentStatus(amountPaidCents, total),
    channel: ORDER_CHANNEL.MANUAL,
    guest_access_token: generateGuestAccessToken(),
  });

  const { hasShortfall, note: stockIssueNote } = await syncOrderStock(order, DIRECTION.DEDUCT, {
    reasonPrefix: "Manual sale",
    saleType: ADJUSTMENT_TYPE.MANUAL_SALE,
  });
  if (hasShortfall) {
    order.has_stock_issue = true;
    order.stock_issue_note = stockIssueNote;
  }

  // No Payment record at all when nothing was collected yet (invoice due in
  // full, or a payment link was chosen instead) — a Payment doc represents
  // money actually received, not an outstanding balance.
  if (amountPaidCents > 0) {
    const payment = await Payment.create({
      tenant_id: tenant._id,
      order: order._id,
      provider: PAYMENT_PROVIDER.MANUAL,
      payment_method,
      amount: amountPaidCents,
      currency: "aud",
      status: PAYMENT_STATUS.SUCCEEDED,
      paid_at: new Date(),
    });
    order.payment = payment._id;
  }

  await order.save();

  // Best-effort — a broken notification pipeline must never fail order
  // creation. Mirrors stripe.webhook.service.js#handlePaymentSucceeded's own
  // "never let an email hiccup fail this webhook" try/catch around
  // sendOrderConfirmation.
  try {
    await notificationService.notifyNewOrder(tenant._id, order);
  } catch (err) {
    logger.error(`[order.service] failed to notify new manual order ${order.order_number}`, { error: err.message });
  }

  return order;
}

// Records a follow-up cash/online-transfer payment against an order that
// still has a balance outstanding — e.g. a manual-sale deposit followed by
// the customer settling the rest later, without a second Stripe payment
// link. Never touches stock: manual orders already had theirs deducted in
// full at createManualOrder() regardless of how much was actually collected.
async function recordOrderPayment(orderId, { payment_method, amount }, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId });
  if (!order) {
    throw httpError("Order not found", 404);
  }
  // Storefront/eBay orders are only ever settled through Stripe (their stock
  // deduction is gated on that webhook firing) — a staff-recorded cash/
  // transfer payment only makes sense for a manual/in-store sale, whose
  // stock was already deducted up front at creation regardless of payment.
  if (order.channel !== ORDER_CHANNEL.MANUAL) {
    throw httpError("Only manual orders can have a payment recorded against them", 400);
  }
  if (![ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PARTIALLY_PAID].includes(order.status)) {
    throw httpError("This order has no outstanding balance to collect", 409);
  }

  const totalPaidCents = await getTotalPaidForOrder(order._id);
  const remainingCents = order.total - totalPaidCents;
  const amountCents = Math.round(amount * 100);
  if (amountCents <= 0 || amountCents > remainingCents) {
    throw httpError(`Amount must be between $0.01 and ${formatCentsAsDollars(remainingCents)}`, 400);
  }

  const payment = await Payment.create({
    tenant_id: tenantId,
    order: order._id,
    provider: PAYMENT_PROVIDER.MANUAL,
    payment_method,
    amount: amountCents,
    currency: order.currency,
    status: PAYMENT_STATUS.SUCCEEDED,
    paid_at: new Date(),
  });

  order.payment = payment._id;
  // See createManualOrder's matching comment — payment_status alongside the
  // legacy status, not instead of it.
  const derivedStatus = derivePaymentStatus(totalPaidCents + amountCents, order.total);
  order.status = derivedStatus;
  order.payment_status = derivedStatus;
  await order.save();

  return order;
}

// Corrects the order's OWN customer/address snapshot (e.g. a mistyped
// email, an updated phone number) — deliberately never touches the linked
// Customer record even when customer_id is set. Orders are a historical
// record and this snapshot is already independent of the master Customer
// profile (see Order.js's `customer` field) — the same separation applies
// here, so this only ever corrects what's on this specific invoice.
async function updateOrderCustomerDetails(orderId, { customer, shipping_address, billing_address }, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId });
  if (!order) {
    throw httpError("Order not found", 404);
  }

  if (customer) {
    if (customer.name !== undefined) order.customer.name = customer.name;
    if (customer.email !== undefined) order.customer.email = customer.email || null;
    if (customer.phone !== undefined) order.customer.phone = customer.phone || null;
  }

  // Pickup orders carry no address at all — silently ignore address fields
  // sent for one rather than erroring, since the client shouldn't need to
  // know this order's delivery_method before deciding what to send.
  const isPickup = order.delivery_method === ORDER_DELIVERY_METHOD.PICKUP;
  if (!isPickup) {
    if (shipping_address !== undefined) order.shipping_address = shipping_address;
    if (billing_address !== undefined) order.billing_address = billing_address || null;
  }

  await order.save();
  return order;
}

// Optional customer/staff-supplied reference (e.g. a customer's own PO
// number) shown on the invoice when set — distinct from the system-generated
// order_number/invoice_number, so no total recompute is needed here.
async function updateOrderReferenceNumber(orderId, { reference_number }, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId });
  if (!order) {
    throw httpError("Order not found", 404);
  }

  order.reference_number = reference_number || null;

  await order.save();
  return order;
}

// Channels whose line items/shipping can be corrected after the fact —
// storefront prices are the storefront's own listed price (editing it here
// would desync from what the customer actually saw at checkout), so that
// channel is deliberately excluded from all three functions below.
const EDITABLE_CHANNELS = [ORDER_CHANNEL.EBAY, ORDER_CHANNEL.MANUAL];

// Corrects a single line item's price on an eBay or manual order — e.g. a
// listing that synced with the wrong price, or a staff mis-key at the
// register. Recomputes subtotal/tax_amount/total the same way order creation
// does, so the invoice always reflects live line-item data rather than a
// stale creation-time snapshot. Note: if the order was already paid before
// this edit, the new total can diverge from what was actually collected —
// that's surfaced to staff via the order's Balance Outstanding figure for
// manual reconciliation, not auto-resolved here (no refund/extra-charge is
// triggered).
async function updateOrderItemPrice(orderId, itemIndex, { unit_price, userId }, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId });
  if (!order) {
    throw httpError("Order not found", 404);
  }
  if (!EDITABLE_CHANNELS.includes(order.channel)) {
    throw httpError("Only eBay and in-store order prices can be edited after the fact", 400);
  }
  const item = order.items[itemIndex];
  if (!item) {
    throw httpError("Order item not found", 404);
  }
  if (!Number.isFinite(unit_price) || unit_price <= 0) {
    throw httpError("Unit price must be greater than 0", 400);
  }

  const unitPriceCents = Math.round(unit_price * 100);
  if (item.original_unit_price === null) {
    item.original_unit_price = item.unit_price;
  }
  item.unit_price = unitPriceCents;
  item.unit_price_updated_at = new Date();
  item.unit_price_updated_by = userId || null;

  order.subtotal = order.items.reduce((sum, i) => sum + (i.unit_price * i.quantity - i.discount_amount), 0);
  order.tax_amount = Math.round(order.subtotal / GST_DIVISOR);
  order.total = order.subtotal - order.discount_amount + order.shipping_cost;

  await order.save();
  return order;
}

// Corrects the order's freight charge after the fact — e.g. a shipping quote
// that turned out wrong. eBay and manual orders only, same reasoning as
// updateOrderItemPrice. Mirrors its recompute of tax_amount/total; same "no
// auto refund/extra-charge" caveat applies if the order was already paid.
async function updateOrderShippingCost(orderId, { shipping_cost }, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId });
  if (!order) {
    throw httpError("Order not found", 404);
  }
  if (!EDITABLE_CHANNELS.includes(order.channel)) {
    throw httpError("Only eBay and in-store order shipping costs can be edited after the fact", 400);
  }
  if (!Number.isFinite(shipping_cost) || shipping_cost < 0) {
    throw httpError("Shipping cost cannot be negative", 400);
  }

  order.shipping_cost = Math.round(shipping_cost * 100);
  order.total = order.subtotal - order.discount_amount + order.shipping_cost;
  if (order.total < 0) {
    throw httpError("Shipping cost would make the order total negative", 400);
  }

  await order.save();
  return order;
}

// Corrects a single line item's discount on an eBay or manual order —
// discount is applied per line item (not as one order-level lump), so
// staff have exactly one place to change it. eBay and manual orders only,
// same reasoning as updateOrderItemPrice. Mirrors its recompute of
// subtotal/tax_amount/total; same "no auto refund/extra-charge" caveat
// applies if the order was already paid.
async function updateOrderItemDiscount(orderId, itemIndex, { discount_amount }, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId });
  if (!order) {
    throw httpError("Order not found", 404);
  }
  if (!EDITABLE_CHANNELS.includes(order.channel)) {
    throw httpError("Only eBay and in-store order discounts can be edited after the fact", 400);
  }
  const item = order.items[itemIndex];
  if (!item) {
    throw httpError("Order item not found", 404);
  }
  if (!Number.isFinite(discount_amount) || discount_amount < 0) {
    throw httpError("Discount cannot be negative", 400);
  }

  const discountCents = Math.round(discount_amount * 100);
  const lineSubtotalCents = item.unit_price * item.quantity;
  if (discountCents > lineSubtotalCents) {
    throw httpError("Discount cannot exceed the line subtotal", 400);
  }

  item.discount_amount = discountCents;

  order.subtotal = order.items.reduce((sum, i) => sum + (i.unit_price * i.quantity - i.discount_amount), 0);
  order.tax_amount = Math.round(order.subtotal / GST_DIVISOR);
  order.total = order.subtotal - order.discount_amount + order.shipping_cost;

  await order.save();
  return order;
}

// Adds a staff comment to an order's internal notes thread — distinct from
// the customer-facing `note` captured once at creation.
async function addOrderNote(orderId, { text, userId }, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId });
  if (!order) {
    throw httpError("Order not found", 404);
  }
  order.internal_notes.push({ text, author: userId || null, created_at: new Date() });
  await order.save();
  return order;
}

// `tenant` is resolved by the guest-facing storefront's own tenant
// identifier (see routes/order.routes.js), not a JWT — this is the one
// order-creation path with no authenticated staff user behind it.
async function createOrder(
  { items, customer, shipping_address, billing_address, delivery_method = ORDER_DELIVERY_METHOD.DELIVERY },
  tenant,
) {
  if (!Array.isArray(items) || !items.length) {
    throw httpError("Order must contain at least one item", 400);
  }

  const resolvedItems = [];
  for (const item of items) {
    resolvedItems.push(await resolveOrderItem(item, tenant._id));
  }

  const isPickup = delivery_method === ORDER_DELIVERY_METHOD.PICKUP;
  const subtotal = resolvedItems.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
  // Nothing to ship for pickup — skip the per-item shipping cost entirely
  // rather than charging for shipping that never happens.
  const shipping_cost = isPickup
    ? 0
    : Math.round(
        resolvedItems.reduce((sum, i) => sum + i.shipping_cost * i.quantity, 0) * 100, // dollars -> cents
      );
  const total = subtotal + shipping_cost;
  const tax_amount = Math.round(subtotal / GST_DIVISOR); // GST already included in subtotal, display-only

  const order = await Order.create({
    tenant_id: tenant._id,
    order_number: await nextOrderNumber(tenant._id),
    order_number_prefix: tenant.order_number_prefix,
    invoice_number: await nextInvoiceNumber(tenant._id),
    invoice_number_prefix: tenant.invoice_number_prefix,
    items: resolvedItems,
    customer,
    delivery_method,
    shipping_address: isPickup ? null : shipping_address,
    billing_address: isPickup ? null : billing_address || null,
    subtotal,
    shipping_cost,
    tax_amount,
    total,
    currency: "aud",
    status: ORDER_STATUS.PENDING_PAYMENT,
    guest_access_token: generateGuestAccessToken(),
  });

  return order;
}

// Resolves one mapped eBay line item to a stored order line — unlike
// resolveOrderItem() (storefront), we trust eBay's own price/title snapshot
// rather than re-deriving from the current Product, since that's what the
// buyer actually paid at the time. Returns null if the SKU doesn't match any
// known product/variant (e.g. a listing not managed through this app) so the
// caller can skip just that line instead of failing the whole import.
async function resolveEbayLineItem(lineItem, tenantId) {
  if (!lineItem.sku) return null;

  // resolveSkuToIds is tenant-scoped (SKUs are only unique per-tenant), so
  // this can only ever resolve to a product this tenant actually owns. The
  // Product/ProductVariant re-fetch below with an explicit tenant_id filter
  // is now redundant defense-in-depth rather than the only thing preventing
  // a cross-tenant mismatch — kept anyway since it's cheap and guards
  // against resolveSkuToIds ever regressing independently of this call site.
  const ids = await resolveSkuToIds(lineItem.sku, tenantId);
  if (!ids) {
    logger.warn(`[order.service] eBay order line SKU not found locally: ${lineItem.sku}`);
    return null;
  }

  const product = await Product.findOne({ _id: ids.productId, tenant_id: tenantId }).select("_id title sku").lean();
  if (!product) return null;
  const variant = ids.variantId
    ? await ProductVariant.findOne({ _id: ids.variantId, tenant_id: tenantId }).select("_id sku display_name").lean()
    : null;

  return {
    product: product._id,
    variant: variant ? variant._id : null,
    name: lineItem.title || product.title,
    sku: lineItem.sku,
    unit_price: lineItem.unitPriceCents,
    quantity: lineItem.quantity,
  };
}

// Imports a paid eBay order into the same Order collection storefront orders
// live in (single source of truth for all channels). Idempotent on
// external_order_id — safe to call again on every poll cycle without
// creating duplicates. Returns null (not an error) when the order was
// already imported, or when none of its line items match a known product —
// callers should treat null as "nothing further to do", not a failure.
async function createOrderFromEbayOrder(rawEbayOrder, tenant, settings) {
  const mapped = mapEbayOrder(rawEbayOrder, { ORDER_STATUS });
  if (!mapped.externalOrderId) {
    logger.warn("[order.service] eBay order payload missing orderId — skipping import");
    return null;
  }

  const existing = await Order.findOne({
    tenant_id: tenant._id,
    channel: ORDER_CHANNEL.EBAY,
    external_order_id: mapped.externalOrderId,
  });
  if (existing) return existing;

  const resolvedItems = [];
  for (const lineItem of mapped.lineItems) {
    const resolved = await resolveEbayLineItem(lineItem, tenant._id);
    if (resolved) resolvedItems.push(resolved);
  }

  if (!resolvedItems.length) {
    logger.warn(
      `[order.service] eBay order ${mapped.externalOrderId} has no line items matching a known product — skipping import`,
    );
    return null;
  }

  const order = await Order.create({
    tenant_id: tenant._id,
    order_number: await nextOrderNumber(tenant._id),
    order_number_prefix: tenant.order_number_prefix,
    invoice_number: await nextInvoiceNumber(tenant._id),
    invoice_number_prefix: tenant.invoice_number_prefix,
    items: resolvedItems,
    customer: mapped.customer,
    shipping_address: mapped.shippingAddress,
    billing_address: null,
    subtotal: mapped.subtotalCents,
    shipping_cost: mapped.shippingCents,
    tax_amount: mapped.taxCents,
    total: mapped.totalCents,
    // Was hardcoded "aud" regardless of what currency the eBay order
    // actually transacted in — prefer eBay's own reported currency (see
    // ebay.order.mapper.js), falling back to this tenant's configured
    // marketplace currency only if that's genuinely absent. Found live.
    currency: (mapped.currency || currencyForMarketplace(settings?.marketplace_id)).toLowerCase(),
    status: mapped.status,
    // eBay orders arrive already paid — eBay Managed Payments settles
    // before the order is ever pushed to us, so there's no "pending" state
    // to model here, unlike storefront/manual. mapped.status is only ever
    // ORDER_STATUS.PAID or ORDER_STATUS.FULFILLED (see mapStatus), so
    // payment_status is unconditionally PAID and fulfillment_status follows
    // mapped.status the same way sendOrderNotification's own comment
    // describes for the storefront/manual path — see this file's other two
    // payment_status write sites (createManualOrder, recordOrderPayment)
    // and stripe.webhook.service.js#handlePaymentSucceeded for why this
    // pairing is required everywhere `status` gets a payment-derived value.
    payment_status: ORDER_PAYMENT_STATUS.PAID,
    fulfillment_status:
      mapped.status === ORDER_STATUS.FULFILLED ? ORDER_FULFILLMENT_STATUS.COMPLETED : ORDER_FULFILLMENT_STATUS.PENDING,
    channel: ORDER_CHANNEL.EBAY,
    external_order_id: mapped.externalOrderId,
    external_buyer_username: mapped.externalBuyerUsername,
    external_raw_payload: rawEbayOrder,
    guest_access_token: generateGuestAccessToken(),
  });

  // eBay collects payment on their end (Managed Payments) before the order
  // ever reaches us — mapped.status is always PAID/FULFILLED, never
  // PENDING_PAYMENT (see mapStatus()), so the full total is recorded as
  // already collected. Without this, every eBay order looked unpaid to the
  // rest of the app (balance-due banners, invoice totals, payment history)
  // since nothing else ever creates a Payment for this channel.
  const payment = await Payment.create({
    tenant_id: tenant._id,
    order: order._id,
    provider: PAYMENT_PROVIDER.EBAY,
    amount: order.total,
    currency: order.currency,
    status: PAYMENT_STATUS.SUCCEEDED,
    paid_at: order.created_at,
  });
  order.payment = payment._id;
  await order.save();

  logger.info(`[order.service] imported eBay order ${mapped.externalOrderId} as ${order.order_number}`);

  // Best-effort — see the identical comment in createManualOrder above.
  try {
    await notificationService.notifyNewOrder(tenant._id, order);
  } catch (err) {
    logger.error(`[order.service] failed to notify new eBay order ${order.order_number}`, { error: err.message });
  }

  return order;
}

// Reflects an eBay order-level cancellation/return notification onto the
// matching local Order. No-op (returns null) if that eBay order was never
// imported here, e.g. its line items didn't match any known product —
// consistent with createOrderFromEbayOrder() treating that as "nothing to
// do" rather than an error. Doesn't create a Refund record automatically:
// eBay-side refunds are settled through eBay's own managed payments, not
// ours, so there's nothing for us to actually reverse here — staff can
// still record a manual refund against the order's Payment (see
// refund.service.js#createManualRefund) if they want it reflected locally.
//
// eBay sends one LINE_ITEMS_UPDATED event per SKU, so a multi-item order
// can have just one line cancelled while the rest still ship — only flip
// the whole order's status when this notification covers every item on it;
// otherwise it's a partial cancellation and the status is left alone for
// manual reconciliation (the stock adjustment for that SKU still applies
// regardless, via the caller).
async function updateEbayOrderStatus(externalOrderId, { sku, quantity, status }, tenantId) {
  const order = await Order.findOne({
    tenant_id: tenantId,
    channel: ORDER_CHANNEL.EBAY,
    external_order_id: externalOrderId,
  });
  if (!order) return null;

  const isFullOrderCancellation =
    order.items.length === 1 && order.items[0].sku === sku && order.items[0].quantity === quantity;
  if (!isFullOrderCancellation) {
    logger.warn(
      `[order.service] eBay order ${externalOrderId}: partial cancellation/return (${sku} x${quantity}) — leaving status "${order.status}" as-is for manual review`,
    );
    return order;
  }

  order.status = status;
  // Only for an actual cancellation — a RETURNED status here means the
  // order already shipped and came back, which isn't "cancelled" in the
  // fulfillment sense, so fulfillment_status is deliberately left as-is.
  // Note: eBay-channel refunds/returns settle entirely on eBay's own side
  // (no local Payment/Refund record — see refund-redesign-spec.md §5), so
  // there is no equivalent payment_status update to make here; that split
  // was never modeled for this channel's cancellation path and stays a
  // known, pre-existing gap rather than one introduced by this change.
  if (status === ORDER_STATUS.CANCELLED) {
    order.fulfillment_status = ORDER_FULFILLMENT_STATUS.CANCELLED;
  }
  await order.save();
  return order;
}

// Admin-triggered status change from the order detail page's status dropdown.
// Unconditional, exactly like flowpos's orderStatusChange — no payment-state
// gating of any kind. Writes ONLY fulfillment_status; payment_status is
// always derived from actual payments (derivePaymentStatus/
// recordOrderPayment/refund.service.js), never settable by hand, so order
// status and payment status stay fully independent no matter what state
// either is in. Legacy `status` is kept in sync as a pure derivation (see
// utils/paymentStatus.js#deriveLegacyOrderStatus) for the handful of readers
// not yet migrated off it — dashboard aggregation, invoice PDF, eBay/Stripe
// internals.
async function updateOrderStatus(orderId, { status }, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId });
  if (!order) throw httpError("Order not found", 404);

  // Restock only fires on the transition INTO cancelled (not a guard against
  // the change itself — just avoids double-restocking if already cancelled).
  if (status === ORDER_FULFILLMENT_STATUS.CANCELLED && order.fulfillment_status !== ORDER_FULFILLMENT_STATUS.CANCELLED) {
    await syncOrderStock(order, DIRECTION.RESTOCK, { reasonPrefix: "Order cancelled" });
  }

  order.fulfillment_status = status;
  order.status = deriveLegacyOrderStatus(order.fulfillment_status, order.payment_status);

  await order.save();
  return order;
}

function safeTokenMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Public/guest lookup — requires the token issued once at creation. Returns
// a generic 404 (not 401/403) on a bad token so a guessed order ID doesn't
// even confirm the order exists.
// tenantId is resolved from the storefront's own tenant identifier (see
// routes/order.routes.js) — added defensively alongside the token check,
// not in place of it.
async function getOrderForGuest(orderId, token, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId })
    .select("+guest_access_token")
    .populate("payment", "provider payment_method status card_brand card_last4 amount amount_refunded paid_at");
  if (!order || !safeTokenMatch(order.guest_access_token, token)) {
    throw httpError("Order not found", 404);
  }
  return order;
}

// ── Admin ────────────────────────────────────────────────────────────────

async function listOrders(
  { page = 1, limit = 20, skip = 0, status, channel, delivery_method, fulfillment_status, payment_status, search } = {},
  tenantId,
) {
  const filter = { tenant_id: tenantId };
  if (status) filter.status = status;
  if (channel) filter.channel = channel;
  if (delivery_method) filter.delivery_method = delivery_method;
  if (fulfillment_status) filter.fulfillment_status = fulfillment_status;
  if (payment_status) filter.payment_status = payment_status;
  if (search) {
    const tenant = await Tenant.findById(tenantId).select("order_number_prefix invoice_number_prefix").lean();
    const strippedSearch = stripOrderNumberPrefix(search, [tenant?.order_number_prefix, tenant?.invoice_number_prefix]);
    filter.$or = buildWordSearchOr(["order_number", "customer.name", "customer.email"], strippedSearch);
  }

  const [items, total] = await Promise.all([
    Order.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .populate("payment", "provider payment_method status amount amount_refunded card_brand card_last4 paid_at"),
    Order.countDocuments(filter),
  ]);

  return {
    items,
    total,
    page,
    pageSize: limit,
    totalPages: Math.ceil(total / limit),
  };
}

// Full order record for the admin detail/invoice view — unlike
// getOrderForGuest, this isn't token-gated (route requires admin JWT auth
// instead) and includes the order's full payment + refund history, rather
// than just the single most-recently-created Payment `order.payment` points
// at (which a deposit + follow-up payment would make incomplete/stale).
async function getOrderDetailForAdmin(orderId, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId });
  if (!order) throw httpError("Order not found", 404);

  const [payments, refunds] = await Promise.all([
    getPaymentsForOrder(order._id),
    Refund.find({ order: order._id }).sort({ created_at: -1 }),
  ]);

  const { payment, ...orderFields } = order.toObject();
  return { ...orderFields, payments, refunds };
}

// Admin action triggered by the "Send Email" button on the order detail
// page. Tracking info is optional for DELIVERY orders — the admin can add
// it via a toggle in the modal, or send without it. Providing it here IS
// the fulfilment step's data capture, but marking the order FULFILLED
// happens either way. Once tracking is on file, re-sending (e.g. the
// customer says they missed the email) reuses it instead of asking again;
// passing new tracking_number/carrier_name always overwrites what's on
// file. Both paths attach the same tax invoice PDF; only the accompanying
// email (shipped vs ready-for-pickup) differs.
async function sendOrderNotification(orderId, { tracking_number, carrier_name } = {}, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId }).populate("payment");
  if (!order) throw httpError("Order not found", 404);

  // Sums every succeeded Payment on the order, not just the most recently
  // created one (order.payment) — a manual sale can have a deposit plus a
  // separate follow-up payment, and the invoice must reflect both.
  const [totalPaidCents, totalRefundedCents, companyProfile] = await Promise.all([
    getTotalPaidForOrder(order._id),
    getTotalRefundedForOrder(order._id),
    getCompanyProfile(order.tenant_id),
  ]);

  // In-person sales are already complete when created — no shipped/pickup
  // framing applies, just the invoice (with the outstanding balance called
  // out, if any) attached to a plain receipt email.
  if (order.channel === ORDER_CHANNEL.MANUAL) {
    if (!order.customer.email) {
      throw httpError("This customer has no email on file — add one before sending an invoice", 400);
    }
    const pdfBuffer = await buildInvoicePdfBuffer(order.toObject(), { totalPaidCents, totalRefundedCents, companyProfile });
    const amountDueCents = order.total - totalPaidCents;
    await emailService.sendManualOrderReceipt({
      to: order.customer.email,
      name: order.customer.name,
      orderNumber: formatOrderNumber(order.order_number_prefix, order.order_number),
      amountDue: amountDueCents > 0 ? formatCentsAsDollars(amountDueCents) : null,
      pdfBase64: pdfBuffer.toString("base64"),
      pdfFilename: `${formatOrderNumber(order.order_number_prefix, order.order_number)}-invoice.pdf`,
      companyProfile,
      tenantId: order.tenant_id,
    });
    return order;
  }

  const isDelivery = order.delivery_method === ORDER_DELIVERY_METHOD.DELIVERY;

  if (isDelivery) {
    const trimmedTracking = tracking_number?.trim();
    const trimmedCarrier = carrier_name?.trim();

    if (trimmedTracking && trimmedCarrier) {
      order.tracking_number = trimmedTracking;
      order.carrier_name = trimmedCarrier;
    } else if (trimmedTracking || trimmedCarrier) {
      throw httpError("Carrier name and tracking number must be provided together", 400);
    }

    if (order.fulfillment_status !== ORDER_FULFILLMENT_STATUS.COMPLETED) {
      order.fulfillment_status = ORDER_FULFILLMENT_STATUS.COMPLETED;
      // Legacy `status` derived, not set directly — see
      // utils/paymentStatus.js#deriveLegacyOrderStatus. refund.service.js's
      // recomputeLedger reads fulfillment_status to decide whether a refund
      // may legitimately overwrite the legacy `status` field; without this,
      // it would never see "completed" and would incorrectly revert it.
      order.status = deriveLegacyOrderStatus(order.fulfillment_status, order.payment_status);
    }
    await order.save();
  }

  const pdfBuffer = await buildInvoicePdfBuffer(order.toObject(), { totalPaidCents, totalRefundedCents, companyProfile });
  const pdfBase64 = pdfBuffer.toString("base64");
  const pdfFilename = `${formatOrderNumber(order.order_number_prefix, order.order_number)}-invoice.pdf`;

  if (isDelivery) {
    await emailService.sendOrderShipped({
      to: order.customer.email,
      name: order.customer.name,
      orderNumber: formatOrderNumber(order.order_number_prefix, order.order_number),
      trackingNumber: order.tracking_number,
      carrierName: order.carrier_name,
      pdfBase64,
      pdfFilename,
      companyProfile,
      tenantId: order.tenant_id,
    });
  } else {
    await emailService.sendOrderReadyForPickup({
      to: order.customer.email,
      name: order.customer.name,
      orderNumber: formatOrderNumber(order.order_number_prefix, order.order_number),
      pdfBase64,
      pdfFilename,
      pickupLocation: companyProfile.pickup_location,
      companyProfile,
      tenantId: order.tenant_id,
    });
  }

  return order;
}

// Admin action triggered by the "Send Payment Link" button on the manual
// order creation confirmation screen — emails the customer the same URL
// createPaymentLinkForOrder (stripe.payment.service.js) already builds for
// staff to copy/open manually, so they don't have to relay it themselves.
// Owns the order lookup itself (not just the email) so the controller never
// touches Mongoose directly — same DB-access-stays-in-the-service-layer rule
// every other admin order endpoint in this file follows.
async function sendPaymentLinkEmail(orderId, tenant) {
  // +guest_access_token: select:false by default — needed to build the link.
  const order = await Order.findOne({ _id: orderId, tenant_id: tenant._id }).select("+guest_access_token");
  if (!order) throw httpError("Order not found", 404);

  if (!order.customer.email) {
    throw httpError("This customer has no email on file — add one before sending a payment link.", 400);
  }

  const { url } = createPaymentLinkForOrder(order, tenant);

  const [totalPaidCents, companyProfile] = await Promise.all([
    getTotalPaidForOrder(order._id),
    getCompanyProfile(order.tenant_id),
  ]);
  const amountDueCents = order.total - totalPaidCents;

  await emailService.sendPaymentLink({
    to: order.customer.email,
    name: order.customer.name,
    orderNumber: formatOrderNumber(order.order_number_prefix, order.order_number),
    amountDue: amountDueCents > 0 ? formatCentsAsDollars(amountDueCents) : null,
    paymentUrl: url,
    companyProfile,
    tenantId: order.tenant_id,
  });

  return { url };
}

// Admin action triggered by the "Download PDF" button on the order detail
// page — the same pdfkit-rendered tax invoice emailed via sendOrderNotification,
// just handed straight to the browser instead of attached to an email. Kept as
// its own read-only fetch (rather than reusing sendOrderNotification) since
// downloading never needs the tracking-number capture/fulfilment side effect
// that function has for delivery orders.
async function getInvoicePdfForOrder(orderId, tenantId) {
  const order = await Order.findOne({ _id: orderId, tenant_id: tenantId }).populate("payment");
  if (!order) throw httpError("Order not found", 404);

  const [totalPaidCents, totalRefundedCents, companyProfile] = await Promise.all([
    getTotalPaidForOrder(order._id),
    getTotalRefundedForOrder(order._id),
    getCompanyProfile(order.tenant_id),
  ]);
  const pdfBuffer = await buildInvoicePdfBuffer(order.toObject(), { totalPaidCents, totalRefundedCents, companyProfile });

  return { pdfBuffer, orderNumber: formatOrderNumber(order.order_number_prefix, order.order_number) };
}

module.exports = {
  createOrder,
  createManualOrder,
  recordOrderPayment,
  updateOrderCustomerDetails,
  updateOrderReferenceNumber,
  getOrderForGuest,
  createOrderFromEbayOrder,
  updateEbayOrderStatus,
  updateOrderStatus,
  listOrders,
  getOrderDetailForAdmin,
  sendOrderNotification,
  sendPaymentLinkEmail,
  getInvoicePdfForOrder,
  addOrderNote,
  updateOrderItemPrice,
  updateOrderShippingCost,
  updateOrderItemDiscount,
};
