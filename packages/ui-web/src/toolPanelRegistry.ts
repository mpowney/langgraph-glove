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
  meta: ToolPanelMeta;
  load: () => Promise<{ default: ComponentType<ToolPanelProps> }>;
}

const registry: ToolPanelRegistryEntry[] = [
  {
    meta: {
      serverKey: "imap-",
      matchStrategy: "prefix",
      label: "IMAP",
      description: "Monitor IMAP crawl indexing progress",
    },
    load: () => import("@langgraph-glove/tool-imap-ui"),
  },
  {
    meta: {
      serverKey: "memory",
      matchStrategy: "exact",
      label: "Memory",
      description: "Manage stored memories",
    },
    load: () => import("@langgraph-glove/tool-memory-ui"),
  },
  {
    meta: {
      serverKey: "config",
      matchStrategy: "exact",
      label: "Configuration",
      description: "Edit system settings and config",
    },
    load: () => import("@langgraph-glove/tool-config-ui"),
  },
];

export default registry;

