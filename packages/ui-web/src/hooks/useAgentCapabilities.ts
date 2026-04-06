import { useState, useCallback } from "react";
import type { AgentCapabilityRegistry } from "../types";

type LoadingState = "idle" | "loading" | "error";

export interface UseAgentCapabilitiesResult {
  registry: AgentCapabilityRegistry | null;
  loadState: LoadingState;
  error: string | null;
  load: (apiBaseUrl?: string, authToken?: string) => Promise<void>;
}

export function useAgentCapabilities(): UseAgentCapabilitiesResult {
  const [registry, setRegistry] = useState<AgentCapabilityRegistry | null>(null);
  const [loadState, setLoadState] = useState<LoadingState>("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (apiBaseUrl = "", authToken?: string) => {
    setLoadState("loading");
    setError(null);
    try {
      const headers: Record<string, string> = authToken
        ? { Authorization: `Bearer ${authToken}` }
        : {};
      const res = await fetch(`${apiBaseUrl}/api/agents/capabilities`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AgentCapabilityRegistry;
      setRegistry(data);
      setLoadState("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoadState("error");
    }
  }, []);

  return { registry, loadState, error, load };
}
