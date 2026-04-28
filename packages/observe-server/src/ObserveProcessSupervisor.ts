import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ObservabilityConfig } from "@langgraph-glove/config";

const DEFAULT_COMMAND_TEMPLATE = "pnpm --filter {packageName} dev";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 1500;

export type ObserveProcessStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface ObserveProcessState {
  moduleKey: string;
  packageName: string;
  status: ObserveProcessStatus;
  pid?: number;
  startedAt?: number;
  stoppedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  lastLine?: string;
}

interface RuntimeEntry extends ObserveProcessState {
  command: string;
  env: Record<string, string>;
  child?: ChildProcess;
}

export interface ObserveProcessSupervisorOptions {
  rootDir: string;
  configDir?: string;
  secretsDir?: string;
  /** Directory where per-module log files are written. Defaults to `<rootDir>/logs/tools`. */
  logsDir?: string;
}

/**
 * Manages the lifecycle of observe relay processes (e.g. `observe-agent365`).
 *
 * Call `load(config)` with the resolved `ObservabilityConfig`, then
 * `startAll()` to spawn every module that has a `launcher` config.  Use
 * `stopAll()` for graceful shutdown.
 *
 * Only non-`in-process` modules that have a `launcher` block are managed
 * here.  In-process modules (web-channel, ui-observability) need no process
 * management.
 */
export class ObserveProcessSupervisor {
  private readonly rootDir: string;
  private readonly configDir: string;
  private readonly secretsDir: string;
  private readonly logsDir: string;
  private readonly runtimes = new Map<string, RuntimeEntry>();

  constructor(options: ObserveProcessSupervisorOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.configDir = path.resolve(options.configDir ?? path.join(this.rootDir, "config"));
    this.secretsDir = path.resolve(
      options.secretsDir ?? path.join(this.rootDir, "secrets"),
    );
    this.logsDir = path.resolve(
      options.logsDir ?? path.join(this.rootDir, "logs", "tools"),
    );
  }

  /**
   * Register manageable modules from the observability config.
   * Safe to call multiple times; existing runtimes are preserved and
   * runtimes for removed modules are deleted.
   */
  load(config: ObservabilityConfig): void {
    const modules = config.modules ?? {};
    const seen = new Set<string>();

    for (const [moduleKey, entry] of Object.entries(modules)) {
      if (entry.enabled === false) continue;
      if (!entry.transport || entry.transport === "in-process") continue;
      if (!entry.launcher) continue;

      seen.add(moduleKey);

      if (!this.runtimes.has(moduleKey)) {
        const packageName =
          entry.launcher.packageName ?? `@langgraph-glove/observe-${moduleKey}`;
        const packageDir = this.resolvePackageDir(packageName, entry.launcher.packageDir);
        const commandTemplate =
          entry.launcher.commandTemplate ?? DEFAULT_COMMAND_TEMPLATE;
        const command = this.renderCommand(
          commandTemplate,
          moduleKey,
          packageDir,
          packageName,
        );
        const commandWithArgs = this.appendArgs(command, entry.launcher.args ?? []);

        this.runtimes.set(moduleKey, {
          moduleKey,
          packageName,
          status: "idle",
          command: commandWithArgs,
          env: entry.launcher.env ?? {},
        });
      }
    }

    // Remove entries that are no longer in config
    for (const key of [...this.runtimes.keys()]) {
      if (!seen.has(key)) {
        this.runtimes.delete(key);
      }
    }
  }

  /** Current snapshot of all managed process states. */
  getStates(): ObserveProcessState[] {
    return [...this.runtimes.values()].map((r) => ({
      moduleKey: r.moduleKey,
      packageName: r.packageName,
      status: r.status,
      pid: r.pid,
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt,
      exitCode: r.exitCode,
      signal: r.signal,
      lastLine: r.lastLine,
    }));
  }

  /** Start all registered processes sequentially. */
  async startAll(): Promise<void> {
    for (const key of this.runtimes.keys()) {
      await this.startModule(key);
    }
  }

  /** Start a single registered module by key. */
  async startModule(moduleKey: string): Promise<void> {
    const entry = this.runtimes.get(moduleKey);
    if (!entry) return;
    if (entry.status === "running" || entry.status === "starting") return;

    fs.mkdirSync(this.logsDir, { recursive: true });
    const logPath = path.join(this.logsDir, `observe-${moduleKey}.log`);

    Object.assign(entry, {
      status: "starting" satisfies ObserveProcessStatus,
      startedAt: Date.now(),
      stoppedAt: undefined,
      exitCode: undefined,
      signal: undefined,
      lastLine: "Spawning process",
      child: undefined,
    });

    const child = spawn("/bin/sh", ["-lc", entry.command], {
      cwd: this.rootDir,
      env: {
        ...process.env,
        OBSERVE_MODULE: moduleKey,
        GLOVE_CONFIG_DIR: this.configDir,
        GLOVE_SECRETS_DIR: this.secretsDir,
        ...entry.env,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    const handleOutput = (chunk: Buffer): void => {
      logStream.write(chunk);
      const text = chunk.toString("utf8");
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      for (const line of lines) {
        entry.lastLine = line;
      }
    };

    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", handleOutput);

    child.once("spawn", () => {
      Object.assign(entry, {
        status: "running" satisfies ObserveProcessStatus,
        pid: child.pid,
        child,
      });
    });

    child.once("error", (err) => {
      logStream.end();
      Object.assign(entry, {
        status: "failed" satisfies ObserveProcessStatus,
        child: undefined,
        pid: undefined,
        stoppedAt: Date.now(),
        lastLine: `Failed to start: ${err.message}`,
      });
    });

    child.once("exit", (code, signal) => {
      logStream.end();
      Object.assign(entry, {
        status: (code === 0 || signal === "SIGTERM"
          ? "stopped"
          : "failed") satisfies ObserveProcessStatus,
        child: undefined,
        pid: undefined,
        stoppedAt: Date.now(),
        exitCode: code,
        signal,
        lastLine:
          code === 0
            ? "Exited cleanly"
            : `Exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      });
    });
  }

  /** Stop a single registered module by key. */
  async stopModule(moduleKey: string): Promise<void> {
    const entry = this.runtimes.get(moduleKey);
    if (!entry) return;

    const pid = entry.pid ?? entry.child?.pid;
    if (!pid) {
      Object.assign(entry, {
        status: "stopped" satisfies ObserveProcessStatus,
        stoppedAt: Date.now(),
      });
      return;
    }

    Object.assign(entry, {
      status: "stopping" satisfies ObserveProcessStatus,
      lastLine: "Stopping process",
    });
    await this.terminatePid(pid);
  }

  /** Stop all managed processes. */
  async stopAll(): Promise<void> {
    for (const key of this.runtimes.keys()) {
      await this.stopModule(key);
    }
  }

  private async terminatePid(pid: number): Promise<void> {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already gone
      return;
    }

    const deadline = Date.now() + DEFAULT_SHUTDOWN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      try {
        process.kill(pid, 0);
      } catch {
        return; // Process gone
      }
    }

    // Force kill if still alive
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, DEFAULT_FORCE_KILL_TIMEOUT_MS),
    );
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

  private renderCommand(
    template: string,
    moduleKey: string,
    packageDir: string,
    packageName: string,
  ): string {
    return template
      .replaceAll("{tool}", moduleKey)
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
}
