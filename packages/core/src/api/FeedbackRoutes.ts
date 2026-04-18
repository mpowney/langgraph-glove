import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { AuthService } from "../auth/AuthService";
import { type FeedbackService, type FeedbackSignal } from "./FeedbackService";

interface RegisterFeedbackRoutesParams {
  feedbackService: FeedbackService;
  authService?: AuthService;
  invokeAgent?: (params: {
    agentKey: string;
    conversationId: string;
    prompt: string;
    graphKey?: string;
  }) => Promise<string>;
}

export function registerFeedbackRoutes(app: Express, params: RegisterFeedbackRoutesParams): void {
  const { feedbackService, authService, invokeAgent } = params;

  const requireAuth = (req: Request, res: Response): { userId?: string } | null => {
    if (!authService) return {};
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Missing bearer token" });
      return null;
    }
    const user = authService.authenticateSession(token);
    if (!user) {
      res.status(401).json({ error: "Invalid or expired session" });
      return null;
    }
    return { userId: user.userId };
  };

  app.post("/api/feedback/events", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const signal = readSignal(req.body, "signal");
    const conversationId = readBodyString(req.body, "conversationId");
    const messageId = readBodyString(req.body, "messageId");
    const messageRole = readBodyString(req.body, "messageRole");
    const modelName = readBodyString(req.body, "modelName");

    if (!signal || !conversationId || !messageId || !messageRole || !modelName) {
      res.status(400).json({
        error: "signal, conversationId, messageId, messageRole, and modelName are required",
      });
      return;
    }

    try {
      const row = feedbackService.upsertFeedbackEvent({
        signal,
        conversationId,
        messageId,
        messageRole,
        modelName,
        modelKey: readBodyString(req.body, "modelKey") || undefined,
        promptUsageId: readBodyString(req.body, "promptUsageId") || undefined,
        promptOriginalHash: readBodyString(req.body, "promptOriginalHash") || undefined,
        promptResolvedHash: readBodyString(req.body, "promptResolvedHash") || undefined,
        checkpointId: readBodyString(req.body, "checkpointId") || undefined,
        agentKey: readBodyString(req.body, "agentKey") || undefined,
        sourceView: readSourceView(req.body, "sourceView"),
        note: readBodyString(req.body, "note") || undefined,
        userId: auth.userId,
      });
      res.status(201).json(row);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/feedback/events/:id", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }

    const row = feedbackService.getFeedbackEvent(id);
    if (!row) {
      res.status(404).json({ error: "feedback event not found" });
      return;
    }
    res.json(row);
  });

  app.get("/api/feedback/messages/:messageId", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const messageId = String(req.params.messageId ?? "").trim();
    const conversationId = String(req.query.conversationId ?? "").trim();
    if (!messageId || !conversationId) {
      res.status(400).json({ error: "messageId and query param conversationId are required" });
      return;
    }

    const row = feedbackService.getFeedbackByMessage(conversationId, messageId);
    if (!row) {
      res.status(404).json({ error: "feedback event not found" });
      return;
    }
    res.json(row);
  });

  app.get("/api/feedback/prompt-diagnosis/summary", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const limitRaw = String(req.query.limit ?? "10").trim();
    const limit = Number.parseInt(limitRaw, 10);

    try {
      const summary = feedbackService.getPromptDiagnosisSummary(Number.isFinite(limit) ? limit : 10);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/feedback/prompt-diagnosis/improve", (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;

    if (!invokeAgent) {
      res.status(503).json({ error: "Prompt improvement is not available" });
      return;
    }

    const promptText = readBodyString(req.body, "promptText");
    const dislikedMessageText = readBodyString(req.body, "dislikedMessageText");
    const userRequest = readBodyString(req.body, "userRequest");
    const conversationId = readBodyString(req.body, "conversationId") || randomUUID();

    if (!promptText) {
      res.status(400).json({ error: "promptText is required" });
      return;
    }
    if (!dislikedMessageText) {
      res.status(400).json({ error: "dislikedMessageText is required" });
      return;
    }

    void (async () => {
      try {
        const prompt = buildPromptImprovementRequest({
          promptText,
          dislikedMessageText,
          userRequest,
        });
        const result = await invokeAgent({
          agentKey: "system-prompt-engineering",
          conversationId,
          prompt,
          graphKey: "system-prompt-engineering",
        });

        res.json({
          conversationId,
          improvedPrompt: result,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

function buildPromptImprovementRequest(input: {
  promptText: string;
  dislikedMessageText: string;
  userRequest: string;
}): string {
  const userRequestBlock = input.userRequest
    ? `\n\nUser guidance on how to improve it:\n${input.userRequest}`
    : "\n\nUser guidance on how to improve it:\n(No additional guidance provided.)";

  return [
    "Improve this system prompt using the disliked output context.",
    "Return only the improved system prompt text.",
    "",
    "Current system prompt:",
    input.promptText,
    "",
    "Message that was disliked:",
    input.dislikedMessageText,
    userRequestBlock,
  ].join("\n");
}

function readBodyString(body: unknown, key: string): string {
  if (!body || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") return "";
  return value.trim();
}

function readSignal(body: unknown, key: string): FeedbackSignal | undefined {
  const value = readBodyString(body, key).toLowerCase();
  if (value === "like" || value === "dislike") return value;
  return undefined;
}

function readSourceView(body: unknown, key: string): "live" | "history" | undefined {
  const value = readBodyString(body, key).toLowerCase();
  if (value === "live" || value === "history") return value;
  return undefined;
}

function readBearerToken(req: Request): string {
  const header = req.header("authorization");
  if (!header) return "";
  if (!header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}
