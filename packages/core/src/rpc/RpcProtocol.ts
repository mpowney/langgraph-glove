/**
 * Shared NDJSON-over-socket / HTTP JSON-RPC protocol types used by both the
 * RPC client (core) and the tool servers.
 */

/** A request from the agent to a tool server. */
export interface RpcRequest {
  /** Unique request identifier (UUID v4). */
  id: string;
  /** Tool name, or the special value "__introspect__" to list available tools. */
  method: string;
  /** Tool input parameters. */
  params: Record<string, unknown>;
}

/** A response from a tool server back to the agent. */
export interface RpcResponse {
  /** Mirrors the request `id`. */
  id: string;
  /** Successful return value from the tool handler. */
  result?: unknown;
  /** Error message when the invocation failed. */
  error?: string;
}

/** Metadata that a tool server exposes for introspection. */
export interface ToolMetadata {
  /** Unique tool name — must match the name used when registering the handler. */
  name: string;
  /** Human-readable description forwarded to the LLM as the tool description. */
  description: string;
  /**
   * JSON Schema object describing the tool's parameters.
   * Used for documentation / introspection; the Zod schema for the LangGraph
   * `RemoteTool` is defined separately by the agent developer.
   */
  parameters: Record<string, unknown>;
}
