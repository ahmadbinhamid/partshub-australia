export interface NotificationData {
  order_id: string;
  order_number: string;
  channel: string;
  total: number;
  customer_name: string | null;
}

export interface AppNotification {
  _id: string;
  tenant_id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  data: NotificationData;
  read_at: string | null;
  created_at: string;
}
