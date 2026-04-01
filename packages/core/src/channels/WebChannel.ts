import http from "node:http";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import express, { type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import Database from "better-sqlite3";
import { distPath } from "@langgraph-glove/ui-web";
import { Channel } from "./Channel.js";
import type { ChannelConfig, IncomingMessage, OutgoingMessage, MessageHandler } from "./Channel.js";

// ---------------------------------------------------------------------------
// Types shared with the browser API
// ---------------------------------------------------------------------------

interface LcMessage {
  lc: number;
  type: string;
  id: string[];
  kwargs: {
    content: unknown;
    additional_kwargs?: Record<string, unknown>;
    response_metadata?: Record<string, unknown>;
    id?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  };
}

interface CheckpointRow {
  thread_id: string;
  checkpoint_id: string;
  checkpoint: string;
}

interface ConversationRow {
  thread_id: string;
  checkpoint_count: number;
  latest_checkpoint_id: string;
}

/** A single decoded message in a conversation. */
export interface BrowserMessage {
  id: string;
  role: "human" | "ai" | "tool" | "system";
  content: string;
  tool_calls?: Array<{ name: string; id: string; args: unknown }>;
  tool_call_id?: string;
}

/** Summary row returned by GET /api/conversations. */
export interface ConversationSummary {
  threadId: string;
  messageCount: number;
  latestCheckpointId: string;
}

function lcIdToRole(id: string[]): BrowserMessage["role"] {
  const cls = id.at(-1) ?? "";
  if (cls.startsWith("Human")) return "human";
  if (cls.startsWith("AI") || cls.startsWith("Ai")) return "ai";
  if (cls.startsWith("Tool")) return "tool";
  return "system";
}

function extractMessages(checkpointJson: string): BrowserMessage[] {
  try {
    const cp = JSON.parse(checkpointJson) as { channel_values?: { messages?: LcMessage[] } };
    const raw = cp.channel_values?.messages ?? [];
    return raw.map((m) => {
      const role = lcIdToRole(m.id);
      const content =
        typeof m.kwargs.content === "string"
          ? m.kwargs.content
          : JSON.stringify(m.kwargs.content);
      const tool_calls = m.kwargs.tool_calls?.length
        ? (m.kwargs.tool_calls as Array<{ name: string; id: string; args: unknown }>)
        : undefined;
      return {
        id: m.kwargs.id ?? uuidv4(),
        role,
        content,
        ...(tool_calls ? { tool_calls } : {}),
        ...(m.kwargs.tool_call_id ? { tool_call_id: m.kwargs.tool_call_id } : {}),
      };
    });
  } catch {
    return [];
  }
}

/** Messages sent from browser client → server. */
interface ClientMessage {
  type: "message";
  text: string;
  conversationId: string;
}

/** Messages sent from server → browser client. */
type ServerMessage =
  | { type: "chunk"; text: string; conversationId: string; role?: "user" | "agent" | "prompt" }
  | { type: "done"; conversationId: string }
  | { type: "error"; message: string; conversationId: string };

export interface WebChannelConfig extends ChannelConfig {
  /** Port for the HTTP + WebSocket server. Default: `8080`. */
  port?: number;
  /** Hostname to bind. Default: `"0.0.0.0"`. */
  host?: string;
  /**
   * Path to the SQLite checkpoint database.  When provided, the channel
   * exposes a read-only REST API for browsing conversation history:
   *  - `GET /api/conversations`           → ConversationSummary[]
   *  - `GET /api/conversations/:threadId` → BrowserMessage[]
   */
  dbPath?: string;
  /** Optional metadata surfaced to the React SPA via `GET /api/info`. */
  appInfo?: {
    /** App name shown in the header. Defaults to "LangGraph Glove". */
    name?: string;
    /** Short description of the active agent, shown beneath the app name. */
    agentDescription?: string;
  };
}

/**
 * A streaming channel that serves a browser-based chat UI over HTTP and
 * communicates in real-time via WebSocket.
 *
 * - HTTP static files are served from the compiled `@langgraph-glove/ui-web` SPA.
 * - `GET /api/info` returns app metadata consumed by the React UI.
 * - WebSocket upgrade on the same port handles message exchange.
 * - Each browser tab creates its own `conversationId` (UUID), which is used
 *   as the LangGraph thread ID — giving each tab its own conversation history.
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
  private readonly appInfo: Required<NonNullable<WebChannelConfig["appInfo"]>>;
  private readonly dbPath?: string;

  constructor(config: WebChannelConfig = {}) {
    super(config);
    this.port = config.port ?? 8080;
    this.host = config.host ?? "0.0.0.0";
    this.dbPath = config.dbPath;
    this.appInfo = {
      name: config.appInfo?.name ?? "LangGraph Glove",
      agentDescription: config.appInfo?.agentDescription ?? "",
    };
    this.app = express();

    // Serve the compiled React SPA
    this.app.use(express.static(distPath));

    // Expose app metadata to the SPA
    this.app.get("/api/info", (_req, res) => {
      res.json({
        name: this.appInfo.name,
        ...(this.appInfo.agentDescription && {
          agentDescription: this.appInfo.agentDescription,
        }),
      });
    });

    // Conversation browser API — only registered when a dbPath is configured
    if (this.dbPath) {
      const dbPath = this.dbPath;

      this.app.get("/api/conversations", (_req, res) => {
        try {
          const db = new Database(dbPath, { readonly: true, fileMustExist: true });
          const rows = db.prepare<[], ConversationRow>(`
            SELECT
              thread_id,
              COUNT(*) AS checkpoint_count,
              MAX(checkpoint_id) AS latest_checkpoint_id
            FROM checkpoints
            WHERE checkpoint_ns = ''
            GROUP BY thread_id
            ORDER BY MAX(checkpoint_id) DESC
          `).all();
          db.close();

          const summaries: ConversationSummary[] = rows.map((r) => ({
            threadId: r.thread_id,
            messageCount: r.checkpoint_count,
            latestCheckpointId: r.latest_checkpoint_id,
          }));
          res.json(summaries);
        } catch (err) {
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      this.app.get("/api/conversations/:threadId", (req, res) => {
        const { threadId } = req.params;
        try {
          const db = new Database(dbPath, { readonly: true, fileMustExist: true });
          const row = db.prepare<[string], CheckpointRow>(`
            SELECT thread_id, checkpoint_id, checkpoint
            FROM checkpoints
            WHERE thread_id = ? AND checkpoint_ns = ''
            ORDER BY checkpoint_id DESC
            LIMIT 1
          `).get(threadId);
          db.close();

          if (!row) {
            res.status(404).json({ error: "Conversation not found" });
            return;
          }
          res.json(extractMessages(row.checkpoint as unknown as string));
        } catch (err) {
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
      });
    }

    // SPA fallback — serve index.html for any unmatched GET
    this.app.get("*", (_req, res) => {
      res.sendFile(join(distPath, "index.html"));
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer(this.app);
      this.wss = new WebSocketServer({ server: this.httpServer });

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
      this.httpServer?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Sends a complete message to all WebSocket clients that share the conversationId. */
  async sendMessage(message: OutgoingMessage): Promise<void> {
    const payload: ServerMessage = {
      type: "chunk",
      text: message.text,
      conversationId: message.conversationId,
      role: message.role,
    };
    this.broadcast(message.conversationId, payload);
    this.broadcast(message.conversationId, { type: "done", conversationId: message.conversationId });
  }

  /**
   * Streams token chunks to the WebSocket client.
   * Each chunk is sent as a `{ type: "chunk" }` frame; a final `{ type: "done" }`
   * frame signals end-of-response.
   */
  override async sendStream(
    conversationId: string,
    stream: AsyncIterable<string>,
  ): Promise<void> {
    for await (const chunk of stream) {
      this.broadcast(conversationId, { type: "chunk", text: chunk, conversationId });
    }
    this.broadcast(conversationId, { type: "done", conversationId });
  }

  private handleConnection(ws: WebSocket): void {
    ws.on("message", async (raw) => {
      let parsed: ClientMessage;
      try {
        parsed = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }

      if (parsed.type !== "message" || !parsed.text || !this.handler) return;

      const message: IncomingMessage = {
        id: uuidv4(),
        conversationId: parsed.conversationId,
        text: parsed.text,
        sender: `ws:${parsed.conversationId}`,
        timestamp: new Date(),
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
}
