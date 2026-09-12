import { cn } from "@/utils/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const base =
  "inline-flex items-center justify-center rounded-xl font-semibold transition-all duration-150 active:scale-[0.98] active:transition-none outline-none! focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg shadow-[0_1px_0_rgba(0,0,0,0.05)] hover:brightness-95",
  secondary: "bg-card text-fg ring-1 ring-inset ring-border shadow-(--shadow-input) hover:bg-muted/60",
  ghost: "bg-transparent text-fg hover:bg-muted/60",
  danger: "bg-danger text-danger-fg shadow-[0_1px_0_rgba(0,0,0,0.05)] hover:brightness-95",
  outline: "border border-border bg-transparent text-fg hover:bg-muted/60",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-11 px-5 text-sm gap-2",
  icon: "h-10 w-10 p-0",
};

export function buttonClassName({
  variant = "primary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  return cn(base, variants[variant], sizes[size], className);
}
