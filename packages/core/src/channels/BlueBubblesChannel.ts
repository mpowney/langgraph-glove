import http from "node:http";
import express, { type Express } from "express";
import { v4 as uuidv4 } from "uuid";
import type { ChannelEntry } from "@langgraph-glove/config";
import { z } from "zod";
import { Channel } from "./Channel";
import type { ChannelConfig, IncomingMessage, OutgoingMessage, MessageHandler } from "./Channel";

export const BlueBubblesChannelSettingsSchema = z.object({
  serverUrl: z.string().url(),
  password: z.string().min(1).optional(),
  webhookPort: z.number().int().positive().optional(),
  webhookHost: z.string().min(1).optional(),
  receiveAgentProcessing: z.boolean().optional(),
  receiveSystem: z.boolean().optional(),
  /**
   * Inactivity TTL (in milliseconds) after which a new conversation thread is
   * started for the same chat.  If a sender is silent for longer than this
   * duration their next message begins a fresh LangGraph thread, preventing
   * the agent context from growing indefinitely.
   *
   * Set to `0` to disable TTL (conversation threads last forever — the
   * original behaviour).  Default: `1800000` (30 minutes).
   */
  conversationTtlMs: z.number().int().nonnegative().optional(),
});

export function createBlueBubblesChannelFromConfig(entry: ChannelEntry | undefined): BlueBubblesChannel {
  if (!entry) {
    throw new Error('Missing "bluebubbles" channel config in channels.json');
  }
  if (entry.enabled === false) {
    throw new Error('BlueBubbles channel is disabled in channels.json');
  }

  const result = BlueBubblesChannelSettingsSchema.safeParse(entry.settings ?? {});
  if (!result.success) {
    throw new Error(`Invalid channels.json bluebubbles settings: ${result.error.message}`);
  }

  return new BlueBubblesChannel({
    serverUrl: result.data.serverUrl,
    password: result.data.password,
    webhookPort: result.data.webhookPort,
    webhookHost: result.data.webhookHost,
    receiveAgentProcessing: result.data.receiveAgentProcessing,
    receiveSystem: result.data.receiveSystem,
    conversationTtlMs: result.data.conversationTtlMs,
  });
}

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
  password?: string;
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
  /**
   * Inactivity TTL (in milliseconds) after which a new conversation thread is
   * started for the same chat.  If a sender is silent for longer than this
   * duration their next message begins a fresh LangGraph thread, preventing
   * the agent context from growing indefinitely.
   *
   * Set to `0` to disable TTL (conversation threads last forever — the
   * original behaviour).  Default: `1800000` (30 minutes).
   */
  conversationTtlMs?: number;
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
  private readonly password?: string;
  private readonly webhookPort: number;
  private readonly webhookHost: string;
  /**
   * Inactivity TTL in ms.  `0` means disabled (conversations last forever).
   * Default: 30 minutes.
   */
  private readonly conversationTtlMs: number;
  /**
   * Per-chat sliding-window conversation state.
   * Key: BlueBubbles chat GUID.
   * Value: current LangGraph thread ID and the timestamp of the last activity.
   */
  private readonly conversationMap = new Map<string, { conversationId: string; lastActivityAt: number }>();
  /**
   * Reverse-lookup map: LangGraph thread ID → BlueBubbles chat GUID.
   * Required so that `sendMessage` can resolve the correct chat GUID when the
   * Agent replies using the internal thread ID as `conversationId`.
   */
  private readonly conversationToChatGuid = new Map<string, string>();
  /** Timer handle for periodic stale-entry cleanup. */
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: BlueBubblesChannelConfig) {
    super(config);
    this.serverUrl = config.serverUrl.replace(/\/$/, "");
    this.password = config.password;
    this.webhookPort = config.webhookPort ?? 5001;
    this.webhookHost = config.webhookHost ?? "0.0.0.0";
    this.conversationTtlMs = config.conversationTtlMs ?? 30 * 60 * 1000;
    this.app = express();
    this.app.use(express.json());
    this.app.post("/webhook", (req, res) => {
      res.sendStatus(200);
      void this.handleWebhook(req.body as BlueBubblesWebhookPayload);
    });
  }

  async start(): Promise<void> {
    // Schedule periodic cleanup of stale conversation map entries only when
    // the TTL feature is active.
    if (this.conversationTtlMs > 0) {
      // Cap the cleanup interval to 1 hour so stale entries are evicted in a
      // reasonable time regardless of how long the TTL is configured to be.
      const cleanupIntervalMs = Math.min(Math.max(this.conversationTtlMs, 60_000), 60 * 60_000);
      this.cleanupTimer = setInterval(() => this.evictStaleConversations(), cleanupIntervalMs);
      // Allow the Node.js process to exit even if this timer is still active.
      this.cleanupTimer.unref();
    }

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
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    return new Promise((resolve, reject) =>
      this.webhookServer?.close((err) => (err ? reject(err) : resolve())),
    );
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Sends a message to the iMessage chat identified by `conversationId`.
   *
   * When TTL-based conversation IDs are enabled `conversationId` is an
   * internal UUID that must be translated back to the BlueBubbles chat GUID
   * via the reverse-lookup map before calling the API.
   */
  async sendMessage(message: OutgoingMessage): Promise<void> {
    const url = `${this.serverUrl}/api/v1/message/text${this.password ? `?password=${encodeURIComponent(this.password)}` : ""}`;
    const plainText = this.stripMarkdown(message.text);

    // Translate internal thread ID → BlueBubbles chat GUID when needed.
    const chatGuid =
      this.conversationTtlMs === 0
        ? message.conversationId
        : (this.conversationToChatGuid.get(message.conversationId) ?? message.conversationId);

    const body = {
      chatGuid,
      message: plainText,
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
      conversationId: this.resolveConversationId(chatGuid),
      text,
      sender,
      timestamp: new Date(),
      metadata: { chatGuid },
    };

    try {
      await this.handler?.(message);
    } catch (err) {
      console.error("[BlueBubblesChannel] Error handling message:", err);
      await this.sendMessage({
        conversationId: message.conversationId,
        text: "Sorry, an error occurred while processing your message.",
      }).catch(console.error);
    }
  }

  /**
   * Return the current LangGraph thread ID for `chatGuid`, creating a new one
   * when the TTL has elapsed since the last activity (sliding-window expiry).
   *
   * When `conversationTtlMs` is `0` the chat GUID itself is used as the
   * conversation ID, preserving the original unlimited-history behaviour.
   */
  private resolveConversationId(chatGuid: string): string {
    if (this.conversationTtlMs === 0) {
      return chatGuid;
    }

    const now = Date.now();
    const existing = this.conversationMap.get(chatGuid);

    if (existing && now - existing.lastActivityAt < this.conversationTtlMs) {
      // Still within the active TTL window — reuse the existing thread.
      existing.lastActivityAt = now;
      return existing.conversationId;
    }

    // Either a brand-new chat or the TTL has elapsed — start a fresh thread.
    const conversationId = uuidv4();
    if (existing) {
      // Remove the stale reverse-lookup entry before overwriting.
      this.conversationToChatGuid.delete(existing.conversationId);
      console.log(
        `[BlueBubblesChannel] Conversation TTL elapsed for chat ${chatGuid}; starting new thread ${conversationId}`,
      );
    }
    this.conversationMap.set(chatGuid, { conversationId, lastActivityAt: now });
    this.conversationToChatGuid.set(conversationId, chatGuid);
    return conversationId;
  }

  /**
   * Remove conversation map entries whose TTL has elapsed.  Called
   * periodically by the cleanup timer to prevent unbounded memory growth.
   */
  private evictStaleConversations(): void {
    const now = Date.now();
    for (const [chatGuid, entry] of this.conversationMap) {
      if (now - entry.lastActivityAt >= this.conversationTtlMs) {
        this.conversationMap.delete(chatGuid);
        this.conversationToChatGuid.delete(entry.conversationId);
      }
    }
  }

  private stripMarkdown(input: string): string {
    return input
      // Remove fenced code block markers while keeping inner code text.
      .replace(/```[\w-]*\n?/g, "")
      .replace(/```/g, "")
      // Remove inline code markers.
      .replace(/`([^`]+)`/g, "$1")
      // Convert markdown links/images to visible text only.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1")
      // Remove emphasis and heading/quote/list markers.
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*([-+*]|\d+\.)\s+/gm, "")
      // Remove markdown horizontal rules.
      .replace(/^\s*([-*_]){3,}\s*$/gm, "")
      // Normalize whitespace/newlines for SMS-style output.
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
