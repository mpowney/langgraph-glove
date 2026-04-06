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

function buildWsUrl(authToken?: string): string {
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const base = envUrl ?? (() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}`;
  })();
  if (!authToken) return base;
  const url = new URL(base);
  url.searchParams.set("token", authToken);
  return url.toString();
}

export function useWebSocket(
  conversationId: string,
  personalToken?: string,
  privilegeGrantId?: string,
  authToken?: string,
) {
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  // Whether the last message in the list is currently streaming
  const streamingIdRef = useRef<string | null>(null);
  // Refs so ws.onopen always sees the latest token values without needing them
  // in the WebSocket effect's dependency array.
  const personalTokenRef = useRef(personalToken);
  const privilegeGrantIdRef = useRef(privilegeGrantId);
  // Track last-sent token values so we can send explicit null only on clear.
  const lastSyncedPersonalTokenRef = useRef<string | undefined>(personalToken);
  const lastSyncedPrivilegeGrantIdRef = useRef<string | undefined>(privilegeGrantId);
  personalTokenRef.current = personalToken;
  privilegeGrantIdRef.current = privilegeGrantId;

  useEffect(() => {
    // `active` lets cleanup signal that this effect instance has been torn
    // down. React StrictMode unmounts and remounts in dev, so the cleanup can
    // run while the socket is still CONNECTING. Calling ws.close() at that
    // point triggers a browser warning ("WebSocket is closed before the
    // connection is established") and also fires onclose, which would append
    // a spurious disconnect message to the chat. Instead we defer the close
    // until onopen if the socket hasn't connected yet.
    let active = true;
    const ws = new WebSocket(buildWsUrl(authToken));
    wsRef.current = ws;

    ws.onopen = () => {
      if (!active) {
        // Cleanup already ran while we were connecting — close now that it's safe.
        ws.close();
        return;
      }
      setStatus("connected");
      // Proactively register any active tokens with the server-side conversation
      // context so they are available before the first message is sent, and so
      // that switching to an existing conversation immediately restores them.
      const pt = personalTokenRef.current;
      const pg = privilegeGrantIdRef.current;
      if (pt !== undefined || pg !== undefined) {
        const contextFrame: ClientMessage = {
          type: "context",
          conversationId,
          ...(pt !== undefined ? { personalToken: pt } : {}),
          ...(pg !== undefined ? { privilegeGrantId: pg } : {}),
        };
        ws.send(JSON.stringify(contextFrame));
      }
      lastSyncedPersonalTokenRef.current = pt;
      lastSyncedPrivilegeGrantIdRef.current = pg;
    };

    ws.onmessage = ({ data }: MessageEvent<string>) => {
      const receivedAt = new Date().toISOString();
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
              (message) => ({
                ...message,
                content: message.content + msg.text,
                checkpoint: msg.checkpoint ?? message.checkpoint,
              }),
            );
          }
          // Start a new streaming entry
          return [
            ...prev,
            {
              id: streamId,
              conversationId: msg.conversationId,
              role,
              content: msg.text,
              isStreaming: true,
              receivedAt,
              checkpoint: msg.checkpoint,
            },
          ];
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
            receivedAt,
            checkpoint: msg.checkpoint,
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
              (message) => ({
                ...message,
                isStreaming: false,
                checkpoint: msg.checkpoint ?? message.checkpoint,
              }),
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
            receivedAt,
            checkpoint: msg.checkpoint,
            ...(msg.toolEventMetadata ? { toolEventMetadata: msg.toolEventMetadata } : {}),
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
            role: "error",
            content: msg.message,
            isStreaming: false,
            receivedAt,
            checkpoint: msg.checkpoint,
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
          receivedAt: new Date().toISOString(),
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
  }, [conversationId, authToken]);

  // When tokens change on an already-open socket, push a context frame so the
  // server-side conversation context stays in sync without waiting for the next
  // message. Fires after connection changes too, but the readyState guard
  // makes those a no-op (onopen handles the post-connect send instead).
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const contextFrame: ClientMessage = {
      type: "context",
      conversationId,
    };

    let shouldSend = false;

    if (personalToken !== undefined) {
      contextFrame.personalToken = personalToken;
      shouldSend = true;
    } else if (lastSyncedPersonalTokenRef.current !== undefined) {
      contextFrame.personalToken = null;
      shouldSend = true;
    }

    if (privilegeGrantId !== undefined) {
      contextFrame.privilegeGrantId = privilegeGrantId;
      shouldSend = true;
    } else if (lastSyncedPrivilegeGrantIdRef.current !== undefined) {
      contextFrame.privilegeGrantId = null;
      shouldSend = true;
    }

    if (shouldSend) {
      ws.send(JSON.stringify(contextFrame));
    }

    lastSyncedPersonalTokenRef.current = personalToken;
    lastSyncedPrivilegeGrantIdRef.current = privilegeGrantId;
  }, [conversationId, personalToken, privilegeGrantId]);

  const sendMessage = useCallback(
    (text: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const userEntry: ChatEntry = {
        id: crypto.randomUUID(),
        conversationId,
        role: "user",
        content: text,
        receivedAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userEntry]);
      const payload: ClientMessage = {
        type: "message",
        text,
        conversationId,
        ...(personalToken !== undefined ? { personalToken } : {}),
        ...(privilegeGrantId !== undefined ? { privilegeGrantId } : {}),
      };
      ws.send(JSON.stringify(payload));
    },
    [conversationId, personalToken, privilegeGrantId],
  );

  return { messages, sendMessage, status, myConversationId: conversationId };
}
