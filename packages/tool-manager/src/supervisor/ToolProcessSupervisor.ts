import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  ConfigLoader,
  type ToolManagerConfig,
  type ToolServerEntry,
} from "@langgraph-glove/config";
import type {
  RuntimeFileEntry,
  ToolDescriptor,
  ToolLogListener,
  ToolRuntimeState,
  ToolStatusListener,
} from "./types.js";

const DEFAULT_COMMAND_TEMPLATE = "pnpm --filter {packageName} dev";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 1500;
const DEFAULT_MAX_LOG_LINES = 1200;

export interface ToolManagerSettings {
  commandTemplate: string;
  shutdownTimeoutMs: number;
  forceKillTimeoutMs: number;
  maxLogLines: number;
}

export interface SupervisorOptions {
  rootDir: string;
  configDir?: string;
  secretsDir?: string;
  logsDir?: string;
  pidFilePath?: string;
}

export class ToolProcessSupervisor {
  private readonly rootDir: string;
  private readonly configDir: string;
  private readonly secretsDir: string;
  private readonly logsDir: string;
  private readonly pidFilePath: string;
  private readonly runtimes = new Map<string, ToolRuntimeState>();
  private readonly statusListeners = new Set<ToolStatusListener>();
  private readonly logListeners = new Set<ToolLogListener>();
  private settings: ToolManagerSettings = {
    commandTemplate: DEFAULT_COMMAND_TEMPLATE,
    shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    forceKillTimeoutMs: DEFAULT_FORCE_KILL_TIMEOUT_MS,
    maxLogLines: DEFAULT_MAX_LOG_LINES,
  };

  constructor(options: SupervisorOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.configDir = path.resolve(options.configDir ?? path.join(this.rootDir, "config"));
    this.secretsDir = path.resolve(options.secretsDir ?? path.join(this.rootDir, "secrets"));
    this.logsDir = path.resolve(options.logsDir ?? path.join(this.rootDir, "logs", "tools"));
    this.pidFilePath = path.resolve(options.pidFilePath ?? path.join(this.rootDir, "logs", "tool-processes.pids"));
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getSettings(): ToolManagerSettings {
    return { ...this.settings };
  }

  loadTools(): ToolDescriptor[] {
    const loader = new ConfigLoader(this.configDir, this.secretsDir);
    const config = loader.load();
    this.settings = this.resolveSettings(config.toolManager);

    const tools = Object.entries(config.tools)
      .filter(([, entry]) => entry.enabled !== false)
      .map(([toolKey, entry]) => this.buildDescriptor(toolKey, entry));

    tools.sort((a, b) => a.key.localeCompare(b.key));

    for (const tool of tools) {
      if (!this.runtimes.has(tool.key)) {
        this.runtimes.set(tool.key, {
          tool,
          status: "idle",
          logs: [],
        });
      }
    }

    for (const key of [...this.runtimes.keys()]) {
      if (!tools.some((tool) => tool.key === key)) {
        this.runtimes.delete(key);
      }
    }

    return tools;
  }

  onStatus(listener: ToolStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onLog(listener: ToolLogListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  getStates(): ToolRuntimeState[] {
    return [...this.runtimes.values()].map((state) => ({ ...state, logs: [...state.logs] }));
  }

  getState(toolKey: string): ToolRuntimeState | undefined {
    const state = this.runtimes.get(toolKey);
    if (!state) return undefined;
    return { ...state, logs: [...state.logs] };
  }

  async startAll(): Promise<void> {
    for (const toolKey of this.runtimes.keys()) {
      await this.startTool(toolKey);
    }
  }

  async startTool(toolKey: string): Promise<void> {
    const state = this.runtimes.get(toolKey);
    if (!state) return;
    if (state.status === "running" || state.status === "starting") return;

    if (!fs.existsSync(state.tool.packageDir)) {
      this.updateState(state, {
        status: "failed",
        lastLine: `Package directory missing: ${state.tool.packageDir}`,
        stoppedAt: Date.now(),
      });
      return;
    }

    fs.mkdirSync(path.dirname(this.pidFilePath), { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });

    this.updateState(state, {
      status: "starting",
      startedAt: Date.now(),
      stoppedAt: undefined,
      exitCode: undefined,
      signal: undefined,
      lastLine: "Spawning process",
      logs: [],
    });

    const child = spawn("/bin/sh", ["-lc", state.tool.command], {
      cwd: this.rootDir,
      env: {
        ...process.env,
        TOOL_NAME: state.tool.key,
        TOOL_PACKAGE_DIR: state.tool.packageDir,
        GLOVE_CONFIG_DIR: this.configDir,
        GLOVE_SECRETS_DIR: this.secretsDir,
        ...state.tool.env,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const logStream = fs.createWriteStream(state.tool.logPath, { flags: "a" });
    const emitOutput = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const text = chunk.toString("utf8");
      logStream.write(text);

      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      for (const line of lines) {
        state.logs.push(line);
        if (state.logs.length > this.settings.maxLogLines) {
          state.logs.shift();
        }
        state.lastLine = line;
        for (const listener of this.logListeners) {
          listener(state.tool.key, line, stream);
        }
      }

      this.emitStatus(state);
    };

    child.stdout?.on("data", (chunk: Buffer) => emitOutput(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => emitOutput(chunk, "stderr"));

    child.once("spawn", () => {
      this.updateState(state, {
        status: "running",
        pid: child.pid,
        child,
        lastLine: "Process started",
      });
      this.persistPidFile();
    });

    child.once("error", (error) => {
      this.updateState(state, {
        status: "failed",
        child: undefined,
        pid: undefined,
        stoppedAt: Date.now(),
        lastLine: `Failed to start: ${error.message}`,
      });
      this.persistPidFile();
    });

    child.once("exit", (code, signal) => {
      logStream.end();
      this.updateState(state, {
        status: code === 0 || signal === "SIGTERM" || signal === "SIGHUP" ? "stopped" : "failed",
        child: undefined,
        pid: undefined,
        stoppedAt: Date.now(),
        exitCode: code,
        signal,
        lastLine: code === 0 ? "Exited cleanly" : `Exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      });
      this.persistPidFile();
    });
  }

  async stopTool(toolKey: string): Promise<void> {
    const state = this.runtimes.get(toolKey);
    if (!state) return;
    if (state.status === "idle" || state.status === "stopped") {
      this.updateState(state, {
        status: "stopped",
        stoppedAt: Date.now(),
        lastLine: "Already stopped",
      });
      return;
    }

    const pid = state.pid;
    if (!pid) {
      this.updateState(state, {
        status: "stopped",
        stoppedAt: Date.now(),
      });
      this.persistPidFile();
      return;
    }

    this.updateState(state, {
      status: "stopping",
      lastLine: "Stopping process",
    });

    await this.terminatePidTree(pid, this.settings.shutdownTimeoutMs, this.settings.forceKillTimeoutMs);
    this.persistPidFile();
  }

  async restartTool(toolKey: string): Promise<void> {
    await this.stopTool(toolKey);
    await this.startTool(toolKey);
  }

  async stopAll(): Promise<void> {
    const keys = [...this.runtimes.keys()];
    for (const key of keys) {
      await this.stopTool(key);
    }
  }

  async stopFromPidFile(targetTools: string[] = []): Promise<void> {
    const entries = this.readPidFile();
    const selected = targetTools.length > 0
      ? entries.filter((entry) => targetTools.includes(entry.toolKey) || targetTools.includes(`tool-${entry.toolKey}`))
      : entries;

    for (const entry of selected) {
      await this.terminatePidTree(entry.pid, this.settings.shutdownTimeoutMs, this.settings.forceKillTimeoutMs);
    }

    const survivors = entries.filter((entry) => !selected.some((sel) => sel.toolKey === entry.toolKey));
    this.writePidFile(survivors);
  }

  private resolveSettings(toolManager: ToolManagerConfig): ToolManagerSettings {
    return {
      commandTemplate: toolManager.commandTemplate ?? DEFAULT_COMMAND_TEMPLATE,
      shutdownTimeoutMs: toolManager.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      forceKillTimeoutMs: toolManager.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS,
      maxLogLines: toolManager.maxLogLines ?? DEFAULT_MAX_LOG_LINES,
    };
  }

  private buildDescriptor(toolKey: string, entry: ToolServerEntry): ToolDescriptor {
    const packageName = entry.launcher?.packageName ?? `@langgraph-glove/tool-${toolKey}`;
    const packageDir = this.resolvePackageDir(packageName, entry.launcher?.packageDir);
    const commandTemplate = entry.launcher?.commandTemplate ?? this.settings.commandTemplate;
    const command = this.renderCommand(commandTemplate, toolKey, packageDir, packageName);
    const commandWithArgs = this.appendArgs(command, entry.launcher?.args ?? []);
    const logPath = path.join(this.logsDir, `tool-${toolKey}.log`);

    return {
      key: toolKey,
      packageDir,
      packageName,
      command: commandWithArgs,
      logPath,
      env: entry.launcher?.env ?? {},
    };
  }

  private resolvePackageDir(packageName: string, override?: string): string {
    if (override) {
      if (path.isAbsolute(override)) return override;
      return path.resolve(this.rootDir, override);
    }

    if (packageName.startsWith("@langgraph-glove/")) {
      const relativeName = packageName.slice("@langgraph-glove/".length);
      return path.join(this.rootDir, "packages", relativeName);
    }

    return path.join(this.rootDir, "packages", packageName);
  }

  private renderCommand(template: string, toolKey: string, packageDir: string, packageName: string): string {
    return template
      .replaceAll("{tool}", toolKey)
      .replaceAll("{packageDir}", packageDir)
      .replaceAll("{packageName}", packageName);
  }

  private appendArgs(command: string, args: string[]): string {
    if (args.length === 0) return command;
    const rendered = args.map((arg) => this.shellQuote(arg)).join(" ");
    return `${command} ${rendered}`;
  }

  private shellQuote(value: string): string {
    if (value.length === 0) return "''";
    return `'${value.replaceAll("'", `'\\''`)}'`;
  }

  private updateState(state: ToolRuntimeState, patch: Partial<ToolRuntimeState>): void {
    Object.assign(state, patch);
    this.emitStatus(state);
  }

  private emitStatus(state: ToolRuntimeState): void {
    for (const listener of this.statusListeners) {
      listener({ ...state, logs: [...state.logs] });
    }
  }

  private persistPidFile(): void {
    const entries: RuntimeFileEntry[] = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.pid && (runtime.status === "running" || runtime.status === "starting" || runtime.status === "stopping")) {
        entries.push({
          toolKey: runtime.tool.key,
          pid: runtime.pid,
          logPath: runtime.tool.logPath,
        });
      }
    }
    this.writePidFile(entries);
  }

  private readPidFile(): RuntimeFileEntry[] {
    if (!fs.existsSync(this.pidFilePath)) return [];

    const raw = fs.readFileSync(this.pidFilePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const entries: RuntimeFileEntry[] = [];

    for (const line of lines) {
      const [toolName, pidText, logPath] = line.split(":");
      if (!toolName || !pidText || !logPath) continue;
      const pid = Number.parseInt(pidText, 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      entries.push({
        toolKey: toolName.startsWith("tool-") ? toolName.slice(5) : toolName,
        pid,
        logPath,
      });
    }

    return entries;
  }

  private writePidFile(entries: RuntimeFileEntry[]): void {
    fs.mkdirSync(path.dirname(this.pidFilePath), { recursive: true });
    if (entries.length === 0) {
      if (fs.existsSync(this.pidFilePath)) {
        fs.unlinkSync(this.pidFilePath);
      }
      return;
    }

    const body = entries
      .map((entry) => `tool-${entry.toolKey}:${entry.pid}:${entry.logPath}`)
      .join("\n");
    fs.writeFileSync(this.pidFilePath, `${body}\n`, "utf8");
  }

  private async terminatePidTree(pid: number, shutdownTimeoutMs: number, forceKillTimeoutMs: number): Promise<void> {
    if (!this.isPidAlive(pid)) return;

    const tree = this.getPidTree(pid);
    this.killTree(tree, "SIGTERM");
    const gracefulStopped = await this.waitForExit(tree, shutdownTimeoutMs);
    if (gracefulStopped) return;

    this.killTree(tree, "SIGKILL");
    await this.waitForExit(tree, forceKillTimeoutMs);
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private getPidTree(rootPid: number): number[] {
    const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
    if (ps.status !== 0 || !ps.stdout) {
      return [rootPid];
    }

    const parentToChildren = new Map<number, number[]>();
    const lines = ps.stdout.split(/\r?\n/);
    for (const line of lines) {
      const [pidText, ppidText] = line.trim().split(/\s+/);
      const pid = Number.parseInt(pidText ?? "", 10);
      const ppid = Number.parseInt(ppidText ?? "", 10);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;

      const children = parentToChildren.get(ppid) ?? [];
      children.push(pid);
      parentToChildren.set(ppid, children);
    }

    const seen = new Set<number>();
    const ordered: number[] = [];
    const stack = [rootPid];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      ordered.push(next);
      const children = parentToChildren.get(next) ?? [];
      for (const child of children) {
        stack.push(child);
      }
    }

    return ordered;
  }

  private killTree(pids: number[], signal: NodeJS.Signals): void {
    for (let index = pids.length - 1; index >= 0; index -= 1) {
      const pid = pids[index];
      try {
        process.kill(pid, signal);
      } catch {
        // Process may have already exited.
      }
    }
  }

  private async waitForExit(pids: number[], timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const alive = pids.some((pid) => this.isPidAlive(pid));
      if (!alive) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return !pids.some((pid) => this.isPidAlive(pid));
  }
}
