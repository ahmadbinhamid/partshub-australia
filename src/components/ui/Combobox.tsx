import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { cn } from "@/utils/cn";

interface ComboboxProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  /** Allow the user to enter a value that isn't in `options`. */
  allowCustom?: boolean;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  disabled = false,
  className,
  allowCustom = false,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  const trimmedQuery = query.trim();
  const showCustomOption =
    allowCustom &&
    trimmedQuery.length > 0 &&
    !options.some((o) => o.toLowerCase() === trimmedQuery.toLowerCase());

  function handleSelect(opt: string) {
    onChange(opt);
    setOpen(false);
    setQuery("");
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-10 w-full items-center justify-between rounded-xl border border-border bg-card px-3 py-2 text-sm shadow-(--shadow-input)",
            "outline-none! focus-visible:border-accent focus-visible:shadow-(--shadow-input-focus)",
            "disabled:cursor-not-allowed disabled:opacity-50",
            value ? "text-fg" : "text-fg/45",
            className,
          )}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={4}
          align="start"
          className={cn(
            "z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-lg border border-border bg-card shadow-lg",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
          )}
        >
          {/* Search input */}
          <div className="p-2">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 h-9 transition-shadow duration-150 focus-within:border-accent focus-within:shadow-(--shadow-input-focus)">
              <Search className="h-3.5 w-3.5 shrink-0 text-fg/40" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (showCustomOption) {
                    handleSelect(trimmedQuery);
                  } else if (filtered.length > 0) {
                    handleSelect(filtered[0]);
                  }
                }}
                placeholder={searchPlaceholder}
                className="flex-1 bg-transparent text-sm text-fg outline-none! placeholder:text-fg/40"
              />
            </div>
          </div>

          {/* Option list */}
          <div className="max-h-60 overflow-y-auto p-1">
            {showCustomOption && (
              <button
                type="button"
                onClick={() => handleSelect(trimmedQuery)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                  "text-accent hover:bg-accent/10",
                )}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 truncate text-left">Use "{trimmedQuery}"</span>
              </button>
            )}
            {filtered.length === 0 && !showCustomOption ? (
              <div className="py-4 text-center text-xs text-fg/45">No results</div>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => handleSelect(opt)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                    "hover:bg-accent/10 hover:text-fg",
                    opt === value ? "bg-accent/10 font-medium text-fg" : "text-fg/80",
                  )}
                >
                  <span className="flex-1 truncate text-left">{opt}</span>
                  {opt === value && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                </button>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
