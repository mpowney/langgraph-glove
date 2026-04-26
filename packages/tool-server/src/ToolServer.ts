import type {
  ToolHealthResult,
  ToolMetadata,
  RpcRequest,
  RpcResponse,
} from "./RpcProtocol";

/** Async function that handles a single tool invocation. */
export type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;
/** Async function that reports health for a tool server. */
export type ToolHealthCheck = () => Promise<Omit<ToolHealthResult, "latencyMs"> | ToolHealthResult>;

/**
 * Abstract base class for remote tool servers.
 *
 * Tool handlers are registered with {@link register} and the server dispatches
 * incoming RPC calls to the appropriate handler.  The reserved method
 * `__introspect__` is handled automatically — it returns the metadata for all
 * registered tools.
 *
 * Two concrete implementations are provided:
 * - {@link UnixSocketToolServer} — NDJSON over a Unix domain socket
 * - {@link HttpToolServer}       — JSON-RPC over HTTP POST
 *
 * @example
 * ```ts
 * const server = new HttpToolServer(3001);
 *
 * server.register(
 *   { name: "weather", description: "Get current weather", parameters: {} },
 *   async ({ location }) => `Sunny in ${location}`,
 * );
 *
 * await server.start();
 * ```
 */
export abstract class ToolServer {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly toolMetadata = new Map<string, ToolMetadata>();
  private healthCheck?: ToolHealthCheck;

  /**
   * Register a tool handler with its metadata.
   *
   * @param metadata - Name, description and JSON Schema for the tool.
   * @param handler  - Async function that processes a tool invocation.
   * @returns `this` for chaining.
   */
  register(metadata: ToolMetadata, handler: ToolHandler): this {
    this.handlers.set(metadata.name, handler);
    this.toolMetadata.set(metadata.name, metadata);
    return this;
  }

  /** Register an optional server-level health check. */
  setHealthCheck(healthCheck: ToolHealthCheck): this {
    this.healthCheck = healthCheck;
    return this;
  }

  /** Start the server and begin accepting connections. */
  abstract start(): Promise<void>;

  /** Stop the server and release resources. */
  abstract stop(): Promise<void>;

  /** Run the server health check or return a default healthy result. */
  async runHealthCheck(): Promise<ToolHealthResult> {
    const startedAt = Date.now();

    if (!this.healthCheck) {
      return {
        ok: true,
        summary: "ok",
        dependencies: [],
        latencyMs: Date.now() - startedAt,
      };
    }

    const result = await this.healthCheck();
    const latencyMs =
      "latencyMs" in result &&
      typeof result.latencyMs === "number" &&
      Number.isFinite(result.latencyMs)
        ? result.latencyMs
        : Date.now() - startedAt;
    return {
      ...result,
      latencyMs,
    };
  }

  /**
   * Dispatch an incoming RPC request to the appropriate handler.
   * Handles the reserved `__introspect__` method automatically.
   *
   * @internal
   */
  protected async dispatch(request: RpcRequest): Promise<RpcResponse> {
    try {
      if (request.method === "__introspect__") {
        return { id: request.id, result: Array.from(this.toolMetadata.values()) };
      }

      if (request.method === "__healthcheck__") {
        return { id: request.id, result: await this.runHealthCheck() };
      }

      const handler = this.handlers.get(request.method);
      if (!handler) {
        return { id: request.id, error: `Unknown tool: "${request.method}"` };
      }

      const result = await handler(request.params);
      return { id: request.id, result };
    } catch (err) {
      return {
        id: request.id,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
