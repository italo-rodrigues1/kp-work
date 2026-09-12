import { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import type { Message } from "../types/chat";
import {
  createWsSendMessagePayload,
  requireSuccessfulWsAck,
  type WsAttachmentPayload,
  type WsAudioPayload,
  type WsSendAck,
} from "./webSocketChatCore";

export type {
  WsAttachmentPayload,
  WsAudioPayload,
  WsSendAck,
} from "./webSocketChatCore";

interface StreamChunkPayload {
  workspaceId: string;
  threadId: string;
  chunk: string;
  accumulated: string;
  isDone: boolean;
}

interface StreamCompletePayload {
  workspaceId: string;
  threadId: string;
  content: string;
  model: string;
  timestamp: string;
  message?: {
    id?: string;
    content?: string;
    model?: string;
    createdAt?: string;
  };
}

interface TypingStatusPayload {
  workspaceId: string;
  threadId: string;
  isTyping: boolean;
}

export type WsSendResult =
  | { status: "acknowledged"; ack: Extract<WsSendAck, { ok: true }> }
  | { status: "offline" };

interface UseWebSocketChatOptions {
  activeWorkspaceId: string;
  activeThreadId: string;
  onMessageChunk?: (
    workspaceId: string,
    threadId: string,
    chunk: string,
    accumulated: string,
  ) => void;
  onMessageComplete?: (
    workspaceId: string,
    threadId: string,
    message: Message,
  ) => void;
  onTypingStatus?: (
    workspaceId: string,
    threadId: string,
    isTyping: boolean,
  ) => void;
}

function formatTimestamp(value?: string): string {
  if (!value) {
    return new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function useWebSocketChat({
  activeWorkspaceId,
  activeThreadId,
  onMessageChunk,
  onMessageComplete,
  onTypingStatus,
}: UseWebSocketChatOptions) {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const socketRef = useRef<Socket | null>(null);
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;

  useEffect(() => {
    const serverUrl = import.meta.env.VITE_WS_URL || "http://localhost:3001";
    const socket = io(serverUrl, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("WebSocket connected:", socket.id);
      setIsConnected(true);
    });

    socket.on("disconnect", () => {
      console.log("WebSocket disconnected");
      setIsConnected(false);
    });

    socket.on("connect_error", (err) => {
      console.warn("WebSocket connection error:", err);
      setIsConnected(false);
    });

    socket.on("message_chunk", (data: StreamChunkPayload) => {
      if (data.workspaceId === activeWorkspaceIdRef.current && onMessageChunk) {
        onMessageChunk(
          data.workspaceId,
          data.threadId,
          data.chunk,
          data.accumulated,
        );
      }
    });

    socket.on("message_complete", (data: StreamCompletePayload) => {
      if (
        data.workspaceId === activeWorkspaceIdRef.current &&
        onMessageComplete
      ) {
        const rawMessage = data.message;
        const rawTimestamp = rawMessage?.createdAt || data.timestamp;
        onMessageComplete(data.workspaceId, data.threadId, {
          id:
            rawMessage?.id ||
            `assistant-${data.workspaceId}-${data.threadId}-${rawTimestamp}`,
          sender: "assistant",
          content: rawMessage?.content ?? data.content ?? "",
          model: rawMessage?.model || data.model,
          timestamp: formatTimestamp(rawTimestamp),
          isStreaming: false,
        });
      }
    });

    socket.on("typing_status", (data: TypingStatusPayload) => {
      if (data.workspaceId === activeWorkspaceIdRef.current && onTypingStatus) {
        onTypingStatus(data.workspaceId, data.threadId, data.isTyping);
      }
    });

    return () => {
      socket.disconnect();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [onMessageChunk, onMessageComplete, onTypingStatus]);

  // Join only the active workspace/thread room and leave it on every switch.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !isConnected || !activeWorkspaceId || !activeThreadId) {
      return;
    }

    const room = {
      workspaceId: activeWorkspaceId,
      threadId: activeThreadId,
    };
    socket.emit("join_thread", room);

    return () => {
      socket.emit("leave_thread", room);
    };
  }, [activeWorkspaceId, activeThreadId, isConnected]);

  const sendWebSocketMessage = useCallback(
    (
      threadId: string,
      message: string,
      model: string,
      attachments?: WsAttachmentPayload[],
      audio?: WsAudioPayload,
    ): Promise<WsSendResult> => {
      const socket = socketRef.current;
      if (!socket || !socket.connected || !isConnected) {
        return Promise.resolve({ status: "offline" });
      }
      const workspaceId = activeWorkspaceId;

      return new Promise<WsSendResult>((resolve, reject) => {
        socket.timeout(15_000).emit(
          "send_message",
          createWsSendMessagePayload(
            workspaceId,
            threadId,
            message,
            model,
            attachments,
            audio,
          ),
          (timeoutError: Error | null, ack?: WsSendAck) => {
            if (timeoutError) {
              reject(
                new Error(
                  "O servidor não confirmou a mensagem enviada por WebSocket.",
                ),
              );
              return;
            }
            try {
              resolve({
                status: "acknowledged",
                ack: requireSuccessfulWsAck(ack, workspaceId, threadId),
              });
            } catch (error) {
              reject(error);
              return;
            }
          },
        );
      });
    },
    [activeWorkspaceId, isConnected],
  );

  return {
    isConnected,
    sendWebSocketMessage,
  };
}
