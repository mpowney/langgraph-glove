import { useState, useCallback } from "react";
import type { ConversationSummary, BrowserMessage } from "../types";

type LoadingState = "idle" | "loading" | "error";

// In production the API is on the same origin. In dev, VITE_WS_URL points to
// the backend (e.g. ws://localhost:8080) and Vite proxies /api/ there, so we
// can always use a relative path.
const API_BASE = "";

export function useConversationBrowser() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<BrowserMessage[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [listState, setListState] = useState<LoadingState>("idle");
  const [messagesState, setMessagesState] = useState<LoadingState>("idle");
  const [listError, setListError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
    setListState("loading");
    setListError(null);
    try {
      const res = await fetch(`${API_BASE}/api/conversations`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ConversationSummary[];
      setConversations(data);
      setListState("idle");
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setListState("error");
    }
  }, []);

  const loadMessages = useCallback(async (threadId: string) => {
    setSelectedThreadId(threadId);
    setMessagesState("loading");
    setMessagesError(null);
    setMessages([]);
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(threadId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BrowserMessage[];
      setMessages(data);
      setMessagesState("idle");
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : String(err));
      setMessagesState("error");
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedThreadId(null);
    setMessages([]);
    setMessagesState("idle");
    setMessagesError(null);
  }, []);

  return {
    conversations,
    messages,
    selectedThreadId,
    listState,
    messagesState,
    listError,
    messagesError,
    loadConversations,
    loadMessages,
    clearSelection,
  };
}
