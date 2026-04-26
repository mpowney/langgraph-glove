import type { ToolHealthResult, ToolMetadata } from "./RpcProtocol";

/**
 * Abstract base class for RPC clients that connect to a remote tool server.
 *
 * Two concrete implementations are provided:
 * - {@link UnixSocketRpcClient} — NDJSON over a Unix domain socket (same-machine IPC)
 * - {@link HttpRpcClient} — JSON-RPC over HTTP POST (cross-machine)
 *
 * Both are swappable at runtime by passing the desired instance to {@link RemoteTool}.
 */
export abstract class RpcClient {
  /**
   * Establish the underlying transport connection (if required).
   * Must be called before the first {@link call}.
   */
  abstract connect(): Promise<void>;

  /**
   * Gracefully close the underlying transport connection.
   * Safe to call even if the client was never connected.
   */
  abstract disconnect(): Promise<void>;

  /**
   * Invoke a named tool on the remote server and return its result.
   *
   * @param method - The tool name to invoke.
   * @param params - Arbitrary key/value parameters forwarded to the handler.
   * @returns The serialisable return value from the tool handler.
   * @throws If the server returns an error or the transport fails.
   */
  abstract call(method: string, params: Record<string, unknown>): Promise<unknown>;

  /**
   * Retrieve metadata for all tools registered on the remote server.
   * Implemented by calling the reserved `__introspect__` method.
   */
  async listTools(): Promise<ToolMetadata[]> {
    const result = await this.call("__introspect__", {});
    return result as ToolMetadata[];
  }

  /** Retrieve the server health report exposed by the reserved health RPC. */
  async checkHealth(): Promise<ToolHealthResult> {
    const result = await this.call("__healthcheck__", {});
    return result as ToolHealthResult;
  }
}
