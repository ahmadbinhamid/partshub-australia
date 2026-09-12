// services/dashboard.service.js
//
// Every function here takes tenantId and scopes its queries by it — this
// file previously had NO tenant filtering anywhere (Order.find({}),
// InventoryHistory.find({}), etc.), so any tenant's admin loading their own
// dashboard saw every OTHER tenant's revenue, orders, customer names/emails,
// and stock levels too. Found live. Inventory/InventoryHistory have no
// tenant_id field of their own (see Inventory.js/InventoryHistory.js), so
// those are scoped via a $lookup on Product + a match on product.tenant_id
// instead of a direct filter.

const Order = require("../models/Order");
const Inventory = require("../models/Inventory");
const InventoryHistory = require("../models/InventoryHistory");
const MarketplaceListing = require("../models/MarketplaceListing");
const InventorySettings = require("../models/InventorySettings");
const Tenant = require("../models/Tenant");
const { ORDER_STATUS, ORDER_CHANNEL } = require("../constants/order.constants");
const { LISTING_STATE } = require("../constants/marketplace.constants");
const { buildWordSearchOr } = require("../utils/regex");
const { formatOrderNumber, stripOrderNumberPrefix } = require("../utils/orderNumberFormat");

// Orders still awaiting settlement — what the dashboard means by "pending".
const PENDING_ORDER_STATUSES = [ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PARTIALLY_PAID];

// ── Stat cards ───────────────────────────────────────────────────────────────

// Sum of stock_count * product.price (dollars — Product.price is stored in
// dollars, unlike Order/Payment which are cents) across every inventory
// record for a non-deleted product belonging to this tenant.
async function getInventoryValue(tenantId) {
  const [result] = await Inventory.aggregate([
    { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "product" } },
    { $unwind: "$product" },
    { $match: { "product.deleted_at": null, "product.tenant_id": tenantId } },
    { $group: { _id: null, totalValue: { $sum: { $multiply: ["$stock_count", "$product.price"] } } } },
  ]);
  return result?.totalValue || 0;
}

// Real (not fabricated) trend figure for the Total Inventory Value card —
// the % the value has moved over the last `days` days, derived from actual
// InventoryHistory adjustments (each one's stock delta × the product's
// price) rather than a snapshot history this app doesn't keep. Returns null
// when there isn't enough history to establish a baseline (division by
// zero, or a brand-new tenant) — the frontend shows "no trend yet" rather
// than a misleading 0%/Infinity.
//
// Also returns null when the baseline was near-zero — a tenant going from
// $1 of stock to $500 is a real 49900% "increase" but not a meaningful
// trend figure, and rendering it verbatim is what blew out the MetricCard
// layout in production (a 5-character badge assumption baked into the
// component). MAX_MEANINGFUL_CHANGE_PCT draws the line: past it, "no
// baseline to compare against" is the more honest read than the number.
const MAX_MEANINGFUL_CHANGE_PCT = 500;

async function getInventoryValueChangePct(tenantId, currentValue, days = 7) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);

  const [result] = await InventoryHistory.aggregate([
    { $match: { created_at: { $gte: since } } },
    { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "product" } },
    { $unwind: "$product" },
    { $match: { "product.deleted_at": null, "product.tenant_id": tenantId } },
    { $group: { _id: null, netValueChange: { $sum: { $multiply: ["$adjustment", "$product.price"] } } } },
  ]);

  const netValueChange = result?.netValueChange || 0;
  const baselineValue = currentValue - netValueChange;
  if (baselineValue <= 0) return null;

  const changePct = (netValueChange / baselineValue) * 100;
  if (Math.abs(changePct) > MAX_MEANINGFUL_CHANGE_PCT) return null;
  return changePct;
}

// Rolls locations up to one row per product+variant first — "low on stock"
// is a property of the item overall, not of any single shelf.
async function getStockCounts(tenantId, lowStockThreshold) {
  const [result] = await Inventory.aggregate([
    { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "product" } },
    { $unwind: "$product" },
    { $match: { "product.deleted_at": null, "product.tenant_id": tenantId } },
    { $group: { _id: { product: "$product._id", variant: "$variant" }, totalStock: { $sum: "$stock_count" } } },
    {
      $group: {
        _id: null,
        lowStockCount: {
          $sum: {
            $cond: [{ $and: [{ $gt: ["$totalStock", 0] }, { $lte: ["$totalStock", lowStockThreshold] }] }, 1, 0],
          },
        },
        outOfStockCount: { $sum: { $cond: [{ $eq: ["$totalStock", 0] }, 1, 0] } },
      },
    },
  ]);
  return { lowStockCount: result?.lowStockCount || 0, outOfStockCount: result?.outOfStockCount || 0 };
}

async function getPendingOrdersStats(tenantId) {
  const pendingOrders = await Order.find({ tenant_id: tenantId, status: { $in: PENDING_ORDER_STATUSES } })
    .select("created_at")
    .lean();

  if (pendingOrders.length === 0) return { count: 0, avgAgeHours: 0 };

  const now = Date.now();
  const totalAgeMs = pendingOrders.reduce((sum, o) => sum + (now - new Date(o.created_at).getTime()), 0);

  return {
    count: pendingOrders.length,
    avgAgeHours: totalAgeMs / pendingOrders.length / (1000 * 60 * 60),
  };
}

// A platform's health is measured by what fraction of its ACTIVE listings
// are currently in sync — one query per registered adapter (eBay, Google,
// any future one), not hardcoded per platform. Extracted so getChannelHealth
// below can just map this over registry.getAll() instead of duplicating this
// same block again for every new channel — see that function's own comment.
async function getPlatformChannelHealth(tenantId, adapter) {
  const listings = await MarketplaceListing.find({
    tenant_id: tenantId,
    platform: adapter.key,
    state: LISTING_STATE.ACTIVE,
  })
    .select("sync_status synced_at")
    .lean();

  const total = listings.length;
  const syncedCount = listings.filter((l) => l.sync_status === "synced").length;
  const erroredCount = listings.filter((l) => l.sync_status === "error").length;
  const lastSyncedAt = listings.reduce(
    (latest, l) => (l.synced_at && (!latest || l.synced_at > latest) ? l.synced_at : latest),
    null,
  );

  return {
    key: adapter.key,
    name: adapter.manifest?.name || adapter.key,
    status: total === 0 ? "not_connected" : erroredCount > 0 ? "attention" : "operational",
    lastSyncedAt,
    listingsSynced: syncedCount,
    listingsTotal: total,
  };
}

// Storefront is the only channel that isn't a registered marketplace adapter
// (it's always available, no external sync concept) — kept as one hardcoded
// row for that reason; every other channel comes from registry.getAll(), so
// a new adapter (Google today, anything registered later) shows up here with
// zero changes to this function once it's registered — see
// registerAdapters.js.
async function getChannelHealth(tenantId) {
  const registry = require("./marketplace/registry");
  const platformChannels = await Promise.all(
    registry.getAll().map((adapter) => getPlatformChannelHealth(tenantId, adapter)),
  );

  const channels = [
    {
      key: "storefront",
      name: "Storefront",
      status: "operational",
      lastSyncedAt: null,
      detail: "Always available — no external sync",
    },
    ...platformChannels,
  ];

  const operationalCount = channels.filter((c) => c.status === "operational").length;
  const totalListings = platformChannels.reduce((sum, c) => sum + c.listingsTotal, 0);
  const totalSynced = platformChannels.reduce((sum, c) => sum + c.listingsSynced, 0);
  const stabilityPct = totalListings === 0 ? 100 : Math.round((totalSynced / totalListings) * 100);

  return { channels, operationalCount, totalChannels: channels.length, stabilityPct };
}

async function getStats(tenantId) {
  const settings = await InventorySettings.getOrCreate(tenantId);
  // getInventoryValueChangePct needs the current total as its baseline
  // reference point, so it can't join the Promise.all below — the other
  // three are still fetched concurrently with it.
  const totalInventoryValue = await getInventoryValue(tenantId);
  const [inventoryValueChangePct, stockCounts, pendingOrders, channelHealth] = await Promise.all([
    getInventoryValueChangePct(tenantId, totalInventoryValue),
    getStockCounts(tenantId, settings.low_stock_threshold),
    getPendingOrdersStats(tenantId),
    getChannelHealth(tenantId),
  ]);

  return {
    totalInventoryValue,
    inventoryValueChangePct,
    lowStockCount: stockCounts.lowStockCount,
    outOfStockCount: stockCounts.outOfStockCount,
    pendingOrdersCount: pendingOrders.count,
    pendingOrdersAvgAgeHours: pendingOrders.avgAgeHours,
    syncStabilityPct: channelHealth.stabilityPct,
    channelsOperational: channelHealth.operationalCount,
    channelsTotal: channelHealth.totalChannels,
  };
}

// ── Order volume trend ───────────────────────────────────────────────────────

// One bucket per calendar day for the last `days` days (including today),
// always returning a fully-populated series (zero-filled) so the chart never
// has to guess about missing days.
//
// Every boundary here is built with Date.UTC(...) rather than the local-time
// setters (setDate/setHours) that used to be here — those construct a LOCAL
// midnight, which toISOString() (used for the bucket key and for matching
// order.created_at) then renders as the PREVIOUS UTC calendar day on any
// server whose local timezone is ahead of UTC. That silently dropped today
// and shifted the entire window a day into the past. Found by running this
// against real data on a UTC+5 box — every bucket came back one calendar
// day earlier than intended. Since order.created_at is a real timestamp
// compared with the same toISOString() slice, bucketing everything through
// UTC from construction onward is what keeps the two sides consistent.
async function getOrderVolumeTrend(tenantId, days = 7) {
  const now = new Date();
  const sinceUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));

  const orders = await Order.find({
    tenant_id: tenantId,
    created_at: { $gte: sinceUtc },
    status: { $ne: ORDER_STATUS.CANCELLED },
  })
    .select("created_at total items")
    .lean();

  const byDate = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(sinceUtc.getUTCFullYear(), sinceUtc.getUTCMonth(), sinceUtc.getUTCDate() + i));
    const key = d.toISOString().slice(0, 10);
    byDate.set(key, { date: key, orders: 0, revenueCents: 0, items: 0 });
  }

  for (const order of orders) {
    const key = new Date(order.created_at).toISOString().slice(0, 10);
    const bucket = byDate.get(key);
    if (!bucket) continue; // order.created_at rounding edge case — ignore rather than crash
    bucket.orders += 1;
    bucket.revenueCents += order.total;
    bucket.items += order.items.reduce((sum, i) => sum + i.quantity, 0);
  }

  return Array.from(byDate.values());
}

// ── Monthly revenue trend ───────────────────────────────────────────────────

// One bucket per calendar month for the last `months` months (including the
// current month), always zero-filled — same "always fully populated"
// contract as getOrderVolumeTrend above — plus a per-channel revenue split.
// Every known ORDER_CHANNEL value is pre-seeded at 0 on every bucket (not
// just the channels that happened to have an order that month) so a
// multi-line "by channel" chart never has to treat a zero-order month as a
// missing data point and break the line.
//
// Also returns previousPeriodRevenueCents — the same-length window
// immediately before `points` — so the dashboard can show a real "+X% vs
// prior period" figure instead of a fabricated target. Fetched in the same
// query (a 2x-wide window, split after the fact) rather than a second round
// trip.
//
// Built entirely with Date.UTC(...) for the same reason getOrderVolumeTrend
// above is — local-time month/date construction, fed through toISOString(),
// shifts every bucket into the wrong month on a server whose local timezone
// is ahead of UTC.
async function getMonthlyRevenueTrend(tenantId, months = 6) {
  const now = new Date();
  const sinceUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months * 2 - 1), 1));

  const orders = await Order.find({
    tenant_id: tenantId,
    created_at: { $gte: sinceUtc },
    status: { $ne: ORDER_STATUS.CANCELLED },
  })
    .select("created_at total channel")
    .lean();

  const channelKeys = Object.values(ORDER_CHANNEL);
  const byMonth = new Map();
  for (let i = 0; i < months * 2; i++) {
    const bucketDate = new Date(Date.UTC(sinceUtc.getUTCFullYear(), sinceUtc.getUTCMonth() + i, 1));
    const key = bucketDate.toISOString().slice(0, 7); // yyyy-mm
    const byChannel = {};
    for (const channel of channelKeys) byChannel[channel] = 0;
    byMonth.set(key, { month: key, revenueCents: 0, orders: 0, byChannel });
  }

  for (const order of orders) {
    const key = new Date(order.created_at).toISOString().slice(0, 7);
    const bucket = byMonth.get(key);
    if (!bucket) continue; // order.created_at rounding edge case — ignore rather than crash
    bucket.revenueCents += order.total;
    bucket.orders += 1;
    bucket.byChannel[order.channel] = (bucket.byChannel[order.channel] || 0) + order.total;
  }

  // Map insertion order is chronological (built oldest-first above) — the
  // first half is the prior period, the second half is what the chart shows.
  const allBuckets = Array.from(byMonth.values());
  const previousPeriodBuckets = allBuckets.slice(0, months);
  const points = allBuckets.slice(months);
  const previousPeriodRevenueCents = previousPeriodBuckets.reduce((sum, b) => sum + b.revenueCents, 0);

  return { points, previousPeriodRevenueCents };
}

// ── Recent activity — synthesized from Orders + InventoryHistory ───────────
// No dedicated activity/audit log exists in this system; this merges the two
// event sources this app actually has, newest first.

function mapOrderEvent(o) {
  return {
    id: `order_${o._id}`,
    type: "order",
    title: `New order — ${o.customer.name}`,
    description: `${formatOrderNumber(o.order_number_prefix, o.order_number)} via ${o.channel}`,
    timestamp: o.created_at,
    tags: [o.channel, o.status],
  };
}

function mapStockEvent(h) {
  return {
    id: `stock_${h._id}`,
    type: "stock",
    title: h.adjustment >= 0 ? "Inventory Restock" : "Stock Adjustment",
    description: [
      h.product ? h.product.title : "Product",
      h.variant ? `(${h.variant.display_name})` : null,
      `${h.adjustment >= 0 ? "+" : ""}${h.adjustment} units`,
      h.reason || null,
    ]
      .filter(Boolean)
      .join(" "),
    // Structured (not folded into description) so the frontend can render
    // it on its own line — variant SKU takes precedence since it's the one
    // that actually maps to eBay's inventory item.
    sku: h.variant?.sku || h.product?.sku || null,
    timestamp: h.created_at,
    tags: [h.type],
  };
}

// InventoryHistory has no tenant_id of its own (see the file-level comment),
// so tenant scoping goes through an aggregation $lookup on Product instead
// of the plain .find().populate() this used to be — same output shape,
// `product`/`variant` still come back populated (as embedded documents
// rather than Mongoose refs, .lean() already made these plain objects
// either way so mapStockEvent needs no changes).
async function findRecentStockEvents(tenantId, limit) {
  return InventoryHistory.aggregate([
    { $sort: { created_at: -1 } },
    { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "product" } },
    { $unwind: "$product" },
    { $match: { "product.tenant_id": tenantId } },
    { $limit: limit },
    { $lookup: { from: "productvariants", localField: "variant", foreignField: "_id", as: "variant" } },
    { $addFields: { variant: { $arrayElemAt: ["$variant", 0] } } },
  ]);
}

async function getRecentActivity(tenantId, limit = 10) {
  const [recentOrders, recentStockChanges] = await Promise.all([
    Order.find({ tenant_id: tenantId })
      .sort({ created_at: -1 })
      .limit(limit)
      .select("order_number order_number_prefix channel status created_at customer")
      .lean(),
    findRecentStockEvents(tenantId, limit),
  ]);

  const events = [...recentOrders.map(mapOrderEvent), ...recentStockChanges.map(mapStockEvent)];

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return events.slice(0, limit);
}

// ── Activity log — paginated, filterable version of the feed above ─────────
// Merging two differently-shaped collections into one sorted, paginated feed
// means skip/limit can't be pushed to a single query. Instead each source is
// queried for its own top (skip + limit) rows (already filtered/sorted),
// merged, re-sorted, then sliced to the requested page — every page comes
// out exactly right while only ever fetching two bounded slices, never the
// whole table. `total` is a separate, cheap countDocuments per source.
async function listActivity(tenantId, { page = 1, limit = 20, type = "", from, to, search } = {}) {
  const skip = (page - 1) * limit;
  const fetchCount = skip + limit;

  const dateFilter = {};
  if (from) dateFilter.$gte = new Date(from);
  if (to) dateFilter.$lte = new Date(to);
  const hasDateFilter = Object.keys(dateFilter).length > 0;

  const includeOrders = type !== "stock";
  const includeStock = type !== "order";

  const orderFilter = { tenant_id: tenantId };
  if (hasDateFilter) orderFilter.created_at = dateFilter;
  let strippedSearch = search;
  if (search) {
    const tenant = await Tenant.findById(tenantId).select("order_number_prefix invoice_number_prefix").lean();
    strippedSearch = stripOrderNumberPrefix(search, [tenant?.order_number_prefix, tenant?.invoice_number_prefix]);
    // Previously interpolated the raw search string straight into $regex
    // with no escaping — a user-controlled regex-injection/ReDoS surface
    // (e.g. `(a+)+$`-style patterns). buildWordSearchOr always escapes.
    orderFilter.$or = buildWordSearchOr(["order_number", "customer.name", "customer.email"], strippedSearch);
  }

  // $lookup+$match on product.tenant_id BEFORE $sort/$limit — this must be
  // an early stage, not a post-filter, or the fetchCount slice could fill up
  // with another tenant's rows before this tenant's own are ever reached.
  const stockBasePipeline = [];
  if (hasDateFilter) stockBasePipeline.push({ $match: { created_at: dateFilter } });
  stockBasePipeline.push(
    { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "product" } },
    { $unwind: "$product" },
    { $match: { "product.tenant_id": tenantId } },
    { $lookup: { from: "productvariants", localField: "variant", foreignField: "_id", as: "variant" } },
    { $addFields: { variant: { $arrayElemAt: ["$variant", 0] } } },
  );
  if (search) {
    stockBasePipeline.push({
      // product.sku/variant.sku included so a specific SKU (visible in
      // logs/eBay Seller Hub, but not always the product's title) can be
      // searched directly, instead of having to guess a title fragment.
      $match: { $or: buildWordSearchOr(["product.title", "product.sku", "variant.sku", "reason"], search) },
    });
  }

  const [orderDocs, orderTotal, stockDocs, stockTotal] = await Promise.all([
    includeOrders
      ? Order.find(orderFilter)
          .sort({ created_at: -1 })
          .limit(fetchCount)
          .select("order_number order_number_prefix channel status created_at customer")
          .lean()
      : [],
    includeOrders ? Order.countDocuments(orderFilter) : 0,
    includeStock ? InventoryHistory.aggregate([...stockBasePipeline, { $sort: { created_at: -1 } }, { $limit: fetchCount }]) : [],
    includeStock
      ? InventoryHistory.aggregate([...stockBasePipeline, { $count: "total" }]).then((r) => r[0]?.total || 0)
      : 0,
  ]);

  const events = [...orderDocs.map(mapOrderEvent), ...stockDocs.map(mapStockEvent)];
  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const total = orderTotal + stockTotal;
  return {
    items: events.slice(skip, skip + limit),
    total,
    page,
    pageSize: limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

// One zero-filled bucket per calendar day across [from, to] (default: the
// trailing 14 days) — same "always fully populated" contract as
// getOrderVolumeTrend, so the activity log's trend chart never has to guess
// about missing days.
async function getActivityAnalytics(tenantId, { from, to } = {}) {
  const rangeTo = to ? new Date(to) : new Date();
  const rangeFrom = from
    ? new Date(from)
    : (() => {
        const d = new Date(rangeTo);
        d.setDate(d.getDate() - 13);
        return d;
      })();

  const dateFilter = { $gte: rangeFrom, $lte: rangeTo };

  const [orders, stockChanges] = await Promise.all([
    Order.find({ tenant_id: tenantId, created_at: dateFilter }).select("created_at").lean(),
    InventoryHistory.aggregate([
      { $match: { created_at: dateFilter } },
      { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "product" } },
      { $unwind: "$product" },
      { $match: { "product.tenant_id": tenantId } },
      { $project: { created_at: 1 } },
    ]),
  ]);

  const byDate = new Map();
  const cursor = new Date(rangeFrom);
  cursor.setHours(0, 0, 0, 0);
  const endDay = new Date(rangeTo);
  endDay.setHours(0, 0, 0, 0);
  while (cursor <= endDay) {
    const key = cursor.toISOString().slice(0, 10);
    byDate.set(key, { date: key, orders: 0, stock: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const o of orders) {
    const bucket = byDate.get(new Date(o.created_at).toISOString().slice(0, 10));
    if (bucket) bucket.orders += 1;
  }
  for (const h of stockChanges) {
    const bucket = byDate.get(new Date(h.created_at).toISOString().slice(0, 10));
    if (bucket) bucket.stock += 1;
  }

  return {
    totalEvents: orders.length + stockChanges.length,
    orderEvents: orders.length,
    stockEvents: stockChanges.length,
    dailyTrend: Array.from(byDate.values()),
  };
}

// ── Critical stock ───────────────────────────────────────────────────────────

// Rolled up to one row per product+variant (summed across locations) so this
// lines up with getStockCounts()'s definition of "low on stock" — a product
// split across two half-empty shelves shouldn't read as two separate alerts.
async function getCriticalStock(tenantId, limit = 10) {
  const settings = await InventorySettings.getOrCreate(tenantId);

  const rows = await Inventory.aggregate([
    { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "product" } },
    { $unwind: "$product" },
    { $match: { "product.deleted_at": null, "product.tenant_id": tenantId } },
    { $lookup: { from: "productvariants", localField: "variant", foreignField: "_id", as: "variant" } },
    { $addFields: { variant: { $arrayElemAt: ["$variant", 0] } } },
    {
      $group: {
        _id: { product: "$product._id", variant: "$variant._id" },
        stockCount: { $sum: "$stock_count" },
        // Every location record for the same product+variant carries identical
        // product/variant details — $first is just "pick one", not an aggregate.
        product: { $first: "$product" },
        variant: { $first: "$variant" },
        // A stand-in id for the Reorder action — any one of this item's
        // per-location Inventory records works, since adjustStock() only
        // needs *a* record for this product+variant to attribute the credit to.
        sampleInventoryId: { $first: "$_id" },
      },
    },
    { $match: { stockCount: { $lte: settings.low_stock_threshold } } },
    { $sort: { stockCount: 1 } },
    { $limit: limit },
  ]);

  return rows.map((r) => ({
    inventoryId: r.sampleInventoryId,
    productId: r.product._id,
    sku: r.variant?.sku || r.product.sku || "—",
    name: r.variant ? `${r.product.title} — ${r.variant.display_name}` : r.product.title,
    category: r.product.brand || null,
    stockCount: r.stockCount,
  }));
}

module.exports = {
  getStats,
  getChannelHealth,
  getOrderVolumeTrend,
  getMonthlyRevenueTrend,
  getRecentActivity,
  listActivity,
  getActivityAnalytics,
  getCriticalStock,
};
