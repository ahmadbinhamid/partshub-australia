import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { RevenueTrendChart } from "@/components/dashboard/RevenueTrendChart";
import { OrderVolumeChart } from "@/components/dashboard/OrderVolumeChart";
import { ActiveChannelsCard } from "@/components/dashboard/ActiveChannelsCard";
import { RecentActivityCard } from "@/components/dashboard/RecentActivityCard";
import { CriticalStockCard } from "@/components/dashboard/CriticalStockCard";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/ActionsMenu";
import {
  getDashboardStats,
  getActiveChannels,
  getRevenueTrend,
  getOrderVolume,
  getRecentActivity,
  getCriticalStock,
} from "@/lib/api/dashboard";
import { formatCurrency } from "@/utils/format";
import { Boxes, AlertTriangle, Clock, Radio, Calendar } from "lucide-react";

const REVENUE_TREND_MONTHS = 6;
const ORDER_VOLUME_RANGE_OPTIONS = [7, 14, 30, 90] as const;
// Recent Activity polls rather than push — good enough at this scale, and
// honest about not actually being a websocket-driven live feed.
const ACTIVITY_REFETCH_MS = 30_000;

// The real [today - (days-1), today] window the order-volume chart is
// actually querying — shown so the date-range control reads as a real
// applied filter ("1 Jul – 31 Jul 2025"), not a static decoration.
function formatDateRangeLabel(days: number) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  const startLabel = start.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  const endLabel = end.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  return `${startLabel} – ${endLabel}`;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [orderVolumeDays, setOrderVolumeDays] = useState<(typeof ORDER_VOLUME_RANGE_OPTIONS)[number]>(7);

  const { data: statsRes, isLoading: statsLoading } = useQuery({
    queryKey: ["dashboard", "stats"],
    queryFn: getDashboardStats,
  });

  const { data: channelsRes, isLoading: channelsLoading } = useQuery({
    queryKey: ["dashboard", "channels"],
    queryFn: getActiveChannels,
  });

  const { data: revenueTrendRes, isLoading: revenueTrendLoading } = useQuery({
    queryKey: ["dashboard", "revenue-trend", REVENUE_TREND_MONTHS],
    queryFn: () => getRevenueTrend(REVENUE_TREND_MONTHS),
  });

  const { data: volumeRes, isLoading: volumeLoading } = useQuery({
    queryKey: ["dashboard", "order-volume", orderVolumeDays],
    queryFn: () => getOrderVolume(orderVolumeDays),
  });

  const { data: activityRes, isLoading: activityLoading } = useQuery({
    queryKey: ["dashboard", "activity"],
    queryFn: () => getRecentActivity(10),
    refetchInterval: ACTIVITY_REFETCH_MS,
  });

  const { data: criticalStockRes, isLoading: criticalStockLoading } = useQuery({
    queryKey: ["dashboard", "critical-stock"],
    queryFn: () => getCriticalStock(10),
  });

  const stats = statsRes?.data;
  const channels = channelsRes?.data ?? [];
  const revenueTrendPoints = revenueTrendRes?.data?.points ?? [];
  const previousPeriodRevenueCents = revenueTrendRes?.data?.previousPeriodRevenueCents;
  const volumePoints = volumeRes?.data ?? [];
  const activityEvents = activityRes?.data ?? [];
  const criticalStock = criticalStockRes?.data ?? [];

  const syncHealthy = stats ? stats.syncStabilityPct >= 90 : true;

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Dashboard
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ok/10 px-2 py-0.5 text-[11px] font-semibold text-ok">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" aria-hidden="true" />
              Live Sync
            </span>
          </span>
        }
        description="Store performance overview, sales volume & real-time inventory telemetry"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3.5 py-2 text-xs font-semibold text-fg shadow-(--shadow-input) transition hover:bg-muted/50"
            >
              <Calendar className="h-3.5 w-3.5 text-fg/45" />
              {formatDateRangeLabel(orderVolumeDays)}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ORDER_VOLUME_RANGE_OPTIONS.map((days) => (
              <DropdownMenuItem
                key={days}
                onSelect={() => setOrderVolumeDays(days)}
                className={days === orderVolumeDays ? "font-semibold text-accent" : undefined}
              >
                Last {days} days
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Total Inventory Value"
          value={stats ? formatCurrency(stats.totalInventoryValue) : "—"}
          badge={
            stats && stats.inventoryValueChangePct !== null
              ? `${stats.inventoryValueChangePct >= 0 ? "+" : ""}${stats.inventoryValueChangePct.toFixed(1)}%`
              : undefined
          }
          subLabel="Across all locations"
          icon={<Boxes className="h-4 w-4" />}
          tone={stats && stats.inventoryValueChangePct !== null && stats.inventoryValueChangePct < 0 ? "danger" : "accent"}
          loading={statsLoading}
          onClick={() => navigate("/inventory")}
        />
        <MetricCard
          label="Low Stock Items"
          value={stats?.lowStockCount ?? 0}
          badge={stats && stats.outOfStockCount > 0 ? `${stats.outOfStockCount} critical` : "Stable"}
          subLabel={
            stats && stats.outOfStockCount > 0 ? "Restock required urgently" : "All stock levels healthy"
          }
          icon={<AlertTriangle className="h-4 w-4" />}
          tone={stats && stats.outOfStockCount > 0 ? "danger" : "ok"}
          loading={statsLoading}
          onClick={() =>
            navigate(`/products?stock=${stats && stats.outOfStockCount > 0 ? "out_of_stock" : "low_stock"}`)
          }
        />
        <MetricCard
          label="Pending Orders"
          value={stats?.pendingOrdersCount ?? 0}
          badge={
            stats && stats.pendingOrdersCount > 0
              ? `Avg ${stats.pendingOrdersAvgAgeHours.toFixed(1)}h`
              : "Settled"
          }
          subLabel={stats && stats.pendingOrdersCount > 0 ? "Ready for warehouse pack" : "All orders settled"}
          icon={<Clock className="h-4 w-4" />}
          tone={stats && stats.pendingOrdersCount > 0 ? "warn" : "ok"}
          loading={statsLoading}
          onClick={() => navigate("/orders?fulfillment_status=pending")}
        />
        <MetricCard
          label="Sync Stability"
          value={stats ? `${stats.syncStabilityPct}%` : "—"}
          badge={stats ? (syncHealthy ? "Healthy" : "Attention") : undefined}
          subLabel={stats ? `${stats.channelsOperational}/${stats.channelsTotal} channels operational` : undefined}
          icon={<Radio className="h-4 w-4" />}
          tone={syncHealthy ? "ok" : "danger"}
          loading={statsLoading}
          onClick={() => navigate("/listings")}
        />
      </div>

      <RevenueTrendChart
        points={revenueTrendPoints}
        previousPeriodRevenueCents={previousPeriodRevenueCents}
        loading={revenueTrendLoading}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <OrderVolumeChart points={volumePoints} loading={volumeLoading} />
        </div>
        <ActiveChannelsCard channels={channels} loading={channelsLoading} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <RecentActivityCard events={activityEvents} loading={activityLoading} />
        <CriticalStockCard items={criticalStock} loading={criticalStockLoading} />
      </div>
    </div>
  );
}
