// Config loading & validation
export { ConfigLoader, resolveConfigEntry } from "./ConfigLoader.js";
export type { GloveConfig } from "./ConfigLoader.js";

// Secret management
export { SecretStore } from "./SecretStore.js";

// Model registry
export { ModelRegistry } from "./ModelRegistry.js";

// Zod schemas & types
export {
  ModelProviderSchema,
  ModelEntrySchema,
  ModelsConfigSchema,
  ChannelEntrySchema,
  ChannelsConfigSchema,
  AgentEntrySchema,
  AgentsConfigSchema,
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
  ToolTransport,
  ToolServerEntry,
  ToolsConfig,
  GatewayConfig,
} from "./schemas.js";
