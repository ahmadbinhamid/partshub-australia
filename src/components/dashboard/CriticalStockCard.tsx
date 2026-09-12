import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/Table";
import { Skeleton } from "@/components/ui/Skeleton";
import { DashboardSectionLabel } from "@/components/dashboard/DashboardSectionLabel";
import { RecordReorderModal } from "@/components/dashboard/RecordReorderModal";
import type { CriticalStockItem } from "@/types/dashboard";

export function CriticalStockCard({ items, loading }: { items: CriticalStockItem[]; loading?: boolean }) {
  const navigate = useNavigate();
  const [reorderTarget, setReorderTarget] = useState<CriticalStockItem | null>(null);

  return (
    <Card className="flex h-full min-w-0 flex-col p-3 shadow-card transition-shadow duration-300 hover:shadow-md sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-y-1.5 border-b border-border pb-1.5">
        <DashboardSectionLabel badge={`${items.length} Urgent`} badgeVariant="danger">
          Low Stock Alert
        </DashboardSectionLabel>
        <button
          type="button"
          onClick={() => navigate("/inventory")}
          className="flex shrink-0 items-center gap-1 text-xs font-semibold text-accent transition hover:text-accent/80"
        >
          View inventory
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <CardContent className="flex-1 px-0 pt-3">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-sm text-fg/45">
            <ShieldAlert className="mx-auto mb-2 h-6 w-6 text-fg/25" />
            Nothing below your low-stock threshold right now.
          </div>
        ) : (
          // No sticky/pinned first column here — unlike the app's larger data
          // tables, this is always just 3 narrow columns that comfortably
          // fit the card width, so the sticky-column chrome (an opaque fill
          // + a divider line down the first column) would only add visual
          // weight this compact widget doesn't need.
          <div className="max-h-80 overflow-x-auto">
            {/* text-xs — Table.tsx defaults to text-sm; the reference wraps
                its whole table in text-xs, which is what actually keeps its
                rows this compact (smaller font -> shorter line-height ->
                shorter rows), not just the cell padding. */}
            <Table className="text-xs">
              <TableHeader className="bg-transparent">
                <TableRow className="hover:bg-transparent">
                  {/* px-0 everywhere, not just the first/last edges — the
                      reference's <td>/<th> carry NO horizontal padding at
                      all (px-4 on Table.tsx's base TableHead/TableCell is a
                      gutter this table was never supposed to have; even the
                      *middle* column had it, which is what was still
                      showing as "too much horizontal padding" after the
                      first pass only fixed the two edges). Column spacing
                      instead comes purely from content width + the
                      text-center/text-right alignment, same as the
                      reference. first:/last: modifier still needed (see
                      below) since a plain px-0 doesn't dedupe against the
                      base's first:pl-5/last:pr-5 in tailwind-merge. */}
                  <TableHead className="h-auto px-0 pb-1.5 first:pl-0 text-[11px] font-medium normal-case tracking-normal text-fg/40">
                    Part &amp; SKU
                  </TableHead>
                  <TableHead className="h-auto px-0 pb-1.5 text-center text-[11px] font-medium normal-case tracking-normal text-fg/40">
                    Available Stock
                  </TableHead>
                  <TableHead className="h-auto px-0 pb-1.5 last:pr-0 text-right text-[11px] font-medium normal-case tracking-normal text-fg/40">
                    Action
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.inventoryId} className="group cursor-pointer">
                    <TableCell className="px-0 py-2 first:pl-0">
                      <div className="truncate font-semibold text-fg group-hover:text-accent">{item.name}</div>
                      <div className="truncate font-mono text-[11px] text-fg/40">{item.sku}</div>
                    </TableCell>
                    <TableCell className="px-0 py-2 text-center">
                      <Badge variant="danger">{item.stockCount} units</Badge>
                    </TableCell>
                    <TableCell className="px-0 py-2 text-right last:pr-0">
                      <Button variant="primary" size="sm" onClick={() => setReorderTarget(item)}>
                        Reorder
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <RecordReorderModal item={reorderTarget} onOpenChange={(open) => !open && setReorderTarget(null)} />
    </Card>
  );
}
