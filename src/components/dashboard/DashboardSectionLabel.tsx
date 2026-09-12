import { Badge } from "@/components/ui/Badge";

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

export function DashboardSectionLabel({
  children,
  badge,
  badgeVariant = "default",
}: {
  children: React.ReactNode;
  /** Small pill next to the title — e.g. "Daily Cycle", "6 Months", "3 Urgent". */
  badge?: React.ReactNode;
  badgeVariant?: BadgeVariant;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h3 className="text-sm font-bold tracking-tight text-fg sm:text-base">{children}</h3>
      {badge ? <Badge variant={badgeVariant}>{badge}</Badge> : null}
    </div>
  );
}
