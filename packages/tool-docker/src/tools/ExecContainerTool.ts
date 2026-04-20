import { spawn } from "node:child_process";
import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { containerManager } from "../ContainerManager.js";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB

export const execContainerToolMetadata: ToolMetadata = {
  name: "docker_exec",
  description:
    "Use {name} to execute a command inside a running docker container. " +
    "The container must have been created with docker_create_container and referenced by its tool-managed reference. " +
    "stdout and stderr are both captured and returned.",
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
          "Executed via /bin/sh -c inside the container.",
      },
      timeout: {
        type: "number",
        description:
          `Maximum execution time in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}. Maximum ${MAX_TIMEOUT_SECONDS}.`,
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

  const record = containerManager.get(containerId);
  if (!record) {
    throw new Error(
      `docker_exec: no container found with reference "${containerId}". ` +
      "It may have expired or been stopped. Use docker_list_containers to see available containers.",
    );
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let settled = false;

    const child = spawn("docker", ["exec", record.dockerId, "/bin/sh", "-c", command], {
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
      if (code !== 0 && output.includes("No such container:")) {
        await containerManager.remove(containerId);
        reject(
          new Error(
            `docker_exec: container reference "${containerId}" is stale because the underlying container no longer exists. Create a new container and retry.`,
          ),
        );
        return;
      }
      const truncationNote = truncated ? `\n[Output truncated at ${MAX_OUTPUT_BYTES / 1024} KiB]` : "";
      const exitNote = code !== 0 ? `\n[Exit code: ${code}]` : "";
      resolve(output + truncationNote + exitNote);
    });
  });
}
