import net from "node:net";
import fs from "node:fs/promises";
import type { RpcRequest, RpcResponse } from "../rpc/RpcProtocol";

export function contentSocketPathForName(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `/tmp/langgraph-glove-${safe}.sock`;
}

export interface GatewayContentUnixSocketServerConfig {
  socketName: string;
  handler: (request: RpcRequest) => Promise<RpcResponse>;
}

/**
 * Lightweight NDJSON RPC server for internal gateway content upload calls.
 */
export class GatewayContentUnixSocketServer {
  private readonly socketPath: string;
  private readonly server: net.Server;

  constructor(private readonly config: GatewayContentUnixSocketServerConfig) {
    this.socketPath = contentSocketPathForName(config.socketName);
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  async start(): Promise<void> {
    try {
      await fs.unlink(this.socketPath);
    } catch {
      // Socket file did not exist.
    }

    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        void fs.unlink(this.socketPath).catch(() => {});
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        void this.handleLine(line, socket);
      }
    });

    socket.on("error", () => {
      // Ignore per-socket errors; caller receives disconnect.
    });
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      if (socket.writable) {
        socket.write(
          JSON.stringify({ id: "unknown", error: "Invalid RPC request JSON" } satisfies RpcResponse) + "\n",
          "utf8",
        );
      }
      return;
    }

    const response = await this.config.handler(request);
    if (socket.writable) {
      socket.write(JSON.stringify(response) + "\n", "utf8");
    }
  }
}
