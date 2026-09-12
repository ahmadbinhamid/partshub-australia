import { useMemo, useState } from "react";
import { Bar, ComposedChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TooltipContentProps } from "recharts";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { DashboardSectionLabel } from "@/components/dashboard/DashboardSectionLabel";
import { DashboardStatTile } from "@/components/dashboard/DashboardStatTile";
import { cn } from "@/utils/cn";
import { formatCurrencyFromCents } from "@/utils/format";
import type { OrderVolumeMetric, OrderVolumePoint } from "@/types/dashboard";

const METRIC_TABS: { key: OrderVolumeMetric; label: string }[] = [
  { key: "orders", label: "Orders" },
  { key: "revenueCents", label: "Revenue" },
  { key: "items", label: "Items" },
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

  const data = useMemo(() => points.map((p) => ({ ...p, label: formatDateLabel(p.date) })), [points]);

  const totals = useMemo(
    () =>
      points.reduce(
        (acc, p) => ({
          orders: acc.orders + p.orders,
          revenueCents: acc.revenueCents + p.revenueCents,
          items: acc.items + p.items,
        }),
        { orders: 0, revenueCents: 0, items: 0 },
      ),
    [points],
  );

  // Revenue is always the soft background bar (context) — the selected
  // metric is the foreground trend line on top of it. When Revenue itself
  // is selected there's nothing distinct left to overlay, so the bar alone
  // carries the chart rather than drawing a redundant line on top of itself.
  const showTrendLine = metric !== "revenueCents";

  return (
    <Card className="p-4 shadow-card transition-shadow duration-300 hover:shadow-md sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <DashboardSectionLabel badge="Daily Cycle">Order Volume &amp; Fulfillment</DashboardSectionLabel>
          <p className="mt-1 text-xs text-fg/50">Daily orders dispatch and fulfillment velocity</p>
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
            <ComposedChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: "var(--color-fg)", opacity: 0.45 }}
              />
              <YAxis yAxisId="revenue" hide domain={[0, (max: number) => max * 1.15]} />
              <YAxis yAxisId="metric" orientation="right" hide domain={[0, (max: number) => max * 1.35]} />
              <Tooltip cursor={{ fill: "var(--color-border)", opacity: 0.3 }} content={ChartTooltip} />
              <Bar
                yAxisId="revenue"
                dataKey="revenueCents"
                name="Revenue"
                fill="var(--color-accent)"
                fillOpacity={0.16}
                radius={[6, 6, 0, 0]}
                maxBarSize={32}
              />
              {showTrendLine && (
                <Line
                  yAxisId="metric"
                  type="monotone"
                  dataKey={metric}
                  name={metric === "orders" ? "Orders" : "Items"}
                  stroke="var(--color-accent)"
                  strokeWidth={2.5}
                  dot={{ r: 4, fill: "var(--color-accent)", stroke: "var(--color-card)", strokeWidth: 1.5 }}
                  activeDot={{ r: 6 }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3">
        <DashboardStatTile variant="plain" loading={loading} label="Total Orders" value={totals.orders} />
        <DashboardStatTile
          variant="plain"
          loading={loading}
          label="Total Revenue"
          value={<span className="text-ok">{formatCurrencyFromCents(totals.revenueCents)}</span>}
        />
        <DashboardStatTile
          variant="plain"
          loading={loading}
          label="Items Shipped"
          value={<span className="text-accent">{totals.items}</span>}
        />
      </div>
    </Card>
  );
}
