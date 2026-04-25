import http from "node:http";
import { join } from "node:path";
import { URL } from "node:url";
import { v4 as uuidv4 } from "uuid";
import express, { type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import Database from "better-sqlite3";
import type { ChannelEntry } from "@langgraph-glove/config";
import { distPath } from "@langgraph-glove/ui-web";
import { z } from "zod";
import { Channel } from "./Channel";
import type {
  ChannelConfig,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  OutgoingStreamChunk,
  StreamSource,
  OutgoingContentItem,
  OutgoingToolReference,
} from "./Channel";
import type { AuthService } from "../auth/AuthService";
import type { ToolEventMetadata } from "../rpc/RpcProtocol";

export const WebChannelSettingsSchema = z.object({
  port: z.number().int().positive().optional(),
  host: z.string().min(1).optional(),
  receiveAgentProcessing: z.boolean().optional(),
  receiveSystem: z.boolean().optional(),
  allowedUrlProtocols: z.array(z.string().min(1)).optional(),
});

const DEFAULT_ALLOWED_URL_PROTOCOLS = ["http", "https", "sandbox"] as const;

function normalizeUrlProtocol(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  let normalized = trimmed;
  if (normalized.endsWith(":")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.endsWith("://")) {
    normalized = normalized.slice(0, -3);
  }

  if (!/^[a-z][a-z0-9+.-]*$/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeAllowedUrlProtocols(configured?: string[]): string[] {
  const unique = new Set<string>(DEFAULT_ALLOWED_URL_PROTOCOLS);
  for (const value of configured ?? []) {
    const normalized = normalizeUrlProtocol(value);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique];
}

export interface WebChannelFactoryContext {
  checkpointDbPath?: string;
  appInfo?: WebChannelConfig["appInfo"];
}

export function createWebChannelFromConfig(
  entry: ChannelEntry | undefined,
  context: WebChannelFactoryContext,
): WebChannel {
  if (entry?.enabled === false) {
    throw new Error('Web channel is disabled in channels.json');
  }

  const result = WebChannelSettingsSchema.safeParse(entry?.settings ?? {});
  if (!result.success) {
    throw new Error(`Invalid channels.json web settings: ${result.error.message}`);
  }

  return new WebChannel({
    port: result.data.port,
    host: result.data.host,
    receiveAgentProcessing: result.data.receiveAgentProcessing ?? true,
    receiveSystem: result.data.receiveSystem ?? false,
    allowedUrlProtocols: normalizeAllowedUrlProtocols(result.data.allowedUrlProtocols),
    appInfo: context.appInfo,
    checkpointDbPath: context.checkpointDbPath,
  });
}

/** Messages sent from browser client → server. */
type ClientMessage =
  | {
      type: "message";
      text: string;
      conversationId: string;
      /**
       * Optional personal token supplied by the browser for encrypted personal
       * memory operations. Stored in-memory per conversation and never logged
       * or persisted to disk.
       */
      personalToken?: string | null;
      /** Optional short-lived privilege grant supplied by the browser. */
      privilegeGrantId?: string | null;
    }
  | {
      /**
       * Context-only frame: updates server-side per-conversation token state
       * without dispatching a message to the agent.
       */
      type: "context";
      conversationId: string;
      personalToken?: string | null;
      privilegeGrantId?: string | null;
    };

/** Messages sent from server → browser client. */
interface CheckpointMetadata {
  id: string;
  timestamp?: string;
}

type ServerMessage =
  | {
      type: "chunk";
      text: string;
      conversationId: string;
      role?: "user" | "agent";
      streamSource?: StreamSource;
      streamAgentKey?: string;
      checkpoint?: CheckpointMetadata;
      contentItems?: OutgoingContentItem[];
      references?: OutgoingToolReference[];
    }
  | { type: "prompt"; text: string; conversationId: string; checkpoint?: CheckpointMetadata }
  | {
      type: "tool_event";
      role: "tool-call" | "tool-result" | "agent-transfer" | "model-call" | "model-response" | "graph-definition" | "system-event";
      text: string;
      conversationId: string;
      checkpoint?: CheckpointMetadata;
      /** Optional structured metadata carrying tool parameter schema and agent context. */
      toolEventMetadata?: ToolEventMetadata;
      /** Optional tool name extracted from the message for UI access. */
      toolName?: string;
      /** Optional uploaded content references associated with this tool event. */
      contentItems?: OutgoingContentItem[];
      /** Optional normalized URL/title references associated with this tool event. */
      references?: OutgoingToolReference[];
    }
  | {
      type: "done";
      conversationId: string;
      checkpoint?: CheckpointMetadata;
      contentItems?: OutgoingContentItem[];
      references?: OutgoingToolReference[];
    }
  | { type: "error"; message: string; conversationId: string; checkpoint?: CheckpointMetadata }
  | { type: "conversation_metadata"; conversationId: string; metadata: { title?: string } };

interface CheckpointRow {
  checkpoint_id: string;
  checkpoint: string;
}

interface CheckpointEnvelope {
  ts?: unknown;
}

export interface WebChannelConfig extends ChannelConfig {
  /** Port for the HTTP + WebSocket server. Default: `8080`. */
  port?: number;
  /** Hostname to bind. Default: `"0.0.0.0"`. */
  host?: string;
  /** Optional metadata surfaced to the React SPA via `GET /api/info`. */
  appInfo?: {
    /** App name shown in the header. Defaults to "LangGraph Glove". */
    name?: string;
    /** Short description of the active agent, shown beneath the app name. */
    agentDescription?: string;
    /**
     * Base URL of the AdminApi server (e.g. `"http://localhost:8081"`).
     * When provided the SPA uses this URL as the base for admin API calls
     * (conversation browser, etc.) instead of the same origin.
     */
    apiUrl?: string;
    /** Active default model key used for prompt context estimation. */
    modelKey?: string;
    /** Active model context window size in tokens (best-effort). */
    modelContextWindowTokens?: number;
    /** Source of context window value (e.g. config, ollama-show). */
    modelContextWindowSource?: string;
  };
  /** Optional path to the SQLite checkpointer database for checkpoint metadata. */
  checkpointDbPath?: string;
  /** Allowed URL protocols that the authenticated UI can render as links. */
  allowedUrlProtocols?: string[];
  /**
   * Optional auth service.  When provided every WebSocket upgrade request
   * must carry a valid session token in the `?token=` query parameter;
   * connections without a valid token are rejected with HTTP 401.
   */
  authService?: AuthService;
}

/**
 * A streaming channel that serves a browser-based chat UI over HTTP and
 * communicates in real-time via WebSocket.
 *
 * - HTTP static files are served from the compiled `@langgraph-glove/ui-web` SPA.
 * - `GET /api/info` returns app metadata (name, agentDescription, apiUrl) consumed by the SPA.
 * - WebSocket upgrade on the same port handles message exchange.
 * - Each browser tab creates its own `conversationId` (UUID), which is used
 *   as the LangGraph thread ID — giving each tab its own conversation history.
 *
 * Admin/system REST APIs (conversation browser, etc.) are served on a
 * separate port by {@link AdminApi}.
 */
export class WebChannel extends Channel {
  readonly name = "web";
  readonly supportsStreaming = true;

  private app: Express;
  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private readonly port: number;
  private readonly host: string;
  private appInfo: Required<NonNullable<WebChannelConfig["appInfo"]>>;
  private readonly checkpointDbPath?: string;
  private checkpointDb?: Database.Database;
  private authService?: AuthService;
  private readonly allowedUrlProtocols: string[];
  private readonly pendingDefaultAgentContentItems = new Map<string, OutgoingContentItem[]>();
  private readonly pendingMainToolReferences = new Map<string, OutgoingToolReference[]>();
  private readonly pendingSubAgentToolReferences = new Map<string, Map<string, OutgoingToolReference[]>>();

  constructor(config: WebChannelConfig = {}) {
    super(config);
    this.port = config.port ?? 8080;
    this.host = config.host ?? "0.0.0.0";
    this.appInfo = {
      name: config.appInfo?.name ?? "LangGraph Glove",
      agentDescription: config.appInfo?.agentDescription ?? "",
      apiUrl: config.appInfo?.apiUrl ?? "",
      modelKey: config.appInfo?.modelKey ?? "",
      modelContextWindowTokens: config.appInfo?.modelContextWindowTokens ?? 0,
      modelContextWindowSource: config.appInfo?.modelContextWindowSource ?? "",
    };
    this.checkpointDbPath = config.checkpointDbPath;
    this.authService = config.authService;
    this.allowedUrlProtocols = normalizeAllowedUrlProtocols(config.allowedUrlProtocols);

    if (this.checkpointDbPath) {
      try {
        this.checkpointDb = new Database(this.checkpointDbPath, {
          readonly: true,
          fileMustExist: true,
        });
      } catch {
        // Checkpoint metadata enrichment is optional for websocket payloads.
        this.checkpointDb = undefined;
      }
    }

    this.app = express();

    // Serve the compiled React SPA
    this.app.use(express.static(distPath));

    // Expose app metadata to the SPA (name, agentDescription, adminApi URL)
    this.app.get("/api/info", (_req, res) => {
      res.json({
        name: this.appInfo.name,
        ...(this.appInfo.agentDescription && {
          agentDescription: this.appInfo.agentDescription,
        }),
        ...(this.appInfo.apiUrl && {
          apiUrl: this.appInfo.apiUrl,
        }),
        ...(this.appInfo.modelKey && {
          modelKey: this.appInfo.modelKey,
        }),
        ...(this.appInfo.modelContextWindowTokens > 0 && {
          modelContextWindowTokens: this.appInfo.modelContextWindowTokens,
        }),
        ...(this.appInfo.modelContextWindowSource && {
          modelContextWindowSource: this.appInfo.modelContextWindowSource,
        }),
      });
    });

    // Expose URL protocol allowlist to authenticated UI clients.
    this.app.get("/api/link-protocols", (req, res) => {
      if (this.authService) {
        const authHeader = req.header("authorization") ?? "";
        const [scheme, token] = authHeader.split(/\s+/, 2);
        const isBearer = scheme?.toLowerCase() === "bearer";
        const authenticated = isBearer && token
          ? this.authService.authenticateSession(token)
          : null;
        if (!authenticated) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
      }

      res.json({
        protocols: this.allowedUrlProtocols,
      });
    });

    // SPA fallback — serve index.html for any unmatched GET
    this.app.get("*", (_req, res) => {
      res.sendFile(join(distPath, "index.html"));
    });
  }

  /**
   * Inject an auth service after construction.  Called by the Gateway after
   * it creates the AuthService, before channels are started.
   */
  setAuthService(svc: AuthService): void {
    this.authService = svc;
  }

  setAppInfo(partial: Partial<NonNullable<WebChannelConfig["appInfo"]>>): void {
    this.appInfo = {
      ...this.appInfo,
      ...partial,
      modelContextWindowTokens:
        partial.modelContextWindowTokens ?? this.appInfo.modelContextWindowTokens,
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer(this.app);

      // When an AuthService is configured, validate the session token supplied
      // as a `?token=` query parameter on every WebSocket upgrade request.
      // The token is read from the URL before any application code runs and is
      // never echoed back or logged.
      const authService = this.authService;
      type VerifyClientSync = (info: { req: http.IncomingMessage }) => boolean;
      const verifyClient: VerifyClientSync | undefined = authService
        ? (info) => {
            try {
              const url = new URL(
                info.req.url ?? "/",
                `http://${info.req.headers.host ?? "localhost"}`,
              );
              const token = url.searchParams.get("token");
              return !!(token && authService.authenticateSession(token));
            } catch {
              return false;
            }
          }
        : undefined;

      this.wss = new WebSocketServer({ server: this.httpServer, ...(verifyClient ? { verifyClient } : {}) });

      this.wss.on("connection", (ws) => this.handleConnection(ws));

      this.httpServer.listen(this.port, this.host, () => {
        console.log(`[WebChannel] Listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss?.close();
      this.checkpointDb?.close();
      this.httpServer?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  onMessage(handler: MessageHandler): void {
    this.setMessageHandler(handler);
  }

  /** Sends a complete message to all WebSocket clients that share the conversationId. */
  async sendMessage(message: OutgoingMessage): Promise<void> {
    if (message.role === "prompt") {
      const payload: ServerMessage = {
        type: "prompt",
        text: message.text,
        conversationId: message.conversationId,
        checkpoint: this.lookupCheckpointMetadata(message.conversationId),
      };
      this.broadcast(message.conversationId, payload);
      return;
    }

    if (message.role === "error") {
      const payload: ServerMessage = {
        type: "error",
        message: message.text,
        conversationId: message.conversationId,
        checkpoint: this.lookupCheckpointMetadata(message.conversationId),
      };
      this.broadcast(message.conversationId, payload);
      return;
    }

    if (message.role === "conversation-metadata") {
      let metadata: { title?: string } = {};
      try {
        const parsed = JSON.parse(message.text) as unknown;
        if (parsed !== null && typeof parsed === "object") {
          metadata = parsed as { title?: string };
        }
      } catch {
        // malformed payload — broadcast empty metadata
      }
      const payload: ServerMessage = {
        type: "conversation_metadata",
        conversationId: message.conversationId,
        metadata,
      };
      this.broadcast(message.conversationId, payload);
      return;
    }

    if (
      message.role === "tool-call"
      || message.role === "tool-result"
      || message.role === "agent-transfer"
      || message.role === "model-call"
      || message.role === "model-response"
      || message.role === "graph-definition"
      || message.role === "system-event"
    ) {
      const payload: ServerMessage = {
        type: "tool_event",
        role: message.role,
        text: message.text,
        conversationId: message.conversationId,
        checkpoint: this.lookupCheckpointMetadata(message.conversationId),
        ...(message.toolEventMetadata ? { toolEventMetadata: message.toolEventMetadata } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.contentItems && message.contentItems.length > 0
          ? { contentItems: message.contentItems }
          : {}),
        ...(message.references && message.references.length > 0
          ? { references: message.references }
          : {}),
      };
      this.broadcast(message.conversationId, payload);
      if (
        message.role === "tool-result"
      ) {
        if (
          message.contentItems
          && message.contentItems.length > 0
          && this.isDefaultAgentToolEvent(message.toolEventMetadata)
        ) {
          this.addPendingDefaultAgentContentItems(message.conversationId, message.contentItems);
        }
        if (message.references && message.references.length > 0) {
          this.addPendingToolReferences(
            message.conversationId,
            message.references,
            message.toolEventMetadata?.agentKey,
          );
        }
      }
      return;
    }

    const doneContentItems = this.mergeContentItems(
      message.contentItems,
      this.drainPendingDefaultAgentContentItems(message.conversationId),
    );
    const doneReferences = this.mergeToolReferences(
      message.references,
      this.drainPendingMainToolReferences(message.conversationId),
    );
    const payload: ServerMessage = {
      type: "chunk",
      text: message.text,
      conversationId: message.conversationId,
      role: message.role,
      checkpoint: this.lookupCheckpointMetadata(message.conversationId),
      ...(message.contentItems && message.contentItems.length > 0
        ? { contentItems: message.contentItems }
        : {}),
      ...(message.references && message.references.length > 0
        ? { references: message.references }
        : {}),
    };
    this.broadcast(message.conversationId, payload);
    this.broadcast(message.conversationId, {
      type: "done",
      conversationId: message.conversationId,
      checkpoint: this.lookupCheckpointMetadata(message.conversationId),
      ...(doneContentItems && doneContentItems.length > 0
        ? { contentItems: doneContentItems }
        : {}),
      ...(doneReferences && doneReferences.length > 0
        ? { references: doneReferences }
        : {}),
    });
  }

  /**
   * Streams token chunks to the WebSocket client.
   * Each chunk is sent as a `{ type: "chunk" }` frame; a final `{ type: "done" }`
   * frame signals end-of-response.
   */
  override async sendStream(
    conversationId: string,
    stream: AsyncIterable<OutgoingStreamChunk>,
  ): Promise<void> {
    for await (const chunk of stream) {
      const chunkReferences = chunk.source === "sub-agent"
        ? this.drainPendingSubAgentToolReferences(conversationId, chunk.agentKey)
        : this.drainPendingMainToolReferences(conversationId);
      this.broadcast(conversationId, {
        type: "chunk",
        text: chunk.text,
        conversationId,
        streamSource: chunk.source,
        ...(chunk.agentKey ? { streamAgentKey: chunk.agentKey } : {}),
        checkpoint: this.lookupCheckpointMetadata(conversationId),
        ...(chunkReferences && chunkReferences.length > 0
          ? { references: chunkReferences }
          : {}),
      });
    }
    const doneContentItems = this.drainPendingDefaultAgentContentItems(conversationId);
    const doneReferences = this.drainPendingMainToolReferences(conversationId);
    this.broadcast(conversationId, {
      type: "done",
      conversationId,
      checkpoint: this.lookupCheckpointMetadata(conversationId),
      ...(doneContentItems && doneContentItems.length > 0
        ? { contentItems: doneContentItems }
        : {}),
      ...(doneReferences && doneReferences.length > 0
        ? { references: doneReferences }
        : {}),
    });
  }

  private isDefaultAgentToolEvent(metadata?: ToolEventMetadata): boolean {
    const agentKey = metadata?.agentKey?.trim();
    return !agentKey || agentKey === "default";
  }

  private addPendingDefaultAgentContentItems(
    conversationId: string,
    items: OutgoingContentItem[],
  ): void {
    const existing = this.pendingDefaultAgentContentItems.get(conversationId) ?? [];
    const merged = this.mergeContentItems(existing, items);
    if (merged && merged.length > 0) {
      this.pendingDefaultAgentContentItems.set(conversationId, merged);
    }
  }

  private drainPendingDefaultAgentContentItems(
    conversationId: string,
  ): OutgoingContentItem[] | undefined {
    const existing = this.pendingDefaultAgentContentItems.get(conversationId);
    if (!existing || existing.length === 0) return undefined;
    this.pendingDefaultAgentContentItems.delete(conversationId);
    return existing;
  }

  private mergeContentItems(
    first?: OutgoingContentItem[],
    second?: OutgoingContentItem[],
  ): OutgoingContentItem[] | undefined {
    const merged: OutgoingContentItem[] = [];
    const seenRefs = new Set<string>();
    for (const item of [...(first ?? []), ...(second ?? [])]) {
      if (seenRefs.has(item.contentRef)) continue;
      seenRefs.add(item.contentRef);
      merged.push(item);
    }
    return merged.length > 0 ? merged : undefined;
  }

  private mergeToolReferences(
    first?: OutgoingToolReference[],
    second?: OutgoingToolReference[],
  ): OutgoingToolReference[] | undefined {
    const merged: OutgoingToolReference[] = [];
    const seenUrls = new Set<string>();
    for (const item of [...(first ?? []), ...(second ?? [])]) {
      const key = item.url.trim();
      if (!key || seenUrls.has(key)) continue;
      seenUrls.add(key);
      merged.push(item);
    }
    return merged.length > 0 ? merged : undefined;
  }

  private addPendingToolReferences(
    conversationId: string,
    references: OutgoingToolReference[],
    agentKey?: string,
  ): void {
    const mergedMain = this.mergeToolReferences(
      this.pendingMainToolReferences.get(conversationId),
      references,
    );
    if (mergedMain && mergedMain.length > 0) {
      this.pendingMainToolReferences.set(conversationId, mergedMain);
    }

    const trimmedAgentKey = agentKey?.trim();
    if (!trimmedAgentKey || trimmedAgentKey === "default") {
      return;
    }
    const byAgent = this.pendingSubAgentToolReferences.get(conversationId) ?? new Map<string, OutgoingToolReference[]>();
    const mergedSubAgent = this.mergeToolReferences(byAgent.get(trimmedAgentKey), references);
    if (mergedSubAgent && mergedSubAgent.length > 0) {
      byAgent.set(trimmedAgentKey, mergedSubAgent);
      this.pendingSubAgentToolReferences.set(conversationId, byAgent);
    }
  }

  private drainPendingMainToolReferences(
    conversationId: string,
  ): OutgoingToolReference[] | undefined {
    const existing = this.pendingMainToolReferences.get(conversationId);
    if (!existing || existing.length === 0) return undefined;
    this.pendingMainToolReferences.delete(conversationId);
    return existing;
  }

  private drainPendingSubAgentToolReferences(
    conversationId: string,
    agentKey?: string,
  ): OutgoingToolReference[] | undefined {
    const trimmedAgentKey = agentKey?.trim();
    if (!trimmedAgentKey) return undefined;
    const byAgent = this.pendingSubAgentToolReferences.get(conversationId);
    if (!byAgent) return undefined;
    const existing = byAgent.get(trimmedAgentKey);
    if (!existing || existing.length === 0) return undefined;
    byAgent.delete(trimmedAgentKey);
    if (byAgent.size === 0) {
      this.pendingSubAgentToolReferences.delete(conversationId);
    } else {
      this.pendingSubAgentToolReferences.set(conversationId, byAgent);
    }
    return existing;
  }

  private handleConnection(ws: WebSocket): void {
    ws.on("message", async (raw) => {
      let parsed: ClientMessage;
      try {
        parsed = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }

      if (parsed.type !== "message" && parsed.type !== "context") return;

      const metadata: Record<string, unknown> = {
        ...(Object.prototype.hasOwnProperty.call(parsed, "personalToken")
          ? { personalToken: parsed.personalToken }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(parsed, "privilegeGrantId")
          ? { privilegeGrantId: parsed.privilegeGrantId }
          : {}),
      };

      if (parsed.type === "context") {

        const contextMessage: IncomingMessage = {
          id: uuidv4(),
          conversationId: parsed.conversationId,
          text: "",
          sender: `ws:${parsed.conversationId}`,
          timestamp: new Date(),
          metadata: {
            ...metadata,
            contextOnly: true,
          },
        };

        await this.processIncomingMessage(contextMessage);
        return;
      }

      if (!parsed.text) return;

      const message: IncomingMessage = {
        id: uuidv4(),
        conversationId: parsed.conversationId,
        text: parsed.text,
        sender: `ws:${parsed.conversationId}`,
        timestamp: new Date(),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };

      // Tag the socket with its conversationId for targeted broadcast
      (ws as WebSocket & { conversationId?: string }).conversationId = parsed.conversationId;

      try {
        await this.processIncomingMessage(message);
      } catch (err) {
        const errorMsg: ServerMessage = {
          type: "error",
          message: err instanceof Error ? err.message : "An unknown error occurred",
          conversationId: parsed.conversationId,
          checkpoint: this.lookupCheckpointMetadata(parsed.conversationId),
        };
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(errorMsg));
        }
      }
    });
  }

  private broadcast(conversationId: string, message: ServerMessage): void {
    const payload = JSON.stringify(message);
    this.wss?.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const tagged = client as WebSocket & { conversationId?: string };
      const receivesBroadcast = message.type === "tool_event"
        ? (message.role === "system-event" ? this.receiveSystem : this.receiveAgentProcessing)
        : this.receiveAgentProcessing;
      if (receivesBroadcast || tagged.conversationId === conversationId) {
        client.send(payload);
      }
    });
  }

  private lookupCheckpointMetadata(conversationId: string): CheckpointMetadata | undefined {
    if (!this.checkpointDb) return undefined;

    try {
      const row = this.checkpointDb
        .prepare<[string], CheckpointRow>(`
          SELECT checkpoint_id, checkpoint
          FROM checkpoints
          WHERE thread_id = ? AND checkpoint_ns = ''
          ORDER BY checkpoint_id DESC
          LIMIT 1
        `)
        .get(conversationId);

      if (!row) return undefined;

      let timestamp: string | undefined;
      try {
        const parsed = JSON.parse(row.checkpoint) as CheckpointEnvelope;
        if (typeof parsed.ts === "string") {
          timestamp = parsed.ts;
        }
      } catch {
        // Keep checkpoint id even if checkpoint blob cannot be parsed.
      }

      return {
        id: row.checkpoint_id,
        ...(timestamp ? { timestamp } : {}),
      };
    } catch {
      return undefined;
    }
  }
}

