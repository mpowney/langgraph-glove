/**
 * Shared utilities for resolving LangChain tool names from callback arguments.
 *
 * LangChain's `handleToolStart` callback receives a `Serialized` descriptor
 * whose `name` field is the class name (e.g. "StructuredTool", "RemoteTool"),
 * not the tool's own `.name` property.  The actual name must be recovered from
 * the `runName` parameter, the `toolCallId`, or `tool.kwargs.name`.
 */

/** Names that represent the class wrapper rather than the actual tool. */
export function isGenericToolName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    ["tool", "structuredtool", "dynamictool", "remotetool"].includes(normalized)
  );
}

/**
 * Some providers emit opaque call IDs (e.g. "call_abc123") that are not tool names.
 */
function isOpaqueCallIdentifier(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^call_[a-z0-9]+$/.test(normalized);
}

function isUsableToolName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate) return false;
  if (isGenericToolName(candidate) || isOpaqueCallIdentifier(candidate)) return false;
  return true;
}

function getNestedObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractNameFromSerializedTool(tool: unknown): string | undefined {
  const t = getNestedObject(tool);
  if (!t) return undefined;

  const directName = t["name"];
  if (isUsableToolName(directName)) {
    return directName;
  }

  const nameLikeContainers = [
    t["kwargs"],
    t["lc_kwargs"],
    t["function"],
    t["tool"],
    t["serialized"],
  ];

  for (const container of nameLikeContainers) {
    const obj = getNestedObject(container);
    if (!obj) continue;

    if (isUsableToolName(obj["name"])) return obj["name"];
    if (isUsableToolName(obj["toolName"])) return obj["toolName"];

    const nestedFunction = getNestedObject(obj["function"]);
    if (nestedFunction && isUsableToolName(nestedFunction["name"])) {
      return nestedFunction["name"];
    }
  }

  return undefined;
}

/**
 * Attempt to extract a tool name from an LLM tool-call ID.
 * Example: `"functions.web_search:5"` → `"web_search"`.
 */
export function toolNameFromToolCallId(toolCallId?: string): string | undefined {
  if (!toolCallId) return undefined;
  const match = toolCallId.match(/(?:^|\.)([a-zA-Z0-9_-]+)(?::\d+)?$/);
  if (!match) return undefined;
  const candidate = match[1];
  if (isGenericToolName(candidate) || isOpaqueCallIdentifier(candidate)) {
    return undefined;
  }
  return candidate;
}

/**
 * Resolve the human-readable tool name from `handleToolStart` callback args.
 *
 * Priority:
 * 1. `runName` (LangChain per-run name, set from the tool's `.name` property)
 * 2. Tool name extracted from `toolCallId` (e.g. `"functions.web_search:5"`)
 * 3. `tool.name` when it is not a generic class name
 * 4. `tool.kwargs.name` as a last-resort fallback
 *
 * Falls back to `"tool"` when nothing useful can be determined.
 */
export function resolveToolName(
  runName: string | undefined,
  tool: unknown,
  toolCallId: string | undefined,
): string {
  if (isUsableToolName(runName)) {
    return runName;
  }

  const fromCallId = toolNameFromToolCallId(toolCallId);
  if (fromCallId) return fromCallId;

  const fromSerializedTool = extractNameFromSerializedTool(tool);
  if (fromSerializedTool) return fromSerializedTool;

  return "tool";
}
