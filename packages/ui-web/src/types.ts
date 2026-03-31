/** Messages sent from server → browser client. */
export type ServerMessage =
  | { type: "chunk"; text: string; conversationId: string; role?: "user" | "agent" | "prompt" }
  | { type: "done"; conversationId: string }
  | { type: "error"; message: string; conversationId: string };

/** Messages sent from browser client → server. */
export interface ClientMessage {
  type: "message";
  text: string;
  conversationId: string;
}

/** App metadata served by the backend `/api/info` endpoint. */
export interface AppInfo {
  name: string;
  agentDescription?: string;
}

/** A single entry in the chat history. */
export interface ChatEntry {
  id: string;
  conversationId: string;
  role: "user" | "agent" | "prompt";
  content: string;
  isStreaming?: boolean;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
