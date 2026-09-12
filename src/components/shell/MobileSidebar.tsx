
import { Suspense } from "react";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "@/components/ui/Button";
import { useOrgSettings } from "@/context";
import { TenantLogo } from "@/components/branding/TenantLogo";
import { Skeleton } from "@/components/ui/Skeleton";
import { APP_NAME } from "@/components/branding/AppLogoMark";
import { NavItemsList } from "@/components/shell/NavItemsList";
import { UserMenu } from "@/components/shell/UserMenu";

export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, isLoading } = useOrgSettings();

  return (
    <div className={cn("fixed inset-0 z-40 lg:hidden", open ? "" : "pointer-events-none")}>
      <div
        className={cn(
          "absolute inset-0 bg-black/45 backdrop-blur-[2px] transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        className={cn(
          "absolute left-0 top-0 flex h-dvh max-h-dvh w-[min(88vw,300px)] flex-col rounded-r-2xl border-r border-border bg-card shadow-2xl transition-transform duration-200 ease-out",
          "pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0px,env(safe-area-inset-left))]",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {isLoading ? (
              <Skeleton className="h-11 w-11 shrink-0 rounded-xl" />
            ) : (
              <div className="shrink-0 overflow-hidden rounded-xl ring-1 ring-[hsl(var(--accent)/0.28)]">
                <TenantLogo logoUrl={settings.logoUrl} name={settings.storeName} sizeClass="h-11" maxWidthClass="max-w-11" />
              </div>
            )}
            <div className="min-w-0">
              {isLoading ? (
                <>
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="mt-1.5 h-2.5 w-16" />
                </>
              ) : (
                <>
                  <div className="truncate text-sm font-semibold leading-tight tracking-tight">
                    {settings.storeName || APP_NAME}
                  </div>
                  <div className="truncate text-[11px] text-fg/50">{APP_NAME}</div>
                </>
              )}
            </div>
          </div>
          <Button variant="ghost" size="sm" className="h-9 w-9 shrink-0 p-0" onClick={onClose} aria-label="Close menu">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <Suspense fallback={null}>
            <NavItemsList onItemClick={onClose} />
          </Suspense>
        </nav>

        <div className="shrink-0 border-t border-border p-2">
          <UserMenu variant="full" />
        </div>
      </div>
    </div>
  );
}
