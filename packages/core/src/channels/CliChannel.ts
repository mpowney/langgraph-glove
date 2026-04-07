import readline from "node:readline";
import process from "node:process";
import { v4 as uuidv4 } from "uuid";
import type { ChannelEntry } from "@langgraph-glove/config";
import { z } from "zod";
import { Channel } from "./Channel";
import type { ChannelConfig, IncomingMessage, OutgoingMessage, MessageHandler, OutgoingStreamChunk } from "./Channel";

export const CliChannelSettingsSchema = z.object({
  receiveAll: z.boolean().optional(),
});

export function createCliChannelFromConfig(entry?: ChannelEntry): CliChannel | null {
  if (entry?.enabled === false) {
    return null;
  }

  const result = CliChannelSettingsSchema.safeParse(entry?.settings ?? {});
  if (!result.success) {
    throw new Error(`Invalid channels.json cli settings: ${result.error.message}`);
  }

  return new CliChannel({ receiveAll: result.data.receiveAll });
}

/**
 * A streaming channel that reads from `stdin` and writes to `stdout`.
 *
 * Each run of the application corresponds to a single conversation thread.
 * Type `exit` or press Ctrl-C to quit.
 */
export class CliChannel extends Channel {
  readonly name = "cli";
  readonly supportsStreaming = true;

  private rl?: readline.Interface;
  private handler?: MessageHandler;
  private readonly conversationId = uuidv4();
  /** Prevent overlapping responses when the user types quickly. */
  private processing = false;

  constructor(config: ChannelConfig = {}) {
    super(config);
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });

    if (process.stdin.isTTY) {
      console.log("LangGraph Glove — CLI channel ready.");
      console.log('Type your message and press Enter. Type "exit" to quit.\n');
      process.stdout.write("You: ");
    }

    this.rl.on("line", async (line) => {
      const text = line.trim();

      if (text.toLowerCase() === "exit") {
        await this.stop();
        process.exit(0);
      }

      if (!text || !this.handler || this.processing) {
        if (!this.processing) process.stdout.write("You: ");
        return;
      }

      this.processing = true;
      this.rl?.pause();

      const message: IncomingMessage = {
        id: uuidv4(),
        conversationId: this.conversationId,
        text,
        sender: "cli-user",
        timestamp: new Date(),
      };

      try {
        await this.handler(message);
      } finally {
        this.processing = false;
        this.rl?.resume();
        process.stdout.write("You: ");
      }
    });

    process.on("SIGINT", async () => {
      await this.stop();
      process.exit(0);
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = undefined;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async sendMessage(message: OutgoingMessage): Promise<void> {
    process.stdout.write(`\nAssistant: ${message.text}\n\n`);
  }

  /**
   * Writes token chunks directly to stdout as they arrive, giving the user
   * an immediate streaming experience identical to ChatGPT's interface.
   */
  override async sendStream(
    _conversationId: string,
    stream: AsyncIterable<OutgoingStreamChunk>,
  ): Promise<void> {
    process.stdout.write("\nAssistant: ");
    for await (const chunk of stream) {
      process.stdout.write(chunk.text);
    }
    process.stdout.write("\n\n");
  }
}
