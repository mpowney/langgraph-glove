// Config loading & validation
export { ConfigLoader, resolveConfigEntry } from "./ConfigLoader.js";
export type { GloveConfig } from "./ConfigLoader.js";

// Secret management
export { SecretStore } from "./SecretStore.js";

// Model registry
export { ModelRegistry } from "./ModelRegistry.js";
export { EmbeddingRegistry } from "./EmbeddingRegistry.js";

// Zod schemas & types
export {
  ModelProviderSchema,
  ModelEntrySchema,
  ModelsConfigSchema,
  ChannelEntrySchema,
  ChannelsConfigSchema,
  AgentEntrySchema,
  AgentsConfigSchema,
  MemoryStorageModeSchema,
  MemoryRetentionTierSchema,
  MemoryChunkingConfigSchema,
  MemoryRetrievalConfigSchema,
  MemoryTierConfigSchema,
  MemoryEntrySchema,
  MemoriesConfigSchema,
  ToolTransportSchema,
  ToolServerEntrySchema,
  ToolsConfigSchema,
  GatewayConfigSchema,
  SECRET_REF_PATTERN,
} from "./schemas.js";
export type {
  ModelProvider,
  ModelEntry,
  ModelsConfig,
  ChannelEntry,
  ChannelsConfig,
  AgentEntry,
  AgentsConfig,
  MemoryStorageMode,
  MemoryRetentionTier,
  MemoryChunkingConfig,
  MemoryRetrievalConfig,
  MemoryTierConfig,
  MemoryEntry,
  MemoriesConfig,
  ToolTransport,
  ToolServerEntry,
  ToolsConfig,
  GatewayConfig,
} from "./schemas.js";
