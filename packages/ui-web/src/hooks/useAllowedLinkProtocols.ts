import { useEffect, useState } from "react";
import { DEFAULT_ALLOWED_LINK_PROTOCOLS } from "../contexts/AllowedLinkProtocolsContext";

interface LinkProtocolsPayload {
  protocols?: unknown;
}

function normalizeProtocol(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  let normalized = trimmed;
  if (normalized.endsWith(":")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.endsWith("://")) {
    normalized = normalized.slice(0, -3);
  }

  if (!/^[a-z][a-z0-9+.-]*$/u.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeProtocols(input: unknown): string[] {
  const merged = new Set<string>(DEFAULT_ALLOWED_LINK_PROTOCOLS);
  if (!Array.isArray(input)) {
    return [...merged];
  }

  for (const value of input) {
    if (typeof value !== "string") continue;
    const normalized = normalizeProtocol(value);
    if (normalized) {
      merged.add(normalized);
    }
  }

  return [...merged];
}

export function useAllowedLinkProtocols(authToken?: string): string[] {
  const [protocols, setProtocols] = useState<string[]>([...DEFAULT_ALLOWED_LINK_PROTOCOLS]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (!authToken?.trim()) {
        if (active) setProtocols([...DEFAULT_ALLOWED_LINK_PROTOCOLS]);
        return;
      }

      try {
        const res = await fetch("/api/link-protocols", {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });
        if (!res.ok) {
          if (active) setProtocols([...DEFAULT_ALLOWED_LINK_PROTOCOLS]);
          return;
        }

        const payload = await res.json() as LinkProtocolsPayload;
        if (!active) return;
        setProtocols(normalizeProtocols(payload.protocols));
      } catch {
        if (active) setProtocols([...DEFAULT_ALLOWED_LINK_PROTOCOLS]);
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, [authToken]);

  return protocols;
}
