import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import {
  GatewayContentUploadClient,
  type ContentUploadAuthPayload,
  type ToolMetadata,
} from "@langgraph-glove/tool-server";
import { containerManager } from "../ContainerManager.js";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_UPLOAD_MAX_FILES = 5;
const MAX_UPLOAD_MAX_FILES = 20;
const DEFAULT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB
const MAX_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB
const DEFAULT_UPLOAD_CHUNK_BYTES = 256 * 1024;

const execFileAsync = promisify(execFile);

interface ExecResult {
  output: string;
  exitCode: number;
  truncated: boolean;
}

interface UploadArtifact {
  containerPath: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  contentRef?: string;
  sha256?: string;
  status: "uploaded" | "skipped";
  reason?: string;
}

function readUploadAuth(params: Record<string, unknown>): ContentUploadAuthPayload {
  const raw = params["contentUploadAuth"];
  if (!raw || typeof raw !== "object") {
    throw new Error("docker_exec: missing runtime contentUploadAuth payload");
  }

  const payload = raw as Record<string, unknown>;
  if (typeof payload.token !== "string") {
    throw new Error("docker_exec: invalid contentUploadAuth.token");
  }
  if (typeof payload.expiresAt !== "string") {
    throw new Error("docker_exec: invalid contentUploadAuth.expiresAt");
  }
  if (payload.transport !== "http" && payload.transport !== "unix-socket") {
    throw new Error("docker_exec: invalid contentUploadAuth.transport");
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

function inferMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".log":
    case ".md":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    default:
      return "application/octet-stream";
  }
}

function normalizeUploadPaths(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("docker_exec: 'uploadPaths' must be an array of absolute file paths");
  }

  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error("docker_exec: every uploadPaths entry must be a string");
    }

    const path = item.trim();
    if (!path) continue;
    if (!path.startsWith("/tmp/")) {
      throw new Error(
        `docker_exec: upload path '${path}' is not allowed. Only /tmp/<unique-subdir>/... paths are permitted`,
      );
    }
    if (path.includes("..")) {
      throw new Error(`docker_exec: upload path '${path}' is invalid`);
    }

    const match = path.match(/^\/tmp\/([^/]+)\/.+/);
    if (!match || !match[1]) {
      throw new Error(
        `docker_exec: upload path '${path}' must include a unique run subdirectory, e.g. /tmp/run-123/output.png`,
      );
    }

    unique.add(path);
  }

  return [...unique];
}

function collectInferredUploadPaths(command: string, output: string): string[] {
  const matches = `${command}\n${output}`.match(/\/tmp\/[^/\s"'`]+\/[^\s"'`]+/g) ?? [];
  const unique = new Set<string>();

  for (const rawPath of matches) {
    const cleaned = rawPath.replace(/[),.;:!?]+$/g, "");
    try {
      for (const validPath of normalizeUploadPaths([cleaned])) {
        unique.add(validPath);
      }
    } catch {
      // Best-effort inference only.
    }
  }

  return [...unique];
}

function readUploadMaxFiles(value: unknown): number {
  if (value == null) return DEFAULT_UPLOAD_MAX_FILES;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("docker_exec: 'uploadMaxFiles' must be an integer");
  }
  if (value < 1 || value > MAX_UPLOAD_MAX_FILES) {
    throw new Error(`docker_exec: 'uploadMaxFiles' must be between 1 and ${MAX_UPLOAD_MAX_FILES}`);
  }
  return value;
}

function readUploadMaxBytes(value: unknown): number {
  if (value == null) return DEFAULT_UPLOAD_MAX_BYTES;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("docker_exec: 'uploadMaxBytes' must be an integer number of bytes");
  }
  if (value < 1 || value > MAX_UPLOAD_MAX_BYTES) {
    throw new Error(`docker_exec: 'uploadMaxBytes' must be between 1 and ${MAX_UPLOAD_MAX_BYTES}`);
  }
  return value;
}

export const execContainerToolMetadata: ToolMetadata = {
  name: "docker_exec",
  description:
    "Use {name} to execute a command inside a running docker container. " +
    "The container must have been created with docker_create_container and referenced by its tool-managed reference. " +
    "stdout and stderr are both captured and returned. " +
    "IMPORTANT: If the command generates any output files (images, documents, data files, etc.), you MUST: " +
    "(1) specify the location of the files under a unique run-specific subdirectory in /tmp (for example /tmp/run-<uuid>/artifact.png), " +
    "(2) include all specified file paths in the uploadPaths parameter as a string array so the files are uploaded and accessible. " +
    "Always include uploadPaths when the script will create a file — the files will be lost otherwise.",
  supportsContentUpload: true,
  parameters: {
    type: "object",
    properties: {
      containerId: {
        type: "string",
        description: "The tool-managed container reference returned by docker_create_container.",
      },
      command: {
        type: "string",
        description:
          "Shell command to execute inside the container, e.g. 'ls /app' or 'python --version'. " +
          "Executed via /bin/sh -c inside the container. " +
          "When the command generates output files, write them to a unique subdirectory under /tmp (e.g. /tmp/run-<uuid>/output.png) " +
          "and always include those paths in the uploadPaths parameter.",
      },
      timeout: {
        type: "number",
        description:
          `Maximum execution time in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}. Maximum ${MAX_TIMEOUT_SECONDS}.`,
      },
      uploadPaths: {
        type: "array",
        items: { type: "string" },
        description:
          "REQUIRED when the command generates any files. " +
          "List of absolute file paths inside the docker container.  These files will be uploaded upon command execution. " +
          "Every path must be under /tmp with a unique run-specific subdirectory (e.g. /tmp/run-<uuid>/output.png). " +
          "Paths directly under /tmp (no subdirectory) or outside /tmp are rejected. " +
          "If you generate files and omit this parameter, the files will not be accessible.",
      },
      uploadMaxFiles: {
        type: "number",
        description:
          `Safety cap for how many files can be uploaded from uploadPaths. Defaults to ${DEFAULT_UPLOAD_MAX_FILES}, max ${MAX_UPLOAD_MAX_FILES}.`,
      },
      uploadMaxBytes: {
        type: "number",
        description:
          `Safety cap for total uploaded bytes across all files. Defaults to ${DEFAULT_UPLOAD_MAX_BYTES} bytes, max ${MAX_UPLOAD_MAX_BYTES}.`,
      },
    },
    required: ["containerId", "command"],
  },
};

export async function handleExecContainer(
  params: Record<string, unknown>,
): Promise<string> {
  const containerId = typeof params["containerId"] === "string" ? params["containerId"].trim() : "";
  if (!containerId) {
    throw new Error("docker_exec: 'containerId' parameter is required and must be a non-empty string");
  }

  const command = typeof params["command"] === "string" ? params["command"] : "";
  if (!command) {
    throw new Error("docker_exec: 'command' parameter is required and must be a non-empty string");
  }

  const timeoutSeconds = Math.min(
    typeof params["timeout"] === "number" ? params["timeout"] : DEFAULT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
  );
  const providedUploadPaths = normalizeUploadPaths(params["uploadPaths"]);
  const uploadMaxFiles = readUploadMaxFiles(params["uploadMaxFiles"]);
  const uploadMaxBytes = readUploadMaxBytes(params["uploadMaxBytes"]);

  const record = containerManager.get(containerId);
  if (!record) {
    throw new Error(
      `docker_exec: no container found with reference "${containerId}". ` +
      "It may have expired or been stopped. Use docker_list_containers to see available containers.",
    );
  }

  const execResult = await runCommand(record.dockerId, command, timeoutSeconds);

  const inferredUploadPaths =
    providedUploadPaths.length > 0
      ? []
      : collectInferredUploadPaths(command, execResult.output);
  const uploadPaths =
    providedUploadPaths.length > 0 ? providedUploadPaths : inferredUploadPaths;

  if (execResult.exitCode !== 0 && execResult.output.includes("No such container:")) {
    await containerManager.remove(containerId);
    throw new Error(
      `docker_exec: container reference "${containerId}" is stale because the underlying container no longer exists. Create a new container and retry.`,
    );
  }

  const artifacts = await uploadArtifactsFromContainer({
    params,
    dockerId: record.dockerId,
    uploadPaths,
    uploadMaxFiles,
    uploadMaxBytes,
  });

  return JSON.stringify({
    commandOutput: execResult.output,
    exitCode: execResult.exitCode,
    outputTruncated: execResult.truncated,
    inferredUploadPaths,
    artifacts,
  });
}

async function runCommand(
  dockerId: string,
  command: string,
  timeoutSeconds: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let settled = false;

    const child = spawn("docker", ["exec", dockerId, "/bin/sh", "-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onData = (chunk: Buffer) => {
      if (truncated) return;
      if (totalBytes + chunk.length > MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - totalBytes;
        chunks.push(chunk.subarray(0, remaining));
        truncated = true;
      } else {
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(`docker_exec: command timed out after ${timeoutSeconds}s — '${command}'`),
      );
    }, timeoutSeconds * 1000);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`docker_exec: failed to run command — ${err.message}`));
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      const truncationNote = truncated ? `\n[Output truncated at ${MAX_OUTPUT_BYTES / 1024} KiB]` : "";
      const exitNote = code !== 0 ? `\n[Exit code: ${code}]` : "";
      resolve({
        output: output + truncationNote + exitNote,
        exitCode: code ?? 0,
        truncated,
      });
    });
  });
}

async function uploadArtifactsFromContainer(args: {
  params: Record<string, unknown>;
  dockerId: string;
  uploadPaths: string[];
  uploadMaxFiles: number;
  uploadMaxBytes: number;
}): Promise<{
  requestedUploadPaths: string[];
  uploadMaxFiles: number;
  uploadMaxBytes: number;
  uploadedTotalBytes: number;
  generatedFiles: UploadArtifact[];
}> {
  const generatedFiles: UploadArtifact[] = [];
  let uploadedTotalBytes = 0;

  if (args.uploadPaths.length === 0) {
    return {
      requestedUploadPaths: [],
      uploadMaxFiles: args.uploadMaxFiles,
      uploadMaxBytes: args.uploadMaxBytes,
      uploadedTotalBytes,
      generatedFiles,
    };
  }

  const uploadAuth = readUploadAuth(args.params);
  if (!uploadAuth) {
    for (const containerPath of args.uploadPaths) {
      generatedFiles.push({
        containerPath,
        status: "skipped",
        reason:
          "Upload skipped: missing runtime contentUploadAuth payload. Run via gateway tool-call flow that injects upload auth.",
      });
    }

    return {
      requestedUploadPaths: args.uploadPaths,
      uploadMaxFiles: args.uploadMaxFiles,
      uploadMaxBytes: args.uploadMaxBytes,
      uploadedTotalBytes,
      generatedFiles,
    };
  }

  const uploadClient = new GatewayContentUploadClient(uploadAuth);
  const stagingDir = await mkdtemp(join(tmpdir(), `glove-docker-exec-upload-${randomUUID()}-`));

  try {
    const cappedPaths = args.uploadPaths.slice(0, args.uploadMaxFiles);
    for (const skipped of args.uploadPaths.slice(args.uploadMaxFiles)) {
      generatedFiles.push({
        containerPath: skipped,
        status: "skipped",
        reason: `Skipped due to uploadMaxFiles=${args.uploadMaxFiles}`,
      });
    }

    for (const containerPath of cappedPaths) {
      const stagedPath = join(stagingDir, basename(containerPath));

      try {
        await execFileAsync("docker", ["cp", `${args.dockerId}:${containerPath}`, stagedPath]);
      } catch (err) {
        generatedFiles.push({
          containerPath,
          status: "skipped",
          reason: `Unable to copy file from container: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      let fileStats;
      try {
        fileStats = await stat(stagedPath);
      } catch (err) {
        generatedFiles.push({
          containerPath,
          status: "skipped",
          reason: `Unable to stat staged file: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      if (!fileStats.isFile()) {
        generatedFiles.push({
          containerPath,
          status: "skipped",
          reason: "Path is not a file",
        });
        continue;
      }

      if (uploadedTotalBytes + fileStats.size > args.uploadMaxBytes) {
        generatedFiles.push({
          containerPath,
          fileName: basename(containerPath),
          sizeBytes: fileStats.size,
          status: "skipped",
          reason: `Skipped due to uploadMaxBytes=${args.uploadMaxBytes}`,
        });
        continue;
      }

      const fileBuffer = await readFile(stagedPath);
      const sha256 = createHash("sha256").update(fileBuffer).digest("hex");
      const mimeType = inferMimeType(containerPath);

      const init = await uploadClient.initUpload({
        fileName: basename(containerPath),
        mimeType,
        expectedBytes: fileBuffer.byteLength,
      });

      try {
        let chunkIndex = 0;
        for (let offset = 0; offset < fileBuffer.byteLength; offset += DEFAULT_UPLOAD_CHUNK_BYTES) {
          const chunk = fileBuffer.subarray(
            offset,
            Math.min(offset + DEFAULT_UPLOAD_CHUNK_BYTES, fileBuffer.byteLength),
          );
          await uploadClient.appendChunk(init.uploadId, chunkIndex, chunk);
          chunkIndex += 1;
        }

        const finalized = await uploadClient.finalizeUpload(init.uploadId, sha256);
        uploadedTotalBytes += fileBuffer.byteLength;

        generatedFiles.push({
          containerPath,
          fileName: finalized.fileName ?? basename(containerPath),
          mimeType: finalized.mimeType ?? mimeType,
          sizeBytes: finalized.byteLength,
          contentRef: finalized.contentRef,
          sha256,
          status: "uploaded",
        });
      } catch (err) {
        await uploadClient.abortUpload(init.uploadId).catch(() => {});
        generatedFiles.push({
          containerPath,
          fileName: basename(containerPath),
          sizeBytes: fileBuffer.byteLength,
          status: "skipped",
          reason: `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    requestedUploadPaths: args.uploadPaths,
    uploadMaxFiles: args.uploadMaxFiles,
    uploadMaxBytes: args.uploadMaxBytes,
    uploadedTotalBytes,
    generatedFiles,
  };
}
