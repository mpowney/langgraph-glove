/**
 * Registry of tool panel companion modules.
 *
 * Each entry maps a ToolPanelMeta (with serverKey + matchStrategy) to a lazy
 * import factory.  ui-web dynamically loads these at render time via
 * React.lazy so panels are code-split out of the main bundle.
 *
 * Companion packages are loaded lazily at render-time, so panel code is
 * split out of the main ui-web bundle.
 */

import type { ToolPanelMeta, ToolPanelProps } from "./types";
import type { ComponentType } from "react";

export interface ToolPanelRegistryEntry {
  serverKey: string;
  matchStrategy: "exact" | "prefix";
  load: () => Promise<{ default: ComponentType<ToolPanelProps> }>;
  /** Dynamic meta loader from companion package (source of truth for labels/descriptions). */
  loadMeta: () => Promise<ToolPanelMeta>;
}

const registry: ToolPanelRegistryEntry[] = [
  {
    serverKey: "imap-",
    matchStrategy: "prefix",
    load: () => import("@langgraph-glove/tool-imap-ui"),
    loadMeta: () => import("@langgraph-glove/tool-imap-ui/meta").then((mod) => mod.meta),
  },
  {
    serverKey: "memory",
    matchStrategy: "exact",
    load: () => import("@langgraph-glove/tool-memory-ui"),
    loadMeta: () => import("@langgraph-glove/tool-memory-ui/meta").then((mod) => mod.meta),
  },
  {
    serverKey: "config",
    matchStrategy: "exact",
    load: () => import("@langgraph-glove/tool-config-ui"),
    loadMeta: () => import("@langgraph-glove/tool-config-ui/meta").then((mod) => mod.meta),
  },
];

export default registry;

