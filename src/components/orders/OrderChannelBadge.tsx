import { Badge } from "@/components/ui/Badge";
import type { OrderChannel } from "@/types/orders";

export const ORDER_CHANNEL_LABEL: Record<OrderChannel, string> = {
  storefront: "Storefront",
  ebay: "eBay",
  manual: "In-Store",
};

export function OrderChannelBadge({ channel }: { channel: OrderChannel }) {
  return <Badge variant="outline">{ORDER_CHANNEL_LABEL[channel]}</Badge>;
}
