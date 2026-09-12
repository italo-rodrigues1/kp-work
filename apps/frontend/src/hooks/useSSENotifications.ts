import { useState, useEffect } from "react";

export interface SSENotification {
  id?: string;
  title?: string;
  message: string;
  timestamp: string;
  type: "status" | "notification" | "system" | "ping";
  workspaceId?: string;
  threadId?: string;
}

export function useSSENotifications(workspaceId: string) {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [lastNotification, setLastNotification] =
    useState<SSENotification | null>(null);
  const [notifications, setNotifications] = useState<SSENotification[]>([]);

  useEffect(() => {
    if (!workspaceId) return;

    setIsConnected(false);
    setLastNotification(null);
    setNotifications([]);

    let eventSource: EventSource | null = null;

    try {
      const baseUrl = import.meta.env.VITE_API_URL || "http://localhost:3001";
      const params = new URLSearchParams({ workspaceId });
      eventSource = new EventSource(`${baseUrl}/api/events/sse?${params}`);

      eventSource.onopen = () => {
        setIsConnected(true);
      };

      eventSource.onerror = (err) => {
        console.warn("SSE Connection error:", err);
        setIsConnected(false);
      };

      const handleEvent = (event: MessageEvent) => {
        try {
          const parsed = JSON.parse(event.data) as SSENotification;
          if (parsed.type === "ping") {
            setIsConnected(true);
            return;
          }
          setLastNotification(parsed);
          setNotifications((prev) => [parsed, ...prev.slice(0, 19)]);
        } catch (e) {
          console.error("Error parsing SSE event data:", e);
        }
      };

      eventSource.onmessage = handleEvent;
      eventSource.addEventListener("notification", handleEvent);
      eventSource.addEventListener("status", handleEvent);
      eventSource.addEventListener("system", handleEvent);
    } catch (error) {
      console.error("Failed to instantiate EventSource:", error);
      setIsConnected(false);
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [workspaceId]);

  return {
    isConnected,
    lastNotification,
    notifications,
  };
}
