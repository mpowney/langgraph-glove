import { useState, useCallback } from "react";
import type { ToolDefinition } from "../types";

type LoadingState = "idle" | "loading" | "error";

export interface UseToolRegistryResult {
  tools: ToolDefinition[];
  loadState: LoadingState;
  error: string | null;
  load: (apiBaseUrl?: string, authToken?: string) => Promise<void>;
  /** Fast lookup by tool name using a pre-built Map — undefined when not yet loaded. */
  lookup: (name: string) => ToolDefinition | undefined;
}

export function useToolRegistry(): UseToolRegistryResult {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [toolMap, setToolMap] = useState<Map<string, ToolDefinition>>(new Map());
  const [loadState, setLoadState] = useState<LoadingState>("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (apiBaseUrl = "", authToken?: string) => {
    setLoadState("loading");
    setError(null);
    try {
      const headers: Record<string, string> = authToken
        ? { Authorization: `Bearer ${authToken}` }
        : {};
      const res = await fetch(`${apiBaseUrl}/api/tools/registry`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ToolDefinition[];
      setTools(data);
      setToolMap(new Map(data.map((t) => [t.name, t])));
      setLoadState("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoadState("error");
    }
  }, []);

  const lookup = useCallback(
    (name: string) => toolMap.get(name),
    [toolMap],
  );

  return { tools, loadState, error, load, lookup };
}
