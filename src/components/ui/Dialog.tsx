
import { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "@/components/ui/Button";

export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
  bodyClassName,
  anchor = "right",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Applied to the sliding panel (surface, border, text). */
  className?: string;
  /** Applied to the scrollable body region below the header. */
  bodyClassName?: string;
  anchor?: "left" | "right";
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className={cn("fixed inset-0 z-50", open ? "" : "pointer-events-none")}>
      <div
        className={cn(
          "absolute inset-0 bg-black/45 transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className={cn(
          "absolute top-0 flex h-[100dvh] max-h-[100dvh] w-full max-w-[min(100vw,560px)] flex-col border-border bg-bg shadow-(--shadow-soft) transition-transform duration-200 ease-out",
          anchor === "left"
            ? "left-0 border-r pl-[max(0px,env(safe-area-inset-left))]"
            : "right-0 border-l pr-[max(0px,env(safe-area-inset-right))]",
          open ? "translate-x-0" : anchor === "left" ? "-translate-x-full" : "translate-x-full",
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div
          className={cn(
            "flex shrink-0 items-center justify-between border-b border-border px-5 py-4",
            "pt-[max(0.75rem,env(safe-area-inset-top))]",
          )}
        >
          <div className="min-w-0 truncate text-sm font-semibold">{title}</div>
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
            bodyClassName,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
