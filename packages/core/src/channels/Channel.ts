import { EventEmitter } from "node:events";

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
   * `receiveAll` channels for observability); `"tool-call"` is a tool
   * invocation emitted to `receiveAll` channels; `"tool-result"` is the
   * corresponding tool output; `"agent-transfer"` is a handoff from the
   * orchestrator to a sub-agent.
   */
  role?: "user" | "agent" | "prompt" | "tool-call" | "tool-result" | "agent-transfer";
}

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
  receiveAll?: boolean;
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
  readonly receiveAll: boolean;

  protected constructor(config: ChannelConfig = {}) {
    super();
    this.receiveAll = config.receiveAll ?? false;
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
   * @param stream         - An async iterable of text chunks.
   */
  async sendStream(conversationId: string, stream: AsyncIterable<string>): Promise<void> {
    let text = "";
    for await (const chunk of stream) {
      text += chunk;
    }
    await this.sendMessage({ conversationId, text });
  }
}
