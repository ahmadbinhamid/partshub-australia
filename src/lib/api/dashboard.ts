import { apiClient } from "./client";
import type { BeResponse } from "./base";
import type {
  DashboardStats,
  OrderVolumePoint,
  RevenueTrendResponse,
  ChannelHealth,
  ActivityEvent,
  ActivityLogPage,
  ActivityAnalytics,
  CriticalStockItem,
} from "@/types/dashboard";

export const getDashboardStats = async () => {
  const { data } = await apiClient.get<BeResponse<DashboardStats>>("/dashboard/stats");
  return data;
};

export const getActiveChannels = async () => {
  const { data } = await apiClient.get<BeResponse<ChannelHealth[]>>("/dashboard/channels");
  return data;
};

export const getOrderVolume = async (days = 7) => {
  const { data } = await apiClient.get<BeResponse<OrderVolumePoint[]>>("/dashboard/order-volume", {
    params: { days },
  });
  return data;
};

export const getRevenueTrend = async (months = 6) => {
  const { data } = await apiClient.get<BeResponse<RevenueTrendResponse>>("/dashboard/revenue-trend", {
    params: { months },
  });
  return data;
};

export const getRecentActivity = async (limit = 10) => {
  const { data } = await apiClient.get<BeResponse<ActivityEvent[]>>("/dashboard/activity", {
    params: { limit },
  });
  return data;
};

export const getCriticalStock = async (limit = 10) => {
  const { data } = await apiClient.get<BeResponse<CriticalStockItem[]>>("/dashboard/critical-stock", {
    params: { limit },
  });
  return data;
};

export interface ListActivityLogParams {
  page?: number;
  limit?: number;
  type?: "" | "order" | "stock";
  from?: string;
  to?: string;
  search?: string;
}

export const listActivityLog = async (params: ListActivityLogParams = {}) => {
  const { data } = await apiClient.get<BeResponse<ActivityLogPage>>("/dashboard/activity-log", { params });
  return data;
};

export const getActivityAnalytics = async (params: { from?: string; to?: string } = {}) => {
  const { data } = await apiClient.get<BeResponse<ActivityAnalytics>>("/dashboard/activity-log/analytics", {
    params,
  });
  return data;
};
