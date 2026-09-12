import { LayoutGrid, List } from "lucide-react";
import { cn } from "@/utils/cn";

export type ViewMode = "list" | "grid";

const OPTIONS: { value: ViewMode; label: string; icon: typeof List }[] = [
  { value: "list", label: "List view", icon: List },
  { value: "grid", label: "Grid view", icon: LayoutGrid },
];

export function ViewToggle({
  value,
  onChange,
  className,
}: {
  value: ViewMode;
  onChange: (value: ViewMode) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Layout"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg bg-bg-2 p-0.5 ring-1 ring-inset ring-border",
        className,
      )}
    >
      {OPTIONS.map(({ value: option, label, icon: Icon }) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            title={label}
            onClick={() => onChange(option)}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
              active ? "bg-card text-fg shadow-card ring-1 ring-inset ring-border" : "text-fg/45 hover:text-fg/70",
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
