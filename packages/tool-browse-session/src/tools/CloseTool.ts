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
        type: "string",
        description: "The session ID returned by browse_open.",
      },
    },
    required: ["sessionId"],
  },
};

export async function handleClose(
  params: Record<string, unknown>,
): Promise<{ closed: boolean }> {
  const sessionId = params["sessionId"] as string;
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("browse_close: 'sessionId' parameter is required");
  }
  await sessionManager.close(sessionId);
  return { closed: true };
}
