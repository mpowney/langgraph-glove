import type { Express, Request, Response } from "express";
import type { AuthService } from "../auth/AuthService";
import { type FeedbackService, type FeedbackSignal } from "./FeedbackService";

interface RegisterFeedbackRoutesParams {
  feedbackService: FeedbackService;
  authService?: AuthService;
}

export function registerFeedbackRoutes(app: Express, params: RegisterFeedbackRoutesParams): void {
  const { feedbackService, authService } = params;

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
        promptOriginal: readBodyString(req.body, "promptOriginal") || undefined,
        promptOriginalHash: readBodyString(req.body, "promptOriginalHash") || undefined,
        promptResolved: readBodyString(req.body, "promptResolved") || undefined,
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
