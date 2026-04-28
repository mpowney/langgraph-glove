import type {
  ObservabilityConfig,
  ObservabilityExcludeConfig,
  ObservabilityModuleEntry,
  ObservabilityRole,
} from "@langgraph-glove/config";
import type { ObservabilityEvent } from "./types.js";

interface ExcludeBundle {
  roles: Set<string>;
  tools: Set<string>;
  agents: Set<string>;
  payloadFields: Set<string>;
}

/**
 * Returns true when the event should be emitted to the module.
 * Default is allow-all unless an exclusion rule matches.
 */
export function shouldEmitObservabilityEvent(
  config: ObservabilityConfig | undefined,
  moduleKey: string,
  event: ObservabilityEvent,
): boolean {
  if (!config || config.enabled !== false) {
    const moduleConfig = config?.modules?.[moduleKey];
    if (moduleConfig?.enabled === false) return false;

    if (isMember(config?.exclude?.modules, moduleKey)) return false;
    if (isMember(moduleConfig?.exclude?.modules, moduleKey)) return false;

    const excludes = buildExcludeBundle(config?.exclude, moduleConfig?.exclude, event.role);
    if (excludes.roles.has(event.role)) return false;
    if (event.toolName && excludes.tools.has(event.toolName)) return false;
    if (event.agentKey && excludes.agents.has(event.agentKey)) return false;

    return true;
  }

  return false;
}

/**
 * Strip excluded payload fields while preserving allow-all semantics for everything else.
 */
export function applyObservabilityPayloadExcludes(
  config: ObservabilityConfig | undefined,
  moduleKey: string,
  event: ObservabilityEvent,
): unknown {
  const payload = event.payload;
  if (!isPlainObject(payload) && !Array.isArray(payload)) return payload;

  const moduleConfig = config?.modules?.[moduleKey];
  const excludes = buildExcludeBundle(config?.exclude, moduleConfig?.exclude, event.role);
  if (excludes.payloadFields.size === 0) return payload;

  const clone = cloneJsonSafe(payload);
  for (const path of excludes.payloadFields) {
    removePath(clone, path);
  }

  return clone;
}

/**
 * Returns module keys that are active after global/module-level exclusions.
 */
export function getActiveObservabilityModules(config: ObservabilityConfig | undefined): string[] {
  if (!config || config.enabled === false) return [];
  const modules: Record<string, ObservabilityModuleEntry> = config.modules ?? {};

  return Object.entries(modules)
    .filter(([key, value]) => value.enabled !== false && !isMember(config.exclude?.modules, key))
    .map(([key]) => key);
}

function buildExcludeBundle(
  globalExclude: ObservabilityExcludeConfig | undefined,
  moduleExclude: ObservabilityExcludeConfig | undefined,
  role: ObservabilityRole,
): ExcludeBundle {
  const globalByRole = globalExclude?.byRole?.[role];
  const moduleByRole = moduleExclude?.byRole?.[role];

  return {
    roles: toSet(globalExclude?.roles, moduleExclude?.roles),
    tools: toSet(
      globalExclude?.tools,
      moduleExclude?.tools,
      globalByRole?.tools,
      moduleByRole?.tools,
    ),
    agents: toSet(
      globalExclude?.agents,
      moduleExclude?.agents,
      globalByRole?.agents,
      moduleByRole?.agents,
    ),
    payloadFields: toSet(
      globalExclude?.payloadFields,
      moduleExclude?.payloadFields,
      globalByRole?.payloadFields,
      moduleByRole?.payloadFields,
    ),
  };
}

function toSet(...values: Array<string[] | undefined>): Set<string> {
  const set = new Set<string>();
  for (const arr of values) {
    if (!arr) continue;
    for (const value of arr) {
      set.add(value);
    }
  }
  return set;
}

function isMember(values: string[] | undefined, candidate: string): boolean {
  if (!values || values.length === 0) return false;
  return values.includes(candidate);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function removePath(target: unknown, path: string): void {
  const segments = path
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (segments.length === 0) return;

  let cursor: unknown = target;
  for (let idx = 0; idx < segments.length - 1; idx += 1) {
    if (!isPlainObject(cursor)) return;
    cursor = cursor[segments[idx]];
    if (cursor === undefined || cursor === null) return;
  }

  if (!isPlainObject(cursor)) return;
  delete cursor[segments[segments.length - 1]];
}
