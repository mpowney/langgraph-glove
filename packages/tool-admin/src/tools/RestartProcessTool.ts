import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { validatePrivilegeGrant } from "../validatePrivilegeGrant";

const execFileAsync = promisify(execFile);

/** Resolve the root directory of the project at runtime. */
function resolveRootDir(): string {
  // The PID file written by tools-bg.sh lives at <root>/logs/tool-processes.pids.
  // Walk up from GLOVE_CONFIG_DIR (or cwd) to find the project root.
  const configDir = path.resolve(process.env["GLOVE_CONFIG_DIR"] ?? "config");
  return path.dirname(configDir);
}

export const restartProcessToolMetadata: ToolMetadata = {
  name: "admin_restart_process",
  description:
    "Use {name} to restart the core gateway process or a named tool server process. " +
    "For tool servers pass the tool key as used in tools.json (e.g. 'weather-us', 'browse'). " +
    "Pass 'core' to restart the main gateway process. " +
    "The process receives SIGTERM so it can shut down gracefully; " +
    "re-launch must be handled by the process manager or shell session. " +
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
      process: {
        type: "string",
        description:
          "Name of the process to restart. Use 'core' for the gateway, " +
          "or a tool key such as 'weather-us', 'browse', 'search', etc.",
      },
      signal: {
        type: "string",
        enum: ["SIGTERM", "SIGKILL"],
        description: "Signal to send. Defaults to SIGTERM.",
      },
    },
    required: ["conversationId", "privilegeGrantId", "process"],
  },
};

export async function handleRestartProcess(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const processName = params["process"] as string;
  const signal = ((params["signal"] as string | undefined) ?? "SIGTERM") as NodeJS.Signals;

  if (!processName || typeof processName !== "string") {
    throw new Error(
      "admin_restart_process: 'process' parameter is required and must be a string",
    );
  }

  if (signal !== "SIGTERM" && signal !== "SIGKILL") {
    throw new Error(
      "admin_restart_process: 'signal' must be 'SIGTERM' or 'SIGKILL'",
    );
  }

  // Special case: restart this very admin tool process or the core gateway.
  if (processName === "core") {
    return await restartCoreProcess(signal);
  }

  return await restartToolProcess(processName, signal);
}

/** Send a signal to the core gateway by matching its command-line pattern. */
async function restartCoreProcess(signal: NodeJS.Signals): Promise<string> {
  // The core is started as: node packages/core/dist/main.js
  // Use pgrep to find its PID.
  try {
    const { stdout } = await execFileAsync("pgrep", [
      "-f",
      "packages/core/dist/main",
    ]);
    const pids = stdout.trim().split(/\s+/).filter(Boolean);
    if (pids.length === 0) {
      return "admin_restart_process: no running 'core' process found.";
    }
    for (const pid of pids) {
      process.kill(parseInt(pid, 10), signal);
    }
    return `Sent ${signal} to core process(es) (PID${pids.length > 1 ? "s" : ""}: ${pids.join(", ")}).`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "admin_restart_process: 'pgrep' is not available on this system.";
    }
    throw err;
  }
}

/** Locate a tool-server process via the PID file written by tools-bg.sh. */
async function restartToolProcess(
  toolKey: string,
  signal: NodeJS.Signals,
): Promise<string> {
  const rootDir = resolveRootDir();
  const pidFile = path.join(rootDir, "logs", "tool-processes.pids");

  let pidFileContent: string;
  try {
    pidFileContent = await fs.readFile(pidFile, "utf8");
  } catch {
    // PID file absent — fall back to pgrep
    return await restartToolByPgrep(toolKey, signal);
  }

  // Each line: tool-name:pid:log-file
  const line = pidFileContent
    .split("\n")
    .find((l) => l.startsWith(`${toolKey}:`));

  if (!line) {
    // Not found in PID file — try pgrep as fallback
    return await restartToolByPgrep(toolKey, signal);
  }

  const parts = line.split(":");
  const pid = parseInt(parts[1] ?? "", 10);

  if (isNaN(pid)) {
    throw new Error(
      `admin_restart_process: could not parse PID for '${toolKey}' from PID file.`,
    );
  }

  process.kill(pid, signal);
  return `Sent ${signal} to tool server '${toolKey}' (PID: ${pid}).`;
}

/** Fallback: locate a tool server process via pgrep matching its tsx/node invocation. */
async function restartToolByPgrep(
  toolKey: string,
  signal: NodeJS.Signals,
): Promise<string> {
  // Tool servers are typically started as: pnpm --filter ./packages/tool-<key> dev
  // or: tsx packages/tool-<key>/src/main.ts
  const pattern = `tool-${toolKey}`;
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
    const pids = stdout.trim().split(/\s+/).filter(Boolean);
    if (pids.length === 0) {
      return `admin_restart_process: no running process found for tool '${toolKey}'.`;
    }
    for (const pid of pids) {
      process.kill(parseInt(pid, 10), signal);
    }
    return `Sent ${signal} to tool '${toolKey}' process(es) (PID${pids.length > 1 ? "s" : ""}: ${pids.join(", ")}).`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "admin_restart_process: 'pgrep' is not available on this system.";
    }
    throw err;
  }
}
