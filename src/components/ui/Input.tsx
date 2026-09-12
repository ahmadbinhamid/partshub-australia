
import * as React from "react";
import { cn } from "@/utils/cn";

export type InputSize = "sm" | "md" | "lg";
export type InputVariant = "default" | "ghost" | "filled";

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: InputSize;
  variant?: InputVariant;
};

const inputSizes: Record<InputSize, string> = {
  sm: "h-8 px-2.5 text-xs",
  md: "h-10 px-3 text-sm",
  lg: "h-12 px-4 text-base",
};

const inputVariants: Record<InputVariant, string> = {
  default: "border border-border bg-card text-fg shadow-(--shadow-input)",
  ghost: "border border-transparent bg-transparent text-fg hover:bg-field-hover/50",
  filled: "border border-transparent bg-field-hover text-fg",
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = "md", variant = "default", ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full rounded-xl outline-none! transition-shadow duration-150",
        "placeholder:text-fg/45",
        "focus-visible:border-accent focus-visible:shadow-(--shadow-input-focus)",
        "disabled:cursor-not-allowed disabled:opacity-50",
        inputSizes[size],
        inputVariants[variant],
        className,
      )}
      {...props}
    />
  );
});
