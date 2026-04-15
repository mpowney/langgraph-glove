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

function extractNameFromCallbackMetadata(metadata: unknown): string | undefined {
  const m = getNestedObject(metadata);
  if (!m) return undefined;

  const directCandidates: unknown[] = [
    m["name"],
    m["toolName"],
    m["tool_name"],
    m["ls_tool_name"],
    m["lc_name"],
    m["runName"],
  ];
  for (const candidate of directCandidates) {
    if (isUsableToolName(candidate)) return candidate;
  }

  const nestedCandidates = [
    m["tool"],
    m["serialized"],
    m["function"],
    m["metadata"],
  ];
  for (const candidate of nestedCandidates) {
    const nested = getNestedObject(candidate);
    if (!nested) continue;

    if (isUsableToolName(nested["name"])) return nested["name"];
    if (isUsableToolName(nested["toolName"])) return nested["toolName"];
    if (isUsableToolName(nested["tool_name"])) return nested["tool_name"];

    const nestedFunction = getNestedObject(nested["function"]);
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
 * 3. Tool name extracted from callback metadata (`ls_tool_name`, `tool_name`, etc.)
 * 4. `tool.name` when it is not a generic class name
 * 5. `tool.kwargs.name` as a last-resort fallback
 *
 * Falls back to `"tool"` when nothing useful can be determined.
 */
export function resolveToolName(
  runName: string | undefined,
  tool: unknown,
  toolCallId: string | undefined,
  metadata?: unknown,
): string {
  if (isUsableToolName(runName)) {
    return runName;
  }

  const fromCallId = toolNameFromToolCallId(toolCallId);
  if (fromCallId) return fromCallId;

  const fromMetadata = extractNameFromCallbackMetadata(metadata);
  if (fromMetadata) return fromMetadata;

  const fromSerializedTool = extractNameFromSerializedTool(tool);
  if (fromSerializedTool) return fromSerializedTool;

  return "tool";
}
