import { useState, useEffect, useCallback, useRef } from "react";
import type { ChatEntry, ClientMessage, ConnectionStatus, ServerMessage } from "../types";

function updateMessageToEnd(
  messages: ChatEntry[],
  messageId: string,
  update: (message: ChatEntry) => ChatEntry,
): ChatEntry[] {
  const messageIndex = messages.findIndex((message) => message.id === messageId);
  if (messageIndex === -1) {
    return messages;
  }

  const updatedMessage = update(messages[messageIndex]);
  return [
    ...messages.slice(0, messageIndex),
    ...messages.slice(messageIndex + 1),
    updatedMessage,
  ];
}

function buildWsUrl(): string {
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (envUrl) return envUrl;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}

export function useWebSocket(conversationId: string) {
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  // Whether the last message in the list is currently streaming
  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    // `active` lets cleanup signal that this effect instance has been torn
    // down. React StrictMode unmounts and remounts in dev, so the cleanup can
    // run while the socket is still CONNECTING. Calling ws.close() at that
    // point triggers a browser warning ("WebSocket is closed before the
    // connection is established") and also fires onclose, which would append
    // a spurious disconnect message to the chat. Instead we defer the close
    // until onopen if the socket hasn't connected yet.
    let active = true;
    const ws = new WebSocket(buildWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      if (!active) {
        // Cleanup already ran while we were connecting — close now that it's safe.
        ws.close();
        return;
      }
      setStatus("connected");
    };

    ws.onmessage = ({ data }: MessageEvent<string>) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data) as ServerMessage;
      } catch {
        return;
      }

      if (msg.type === "chunk") {
        const role = msg.role ?? "agent";
        // Manage the ref outside the updater — state updaters must be pure
        // (no side effects). React StrictMode calls them twice with the same
        // prev snapshot; a side effect inside would corrupt the ref on the
        // second invocation, causing the new entry to silently disappear.
        if (!streamingIdRef.current) {
          streamingIdRef.current = crypto.randomUUID();
        }
        const streamId = streamingIdRef.current;
        setMessages((prev) => {
          if (prev.some((e) => e.id === streamId)) {
            // Append to the existing streaming entry
            return updateMessageToEnd(
              prev,
              streamId,
              (message) => ({ ...message, content: message.content + msg.text }),
            );
          }
          // Start a new streaming entry
          return [...prev, { id: streamId, conversationId: msg.conversationId, role, content: msg.text, isStreaming: true }];
        });
      } else if (msg.type === "prompt") {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            conversationId: msg.conversationId,
            role: "prompt",
            content: msg.text,
            isStreaming: false,
          },
        ]);
      } else if (msg.type === "done") {
        if (streamingIdRef.current) {
          const finishedId = streamingIdRef.current;
          streamingIdRef.current = null;
          setMessages((prev) =>
            updateMessageToEnd(
              prev,
              finishedId,
              (message) => ({ ...message, isStreaming: false }),
            ),
          );
        }
      } else if (msg.type === "tool_event") {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            conversationId: msg.conversationId,
            role: msg.role,
            content: msg.text,
            isStreaming: false,
          },
        ]);
      } else if (msg.type === "error") {
        // Remove any in-progress streaming entry and add an error message
        if (streamingIdRef.current) {
          const errId = streamingIdRef.current;
          streamingIdRef.current = null;
          setMessages((prev) => prev.filter((e) => e.id !== errId));
        }
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            conversationId: msg.conversationId,
            role: "agent",
            content: `⚠ ${msg.message}`,
            isStreaming: false,
          },
        ]);
      }
    };

    ws.onerror = () => { if (active) setStatus("error"); };

    ws.onclose = () => {
      // Ignore closes triggered by the StrictMode cleanup (active === false).
      // Those are intentional teardowns of the first effect instance; the real
      // connection is established by the second mount.
      if (!active) return;
      setStatus("disconnected");
      if (streamingIdRef.current) {
        const id = streamingIdRef.current;
        streamingIdRef.current = null;
        setMessages((prev) =>
          updateMessageToEnd(
            prev,
            id,
            (message) => ({ ...message, isStreaming: false }),
          ),
        );
      }
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          conversationId,
          role: "agent",
          content: "⚠ Connection closed. Refresh the page to reconnect.",
          isStreaming: false,
        },
      ]);
    };

    return () => {
      active = false;
      // Only close directly if already connected; if still CONNECTING, onopen
      // will call ws.close() once it fires (see above). This avoids the
      // browser warning "WebSocket is closed before the connection is
      // established".
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [conversationId]);

  const sendMessage = useCallback(
    (text: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const userEntry: ChatEntry = {
        id: crypto.randomUUID(),
        conversationId,
        role: "user",
        content: text,
      };
      setMessages((prev) => [...prev, userEntry]);
      const payload: ClientMessage = { type: "message", text, conversationId };
      ws.send(JSON.stringify(payload));
    },
    [conversationId],
  );

  return { messages, sendMessage, status, myConversationId: conversationId };
}
