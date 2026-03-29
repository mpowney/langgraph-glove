import { z } from "zod";

// ---------------------------------------------------------------------------
// Secret reference pattern: {SECRET:secret-name}
// ---------------------------------------------------------------------------

/** Regex that matches `{SECRET:some-name}` placeholders in config values. */
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
  /** Channel implementation type. */
  type: z.string(),
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
  /** Tool names this agent is allowed to use. Empty/missing = all tools. */
  tools: z.array(z.string()).optional(),
  /** Maximum ReAct loop steps before aborting. */
  recursionLimit: z.number().int().positive().optional(),
});
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

export const AgentsConfigSchema = z
  .record(z.string(), AgentEntrySchema)
  .refine((obj) => "default" in obj, {
    message: 'agents.json must contain a "default" key',
  });
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
