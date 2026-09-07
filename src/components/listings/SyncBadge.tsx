import { Badge } from "@/components/ui/Badge";
import type { ListingSyncStatus } from "@/types/marketplace";
import { LISTING_SYNC_STATUS_CONFIG } from "@/config/listingStatus";

interface SyncBadgeProps {
  status: ListingSyncStatus;
  // Optional platform name prefix (e.g. "eBay: Live") — the TASK 6 grouped
  // Listings view uses this so a product's per-channel badges each say
  // which channel they're for; every existing single-platform-context
  // caller omits it and keeps the exact same "Live"/"Pending"/etc. text.
  label?: string;
}

export function SyncBadge({ status, label }: SyncBadgeProps) {
  const cfg = LISTING_SYNC_STATUS_CONFIG[status];
  const text = cfg?.label ?? status;
  return <Badge variant={cfg?.variant ?? "muted"}>{label ? `${label}: ${text}` : text}</Badge>;
}
