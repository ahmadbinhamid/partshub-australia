import type { ComponentType, ReactNode } from "react";

// Generic icon + label + value tile — e.g. the Order Total / Payment / Items
// row on the order detail page. Reusable anywhere a small metric needs a
// consistent card treatment.
export function StatCard({
  icon: Icon,
  label,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium uppercase tracking-wider text-fg/45">{label}</div>
        <div className="mt-0.5 text-base font-semibold text-fg">{children}</div>
      </div>
    </div>
  );
}
