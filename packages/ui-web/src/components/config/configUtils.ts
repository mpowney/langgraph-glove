import type { DependentItem } from "./DependentsPanel";

/**
 * Given a file and item key, computes which other config items reference it.
 *
 * Current cross-references tracked:
 * - models.json entries → referenced by agents.json via modelKey
 * - tools.json entries  → referenced by agents.json via tools array
 */
export function computeDependents(
  filename: string,
  itemKey: string,
  allConfigs: Record<string, string>,
): DependentItem[] {
  const dependents: DependentItem[] = [];

  if (filename === "models.json") {
    // Find agents that reference this model key
    const agentsRaw = allConfigs["agents.json"];
    if (agentsRaw) {
      try {
        const agents = JSON.parse(agentsRaw) as Record<string, unknown>;
        for (const [agentKey, agentValue] of Object.entries(agents)) {
          if (
            typeof agentValue === "object" &&
            agentValue !== null &&
            "modelKey" in agentValue &&
            (agentValue as Record<string, unknown>)["modelKey"] === itemKey
          ) {
            dependents.push({
              label: agentKey,
              file: "agents.json",
              key: agentKey,
            });
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  if (filename === "tools.json") {
    // Find agents that include this tool in their tools array
    const agentsRaw = allConfigs["agents.json"];
    if (agentsRaw) {
      try {
        const agents = JSON.parse(agentsRaw) as Record<string, unknown>;
        for (const [agentKey, agentValue] of Object.entries(agents)) {
          if (
            typeof agentValue === "object" &&
            agentValue !== null &&
            "tools" in agentValue
          ) {
            const tools = (agentValue as Record<string, unknown>)["tools"];
            if (Array.isArray(tools) && tools.includes(itemKey)) {
              dependents.push({
                label: agentKey,
                file: "agents.json",
                key: agentKey,
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  if (filename === "graphs.json") {
    // Find agents that reference this graph
    const agentsRaw = allConfigs["agents.json"];
    if (agentsRaw) {
      try {
        const agents = JSON.parse(agentsRaw) as Record<string, unknown>;
        for (const [agentKey, agentValue] of Object.entries(agents)) {
          if (
            typeof agentValue === "object" &&
            agentValue !== null &&
            "graphKey" in agentValue &&
            (agentValue as Record<string, unknown>)["graphKey"] === itemKey
          ) {
            dependents.push({
              label: agentKey,
              file: "agents.json",
              key: agentKey,
            });
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return dependents;
}

/**
 * Extract all secret names referenced in a JSON value string.
 * Looks for {SECRET:name} placeholders.
 */
export function extractSecretRefs(value: unknown): string[] {
  const json = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const matches = json.matchAll(/\{SECRET:([a-zA-Z0-9_-]+)\}/g);
  const names = new Set<string>();
  for (const match of matches) {
    if (match[1]) names.add(match[1]);
  }
  return Array.from(names);
}
