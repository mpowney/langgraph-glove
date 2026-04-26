import { useState, useCallback } from "react";
import type { ToolServerStatus } from "../types";

type LoadingState = "idle" | "loading" | "error";

export interface UseToolServerStatusResult {
  statuses: Map<string, ToolServerStatus>;
  loadState: LoadingState;
  error: string | null;
  load: (apiBaseUrl?: string, authToken?: string) => Promise<void>;
}

export function useToolServerStatus(): UseToolServerStatusResult {
  const [statuses, setStatuses] = useState<Map<string, ToolServerStatus>>(new Map());
  const [loadState, setLoadState] = useState<LoadingState>("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (apiBaseUrl = "", authToken?: string) => {
    setLoadState("loading");
    setError(null);
    try {
      const headers: Record<string, string> = authToken
        ? { Authorization: `Bearer ${authToken}` }
        : {};
      const res = await fetch(`${apiBaseUrl}/api/tools/server-status`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, ToolServerStatus>;
      setStatuses(new Map(Object.entries(data)));
      setLoadState("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoadState("error");
    }
  }, []);

  return { statuses, loadState, error, load };
}
