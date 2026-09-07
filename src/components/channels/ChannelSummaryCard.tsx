import { Card } from "@/components/ui/Card";
import { cn } from "@/utils/cn";
import { formatRelativeTime } from "@/utils/formatRelativeTime";
import type { ChannelSummary } from "@/types/channel";

// Same status-dot color convention as ActiveChannelsCard.tsx (dashboard) —
// kept as its own small map here rather than importing that component's
// internal one, since the two live in different feature folders and this
// one keys off health_status ("healthy" | "needs_attention"), not
// ChannelHealth's three-state status.
const STATUS_DOT: Record<ChannelSummary["health_status"], string> = {
  healthy: "bg-ok",
  needs_attention: "bg-danger",
};

export function ChannelSummaryCard({
  channel,
  onClick,
}: {
  channel: ChannelSummary;
  onClick?: () => void;
}) {
  // "synced" is ListingSyncStatus's literal value for "Live" (see
  // src/config/listingStatus.ts's LISTING_SYNC_STATUS_CONFIG) — used as a
  // plain string here since there's no runtime enum object for it on the
  // frontend, matching how ListingsPage.tsx's own SYNC_STATUS_FILTERS does.
  const liveCount = channel.listing_counts["synced"] ?? 0;
  const relativeSync = formatRelativeTime(channel.last_synced_at);
  const isHealthy = channel.health_status === "healthy";

  return (
    <Card
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={cn(
        "p-3",
        onClick && "cursor-pointer transition hover:ring-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[channel.health_status])} aria-hidden="true" />
          <span className="truncate text-xs font-semibold text-fg">{channel.name}</span>
        </div>
        {relativeSync ? <span className="shrink-0 text-[11px] text-fg/45">{relativeSync}</span> : null}
      </div>

      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-1">
          <span className="text-lg font-semibold tracking-tight text-fg tabular-nums">{liveCount}</span>
          <span className="text-[11px] text-fg/55">live</span>
        </span>
        <span className={cn("text-[11px] font-medium", isHealthy ? "text-ok" : "text-danger")}>
          {isHealthy ? "all healthy" : `${channel.needs_attention_count} needs attention`}
        </span>
      </div>
    </Card>
  );
}
