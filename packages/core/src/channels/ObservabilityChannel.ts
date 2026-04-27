import http from "node:http";
import { join } from "node:path";
import express, { type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { ChannelEntry } from "@langgraph-glove/config";
import { distPath } from "@langgraph-glove/ui-observability";
import { z } from "zod";
import { Channel } from "./Channel";
import type { ChannelConfig, MessageHandler, OutgoingMessage } from "./Channel";
import type { AuthService } from "../auth/AuthService";

export const ObservabilityChannelSettingsSchema = z.object({
  port: z.number().int().positive().optional(),
  host: z.string().min(1).optional(),
  receiveAgentProcessing: z.boolean().optional(),
  receiveSystem: z.boolean().optional(),
  receiveConversationMetadata: z.boolean().optional(),
});

export interface ObservabilityChannelFactoryContext {
  appInfo?: ObservabilityChannelConfig["appInfo"];
}

export function createObservabilityChannelFromConfig(
  entry: ChannelEntry | undefined,
  context: ObservabilityChannelFactoryContext,
): ObservabilityChannel {
  if (entry?.enabled === false) {
    throw new Error('Observability channel is disabled in channels.json');
  }

  const result = ObservabilityChannelSettingsSchema.safeParse(entry?.settings ?? {});
  if (!result.success) {
    throw new Error(`Invalid channels.json observability settings: ${result.error.message}`);
  }

  return new ObservabilityChannel({
    port: result.data.port,
    host: result.data.host,
    receiveAgentProcessing: result.data.receiveAgentProcessing ?? true,
    receiveSystem: result.data.receiveSystem ?? true,
    receiveConversationMetadata: result.data.receiveConversationMetadata,
    appInfo: context.appInfo,
  });
}

type ObservabilityServerMessage = {
  type: "event";
  conversationId: string;
  role: NonNullable<OutgoingMessage["role"]>;
  text: string;
  timestamp: string;
};

export interface ObservabilityChannelConfig extends ChannelConfig {
  port?: number;
  host?: string;
  appInfo?: {
    name?: string;
    description?: string;
    apiUrl?: string;
  };
  authService?: AuthService;
}

export class ObservabilityChannel extends Channel {
  readonly name = "observability";
  readonly supportsStreaming = false;

  private app: Express;
  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private readonly port: number;
  private readonly host: string;
  private appInfo: Required<NonNullable<ObservabilityChannelConfig["appInfo"]>>;
  private authService?: AuthService;

  constructor(config: ObservabilityChannelConfig = {}) {
    super(config);
    this.port = config.port ?? 8090;
    this.host = config.host ?? "0.0.0.0";
    this.appInfo = {
      name: config.appInfo?.name ?? "LangGraph Glove Observability",
      description: config.appInfo?.description ?? "Topology and runtime observability surface",
      apiUrl: config.appInfo?.apiUrl ?? "",
    };
    this.authService = config.authService;

    this.app = express();
    this.app.use(express.static(distPath));
    this.app.get("/api/info", (_req, res) => {
      res.json(this.appInfo);
    });
    this.app.get("*", (_req, res) => {
      res.sendFile(join(distPath, "index.html"));
    });
  }

  setAuthService(svc: AuthService): void {
    this.authService = svc;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer(this.app);

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

      this.wss = new WebSocketServer({
        server: this.httpServer,
        ...(verifyClient ? { verifyClient } : {}),
      });

      this.wss.on("connection", (ws) => {
        ws.on("message", () => {
          // Reserved for future interactive observability controls.
        });
      });

      this.httpServer.listen(this.port, this.host, () => {
        console.log(`[ObservabilityChannel] Listening on http://${this.host}:${this.port}`);
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
    this.setMessageHandler(handler);
  }

  async sendMessage(message: OutgoingMessage): Promise<void> {
    const payload: ObservabilityServerMessage = {
      type: "event",
      conversationId: message.conversationId,
      role: message.role ?? "agent",
      text: message.text,
      timestamp: new Date().toISOString(),
    };

    const encoded = JSON.stringify(payload);
    this.wss?.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(encoded);
      }
    });
  }
}