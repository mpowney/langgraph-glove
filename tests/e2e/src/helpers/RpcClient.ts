/**
 * Lightweight RPC client that speaks the same wire protocol as the tool
 * servers (HttpToolServer / UnixSocketToolServer).
 *
 * Supports two transports:
 *   - "http"        — POST JSON-RPC to `<baseUrl>/rpc`
 *   - "unix-socket" — NDJSON over `/tmp/langgraph-glove-<name>.sock`
 */

import net from "node:net";
import { randomUUID } from "node:crypto";

export interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// HTTP RPC client
// ---------------------------------------------------------------------------

export async function callHttpRpc(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResponse> {
  const request: RpcRequest = { id: randomUUID(), method, params };
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    throw new Error(`HTTP RPC transport error: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as RpcResponse;
}

// ---------------------------------------------------------------------------
// Unix-socket NDJSON RPC client
// ---------------------------------------------------------------------------

/**
 * Convert a tool name to its deterministic socket path, matching the logic
 * used by UnixSocketToolServer in `@langgraph-glove/tool-server`.
 */
export function socketPathForTool(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `/tmp/langgraph-glove-${safe}.sock`;
}

export function callUnixSocketRpc(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<RpcResponse> {
  const request: RpcRequest = { id: randomUUID(), method, params };

  return new Promise<RpcResponse>((resolve, reject) => {
    let readBuffer = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`Unix-socket RPC timed out after ${timeoutMs} ms`)));
    }, timeoutMs);

    const socket = net.createConnection({ path: socketPath }, () => {
      socket.write(`${JSON.stringify(request)}\n`, "utf8");
    });

    socket.on("data", (chunk) => {
      readBuffer += chunk.toString("utf8");
      const lines = readBuffer.split("\n");
      readBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as RpcResponse;
          settle(() => resolve(response));
          return;
        } catch {
          // Malformed line — keep reading
        }
      }
    });

    socket.on("end", () => {
      if (readBuffer.trim()) {
        try {
          const response = JSON.parse(readBuffer) as RpcResponse;
          settle(() => resolve(response));
          return;
        } catch {
          // Fall through to error below
        }
      }
      settle(() => reject(new Error("Unix-socket closed before a valid RPC response was received")));
    });

    socket.on("error", (err) => {
      settle(() => reject(err));
    });
  });
}

// ---------------------------------------------------------------------------
// Unified client
// ---------------------------------------------------------------------------

export interface ToolRpcClientOptions {
  transport: "http" | "unix-socket";
  /** Required when transport === "http". */
  baseUrl?: string;
  /** Required when transport === "unix-socket". */
  socketPath?: string;
  /** Per-call timeout in milliseconds (unix-socket only). */
  timeoutMs?: number;
}

export class ToolRpcClient {
  constructor(private readonly opts: ToolRpcClientOptions) {
    if (opts.transport === "http" && !opts.baseUrl) {
      throw new Error("ToolRpcClient: baseUrl is required for HTTP transport");
    }
    if (opts.transport === "unix-socket" && !opts.socketPath) {
      throw new Error("ToolRpcClient: socketPath is required for unix-socket transport");
    }
  }

  async call(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    if (this.opts.transport === "http") {
      return callHttpRpc(this.opts.baseUrl!, method, params);
    }
    return callUnixSocketRpc(this.opts.socketPath!, method, params, this.opts.timeoutMs);
  }

  /**
   * Convenience wrapper that unwraps the result or throws on RPC-level error.
   */
  async invoke(method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await this.call(method, params);
    if (response.error) {
      throw new Error(`Tool "${method}" returned error: ${response.error}`);
    }
    return response.result;
  }

  /**
   * Fetch the list of tool metadata objects from the server's introspection
   * endpoint.
   */
  async introspect(): Promise<unknown[]> {
    const response = await this.call("__introspect__", {});
    if (response.error) {
      throw new Error(`Introspection failed: ${response.error}`);
    }
    return Array.isArray(response.result) ? response.result : [];
  }
}
