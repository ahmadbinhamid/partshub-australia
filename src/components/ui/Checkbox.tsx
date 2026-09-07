
import * as React from "react";
import { cn } from "@/utils/cn";

export type CheckboxSize = "sm" | "md" | "lg";

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & {
  label?: React.ReactNode;
  description?: React.ReactNode;
  size?: CheckboxSize;
};

const checkboxSizes: Record<CheckboxSize, { input: string; label: string; desc: string }> = {
  sm: { input: "h-3.5 w-3.5", label: "text-xs", desc: "text-xs" },
  md: { input: "h-4 w-4", label: "text-sm", desc: "text-xs" },
  lg: { input: "h-5 w-5", label: "text-base", desc: "text-sm" },
};

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, label, description, id, size = "md", ...props },
  ref,
) {
  // NOTE (lint fix): React.useId() was called on the right side of `??`,
  // so it only actually ran on renders where `id` was falsy — a real
  // rules-of-hooks violation (the number of hooks called can change
  // between renders of the same instance if a caller's `id` prop toggles
  // between set/unset). Called unconditionally now; the `??` only picks
  // between the two already-computed values.
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const s = checkboxSizes[size];

  return (
    <div className="flex items-start gap-3">
      <div className="flex h-5 items-center">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className={cn(
            "rounded-xs border border-border bg-bg text-accent shadow-sm outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "checked:border-accent checked:bg-accent",
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
