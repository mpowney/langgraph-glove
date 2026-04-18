import { useCallback } from "react";
import type { FeedbackContext } from "../types";

export type FeedbackSignal = "like" | "dislike";

export interface SubmitFeedbackInput {
  conversationId: string;
  messageId: string;
  messageRole: string;
  signal: FeedbackSignal;
  checkpointId?: string;
  sourceView: "live" | "history";
  feedbackContext?: FeedbackContext;
}

export function useFeedback(apiBaseUrl = "", authToken?: string) {
  const submitFeedback = useCallback(
    async (input: SubmitFeedbackInput): Promise<void> => {
      const modelName = input.feedbackContext?.modelName?.trim() || "unknown";
      const res = await fetch(`${apiBaseUrl}/api/feedback/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          conversationId: input.conversationId,
          messageId: input.messageId,
          messageRole: input.messageRole,
          signal: input.signal,
          modelName,
          modelKey: input.feedbackContext?.modelKey,
          agentKey: input.feedbackContext?.agentKey,
          promptUsageId: input.feedbackContext?.promptUsageId,
          promptOriginal: input.feedbackContext?.promptOriginal,
          promptOriginalHash: input.feedbackContext?.promptOriginalHash,
          promptResolved: input.feedbackContext?.promptResolved,
          promptResolvedHash: input.feedbackContext?.promptResolvedHash,
          checkpointId: input.checkpointId,
          sourceView: input.sourceView,
        }),
      });

      if (!res.ok) {
        throw new Error(`Feedback request failed with HTTP ${res.status}`);
      }
    },
    [apiBaseUrl, authToken],
  );

  return { submitFeedback };
}
