import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Columns3, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/utils/cn";
import type { ColumnDef } from "@/hooks/useColumnVisibility";

interface ManageColumnsProps {
  columns: ColumnDef[];
  visibility: Record<string, boolean>;
  onToggle: (key: string) => void;
}

function MiniToggle({ checked, disabled, onClick }: { checked: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-50",
        checked ? "bg-accent" : "bg-fg/20",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition-transform duration-150",
          checked ? "translate-x-3" : "translate-x-0",
        )}
      />
    </button>
  );
}

// Toolbar action, shown alongside a table's filter bar — lets the user
// show/hide optional columns, persisted per-table via useColumnVisibility.
export function ManageColumns({ columns, visibility, onToggle }: ManageColumnsProps) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <Button variant="secondary" size="sm" className="gap-1.5 whitespace-nowrap">
          <Columns3 className="h-3.5 w-3.5" />
          Manage Columns
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          className={cn(
            "z-50 w-52 overflow-hidden rounded-lg border border-border bg-card shadow-lg",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          )}
        >
          <div className="border-b border-border px-3 py-2.5">
            <span className="text-xs font-semibold text-fg">Manage columns</span>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {columns.map((col) => {
              const checked = visibility[col.key] !== false || !!col.alwaysVisible;
              return (
                <div key={col.key} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-fg/80">{col.label}</span>
                  <MiniToggle
                    checked={checked}
                    disabled={col.alwaysVisible}
                    onClick={() => onToggle(col.key)}
                  />
                </div>
              );
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
