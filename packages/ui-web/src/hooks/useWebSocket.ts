import { useState, useEffect, useCallback, useRef } from "react";
import type { ChatEntry, ClientMessage, ConnectionStatus, ServerMessage } from "../types";
import { createUuid } from "../uuid";

const RECONNECT_INITIAL_DELAY_MS = 5_000;
const RECONNECT_BACKOFF_MULTIPLIER = 1.5;
const RECONNECT_MAX_DELAY_MS = 30_000;

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

function mergeContentItems(
  first: ChatEntry["contentItems"],
  second: ChatEntry["contentItems"],
): ChatEntry["contentItems"] {
  const merged = [...(first ?? []), ...(second ?? [])];
  if (merged.length === 0) return undefined;
  const unique = new Map<string, NonNullable<ChatEntry["contentItems"]>[number]>();
  for (const item of merged) {
    unique.set(item.contentRef, item);
  }
  return [...unique.values()];
}

function mergeReferences(
  first: ChatEntry["references"],
  second: ChatEntry["references"],
): ChatEntry["references"] {
  const merged = [...(first ?? []), ...(second ?? [])];
  if (merged.length === 0) return undefined;
  const unique = new Map<string, NonNullable<ChatEntry["references"]>[number]>();
  for (const item of merged) {
    const key = item.url.trim();
    if (!key) continue;
    unique.set(key, item);
  }
  return [...unique.values()];
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
  const [conversationTitles, setConversationTitles] = useState<Map<string, string>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const disconnectNoticeShownRef = useRef(false);
  // Streaming state per conversationId: maps each conversation to its active
  // streaming entry ({ id, sourceKey }).  Keying by conversationId prevents a
  // chunk or done frame for conversation B from corrupting the streaming state
  // of conversation A when the WebSocket services multiple conversations.
  const streamingRef = useRef<Map<string, { id: string; sourceKey: string }>>(new Map());
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

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (!active) return;
      const attempt = reconnectAttemptRef.current;
      const delayMs = Math.min(
        RECONNECT_MAX_DELAY_MS,
        Math.round(RECONNECT_INITIAL_DELAY_MS * (RECONNECT_BACKOFF_MULTIPLIER ** attempt)),
      );
      reconnectAttemptRef.current = attempt + 1;
      setStatus("connecting");
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (!active) return;
      setStatus("connecting");
      const ws = new WebSocket(buildWsUrl(authToken));
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        if (!active) {
          // Cleanup already ran while we were connecting — close now that it's safe.
          ws.close();
          return;
        }
        reconnectAttemptRef.current = 0;
        disconnectNoticeShownRef.current = false;
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
        if (wsRef.current !== ws) return;
        const receivedAt = new Date().toISOString();
        let msg: ServerMessage;
        try {
          msg = JSON.parse(data) as ServerMessage;
        } catch {
          return;
        }

      if (msg.type === "chunk") {
        const role = msg.role ?? "agent";
        const streamSource = msg.streamSource ?? "main";
        const sourceKey = streamSource === "sub-agent"
          ? `sub-agent:${msg.streamAgentKey ?? "unknown"}`
          : "main";
        const convId = msg.conversationId;
        const currentStreaming = streamingRef.current.get(convId) ?? null;

        if (!currentStreaming || currentStreaming.sourceKey !== sourceKey) {
          const nextStream = { id: createUuid(), sourceKey };
          streamingRef.current.set(convId, nextStream);

          setMessages((prev) => {
            const withPreviousStopped = currentStreaming
              ? updateMessageToEnd(
                prev,
                currentStreaming.id,
                (message) => ({ ...message, isStreaming: false }),
              )
              : prev;

            return [
              ...withPreviousStopped,
              {
                id: nextStream.id,
                conversationId: msg.conversationId,
                role,
                content: msg.text,
                isStreaming: true,
                streamSource,
                ...(msg.streamAgentKey ? { streamAgentKey: msg.streamAgentKey } : {}),
                receivedAt,
                checkpoint: msg.checkpoint,
                ...(msg.references ? { references: msg.references } : {}),
              },
            ];
          });
          return;
        }

        setMessages((prev) => {
          if (prev.some((e) => e.id === currentStreaming.id)) {
            // Append to the existing streaming entry
            return updateMessageToEnd(
              prev,
              currentStreaming.id,
              (message) => ({
                ...message,
                content: message.content + msg.text,
                checkpoint: msg.checkpoint ?? message.checkpoint,
                references: mergeReferences(message.references, msg.references),
              }),
            );
          }
          // If the entry was dropped for any reason, recreate it.
          return [
            ...prev,
            {
              id: currentStreaming.id,
              conversationId: msg.conversationId,
              role,
              content: msg.text,
              isStreaming: true,
              streamSource,
              ...(msg.streamAgentKey ? { streamAgentKey: msg.streamAgentKey } : {}),
              receivedAt,
              checkpoint: msg.checkpoint,
              ...(msg.references ? { references: msg.references } : {}),
            },
          ];
        });
      } else if (msg.type === "prompt") {
        setMessages((prev) => [
          ...prev,
          {
            id: createUuid(),
            conversationId: msg.conversationId,
            role: "prompt",
            content: msg.text,
            isStreaming: false,
            receivedAt,
            checkpoint: msg.checkpoint,
          },
        ]);
      } else if (msg.type === "done") {
        const convStreaming = streamingRef.current.get(msg.conversationId);
        if (convStreaming) {
          const finishedId = convStreaming.id;
          streamingRef.current.delete(msg.conversationId);
          setMessages((prev) =>
            updateMessageToEnd(
              prev,
              finishedId,
              (message) => ({
                ...message,
                isStreaming: false,
                checkpoint: msg.checkpoint ?? message.checkpoint,
                contentItems: mergeContentItems(message.contentItems, msg.contentItems),
                references: mergeReferences(message.references, msg.references),
              }),
            ),
          );
        }
      } else if (msg.type === "tool_event") {
        setMessages((prev) => [
          ...prev,
          {
            id: createUuid(),
            conversationId: msg.conversationId,
            role: msg.role,
            content: msg.text,
            isStreaming: false,
            receivedAt,
            checkpoint: msg.checkpoint,
            ...(msg.toolEventMetadata ? { toolEventMetadata: msg.toolEventMetadata } : {}),
            ...(msg.toolName ? { toolName: msg.toolName } : {}),
            ...(msg.contentItems ? { contentItems: msg.contentItems } : {}),
            ...(msg.references ? { references: msg.references } : {}),
          },
        ]);
      } else if (msg.type === "error") {
        // Remove any in-progress streaming entry and add an error message
        const convStreaming = streamingRef.current.get(msg.conversationId);
        if (convStreaming) {
          const errId = convStreaming.id;
          streamingRef.current.delete(msg.conversationId);
          setMessages((prev) => prev.filter((e) => e.id !== errId));
        }
        setMessages((prev) => [
          ...prev,
          {
            id: createUuid(),
            conversationId: msg.conversationId,
            role: "error",
            content: msg.message,
            isStreaming: false,
            receivedAt,
            checkpoint: msg.checkpoint,
          },
        ]);
      } else if (msg.type === "conversation_metadata") {
        if (msg.metadata.title) {
          setConversationTitles((prev) => {
            const next = new Map(prev);
            next.set(msg.conversationId, msg.metadata.title!);
            return next;
          });
        }
        setMessages((prev) => [
          ...prev,
          {
            id: createUuid(),
            conversationId: msg.conversationId,
            role: "conversation-metadata" as const,
            content: JSON.stringify(msg.metadata),
            isStreaming: false,
            receivedAt,
          },
        ]);
      }
      };

      ws.onerror = () => {
        if (!active) return;
        if (wsRef.current !== ws) return;
        setStatus("error");
      };

      ws.onclose = () => {
        // Ignore closes triggered by the StrictMode cleanup (active === false).
        // Those are intentional teardowns of the first effect instance; the real
        // connection is established by the second mount.
        if (!active) return;
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        setStatus("disconnected");
        if (streamingRef.current.size > 0) {
          const activeEntries = [...streamingRef.current.values()];
          streamingRef.current.clear();
          setMessages((prev) => {
            let updated = prev;
            for (const { id } of activeEntries) {
              updated = updateMessageToEnd(
                updated,
                id,
                (message) => ({ ...message, isStreaming: false }),
              );
            }
            return updated;
          });
        }
        if (!disconnectNoticeShownRef.current) {
          disconnectNoticeShownRef.current = true;
          setMessages((prev) => [
            ...prev,
            {
              id: createUuid(),
              conversationId,
              role: "agent",
              content: "⚠ Connection lost. Reconnecting automatically...",
              isStreaming: false,
              receivedAt: new Date().toISOString(),
            },
          ]);
        }
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      active = false;
      clearReconnectTimer();
      reconnectAttemptRef.current = 0;
      disconnectNoticeShownRef.current = false;
      const currentWs = wsRef.current;
      wsRef.current = null;
      // Only close directly if already connected; if still CONNECTING, onopen
      // will call ws.close() once it fires (see above). This avoids the
      // browser warning "WebSocket is closed before the connection is
      // established".
      if (currentWs?.readyState === WebSocket.OPEN) {
        currentWs.close();
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
        id: createUuid(),
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

  return { messages, sendMessage, status, myConversationId: conversationId, conversationTitles };
}
