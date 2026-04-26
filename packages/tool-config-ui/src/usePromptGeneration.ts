import { useCallback } from "react";
import { createUuid } from "./uuid.js";

interface GeneratePromptRequest {
  userRequest: string;
  selectedGraph: string;
  selectedAgents: string[];
  selectedTools: string[];
}

export function usePromptGeneration(
  personalToken?: string,
  privilegeGrantId?: string,
  authToken?: string,
  configToolUrl?: string,
) {
  const resolveInvokeUrl = useCallback((): string => {
    if (configToolUrl?.trim()) {
      try {
        const configUrl = new URL(configToolUrl, window.location.origin);
        return new URL("/api/internal/invoke", configUrl.origin).toString();
      } catch {
        // Fall through to relative path when URL parsing fails.
      }
    }
    return "/api/internal/invoke";
  }, [configToolUrl]);

  const generatePrompt = useCallback(
    async (request: GeneratePromptRequest): Promise<string> => {
      if (!request.selectedGraph.trim()) {
        throw new Error("Please select a graph");
      }

      // Use a fresh conversation per generation request to avoid graph/context bleed.
      const conversationId = createUuid();

      const promptConstructionMessage = `${request.userRequest}

Available Agents: ${request.selectedAgents.join(", ") || "none selected"}
Available Tools: ${request.selectedTools.join(", ") || "none selected"}`;

      const response = await fetch(resolveInvokeUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          conversationId,
          prompt: promptConstructionMessage,
          graphKey: request.selectedGraph,
          ...(personalToken ? { personalToken } : {}),
          ...(privilegeGrantId ? { privilegeGrantId } : {}),
        }),
      });

      if (!response.ok) {
        const failure = await response.text();
        throw new Error(failure || `HTTP ${response.status}`);
      }

      const payload = (await response.json()) as { result?: string; error?: string };
      if (typeof payload.result === "string" && payload.result.trim()) {
        return payload.result.trim();
      }

      throw new Error(payload.error || "No response received from graph");
    },
    [authToken, personalToken, privilegeGrantId, resolveInvokeUrl],
  );

  return { generatePrompt };
}
