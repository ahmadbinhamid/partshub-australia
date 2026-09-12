import { ShoppingCart, Boxes, RefreshCw, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/utils/cn";
import type { ActivityEvent } from "@/types/dashboard";

// A "stock" event's first tag is the real ADJUSTMENT_TYPE value the backend
// recorded it under (mapStockEvent in dashboard.service.js) — used here
// instead of sniffing the event's title text, which is free-form copy, not
// a stable signal to branch icon/color on.
const RESTOCK_ADJUSTMENT_TAGS = new Set(["restock", "transfer_in"]);
const LOSS_ADJUSTMENT_TAGS = new Set(["damaged", "lost", "stolen"]);

function eventVisual(event: ActivityEvent): { icon: typeof ShoppingCart; style: string } {
  if (event.type === "order") return { icon: ShoppingCart, style: "bg-ok/10 text-ok" };
  const adjustmentTag = event.tags[0];
  if (adjustmentTag && RESTOCK_ADJUSTMENT_TAGS.has(adjustmentTag)) return { icon: RefreshCw, style: "bg-ok/10 text-ok" };
  if (adjustmentTag && LOSS_ADJUSTMENT_TAGS.has(adjustmentTag)) return { icon: AlertTriangle, style: "bg-danger/10 text-danger" };
  return { icon: Boxes, style: "bg-warn/10 text-warn" };
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}, ${formatTime(iso)}`;
}

// Icon + title/description/tags block shared by the dashboard's compact
// Recent Activity feed and the full Activity Log page — only the timestamp
// format and the surrounding spacing/divider differ between the two.
export function ActivityEventRow({ event, showDate }: { event: ActivityEvent; showDate?: boolean }) {
  const { icon: Icon, style } = eventVisual(event);
  return (
    <div className="flex gap-3">
      <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", style)}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="truncate text-xs font-semibold text-fg">{event.title}</span>
          <span className="shrink-0 rounded-md border border-border bg-card px-2 py-0.5 text-[10px] font-medium tabular-nums text-fg/45">
            {showDate ? formatDateTime(event.timestamp) : formatTime(event.timestamp)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-fg/55">{event.description}</p>
        {event.sku && <p className="mt-0.5 truncate text-xs text-fg/40">(SKU: {event.sku})</p>}
        {event.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {event.tags.map((tag) => (
              <Badge key={tag} variant="muted" className="px-1.5 py-0.5 text-[10px] capitalize">
                {tag.replace(/_/g, " ")}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
