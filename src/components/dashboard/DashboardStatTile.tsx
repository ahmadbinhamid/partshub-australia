import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/utils/cn";

export type StatTileTone = "neutral" | "ok" | "danger" | "accent";

const CAPTION_TONE: Record<StatTileTone, string> = {
  neutral: "text-fg/45",
  ok: "text-ok",
  danger: "text-danger",
  accent: "text-accent",
};

// Small "label / value / caption" tile used inside the dashboard's chart
// cards — RevenueTrendChart's 4-up summary row (boxed) and OrderVolumeChart's
// footer totals (plain, no box — that footer sits directly under a divider
// instead of inside its own card-like tile) — pulled out so both stop
// hand-rolling the same label/value/caption markup.
export function DashboardStatTile({
  label,
  value,
  caption,
  captionTone = "neutral",
  variant = "boxed",
  loading,
  className,
}: {
  label: string;
  value: React.ReactNode;
  caption?: React.ReactNode;
  captionTone?: StatTileTone;
  variant?: "boxed" | "plain";
  loading?: boolean;
  className?: string;
}) {
  const box = variant === "boxed" && "rounded-xl border border-border bg-muted/50 p-3.5 hover:bg-muted/70";

  // min-w-0 — every consumer places this in a CSS grid row (grid items
  // default to min-width: auto, i.e. "never narrower than my content"), so
  // without it a long value/caption widened the grid track instead of the
  // `truncate` below ever getting a chance to ellipsize.
  if (loading) {
    return (
      <div className={cn("min-w-0 transition-colors duration-200", box, className)}>
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-2 h-5 w-16" />
        <Skeleton className="mt-1.5 h-2.5 w-24" />
      </div>
    );
  }

  return (
    <div className={cn("min-w-0 transition-colors duration-200", box, className)}>
      <p className="truncate text-[11px] font-medium text-fg/50">{label}</p>
      <p className="mt-0.5 truncate text-lg font-bold tracking-tight text-fg tabular-nums">{value}</p>
      {caption ? (
        <p className={cn("mt-0.5 truncate text-[10px] font-medium", CAPTION_TONE[captionTone])}>{caption}</p>
      ) : null}
    </div>
  );
}
