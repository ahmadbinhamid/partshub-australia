import { apiClient } from "./client";
import type { BeResponse, PaginatedData } from "./base";
import type { AppNotification } from "@/types/notification";

export interface NotificationListParams {
  page?: number;
  limit?: number;
}

export const getNotifications = async (params: NotificationListParams = {}) => {
  const { data } = await apiClient.get<BeResponse<PaginatedData<AppNotification> & { unread_count: number }>>(
    "/notification",
    { params },
  );
  return data;
};

export const markNotificationRead = async (id: string) => {
  const { data } = await apiClient.patch<BeResponse<null>>(`/notification/${id}/read`);
  return data;
};

export const markAllNotificationsRead = async () => {
  const { data } = await apiClient.patch<BeResponse<null>>("/notification/read-all");
  return data;
};
