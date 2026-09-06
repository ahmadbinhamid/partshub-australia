// Generic channel/marketplace shape returned by GET /channels — mirrors
// services/marketplace/channel.service.js#listChannelsForTenant on the
// backend. One entry per registered adapter (eBay, Google Shopping, ...),
// so this stays the shared type for any channel-status UI rather than a
// per-platform duplicate.

// "pending": OAuth consent succeeded and a token is saved, but the tenant
// hasn't picked which Merchant Center account to finish connecting yet —
// see server/docs/channel-architecture.md §9 (TASK 4, connect flow) and
// constants/channel.constants.js's own comment. Currently only ever set by
// the Google adapter's connect flow; eBay never produces it.
export type ChannelConnectionStatus = "connected" | "disconnected" | "degraded" | "error" | "pending";

export interface ChannelConnectionInfo {
  status: ChannelConnectionStatus;
  connected_at: string | null;
  last_error: string | null;
}

export interface ChannelHealthInfo {
  consecutive_failures: number;
  last_success_at: string | null;
}

export interface ChannelCapabilities {
  publish: boolean;
  inventory: boolean;
  batch: boolean;
  orders: boolean;
  webhooks: boolean;
  inboundInventory: boolean;
  variants: boolean;
}

export interface ChannelSummary {
  key: string;
  name: string;
  logo: string | null;
  description: string;
  status: string;
  authType: string;
  setupSteps: string[];
  requiredTenantData: string[];
  // TASK 5 (requiresStorefront capability) — true unless this channel needs
  // something the tenant doesn't have yet (Google Shopping: a verified
  // storefront domain). `unavailable_reason` is a ready-to-show, human-
  // readable string whenever this is false — never null in that case.
  requiresStorefront?: boolean;
  available: boolean;
  unavailable_reason: string | null;
  capabilities: ChannelCapabilities;
  connection: ChannelConnectionInfo;
  health: ChannelHealthInfo;
  listing_counts: Record<string, number>;
}
