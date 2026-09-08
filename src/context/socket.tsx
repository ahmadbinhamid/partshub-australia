import { useEffect } from "react";
import { io } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { getToken } from "@/lib/api/client";
import { useAuth } from "@/context/auth";
import { useToast } from "@/context/toast";
import type { NotificationData } from "@/types/notification";

// Socket.IO connects to the bare server origin, not the REST /api/v1 base
// path — VITE_API_URL is the REST base, so strip it down to just the origin.
function wsOrigin() {
  const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:7000/api/v1";
  return new URL(apiUrl).origin;
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
