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
}

/** Lightweight tool event metadata attached to live tool-call/tool-result entries. */
export interface ToolEventMetadata {
  tool: ToolDefinition;
  agentKey?: string;
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
    }
  | { type: "done"; conversationId: string; checkpoint?: CheckpointMetadata }
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
