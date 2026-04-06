import http from "node:http";
import { join } from "node:path";
import { URL } from "node:url";
import { v4 as uuidv4 } from "uuid";
import express, { type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import Database from "better-sqlite3";
import { distPath } from "@langgraph-glove/ui-web";
import { Channel } from "./Channel";
import type { ChannelConfig, IncomingMessage, OutgoingMessage, MessageHandler, OutgoingStreamChunk, StreamSource } from "./Channel";
import type { AuthService } from "../auth/AuthService";
import type { ToolEventMetadata } from "../rpc/RpcProtocol";

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
    }
  | { type: "prompt"; text: string; conversationId: string; checkpoint?: CheckpointMetadata }
  | {
      type: "tool_event";
      role: "tool-call" | "tool-result" | "agent-transfer" | "model-call" | "model-response";
      text: string;
      conversationId: string;
      checkpoint?: CheckpointMetadata;
      /** Optional structured metadata carrying tool parameter schema and agent context. */
      toolEventMetadata?: ToolEventMetadata;
    }
  | { type: "done"; conversationId: string; checkpoint?: CheckpointMetadata }
  | { type: "error"; message: string; conversationId: string; checkpoint?: CheckpointMetadata };

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

  private handler?: MessageHandler;
  private app: Express;
  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private readonly port: number;
  private readonly host: string;
  private appInfo: Required<NonNullable<WebChannelConfig["appInfo"]>>;
  private readonly checkpointDbPath?: string;
  private checkpointDb?: Database.Database;
  private authService?: AuthService;

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
    this.handler = handler;
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

    if (
      message.role === "tool-call"
      || message.role === "tool-result"
      || message.role === "agent-transfer"
      || message.role === "model-call"
      || message.role === "model-response"
    ) {
      const payload: ServerMessage = {
        type: "tool_event",
        role: message.role,
        text: message.text,
        conversationId: message.conversationId,
        checkpoint: this.lookupCheckpointMetadata(message.conversationId),
        ...(message.toolEventMetadata ? { toolEventMetadata: message.toolEventMetadata } : {}),
      };
      this.broadcast(message.conversationId, payload);
      return;
    }
    const payload: ServerMessage = {
      type: "chunk",
      text: message.text,
      conversationId: message.conversationId,
      role: message.role,
      checkpoint: this.lookupCheckpointMetadata(message.conversationId),
    };
    this.broadcast(message.conversationId, payload);
    this.broadcast(message.conversationId, {
      type: "done",
      conversationId: message.conversationId,
      checkpoint: this.lookupCheckpointMetadata(message.conversationId),
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
      this.broadcast(conversationId, {
        type: "chunk",
        text: chunk.text,
        conversationId,
        streamSource: chunk.source,
        ...(chunk.agentKey ? { streamAgentKey: chunk.agentKey } : {}),
        checkpoint: this.lookupCheckpointMetadata(conversationId),
      });
    }
    this.broadcast(conversationId, {
      type: "done",
      conversationId,
      checkpoint: this.lookupCheckpointMetadata(conversationId),
    });
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
        if (!this.handler) return;

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

        await this.handler(contextMessage);
        return;
      }

      if (!parsed.text || !this.handler) return;


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
        await this.handler(message);
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
      if (this.receiveAll || tagged.conversationId === conversationId) {
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

