import { spawn } from "node:child_process";
import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { validatePrivilegeGrant } from "../validatePrivilegeGrant";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB

export const shellCommandToolMetadata: ToolMetadata = {
  name: "admin_shell",
  description:
    "Use {name} to run an arbitrary shell command on the host and return its output. " +
    "stdout and stderr are both captured and returned. " +
    "The command is executed with /bin/sh so shell features such as pipes, " +
    "redirections, and environment variable expansion are available. " +
    "Use with caution — this tool has full access to the host shell environment. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation and are injected from runtime privileged context. Do not ask the user to provide them.",
  parameters: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        description: "Conversation thread ID for this privileged execution (auto-injected by runtime context).",
      },
      privilegeGrantId: {
        type: "string",
        description: "Short-lived privileged-access grant ID (auto-injected by runtime context).",
      },
      command: {
        type: "string",
        description:
          "Shell command to execute, e.g. 'ls -la /tmp' or 'cat config/agents.json | jq .'",
      },
      timeout: {
        type: "number",
        description: `Maximum execution time in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}. Maximum ${MAX_TIMEOUT_SECONDS}.`,
      },
    },
    required: ["conversationId", "privilegeGrantId", "command"],
  },
};

export async function handleShellCommand(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const command = params["command"] as string;
  const timeoutSeconds = Math.min(
    typeof params["timeout"] === "number" ? params["timeout"] : DEFAULT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
  );

  if (!command || typeof command !== "string") {
    throw new Error("admin_shell: 'command' parameter is required and must be a string");
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let settled = false;

    const child = spawn("/bin/sh", ["-c", command], {
      env: process.env,
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

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `admin_shell: command timed out after ${timeoutSeconds}s — '${command}'`,
        ),
      );
    }, timeoutSeconds * 1000);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`admin_shell: failed to spawn command — ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      const truncationNote = truncated
        ? `\n[Output truncated at ${MAX_OUTPUT_BYTES / 1024} KiB]`
        : "";
      const exitNote = code !== 0 ? `\n[Exit code: ${code}]` : "";
      resolve(output + truncationNote + exitNote);
    });
  });
}
