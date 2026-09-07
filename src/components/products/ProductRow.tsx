import { Badge } from "@/components/ui/Badge";
import { TableRow, TableCell } from "@/components/ui/Table";
import { StickyTableCell } from "@/components/ui/StickyTableColumn";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/ActionsMenu";
import { ProductChannelDots, ProductChannelDetail } from "@/components/products/ProductChannelStatus";
import type { Product } from "@/types/product";
import type { ChannelSummary } from "@/types/channel";
import type { AnyMarketplaceListing } from "@/types/marketplace";
import { formatCurrency } from "@/utils/format";
import { Package, ChevronDown, ChevronRight, Globe, EyeOff } from "lucide-react";
import { ProductRowActionsMenu } from "@/components/products/ProductRowActionsMenu";
import { AddToCartButton } from "@/components/pos/AddToCartButton";
import { STOCK_STATUS_CONFIG } from "@/config/stockStatus";

interface ProductRowProps {
  product: Product;
  channels: ChannelSummary[];
  listings?: AnyMarketplaceListing[];
  expanded: boolean;
  onToggleExpand: () => void;
  onOpenChannel: (platform: string) => void;
  onListChannel: (platform: string) => void;
  columnWidth?: number;
  onColumnResize?: (width: number) => void;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePublish: (published: boolean) => void;
}

export function ProductRow({
  product,
  channels,
  listings = [],
  expanded,
  onToggleExpand,
  onOpenChannel,
  onListChannel,
  columnWidth,
  onColumnResize,
  onClick,
  onEdit,
  onDelete,
  onTogglePublish,
}: ProductRowProps) {
  const coverImage = product.attachments?.[0];

  return (
    <>
      <TableRow onClick={onClick} className="group cursor-pointer">
        {/* Product — sticky so it stays readable while the rest scrolls on narrow screens.
            max-w caps the column so a very long title truncates instead of blowing out the table.
            Width is user-resizable from any row's own drag handle, not just the
            header's — see StickyTableColumn. */}
        <StickyTableCell size={64} width={columnWidth} onResize={onColumnResize}>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-xs border border-border bg-bg-2">
              {coverImage?.url ? (
                <img
                  src={coverImage.url}
                  alt={product.title}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Package className="h-5 w-5 text-fg/25" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-fg">{product.title}</div>
              <div className="mt-0.5 flex items-center gap-2">
                {product.sku ? (
                  <span className="truncate text-xs text-fg/45">
                    {product.sku}
                  </span>
                ) : (
                  <span className="text-xs text-fg/30 italic">No SKU</span>
                )}
              </div>
            </div>
          </div>
        </StickyTableCell>

        {/* Status */}
        <TableCell className="whitespace-nowrap">
          <Badge variant={product.status === "active" ? "ok" : "muted"}>
            {product.status === "active" ? "Active" : "Draft"}
          </Badge>
        </TableCell>

        {/* Online */}
        <TableCell className="whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-auto w-auto items-center gap-1 rounded-full px-0 py-0 text-fg/40 hover:bg-transparent hover:text-fg/40 data-[state=open]:bg-transparent data-[state=open]:text-fg/40">
              <Badge variant={product.is_published_online ? "ok" : "muted"} className="cursor-pointer">
                {product.is_published_online ? "Published" : "Hidden"}
                <ChevronDown className="h-3 w-3" />
              </Badge>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => onTogglePublish(true)}>
                <Globe className="h-3.5 w-3.5 text-fg/50" />
                Publish
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onTogglePublish(false)}>
                <EyeOff className="h-3.5 w-3.5 text-fg/50" />
                Hide
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>

        {/* Stock */}
        <TableCell className="whitespace-nowrap">
          <Badge variant={STOCK_STATUS_CONFIG[product.stock_status]?.variant ?? "muted"}>
            {STOCK_STATUS_CONFIG[product.stock_status]?.label ?? product.stock_status}
          </Badge>
        </TableCell>

        {/* Channels — expand/collapse control lives here (stopPropagation,
            independent of the row's own click-to-edit behaviour). */}
        <TableCell className="whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
          {channels.length > 0 ? (
            <button
              type="button"
              onClick={onToggleExpand}
              className="flex items-center gap-1 rounded-xs px-1 py-0.5 -mx-1 hover:bg-bg-2"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg/40" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg/40" />
              )}
              <ProductChannelDots channels={channels} listings={listings} />
            </button>
          ) : (
            <span className="text-xs text-fg/35">—</span>
          )}
        </TableCell>

        {/* Price */}
        <TableCell className="whitespace-nowrap text-right font-medium tabular-nums text-sm">
          {formatCurrency(product.price)}
        </TableCell>

        {/* Created */}
        <TableCell className="whitespace-nowrap text-right text-xs text-fg/45">
          {new Date(product.created_at).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </TableCell>

        {/* Actions */}
        <TableCell className="w-px whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-end gap-1">
            <AddToCartButton product={product} display="icon" />
            <ProductRowActionsMenu onEdit={onEdit} onDelete={onDelete} />
          </div>
        </TableCell>
      </TableRow>

      {expanded && channels.length > 0 && (
        <TableRow className="bg-bg-2/50 hover:bg-bg-2/50">
          <TableCell colSpan={8} className="p-0">
            <div className="px-5 py-2">
              <ProductChannelDetail
                channels={channels}
                listings={listings}
                onOpen={onOpenChannel}
                onList={onListChannel}
              />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
