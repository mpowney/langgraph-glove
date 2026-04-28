import type { OutgoingMessage } from "../channels/Channel.js";

export type ObservabilityEventRole = NonNullable<OutgoingMessage["role"]>;

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
