import { apiClient } from "./client";
import type { BeResponse } from "./base";
import type { ChannelSummary } from "@/types/channel";

// GET /api/v1/channels — every registered marketplace adapter's manifest +
// this tenant's connection/health for it (see
// services/marketplace/channel.service.js#listChannelsForTenant). Generic
// across platforms, so any channel-status UI (a per-platform connect card,
// a dashboard summary) can share this one call instead of each platform
// needing its own /status endpoint.
export const getChannels = async () => {
  const { data } = await apiClient.get<BeResponse<ChannelSummary[]>>("/channels");
  return data;
};
