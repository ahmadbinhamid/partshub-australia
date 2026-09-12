import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TooltipContentProps } from "recharts";
import { Card } from "@/components/ui/Card";
import { DashboardSectionLabel } from "@/components/dashboard/DashboardSectionLabel";
import type { ActivityAnalyticsPoint } from "@/types/dashboard";

const SERIES = [
  { key: "orders", label: "Orders", color: "var(--color-accent)" },
  { key: "stock", label: "Stock Changes", color: "var(--color-warn)" },
] as const;

function formatDateLabel(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("en-AU", { month: "short", day: "numeric" });
}

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as ActivityAnalyticsPoint;

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5 text-xs shadow-lg">
      <div className="mb-1.5 font-semibold text-fg">{formatDateLabel(point.date)}</div>
      {SERIES.map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-4 text-fg/60">
          <span>{s.label}</span>
          <span className="font-medium tabular-nums text-fg">{point[s.key]}</span>
        </div>
      ))}
    </div>
  );
}

export function ActivityTrendChart({ points, loading }: { points: ActivityAnalyticsPoint[]; loading?: boolean }) {
  const data = useMemo(() => points.map((p) => ({ ...p, label: formatDateLabel(p.date) })), [points]);

  return (
    <Card className="p-4 sm:p-5">
      <DashboardSectionLabel>Activity Over Time</DashboardSectionLabel>

      <div className="mt-4 h-64 w-full">
        {loading ? (
          <div className="h-full w-full animate-pulse rounded-md bg-bg-2" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: "var(--color-fg)", opacity: 0.45 }}
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: "var(--color-fg)", opacity: 0.45 }}
                width={32}
              />
              <Tooltip cursor={{ fill: "var(--color-border)", opacity: 0.3 }} content={ChartTooltip} />
              {SERIES.map((s) => (
                <Bar key={s.key} dataKey={s.key} radius={[4, 4, 0, 0]} fill={s.color} maxBarSize={28} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-fg/55">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </div>
    </Card>
  );
}
