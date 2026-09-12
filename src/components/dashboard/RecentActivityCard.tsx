import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { DashboardSectionLabel } from "@/components/dashboard/DashboardSectionLabel";
import { ActivityEventRow } from "@/components/activity/ActivityEventRow";
import type { ActivityEvent } from "@/types/dashboard";

function eventHref(event: ActivityEvent) {
  return event.type === "order" ? "/orders" : "/inventory";
}

export function RecentActivityCard({ events, loading }: { events: ActivityEvent[]; loading?: boolean }) {
  const navigate = useNavigate();

  return (
    <Card className="flex h-full flex-col p-3 shadow-card transition-shadow duration-300 hover:shadow-md sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-y-1.5 border-b border-border pb-1.5">
        <DashboardSectionLabel badge="Audit Trail">Recent Activity</DashboardSectionLabel>
        <button
          type="button"
          onClick={() => navigate("/activity-log")}
          className="flex shrink-0 items-center gap-1 text-xs font-semibold text-accent transition hover:text-accent/80"
        >
          View all
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <CardContent className="flex-1 space-y-2 px-0 pt-3">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)
        ) : events.length === 0 ? (
          <div className="py-10 text-center text-sm text-fg/45">No recent activity</div>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {events.map((event) => (
              <div
                key={event.id}
                onClick={() => navigate(eventHref(event))}
                className="cursor-pointer rounded-lg border border-transparent bg-muted/40 p-2 shadow-(--shadow-input) transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:bg-muted/70"
              >
                <ActivityEventRow event={event} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
