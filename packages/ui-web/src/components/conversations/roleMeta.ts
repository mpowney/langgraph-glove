import type { BrowserMessage } from "../../types";

export const ROLE_LABELS: Record<BrowserMessage["role"], string> = {
  human: "User",
  ai: "Agent",
  tool: "Tool",
  system: "System",
  prompt: "Prompt",
  "tool-call": "Tool Call",
  "tool-result": "Tool Result",
  "agent-transfer": "Agent Transfer",
  "model-call": "Model Call",
  "model-response": "Model Response",
  "graph-definition": "Graph Definition",
  "system-event": "System Event",
};
