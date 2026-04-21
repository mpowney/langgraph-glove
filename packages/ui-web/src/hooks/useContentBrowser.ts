import { useState, useCallback } from "react";
import type { ContentItemView, ContentListResponse } from "../types";

type LoadingState = "idle" | "loading" | "error";

interface LoadContentListOptions {
  conversationId?: string;
  toolName?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
  authToken?: string;
}

export function useContentBrowser(apiBaseUrl = "") {
  const [items, setItems] = useState<ContentItemView[]>([]);
  const [selectedContentRef, setSelectedContentRef] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<ContentItemView | null>(null);
  const [listState, setListState] = useState<LoadingState>("idle");
  const [detailsState, setDetailsState] = useState<LoadingState>("idle");
  const [listError, setListError] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const authHeaders = (authToken?: string): Record<string, string> => {
    if (!authToken) return {};
    return { Authorization: `Bearer ${authToken}` };
  };

  const loadList = useCallback(async (options: LoadContentListOptions = {}) => {
    setListState("loading");
    setListError(null);

    const params = new URLSearchParams();
    if (options.conversationId?.trim()) params.set("conversationId", options.conversationId.trim());
    if (options.toolName?.trim()) params.set("toolName", options.toolName.trim());
    if (options.includeDeleted) params.set("includeDeleted", "true");
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));

    try {
      const query = params.toString();
      const res = await fetch(`${apiBaseUrl}/api/content${query ? `?${query}` : ""}`, {
        headers: authHeaders(options.authToken),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ContentListResponse;
      setItems(data.items);
      setListState("idle");
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setItems([]);
      setListState("error");
    }
  }, [apiBaseUrl]);

  const loadContent = useCallback(async (contentRef: string, authToken?: string) => {
    const ref = contentRef.trim();
    if (!ref) return;

    setSelectedContentRef(ref);
    setDetailsState("loading");
    setDetailsError(null);

    try {
      const res = await fetch(`${apiBaseUrl}/api/content/${encodeURIComponent(ref)}`, {
        headers: authHeaders(authToken),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ContentItemView;
      setSelectedItem(data);
      setDetailsState("idle");
    } catch (err) {
      setSelectedItem(null);
      setDetailsError(err instanceof Error ? err.message : String(err));
      setDetailsState("error");
    }
  }, [apiBaseUrl]);

  const clearSelection = useCallback(() => {
    setSelectedContentRef(null);
    setSelectedItem(null);
    setDetailsState("idle");
    setDetailsError(null);
  }, []);

  return {
    items,
    selectedContentRef,
    selectedItem,
    listState,
    detailsState,
    listError,
    detailsError,
    loadList,
    loadContent,
    clearSelection,
  };
}
