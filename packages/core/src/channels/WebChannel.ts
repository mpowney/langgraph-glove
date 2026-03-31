import http from "node:http";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import express, { type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { distPath } from "@langgraph-glove/ui-web";
import { Channel } from "./Channel.js";
import type { ChannelConfig, IncomingMessage, OutgoingMessage, MessageHandler } from "./Channel.js";

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

  constructor(config: WebChannelConfig = {}) {
    super(config);
    this.port = config.port ?? 8080;
    this.host = config.host ?? "0.0.0.0";
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
