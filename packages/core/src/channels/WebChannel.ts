import http from "node:http";
import { v4 as uuidv4 } from "uuid";
import express, { type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Channel } from "./Channel";
import type { IncomingMessage, OutgoingMessage, MessageHandler } from "./Channel";

/** Messages sent from browser client → server. */
interface ClientMessage {
  type: "message";
  text: string;
  conversationId: string;
}

/** Messages sent from server → browser client. */
type ServerMessage =
  | { type: "chunk"; text: string; conversationId: string }
  | { type: "done"; conversationId: string }
  | { type: "error"; message: string; conversationId: string };

const WEB_UI_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LangGraph Glove</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      display: flex;
      flex-direction: column;
      height: 100dvh;
    }
    header {
      background: #1a1a2e;
      color: #fff;
      padding: 12px 20px;
      font-size: 18px;
      font-weight: 600;
    }
    #chat {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .message {
      max-width: 72%;
      padding: 10px 14px;
      border-radius: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .user { align-self: flex-end; background: #0078d4; color: #fff; border-bottom-right-radius: 2px; }
    .assistant { align-self: flex-start; background: #fff; color: #1a1a2e; border-bottom-left-radius: 2px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    .assistant.streaming::after { content: "▌"; animation: blink .7s step-end infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    #input-bar {
      display: flex;
      gap: 8px;
      padding: 12px 20px;
      background: #fff;
      border-top: 1px solid #e0e0e0;
    }
    #input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #d0d0d0;
      border-radius: 8px;
      font-size: 15px;
      outline: none;
    }
    #input:focus { border-color: #0078d4; }
    button {
      padding: 10px 20px;
      background: #0078d4;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      cursor: pointer;
    }
    button:disabled { background: #999; cursor: default; }
  </style>
</head>
<body>
  <header>LangGraph Glove</header>
  <div id="chat"></div>
  <div id="input-bar">
    <input id="input" type="text" placeholder="Type a message…" autocomplete="off" />
    <button id="send-btn" onclick="sendMessage()">Send</button>
  </div>
  <script>
    const conversationId = crypto.randomUUID();
    const chat = document.getElementById('chat');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');

    const ws = new WebSocket(\`ws://\${location.host}\`);

    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === 'chunk') {
        let el = document.getElementById('streaming-response');
        if (!el) {
          el = document.createElement('div');
          el.id = 'streaming-response';
          el.className = 'message assistant streaming';
          chat.appendChild(el);
        }
        el.textContent += msg.text;
        chat.scrollTop = chat.scrollHeight;
      } else if (msg.type === 'done') {
        const el = document.getElementById('streaming-response');
        if (el) {
          el.id = '';
          el.classList.remove('streaming');
        }
        sendBtn.disabled = false;
        input.focus();
      } else if (msg.type === 'error') {
        const el = document.getElementById('streaming-response');
        if (el) el.remove();
        appendMessage('assistant', '⚠ ' + msg.message);
        sendBtn.disabled = false;
        input.focus();
      }
    };

    ws.onclose = () => appendMessage('assistant', '⚠ Connection closed. Refresh the page to reconnect.');

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    function appendMessage(role, text) {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      div.textContent = text;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
      return div;
    }

    function sendMessage() {
      const text = input.value.trim();
      if (!text || ws.readyState !== WebSocket.OPEN) return;
      appendMessage('user', text);
      input.value = '';
      sendBtn.disabled = true;
      ws.send(JSON.stringify({ type: 'message', text, conversationId }));
    }
  </script>
</body>
</html>`;

export interface WebChannelConfig {
  /** Port for the HTTP + WebSocket server. Default: `8080`. */
  port?: number;
  /** Hostname to bind. Default: `"0.0.0.0"`. */
  host?: string;
}

/**
 * A streaming channel that serves a browser-based chat UI over HTTP and
 * communicates in real-time via WebSocket.
 *
 * - HTTP `GET /` serves the embedded single-page application.
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

  constructor(config: WebChannelConfig = {}) {
    super();
    this.port = config.port ?? 8080;
    this.host = config.host ?? "0.0.0.0";
    this.app = express();
    this.app.get("/", (_req, res) => res.send(WEB_UI_HTML));
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
      const tagged = client as WebSocket & { conversationId?: string };
      if (tagged.conversationId === conversationId && client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }
}
