import { ArrowUpRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/utils/cn";

export type MetricCardTone = "accent" | "danger" | "warn" | "ok";

// Tailwind can't resolve a template-literal class like `bg-${tone}/10` at
// build time — it only ever picks up classes it can see written out in full
// in source, so each tone's full class string has to be spelled out here
// rather than interpolated.
//
// `bar` is a two-stop gradient, same idea as the reference's per-card
// gradient top edge (indigo→blue, rose→amber, etc). Where the reference
// shifts hue entirely, ours only does that for `danger`, because
// danger→warn (red→amber) are two real, distinct semantic tokens — the
// other three fade the same token toward transparent instead of inventing
// a second arbitrary color.
const TONE_STYLES: Record<
  MetricCardTone,
  { icon: string; iconHover: string; bar: string; ring: string; caption: string }
> = {
  accent: {
    icon: "bg-accent/10 text-accent",
    iconHover: "group-hover:bg-accent group-hover:text-accent-fg",
    bar: "bg-gradient-to-r from-accent to-accent/40",
    ring: "hover:ring-accent/50",
    caption: "group-hover:text-accent",
  },
  danger: {
    icon: "bg-danger/10 text-danger",
    iconHover: "group-hover:bg-danger group-hover:text-danger-fg",
    bar: "bg-gradient-to-r from-danger to-warn",
    ring: "hover:ring-danger/50",
    caption: "group-hover:text-danger",
  },
  warn: {
    icon: "bg-warn/10 text-warn",
    iconHover: "group-hover:bg-warn group-hover:text-warn-fg",
    bar: "bg-gradient-to-r from-warn to-warn/40",
    ring: "hover:ring-warn/50",
    caption: "group-hover:text-warn",
  },
  ok: {
    icon: "bg-ok/10 text-ok",
    iconHover: "group-hover:bg-ok group-hover:text-ok-fg",
    bar: "bg-gradient-to-r from-ok to-ok/40",
    ring: "hover:ring-ok/50",
    caption: "group-hover:text-ok",
  },
};

const BADGE_TONE: Record<MetricCardTone, string> = {
  accent: "bg-accent/10 text-accent",
  danger: "bg-danger/10 text-danger",
  warn: "bg-warn/10 text-warn",
  ok: "bg-ok/10 text-ok",
};

export function MetricCard({
  label,
  value,
  badge,
  subLabel,
  icon,
  tone = "accent",
  loading,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  /** Small colored pill next to the value — e.g. a trend or a status word. */
  badge?: React.ReactNode;
  subLabel?: React.ReactNode;
  icon: React.ReactNode;
  tone?: MetricCardTone;
  loading?: boolean;
  onClick?: () => void;
}) {
  const toneStyles = TONE_STYLES[tone];

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
        "group relative flex min-w-0 flex-col overflow-hidden p-4 transition-all duration-300 sm:p-5",
        onClick &&
          cn(
            "cursor-pointer hover:-translate-y-1 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            toneStyles.ring,
          ),
      )}
    >
      <span
        className={cn(
          "absolute inset-x-0 top-0 h-1 opacity-0 transition-opacity duration-300 group-hover:opacity-100",
          toneStyles.bar,
        )}
        aria-hidden="true"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg/55 transition-colors group-hover:text-fg/70">{label}</span>
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all duration-300",
            toneStyles.icon,
            toneStyles.iconHover,
          )}
        >
          {icon}
        </span>
      </div>

      {loading ? (
        <Skeleton className="mt-3 h-7 w-20" />
      ) : (
        // flex-wrap + min-w-0 on the value — a long currency value next to a
        // badge can exceed the card's width at some viewport sizes; without
        // these the badge got hard-clipped by the card's overflow-hidden
        // instead of wrapping to its own line. Found live: an extreme
        // percentage badge ("+2094...") got cut off mid-character.
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-2xl font-bold tracking-tight text-fg tabular-nums sm:text-3xl">
            {value}
          </span>
          {badge ? (
            <span
              className={cn(
                "shrink-0 whitespace-nowrap rounded-lg px-2 py-0.5 text-xs font-semibold",
                BADGE_TONE[tone],
              )}
            >
              {badge}
            </span>
          ) : null}
        </div>
      )}

      {loading ? (
        <Skeleton className="mt-3 h-3 w-28" />
      ) : subLabel ? (
        <div
          className={cn(
            "mt-3 flex items-center justify-between gap-2 border-t border-border pt-2.5 text-xs text-fg/50 transition-colors duration-300",
            toneStyles.caption,
          )}
        >
          <span className="truncate">{subLabel}</span>
          {onClick ? (
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 -translate-y-0.5 translate-x-0 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:translate-x-0.5 group-hover:opacity-100" />
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
