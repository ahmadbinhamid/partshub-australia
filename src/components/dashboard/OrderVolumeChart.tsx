import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TooltipContentProps } from "recharts";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { DashboardSectionLabel } from "@/components/dashboard/DashboardSectionLabel";
import { cn } from "@/utils/cn";
import { formatCurrencyFromCents } from "@/utils/format";
import type { OrderVolumeMetric, OrderVolumePoint } from "@/types/dashboard";

// Fixed, never-cycled colors — one per metric, reused consistently between
// the tab bar, the bars themselves, and the caption row below the chart.
const METRIC_TABS: { key: OrderVolumeMetric; label: string; legendLabel: string; color: string }[] = [
  { key: "orders", label: "Orders", legendLabel: "Orders Count", color: "var(--color-accent)" },
  { key: "revenueCents", label: "Revenue", legendLabel: "Revenue Generation", color: "var(--color-ok)" },
  { key: "items", label: "Items", legendLabel: "Items Shipped", color: "var(--color-warn)" },
];

function formatDateLabel(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("en-AU", { month: "short", day: "numeric" });
}

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as OrderVolumePoint;

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5 text-xs shadow-lg">
      <div className="mb-1.5 font-semibold text-fg">{formatDateLabel(point.date)}</div>
      <div className="flex items-center justify-between gap-4 text-fg/60">
        <span>Orders</span>
        <span className="font-medium tabular-nums text-fg">{point.orders}</span>
      </div>
      <div className="flex items-center justify-between gap-4 text-fg/60">
        <span>Revenue</span>
        <span className="font-medium tabular-nums text-fg">{formatCurrencyFromCents(point.revenueCents)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 text-fg/60">
        <span>Items</span>
        <span className="font-medium tabular-nums text-fg">{point.items}</span>
      </div>
    </div>
  );
}

export function OrderVolumeChart({ points, loading }: { points: OrderVolumePoint[]; loading?: boolean }) {
  const [metric, setMetric] = useState<OrderVolumeMetric>("orders");
  const activeTab = METRIC_TABS.find((t) => t.key === metric)!;

  const data = useMemo(() => points.map((p) => ({ ...p, label: formatDateLabel(p.date) })), [points]);

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <DashboardSectionLabel>Order Volume (Last {points.length || 7} Days)</DashboardSectionLabel>
          <p className="mt-1 text-xs text-fg/50">Daily order volume, item, and revenue tracking</p>
        </div>
        <div className="inline-flex shrink-0 rounded-md border border-border bg-bg-2/40 p-0.5">
          {METRIC_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setMetric(tab.key)}
              className={cn(
                "rounded-sm px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors",
                metric === tab.key ? "bg-card text-fg shadow-sm" : "text-fg/50 hover:text-fg",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 h-64 w-full">
        {loading ? (
          <Skeleton className="h-full w-full" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
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
                width={36}
              />
              <Tooltip cursor={{ fill: "var(--color-border)", opacity: 0.3 }} content={ChartTooltip} />
              <Bar dataKey={metric} radius={[4, 4, 0, 0]} fill={activeTab.color} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-fg/55">
        {METRIC_TABS.map((tab) => (
          <span key={tab.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tab.color }} aria-hidden="true" />
            {tab.legendLabel}
          </span>
        ))}
      </div>
    </Card>
  );
}
