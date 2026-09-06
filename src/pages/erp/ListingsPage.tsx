import { useState, useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/Table";
import { StickyTableHead, StickyTableCell } from "@/components/ui/StickyTableColumn";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalFooter,
  ModalTitle,
  ModalDescription,
} from "@/components/ui/Modal";
import { Pagination } from "@/components/ui/Pagination";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { PageHeader } from "@/components/shared/PageHeader";
import { DEFAULT_PAGE_SIZE } from "@/config/pagination";
import { getListing, getGroupedListings, updateListing, pushListing, deleteListing } from "@/lib/api/listings";
import { createGoogleListing, updateGoogleListing } from "@/lib/api/googleListings";
import { listingToForm, getListingFallbackImageUrl } from "@/lib/marketplace/listingToForm";
import { useToast } from "@/context";
import type {
  GoogleListing,
  GoogleListingFormState,
  GroupedListingSummary,
  MarketplacePlatform,
  ProductListingGroup,
} from "@/types/marketplace";
import { GOOGLE_LISTING_FORM_INITIAL } from "@/types/marketplace";
import type { Product } from "@/types/product";
import { SyncBadge } from "@/components/listings/SyncBadge";
import { ProductPickerModal } from "@/components/listings/ProductPickerModal";
import { ListingRowActionsMenu } from "@/components/listings/ListingRowActionsMenu";
import { GoogleListingEditModal } from "@/components/listings/GoogleListingEditModal";
import { PLATFORM_LABEL, AVAILABLE_PLATFORMS } from "@/config/marketplacePlatforms";
import { Plus, Cloud, Search, ChevronDown, ChevronRight } from "lucide-react";

// ── Constants ─────────────────────────────────────────────────────────────────

const SYNC_STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Synced", value: "synced" },
  { label: "Pending", value: "pending" },
  { label: "Out of Stock", value: "out_of_stock" },
  { label: "Price Locked (On Sale)", value: "price_locked" },
  { label: "Error", value: "error" },
  { label: "Not listed", value: "not_listed" },
];

const PLATFORM_FILTERS = [
  { label: "All channels", value: "" },
  ...AVAILABLE_PLATFORMS.map((p) => ({ label: PLATFORM_LABEL[p] ?? p, value: p })),
];

// A row's deletion/push/edit target — deliberately just the pieces those
// actions actually need (group for product context, the one listing
// summary being acted on), rather than reconstructing a full
// AnyMarketplaceListing client-side out of the grouped view's smaller shape.
interface ListingActionTarget {
  group: ProductListingGroup;
  listing: GroupedListingSummary;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ListingsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // URL-synced state (survives refresh/back navigation)
  const search = searchParams.get("search") ?? "";
  const syncStatus = searchParams.get("sync_status") ?? "";
  const platform = searchParams.get("platform") ?? "";
  const page = parseInt(searchParams.get("page") ?? "1", 10);
  const limit = parseInt(searchParams.get("limit") ?? String(DEFAULT_PAGE_SIZE), 10);

  // Local UI state (doesn't need to be in URL)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ListingActionTarget | null>(null);
  const [googleEditTarget, setGoogleEditTarget] = useState<GoogleListing | null>(null);
  const [inputValue, setInputValue] = useState(search);
  const [productColWidth, setProductColWidth] = useState<number | null>(null);
  // TASK 6: which product rows are expanded to show their per-listing detail
  // — a product on only one channel starts expanded automatically (nothing
  // to collapse into), a product on multiple channels starts collapsed.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  const setSyncStatus = useCallback(
    (val: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (val) next.set("sync_status", val);
        else next.delete("sync_status");
        next.set("page", "1");
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setPlatform = useCallback(
    (val: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (val) next.set("platform", val);
        else next.delete("platform");
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

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["listings", "grouped", { page, limit, sync_status: syncStatus, platform, search }],
    queryFn: () =>
      getGroupedListings({
        page,
        limit,
        ...(syncStatus ? { sync_status: syncStatus } : {}),
        ...(platform ? { platform: platform as MarketplacePlatform } : {}),
        ...(search ? { search } : {}),
      }),
  });

  const groups: ProductListingGroup[] = data?.data?.items ?? [];
  const total = data?.data?.total ?? 0;
  const totalPages = data?.data?.totalPages ?? 1;

  const deleteListingName = deleteTarget?.group.product?.title ?? "This listing";
  const deleteListingIsLive = !!deleteTarget?.listing.external_listing_id;

  const pushMutation = useMutation({
    // eBay: resave first so description_override is regenerated from current
    // product/listing data (e.g. the real photo) before eBay receives it —
    // pushing straight from here previously resent whatever HTML happened to
    // already be stored, which was stale for anything synced before a
    // description-generator change. Google has no equivalent stale-snapshot
    // problem (its adapter reads title/description/price/photos live off the
    // product at sync time, not off a stored HTML blob) — just push.
    mutationFn: async ({ listing }: ListingActionTarget) => {
      if (listing.platform === "ebay") {
        const { data: fresh } = await getListing(listing._id);
        if (fresh.platform === "ebay") {
          const vehicle =
            fresh.product !== null && typeof fresh.product === "object" ? fresh.product.vehicle ?? null : null;
          await updateListing(listing._id, listingToForm(fresh), vehicle, getListingFallbackImageUrl(fresh));
        }
      }
      await pushListing(listing._id);
    },
    onSuccess: (_data, { listing }) => {
      toast({ title: `Queued for ${PLATFORM_LABEL[listing.platform] ?? listing.platform} sync`, tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["listings"] });
    },
    onError: (err: Error) => toast({ title: err.message, tone: "danger" }),
  });

  const googleUpdateMutation = useMutation({
    mutationFn: ({ id, form }: { id: string; form: GoogleListingFormState }) => updateGoogleListing(id, form),
    onSuccess: () => {
      toast({ title: "Google Shopping details saved", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["listings"] });
      setGoogleEditTarget(null);
    },
    onError: (err: Error) => toast({ title: err.message, tone: "danger" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteListing(id),
    onSuccess: () => {
      toast({ title: "Listing deleted", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["listings"] });
    },
    onError: (err: Error) => toast({ title: err.message, tone: "danger" }),
  });

  // "List on <channel>" for a channel this product isn't on yet — Google is
  // a one-click toggle (createGoogleListing also queues the first sync
  // server-side); eBay needs its full create form, so that one navigates
  // instead of mutating here (matches ProductPickerModal's own flow below).
  const listOnGoogleMutation = useMutation({
    mutationFn: (productId: string) => createGoogleListing(productId, null, GOOGLE_LISTING_FORM_INITIAL),
    onSuccess: () => {
      toast({ title: "Queued for Google Shopping sync", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["listings"] });
    },
    onError: (err: Error) => toast({ title: err.message, tone: "danger" }),
  });

  function handleProductSelected(product: Product) {
    setPickerOpen(false);
    navigate(`/listings/new?product=${product._id}&productSlug=${product.slug}`);
  }

  function openEdit(group: ProductListingGroup, listing: GroupedListingSummary) {
    // eBay's rich form lives at /listings/:id/edit; Google's "lightweight
    // toggle" listing has no equivalent page — it edits via a small inline
    // modal instead. The grouped view's own listing summary doesn't carry
    // Google's gtin/mpn/condition/etc. (kept out of the aggregation so this
    // page doesn't have to project every platform's every field for every
    // row — see types/marketplace.ts#GroupedListingSummary), so those are
    // fetched on demand, the same way the eBay resave-before-push above
    // already fetches the full listing on demand too.
    if (listing.platform === "google") {
      getListing(listing._id).then(({ data: full }) => {
        if (full.platform === "google") setGoogleEditTarget(full);
      });
      return;
    }
    navigate(`/listings/${listing._id}/edit`);
  }

  function listOnChannel(group: ProductListingGroup, targetPlatform: string) {
    if (!group.product) return;
    if (targetPlatform === "google") {
      listOnGoogleMutation.mutate(group.product._id);
    } else {
      navigate(`/listings/new?product=${group.product._id}&productSlug=${group.product.slug}`);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Listings"
        description={
          total > 0
            ? `${total} product${total !== 1 ? "s" : ""} listed across your channels`
            : "Manage your channel listings"
        }
      >
        <Button variant="primary" size="md" className="gap-2" onClick={() => setPickerOpen(true)}>
          <Plus className="h-4 w-4" />
          New Listing
        </Button>
      </PageHeader>

      <Card>
        {/* Toolbar */}
        <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg/40 pointer-events-none" />
            <Input
              placeholder="Search listings…"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex items-center gap-3">
            {isFetching && !isLoading && (
              <span className="text-xs text-fg/40">Updating…</span>
            )}
            <FilterSelect options={PLATFORM_FILTERS} value={platform} onChange={setPlatform} />
            <FilterSelect options={SYNC_STATUS_FILTERS} value={syncStatus} onChange={setSyncStatus} />
          </div>
        </div>

        {/* Table */}
        {isLoading ? (
          <LoadingSkeleton />
        ) : groups.length === 0 ? (
          <EmptyState onNew={() => setPickerOpen(true)} />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-180">
              <TableHeader>
                <TableRow>
                  <StickyTableHead
                    size={52}
                    width={productColWidth ?? undefined}
                    onResize={setProductColWidth}
                  >
                    Product
                  </StickyTableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead>Last Synced</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => {
                  const productId = group.product?._id ?? "";
                  const isExpanded = expandedIds.has(productId);
                  const listedPlatforms = new Set(group.listings.map((l) => l.platform));
                  const latestSyncedAt = group.listings
                    .map((l) => l.synced_at)
                    .filter((d): d is string => !!d)
                    .sort()
                    .at(-1);

                  return (
                    <FragmentRow key={productId || group.listings[0]?._id}>
                      <TableRow className="cursor-pointer" onClick={() => toggleExpanded(productId)}>
                        <StickyTableCell
                          size={52}
                          width={productColWidth ?? undefined}
                          onResize={setProductColWidth}
                          className="truncate font-medium text-fg"
                        >
                          <span className="flex items-center gap-1.5">
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg/40" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg/40" />
                            )}
                            {group.product?.title ?? "—"}
                          </span>
                        </StickyTableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1.5">
                            {AVAILABLE_PLATFORMS.map((p) => {
                              const listing = group.listings.find((l) => l.platform === p);
                              return listing ? (
                                <SyncBadge key={p} status={listing.sync_status} label={PLATFORM_LABEL[p] ?? p} />
                              ) : (
                                <Badge key={p} variant="muted" className="opacity-50">
                                  {PLATFORM_LABEL[p] ?? p}: not listed
                                </Badge>
                              );
                            })}
                          </div>
                        </TableCell>
                        <TableCell className="text-fg/60">
                          {latestSyncedAt ? new Date(latestSyncedAt).toLocaleDateString("en-AU") : "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs text-fg/40" onClick={(e) => e.stopPropagation()}>
                          {group.listings.length} channel{group.listings.length !== 1 ? "s" : ""}
                        </TableCell>
                      </TableRow>

                      {isExpanded && (
                        <TableRow className="bg-bg-2/50 hover:bg-bg-2/50">
                          <TableCell colSpan={4} className="p-0">
                            <div className="divide-y divide-border/60 px-5 py-2">
                              {group.listings.map((listing) => (
                                <div key={listing._id} className="flex items-center gap-4 py-2.5">
                                  <Badge variant="outline" className="w-fit shrink-0">
                                    {PLATFORM_LABEL[listing.platform] ?? listing.platform}
                                  </Badge>
                                  <span className="w-32 shrink-0 truncate text-xs text-fg/60">
                                    {(listing.platform === "ebay" ? listing.store_sku : null) || group.product?.sku || "—"}
                                  </span>
                                  <SyncBadge status={listing.sync_status} />
                                  <span className="w-24 shrink-0 text-xs text-fg/60">
                                    {listing.synced_at ? new Date(listing.synced_at).toLocaleDateString("en-AU") : "—"}
                                  </span>
                                  <div className="ml-auto">
                                    <ListingRowActionsMenu
                                      platform={listing.platform}
                                      onPush={() => pushMutation.mutate({ group, listing })}
                                      pushDisabled={pushMutation.isPending}
                                      onEdit={() => openEdit(group, listing)}
                                      onDelete={() => setDeleteTarget({ group, listing })}
                                      externalUrl={listing.ebay_item_url}
                                    />
                                  </div>
                                </div>
                              ))}

                              {AVAILABLE_PLATFORMS.filter((p) => !listedPlatforms.has(p as MarketplacePlatform)).map(
                                (p) => (
                                  <div key={p} className="flex items-center gap-4 py-2.5">
                                    <Badge variant="muted" className="w-fit shrink-0 opacity-60">
                                      {PLATFORM_LABEL[p] ?? p}
                                    </Badge>
                                    <span className="text-xs text-fg/40">Not listed</span>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="ml-auto gap-1.5"
                                      disabled={listOnGoogleMutation.isPending}
                                      onClick={() => listOnChannel(group, p)}
                                    >
                                      <Plus className="h-3.5 w-3.5" />
                                      List on {PLATFORM_LABEL[p] ?? p}
                                    </Button>
                                  </div>
                                ),
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </FragmentRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={total}
          itemsPerPage={limit}
          onLimitChange={setLimit}
          isLoading={isFetching}
          onPageChange={setPage}
        />
      </Card>

      <ProductPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleProductSelected}
      />

      <Modal
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <ModalContent className="max-w-sm">
          <ModalHeader>
            <ModalTitle>Delete listing?</ModalTitle>
            <ModalDescription>
              {deleteTarget && (
                <>
                  <span className="font-medium text-fg">{deleteListingName}</span> will be
                  permanently removed from {PLATFORM_LABEL[deleteTarget.listing.platform] ?? deleteTarget.listing.platform}.
                  {deleteListingIsLive && (
                    <span className="mt-1 block text-amber-500">
                      This listing is live on{" "}
                      {PLATFORM_LABEL[deleteTarget.listing.platform] ?? deleteTarget.listing.platform} and will also
                      be withdrawn.
                    </span>
                  )}
                </>
              )}
            </ModalDescription>
          </ModalHeader>
          <ModalFooter>
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              className="rounded-xs border border-border bg-bg px-4 py-2 text-sm text-fg transition-colors hover:bg-bg-2"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (!deleteTarget) return;
                deleteMutation.mutate(deleteTarget.listing._id, {
                  onSuccess: () => setDeleteTarget(null),
                });
              }}
              className="rounded-xs bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90 disabled:opacity-50"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <GoogleListingEditModal
        listing={googleEditTarget}
        open={!!googleEditTarget}
        onClose={() => setGoogleEditTarget(null)}
        onSave={(form) => {
          if (googleEditTarget) googleUpdateMutation.mutate({ id: googleEditTarget._id, form });
        }}
        saving={googleUpdateMutation.isPending}
      />
    </div>
  );
}

// React requires a single element/Fragment per array item — a plain <>
// alias so the two-TableRow-per-product structure above reads cleanly.
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// ── Skeleton & empty state ────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-3.5">
          <div className="h-4 w-40 animate-pulse rounded bg-bg-2" />
          <div className="h-5 w-14 animate-pulse rounded-full bg-bg-2" />
          <div className="h-4 w-24 animate-pulse rounded bg-bg-2" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-bg-2" />
          <div className="h-4 w-20 animate-pulse rounded bg-bg-2" />
          <div className="ml-auto flex gap-2">
            <div className="h-7 w-7 animate-pulse rounded bg-bg-2" />
            <div className="h-7 w-7 animate-pulse rounded bg-bg-2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-xs border border-border bg-bg-2">
        <Cloud className="h-8 w-8 text-fg/30" />
      </div>
      <div>
        <p className="font-medium text-fg">No listings yet</p>
        <p className="mt-1 text-sm text-fg/50">
          Create your first listing to start selling on eBay.
        </p>
      </div>
      <Button variant="primary" size="sm" className="mt-1 gap-1.5" onClick={onNew}>
        <Plus className="h-3.5 w-3.5" />
        New Listing
      </Button>
    </div>
  );
}
