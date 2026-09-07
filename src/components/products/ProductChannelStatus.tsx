import { cn } from "@/utils/cn";
import { LISTING_SYNC_STATUS_CONFIG } from "@/config/listingStatus";
import type { ChannelSummary } from "@/types/channel";
import type { AnyMarketplaceListing, GroupedListingSummary } from "@/types/marketplace";

// Extracted from ListingsPage.tsx's own per-product expand pattern so the
// Catalogue page's Products tab (channel status per product, collapsed dot
// row + expandable detail) and the Listings tab's grouped fallback don't
// each reimplement it. Takes `channels` from GET /channels (never a
// hardcoded platform list) so a newly-registered adapter shows up here
// automatically, with no changes to this component.

type ListingLike = Pick<AnyMarketplaceListing | GroupedListingSummary, "platform" | "sync_status" | "synced_at">;

// Collapsed summary row's dots are colored by STATUS (so several channels
// sharing a status visually group together at a glance) — this map is only
// for that row. The expanded detail panel below uses a different, per-
// CHANNEL-IDENTITY color instead (see CAT_DOT_COLORS) — deliberately not
// the same scheme, since its job is "which channel is this row", not "is
// this one healthy".
const DOT_COLOR: Record<string, string> = {
  synced: "bg-ok",
  pending: "bg-warn",
  out_of_stock: "bg-warn",
  price_locked: "bg-warn",
  error: "bg-danger",
  not_listed: "bg-fg/20",
};

// Status → plain text color (no pill/badge background) — the expanded
// detail panel shows status as bare colored text right next to "Not
// listed" (also bare text), so a real listing's status doesn't visually
// jump out with a pill background its unlisted neighbors don't have.
const STATUS_TEXT_COLOR: Record<string, string> = {
  synced: "text-ok",
  pending: "text-warn",
  out_of_stock: "text-warn",
  price_locked: "text-warn",
  error: "text-danger",
};

// Categorical palette (globals.css --cat-1..6) — identifies WHICH channel a
// detail row is for, cycling if there are ever more than 6 registered
// adapters. Never reuse the semantic ok/warn/danger tokens for this: those
// mean something (healthy/attention/broken), this is pure identity.
const CAT_DOT_COLORS = ["bg-cat-1", "bg-cat-2", "bg-cat-3", "bg-cat-4", "bg-cat-5", "bg-cat-6"];

// Collapsed row's "Channels" cell — a dot per registered channel (colored by
// that channel's listing status, dim if not listed) plus a short summary
// string, e.g. "2/6 live · 1 syncing".
export function ProductChannelDots({
  channels,
  listings,
}: {
  channels: ChannelSummary[];
  listings: ListingLike[];
}) {
  // Keyed by plain string, not MarketplacePlatform — channel.key comes from
  // the backend's dynamic adapter registry (any future platform), a wider
  // set than the frontend's closed MarketplacePlatform union.
  const byPlatform = new Map<string, ListingLike>(listings.map((l) => [l.platform, l]));
  const liveCount = channels.filter((c) => byPlatform.get(c.key)?.sync_status === "synced").length;
  const pendingCount = channels.filter((c) => byPlatform.get(c.key)?.sync_status === "pending").length;

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        {channels.map((channel) => {
          const listing = byPlatform.get(channel.key);
          const status = listing?.sync_status ?? "not_listed";
          return (
            <span
              key={channel.key}
              title={`${channel.name}: ${LISTING_SYNC_STATUS_CONFIG[status]?.label ?? status}`}
              className={cn("h-2 w-2 shrink-0 rounded-full", DOT_COLOR[status] ?? "bg-fg/20")}
            />
          );
        })}
      </div>
      <span className="whitespace-nowrap text-xs text-fg/50">
        {liveCount}/{channels.length} live{pendingCount > 0 ? ` · ${pendingCount} syncing` : ""}
      </span>
    </div>
  );
}

// Expanded detail panel — one row per registered channel, showing this
// product's real status on it (or "Ready to publish" if not listed yet),
// with a single primary action: "Open" (edit) for a listed channel, "List"
// (create) for one it isn't on yet. Push/retry/delete stay Listings-tab-only
// — this view is for browsing "is this product live where it should be",
// not day-to-day per-listing operations.
export function ProductChannelDetail({
  channels,
  listings,
  onOpen,
  onList,
}: {
  channels: ChannelSummary[];
  listings: ListingLike[];
  onOpen: (platform: string) => void;
  onList: (platform: string) => void;
}) {
  // Keyed by plain string, not MarketplacePlatform — channel.key comes from
  // the backend's dynamic adapter registry (any future platform), a wider
  // set than the frontend's closed MarketplacePlatform union.
  const byPlatform = new Map<string, ListingLike>(listings.map((l) => [l.platform, l]));

  return (
    <div className="divide-y divide-border/60">
      {channels.map((channel, index) => {
        const listing = byPlatform.get(channel.key);
        const isListed = !!listing;
        const statusLabel = listing ? (LISTING_SYNC_STATUS_CONFIG[listing.sync_status]?.label ?? listing.sync_status) : "Not listed";
        const statusColor = listing ? (STATUS_TEXT_COLOR[listing.sync_status] ?? "text-fg/70") : "text-fg/40";

        return (
          <div key={channel.key} className="flex items-center gap-4 py-2.5">
            <span className="flex w-36 shrink-0 items-center gap-2 truncate text-sm text-fg/80">
              <span
                className={cn("h-1.5 w-1.5 shrink-0 rounded-full", CAT_DOT_COLORS[index % CAT_DOT_COLORS.length])}
                aria-hidden="true"
              />
              <span className="truncate">{channel.name}</span>
            </span>
            <span className={cn("w-20 shrink-0 text-xs font-medium", statusColor)}>{statusLabel}</span>
            <span className="flex-1 truncate text-xs text-fg/45">
              {listing?.synced_at
                ? `Synced ${new Date(listing.synced_at).toLocaleDateString("en-AU")}`
                : isListed
                  ? "Queued for next sync"
                  : "Ready to publish"}
            </span>
            <button
              type="button"
              onClick={() => (isListed ? onOpen(channel.key) : onList(channel.key))}
              className={cn(
                "shrink-0 text-xs font-medium transition-colors",
                isListed ? "text-fg/60 hover:text-fg" : "text-accent hover:text-accent/80",
              )}
            >
              {isListed ? "Open →" : "List →"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
