import net from "node:net";
import { v4 as uuidv4 } from "uuid";
import { RpcClient } from "./RpcClient";
import type { RpcRequest, RpcResponse } from "./RpcProtocol";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * Convert a tool name to a safe, deterministic Unix socket path.
 * Must stay in sync with the identical helper in `@langgraph-glove/tool-server`.
 *
 * @example
 * socketPathForTool("weather_us") // "/tmp/langgraph-glove-weather_us.sock"
 */
export function socketPathForTool(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `/tmp/langgraph-glove-${safe}.sock`;
}

/**
 * RPC client that communicates with a {@link UnixSocketToolServer} using
 * newline-delimited JSON (NDJSON) over a Unix domain socket.
 *
 * Supports multiple concurrent in-flight requests — each is keyed by a UUID
 * and resolved when the matching response arrives.
 *
 * @example
 * ```ts
 * const client = new UnixSocketRpcClient("weather_us");
 * // Connects to /tmp/langgraph-glove-weather_us.sock
 * await client.connect();
 * const result = await client.call("weather_us", { location: "New York" });
 * ```
 */
export class UnixSocketRpcClient extends RpcClient {
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private readBuffer = "";
  readonly socketPath: string;

  constructor(readonly name: string) {
    super();
    this.socketPath = socketPathForTool(name);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let connected = false;
      const sock = net.createConnection({ path: this.socketPath }, () => {
        connected = true;
        resolve();
      });

      sock.on("error", (err) => {
        if (!connected) {
          // Still in the connection phase
          reject(err);
        } else {
          this.rejectAll(err);
        }
      });

      sock.on("data", (data) => {
        this.readBuffer += data.toString("utf8");
        const lines = this.readBuffer.split("\n");
        // Last element is an incomplete line (possibly empty)
        this.readBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response: RpcResponse = JSON.parse(line);
            this.handleResponse(response);
          } catch {
            // Malformed frame — drop it
          }
        }
      });

      sock.on("close", () => {
        this.rejectAll(new Error("Unix socket closed"));
        this.socket = null;
      });

      this.socket = sock;
    });
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }
      this.socket.destroy();
      this.socket = null;
      resolve();
    });
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.socket) {
      throw new Error("UnixSocketRpcClient: not connected — call connect() first");
    }

    const id = uuidv4();
    const request: RpcRequest = { id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(JSON.stringify(request) + "\n", "utf8", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);

    if (response.error !== undefined) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response.result);
    }
  }

  private rejectAll(err: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }
}
