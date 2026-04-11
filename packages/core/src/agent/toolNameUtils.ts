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
 * Attempt to extract a tool name from an LLM tool-call ID.
 * Example: `"functions.web_search:5"` → `"web_search"`.
 */
export function toolNameFromToolCallId(toolCallId?: string): string | undefined {
  if (!toolCallId) return undefined;
  const match = toolCallId.match(/(?:^|\.)([a-zA-Z0-9_-]+)(?::\d+)?$/);
  if (!match) return undefined;
  const candidate = match[1];
  return isGenericToolName(candidate) ? undefined : candidate;
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
  if (typeof runName === "string" && !isGenericToolName(runName)) {
    return runName;
  }

  const fromCallId = toolNameFromToolCallId(toolCallId);
  if (fromCallId) return fromCallId;

  if (typeof tool === "object" && tool !== null) {
    const t = tool as Record<string, unknown>;
    if (typeof t["name"] === "string" && !isGenericToolName(t["name"])) {
      return t["name"];
    }
    const kwargs = typeof t["kwargs"] === "object" && t["kwargs"] !== null
      ? (t["kwargs"] as Record<string, unknown>)
      : undefined;
    if (kwargs && typeof kwargs["name"] === "string" && !isGenericToolName(kwargs["name"])) {
      return kwargs["name"];
    }
  }

  return "tool";
}
