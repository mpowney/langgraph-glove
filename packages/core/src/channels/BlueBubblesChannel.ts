import http from "node:http";
import express, { type Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { Channel } from "./Channel";
import type { ChannelConfig, IncomingMessage, OutgoingMessage, MessageHandler } from "./Channel";

/** Webhook payload sent by the BlueBubbles server for new incoming messages. */
interface BlueBubblesWebhookPayload {
  type: string;
  data?: {
    guid?: string;
    text?: string;
    isFromMe?: boolean;
    chats?: Array<{ guid?: string }>;
    handle?: { address?: string };
  };
}

export interface BlueBubblesChannelConfig extends ChannelConfig {
  /** Base URL of the BlueBubbles server (e.g. `http://192.168.1.10:1234`). */
  serverUrl: string;
  /** BlueBubbles server password. */
  password: string;
  /**
   * Local port on which this process listens for incoming BlueBubbles webhooks.
   * You must configure this URL inside the BlueBubbles app's webhook settings.
   * Default: `5001`.
   */
  webhookPort?: number;
  /**
   * Hostname / IP the webhook server binds to.
   * Default: `"0.0.0.0"`.
   */
  webhookHost?: string;
}

/**
 * Channel that integrates with iMessage via the
 * [BlueBubbles](https://bluebubbles.app/) open-source proxy server.
 *
 * **Streaming is not supported** — iMessage does not support partial message
 * delivery.  The agent's full response is sent as a single message once the
 * LangGraph graph completes.
 *
 * ## Setup
 * 1. Run BlueBubbles on a Mac that is signed in to iMessage.
 * 2. In BlueBubbles → Settings → Webhooks, add a new webhook pointing to
 *    `http://<this-machine-ip>:<webhookPort>/webhook`.
 * 3. Provide the server URL and password in {@link BlueBubblesChannelConfig}.
 */
export class BlueBubblesChannel extends Channel {
  readonly name = "bluebubbles";
  readonly supportsStreaming = false;

  private handler?: MessageHandler;
  private app: Express;
  private webhookServer?: http.Server;
  private readonly serverUrl: string;
  private readonly password: string;
  private readonly webhookPort: number;
  private readonly webhookHost: string;

  constructor(config: BlueBubblesChannelConfig) {
    super(config);
    this.serverUrl = config.serverUrl.replace(/\/$/, "");
    this.password = config.password;
    this.webhookPort = config.webhookPort ?? 5001;
    this.webhookHost = config.webhookHost ?? "0.0.0.0";
    this.app = express();
    this.app.use(express.json());
    this.app.post("/webhook", (req, res) => {
      res.sendStatus(200);
      void this.handleWebhook(req.body as BlueBubblesWebhookPayload);
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.webhookServer = this.app.listen(this.webhookPort, this.webhookHost, () => {
        console.log(
          `[BlueBubblesChannel] Webhook listener on http://${this.webhookHost}:${this.webhookPort}/webhook`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.webhookServer?.close((err) => (err ? reject(err) : resolve())),
    );
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Sends a message to the iMessage chat identified by `conversationId`
   * (which is the BlueBubbles chat GUID).
   */
  async sendMessage(message: OutgoingMessage): Promise<void> {
    const url = `${this.serverUrl}/api/v1/message/text?password=${encodeURIComponent(this.password)}`;

    const body = {
      chatGuid: message.conversationId,
      message: message.text,
      tempGuid: uuidv4(),
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `[BlueBubblesChannel] Failed to send message: HTTP ${response.status}`,
      );
    }
  }

  private async handleWebhook(payload: BlueBubblesWebhookPayload): Promise<void> {
    if (payload.type !== "new-message" || !payload.data) return;

    const { data } = payload;

    // Ignore messages sent by the agent itself
    if (data.isFromMe) return;

    const text = data.text?.trim();
    if (!text) return;

    const chatGuid = data.chats?.[0]?.guid;
    if (!chatGuid) return;

    const sender = data.handle?.address ?? "unknown";

    const message: IncomingMessage = {
      id: data.guid ?? uuidv4(),
      conversationId: chatGuid,
      text,
      sender,
      timestamp: new Date(),
    };

    try {
      await this.handler?.(message);
    } catch (err) {
      console.error("[BlueBubblesChannel] Error handling message:", err);
      await this.sendMessage({
        conversationId: chatGuid,
        text: "Sorry, an error occurred while processing your message.",
      }).catch(console.error);
    }
  }
}
