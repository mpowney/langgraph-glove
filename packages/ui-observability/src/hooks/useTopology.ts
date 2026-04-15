import { useCallback, useEffect, useState } from "react";
import type { TopologyPayload } from "../types";

export function useTopology(apiBaseUrl: string | null, token: string | null) {
  const [loading, setLoading] = useState(false);
  const [topology, setTopology] = useState<TopologyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (apiBaseUrl === null || !token) {
      setTopology(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/topology`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = (await res.json()) as TopologyPayload;
      setTopology(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    loading,
    topology,
    error,
    refresh,
  };
}
