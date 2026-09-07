import { useState, useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Table, TableHeader, TableRow, TableHead, TableBody } from "@/components/ui/Table";
import { StickyTableHead } from "@/components/ui/StickyTableColumn";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalFooter,
  ModalTitle,
  ModalDescription,
} from "@/components/ui/Modal";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { PageHeader } from "@/components/shared/PageHeader";
import { ProductRow } from "@/components/products/ProductRow";
import { ProductGrid, ProductGridSkeleton } from "@/components/products/ProductGrid";
import { ViewToggle, type ViewMode } from "@/components/ui/ViewToggle";
import { getProducts, deleteProduct, updateProduct } from "@/lib/api/products";
import { getCategories } from "@/lib/api/categories";
import { getListings } from "@/lib/api/listings";
import { useToast } from "@/context";
import type { Product } from "@/types/product";
import type { AnyMarketplaceListing } from "@/types/marketplace";
import { Pagination } from "@/components/ui/Pagination";
import { DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE_GRID, PER_PAGE_OPTIONS_GRID } from "@/config/pagination";
import { PLATFORM_LABEL, AVAILABLE_PLATFORMS } from "@/config/marketplacePlatforms";
import { Plus, Search, Package, Trash2, AlertTriangle } from "lucide-react";

const STATUS_FILTERS = [
  { label: "All Status", value: "" },
  { label: "Active", value: "active" },
  { label: "Draft", value: "draft" },
];

const STOCK_FILTERS = [
  { label: "All Stock", value: "" },
  { label: "In Stock", value: "in_stock" },
  { label: "Low Stock", value: "low_stock" },
  { label: "Out of Stock", value: "out_of_stock" },
];

const CHANNEL_FILTERS = [
  { label: "All Channels", value: "" },
  ...AVAILABLE_PLATFORMS.map((value) => ({ label: PLATFORM_LABEL[value], value })),
  { label: "Not Listed", value: "none" },
];

// ── Page ─────────────────────────────────────────────────────────────────────
export default function ProductsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("search") ?? "";
  const status = searchParams.get("status") ?? "";
  const stock = searchParams.get("stock") ?? "";
  const channel = searchParams.get("channel") ?? "";
  const categories = searchParams.get("categories") ?? "";
  const view: ViewMode = searchParams.get("view") === "grid" ? "grid" : "list";
  const page = parseInt(searchParams.get("page") ?? "1", 10);
  const limit = parseInt(
    searchParams.get("limit") ?? String(view === "grid" ? DEFAULT_PAGE_SIZE_GRID : DEFAULT_PAGE_SIZE),
    10,
  );
  const selectedCategories = categories ? categories.split(",") : [];

  const [inputValue, setInputValue] = useState(search);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [productColWidth, setProductColWidth] = useState<number | null>(null);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchParams((prev) => {
        const current = prev.get("search") ?? "";
        if (inputValue === current) return prev; // no change — don't reset page
        const next = new URLSearchParams(prev);
        if (inputValue) next.set("search", inputValue);
        else next.delete("search");
        next.set("page", "1");
        return next;
      }, { replace: true });
    }, 400);
    return () => clearTimeout(timer);
  }, [inputValue, setSearchParams]);

  const setStatus = useCallback(
    (val: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (val) next.set("status", val);
        else next.delete("status");
        next.set("page", "1");
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setStock = useCallback(
    (val: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (val) next.set("stock", val);
        else next.delete("stock");
        next.set("page", "1");
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setChannel = useCallback(
    (val: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (val) next.set("channel", val);
        else next.delete("channel");
        next.set("page", "1");
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setPage = useCallback(
    (p: number) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("page", String(p));
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setLimit = useCallback(
    (l: number) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("limit", String(l));
        next.set("page", "1");
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setCategories = useCallback(
    (ids: string[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (ids.length) next.set("categories", ids.join(","));
        else next.delete("categories");
        next.set("page", "1");
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setView = useCallback(
    (mode: ViewMode) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (mode === "grid") next.set("view", "grid");
        else next.delete("view");
        // Drop any explicit limit/page from the other mode — list and grid
        // use different page-size options (grid's are multiples of its
        // column counts), so a stale limit can mismatch the new mode's set.
        next.delete("limit");
        next.set("page", "1");
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["products", { search, status, stock, channel, categories, page, limit }],
    queryFn: () => getProducts({ search, status, stock, channel, categories, page, limit }),
  });

  const { data: categoriesRes } = useQuery({
    queryKey: ["categories", "all"],
    queryFn: () => getCategories({ limit: 100 }),
    staleTime: 5 * 60 * 1000,
  });
  const categoryOptions = (categoriesRes?.data?.items ?? []).map((c) => ({
    value: c._id,
    label: c.name,
  }));

  const pageProductIds = (data?.data?.items ?? []).map((p) => p._id);

  // Scoped to just this page's product ids (not a flat `limit`-capped fetch)
  // so a tenant with >100 total listings on any one channel doesn't have
  // older listings silently excluded — see
  // listing.query.service.js#listListings. Mixes every platform's listings
  // together (that endpoint is generic, not eBay-only), so a product's
  // Channels badge shows Google alongside eBay without a second fetch.
  const { data: listingsData } = useQuery({
    queryKey: ["listings-for-products", pageProductIds],
    queryFn: () => getListings({ product_in: pageProductIds.join(",") }),
    enabled: pageProductIds.length > 0,
    staleTime: 30_000,
  });

  const listingPlatformsMap = new Map<string, string[]>();
  ((listingsData?.data?.items ?? []) as AnyMarketplaceListing[])
    .filter((l) => l.product != null)
    .forEach((l) => {
      const id = typeof l.product === "string" ? l.product : (l.product as { _id: string })._id;
      const platforms = listingPlatformsMap.get(id) ?? [];
      if (!platforms.includes(l.platform)) listingPlatformsMap.set(id, [...platforms, l.platform]);
    });

  const listedProductIds = new Set(listingPlatformsMap.keys());

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProduct(id),
    onSuccess: () => {
      toast({ title: "Product deleted", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, tone: "danger" });
      setDeleteTarget(null);
    },
  });

  const publishMutation = useMutation({
    mutationFn: ({ id, published }: { id: string; published: boolean }) => {
      const form = new FormData();
      form.append("is_published_online", String(published));
      return updateProduct(id, form);
    },
    onSuccess: (_data, { published }) => {
      toast({ title: published ? "Product published" : "Product hidden", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (err: Error) => toast({ title: "Update failed", description: err.message, tone: "danger" }),
  });

  const products: Product[] = data?.data?.items ?? [];
  const total = data?.data?.total ?? 0;
  const totalPages = data?.data?.totalPages ?? 1;
  const isDeleteTargetListed = deleteTarget ? listedProductIds.has(deleteTarget._id) : false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        description={
          total > 0
            ? `${total} product${total !== 1 ? "s" : ""} in your catalogue`
            : "Manage your product catalogue"
        }
      >
        <Button variant="primary" size="md" className="gap-2" onClick={() => navigate("/products/new")}>
          <Plus className="h-4 w-4" />
          New Product
        </Button>
      </PageHeader>

      <Card>
        {/* Toolbar */}
        <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg/40 pointer-events-none" />
            <Input
              placeholder="Search products…"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {isFetching && !isLoading && (
              <span className="text-xs text-fg/40">Updating…</span>
            )}
            <FilterSelect options={STATUS_FILTERS} value={status} onChange={setStatus} />
            <FilterSelect options={STOCK_FILTERS} value={stock} onChange={setStock} />
            <FilterSelect options={CHANNEL_FILTERS} value={channel} onChange={setChannel} />
            <MultiSelect
              options={categoryOptions}
              value={selectedCategories}
              onChange={setCategories}
              placeholder="All categories"
              searchPlaceholder="Search categories…"
              className="w-48"
            />
            <ViewToggle value={view} onChange={setView} />
          </div>
        </div>

        {/* List / Grid */}
        {isLoading ? (
          view === "grid" ? <ProductGridSkeleton /> : <LoadingSkeleton />
        ) : products.length === 0 ? (
          <EmptyState
            search={search}
            onNew={() => navigate("/products/new")}
          />
        ) : view === "grid" ? (
          <ProductGrid
            products={products}
            onProductClick={(product) => navigate(`/products/${product.slug}/edit`)}
            onEdit={(product) => navigate(`/products/${product.slug}/edit`)}
            onDelete={(product) => setDeleteTarget(product)}
            onTogglePublish={(product, published) =>
              publishMutation.mutate({ id: product._id, published })
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-240">
              <TableHeader>
                <TableRow>
                  <StickyTableHead
                    size={64}
                    width={productColWidth ?? undefined}
                    onResize={setProductColWidth}
                  >
                    Product
                  </StickyTableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Online</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => (
                  <ProductRow
                    key={product._id}
                    product={product}
                    listingPlatforms={listingPlatformsMap.get(product._id) ?? []}
                    columnWidth={productColWidth ?? undefined}
                    onColumnResize={setProductColWidth}
                    onClick={() => navigate(`/products/${product.slug}/edit`)}
                    onEdit={() => navigate(`/products/${product.slug}/edit`)}
                    onDelete={() => setDeleteTarget(product)}
                    onTogglePublish={(published) =>
                      publishMutation.mutate({ id: product._id, published })
                    }
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={total}
          itemsPerPage={limit}
          perPageOptions={view === "grid" ? PER_PAGE_OPTIONS_GRID : undefined}
          onLimitChange={setLimit}
          isLoading={isFetching}
          onPageChange={setPage}
        />
      </Card>

      {/* Delete confirm modal */}
      <Modal
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        {deleteTarget && (
          <ModalContent className="max-w-sm">
            <ModalHeader>
              <div className={`mb-1 flex h-11 w-11 items-center justify-center rounded-full ${isDeleteTargetListed ? "bg-warn/10" : "bg-danger/10"}`}>
                <AlertTriangle className={`h-5 w-5 ${isDeleteTargetListed ? "text-warn" : "text-danger"}`} />
              </div>
              <ModalTitle>{isDeleteTargetListed ? "Cannot delete product" : "Delete product?"}</ModalTitle>
              <ModalDescription>
                {isDeleteTargetListed ? (
                  <>
                    <span className="font-medium text-fg">{deleteTarget.title}</span>{" "}
                    has a marketplace listing. Remove the listing first, then delete the product.
                  </>
                ) : (
                  <>
                    <span className="font-medium text-fg">{deleteTarget.title}</span>{" "}
                    will be permanently deleted. This action cannot be undone.
                  </>
                )}
              </ModalDescription>
            </ModalHeader>
            <ModalFooter>
              <Button
                type="button"
                variant="secondary"
                size="md"
                className="flex-1"
                disabled={deleteMutation.isPending}
                onClick={() => setDeleteTarget(null)}
              >
                {isDeleteTargetListed ? "Close" : "Cancel"}
              </Button>
              {!isDeleteTargetListed && (
                <Button
                  type="button"
                  variant="danger"
                  size="md"
                  className="flex-1 gap-2"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(deleteTarget._id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {deleteMutation.isPending ? "Deleting…" : "Delete"}
                </Button>
              )}
            </ModalFooter>
          </ModalContent>
        )}
      </Modal>
    </div>
  );
}

const SKEL_WIDTHS = [140, 180, 120, 160, 200, 130, 170, 150];

function LoadingSkeleton() {
  return (
    <div className="divide-y divide-border">
      {SKEL_WIDTHS.map((w, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-3.5">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-xs bg-bg-2" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 animate-pulse rounded-xs bg-bg-2" style={{ width: w }} />
            <div className="h-3 w-20 animate-pulse rounded-xs bg-bg-2" />
          </div>
          <div className="h-5 w-14 animate-pulse rounded-xs bg-bg-2" />
          <div className="h-5 w-16 animate-pulse rounded-xs bg-bg-2" />
          <div className="h-5 w-20 animate-pulse rounded-xs bg-bg-2" />
          <div className="h-5 w-16 animate-pulse rounded-xs bg-bg-2" />
          <div className="h-7 w-7 animate-pulse rounded-xs bg-bg-2" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ search, onNew }: { search: string; onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-xs border border-border bg-bg-2">
        <Package className="h-8 w-8 text-fg/30" />
      </div>
      <div>
        <p className="font-medium text-fg">
          {search ? "No products found" : "No products yet"}
        </p>
        <p className="mt-1 text-sm text-fg/50">
          {search
            ? `No results for "${search}" — try a different term`
            : "Create your first product to get started"}
        </p>
      </div>
      {!search && (
        <Button
          variant="primary"
          size="sm"
          className="mt-1 gap-1.5"
          onClick={onNew}
        >
          <Plus className="h-3.5 w-3.5" />
          New Product
        </Button>
      )}
    </div>
  );
}