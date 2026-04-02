import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { sessionManager } from "../SessionManager.js";

export const closeToolMetadata: ToolMetadata = {
  name: "browse_close",
  description:
    "Use {name} to close an existing browser session, freeing its resources. Always close sessions " +
    "when you are done with them.",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: ["string", "null"],
        description:
          "Optional session ID returned by browse_open. If null or omitted, the tool reuses the latest active session or creates a new one.",
      },
    },
  },
};

export async function handleClose(
  params: Record<string, unknown>,
): Promise<{ sessionId: string; closed: boolean }> {
  const sessionId = await sessionManager.resolveSessionId(params["sessionId"]);
  await sessionManager.close(sessionId);
  return { sessionId, closed: true };
}
