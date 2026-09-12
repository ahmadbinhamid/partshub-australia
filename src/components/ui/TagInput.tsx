import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
}

export function TagInput({
  value,
  onChange,
  placeholder = "Add tag…",
  id,
  className,
  disabled,
}: TagInputProps) {
  const [inputValue, setInputValue] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const addTag = (raw: string) => {
    const tag = raw.replace(/,$/, "").trim();
    if (tag && !value.includes(tag)) {
      onChange([...value, tag]);
    }
    setInputValue("");
  };

  const removeTag = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (inputValue.trim()) addTag(inputValue);
    } else if (e.key === "Backspace" && !inputValue && value.length > 0) {
      removeTag(value[value.length - 1]);
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 shadow-(--shadow-input)",
        "focus-within:border-accent focus-within:shadow-(--shadow-input-focus)",
        "transition-shadow duration-150",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-md bg-bg-2 px-2 py-0.5 text-xs font-medium text-fg ring-1 ring-inset ring-border"
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
              className="ml-0.5 rounded-sm text-fg/40 transition hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (inputValue.trim()) addTag(inputValue);
        }}
        placeholder={value.length === 0 ? placeholder : ""}
        disabled={disabled}
        className="min-w-20 flex-1 bg-transparent text-sm outline-none placeholder:text-fg/40"
      />
    </div>
  );
}
