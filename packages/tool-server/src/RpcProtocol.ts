/** A request from the agent to a tool server. */
export interface RpcRequest {
  /** Unique request identifier (UUID v4). */
  id: string;
  /** Tool name, or the reserved method "__introspect__" to list tools. */
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
   * Optional execution hint: when true, runtime should inject privileged
   * context fields (for example conversationId and privilegeGrantId)
   * automatically when available.
   */
  requiresPrivilegedAccess?: boolean;
  /**
   * Optional execution hint: when true, runtime may inject short-lived
   * content-upload credentials so this tool can push generated files back to
   * the gateway content store.
   */
  supportsContentUpload?: boolean;
  /**
   * JSON Schema object describing the tool's parameters.
   * Used for documentation / introspection.
   */
  parameters: Record<string, unknown>;
}

/** Reserved RPC method names for content upload flows. */
export type ContentUploadRpcMethod =
  | "__content_upload_init__"
  | "__content_upload_chunk__"
  | "__content_upload_finalize__"
  | "__content_upload_abort__";

/** Runtime-injected tool auth payload used for content upload. */
export interface ContentUploadAuthPayload {
  token: string;
  expiresAt: string;
  transport: "http" | "unix-socket";
  /**
   * For HTTP uploads, this is an absolute base URL to the gateway API.
   * Example: "http://127.0.0.1:8081"
   */
  gatewayBaseUrl?: string;
  /**
   * For unix-socket uploads, this is the socket name/path exposed by the
   * gateway content upload RPC server.
   */
  socketName?: string;
}
