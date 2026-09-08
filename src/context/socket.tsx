import { useEffect } from "react";
import { io } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { getToken } from "@/lib/api/client";
import { useAuth } from "@/context/auth";
import { useToast } from "@/context/toast";
import type { NotificationData } from "@/types/notification";

// Socket.IO connects to the bare server origin, not the REST /api/v1 base
// path — VITE_API_URL is the REST base, so strip it down to just the origin.
// VITE_API_URL can be a full absolute URL (local dev: http://localhost:7001/api/v1)
// OR a relative path (production, when the frontend and API share a domain
// behind a reverse proxy: /api/v1) — `new URL()` throws "Invalid URL" on a
// bare relative path with no base, which crashed the whole provider tree in
// production. Passing window.location.origin as the base makes both forms
// resolve correctly: an absolute apiUrl ignores the base entirely, a
// relative one resolves against it.
function wsOrigin() {
  const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:7000/api/v1";
  try {
    return new URL(apiUrl, window.location.origin).origin;
  } catch {
    // Last resort — never let a malformed env value crash the app; the
    // socket connection just won't work, same as if the server were down.
    return window.location.origin;
  }
}

interface NotificationPushPayload {
  type: string;
  title: string;
  message: string;
  data: NotificationData;
}

// Pushes a toast + invalidates the notifications query when the server-side
// dormant Socket.IO setup (server/src/services/websocket.service.js) emits
// "notification:new" — the bell/panel (NotificationBell.tsx) itself just
// reads from React Query, this only drives it live rather than waiting on
// its own refetchInterval fallback.
export function NotificationSocketProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isAuthenticated) return;

    const token = getToken();
    if (!token) return;

    const socket = io(wsOrigin(), { auth: { token } });

    socket.on("notification:new", (payload: NotificationPushPayload) => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      toast({ title: payload.title, description: payload.message, tone: "default" });
    });

    return () => {
      socket.disconnect();
    };
  }, [isAuthenticated, queryClient, toast]);

  return <>{children}</>;
}
