
import * as React from "react";
import { cn } from "@/utils/cn";

export type RadioSize = "sm" | "md" | "lg";

export type RadioProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & {
  label?: React.ReactNode;
  description?: React.ReactNode;
  size?: RadioSize;
};

const radioSizes: Record<RadioSize, { input: string; label: string; desc: string }> = {
  sm: { input: "h-3.5 w-3.5", label: "text-xs", desc: "text-xs" },
  md: { input: "h-4 w-4", label: "text-sm", desc: "text-xs" },
  lg: { input: "h-5 w-5", label: "text-base", desc: "text-sm" },
};

export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { className, label, description, id, size = "md", ...props },
  ref,
) {
  // NOTE (lint fix): same real rules-of-hooks bug as Checkbox.tsx — see
  // that file's comment.
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const s = radioSizes[size];

  return (
    <div className="flex items-start gap-3">
      <div className="flex h-5 items-center">
        <input
          ref={ref}
          id={inputId}
          type="radio"
          className={cn(
            "rounded-full border border-border bg-bg text-accent shadow-sm outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "[accent-color:hsl(var(--accent))]",
            s.input,
            className,
          )}
          {...props}
        />
      </div>
      {(label || description) ? (
        <div className="min-w-0">
          {label ? (
            <label htmlFor={inputId} className={cn("cursor-pointer select-none font-medium text-fg", s.label)}>
              {label}
            </label>
          ) : null}
          {description ? (
            <p className={cn("mt-0.5 text-fg/55", s.desc)}>{description}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export function RadioGroup({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-2", className)} role="radiogroup">
      {children}
    </div>
  );
}
