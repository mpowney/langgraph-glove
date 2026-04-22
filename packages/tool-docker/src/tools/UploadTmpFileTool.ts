import { basename } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ContentUploadAuthPayload, ToolMetadata } from "@langgraph-glove/tool-server";
import { GatewayContentUploadClient } from "@langgraph-glove/tool-server";

const DEFAULT_CHUNK_BYTES = 256 * 1024;

function readUploadAuth(params: Record<string, unknown>): ContentUploadAuthPayload {
  const raw = params["contentUploadAuth"];
  if (!raw || typeof raw !== "object") {
    throw new Error("docker_upload_tmp_file: missing runtime contentUploadAuth payload");
  }

  const payload = raw as Record<string, unknown>;
  if (typeof payload.token !== "string") {
    throw new Error("docker_upload_tmp_file: invalid contentUploadAuth.token");
  }
  if (typeof payload.expiresAt !== "string") {
    throw new Error("docker_upload_tmp_file: invalid contentUploadAuth.expiresAt");
  }
  if (payload.transport !== "http" && payload.transport !== "unix-socket") {
    throw new Error("docker_upload_tmp_file: invalid contentUploadAuth.transport");
  }

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    transport: payload.transport,
    ...(typeof payload.gatewayBaseUrl === "string"
      ? { gatewayBaseUrl: payload.gatewayBaseUrl }
      : {}),
    ...(typeof payload.socketName === "string"
      ? { socketName: payload.socketName }
      : {}),
  };
}

export const uploadTmpFileToolMetadata: ToolMetadata = {
  name: "docker_upload_tmp_file",
  description:
    "Use {name} to upload a generated file from the tool host tmp directory to the gateway content store. "
    + "This is intended for artifacts produced by docker workflows (images, PDFs, documents). "
    + "The gateway returns a durable content reference for channel delivery.",
  supportsContentUpload: true,
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to a generated file on the tool host, typically under /tmp.",
      },
      mimeType: {
        type: "string",
        description: "Optional MIME type hint, e.g. image/png or application/pdf.",
      },
      fileName: {
        type: "string",
        description: "Optional override filename for downstream channel display/download.",
      },
      chunkBytes: {
        type: "number",
        description: "Optional upload chunk size in bytes. Defaults to 262144.",
      },
    },
    required: ["filePath"],
  },
};

export async function handleUploadTmpFile(
  params: Record<string, unknown>,
): Promise<string> {
  const filePath = typeof params["filePath"] === "string" ? params["filePath"].trim() : "";
  if (!filePath) {
    throw new Error("docker_upload_tmp_file: 'filePath' is required");
  }
  if (!filePath.startsWith("/tmp/")) {
    throw new Error("docker_upload_tmp_file: only /tmp paths are allowed");
  }

  const mimeType = typeof params["mimeType"] === "string" ? params["mimeType"].trim() : undefined;
  const fileName = typeof params["fileName"] === "string" ? params["fileName"].trim() : undefined;
  const chunkBytesRaw = typeof params["chunkBytes"] === "number" ? params["chunkBytes"] : DEFAULT_CHUNK_BYTES;
  const chunkBytes = Number.isFinite(chunkBytesRaw) && chunkBytesRaw > 0
    ? Math.floor(chunkBytesRaw)
    : DEFAULT_CHUNK_BYTES;

  const uploadAuth = readUploadAuth(params);
  const uploadClient = new GatewayContentUploadClient(uploadAuth);
  const fileBuffer = await readFile(filePath);
  const sha256 = createHash("sha256").update(fileBuffer).digest("hex");

  const init = await uploadClient.initUpload({
    fileName: fileName && fileName.length > 0 ? fileName : basename(filePath),
    mimeType,
    expectedBytes: fileBuffer.byteLength,
  });

  try {
    let chunkIndex = 0;
    for (let offset = 0; offset < fileBuffer.byteLength; offset += chunkBytes) {
      const chunk = fileBuffer.subarray(offset, Math.min(offset + chunkBytes, fileBuffer.byteLength));
      await uploadClient.appendChunk(init.uploadId, chunkIndex, chunk);
      chunkIndex += 1;
    }

    const finalized = await uploadClient.finalizeUpload(init.uploadId, sha256);

    return JSON.stringify({
      uploadId: finalized.uploadId,
      contentRef: finalized.contentRef,
      fileName: finalized.fileName,
      mimeType: finalized.mimeType,
      byteLength: finalized.byteLength,
      sha256,
    });
  } catch (err) {
    await uploadClient.abortUpload(init.uploadId).catch(() => {});
    throw err;
  }
}
