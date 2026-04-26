import { useEffect, useMemo, useRef, useState } from "react";
import type { AvailablePanel, ToolPanelMeta, ToolServerStatus } from "../types";
import registry from "../toolPanelRegistry";

function toFallbackLabel(serverKey: string): string {
  const trimmed = serverKey.replace(/-+$/, "");
  if (!trimmed) return "Tool";
  return trimmed
    .split(/[-_]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Combines the live tool server status map with the static panel registry to
 * produce a sorted list of AvailablePanel entries suitable for rendering in
 * ControlPanel.
 *
 * Rules:
 *  - configured+undiscovered: always included as status='error' (no load fn)
 *  - configured+discovered + has companion: included as status='ok' with load fn
 *  - configured+discovered + no companion: excluded (silent)
 */
export function useToolPanels(statuses: Map<string, ToolServerStatus>): AvailablePanel[] {
  const [dynamicMetaByServerKey, setDynamicMetaByServerKey] = useState<Map<string, ToolPanelMeta>>(new Map());
  const requestedMetaKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    const loadDynamicMeta = async () => {
      for (const entry of registry) {
        const { serverKey, matchStrategy, loadMeta } = entry;
        if (requestedMetaKeys.current.has(serverKey)) continue;

        const hasMatchingStatus =
          matchStrategy === "prefix"
            ? [...statuses.keys()].some((k) => k.startsWith(serverKey))
            : statuses.has(serverKey);

        if (!hasMatchingStatus) continue;

        requestedMetaKeys.current.add(serverKey);

        try {
          const loadedMeta = await loadMeta();
          if (cancelled) return;

          setDynamicMetaByServerKey((prev) => {
            if (prev.has(serverKey)) return prev;
            const next = new Map(prev);
            next.set(serverKey, loadedMeta);
            return next;
          });
        } catch {
          requestedMetaKeys.current.delete(serverKey);
        }
      }
    };

    void loadDynamicMeta();

    return () => {
      cancelled = true;
    };
  }, [statuses]);

  return useMemo(() => {
    const panels: AvailablePanel[] = [];

    // Build a map of every configured server key that failed discovery.
    const failedKeys = new Map<string, string>(); // key → error
    for (const [key, status] of statuses) {
      if (!status.discovered) {
        failedKeys.set(key, status.error ?? "Not discovered");
      }
    }

    // Track which server keys have been covered by a registry entry (to avoid
    // duplicate error entries for keys also handled by a companion package).
    const coveredByRegistry = new Set<string>();

    // Walk the registry and produce an AvailablePanel per entry.
    for (const entry of registry) {
      const { serverKey, matchStrategy, load } = entry;
      const resolvedMeta = dynamicMetaByServerKey.get(serverKey);

      // Find all matching server keys.
      const matchingKeys: string[] =
        matchStrategy === "prefix"
          ? [...statuses.keys()].filter((k) => k.startsWith(serverKey))
          : statuses.has(serverKey)
            ? [serverKey]
            : [];

      if (matchingKeys.length === 0) continue;

      for (const k of matchingKeys) coveredByRegistry.add(k);

      const errors: Record<string, string> = {};
      for (const k of matchingKeys) {
        const s = statuses.get(k);
        if (s && !s.discovered) {
          errors[k] = s.error ?? "Not discovered";
        }
      }

      const hasErrors = Object.keys(errors).length > 0;
      const panelKey = matchStrategy === "prefix" ? matchingKeys[0]! : serverKey;

      panels.push({
        panelKey,
        label: resolvedMeta?.label ?? toFallbackLabel(serverKey),
        description: resolvedMeta?.description ?? "Open tool panel",
        status: hasErrors ? "error" : "ok",
        instanceKeys: matchingKeys,
        errors,
        load: hasErrors ? undefined : load,
      });
    }

    // Add error entries for configured-but-failed servers not covered by any companion.
    for (const [key, errMsg] of failedKeys) {
      if (coveredByRegistry.has(key)) continue;
      panels.push({
        panelKey: key,
        label: key,
        description: "Tool server not connected",
        status: "error",
        instanceKeys: [key],
        errors: { [key]: errMsg },
      });
    }

    return panels;
  }, [statuses, dynamicMetaByServerKey]);
}
