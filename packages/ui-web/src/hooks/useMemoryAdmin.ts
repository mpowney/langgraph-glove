import { useCallback, useState } from "react";
import type {
  MemoryDocument,
  MemorySearchResult,
  MemorySummary,
  MemoryToolHealth,
} from "../types";
import { callMemoryTool, checkMemoryToolAvailability } from "./memoryRpcClient";

type LoadingState = "idle" | "loading" | "error";

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useMemoryAdmin(memoryToolUrl = "", authToken?: string) {
  const [health, setHealth] = useState<MemoryToolHealth>({ available: false });
  const [healthState, setHealthState] = useState<LoadingState>("idle");
  const [listState, setListState] = useState<LoadingState>("idle");
  const [searchState, setSearchState] = useState<LoadingState>("idle");
  const [detailState, setDetailState] = useState<LoadingState>("idle");
  const [saveState, setSaveState] = useState<LoadingState>("idle");
  const [deleteState, setDeleteState] = useState<LoadingState>("idle");

  const [listError, setListError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [memories, setMemories] = useState<MemorySummary[]>([]);
  const [searchResults, setSearchResults] = useState<MemorySearchResult | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<MemoryDocument | null>(null);

  const checkHealth = useCallback(async () => {
    setHealthState("loading");
    const result = await checkMemoryToolAvailability(memoryToolUrl, authToken);
    setHealth(result);
    setHealthState(result.available ? "idle" : "error");
    return result.available;
  }, [memoryToolUrl, authToken]);

  const loadMemories = useCallback(async () => {
    setListState("loading");
    setListError(null);
    setSearchResults(null);
    try {
      const data = await callMemoryTool<MemorySummary[]>(memoryToolUrl, "memory_list", {}, authToken);
      setMemories(data);
      setListState("idle");
    } catch (err) {
      setListError(toErrorMessage(err));
      setListState("error");
    }
  }, [memoryToolUrl, authToken]);

  const searchMemories = useCallback(async (query: string, personalToken?: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      return;
    }

    setSearchState("loading");
    setSearchError(null);
    try {
      const data = await callMemoryTool<MemorySearchResult>(memoryToolUrl, "memory_search", {
        query: trimmed,
        ...(typeof personalToken === "string" && personalToken.trim()
          ? { personalToken: personalToken.trim() }
          : {}),
      }, authToken);
      setSearchResults(data);
      setSearchState("idle");
    } catch (err) {
      setSearchError(toErrorMessage(err));
      setSearchState("error");
    }
  }, [memoryToolUrl, authToken]);

  const loadMemory = useCallback(async (memoryId: string, personalToken?: string) => {
    setDetailState("loading");
    setDetailError(null);
    try {
      const data = await callMemoryTool<MemoryDocument>(memoryToolUrl, "memory_get", {
        memoryId,
        ...(typeof personalToken === "string" && personalToken.trim()
          ? { personalToken: personalToken.trim() }
          : {}),
      }, authToken);
      setSelectedMemory(data);
      setDetailState("idle");
    } catch (err) {
      setDetailError(toErrorMessage(err));
      setDetailState("error");
    }
  }, [memoryToolUrl, authToken]);

  const saveMemory = useCallback(async (
    memoryId: string,
    updates: Partial<MemoryDocument>,
    personalToken?: string,
  ) => {
    setSaveState("loading");
    setSaveError(null);
    try {
      const data = await callMemoryTool<MemoryDocument>(memoryToolUrl, "memory_update", {
        memoryId,
        ...(typeof updates.title === "string" ? { title: updates.title } : {}),
        ...(typeof updates.content === "string" ? { content: updates.content } : {}),
        ...(typeof updates.scope === "string" ? { scope: updates.scope } : {}),
        ...(Array.isArray(updates.tags) ? { tags: updates.tags } : {}),
        ...(typeof updates.retentionTier === "string" ? { retentionTier: updates.retentionTier } : {}),
        ...(typeof updates.status === "string" ? { status: updates.status } : {}),
        ...(typeof updates.personal === "boolean" ? { personal: updates.personal } : {}),
        ...(typeof personalToken === "string" && personalToken.trim()
          ? { personalToken: personalToken.trim() }
          : {}),
      }, authToken);
      setSelectedMemory(data);
      setMemories((prev) => prev.map((m) => (m.id === data.id ? data : m)));
      setSearchResults((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          results: prev.results.map((r) => (r.memory.id === data.id ? { ...r, memory: data } : r)),
        };
      });
      setSaveState("idle");
      return data;
    } catch (err) {
      setSaveError(toErrorMessage(err));
      setSaveState("error");
      return null;
    }
  }, [memoryToolUrl, authToken]);

  const deleteMemory = useCallback(async (memoryId: string) => {
    setDeleteState("loading");
    setDeleteError(null);
    try {
      await callMemoryTool(memoryToolUrl, "memory_delete", { memoryId }, authToken);
      setMemories((prev) => prev.filter((memory) => memory.id !== memoryId));
      setSearchResults((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          results: prev.results.filter((result) => result.memory.id !== memoryId),
        };
      });
      setSelectedMemory((prev) => (prev?.id === memoryId ? null : prev));
      setDeleteState("idle");
      return true;
    } catch (err) {
      setDeleteError(toErrorMessage(err));
      setDeleteState("error");
      return false;
    }
  }, [memoryToolUrl, authToken]);

  const clearSelection = useCallback(() => {
    setSelectedMemory(null);
    setDetailError(null);
    setDetailState("idle");
    setSaveError(null);
    setSaveState("idle");
    setDeleteError(null);
    setDeleteState("idle");
  }, []);

  const canDeleteMemory = Boolean(health.tools?.includes("memory_delete"));

  return {
    health,
    healthState,
    listState,
    searchState,
    detailState,
    saveState,
    deleteState,
    listError,
    searchError,
    detailError,
    saveError,
    deleteError,
    canDeleteMemory,
    memories,
    searchResults,
    selectedMemory,
    checkHealth,
    loadMemories,
    searchMemories,
    loadMemory,
    saveMemory,
    deleteMemory,
    clearSelection,
  };
}
