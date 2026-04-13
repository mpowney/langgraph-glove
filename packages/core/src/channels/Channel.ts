import { EventEmitter } from "node:events";
import type { ChannelEntry } from "@langgraph-glove/config";
import type { ToolEventMetadata } from "../rpc/RpcProtocol";

/**
 * Check if the given text is a "!stop" command (case-insensitive, whitespace-trimmed).
 * Used by all channels to detect stop requests.
 */
export function isStopCommand(text: string): boolean {
  return text.toLowerCase().trim() === "!stop";
}

/** Returns a channel entry by key from channels.json data. */
export function getChannelEntryByKey(
  channels: Record<string, ChannelEntry>,
  key: string,
): ChannelEntry | undefined {
  return channels[key];
}

export type StreamSource = "main" | "sub-agent";

export interface OutgoingStreamChunk {
  text: string;
  source: StreamSource;
  /** Present when source is a sub-agent stream. */
  agentKey?: string;
}

/** An incoming message received from a user via a channel. */
export interface IncomingMessage {
  /** Unique message identifier (UUID). */
  id: string;
  /** Identifies the conversation / LangGraph thread. */
  conversationId: string;
  /** Plain-text content of the message. */
  text: string;
  /** Sender identifier — e.g. phone number, username, or "cli". */
  sender: string;
  /** Wall-clock time when the message was received. */
  timestamp: Date;
  /**
   * Optional channel-specific metadata attached to the message.
   * Values here are never persisted to LangGraph state or checkpoints.
   * Currently used to carry `personalToken` from WebChannel clients.
   */
  metadata?: Record<string, unknown>;
}

/** An outgoing message sent from the agent to the user. */
export interface OutgoingMessage {
  /** Identifies the conversation / LangGraph thread. */
  conversationId: string;
  /** Plain-text content to deliver. */
  text: string;
  /**
   * Who produced this message.  `"user"` is used when mirroring an incoming
   * message from another channel; `"agent"` (default) is the model's reply;
   * `"prompt"` is the full prompt array sent to the model (emitted to
    * `receiveAgentProcessing` channels for observability); `"tool-call"` is a tool
    * invocation emitted to `receiveAgentProcessing` channels; `"tool-result"` is the
   * corresponding tool output; `"agent-transfer"` is a handoff from the
  * orchestrator to a sub-agent; `"model-call"` carries redacted model
  * invocation options (including tool definitions) for observability;
  * `"model-response"` carries the redacted response payload returned from
  * a model invocation; "graph-definition" carries graph routing metadata for
  * the current dispatch; "system-event" carries background runtime events
    * (for example scheduler scan progress) for receiveSystem channels.
   */
  role?: "user" | "agent" | "prompt" | "tool-call" | "tool-result" | "agent-transfer" | "model-call" | "model-response" | "graph-definition" | "system-event" | "error";
  /**
   * Optional structured metadata for `"tool-call"` and `"tool-result"` events.
   * Carries the tool definition (parameter schema/descriptions) and the agent
   * key that invoked the tool so the UI can render inline parameter instructions.
   */
  toolEventMetadata?: ToolEventMetadata;
}

/** Callback invoked by a channel when a command (e.g., "!stop") is detected. */
export type CommandHandler = (command: string, conversationId: string) => Promise<void>;

/** Callback invoked by the channel for every incoming message. */
export type MessageHandler = (message: IncomingMessage) => Promise<void>;

/** Configuration options shared by all channel implementations. */
export interface ChannelConfig {
  /**
   * When `true`, this channel will also receive the agent's responses to
   * messages that originated from *other* channels.  Useful for observation,
   * logging, or mirroring conversations across channels.
   * Default: `false`.
   */
  receiveAgentProcessing?: boolean;
  /**
   * When `true`, this channel receives runtime system events such as
   * scheduler sweeps and task lifecycle notifications.
   * Default: `false`.
   */
  receiveSystem?: boolean;
}

/**
 * Abstract base class for all agent channels.
 *
 * A Channel is a bidirectional communication pathway between a user and the
 * `GloveAgent`.  Concrete subclasses wrap messaging applications
 * (e.g. iMessage via BlueBubbles), web UIs (WebSocket), or the command line.
 *
 * ## Implementing a new Channel
 *
 * 1. Extend `Channel`.
 * 2. Set `readonly name` and `readonly supportsStreaming`.
 * 3. Implement `start()`, `stop()`, `onMessage()`, and `sendMessage()`.
 * 4. Optionally override `sendStream()` for true token-by-token delivery.
 *
 * The `GloveAgent` calls `onMessage()` to register its handler before calling
 * `start()`.  When a message arrives the handler is invoked; the agent then
 * calls `sendMessage()` or `sendStream()` with the response.
 */
export abstract class Channel extends EventEmitter {
  /** Human-readable identifier used in logs and error messages. */
  abstract readonly name: string;

  /**
   * When `true`, this channel receives the agent's responses to messages from
   * all other channels in addition to its own.
   */
  readonly receiveAgentProcessing: boolean;

  /** When `true`, this channel receives runtime system events. */
  readonly receiveSystem: boolean;

  /** Optional handler for commands like \"!stop\". Set by the agent. */
  protected commandHandler?: CommandHandler;

  /** The actual message handler for processing incoming messages. */
  private handler?: MessageHandler;

  protected constructor(config: ChannelConfig = {}) {
    super();
    this.receiveAgentProcessing = config.receiveAgentProcessing ?? false;
    this.receiveSystem = config.receiveSystem ?? false;
  }

  /**
   * Whether this channel can deliver token-by-token streaming output.
   *
   * When `true` the agent will call `sendStream()` instead of `sendMessage()`,
   * which allows the user to see partial responses as they are generated.
   * Channels that return `false` receive buffered complete responses.
   */
  abstract readonly supportsStreaming: boolean;

  /** Begin listening for incoming messages. */
  abstract start(): Promise<void>;

  /** Stop listening and release all held resources. */
  abstract stop(): Promise<void>;

  /**
   * Register the agent's message handler.
   * Called once by `GloveAgent.start()` before `start()` is invoked.
   */
  abstract onMessage(handler: MessageHandler): void;

  /**
   * Set the command handler (optional).
   * Called by the agent to register a handler for special commands like \"!stop\".
   */
  setCommandHandler(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  /**
   * Protected helper method for subclasses to process incoming messages.
   * Automatically checks for "!stop" command and routes accordingly.
   * Subclasses should call this instead of directly accessing this.handler.
   */
  protected async processIncomingMessage(message: IncomingMessage): Promise<void> {
    // Check for "!stop" command (case-insensitive, whitespace-trimmed)
    if (isStopCommand(message.text)) {
      if (this.commandHandler) {
        await this.commandHandler(message.text, message.conversationId);
      }
      return;
    }

    // Otherwise, pass to the normal message handler
    if (this.handler) {
      await this.handler(message);
    }
  }

  /** Set the message handler. Called by GloveAgent.start(). */
  protected setMessageHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Deliver a complete response message to the user.
   * Used by the agent for non-streaming channels and as a fallback.
   */
  abstract sendMessage(message: OutgoingMessage): Promise<void>;

  /**
   * Stream token chunks to the user as they are generated.
   *
   * The default implementation collects all chunks and delegates to
   * `sendMessage()`, providing a safe fallback for channels that do not
   * support true streaming.  Override this in channels where
   * `supportsStreaming === true` for a real streaming experience.
   *
   * @param conversationId - The thread the response belongs to.
   * @param stream         - An async iterable of `OutgoingStreamChunk` objects,
   * containing chunk `text`, its `source` (`"main"` or `"sub-agent"`), and
   * an optional `agentKey` when the chunk originates from a sub-agent stream.
   */
  async sendStream(conversationId: string, stream: AsyncIterable<OutgoingStreamChunk>): Promise<void> {
    let text = "";
    for await (const chunk of stream) {
      text += chunk.text;
    }
    await this.sendMessage({ conversationId, text });
  }
}
