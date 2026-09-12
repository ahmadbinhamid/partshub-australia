import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/utils/cn";
import { PER_PAGE_OPTIONS } from "@/config/pagination";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  totalItems?: number;
  itemsPerPage?: number;
  onLimitChange?: (limit: number) => void;
  perPageOptions?: readonly number[];
  isLoading?: boolean;
  className?: string;
}

const Pagination = ({
  currentPage,
  totalPages,
  onPageChange,
  totalItems,
  itemsPerPage = 15,
  onLimitChange,
  perPageOptions = PER_PAGE_OPTIONS,
  isLoading,
  className,
}: PaginationProps) => {
  if (totalItems === 0) return null;

  const renderPageNumbers = () => {
    const pages: (number | string)[] = [];
    const showEllipsisStart = currentPage > 3;
    const showEllipsisEnd = currentPage < totalPages - 2;

    pages.push(1);

    if (showEllipsisStart) pages.push("...");

    for (
      let i = Math.max(2, currentPage - 1);
      i <= Math.min(totalPages - 1, currentPage + 1);
      i++
    ) {
      if (!pages.includes(i)) pages.push(i);
    }

    if (showEllipsisEnd) pages.push("...");

    if (totalPages > 1 && !pages.includes(totalPages)) pages.push(totalPages);

    return pages;
  };

  return (
    <div
      className={cn(
        // Stacks on mobile — the row/page controls on the right previously
        // shared one row with the "Showing X-Y of Z" text unconditionally,
        // which overflowed/clipped once page-number buttons appeared on a
        // narrow screen.
        "flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5",
        className,
      )}
    >
      <p className="text-xs tabular-nums text-fg/50">
        {typeof totalItems === "number" ? (
          <>
            Showing{" "}
            <span className="font-medium text-fg/70">
              {totalItems === 0 ? 0 : (currentPage - 1) * itemsPerPage + 1}
            </span>
            {"–"}
            <span className="font-medium text-fg/70">
              {Math.min(currentPage * itemsPerPage, totalItems)}
            </span>{" "}
            of{" "}
            <span className="font-medium text-fg/70">{totalItems}</span>
          </>
        ) : (
          <>
            Page{" "}
            <span className="font-medium text-fg/70">{currentPage}</span>{" "}
            of{" "}
            <span className="font-medium text-fg/70">{totalPages}</span>
          </>
        )}
      </p>

      {/* Rows-per-page and the prev/page-numbers/next group stack as two
          separate centered rows on mobile — cramming both into one row (an
          earlier version of this fix) still overflowed/wrapped awkwardly on
          narrow phones once page-number buttons appeared. At sm:+ they go
          back to one row, right-aligned by the parent's justify-between. */}
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:gap-4">
        {onLimitChange ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg/50">Rows per page</span>
            <Select
              value={String(itemsPerPage)}
              onValueChange={(v) => onLimitChange(Number(v))}
            >
              <SelectTrigger className="h-8 w-auto min-w-16 gap-1.5 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {perPageOptions.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {totalPages > 1 ? (
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onPageChange(currentPage - 1)}
              disabled={currentPage === 1 || isLoading}
              className="h-8 w-8 p-0"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <div className="flex flex-wrap items-center gap-0.5">
              {renderPageNumbers().map((page, index) => {
                if (page === "...") {
                  return (
                    <span
                      key={`ellipsis-${index}`}
                      className="px-2 text-xs text-fg/40"
                    >
                      …
                    </span>
                  );
                }

                const pageNumber = page as number;
                const isActive = pageNumber === currentPage;

                return (
                  <button
                    key={pageNumber}
                    type="button"
                    onClick={() => onPageChange(pageNumber)}
                    className={cn(
                      "flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-xs font-medium transition",
                      isActive
                        ? "bg-accent text-accent-fg"
                        : "text-fg/60 hover:bg-bg-2",
                    )}
                  >
                    {pageNumber}
                  </button>
                );
              })}
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => onPageChange(currentPage + 1)}
              disabled={currentPage === totalPages || isLoading}
              className="h-8 w-8 p-0"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

Pagination.displayName = "Pagination";

export { Pagination };
export type { PaginationProps };
