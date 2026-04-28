import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Agent365ObservabilityModuleEntry,
  Agent365ForwardConfig,
  Agent365IngressHttpConfig,
  Agent365IngressUnixConfig,
  Agent365ModuleSettings,
  Agent365SdkConfig,
  ResolvedAgent365ModuleConfig,
  ResolvedAgent365RuntimeConfig,
} from "./types.js";

const DEFAULT_HTTP_INGRESS: Agent365IngressHttpConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 9401,
  path: "/events",
};

const DEFAULT_UNIX_INGRESS: Agent365IngressUnixConfig = {
  enabled: true,
  socketPath: resolveSocketPath("agent365-ingress"),
};

const DEFAULT_FORWARD: Agent365ForwardConfig = {
  transport: "none",
  http: {
    url: "http://127.0.0.1:9501/agent365/telemetry",
    timeoutMs: 5000,
  },
  unixSocket: {
    socketPath: resolveSocketPath("agent365-target"),
    timeoutMs: 5000,
  },
};

const DEFAULT_SDK: ResolvedAgent365RuntimeConfig["sdk"] = {
  enabled: false,
  serviceName: "langgraph-glove-observe-agent365",
  serviceVersion: "0.1.0",
  tenantId: undefined,
  agentId: undefined,
  agentName: "langgraph-glove-agent",
  userId: undefined,
  userName: undefined,
  userEmail: undefined,
  clientId: undefined,
  clientSecret: undefined,
  maxQueueSize: 2048,
};

interface Agent365StandaloneConfig extends Agent365ModuleSettings {
  moduleKey?: string;
}

export function loadAgent365RuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgent365RuntimeConfig {
  const moduleConfig = loadAgent365ModuleConfig(env);
  return {
    moduleKey: moduleConfig?.moduleKey ?? envString(env, "AGENT365_MODULE_KEY") ?? "agent365-standalone",
    relay: buildRelayConfig(moduleConfig, env),
    sdk: buildSdkConfig(moduleConfig?.settings?.sdk, env),
  };
}

export function resolveSocketPath(raw: string): string {
  if (raw.includes("/")) return raw;
  return path.resolve(`/tmp/${raw}.sock`);
}

function loadAgent365ModuleConfig(
  env: NodeJS.ProcessEnv,
): ResolvedAgent365ModuleConfig | undefined {
  const moduleKey = envString(env, "OBSERVE_MODULE");
  if (moduleKey) {
    return loadTopLevelModuleConfig(moduleKey, env);
  }

  return loadStandaloneConfig(env);
}

function loadTopLevelModuleConfig(
  moduleKey: string,
  env: NodeJS.ProcessEnv,
): ResolvedAgent365ModuleConfig {
  const configDir = path.resolve(envString(env, "GLOVE_CONFIG_DIR") ?? path.resolve(process.cwd(), "config"));
  const secretsDir = path.resolve(envString(env, "GLOVE_SECRETS_DIR") ?? path.resolve(process.cwd(), "secrets"));
  const observabilityPath = path.join(configDir, "observability.json");
  const config = readJsonWithSecrets(observabilityPath, secretsDir);
  const modules = isRecord(config.modules) ? config.modules : undefined;
  const entryValue = modules?.[moduleKey];
  const entry = asObservabilityModuleEntry(entryValue);

  if (!entry) {
    throw new Error(`Observability module "${moduleKey}" was not found in ${observabilityPath}`);
  }

  return {
    moduleKey,
    entry,
    settings: asAgent365ModuleSettings(entry.settings),
  };
}

function loadStandaloneConfig(
  env: NodeJS.ProcessEnv,
): ResolvedAgent365ModuleConfig | undefined {
  const explicitConfigPath = envString(env, "AGENT365_CONFIG_FILE");
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidatePaths = [
    ...(explicitConfigPath ? [path.resolve(explicitConfigPath)] : []),
    path.join(packageRoot, "config.json"),
  ];

  const configPath = candidatePaths.find((candidate) => fs.existsSync(candidate));
  if (!configPath) return undefined;

  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: Agent365StandaloneConfig;
  try {
    parsed = JSON.parse(raw) as Agent365StandaloneConfig;
  } catch {
    throw new Error(`Invalid JSON in Agent365 config file: ${configPath}`);
  }

  const secretsDir = path.resolve(envString(env, "GLOVE_SECRETS_DIR") ?? path.join(packageRoot, "secrets"));
  resolveSecrets(parsed, loadSecrets(secretsDir));

  return {
    moduleKey: parsed.moduleKey ?? envString(env, "AGENT365_MODULE_KEY") ?? "agent365-standalone",
    settings: parsed,
  };
}

function buildRelayConfig(
  moduleConfig: ResolvedAgent365ModuleConfig | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedAgent365RuntimeConfig["relay"] {
  const settings = moduleConfig?.settings;
  const transport = moduleConfig?.entry?.transport;
  const entryHttp = deriveHttpIngress(moduleConfig?.entry);
  const entryUnix = deriveUnixIngress(moduleConfig?.entry);

  const http = {
    ...DEFAULT_HTTP_INGRESS,
    ...entryHttp,
    ...settings?.ingress?.http,
  };

  const unixSocket = {
    ...DEFAULT_UNIX_INGRESS,
    ...entryUnix,
    ...settings?.ingress?.unixSocket,
  };

  if (transport === "http") {
    http.enabled = true;
    unixSocket.enabled = false;
  } else if (transport === "unix-socket") {
    http.enabled = false;
    unixSocket.enabled = true;
  } else {
    http.enabled = envBool(env, "AGENT365_INGRESS_HTTP_ENABLED") ?? http.enabled;
    unixSocket.enabled = envBool(env, "AGENT365_INGRESS_UNIX_ENABLED") ?? unixSocket.enabled;
  }

  http.host = envString(env, "AGENT365_INGRESS_HTTP_HOST") ?? http.host;
  http.port = envNumber(env, "AGENT365_INGRESS_HTTP_PORT") ?? http.port;
  http.path = envString(env, "AGENT365_INGRESS_HTTP_PATH") ?? http.path;
  unixSocket.socketPath = resolveSocketPath(
    envString(env, "AGENT365_INGRESS_UNIX_SOCKET") ?? unixSocket.socketPath,
  );

  const forward = buildForwardConfig(settings, env);

  return {
    ingress: {
      http,
      unixSocket,
    },
    forward,
  };
}

function buildForwardConfig(
  settings: Agent365ModuleSettings | undefined,
  env: NodeJS.ProcessEnv,
): Agent365ForwardConfig {
  const configured = settings?.forward;
  const transport = envForwardTransport(envString(env, "AGENT365_FORWARD_TRANSPORT"))
    ?? configured?.transport
    ?? DEFAULT_FORWARD.transport;

  return {
    transport,
    http: {
      ...DEFAULT_FORWARD.http,
      ...configured?.http,
      url: envString(env, "AGENT365_FORWARD_HTTP_URL")
        ?? configured?.http?.url
        ?? DEFAULT_FORWARD.http?.url
        ?? "",
      authToken: envString(env, "AGENT365_FORWARD_HTTP_AUTH_TOKEN")
        ?? configured?.http?.authToken,
      timeoutMs: envNumber(env, "AGENT365_FORWARD_HTTP_TIMEOUT_MS")
        ?? configured?.http?.timeoutMs
        ?? DEFAULT_FORWARD.http?.timeoutMs,
    },
    unixSocket: {
      ...DEFAULT_FORWARD.unixSocket,
      ...configured?.unixSocket,
      socketPath: resolveSocketPath(
        envString(env, "AGENT365_FORWARD_UNIX_SOCKET")
          ?? configured?.unixSocket?.socketPath
          ?? DEFAULT_FORWARD.unixSocket?.socketPath
          ?? DEFAULT_UNIX_INGRESS.socketPath,
      ),
      timeoutMs: envNumber(env, "AGENT365_FORWARD_UNIX_TIMEOUT_MS")
        ?? configured?.unixSocket?.timeoutMs
        ?? DEFAULT_FORWARD.unixSocket?.timeoutMs,
    },
  };
}

function buildSdkConfig(
  configured: Agent365SdkConfig | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedAgent365RuntimeConfig["sdk"] {
  return {
    ...DEFAULT_SDK,
    ...configured,
    enabled: envBool(env, "AGENT365_SDK_ENABLED") ?? configured?.enabled ?? DEFAULT_SDK.enabled,
    serviceName: envString(env, "AGENT365_SDK_SERVICE_NAME")
      ?? configured?.serviceName
      ?? DEFAULT_SDK.serviceName,
    serviceVersion: envString(env, "AGENT365_SDK_SERVICE_VERSION")
      ?? configured?.serviceVersion
      ?? DEFAULT_SDK.serviceVersion,
    tenantId: envString(env, "A365_TENANT_ID") ?? configured?.tenantId,
    agentId: envString(env, "A365_AGENT_ID") ?? configured?.agentId,
    agentName: envString(env, "A365_AGENT_NAME")
      ?? configured?.agentName
      ?? DEFAULT_SDK.agentName,
    userId: envString(env, "A365_USER_ID") ?? configured?.userId,
    userName: envString(env, "A365_USER_NAME") ?? configured?.userName,
    userEmail: envString(env, "A365_USER_EMAIL") ?? configured?.userEmail,
    clientId: envString(env, "A365_CLIENT_ID") ?? configured?.clientId,
    clientSecret: envString(env, "A365_CLIENT_SECRET") ?? configured?.clientSecret,
    maxQueueSize: envNumber(env, "A365_SDK_MAX_QUEUE_SIZE")
      ?? configured?.maxQueueSize
      ?? DEFAULT_SDK.maxQueueSize,
  };
}

function deriveHttpIngress(entry: Agent365ObservabilityModuleEntry | undefined): Partial<Agent365IngressHttpConfig> {
  if (!entry?.url) return {};

  const parsed = new URL(entry.url);
  return {
    host: parsed.hostname || DEFAULT_HTTP_INGRESS.host,
    port: parsed.port ? Number(parsed.port) : defaultPortForProtocol(parsed.protocol),
    path: parsed.pathname || DEFAULT_HTTP_INGRESS.path,
  };
}

function deriveUnixIngress(entry: Agent365ObservabilityModuleEntry | undefined): Partial<Agent365IngressUnixConfig> {
  if (!entry?.socketName) return {};
  return {
    socketPath: resolveSocketPath(entry.socketName),
  };
}

function defaultPortForProtocol(protocol: string): number {
  if (protocol === "https:") return 443;
  return 80;
}

function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = envString(env, name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function envBool(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = envString(env, name);
  if (raw === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envForwardTransport(value: string | undefined): Agent365ForwardConfig["transport"] | undefined {
  if (value === "none" || value === "http" || value === "unix-socket") {
    return value;
  }
  return undefined;
}

function asAgent365ModuleSettings(value: unknown): Agent365ModuleSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Agent365ModuleSettings;
}

function asObservabilityModuleEntry(value: unknown): Agent365ObservabilityModuleEntry | undefined {
  if (!isRecord(value)) return undefined;
  return value as Agent365ObservabilityModuleEntry;
}

function readJsonWithSecrets(filePath: string, secretsDir: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required Agent365 config file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in Agent365 config file: ${filePath}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Agent365 config file must contain a JSON object: ${filePath}`);
  }

  resolveSecrets(parsed, loadSecrets(secretsDir));
  return parsed;
}

function loadSecrets(secretsDir: string): Map<string, string> {
  const secrets = new Map<string, string>();
  if (!fs.existsSync(secretsDir)) {
    return secrets;
  }

  for (const fileName of fs.readdirSync(secretsDir)) {
    if (!fileName.endsWith(".json")) continue;
    const filePath = path.join(secretsDir, fileName);
    const raw = fs.readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in secret file: ${filePath}`);
    }

    if (!isRecord(parsed)) {
      throw new Error(`Secret file must contain a JSON object: ${filePath}`);
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new Error(`Secret "${key}" in ${fileName} must be a string`);
      }
      if (secrets.has(key)) {
        throw new Error(`Duplicate secret name "${key}" (found in ${fileName})`);
      }
      secrets.set(key, value);
    }
  }

  return secrets;
}

function resolveSecrets<T>(value: T, secrets: Map<string, string>): T {
  if (typeof value === "string") {
    return value.replace(
      /\{\{SECRET:([a-zA-Z0-9_-]+)\}\}|\{SECRET:([a-zA-Z0-9_-]+)\}/g,
      (_match, escapedName: string | undefined, name: string | undefined) => {
        if (escapedName) {
          return `{SECRET:${escapedName}}`;
        }

        const resolved = secrets.get(name as string);
        if (resolved === undefined) {
          throw new Error(`Secret "${name}" not found`);
        }
        return resolved;
      },
    ) as T;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = resolveSecrets(value[index], secrets);
    }
    return value;
  }

  if (isRecord(value)) {
    const mutableValue = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) {
      mutableValue[key] = resolveSecrets(child, secrets);
    }
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}