import type { ComponentType } from "react";

/** Messages sent from server → browser client. */
export interface CheckpointMetadata {
  id: string;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Tool / agent capability types (mirrored from RpcProtocol, JSON-serialisable)
// ---------------------------------------------------------------------------

/** Full definition of a discovered tool (name, description, parameter schema). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's parameters. */
  parameters: Record<string, unknown>;
}

/** Single agent/sub-agent entry with its allowed tool names. */
export interface AgentCapabilityEntry {
  key: string;
  description: string;
  modelKey: string;
  /** Null means access to ALL tools; empty array means NO tools. */
  tools: string[] | null;
}

/** Payload returned by `GET /api/agents/capabilities`. */
export interface AgentCapabilityRegistry {
  agents: AgentCapabilityEntry[];
  tools: Record<string, ToolDefinition>;
  /** Filtered tool definitions for explicitly configured or auto-discovered agent tools. */
  toolDefinitions: Record<string, ToolDefinition>;
}

/** Lightweight tool event metadata attached to live tool-call/tool-result entries. */
export interface ToolEventMetadata {
  tool: ToolDefinition;
  agentKey?: string;
}

export interface ContentItem {
  contentRef: string;
  fileName?: string;
  mimeType?: string;
  byteLength?: number;
  downloadPath?: string;
  previewPath?: string;
}

export interface ToolReference {
  url: string;
  title: string;
  kind?: string;
  sourceTool?: string;
  metadata?: Record<string, unknown>;
}

export type ServerMessage =
  | {
      type: "chunk";
      text: string;
      conversationId: string;
      role?: "user" | "agent";
      streamSource?: "main" | "sub-agent";
      streamAgentKey?: string;
      checkpoint?: CheckpointMetadata;
      contentItems?: ContentItem[];
      references?: ToolReference[];
    }
  | { type: "prompt"; text: string; conversationId: string; checkpoint?: CheckpointMetadata }
  | {
      type: "tool_event";
      role: "tool-call" | "tool-result" | "agent-transfer" | "model-call" | "model-response" | "graph-definition" | "system-event";
      text: string;
      conversationId: string;
      checkpoint?: CheckpointMetadata;
      toolEventMetadata?: ToolEventMetadata;
      /** Optional tool name extracted from the message for UI access. */
      toolName?: string;
      /** Optional uploaded content references associated with the tool event. */
      contentItems?: ContentItem[];
      /** Optional normalized URL/title references associated with this tool event. */
      references?: ToolReference[];
    }
  | {
      type: "done";
      conversationId: string;
      checkpoint?: CheckpointMetadata;
      contentItems?: ContentItem[];
      references?: ToolReference[];
    }
  | { type: "error"; message: string; conversationId: string; checkpoint?: CheckpointMetadata }
  | { type: "conversation_metadata"; conversationId: string; metadata: { title?: string } };

/** Messages sent from browser client → server. */
export type ClientMessage =
  | {
      type: "message";
      text: string;
      conversationId: string;
      /**
       * Optional personal token for encrypted personal memory operations.
       * Pass `null` to explicitly clear the server-side token for this conversation.
       */
      personalToken?: string | null;
      /** Optional short-lived privilege grant for admin tool execution. */
      privilegeGrantId?: string | null;
    }
  | {
      /**
       * Context-only frame: registers or clears tokens in the server-side
       * per-conversation context without sending a message to the agent.
       * Used when tokens are set/cleared outside of a message send, or when
       * the client connects to (or switches to) a conversation that already
       * has active tokens in this browser session.
       */
      type: "context";
      conversationId: string;
      personalToken?: string | null;
      privilegeGrantId?: string | null;
    };

/** App metadata served by the backend `/api/info` endpoint. */
export interface AppInfo {
  name: string;
  agentDescription?: string;
  /** Base URL of the AdminApi server. When absent, the SPA uses the same origin. */
  apiUrl?: string;
  /** Active default model key used by the orchestrator/agent. */
  modelKey?: string;
  /** Active model context window size in tokens (best-effort). */
  modelContextWindowTokens?: number;
  /** Source of modelContextWindowTokens (e.g. config, ollama-show). */
  modelContextWindowSource?: string;
}

/** A single entry in the chat history. */
export interface ChatEntry {
  id: string;
  conversationId: string;
  role: "user" | "agent" | "prompt" | "tool-call" | "tool-result" | "agent-transfer" | "model-call" | "model-response" | "graph-definition" | "system-event" | "error" | "conversation-metadata";
  content: string;
  isStreaming?: boolean;
  /** Source stream classification for agent chunks. */
  streamSource?: "main" | "sub-agent";
  /** Sub-agent key/name when streamSource is "sub-agent". */
  streamAgentKey?: string;
  /** ISO timestamp of when the payload was received/created by the browser. */
  receivedAt?: string;
  /** Checkpoint metadata sent by server when available. */
  checkpoint?: CheckpointMetadata;
  /** Tool parameter/schema metadata attached to tool-call and tool-result entries. */
  toolEventMetadata?: ToolEventMetadata;
  /** Optional tool name extracted from the message for easy UI access. */
  toolName?: string;
  /** Optional uploaded content references associated with this entry. */
  contentItems?: ContentItem[];
  /** Optional normalized URL/title references associated with this entry. */
  references?: ToolReference[];
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

// ---------------------------------------------------------------------------
// Conversation browser API types (mirrors server BrowserMessage / ConversationSummary)
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  threadId: string;
  messageCount: number;
  latestCheckpointId: string;
  title?: string;
}

export interface BrowserMessage {
  id: string;
  role: "human" | "ai" | "tool" | "system";
  content: string;
  tool_calls?: Array<{ name: string; id: string; args: unknown }>;
  tool_call_id?: string;
  contentItems?: ContentItem[];
}

export interface ContentItemView {
  contentRef: string;
  conversationId: string;
  toolName: string;
  fileName?: string;
  mimeType?: string;
  byteLength: number;
  createdAt: string;
  deletedAt?: string;
  previewUrl?: string;
  downloadUrl?: string;
}

export interface ContentListResponse {
  items: ContentItemView[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
    hasMore: boolean;
  };
}

// ---------------------------------------------------------------------------
// Memory admin API types
// ---------------------------------------------------------------------------

export interface MemoryToolHealth {
  available: boolean;
  reason?: string;
  tools?: string[];
}

export type MemoryRetentionTier = "hot" | "warm" | "cold";

export interface MemorySummary {
  id: string;
  slug: string;
  title: string;
  scope: string;
  tags: string[];
  status: string;
  retentionTier: MemoryRetentionTier;
  storagePath: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  personal: boolean;
  lastIndexedAt?: string;
}

export interface MemoryDocument extends MemorySummary {
  content: string;
}

export interface MemorySearchResultItem {
  memory: MemorySummary;
  score: number;
  excerpts: string[];
}

export interface MemorySearchResult {
  query: string;
  retrievalMode: "vector-hybrid" | "lexical-fallback";
  embeddingModelKey: string;
  indexingStrategy: "immediate" | "deferred";
  results: MemorySearchResultItem[];
}

// ---------------------------------------------------------------------------
// Config admin API types
// ---------------------------------------------------------------------------

export interface ConfigFileSummary {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ConfigVersionSummary {
  id: string;
  filename: string;
  savedAt: string;
  description?: string;
  contentLength: number;
}

export interface ConfigVersion extends ConfigVersionSummary {
  content: string;
}

export interface ConfigValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

// ---------------------------------------------------------------------------
// Tool server status & dynamic panel registry
// ---------------------------------------------------------------------------

/** Mirror of the backend ToolServerStatus — returned by GET /api/tools/server-status. */
export interface ToolHealthDependency {
  name: string;
  ok: boolean;
  detail?: string;
  severity?: "error" | "warning";
}

export interface ToolHealthResult {
  ok: boolean;
  summary: string;
  dependencies: ToolHealthDependency[];
  latencyMs: number;
}

export interface ToolServerStatus {
  key: string;
  configured: boolean;
  discovered: boolean;
  healthy?: boolean;
  error?: string;
  healthError?: string;
  health?: ToolHealthResult;
  toolNames: string[];
}

/**
 * Props passed by ui-web into every dynamically-loaded tool panel component.
 * Companion packages that export a panel must accept this interface as their
 * component props (they may ignore fields they don't need).
 */
export interface ToolPanelProps {
  open: boolean;
  onClose: () => void;
  adminApiBaseUrl?: string;
  authToken?: string;
  personalToken?: string;
  privilegedGrantId?: string;
  conversationId?: string;
  privilegedAccessActive?: boolean;
  privilegedAccessExpiresAt?: string;
  onEnablePrivilegedAccessWithToken?: (token: string) => Promise<boolean>;
  onEnablePrivilegedAccessWithPasskey?: () => Promise<boolean>;
  onDisablePrivilegedAccess?: () => void;
  privilegeTokenRegistered?: boolean;
  onRegisterPrivilegeToken?: (newToken: string, currentToken?: string) => Promise<boolean>;
  authError?: string | null;
  passkeyEnabled?: boolean;
}

/** Static metadata exported by a tool UI companion package alongside its default component. */
export interface ToolPanelMeta {
  /** Used to match against server keys in tools.json. */
  serverKey: string;
  /** 'exact' matches one server key; 'prefix' matches all keys starting with serverKey. */
  matchStrategy: "exact" | "prefix";
  /** Label shown in ControlPanel CompoundButton. */
  label: string;
  /** Secondary text shown in ControlPanel CompoundButton. */
  description: string;
}

/**
 * A resolved panel entry passed to ControlPanel for rendering.
 * If status is 'error', `load` is absent (no panel to open).
 */
export interface AvailablePanel {
  /** Group key: the serverKey from ToolPanelMeta, or first instanceKey for prefix groups. */
  panelKey: string;
  label: string;
  description: string;
  /** 'ok' = all matching instances discovered; 'error' = at least one failed. */
  status: "ok" | "error";
  /** All matching server keys covered by this panel entry. */
  instanceKeys: string[];
  /** Per-key error messages, populated when status='error'. */
  errors: Record<string, string>;
  /** Lazy loader — only present when status='ok' and a UI companion package is registered. */
  load?: () => Promise<{ default: ComponentType<ToolPanelProps> }>;
}

