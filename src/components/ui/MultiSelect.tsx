import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/utils/cn";

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  disabled?: boolean;
  maxHeight?: string;
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  className,
  disabled,
  maxHeight = "220px",
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const filtered = React.useMemo(
    () =>
      search.trim()
        ? options.filter((o) =>
            o.label.toLowerCase().includes(search.toLowerCase()),
          )
        : options,
    [options, search],
  );

  const toggle = (val: string) => {
    onChange(
      value.includes(val) ? value.filter((v) => v !== val) : [...value, val],
    );
  };

  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-10 w-full items-center justify-between rounded-xl border border-border bg-card px-3 py-2 text-sm shadow-(--shadow-input)",
            "outline-none! focus-visible:border-accent focus-visible:shadow-(--shadow-input-focus)",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "transition-shadow duration-150",
            className,
          )}
        >
          <span
            className={cn(
              "truncate",
              value.length === 0 ? "text-fg/45" : "text-fg",
            )}
          >
            {value.length === 0
              ? placeholder
              : value.length === 1
                ? options.find((o) => o.value === value[0])?.label ?? placeholder
                : `${value.length} selected`}
          </span>
          <div className="flex shrink-0 items-center gap-1 pl-2">
            {value.length > 0 && (
              <span
                role="button"
                tabIndex={-1}
                onClick={clearAll}
                className="flex h-4 w-4 items-center justify-center rounded-full text-fg/40 transition hover:text-fg"
              >
                <X className="h-3 w-3" />
              </span>
            )}
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 opacity-50 transition-transform",
                open && "rotate-180",
              )}
            />
          </div>
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-(--radix-popover-trigger-width) overflow-hidden rounded-lg border border-border bg-card shadow-lg",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          )}
        >
          {/* Search */}
          {options.length > 5 && (
            <div className="p-2">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 h-9 transition-shadow duration-150 focus-within:border-accent focus-within:shadow-(--shadow-input-focus)">
                <Search className="h-3.5 w-3.5 shrink-0 text-fg/40" />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="flex-1 bg-transparent text-sm outline-none! placeholder:text-fg/40"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="text-fg/40 transition hover:text-fg"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Options list */}
          <div
            className={cn("overflow-y-auto p-1", options.length > 5 && "pt-0")}
            style={{ maxHeight }}
          >
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-fg/40">
                No options
              </p>
            ) : (
              filtered.map((opt) => {
                const selected = value.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggle(opt.value)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none transition-colors",
                      selected ? "bg-accent/10" : "hover:bg-muted/70",
                      selected ? "text-fg" : "text-fg/75",
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-[1.5px] transition-colors",
                        selected ? "border-accent bg-accent text-accent-fg" : "border-border bg-card",
                      )}
                    >
                      {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                    </div>
                    <span className="truncate">{opt.label}</span>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer */}
          {value.length > 0 && (
            <div className="border-t border-border px-3 py-2">
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-xs text-fg/50 transition hover:text-fg"
              >
                Clear all ({value.length})
              </button>
            </div>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
