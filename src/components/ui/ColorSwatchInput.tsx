import { cn } from "@/utils/cn";

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function ColorSwatchInput({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const swatchColor = HEX_COLOR_RE.test(value) ? value : "transparent";

  return (
    <div
      className={cn(
        "flex h-10 w-full items-center gap-2.5 rounded-xl border border-border bg-card px-3 shadow-(--shadow-input)",
        className,
      )}
    >
      <label
        className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
        style={{ backgroundColor: swatchColor }}
      >
        <input
          type="color"
          value={HEX_COLOR_RE.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="Pick a colour"
        />
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#000000"
        className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg/45"
      />
    </div>
  );
}
