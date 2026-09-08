import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { UserMenu } from "@/components/shell/UserMenu";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { NotificationBell } from "@/components/shell/NotificationBell";
import { cn } from "@/utils/cn";
import { useCart } from "@/context/cart";
import { usePathname } from "@/hooks";
import { Menu, Search, Settings, ShoppingCart } from "lucide-react";

export function Topbar({ onOpenMobile }: { onOpenMobile: () => void }) {
  const navigate = useNavigate();
  const pathname = usePathname();
  const { totalItems } = useCart();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <header className="sticky top-0 z-20 h-14 border-b border-border bg-card">
        <div
          className={cn(
            "flex h-full items-center gap-3 px-4 sm:px-6 lg:px-8",
            "ps-[max(1rem,env(safe-area-inset-left))] pe-[max(1rem,env(safe-area-inset-right))]",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-fg/70 lg:hidden"
            onClick={onOpenMobile}
            aria-label="Open menu"
          >
            <Menu className="h-4.5 w-4.5" />
          </Button>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className={cn(
              "group hidden flex-1 items-center gap-2 rounded-md border border-border bg-field-hover/40 px-3 h-9",
              "hover:bg-field-hover/70 hover:border-border transition-colors",
              "outline-none! focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              "sm:flex max-w-xs",
            )}
            aria-label="Search"
          >
            <Search className="h-3.5 w-3.5 shrink-0 text-fg/40 group-hover:text-fg/60" />
            <span className="flex-1 truncate text-left text-sm text-fg/45">Search…</span>
            <kbd className="hidden shrink-0 items-center gap-0.5 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-fg/45 sm:inline-flex">
              ⌘K
            </kbd>
          </button>

          <div className="flex shrink-0 items-center justify-end gap-0.5 ml-auto">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 sm:hidden"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search"
              title="Search"
            >
              <Search className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative h-9 w-9 shrink-0"
              onClick={() => navigate("/create-order")}
              aria-label="Create order"
              title="Create Order"
            >
              <ShoppingCart className="h-4 w-4" />
              {totalItems > 0 && (
                <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-fg">
                  {totalItems > 99 ? "99+" : totalItems}
                </span>
              )}
            </Button>
            <NotificationBell />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => navigate("/settings", { state: { from: pathname } })}
              aria-label="Settings"
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
            <div aria-hidden className="mx-1 hidden h-5 w-px bg-border sm:block" />
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  );
}
