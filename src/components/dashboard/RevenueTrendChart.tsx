import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TooltipContentProps } from "recharts";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { DashboardSectionLabel } from "@/components/dashboard/DashboardSectionLabel";
import { DashboardStatTile } from "@/components/dashboard/DashboardStatTile";
import { ORDER_CHANNEL_LABEL } from "@/components/orders/OrderChannelBadge";
import { cn } from "@/utils/cn";
import { formatCurrencyFromCents, formatCompactNumber } from "@/utils/format";
import type { RevenueTrendPoint } from "@/types/dashboard";
import type { OrderChannel } from "@/types/orders";

type ViewMode = "total" | "channels";

const VIEW_TABS: { key: ViewMode; label: string }[] = [
  { key: "total", label: "Total" },
  { key: "channels", label: "Channels" },
];

// Categorical palette (globals.css --cat-1..6) — same tokens
// ProductChannelStatus.tsx uses to identify a channel by dot color. Cycled
// in case a tenant somehow has more channels than the palette has slots.
const CHANNEL_COLOR_VARS = [
  "var(--color-cat-1)",
  "var(--color-cat-2)",
  "var(--color-cat-3)",
  "var(--color-cat-4)",
  "var(--color-cat-5)",
  "var(--color-cat-6)",
];

function channelLabel(key: string) {
  return ORDER_CHANNEL_LABEL[key as OrderChannel] ?? key;
}

function formatMonthLabel(month: string) {
  const d = new Date(`${month}-01T00:00:00`);
  return d.toLocaleDateString("en-AU", { month: "short", year: "2-digit" });
}

function formatMonthShort(month: string) {
  const d = new Date(`${month}-01T00:00:00`);
  return d.toLocaleDateString("en-AU", { month: "short" });
}

function formatMonthLong(month: string) {
  const d = new Date(`${month}-01T00:00:00`);
  return d.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
}

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as RevenueTrendPoint & { label: string };
  const channelKeys = Object.keys(point.byChannel);

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5 text-xs shadow-lg">
      <div className="mb-1.5 font-semibold text-fg">{formatMonthLong(point.month)}</div>
      <div className="flex items-center justify-between gap-4 text-fg/60">
        <span>Gross revenue</span>
        <span className="font-medium tabular-nums text-fg">{formatCurrencyFromCents(point.revenueCents)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 text-fg/60">
        <span>Orders</span>
        <span className="font-medium tabular-nums text-fg">{point.orders}</span>
      </div>
      {channelKeys.length > 0 && (
        <div className="mt-1.5 space-y-1 border-t border-border pt-1.5">
          {channelKeys.map((key, i) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-fg/60">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: CHANNEL_COLOR_VARS[i % CHANNEL_COLOR_VARS.length] }}
                  aria-hidden="true"
                />
                {channelLabel(key)}
              </span>
              <span className="font-medium tabular-nums text-fg">{formatCurrencyFromCents(point.byChannel[key])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RevenueTrendChart({
  points,
  previousPeriodRevenueCents,
  loading,
}: {
  points: RevenueTrendPoint[];
  previousPeriodRevenueCents?: number;
  loading?: boolean;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("total");

  const data = useMemo(() => points.map((p) => ({ ...p, label: formatMonthLabel(p.month) })), [points]);

  const channelKeys = useMemo(() => {
    const totals = new Map<string, number>();
    for (const p of points) {
      for (const [key, cents] of Object.entries(p.byChannel)) {
        totals.set(key, (totals.get(key) || 0) + cents);
      }
    }
    // Every ORDER_CHANNEL is pre-seeded at 0 server-side so lines don't
    // break on a zero-order month — but a channel this tenant has never
    // once used shouldn't clutter the legend/chart with a flat zero line.
    return Array.from(totals.entries())
      .filter(([, cents]) => cents > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => key);
  }, [points]);

  const summary = useMemo(() => {
    const totalRevenueCents = points.reduce((sum, p) => sum + p.revenueCents, 0);
    const monthlyAverageCents = points.length > 0 ? Math.round(totalRevenueCents / points.length) : 0;
    const peak = points.reduce<RevenueTrendPoint | null>(
      (best, p) => (!best || p.revenueCents > best.revenueCents ? p : best),
      null,
    );

    // Which channel contributed the most revenue in the peak month
    // specifically (not across the whole period) — matches "Top performing
    // channel: eBay" sitting under the Peak Month figure.
    let peakChannel: string | null = null;
    if (peak) {
      for (const [key, cents] of Object.entries(peak.byChannel)) {
        if (cents > 0 && (!peakChannel || cents > peak.byChannel[peakChannel])) peakChannel = key;
      }
    }

    // Real period-over-period comparison — vs the same-length window
    // immediately before this one, computed server-side.
    const hasPriorPeriod = typeof previousPeriodRevenueCents === "number" && previousPeriodRevenueCents > 0;
    const periodChangePct = hasPriorPeriod
      ? ((totalRevenueCents - previousPeriodRevenueCents!) / previousPeriodRevenueCents!) * 100
      : null;

    // "Pacing" caption for the average tile — real signal (is the latest
    // month running hot/cold vs the period average), not a static string.
    const latest = points[points.length - 1] ?? null;
    let pacing: "up" | "down" | "steady" = "steady";
    if (latest && monthlyAverageCents > 0) {
      const ratio = latest.revenueCents / monthlyAverageCents;
      if (ratio >= 1.1) pacing = "up";
      else if (ratio <= 0.9) pacing = "down";
    }

    return { totalRevenueCents, monthlyAverageCents, peak, peakChannel, periodChangePct, pacing };
  }, [points, previousPeriodRevenueCents]);

  return (
    <Card className="p-4 shadow-card transition-shadow duration-300 hover:shadow-md sm:p-5">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <DashboardSectionLabel badge={`${points.length || 6} Months`}>
            Revenue Trends &amp; Channel Analytics
          </DashboardSectionLabel>
          <p className="mt-1 text-xs text-fg/50">Channel sales comparison and revenue tracking over time</p>
        </div>
        <div className="inline-flex shrink-0 rounded-md border border-border bg-bg-2/40 p-0.5">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setViewMode(tab.key)}
              className={cn(
                "rounded-sm px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors",
                viewMode === tab.key ? "bg-card text-fg shadow-sm" : "text-fg/50 hover:text-fg",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <DashboardStatTile
          loading={loading}
          label={`${points.length || 6}-Month Revenue`}
          value={formatCurrencyFromCents(summary.totalRevenueCents)}
          caption={
            summary.periodChangePct === null
              ? "No prior period yet"
              : `${summary.periodChangePct >= 0 ? "+" : ""}${summary.periodChangePct.toFixed(1)}% vs prev period`
          }
          captionTone={
            summary.periodChangePct === null ? "neutral" : summary.periodChangePct >= 0 ? "ok" : "danger"
          }
        />
        <DashboardStatTile
          loading={loading}
          label="Monthly Average"
          value={formatCurrencyFromCents(summary.monthlyAverageCents)}
          caption={summary.pacing === "up" ? "Trending up" : summary.pacing === "down" ? "Trending down" : "Consistent pacing"}
          captionTone={summary.pacing === "up" ? "ok" : summary.pacing === "down" ? "danger" : "neutral"}
        />
        <DashboardStatTile
          loading={loading}
          label="Peak Month"
          value={
            summary.peak ? (
              <>
                {formatCurrencyFromCents(summary.peak.revenueCents)}{" "}
                <span className="text-xs font-normal text-fg/50">({formatMonthShort(summary.peak.month)})</span>
              </>
            ) : (
              "—"
            )
          }
          caption={summary.peakChannel ? `Top performing channel: ${channelLabel(summary.peakChannel)}` : "No orders yet"}
          captionTone="accent"
        />
      </div>

      <div className="mt-4 h-64 w-full sm:h-72">
        {loading ? (
          <Skeleton className="h-full w-full" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="revenueTrendGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-accent)" stopOpacity={0.22} />
                  <stop offset="95%" stopColor="var(--color-accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: "var(--color-fg)", opacity: 0.45 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: "var(--color-fg)", opacity: 0.45 }}
                tickFormatter={(v: number) => `$${formatCompactNumber(v / 100)}`}
                width={44}
              />
              <Tooltip content={ChartTooltip} />
              <Legend
                verticalAlign="top"
                align="right"
                iconType="line"
                wrapperStyle={{ paddingBottom: 16, fontSize: 12, fontWeight: 500 }}
              />

              {viewMode === "total" && (
                <Area
                  type="monotone"
                  dataKey="revenueCents"
                  name="Total Gross Revenue ($)"
                  stroke="var(--color-accent)"
                  strokeWidth={2.5}
                  fillOpacity={1}
                  fill="url(#revenueTrendGradient)"
                  activeDot={{ r: 5 }}
                />
              )}

              {viewMode === "channels" &&
                channelKeys.map((key, i) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={`byChannel.${key}`}
                    name={channelLabel(key)}
                    stroke={CHANNEL_COLOR_VARS[i % CHANNEL_COLOR_VARS.length]}
                    strokeWidth={2.5}
                    dot={{ r: 3.5 }}
                    activeDot={{ r: 5 }}
                  />
                ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}
