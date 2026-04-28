import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import type {
  Agent365RelayConfig,
  Agent365RelayOptions,
  Agent365RelayStats,
  ObservabilityIngressPayload,
} from "./types.js";

const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;

export class Agent365Relay {
  private httpServer?: http.Server;
  private unixServer?: net.Server;
  private readonly stats: Agent365RelayStats = {
    received: 0,
    forwarded: 0,
    forwardFailures: 0,
    sdkIngested: 0,
    sdkIngestFailures: 0,
  };

  constructor(
    private readonly config: Agent365RelayConfig,
    private readonly options: Agent365RelayOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.config.ingress.http.enabled) {
      await this.startHttpServer();
    }
    if (this.config.ingress.unixSocket.enabled) {
      await this.startUnixServer();
    }
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.stopHttpServer(),
      this.stopUnixServer(),
    ]);
  }

  getStats(): Agent365RelayStats {
    return { ...this.stats };
  }

  private async startHttpServer(): Promise<void> {
    const { host, port, path } = this.config.ingress.http;

    this.httpServer = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, stats: this.getStats() }));
        return;
      }

      if (req.method !== "POST" || req.url !== path) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      try {
        const payload = await readJsonBody(req, MAX_HTTP_BODY_BYTES) as ObservabilityIngressPayload;
        await this.handleIngressPayload(payload);
        res.statusCode = 202;
        res.end("accepted");
      } catch (error) {
        res.statusCode = 400;
        res.end(error instanceof Error ? error.message : String(error));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once("error", reject);
      this.httpServer?.listen(port, host, () => resolve());
    });

    console.log(`[observe-agent365] HTTP ingress listening on http://${host}:${port}${path}`);
  }

  private async startUnixServer(): Promise<void> {
    const socketPath = this.config.ingress.unixSocket.socketPath;
    try {
      await fs.unlink(socketPath);
    } catch {
      // Ignore missing socket file.
    }

    this.unixServer = net.createServer((socket) => {
      let buffer = "";

      socket.on("data", async (chunk) => {
        buffer += chunk.toString("utf8");
        const frames = buffer.split("\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const trimmed = frame.trim();
          if (!trimmed) continue;

          try {
            const payload = JSON.parse(trimmed) as ObservabilityIngressPayload;
            await this.handleIngressPayload(payload);
          } catch (error) {
            console.error("[observe-agent365] Invalid unix ingress frame", error);
          }
        }
      });

      socket.on("error", (error) => {
        console.error("[observe-agent365] Unix ingress socket error", error);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.unixServer?.once("error", reject);
      this.unixServer?.listen(socketPath, () => resolve());
    });

    console.log(`[observe-agent365] Unix ingress listening on ${socketPath}`);
  }

  private async stopHttpServer(): Promise<void> {
    if (!this.httpServer) return;
    await new Promise<void>((resolve, reject) => {
      this.httpServer?.close((error) => (error ? reject(error) : resolve()));
    });
    this.httpServer = undefined;
  }

  private async stopUnixServer(): Promise<void> {
    if (!this.unixServer) return;
    await new Promise<void>((resolve, reject) => {
      this.unixServer?.close((error) => (error ? reject(error) : resolve()));
    });
    this.unixServer = undefined;
  }

  private async handleIngressPayload(payload: ObservabilityIngressPayload): Promise<void> {
    this.stats.received += 1;

    if (this.options.onIngressPayload) {
      try {
        await this.options.onIngressPayload(payload);
        this.stats.sdkIngested += 1;
      } catch (error) {
        this.stats.sdkIngestFailures += 1;
        console.error("[observe-agent365] SDK ingest failed", error);
      }
    }

    try {
      await this.forwardToAgent365(payload);
      this.stats.forwarded += 1;
    } catch (error) {
      this.stats.forwardFailures += 1;
      throw error;
    }
  }

  private async forwardToAgent365(payload: ObservabilityIngressPayload): Promise<void> {
    const forward = this.config.forward;
    switch (forward.transport) {
      case "none":
        return;
      case "http": {
        const target = forward.http;
        if (!target?.url) {
          throw new Error("Agent365 HTTP forward transport is missing url");
        }
        await postJson(target.url, payload, target.authToken, target.timeoutMs ?? 5000);
        return;
      }
      case "unix-socket": {
        const target = forward.unixSocket;
        if (!target?.socketPath) {
          throw new Error("Agent365 unix-socket forward transport is missing socketPath");
        }
        await writeUnixJson(target.socketPath, payload, target.timeoutMs ?? 5000);
        return;
      }
      default:
        throw new Error(`Unsupported Agent365 forward transport: ${String((forward as { transport?: unknown }).transport)}`);
    }
  }
}

function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Payload exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

async function postJson(
  url: string,
  payload: unknown,
  authToken: string | undefined,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (authToken) {
      headers.authorization = `Bearer ${authToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Forward HTTP failed: ${response.status} ${response.statusText}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function writeUnixJson(socketPath: string, payload: unknown, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    socket.setTimeout(timeoutMs, () => {
      fail(new Error(`Forward unix socket timeout after ${timeoutMs}ms`));
    });

    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (error) {
          fail(error);
          return;
        }
        socket.end();
      });
    });

    socket.once("close", () => {
      finish();
    });
  });
}
