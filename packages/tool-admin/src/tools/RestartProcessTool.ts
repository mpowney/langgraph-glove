import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { validatePrivilegeGrant } from "../validatePrivilegeGrant";

const execFileAsync = promisify(execFile);
const RESTART_LOG_PREFIX = "[admin_restart_process]";
const STOP_LOG_PREFIX = "[admin_stop_process]";

type ProcessAction = "restart" | "stop";

type ProcessControlContext = {
  action: ProcessAction;
  logPrefix: string;
  toolName: "admin_restart_process" | "admin_stop_process";
};

function logInfo(message: string): void {
  try {
    process.stdout.write(`${message}\n`);
  } catch {
    // Best-effort logging only.
  }
}

function logError(message: string, err?: unknown): void {
  try {
    const details = err ? ` ${String(err)}` : "";
    process.stderr.write(`${message}${details}\n`);
  } catch {
    // Best-effort logging only.
  }
}

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
    "The tool will stop and re-launch the process using a matching dev/prod command. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation. The user provides these by enabling privileged access.",
  parameters: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        description: "Conversation thread ID for this privileged execution.",
      },
      privilegeGrantId: {
        type: "string",
        description: "Short-lived privileged-access grant ID for this privileged execution.",
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
    required: ["process"],
  },
};

export const stopProcessToolMetadata: ToolMetadata = {
  name: "admin_stop_process",
  description:
    "Use {name} to stop the core gateway process or a named tool server process without restarting it. " +
    "For tool servers pass the tool key as used in tools.json (e.g. 'weather-us', 'browse'). " +
    "Pass 'core' to stop the main gateway process. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation. The user provides these by enabling privileged access.",
  parameters: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        description: "Conversation thread ID for this privileged execution.",
      },
      privilegeGrantId: {
        type: "string",
        description: "Short-lived privileged-access grant ID for this privileged execution.",
      },
      process: {
        type: "string",
        description:
          "Name of the process to stop. Use 'core' for the gateway, " +
          "or a tool key such as 'weather-us', 'browse', 'search', etc.",
      },
      signal: {
        type: "string",
        enum: ["SIGTERM", "SIGKILL"],
        description: "Signal to send. Defaults to SIGTERM.",
      },
    },
    required: ["process"],
  },
};

export async function handleRestartProcess(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);
  const parsed = parseProcessControlParams(params, "admin_restart_process");

  logInfo(
    `${RESTART_LOG_PREFIX} restart requested process='${parsed.processName}' signal='${parsed.signal}'`,
  );

  return await runProcessControl(
    {
      action: "restart",
      logPrefix: RESTART_LOG_PREFIX,
      toolName: "admin_restart_process",
    },
    parsed.processName,
    parsed.signal,
  );
}

export async function handleStopProcess(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);
  const parsed = parseProcessControlParams(params, "admin_stop_process");

  logInfo(
    `${STOP_LOG_PREFIX} stop requested process='${parsed.processName}' signal='${parsed.signal}'`,
  );

  return await runProcessControl(
    {
      action: "stop",
      logPrefix: STOP_LOG_PREFIX,
      toolName: "admin_stop_process",
    },
    parsed.processName,
    parsed.signal,
  );
}

function parseProcessControlParams(
  params: Record<string, unknown>,
  toolName: "admin_restart_process" | "admin_stop_process",
): { processName: string; signal: NodeJS.Signals } {
  const processName = params["process"] as string;
  const signal = ((params["signal"] as string | undefined) ?? "SIGTERM") as NodeJS.Signals;

  if (!processName || typeof processName !== "string") {
    throw new Error(
      `${toolName}: 'process' parameter is required and must be a string`,
    );
  }

  if (signal !== "SIGTERM" && signal !== "SIGKILL") {
    throw new Error(
      `${toolName}: 'signal' must be 'SIGTERM' or 'SIGKILL'`,
    );
  }

  return { processName, signal };
}

async function runProcessControl(
  context: ProcessControlContext,
  processName: string,
  signal: NodeJS.Signals,
): Promise<string> {
  if (processName === "core") {
    return await controlCoreProcess(context, signal);
  }

  return await controlToolProcess(context, processName, signal);
}

/** Send a signal to the core gateway by matching its command-line pattern. */
async function controlCoreProcess(
  context: ProcessControlContext,
  signal: NodeJS.Signals,
): Promise<string> {
  const rootDir = resolveRootDir();
  const corePatterns = ["packages/core/dist/main", "packages/core/src/main"];
  const pidSet = new Set<number>();

  logInfo(
    `${context.logPrefix} core ${context.action} start rootDir='${rootDir}' patterns=${corePatterns.join(",")}`,
  );

  for (const pattern of corePatterns) {
    const pids = await pgrep(pattern, context.logPrefix, context.toolName);
    for (const pid of pids) pidSet.add(pid);
  }

  const pids = Array.from(pidSet);
  logInfo(`${context.logPrefix} core matched pids=${pids.join(",") || "(none)"}`);
  if (pids.length === 0) {
    return `${context.toolName}: no running 'core' process found.`;
  }

  const withCommand = await loadProcessCommands(pids);
  const selected =
    withCommand.find((entry) => entry.command.includes("packages/core/src/main"))
    ?? withCommand.find((entry) => entry.command.includes("packages/core/dist/main"))
    ?? withCommand[0];

  const flags = extractCoreFlags(selected?.command ?? "");
  const restartCommand =
    selected && isCoreDevCommand(selected.command)
      ? `pnpm exec tsx packages/core/src/main.ts${flags.length ? ` ${flags.join(" ")}` : ""}`
      : `node packages/core/dist/main.js${flags.length ? ` ${flags.join(" ")}` : ""}`;

  logInfo(
    `${context.logPrefix} core selected command='${selected?.command ?? "(unknown)"}' restartCommand='${restartCommand}'`,
  );

  await stopProcesses(pids, signal, context.logPrefix);

  if (context.action === "restart") {
    await launchDetached(
      restartCommand,
      rootDir,
      runtimeEnv(rootDir),
      context.logPrefix,
      context.toolName,
    );
    return `Restarted core (killed PID${pids.length > 1 ? "s" : ""}: ${pids.join(", ")}; relaunched with: ${restartCommand}).`;
  }

  return `Stopped core (killed PID${pids.length > 1 ? "s" : ""}: ${pids.join(", ")}).`;
}

/** Locate a tool-server process via the PID file written by tools-bg.sh. */
async function controlToolProcess(
  context: ProcessControlContext,
  toolKey: string,
  signal: NodeJS.Signals,
): Promise<string> {
  const toolPackage = normalizeToolPackageName(toolKey);
  const rootDir = resolveRootDir();
  const pidFile = path.join(rootDir, "logs", "tool-processes.pids");

  logInfo(
    `${context.logPrefix} tool ${context.action} start toolKey='${toolKey}' toolPackage='${toolPackage}' pidFile='${pidFile}'`,
  );

  const pidsFromPidFile = await findToolPidsFromPidFile(pidFile, [toolKey, toolPackage]);
  const pidsFromPgrep = await findToolPidsByPgrep(toolPackage, context.logPrefix, context.toolName);
  logInfo(
    `${context.logPrefix} tool pid candidates fromPidFile=${pidsFromPidFile.join(",") || "(none)"} fromPgrep=${pidsFromPgrep.join(",") || "(none)"}`,
  );
  const pidSet = new Set<number>([...pidsFromPidFile, ...pidsFromPgrep]);
  const pids = Array.from(pidSet);

  if (pids.length === 0) {
    return `${context.toolName}: no running process found for tool '${toolKey}'.`;
  }

  const withCommand = await loadProcessCommands(pids);
  const selected =
    withCommand.find((entry) => entry.command.includes(`packages/${toolPackage}/dist/main`))
    ?? withCommand.find((entry) => entry.command.includes(`packages/${toolPackage}/src/main`))
    ?? withCommand.find((entry) => entry.command.includes(toolPackage))
    ?? withCommand[0];

  const distEntry = path.join(rootDir, "packages", toolPackage, "dist", "main.js");
  const canRunProd = await fileExists(distEntry);
  const useProd = Boolean(selected && isToolProdCommand(selected.command) && canRunProd);

  const restartCommand = useProd
    ? `node packages/${toolPackage}/dist/main.js`
    : `pnpm --filter ./packages/${toolPackage} dev`;

  logInfo(
    `${context.logPrefix} tool selected command='${selected?.command ?? "(unknown)"}' useProd=${String(useProd)} canRunProd=${String(canRunProd)} restartCommand='${restartCommand}'`,
  );

  await stopProcesses(pids, signal, context.logPrefix);

  if (context.action === "restart") {
    await launchDetached(
      restartCommand,
      rootDir,
      runtimeEnv(rootDir),
      context.logPrefix,
      context.toolName,
    );
    return `Restarted tool '${toolKey}' (killed PID${pids.length > 1 ? "s" : ""}: ${pids.join(", ")}; relaunched with: ${restartCommand}).`;
  }

  return `Stopped tool '${toolKey}' (killed PID${pids.length > 1 ? "s" : ""}: ${pids.join(", ")}).`;
}

function normalizeToolPackageName(toolKey: string): string {
  return toolKey.startsWith("tool-") ? toolKey : `tool-${toolKey}`;
}

function extractCoreFlags(command: string): string[] {
  const flags: string[] = [];
  if (command.includes("--web")) flags.push("--web");
  if (command.includes("--no-cli")) flags.push("--no-cli");
  return flags;
}

function isCoreDevCommand(command: string): boolean {
  return command.includes("packages/core/src/main") || command.includes("tsx");
}

function isToolProdCommand(command: string): boolean {
  return /\/packages\/tool-[^\s/]+\/dist\/main(?:\.js)?/.test(command);
}

async function findToolPidsFromPidFile(pidFile: string, names: string[]): Promise<number[]> {
  let pidFileContent: string;
  try {
    pidFileContent = await fs.readFile(pidFile, "utf8");
  } catch {
    return [];
  }

  const nameSet = new Set(names);
  const pids: number[] = [];
  for (const line of pidFileContent.split("\n")) {
    if (!line.trim()) continue;
    const [name, pidText] = line.split(":");
    if (!nameSet.has(name ?? "")) continue;
    const pid = parseInt(pidText ?? "", 10);
    if (!Number.isNaN(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}

async function findToolPidsByPgrep(
  toolPackage: string,
  logPrefix: string,
  toolName: string,
): Promise<number[]> {
  const pidSet = new Set<number>();
  const patterns = [toolPackage, `packages/${toolPackage}/`];
  for (const pattern of patterns) {
    const pids = await pgrep(pattern, logPrefix, toolName);
    for (const pid of pids) {
      pidSet.add(pid);
    }
  }
  return Array.from(pidSet);
}

async function pgrep(
  pattern: string,
  logPrefix: string,
  toolName: string,
): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
    const pids = stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((pidText: string) => parseInt(pidText, 10))
      .filter((pid: number) => !Number.isNaN(pid));
    logInfo(`${logPrefix} pgrep pattern='${pattern}' pids=${pids.join(",") || "(none)"}`);
    return pids;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT") {
      throw new Error(`${toolName}: 'pgrep' is not available on this system.`);
    }
    if (code === 1 || code === "1") {
      logInfo(`${logPrefix} pgrep pattern='${pattern}' no matches`);
      return [];
    }
    logError(`${logPrefix} pgrep pattern='${pattern}' failed`, err);
    throw err;
  }
}

async function getProcessCommand(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    const command = stdout.trim();
    return command.length > 0 ? command : undefined;
  } catch {
    return undefined;
  }
}

async function loadProcessCommands(
  pids: number[],
): Promise<Array<{ pid: number; command: string }>> {
  const entries: Array<{ pid: number; command: string }> = [];
  for (const pid of pids) {
    const command = await getProcessCommand(pid);
    if (command) entries.push({ pid, command });
  }
  return entries;
}

async function stopProcesses(pids: number[], signal: NodeJS.Signals, logPrefix: string): Promise<void> {
  logInfo(`${logPrefix} stopping pids=${pids.join(",") || "(none)"} signal='${signal}'`);
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      logInfo(`${logPrefix} sent signal='${signal}' pid=${pid}`);
    } catch {
      // Ignore races where the process already exited.
      logInfo(`${logPrefix} signal skipped pid=${pid} (already exited or inaccessible)`);
    }
  }

  for (const pid of pids) {
    await waitForExit(pid, 3000, logPrefix);
  }
}

async function waitForExit(pid: number, timeoutMs: number, logPrefix: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await delay(100);
    } catch {
      logInfo(`${logPrefix} pid=${pid} has exited`);
      return;
    }
  }
  logInfo(`${logPrefix} pid=${pid} still alive after wait timeoutMs=${timeoutMs}`);
}

function runtimeEnv(rootDir: string): Record<string, string | undefined> {
  const configDir = process.env["GLOVE_CONFIG_DIR"];
  const secretsDir = process.env["GLOVE_SECRETS_DIR"];
  const currentNodeDir = path.dirname(process.execPath);
  const existingPath = process.env["PATH"] ?? "";
  const pathParts = existingPath.split(":").filter(Boolean) as string[];
  const dedupedPath = [currentNodeDir, ...pathParts.filter((entry: string) => entry !== currentNodeDir)].join(":");

  return {
    ...process.env,
    // Keep restart children on the same Node runtime as this host process.
    PATH: dedupedPath,
    GLOVE_CONFIG_DIR: configDir ? path.resolve(configDir) : path.join(rootDir, "config"),
    GLOVE_SECRETS_DIR: secretsDir ? path.resolve(secretsDir) : path.join(rootDir, "secrets"),
  };
}

async function launchDetached(
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
  logPrefix: string,
  toolName: string,
): Promise<void> {
  logInfo(`${logPrefix} launching command='${command}' cwd='${cwd}'`);
  const child = spawn("sh", ["-c", command], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let settled = false;
  let stderr = "";

  const onStderrData = (chunk: unknown): void => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    stderr = (stderr + text).slice(-2000);
  };

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", onStderrData);

  const launchProbe = new Promise<void>((resolve, reject) => {
    const settleResolve = (): void => {
      if (settled) return;
      settled = true;
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.stderr?.removeListener("data", onStderrData);
      child.stderr?.destroy();
      resolve();
    };

    const settleReject = (message: string): void => {
      if (settled) return;
      settled = true;
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.stderr?.removeListener("data", onStderrData);
      child.stderr?.destroy();
      reject(new Error(message));
    };

    const onError = (err: Error): void => {
      logError(`${logPrefix} launch error command='${command}'`, err);
      settleReject(
        `${toolName}: failed to launch '${command}': ${err.message}`,
      );
    };

    const onExit = (code: number | null, termSignal: string | null): void => {
      const details = stderr.trim().length > 0
        ? ` stderr: ${stderr.trim()}`
        : "";
      logError(
        `${logPrefix} launch exited early command='${command}' code=${code ?? "null"} signal=${termSignal ?? "null"}${details}`,
      );
      settleReject(
        `${toolName}: process exited immediately for '${command}' (code=${code ?? "null"}, signal=${termSignal ?? "null"}).${details}`,
      );
    };

    child.once("error", onError);
    child.once("exit", onExit);

    // Probe resolves when process is considered healthy by time window.
    void delay(30000).then(settleResolve);
  });

  await launchProbe;

  logInfo(`${logPrefix} launch healthy command='${command}' pid=${child.pid ?? -1}`);
  child.unref();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
