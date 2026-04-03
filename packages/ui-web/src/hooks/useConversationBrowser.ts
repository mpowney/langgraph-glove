import { useState, useCallback } from "react";
import type { ConversationSummary, BrowserMessage } from "../types";

type LoadingState = "idle" | "loading" | "error";

export function useConversationBrowser(apiBaseUrl = "") {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<BrowserMessage[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [listState, setListState] = useState<LoadingState>("idle");
  const [messagesState, setMessagesState] = useState<LoadingState>("idle");
  const [listError, setListError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const authHeaders = (authToken?: string): Record<string, string> => {
    if (!authToken) return {};
    return { Authorization: `Bearer ${authToken}` };
  };

  const loadConversations = useCallback(async (authToken?: string) => {
    setListState("loading");
    setListError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/conversations`, {
        headers: authHeaders(authToken),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ConversationSummary[];
      setConversations(data);
      setListState("idle");
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setListState("error");
    }
  }, [apiBaseUrl]);

  const loadMessages = useCallback(async (threadId: string, authToken?: string) => {
    setSelectedThreadId(threadId);
    setMessagesState("loading");
    setMessagesError(null);
    setMessages([]);
    try {
      const res = await fetch(`${apiBaseUrl}/api/conversations/${encodeURIComponent(threadId)}`, {
        headers: authHeaders(authToken),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BrowserMessage[];
      setMessages(data);
      setMessagesState("idle");
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : String(err));
      setMessagesState("error");
    }
  }, [apiBaseUrl]);

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
