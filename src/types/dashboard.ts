export interface DashboardStats {
  totalInventoryValue: number; // dollars
  // % change in inventory value over the last 7 days, derived from real
  // stock adjustments — null when there's no baseline to compare against.
  inventoryValueChangePct: number | null;
  lowStockCount: number;
  outOfStockCount: number;
  pendingOrdersCount: number;
  pendingOrdersAvgAgeHours: number;
  syncStabilityPct: number;
  channelsOperational: number;
  channelsTotal: number;
}

export interface OrderVolumePoint {
  date: string; // yyyy-mm-dd
  orders: number;
  revenueCents: number;
  items: number;
}

export type OrderVolumeMetric = "orders" | "revenueCents" | "items";

export interface RevenueTrendPoint {
  month: string; // yyyy-mm
  revenueCents: number;
  orders: number;
  // Keyed by whatever ORDER_CHANNEL values actually appear in this tenant's
  // orders (e.g. "storefront", "ebay", "manual") — not a fixed list, since
  // not every tenant uses every channel.
  byChannel: Record<string, number>;
}

export interface RevenueTrendResponse {
  points: RevenueTrendPoint[];
  // Total revenue for the same-length window immediately before `points` —
  // a real, computed baseline (not a fabricated target) for a "vs prior
  // period" comparison.
  previousPeriodRevenueCents: number;
}

// Only channels this app actually integrates with are ever returned —
// "not_connected" exists for a real channel with zero activity yet, never a
// platform (Amazon/Walmart/Shopify) that isn't built.
export type ChannelStatus = "operational" | "attention" | "not_connected";

export interface ChannelHealth {
  key: string;
  name: string;
  status: ChannelStatus;
  lastSyncedAt: string | null;
  detail?: string;
  listingsSynced?: number;
  listingsTotal?: number;
}

export type ActivityEventType = "order" | "stock";

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  title: string;
  description: string;
  // Only ever set on "stock" events — the product/variant SKU the
  // adjustment applies to, rendered on its own line under the description.
  sku?: string | null;
  timestamp: string;
  tags: string[];
}

export interface CriticalStockItem {
  inventoryId: string;
  productId: string;
  sku: string;
  name: string;
  category: string | null;
  stockCount: number;
}

export interface ActivityLogPage {
  items: ActivityEvent[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ActivityAnalyticsPoint {
  date: string; // yyyy-mm-dd
  orders: number;
  stock: number;
}

export interface ActivityAnalytics {
  totalEvents: number;
  orderEvents: number;
  stockEvents: number;
  dailyTrend: ActivityAnalyticsPoint[];
}
