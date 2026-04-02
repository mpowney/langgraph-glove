import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { sessionManager } from "../SessionManager.js";

export const openToolMetadata: ToolMetadata = {
  name: "browse_open",
  description:
    "Use {name} to open a new browser session by navigating to the given URL. Returns a session ID " +
    "that must be used with other browse_* tools. Sessions automatically expire after " +
    "5 minutes of inactivity. Close sessions when done using browse_close.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The full URL to navigate to, e.g. 'https://example.com/form'.",
      },
    },
    required: ["url"],
  },
};

export async function handleOpen(
  params: Record<string, unknown>,
): Promise<{ sessionId: string; title: string; url: string }> {
  const url = params["url"] as string;
  if (!url || typeof url !== "string") {
    throw new Error("browse_open: 'url' parameter is required and must be a string");
  }
  return sessionManager.open(url);
}
