import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/Table";
import { StickyTableHead, StickyTableCell } from "@/components/ui/StickyTableColumn";
import { Skeleton } from "@/components/ui/Skeleton";
import { DashboardSectionLabel } from "@/components/dashboard/DashboardSectionLabel";
import { RecordReorderModal } from "@/components/dashboard/RecordReorderModal";
import type { CriticalStockItem } from "@/types/dashboard";

export function CriticalStockCard({ items, loading }: { items: CriticalStockItem[]; loading?: boolean }) {
  const navigate = useNavigate();
  const [reorderTarget, setReorderTarget] = useState<CriticalStockItem | null>(null);

  return (
    // min-w-0 — this card is always rendered as a direct CSS grid item on
    // DashboardPage; without it, the table inside (min-w-140, scrolled via
    // its own overflow-auto) forces the grid track wider than the viewport
    // instead of scrolling internally. Same class of bug as
    // OrderDetailPage.tsx/CustomerDetailPage.tsx's own min-w-0 fix.
    <Card className="flex h-full min-w-0 flex-col p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <DashboardSectionLabel>Critical Stock (Action Required)</DashboardSectionLabel>
        <button
          type="button"
          onClick={() => navigate("/inventory")}
          className="text-[10px] font-semibold uppercase tracking-wider text-warn transition hover:underline"
        >
          Restock Alert
        </button>
      </div>

      <CardContent className="flex-1 px-0 pt-4">
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
          <div className="max-h-80 overflow-auto">
            <Table className="min-w-140">
              <TableHeader>
                <TableRow>
                  <StickyTableHead size={56} className="top-0 z-3 bg-card">
                    Part Details
                  </StickyTableHead>
                  <TableHead className="sticky top-0 z-2 bg-card text-right">In Stock</TableHead>
                  <TableHead className="sticky top-0 z-2 bg-card">Category</TableHead>
                  <TableHead className="sticky top-0 z-2 bg-card text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.inventoryId} className="group">
                    <StickyTableCell size={56}>
                      <div className="truncate font-medium text-fg">{item.sku}</div>
                      <div className="truncate text-xs text-fg/50">{item.name}</div>
                    </StickyTableCell>
                    <TableCell className="text-right">
                      <span className={item.stockCount === 0 ? "font-semibold text-danger" : "font-semibold text-warn"}>
                        {item.stockCount}
                      </span>
                    </TableCell>
                    <TableCell>
                      {item.category ? (
                        <Badge variant="outline" className="uppercase">
                          {item.category}
                        </Badge>
                      ) : (
                        <span className="text-xs text-fg/35">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="secondary" size="sm" onClick={() => setReorderTarget(item)}>
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
