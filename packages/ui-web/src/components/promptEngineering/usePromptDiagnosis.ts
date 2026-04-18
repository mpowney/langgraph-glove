import { useCallback, useState } from "react";
import type {
  ImprovePromptRequest,
  ImprovePromptResponse,
  PromptDiagnosisSummary,
} from "../../types";

type RequestState = "idle" | "loading" | "success" | "error";

export function usePromptDiagnosis(apiBaseUrl = "", authToken?: string) {
  const [summary, setSummary] = useState<PromptDiagnosisSummary>({
    mostLiked: [],
    mostDisliked: [],
  });
  const [summaryState, setSummaryState] = useState<RequestState>("idle");
  const [summaryError, setSummaryError] = useState<string>("");
  const [improveState, setImproveState] = useState<RequestState>("idle");
  const [improveError, setImproveError] = useState<string>("");

  const loadSummary = useCallback(async (limit = 10): Promise<void> => {
    setSummaryState("loading");
    setSummaryError("");
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/feedback/prompt-diagnosis/summary?limit=${encodeURIComponent(String(limit))}`,
        {
          headers: {
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
        },
      );

      if (!response.ok) {
        const failure = await response.text();
        throw new Error(failure || `HTTP ${response.status}`);
      }

      const payload = (await response.json()) as PromptDiagnosisSummary;
      setSummary({
        mostLiked: Array.isArray(payload.mostLiked) ? payload.mostLiked : [],
        mostDisliked: Array.isArray(payload.mostDisliked) ? payload.mostDisliked : [],
      });
      setSummaryState("success");
    } catch (err) {
      setSummaryState("error");
      setSummaryError(err instanceof Error ? err.message : String(err));
    }
  }, [apiBaseUrl, authToken]);

  const improvePrompt = useCallback(async (request: ImprovePromptRequest): Promise<ImprovePromptResponse> => {
    setImproveState("loading");
    setImproveError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/feedback/prompt-diagnosis/improve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const failure = await response.text();
        throw new Error(failure || `HTTP ${response.status}`);
      }

      const payload = (await response.json()) as ImprovePromptResponse;
      setImproveState("success");
      return payload;
    } catch (err) {
      setImproveState("error");
      const message = err instanceof Error ? err.message : String(err);
      setImproveError(message);
      throw err;
    }
  }, [apiBaseUrl, authToken]);

  return {
    summary,
    summaryState,
    summaryError,
    improveState,
    improveError,
    loadSummary,
    improvePrompt,
  };
}
