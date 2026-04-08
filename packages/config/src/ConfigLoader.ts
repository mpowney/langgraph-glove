import fs from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";
import { SecretStore } from "./SecretStore";
import {
  ModelsConfigSchema,
  ChannelsConfigSchema,
  AgentsConfigSchema,
  MemoriesConfigSchema,
  ToolsConfigSchema,
  GatewayConfigSchema,
  GraphsConfigSchema,
  DEFAULT_GRAPH_ENTRY,
  type ModelsConfig,
  type ChannelsConfig,
  type AgentsConfig,
  type MemoriesConfig,
  type ToolsConfig,
  type GatewayConfig,
  type GraphsConfig,
} from "./schemas.js";

/**
 * Result of loading and validating all configuration files.
 */
export interface GloveConfig {
  models: ModelsConfig;
  channels: ChannelsConfig;
  agents: AgentsConfig;
  memories: MemoriesConfig;
  tools: ToolsConfig;
  gateway: GatewayConfig;
  graphs: GraphsConfig;
}

/**
 * Loads configuration from a directory of JSON files, resolves secret
 * references, and validates against Zod schemas.
 *
 * ## Config directory layout
 * ```
 * config/
 *   models.json      — model provider definitions (required)
 *   channels.json    — channel definitions (optional)
 *   agents.json      — agent definitions (optional)
 * ```
 *
 * Each file uses a **default + override** pattern:
 * ```json
 * {
 *   "default": { "provider": "anthropic", "model": "claude-sonnet-4-6", ... },
 *   "fast":    { "provider": "openai", "model": "gpt-4o-mini", ... }
 * }
 * ```
 *
 * Specify a `subKey` to deep-merge that key's values over `default`.
 */
export class ConfigLoader {
  readonly secrets: SecretStore;
  private readonly configDir: string;
  private readonly secretsDir: string;

  constructor(configDir: string, secretsDir: string) {
    this.configDir = path.resolve(configDir);
    this.secretsDir = path.resolve(secretsDir);
    this.secrets = new SecretStore();
  }

  /**
   * Load all config files, resolve secrets, validate schemas.
   * Call this once at startup.
   */
  load(): GloveConfig {
    // 1. Load secrets first (config values may reference them)
    this.secrets.load(this.secretsDir);

    // 2. Load each config file
    const models = this.loadFileOptional("models.json", ModelsConfigSchema) ?? {};
    const channels = this.loadFileOptional("channels.json", ChannelsConfigSchema) ?? {};
    const agents = this.loadFileOptional("agents.json", AgentsConfigSchema) ?? {
      default: {},
    };
    const memories = this.loadFileOptional("memories.json", MemoriesConfigSchema) ?? {
      default: {},
    };
    const tools = this.loadFileOptional("tools.json", ToolsConfigSchema) ?? {};
    const gateway = this.loadFileOptional("gateway.json", GatewayConfigSchema) ?? {};
    const graphs = this.loadFileOptional("graphs.json", GraphsConfigSchema) ?? {
      default: DEFAULT_GRAPH_ENTRY,
    };

    return { models, channels, agents, memories, tools, gateway, graphs };
  }

  /**
   * Load a required config file: read JSON, resolve secrets, validate.
   */
  private loadFile<T>(filename: string, schema: ZodType<T>): T {
    const filePath = path.join(this.configDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required config file not found: ${filePath}`);
    }
    return this.parseAndValidate(filePath, schema);
  }

  /**
   * Load an optional config file. Returns `null` if the file doesn't exist.
   */
  private loadFileOptional<T>(filename: string, schema: ZodType<T>): T | null {
    const filePath = path.join(this.configDir, filename);
    if (!fs.existsSync(filePath)) return null;
    return this.parseAndValidate(filePath, schema);
  }

  private parseAndValidate<T>(filePath: string, schema: ZodType<T>): T {
    const raw = fs.readFileSync(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in config file: ${filePath}`);
    }

    // Resolve {SECRET:...} references in all string values
    this.secrets.resolveSecrets(parsed);

    // Validate against the Zod schema
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Config validation failed for ${path.basename(filePath)}:\n${issues}`);
    }
    return result.data;
  }
}

/**
 * Resolve a named config entry by deep-merging `default` with the requested
 * sub-key.  If `subKey` is `"default"` or not provided, returns `default`
 * as-is.
 *
 * Arrays in the sub-key **replace** (not append) the default arrays.
 */
export function resolveConfigEntry<T extends Record<string, unknown>>(
  config: Record<string, T>,
  subKey: string = "default",
): T {
  const defaultEntry = config["default"];
  if (!defaultEntry) {
    throw new Error('Config is missing required "default" key');
  }
  if (subKey === "default") return { ...defaultEntry };

  const override = config[subKey];
  if (!override) {
    throw new Error(
      `Config key "${subKey}" not found. Available: ${Object.keys(config).join(", ")}`,
    );
  }
  return deepMerge(defaultEntry, override);
}

/** Deep-merge `override` into a shallow copy of `base`. Arrays are replaced. */
function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const overrideVal = override[key];
    const baseVal = result[key];
    if (
      overrideVal !== undefined &&
      typeof overrideVal === "object" &&
      overrideVal !== null &&
      !Array.isArray(overrideVal) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}
