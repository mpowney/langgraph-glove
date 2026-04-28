import type { OutgoingMessage } from "../channels/Channel.js";

export type ObservabilityEventRole = NonNullable<OutgoingMessage["role"]>;
export type ObservabilityScopeType = "InvokeAgent" | "ExecuteTool" | "Inference" | "Output";

/**
 * Normalized event shape for observability routing/fan-out.
 */
export interface ObservabilityEvent {
  eventId: string;
  timestamp: string;
  conversationId: string;
  role: ObservabilityEventRole;
  source: "agent" | "gateway";
  agentKey?: string;
  toolName?: string;
  payload?: unknown;
}

/**
 * Structured scope payload routed to modules that explicitly opt in.
 */
export interface ObservabilityScopeEvent {
  eventId: string;
  timestamp: string;
  conversationId: string;
  source: "agent" | "gateway";
  scopeType: ObservabilityScopeType;
  scope: unknown;
  agentKey?: string;
  toolName?: string;
}
