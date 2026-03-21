import net from "node:net";
import fs from "node:fs/promises";
import { ToolServer } from "./ToolServer";
import type { RpcRequest } from "./RpcProtocol";

/**
 * Convert a tool name to a safe, deterministic Unix socket path.
 *
 * Non-alphanumeric characters (except `-` and `_`) are replaced with `-`
 * so the resulting filename is safe on all Unix filesystems.
 *
 * @example
 * socketPathForTool("weather_us") // "/tmp/langgraph-glove-weather_us.sock"
 */
export function socketPathForTool(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `/tmp/langgraph-glove-${safe}.sock`;
}

/**
 * A tool server that communicates via newline-delimited JSON (NDJSON) over a
 * Unix domain socket.
 *
 * Each connected client gets its own buffer so that multiple concurrent callers
 * (e.g. two parallel tool invocations) are handled independently.
 *
 * On `start()` any existing socket file at `socketPath` is removed before the
 * server begins listening, so restarts are safe.
 *
 * @example
 * ```ts
 * const server = new UnixSocketToolServer("my-tool");
 * // Listens on /tmp/langgraph-glove-my-tool.sock
 * server.register({ name: "echo", description: "Echoes input", parameters: {} },
 *   async (params) => params);
 * await server.start();
 * ```
 */
export class UnixSocketToolServer extends ToolServer {
  private server: net.Server;
  readonly socketPath: string;

  constructor(readonly name: string) {
    super();
    this.socketPath = socketPathForTool(name);
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  async start(): Promise<void> {
    // Clean up stale socket file so the .listen() call doesn't throw EADDRINUSE
    try {
      await fs.unlink(this.socketPath);
    } catch {
      // File didn't exist — that's fine
    }

    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        console.log(`[UnixSocketToolServer] Listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        let request: RpcRequest;
        try {
          request = JSON.parse(line) as RpcRequest;
        } catch {
          // Malformed frame — ignore
          continue;
        }

        const response = await this.dispatch(request);
        if (socket.writable) {
          socket.write(JSON.stringify(response) + "\n", "utf8");
        }
      }
    });

    socket.on("error", (err) => {
      console.error("[UnixSocketToolServer] Socket error:", err.message);
    });
  }
}
