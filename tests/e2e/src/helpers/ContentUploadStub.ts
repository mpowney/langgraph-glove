/**
 * Minimal in-process HTTP stub for the gateway content-upload RPC endpoint.
 *
 * When the real gateway is not running (E2E_CONTENT_UPLOAD_URL is not set),
 * the tests start this stub so that tools which require `supportsContentUpload`
 * can still exercise their code paths up to and including the upload phase.
 *
 * The stub:
 *   - Accepts `__content_upload_init__`, `__content_upload_chunk__`,
 *     `__content_upload_finalize__`, and `__content_upload_abort__` RPC calls
 *     at `POST /api/internal/content/rpc`.
 *   - Stores upload chunks in memory.
 *   - Returns plausible-looking responses so the tool handler can complete.
 *
 * Usage:
 *   const stub = new ContentUploadStub();
 *   await stub.start();                   // picks a random available port
 *   const auth = stub.makeUploadAuth();   // build the contentUploadAuth payload
 *   // ... run tests ...
 *   await stub.stop();
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

interface PendingUpload {
  fileName?: string;
  mimeType?: string;
  expectedBytes?: number;
  ttlSeconds?: number;
  chunks: Map<number, string>; // chunkIndex → base64
  contentRef: string;
  expiresAt: string;
}

function makeExpiresAt(ttlSeconds = 300): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

export class ContentUploadStub {
  private server?: http.Server;
  private port?: number;
  private readonly uploads = new Map<string, PendingUpload>();

  /** Start the stub on a random available port. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("ContentUploadStub: unexpected address type"));
          return;
        }
        this.port = addr.port;
        this.server = srv;
        resolve();
      });
    });
  }

  /** Stop the stub server. */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Base URL of the stub server (e.g. "http://127.0.0.1:54321"). */
  get baseUrl(): string {
    if (!this.port) throw new Error("ContentUploadStub is not started");
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Build a `contentUploadAuth` payload that points to this stub.
   * Pass this as a parameter when calling tools that require content upload.
   */
  makeUploadAuth(): Record<string, unknown> {
    return {
      token: "e2e-test-stub-token",
      expiresAt: makeExpiresAt(3600),
      transport: "http",
      gatewayBaseUrl: this.baseUrl,
    };
  }

  /** How many uploads were finalized (useful for assertions). */
  get finalizedCount(): number {
    return [...this.uploads.values()].filter((u) => u.chunks.size > 0 || u.expectedBytes === 0).length;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/api/internal/content/rpc") {
      res.writeHead(404).end("Not found");
      return;
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let parsed: { id?: string; method?: string; params?: Record<string, unknown> };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const { id = "unknown", method = "", params = {} } = parsed;

    try {
      const result = this.dispatchRpc(method, params);
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ id, result }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ id, error: message }),
      );
    }
  }

  private dispatchRpc(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "__content_upload_init__": {
        const uploadId = randomUUID();
        const contentRef = `test-content-ref:${uploadId}`;
        const ttl = typeof params["ttlSeconds"] === "number" ? params["ttlSeconds"] : 300;
        this.uploads.set(uploadId, {
          fileName: typeof params["fileName"] === "string" ? params["fileName"] : undefined,
          mimeType: typeof params["mimeType"] === "string" ? params["mimeType"] : undefined,
          expectedBytes: typeof params["expectedBytes"] === "number" ? params["expectedBytes"] : undefined,
          ttlSeconds: ttl,
          chunks: new Map(),
          contentRef,
          expiresAt: makeExpiresAt(ttl),
        });
        return {
          uploadId,
          contentRef,
          expiresAt: this.uploads.get(uploadId)!.expiresAt,
        };
      }

      case "__content_upload_chunk__": {
        const uploadId = params["uploadId"];
        if (typeof uploadId !== "string") throw new Error("Missing uploadId");
        const upload = this.uploads.get(uploadId);
        if (!upload) throw new Error(`Unknown uploadId: ${uploadId}`);
        const chunkIndex = typeof params["chunkIndex"] === "number" ? params["chunkIndex"] : 0;
        const dataBase64 = typeof params["dataBase64"] === "string" ? params["dataBase64"] : "";
        upload.chunks.set(chunkIndex, dataBase64);
        const receivedBytes = Buffer.from(dataBase64, "base64").byteLength;
        return { receivedBytes };
      }

      case "__content_upload_finalize__": {
        const uploadId = params["uploadId"];
        if (typeof uploadId !== "string") throw new Error("Missing uploadId");
        const upload = this.uploads.get(uploadId);
        if (!upload) throw new Error(`Unknown uploadId: ${uploadId}`);
        const totalBytes = [...upload.chunks.values()].reduce(
          (sum, b64) => sum + Buffer.from(b64, "base64").byteLength,
          0,
        );
        return {
          uploadId,
          contentRef: upload.contentRef,
          byteLength: totalBytes,
          mimeType: upload.mimeType,
          fileName: upload.fileName,
        };
      }

      case "__content_upload_abort__": {
        const uploadId = params["uploadId"];
        if (typeof uploadId !== "string") throw new Error("Missing uploadId");
        this.uploads.delete(uploadId);
        return { aborted: true };
      }

      default:
        throw new Error(`ContentUploadStub: unknown method "${method}"`);
    }
  }
}
