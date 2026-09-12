import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/utils/cn";

// Radix DropdownMenu renders via Portal so it's never clipped by
// overflow:auto/hidden on ancestor table/card containers.

const DropdownMenu = DropdownMenuPrimitive.Root;

const DropdownMenuTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ className, asChild, ...props }, ref) => (
  <DropdownMenuPrimitive.Trigger
    ref={ref}
    asChild={asChild}
    // The default icon-button sizing (fixed 28px square, muted text) is only
    // right for the bare "···" trigger below — with asChild, the caller
    // supplies its own fully-styled element (e.g. a labelled Button), and
    // Radix's Slot merges these classes onto it regardless, so applying them
    // unconditionally clipped/greyed out any asChild trigger that wasn't
    // also a 28px icon square. Only the bare (non-asChild) trigger gets them.
    className={cn(
      !asChild &&
        "flex h-7 w-7 items-center justify-center rounded-md text-fg/40 outline-none transition hover:bg-bg-2 hover:text-fg data-[state=open]:bg-bg-2 data-[state=open]:text-fg",
      className,
    )}
    {...props}
  />
));
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-36 overflow-hidden rounded-lg border border-border bg-bg shadow-lg",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    destructive?: boolean;
  }
>(({ className, destructive, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      // outline-none! (not plain outline-none) — globals.css's :focus-visible
      // ring is an unlayered rule, so it wins over a plain Tailwind utility
      // regardless of source order; only the `!important` form actually
      // suppresses it. Needed here because Radix gives a highlighted item
      // real DOM focus (roving tabindex) on hover/keyboard nav, and the
      // item's own focus:bg-* already communicates "highlighted" — the gold
      // ring on top of that was the bug being fixed.
      "flex w-full cursor-default select-none items-center gap-2.5 px-3 py-2 text-sm outline-none! transition",
      destructive
        ? "text-danger focus:bg-danger/8"
        : "text-fg focus:bg-bg-2",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn("mx-2 my-0.5 h-px bg-border", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

// Convenience wrapper: renders the ··· trigger button
function ActionsMenuTrigger({ className }: { className?: string }) {
  return (
    <DropdownMenuTrigger className={className}>
      <MoreHorizontal className="h-4 w-4" />
      <span className="sr-only">Actions</span>
    </DropdownMenuTrigger>
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  ActionsMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
};
