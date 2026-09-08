import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/ActionsMenu";
import { getNotifications, markNotificationRead, markAllNotificationsRead } from "@/lib/api/notifications";
import { formatCurrencyFromCents } from "@/utils/format";
import type { AppNotification } from "@/types/notification";

// The socket push (context/socket.tsx) is the primary delivery mechanism —
// this refetchInterval is only a defensive fallback if that connection
// drops, same honesty-about-polling spirit as DashboardPage.tsx's own
// ACTIVITY_REFETCH_MS comment.
const FALLBACK_REFETCH_MS = 60_000;

function timeAgo(iso: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function NotificationBell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["notifications", { page: 1, limit: 10 }],
    queryFn: () => getNotifications({ page: 1, limit: 10 }),
    refetchInterval: FALLBACK_REFETCH_MS,
  });

  const items = data?.data.items ?? [];
  const unreadCount = data?.data.unread_count ?? 0;

  async function handleSelect(notification: AppNotification) {
    if (!notification.read_at) {
      // Optimistic — the panel closes immediately on click, so there's no
      // window where a stale "unread" state would visibly linger.
      queryClient.setQueryData(["notifications", { page: 1, limit: 10 }], (prev: typeof data) =>
        prev
          ? {
              ...prev,
              data: {
                ...prev.data,
                unread_count: Math.max(0, prev.data.unread_count - 1),
                items: prev.data.items.map((n) =>
                  n._id === notification._id ? { ...n, read_at: new Date().toISOString() } : n,
                ),
              },
            }
          : prev,
      );
      markNotificationRead(notification._id).catch(() => {
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
      });
    }
    navigate(`/orders/${notification.data.order_id}`);
  }

  async function handleMarkAllRead() {
    queryClient.setQueryData(["notifications", { page: 1, limit: 10 }], (prev: typeof data) =>
      prev
        ? {
            ...prev,
            data: {
              ...prev.data,
              unread_count: 0,
              items: prev.data.items.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })),
            },
          }
        : prev,
    );
    try {
      await markAllNotificationsRead();
    } finally {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 shrink-0"
          aria-label="Notifications"
          title="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-fg">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[92vw]">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {unreadCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleMarkAllRead}
              className="h-auto px-1.5 py-0.5 text-xs font-medium text-accent hover:underline"
            >
              Mark all read
            </Button>
          )}
        </div>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-fg/45">No notifications yet</div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {items.map((n) => (
              <DropdownMenuItem
                key={n._id}
                onSelect={() => handleSelect(n)}
                className="flex-col items-start gap-0.5 whitespace-normal py-2.5"
              >
                <div className="flex w-full items-start gap-2">
                  {!n.read_at && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{n.title}</div>
                    <div className="text-xs text-fg/60">
                      {n.message} · {formatCurrencyFromCents(n.data.total)}
                    </div>
                    <div className="mt-0.5 text-[11px] text-fg/40">{timeAgo(n.created_at)}</div>
                  </div>
                </div>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
