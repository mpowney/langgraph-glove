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
      checkpoint?: CheckpointMetadata;
    }
  | { type: "prompt"; text: string; conversationId: string; checkpoint?: CheckpointMetadata }
  | {
      type: "tool_event";
      role: "tool-call" | "tool-result" | "agent-transfer";
      text: string;
      conversationId: string;
      checkpoint?: CheckpointMetadata;
      toolEventMetadata?: ToolEventMetadata;
    }
  | { type: "done"; conversationId: string; checkpoint?: CheckpointMetadata }
  | { type: "error"; message: string; conversationId: string; checkpoint?: CheckpointMetadata };

/** Messages sent from browser client → server. */
export interface ClientMessage {
  type: "message";
  text: string;
  conversationId: string;
  /**
   * Optional personal token for encrypted personal memory operations.
   * Pass `null` to explicitly clear the server-side token for this conversation.
   */
  personalToken?: string | null;
}

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
  role: "user" | "agent" | "prompt" | "tool-call" | "tool-result" | "agent-transfer" | "error";
  content: string;
  isStreaming?: boolean;
  /** ISO timestamp of when the payload was received/created by the browser. */
  receivedAt?: string;
  /** Checkpoint metadata sent by server when available. */
  checkpoint?: CheckpointMetadata;
  /** Tool parameter/schema metadata attached to tool-call and tool-result entries. */
  toolEventMetadata?: ToolEventMetadata;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

// ---------------------------------------------------------------------------
// Conversation browser API types (mirrors server BrowserMessage / ConversationSummary)
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  threadId: string;
  messageCount: number;
  latestCheckpointId: string;
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
