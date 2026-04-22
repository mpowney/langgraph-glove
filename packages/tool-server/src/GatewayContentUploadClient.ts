import net from "node:net";
import { randomUUID } from "node:crypto";
import { socketPathForTool } from "./UnixSocketToolServer";
import type { ContentUploadAuthPayload, RpcRequest, RpcResponse } from "./RpcProtocol";

export interface InitUploadParams {
  fileName?: string;
  mimeType?: string;
  expectedBytes?: number;
  systemPromptText?: string;
  systemPromptHash?: string;
}

export interface InitUploadResult {
  uploadId: string;
  contentRef: string;
  expiresAt: string;
}

export interface FinalizeUploadResult {
  uploadId: string;
  contentRef: string;
  byteLength: number;
  mimeType?: string;
  fileName?: string;
}

/**
 * Transport-aware client for pushing tool-generated content to gateway.
 *
 * It uses the same RPC transport model as the hosting tool server:
 * - HTTP transport: POST /api/internal/content/rpc
 * - unix-socket transport: NDJSON RPC over gateway content socket
 */
export class GatewayContentUploadClient {
  constructor(private readonly auth: ContentUploadAuthPayload) {}

  async initUpload(params: InitUploadParams = {}): Promise<InitUploadResult> {
    const result = await this.call("__content_upload_init__", {
      token: this.auth.token,
      ...params,
    });
    return result as InitUploadResult;
  }

  async appendChunk(uploadId: string, chunkIndex: number, chunkData: Buffer): Promise<{ receivedBytes: number }> {
    const result = await this.call("__content_upload_chunk__", {
      token: this.auth.token,
      uploadId,
      chunkIndex,
      dataBase64: chunkData.toString("base64"),
    });
    return result as { receivedBytes: number };
  }

  async finalizeUpload(uploadId: string, sha256?: string): Promise<FinalizeUploadResult> {
    const result = await this.call("__content_upload_finalize__", {
      token: this.auth.token,
      uploadId,
      ...(sha256 ? { sha256 } : {}),
    });
    return result as FinalizeUploadResult;
  }

  async abortUpload(uploadId: string): Promise<void> {
    await this.call("__content_upload_abort__", {
      token: this.auth.token,
      uploadId,
    });
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const request: RpcRequest = {
      id: randomUUID(),
      method,
      params,
    };

    const response =
      this.auth.transport === "http"
        ? await this.callHttpRpc(request)
        : await this.callUnixSocketRpc(request);

    if (response.error) {
      throw new Error(response.error);
    }
    return response.result;
  }

  private async callHttpRpc(request: RpcRequest): Promise<RpcResponse> {
    const baseUrl = this.auth.gatewayBaseUrl?.trim();
    if (!baseUrl) {
      throw new Error("Missing gatewayBaseUrl for HTTP content upload transport");
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/internal/content/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Gateway content RPC failed: HTTP ${response.status}`);
    }

    return (await response.json()) as RpcResponse;
  }

  private async callUnixSocketRpc(request: RpcRequest): Promise<RpcResponse> {
    const socketName = this.auth.socketName?.trim();
    if (!socketName) {
      throw new Error("Missing socketName for unix-socket content upload transport");
    }

    const socketPath = socketPathForTool(socketName);
    return new Promise<RpcResponse>((resolve, reject) => {
      let readBuffer = "";
      const socket = net.createConnection({ path: socketPath }, () => {
        socket.write(`${JSON.stringify(request)}\n`, "utf8");
      });

      socket.on("data", (data) => {
        readBuffer += data.toString("utf8");
        const lines = readBuffer.split("\n");
        readBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line) as RpcResponse;
            socket.end();
            resolve(response);
            return;
          } catch {
            // Ignore malformed line and keep reading.
          }
        }
      });

      socket.on("error", (err) => {
        reject(err);
      });

      socket.on("end", () => {
        if (readBuffer.trim().length === 0) {
          return;
        }
        try {
          const response = JSON.parse(readBuffer) as RpcResponse;
          resolve(response);
        } catch {
          reject(new Error("Invalid RPC response from gateway unix-socket content endpoint"));
        }
      });

      socket.setTimeout(30_000, () => {
        socket.destroy(new Error("Timed out waiting for gateway unix-socket content RPC response"));
      });
    });
  }
}
