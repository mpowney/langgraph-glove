import { z } from "zod";

// ---------------------------------------------------------------------------
// Secret reference pattern: {SECRET:secret-name}
// ---------------------------------------------------------------------------

/**
 * Regex that matches `{SECRET:some-name}` placeholders in config values.
 *
 * Use `{{SECRET:some-name}}` when you want the literal placeholder text.
 */
export const SECRET_REF_PATTERN = /\{SECRET:([a-zA-Z0-9_-]+)\}/g;

// ---------------------------------------------------------------------------
// Model config schema
// ---------------------------------------------------------------------------

/** Supported LLM provider identifiers. */
export const ModelProviderSchema = z.enum([
  "openai",
  "anthropic",
  "google",
  "ollama",
  "openai-compatible",
]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

/**
 * Config for a single named model entry.
 * The `default` key is required; additional keys override specific fields.
 */
export const ModelEntrySchema = z.object({
  /** Provider backend. */
  provider: ModelProviderSchema,
  /** Model name as understood by the provider (e.g. "gpt-4o", "claude-sonnet-4-6"). */
  model: z.string(),
  /** API key — may contain a `{SECRET:name}` reference. */
  apiKey: z.string().optional(),
  /** Base URL override (useful for ollama, openai-compatible, proxies). */
  baseUrl: z.string().url().optional(),
  /** Sampling temperature (0–2). */
  temperature: z.number().min(0).max(2).optional(),
  /** API version passed as ?api-version=<value> (required for Azure Foundry endpoints). */
  apiVersion: z.string().optional(),
  /** Ollama thinking mode. When true, prefer thinking traces; when false, disable them. */
  think: z.boolean().optional(),
  /** Ollama model residency duration after a request (maps to Ollama `keep_alive`). */
  keepAlive: z.union([z.string(), z.number()]).optional(),
  /** Optional known model context window size in tokens. */
  contextWindowTokens: z.number().int().positive().optional(),
}).superRefine((value, ctx) => {
  if (value.keepAlive !== undefined && value.provider !== "ollama") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["keepAlive"],
      message: '"keepAlive" is only supported when provider is "ollama"',
    });
  }
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

/**
 * Top-level models.json schema.
 * Must contain a `default` key. Additional keys are named model profiles.
 */
export const ModelsConfigSchema = z
  .record(z.string(), ModelEntrySchema)
  .refine((obj) => "default" in obj, {
    message: 'models.json must contain a "default" key',
  });
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

// ---------------------------------------------------------------------------
// Channel config schema (minimal — extended per-channel package later)
// ---------------------------------------------------------------------------

export const ChannelEntrySchema = z.object({
  /** Whether the channel is enabled. Defaults to `true` if omitted. */
  enabled: z.boolean().optional(),
  /** Arbitrary channel-specific settings. */
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type ChannelEntry = z.infer<typeof ChannelEntrySchema>;

export const ChannelsConfigSchema = z.record(z.string(), ChannelEntrySchema);
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

// ---------------------------------------------------------------------------
// Agent config schema
// ---------------------------------------------------------------------------

export const AgentEntrySchema = z.object({
  /** Model config key to use (must exist in models.json). Defaults to `"default"` if omitted. */
  modelKey: z.string().optional(),
  /** System prompt for this agent. */
  systemPrompt: z.string().optional(),
  /** Short description of what this agent does (used by the orchestrator for routing). */
  description: z.string().optional(),
  /** Tool names this agent is allowed to use. Missing = all tools, empty = no tools. */
  tools: z.array(z.string()).optional(),
  /** Tool-server keys (from tools.json) whose discovered tools are auto-allowed for this agent. */
  autoToolDiscovery: z.array(z.string()).optional(),
  /** Maximum ReAct loop steps before aborting. */
  recursionLimit: z.number().int().positive().optional(),
  /** Optional subgraph key that defines this agent's default context compression behavior. */
  compressionSubgraph: z.string().optional(),
  /**
   * Maximum bytes allowed for an inline tool result returned to the LLM.
   * Results exceeding this limit are replaced with a truncation notice.
   * Defaults to 2 MB. Increase this when tools like `peekaboo_see` return
   * large payloads that should not be truncated.
   */
  maxInlineToolResultBytes: z.number().int().positive().optional(),
});
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

export const AgentsConfigSchema = z
  .record(z.string(), AgentEntrySchema)
  .refine((obj) => "default" in obj, {
    message: 'agents.json must contain a "default" key',
  });
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

// ---------------------------------------------------------------------------
// Memory config schema
// ---------------------------------------------------------------------------

export const MemoryStorageModeSchema = z.enum(["markdown-sqlite"]);
export type MemoryStorageMode = z.infer<typeof MemoryStorageModeSchema>;

export const MemoryRetentionTierSchema = z.enum(["hot", "warm", "cold"]);
export type MemoryRetentionTier = z.infer<typeof MemoryRetentionTierSchema>;

export const MemoryChunkingConfigSchema = z
  .object({
    /** Maximum characters per chunk before overlap is applied. */
    chunkSize: z.number().int().positive(),
    /** Number of characters to repeat at the start of the next chunk. */
    chunkOverlap: z.number().int().min(0),
  })
  .refine((obj) => obj.chunkOverlap < obj.chunkSize, {
    message: "chunkOverlap must be smaller than chunkSize",
    path: ["chunkOverlap"],
  });
export type MemoryChunkingConfig = z.infer<typeof MemoryChunkingConfigSchema>;

export const MemoryRetrievalConfigSchema = z.object({
  /** Maximum memories returned to the agent. */
  topK: z.number().int().positive().optional(),
  /** Cap how many chunks any single memory can contribute to the result. */
  maxChunksPerMemory: z.number().int().positive().optional(),
  /** Whether to include raw chunk excerpts in results. */
  includeChunks: z.boolean().optional(),
});
export type MemoryRetrievalConfig = z.infer<typeof MemoryRetrievalConfigSchema>;

export const MemoryTierConfigSchema = z.object({
  /** Days a memory stays in the hot tier before ageing into warm. */
  hotDays: z.number().int().positive().optional(),
  /** Days a memory stays in the warm tier before ageing into cold. */
  warmDays: z.number().int().positive().optional(),
});
export type MemoryTierConfig = z.infer<typeof MemoryTierConfigSchema>;

export const MemoryEntrySchema = z.object({
  /** Whether the memory subsystem is enabled for this profile. */
  enabled: z.boolean().optional(),
  /** Storage mode for source memories and derived index state. */
  storageMode: MemoryStorageModeSchema.optional(),
  /** Directory containing markdown memory files. Relative paths resolve from the workspace root. */
  storageDir: z.string().optional(),
  /** SQLite database path for memory metadata and chunk index rows. */
  indexDbPath: z.string().optional(),
  /** Scope assigned when a memory is created without an explicit scope. */
  defaultScope: z.string().optional(),
  /** Model key in models.json intended for embedding generation. */
  embeddingModelKey: z.string().optional(),
  /** Whether embeddings are generated immediately or deferred. */
  indexingStrategy: z.enum(["immediate", "deferred"]).optional(),
  chunking: MemoryChunkingConfigSchema.optional(),
  retrieval: MemoryRetrievalConfigSchema.optional(),
  tiers: MemoryTierConfigSchema.optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const MemoriesConfigSchema = z
  .record(z.string(), MemoryEntrySchema)
  .refine((obj) => "default" in obj, {
    message: 'memories.json must contain a "default" key',
  });
export type MemoriesConfig = z.infer<typeof MemoriesConfigSchema>;

// ---------------------------------------------------------------------------
// Tool server config schema
// ---------------------------------------------------------------------------

/** Transport used to reach a remote tool server. */
export const ToolTransportSchema = z.enum(["http", "unix-socket"]);
export type ToolTransport = z.infer<typeof ToolTransportSchema>;

/** A single tool server entry in tools.json. */
export const ToolServerEntrySchema = z.object({
  /** Transport type. */
  transport: ToolTransportSchema,
  /** HTTP URL (required when transport is "http"). */
  url: z.string().url().optional(),
  /** Unix socket name (required when transport is "unix-socket"). */
  socketName: z.string().optional(),
  /** Whether this tool server is enabled. Defaults to `true` if omitted. */
  enabled: z.boolean().optional(),
});
export type ToolServerEntry = z.infer<typeof ToolServerEntrySchema>;

/**
 * Top-level tools.json schema.
 * Keys are human-readable names for each tool server.
 */
export const ToolsConfigSchema = z.record(z.string(), ToolServerEntrySchema);
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

// ---------------------------------------------------------------------------
// Subgraph profile config schema
// ---------------------------------------------------------------------------

export const SubgraphCompressionModeSchema = z.enum(["research-digest"]);
export type SubgraphCompressionMode = z.infer<typeof SubgraphCompressionModeSchema>;

export const SubgraphCompressionSchema = z.object({
  /** Remote tool name that performs the compression. */
  tool: z.string(),
  /** Compression strategy to apply. */
  mode: SubgraphCompressionModeSchema.optional(),
  /** Number of recent visible messages to keep verbatim after compression. */
  preserveRecentMessages: z.number().int().nonnegative().optional(),
  /** Compress once the visible message count reaches this threshold. */
  messageCountThreshold: z.number().int().positive().optional(),
  /** Compress once the visible character budget reaches this threshold. */
  charThreshold: z.number().int().positive().optional(),
  /** Maximum digest size requested from the compression tool. */
  maxDigestChars: z.number().int().positive().optional(),
});
export type SubgraphCompression = z.infer<typeof SubgraphCompressionSchema>;

/**
 * Reusable subgraph profile that can be referenced by a graph entry.
 *
 * Profiles are intentionally close to AgentEntry so they can override
 * model/prompt/tool behavior for role-specific subgraph usage.
 */
export const SubgraphProfileSchema = z.object({
  /** Base agent key used when this subgraph profile is resolved. */
  agentKey: z.string().optional(),
  /** Optional model override for this subgraph profile. */
  modelKey: z.string().optional(),
  /** Optional system prompt override for this subgraph profile. */
  systemPrompt: z.string().optional(),
  /** Optional description override for this subgraph profile. */
  description: z.string().optional(),
  /** Optional tool allow-list override for this subgraph profile. */
  tools: z.array(z.string()).optional(),
  /** Optional recursion limit override for this subgraph profile. */
  recursionLimit: z.number().int().positive().optional(),
  /** Optional context compression behavior attached to this subgraph profile. */
  compression: SubgraphCompressionSchema.optional(),
});
export type SubgraphProfile = z.infer<typeof SubgraphProfileSchema>;

export const SubgraphsConfigSchema = z
  .record(z.string(), SubgraphProfileSchema);
export type SubgraphsConfig = z.infer<typeof SubgraphsConfigSchema>;

// ---------------------------------------------------------------------------
// Graph config schema
// ---------------------------------------------------------------------------

/**
 * Config for a single named graph entry.
 *
 * A graph defines which agent acts as the orchestrator and which agents are
 * sub-agents within that graph. When `subAgentKeys` is empty or omitted, the
 * graph runs in single-agent ReAct mode using only the orchestrator agent.
 */
export const GraphEntrySchema = z.object({
  /**
   * Key of the agent (from agents.json) to use as the orchestrator / sole
   * agent for this graph.
   */
  orchestratorAgentKey: z.string(),
  /**
   * Keys of agents (from agents.json) that act as sub-agents delegated to by
   * the orchestrator. When absent or empty the graph runs as a single-agent
   * ReAct loop.
   */
  subAgentKeys: z.array(z.string()).optional(),
  /**
   * Optional role-to-subgraph profile mapping.
   *
   * Memory and agent-specific compression profiles point at keys in
   * subgraphs.json.
   */
  subgraphs: z.object({
    memory: z.string().optional(),
    compression: z.record(z.string(), z.string()).optional(),
  }).optional(),
});
export type GraphEntry = z.infer<typeof GraphEntrySchema>;

/**
 * Top-level graphs.json schema.
 * Must contain a `default` key. Additional keys define named graphs (e.g.
 * `"scheduled"` for automated task execution).
 */
export const GraphsConfigSchema = z
  .record(z.string(), GraphEntrySchema)
  .refine((obj) => "default" in obj, {
    message: 'Configuration validation failed: graphs.json must contain a "default" graph entry',
  });
export type GraphsConfig = z.infer<typeof GraphsConfigSchema>;

/**
 * Fallback graph entry used when `graphs.json` is absent or the requested
 * graph key is not found. Points to the `"default"` agent as a single-agent
 * ReAct loop with no explicit sub-agents.
 */
export const DEFAULT_GRAPH_ENTRY: GraphEntry = { orchestratorAgentKey: "default" };

// ---------------------------------------------------------------------------
// Tool manager config schema
// ---------------------------------------------------------------------------

export const ToolManagerConfigSchema = z.object({
  /** Shared command template for starting tools. Must include {tool}. */
  commandTemplate: z.string().min(1).optional(),
  /** Graceful shutdown timeout before force kill. */
  shutdownTimeoutMs: z.number().int().positive().optional(),
  /** Additional wait after SIGKILL before concluding stop. */
  forceKillTimeoutMs: z.number().int().positive().optional(),
  /** In-memory per-tool log buffer size shown in TUI. */
  maxLogLines: z.number().int().positive().optional(),
}).superRefine((value, ctx) => {
  if (value.commandTemplate && !value.commandTemplate.includes("{tool}")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["commandTemplate"],
      message: 'toolManager.commandTemplate must include the "{tool}" token',
    });
  }
});
export type ToolManagerConfig = z.infer<typeof ToolManagerConfigSchema>;

// ---------------------------------------------------------------------------
// Gateway config schema
// ---------------------------------------------------------------------------

export const GatewayConfigSchema = z.object({
  /** Port for the health / control HTTP server. Defaults to 9090. */
  healthPort: z.number().int().positive().optional(),
  /** Host to bind the health server to. Defaults to "0.0.0.0". */
  healthHost: z.string().optional(),
  /** Path to the SQLite database for checkpoint persistence. */
  dbPath: z.string().optional(),
  /** Port for the AdminApi REST server. Defaults to 8081. */
  apiPort: z.number().int().positive().optional(),
  /** Host to bind the AdminApi server to. Defaults to "0.0.0.0". */
  apiHost: z.string().optional(),
  /** Authentication and bootstrap settings for web/admin surfaces. */
  auth: z.object({
    /** One-time setup token time-to-live in minutes. */
    setupTokenTtlMinutes: z.number().int().positive().optional(),
    /** User session token time-to-live in minutes. */
    sessionTtlMinutes: z.number().int().positive().optional(),
    /** Minimum allowed password length during bootstrap. */
    minPasswordLength: z.number().int().min(6).optional(),
  }).optional(),
});
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
