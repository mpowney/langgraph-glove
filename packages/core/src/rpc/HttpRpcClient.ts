import { v4 as uuidv4 } from "uuid";
import { RpcClient } from "./RpcClient";
import type { RpcRequest, RpcResponse } from "./RpcProtocol";

/**
 * RPC client that communicates with an {@link HttpToolServer} using
 * JSON-RPC over HTTP POST.
 *
 * Uses the Node.js built-in `fetch` API (available since Node 18).
 * `connect()` and `disconnect()` are no-ops because HTTP is stateless.
 *
 * @example
 * ```ts
 * const client = new HttpRpcClient("http://localhost:3001");
 * await client.connect(); // no-op, safe to omit
 * const result = await client.call("weather", { location: "London" });
 * ```
 */
export class HttpRpcClient extends RpcClient {
  constructor(private readonly baseUrl: string) {
    super();
  }

  /** No-op — HTTP is stateless. */
  async connect(): Promise<void> {}

  /** No-op — HTTP is stateless. */
  async disconnect(): Promise<void> {}

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = uuidv4();
    const request: RpcRequest = { id, method, params };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`HttpRpcClient: network error calling ${method}: ${msg}`);
    }

    if (!response.ok) {
      throw new Error(
        `HttpRpcClient: HTTP ${response.status} ${response.statusText} calling ${method}`,
      );
    }

    const rpcResponse: RpcResponse = (await response.json()) as RpcResponse;

    if (rpcResponse.error !== undefined) {
      throw new Error(`HttpRpcClient: tool error in ${method}: ${rpcResponse.error}`);
    }

    return rpcResponse.result;
  }
}
