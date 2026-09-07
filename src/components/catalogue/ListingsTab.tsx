import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/Table";
import { Pagination } from "@/components/ui/Pagination";
import { Modal, ModalContent, ModalHeader, ModalFooter, ModalTitle, ModalDescription } from "@/components/ui/Modal";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { SyncBadge } from "@/components/listings/SyncBadge";
import { ListingRowActionsMenu } from "@/components/listings/ListingRowActionsMenu";
import { GoogleListingEditModal } from "@/components/listings/GoogleListingEditModal";
import { DEFAULT_PAGE_SIZE } from "@/config/pagination";
import { PLATFORM_LABEL } from "@/config/marketplacePlatforms";
import { getListing, getListings, updateListing, pushListing, deleteListing } from "@/lib/api/listings";
import { updateGoogleListing } from "@/lib/api/googleListings";
import { listingToForm, getListingFallbackImageUrl } from "@/lib/marketplace/listingToForm";
import { useToast } from "@/context";
import type { ChannelSummary } from "@/types/channel";
import type { AnyMarketplaceListing, GoogleListing, GoogleListingFormState } from "@/types/marketplace";
import { Search, Cloud } from "lucide-react";

// NOTE: reverted to the app's standard dropdown-filter toolbar (matching
// the original ListingsPage.tsx exactly) instead of a sidebar + segmented
// triage control — per explicit feedback after the first pass. `platform`
// options are still sourced from `channels` (GET /channels), never a
// hardcoded list, so a newly-registered adapter appears here automatically.
const SYNC_STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Synced", value: "synced" },
  { label: "Pending", value: "pending" },
  { label: "Out of Stock", value: "out_of_stock" },
  { label: "Price Locked (On Sale)", value: "price_locked" },
  { label: "Error", value: "error" },
  { label: "Not listed", value: "not_listed" },
];

// Catalogue page's "Listings" tab — the flat, listing-centric view (every
// real MarketplaceListing row, one per row), as opposed to the Products
// tab's product-centric grouped view. Reuses the exact mutations
// ListingsPage.tsx already had (push/edit/delete) — only the presentation
// (flat table instead of grouped-by-product) is new; the filter toolbar
// itself is the app's standard pattern, unchanged in spirit from before.
export function ListingsTab({ channels }: { channels: ChannelSummary[] }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("search") ?? "";
  const platform = searchParams.get("l_platform") ?? "";
  const syncStatus = searchParams.get("l_sync_status") ?? "";
  const page = parseInt(searchParams.get("l_page") ?? "1", 10);
  const limit = parseInt(searchParams.get("l_limit") ?? String(DEFAULT_PAGE_SIZE), 10);

  const [inputValue, setInputValue] = useState(search);
  const [deleteTarget, setDeleteTarget] = useState<AnyMarketplaceListing | null>(null);
  const [googleEditTarget, setGoogleEditTarget] = useState<GoogleListing | null>(null);

  const PLATFORM_FILTERS = [
    { label: "All channels", value: "" },
    ...channels.map((c) => ({ label: c.name, value: c.key })),
  ];

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchParams((prev) => {
        const current = prev.get("search") ?? "";
        if (inputValue === current) return prev;
        const next = new URLSearchParams(prev);
        if (inputValue) next.set("search", inputValue);
        else next.delete("search");
        next.set("l_page", "1");
        return next;
      }, { replace: true });
    }, 400);
    return () => clearTimeout(timer);
  }, [inputValue, setSearchParams]);

  const setPlatform = useCallback(
    (val: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (val) next.set("l_platform", val);
        else next.delete("l_platform");
        next.set("l_page", "1");
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setSyncStatus = useCallback(
    (val: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (val) next.set("l_sync_status", val);
        else next.delete("l_sync_status");
        next.set("l_page", "1");
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setPage = useCallback(
    (p: number) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("l_page", String(p));
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const setLimit = useCallback(
    (l: number) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("l_limit", String(l));
        next.set("l_page", "1");
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["listings", "flat", { page, limit, platform, syncStatus, search }],
    queryFn: () =>
      getListings({
        page,
        limit,
        ...(platform ? { platform: platform as AnyMarketplaceListing["platform"] } : {}),
        ...(syncStatus ? { sync_status: syncStatus } : {}),
        ...(search ? { search } : {}),
      }),
  });

  const listings: AnyMarketplaceListing[] = data?.data?.items ?? [];
  const total = data?.data?.total ?? 0;
  const totalPages = data?.data?.totalPages ?? 1;

  const pushMutation = useMutation({
    mutationFn: async (listing: AnyMarketplaceListing) => {
      if (listing.platform === "ebay") {
        const { data: fresh } = await getListing(listing._id);
        if (fresh.platform === "ebay") {
          const vehicle = fresh.product !== null && typeof fresh.product === "object" ? fresh.product.vehicle ?? null : null;
          await updateListing(listing._id, listingToForm(fresh), vehicle, getListingFallbackImageUrl(fresh));
        }
      }
      await pushListing(listing._id);
    },
    onSuccess: (_data, listing) => {
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
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast({ title: err.message, tone: "danger" }),
  });

  function openEdit(listing: AnyMarketplaceListing) {
    if (listing.platform === "google") {
      getListing(listing._id)
        .then(({ data: full }) => {
          if (full.platform === "google") setGoogleEditTarget(full);
        })
        .catch((err: Error) => toast({ title: err.message, tone: "danger" }));
      return;
    }
    navigate(`/listings/${listing._id}/edit`);
  }

  const deleteListingName =
    deleteTarget && typeof deleteTarget.product === "object" && deleteTarget.product ? deleteTarget.product.title : "This listing";
  const deleteListingIsLive = !!deleteTarget?.external_listing_id;

  return (
    <div>
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg/40" />
            <Input
              placeholder="Search listings…"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-3">
            {isFetching && !isLoading && <span className="text-xs text-fg/40">Updating…</span>}
            <FilterSelect options={PLATFORM_FILTERS} value={platform} onChange={setPlatform} />
            <FilterSelect options={SYNC_STATUS_FILTERS} value={syncStatus} onChange={setSyncStatus} />
          </div>
        </div>

        {isLoading ? (
          <ListingsLoadingSkeleton />
        ) : listings.length === 0 ? (
          <ListingsEmptyState />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-180">
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Last Synced</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.map((listing) => {
                  const productTitle = typeof listing.product === "object" && listing.product ? listing.product.title : "—";
                  return (
                    <TableRow key={listing._id}>
                      <TableCell className="max-w-64 truncate font-medium text-fg">{productTitle}</TableCell>
                      <TableCell className="whitespace-nowrap text-fg/70">
                        {PLATFORM_LABEL[listing.platform] ?? listing.platform}
                      </TableCell>
                      <TableCell>
                        <SyncBadge status={listing.sync_status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-fg/60">
                        {listing.synced_at ? new Date(listing.synced_at).toLocaleDateString("en-AU") : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <ListingRowActionsMenu
                          platform={listing.platform}
                          onPush={() => pushMutation.mutate(listing)}
                          pushDisabled={pushMutation.isPending}
                          onEdit={() => openEdit(listing)}
                          onDelete={() => setDeleteTarget(listing)}
                          externalUrl={listing.ebay_item_url}
                        />
                      </TableCell>
                    </TableRow>
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

      <Modal open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <ModalContent className="max-w-sm">
          <ModalHeader>
            <ModalTitle>Delete listing?</ModalTitle>
            <ModalDescription>
              {deleteTarget && (
                <>
                  <span className="font-medium text-fg">{deleteListingName}</span> will be permanently removed from{" "}
                  {PLATFORM_LABEL[deleteTarget.platform] ?? deleteTarget.platform}.
                  {deleteListingIsLive && (
                    <span className="mt-1 block text-amber-500">
                      This listing is live on {PLATFORM_LABEL[deleteTarget.platform] ?? deleteTarget.platform} and will also be withdrawn.
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
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget._id)}
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

function ListingsLoadingSkeleton() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-3.5">
          <div className="h-4 w-40 animate-pulse rounded bg-bg-2" />
          <div className="h-4 w-16 animate-pulse rounded bg-bg-2" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-bg-2" />
          <div className="h-4 w-20 animate-pulse rounded bg-bg-2" />
          <div className="ml-auto h-7 w-7 animate-pulse rounded bg-bg-2" />
        </div>
      ))}
    </div>
  );
}

function ListingsEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-xs border border-border bg-bg-2">
        <Cloud className="h-8 w-8 text-fg/30" />
      </div>
      <div>
        <p className="font-medium text-fg">No listings match this filter</p>
        <p className="mt-1 text-sm text-fg/50">Try a different channel or status.</p>
      </div>
    </div>
  );
}
