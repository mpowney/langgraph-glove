import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import type { ObservabilityConfig, ObservabilityModuleEntry } from "@langgraph-glove/config";
import { DurableObserveQueue } from "./DurableObserveQueue.js";
import { socketPathForObserve } from "./socket.js";
import type { ObserveProcessState } from "./ObserveProcessSupervisor.js";

const DEFAULT_PROBE_TIMEOUT_MS = 1500;

export interface ObserveReachabilitySnapshot {
  status: "reachable" | "unreachable" | "skipped";
  ok: boolean;
  checkedAt: string;
  latencyMs?: number;
  detail?: string;
}

export interface ObserveQueueModuleSnapshot {
  pending: number;
  dueNow: number;
  nextAttemptAt?: string;
  latestQueuedAt?: string;
  lastError?: string;
}

export interface ObserveQueueSnapshot {
  configured: boolean;
  dbPath?: string;
  dbExists: boolean;
  totalPending: number;
  totalDueNow: number;
  oldestCreatedAt?: string;
  byModule: Record<string, ObserveQueueModuleSnapshot>;
}

export interface ObserveModuleStatusSnapshot {
  moduleKey: string;
  enabled: boolean;
  transport: "in-process" | "http" | "unix-socket";
  durableRetry: boolean;
  process?: ObserveProcessState;
  reachability: ObserveReachabilitySnapshot;
  queue?: ObserveQueueModuleSnapshot;
}

export interface ObservabilityStatusSnapshot {
  generatedAt: string;
  processes: ObserveProcessState[];
  queue: ObserveQueueSnapshot;
  modules: Record<string, ObserveModuleStatusSnapshot>;
}

export interface CollectObservabilityDiagnosticsOptions {
  cwd?: string;
  probeTimeoutMs?: number;
}

export async function collectObservabilityDiagnostics(
  config: ObservabilityConfig | undefined,
  processStates: ObserveProcessState[],
  options: CollectObservabilityDiagnosticsOptions = {},
): Promise<ObservabilityStatusSnapshot> {
  const now = Date.now();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const processByModule = new Map<string, ObserveProcessState>();
  for (const state of processStates) {
    processByModule.set(state.moduleKey, state);
  }

  const queue = collectQueueSnapshot(config, now, cwd);
  const moduleEntries = Object.entries(config?.modules ?? {});

  const modulePairs = await Promise.all(
    moduleEntries.map(async ([moduleKey, module]) => {
      const transport = module.transport ?? "in-process";
      const reachability = await probeModuleReachability(module, probeTimeoutMs);
      const moduleSnapshot: ObserveModuleStatusSnapshot = {
        moduleKey,
        enabled: module.enabled !== false,
        transport,
        durableRetry: module.delivery?.durableRetry === true,
        process: processByModule.get(moduleKey),
        reachability,
        queue: queue.byModule[moduleKey],
      };
      return [moduleKey, moduleSnapshot] as const;
    }),
  );

  return {
    generatedAt: new Date(now).toISOString(),
    processes: processStates,
    queue,
    modules: Object.fromEntries(modulePairs),
  };
}

function collectQueueSnapshot(
  config: ObservabilityConfig | undefined,
  nowMs: number,
  cwd: string,
): ObserveQueueSnapshot {
  const configuredDbPath = config?.queue?.dbPath;
  if (!configuredDbPath) {
    return {
      configured: false,
      dbExists: false,
      totalPending: 0,
      totalDueNow: 0,
      byModule: {},
    };
  }

  const absoluteDbPath = path.resolve(cwd, configuredDbPath);
  if (!fs.existsSync(absoluteDbPath)) {
    return {
      configured: true,
      dbPath: absoluteDbPath,
      dbExists: false,
      totalPending: 0,
      totalDueNow: 0,
      byModule: {},
    };
  }

  const queue = new DurableObserveQueue(absoluteDbPath);
  try {
    const diagnostics = queue.getDiagnostics(nowMs);
    const byModule: Record<string, ObserveQueueModuleSnapshot> = {};
    for (const [moduleKey, moduleDiag] of Object.entries(diagnostics.byModule)) {
      byModule[moduleKey] = {
        pending: moduleDiag.pending,
        dueNow: moduleDiag.dueNow,
        nextAttemptAt: toIso(moduleDiag.nextAttemptAt),
        latestQueuedAt: toIso(moduleDiag.latestQueuedAt),
        lastError: moduleDiag.lastError,
      };
    }

    return {
      configured: true,
      dbPath: absoluteDbPath,
      dbExists: true,
      totalPending: diagnostics.totalPending,
      totalDueNow: diagnostics.totalDueNow,
      oldestCreatedAt: toIso(diagnostics.oldestCreatedAt),
      byModule,
    };
  } finally {
    queue.close();
  }
}

async function probeModuleReachability(
  module: ObservabilityModuleEntry,
  timeoutMs: number,
): Promise<ObserveReachabilitySnapshot> {
  const checkedAt = new Date().toISOString();

  if (module.enabled === false) {
    return {
      status: "skipped",
      ok: true,
      checkedAt,
      detail: "module disabled",
    };
  }

  const transport = module.transport ?? "in-process";

  if (transport === "in-process") {
    return {
      status: "skipped",
      ok: true,
      checkedAt,
      detail: "in-process module",
    };
  }

  if (transport === "http") {
    return probeHttpReachability(module, timeoutMs, checkedAt);
  }

  return probeUnixSocketReachability(module, timeoutMs, checkedAt);
}

async function probeHttpReachability(
  module: ObservabilityModuleEntry,
  timeoutMs: number,
  checkedAt: string,
): Promise<ObserveReachabilitySnapshot> {
  if (!module.url) {
    return {
      status: "unreachable",
      ok: false,
      checkedAt,
      detail: "missing module url",
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(module.url, {
      method: "GET",
      signal: controller.signal,
    });

    return {
      status: "reachable",
      ok: true,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      status: "unreachable",
      ok: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeUnixSocketReachability(
  module: ObservabilityModuleEntry,
  timeoutMs: number,
  checkedAt: string,
): Promise<ObserveReachabilitySnapshot> {
  if (!module.socketName) {
    return {
      status: "unreachable",
      ok: false,
      checkedAt,
      detail: "missing module socketName",
    };
  }

  const socketPath = socketPathForObserve(module.socketName);
  const startedAt = Date.now();

  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      socket.setTimeout(timeoutMs, () => {
        fail(new Error(`unix-socket probe timed out after ${timeoutMs}ms`));
      });

      socket.once("error", fail);
      socket.once("connect", () => {
        socket.end();
      });
      socket.once("close", finish);
    });

    return {
      status: "reachable",
      ok: true,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      detail: "unix-socket connect ok",
    };
  } catch (error) {
    return {
      status: "unreachable",
      ok: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function toIso(value: number | undefined): string | undefined {
  return typeof value === "number" ? new Date(value).toISOString() : undefined;
}
