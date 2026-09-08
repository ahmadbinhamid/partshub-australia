import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { DashboardSectionLabel } from "@/components/dashboard/DashboardSectionLabel";
import { ActivityEventRow } from "@/components/activity/ActivityEventRow";
import type { ActivityEvent } from "@/types/dashboard";

export function RecentActivityCard({ events, loading }: { events: ActivityEvent[]; loading?: boolean }) {
  const navigate = useNavigate();

  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <DashboardSectionLabel>Recent Activity</DashboardSectionLabel>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg/35">Live Feed</span>
      </div>

      <CardContent className="flex-1 space-y-1 px-0 pt-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)
        ) : events.length === 0 ? (
          <div className="py-10 text-center text-sm text-fg/45">No recent activity</div>
        ) : (
          <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
            {events.map((event) => (
              <div key={event.id} className="border-b border-border/60 pb-3 last:border-0 last:pb-0">
                <ActivityEventRow event={event} />
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <button
        type="button"
        onClick={() => navigate("/activity-log")}
        className="mt-3 text-center text-xs font-medium text-accent transition hover:underline"
      >
        View Full Activity Log
      </button>
    </Card>
  );
}
