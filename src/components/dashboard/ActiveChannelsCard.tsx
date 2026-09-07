import { useNavigate } from "react-router-dom";
import { Activity } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { DashboardSectionLabel } from "@/components/dashboard/DashboardSectionLabel";
import { cn } from "@/utils/cn";
import { formatRelativeTime } from "@/utils/formatRelativeTime";
import type { ChannelHealth } from "@/types/dashboard";

const STATUS_DOT: Record<ChannelHealth["status"], string> = {
  operational: "bg-ok",
  attention: "bg-danger",
  not_connected: "bg-fg/30",
};

const STATUS_BORDER: Record<ChannelHealth["status"], string> = {
  operational: "border-border",
  attention: "border-danger/50",
  not_connected: "border-border",
};

function channelDetail(channel: ChannelHealth) {
  if (channel.detail) return channel.detail;
  if (channel.status === "not_connected") return "No listings yet";
  const relative = formatRelativeTime(channel.lastSyncedAt);
  return relative ? `Synced ${relative}` : "Not yet synced";
}

export function ActiveChannelsCard({ channels, loading }: { channels: ChannelHealth[]; loading?: boolean }) {
  const navigate = useNavigate();

  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <DashboardSectionLabel>Active Channels</DashboardSectionLabel>

      <CardContent className="flex-1 space-y-2 px-0 pt-4">
        {loading ? (
          Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-md bg-bg-2" />
          ))
        ) : (
          channels.map((channel) => (
            <div
              key={channel.key}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md border bg-bg-2/30 px-2.5 py-2.5",
                STATUS_BORDER[channel.status],
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xs bg-bg-2 text-fg/60">
                  <Activity className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-fg">{channel.name}</div>
                  <div className="truncate text-xs text-fg/50">{channelDetail(channel)}</div>
                </div>
              </div>
              <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", STATUS_DOT[channel.status])} aria-hidden="true" />
            </div>
          ))
        )}
      </CardContent>

      <Button variant="secondary" size="sm" className="mt-2 w-full" onClick={() => navigate("/catalogue?tab=listings")}>
        Manage Channels
      </Button>
    </Card>
  );
}
