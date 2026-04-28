import type { ObservabilityModuleEntry } from "@langgraph-glove/config";

export interface ObservabilityOutboundEvent {
  eventId: string;
  timestamp: string;
  conversationId: string;
  role: string;
  source: "agent" | "gateway";
  text: string;
  toolName?: string;
  agentKey?: string;
  payload?: unknown;
}

export interface ObserveSendPayload {
  moduleKey: string;
  event: ObservabilityOutboundEvent;
}

export interface ObserveTransportClient {
  send(moduleKey: string, module: ObservabilityModuleEntry, payload: ObserveSendPayload): Promise<void>;
}

export interface DurableQueueRecord {
  id: number;
  moduleKey: string;
  eventJson: string;
  attemptCount: number;
  nextAttemptAt: number;
}
