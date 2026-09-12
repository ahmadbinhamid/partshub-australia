import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

// Reusable "add/remove rows of free text" input — same row pattern as eBay's
// Superseded Part Number(s) list (EbayItemSpecificsSection.tsx), pulled out
// here so other string[] fields (e.g. tenant pickup trading hours) don't
// duplicate the same markup.
export function StringListField({
  values,
  onChange,
  placeholder,
  addLabel = "Add",
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  addLabel?: string;
}) {
  const rows = values.length > 0 ? values : [""];

  function updateRow(index: number, value: string) {
    const next = [...rows];
    next[index] = value;
    onChange(next);
  }

  function addRow() {
    onChange([...rows, ""]);
  }

  function removeRow(index: number) {
    const next = rows.filter((_, i) => i !== index);
    onChange(next.length > 0 ? next : [""]);
  }

  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {rows.map((val, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              type="text"
              value={val}
              onChange={(e) => updateRow(i, e.target.value)}
              placeholder={placeholder}
              className="min-w-0 flex-1"
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              disabled={rows.length === 1 && val === ""}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-fg/40 transition-colors hover:border-danger/50 hover:bg-danger/5 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
              title="Remove"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      <Button type="button" variant="outline" size="sm" onClick={addRow} className="gap-1.5 text-xs">
        <Plus className="h-3 w-3" />
        {addLabel}
      </Button>
    </div>
  );
}
