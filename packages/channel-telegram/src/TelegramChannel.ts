import { Bot, type Context } from "grammy";
import {
  Channel,
  type ChannelConfig,
  type IncomingMessage,
  type OutgoingMessage,
  type MessageHandler,
} from "@langgraph-glove/core";
import { Logger } from "@langgraph-glove/core";

const logger = new Logger("TelegramChannel");

export interface TelegramChannelConfig extends ChannelConfig {
  /** Telegram Bot API token (from @BotFather). */
  token: string;
  /**
   * Optional set of allowed Telegram user IDs.
   * If provided, messages from other users are silently ignored.
   */
  allowedUserIds?: number[];
}

/**
 * Telegram channel using grammY.
 *
 * Maps each Telegram chat to a LangGraph conversation thread using the
 * chat ID as the conversation identifier.
 *
 * Supports buffered responses only (Telegram doesn't support true streaming
 * edits reliably). Long responses are split at the 4096-character limit.
 */
export class TelegramChannel extends Channel {
  readonly name = "telegram";
  readonly supportsStreaming = false;

  private bot: Bot;
  private handler?: MessageHandler;
  private readonly allowedUserIds: Set<number> | null;

  constructor(private readonly telegramConfig: TelegramChannelConfig) {
    super({ receiveAll: telegramConfig.receiveAll });
    this.bot = new Bot(telegramConfig.token);
    this.allowedUserIds = telegramConfig.allowedUserIds?.length
      ? new Set(telegramConfig.allowedUserIds)
      : null;
  }

  async start(): Promise<void> {
    this.bot.on("message:text", async (ctx: Context) => {
      if (!this.handler) return;

      const from = ctx.from;
      const chat = ctx.chat;
      const text = ctx.message?.text;
      if (!from || !chat || !text) return;

      // Access control
      if (this.allowedUserIds && !this.allowedUserIds.has(from.id)) {
        logger.debug(`Ignoring message from unauthorized user ${from.id}`);
        return;
      }

      const message: IncomingMessage = {
        id: String(ctx.message!.message_id),
        conversationId: String(chat.id),
        text,
        sender: from.username ?? String(from.id),
        timestamp: new Date(ctx.message!.date * 1000),
      };

      logger.debug(`Message from ${message.sender} in chat ${chat.id}`);

      try {
        await this.handler(message);
      } catch (err) {
        logger.error("Error handling Telegram message", err);
        await ctx.reply("Sorry, an error occurred processing your message.").catch(() => {});
      }
    });

    // Start long polling
    this.bot.start({
      onStart: () => logger.info("Telegram bot started (long polling)"),
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    logger.info("Telegram bot stopped");
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async sendMessage(message: OutgoingMessage): Promise<void> {
    const chatId = Number(message.conversationId);
    const text = message.text;

    // Telegram message limit is 4096 characters — split if needed
    const chunks = splitText(text, 4096);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(chatId, chunk);
    }
  }
}

/** Split text into chunks of at most `maxLen` characters, breaking at newlines when possible. */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, "");
  }

  return chunks;
}
