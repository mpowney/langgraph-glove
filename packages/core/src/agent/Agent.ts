import { HumanMessage, SystemMessage, AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { StateGraph, MessagesAnnotation, END, START, MemorySaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { Channel, IncomingMessage } from "../channels/Channel";
import { Logger } from "../logging/Logger";

const logger = new Logger("Agent.ts");

/**
 * Walk the `cause` chain of an error and return a human-readable string that
 * includes every nested message.  Useful for surfacing the root cause of
 * `TypeError: fetch failed` errors from undici, which wrap the real network
 * error (e.g. `ECONNREFUSED`) in `err.cause`.
 */
function formatError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current != null) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as NodeJS.ErrnoException & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" → ");
}

export interface AgentConfig {
  /**
   * System prompt prepended to every conversation.
   * Supports multi-turn — the prompt is injected at the `system` role before
   * each model call and is not stored in the conversation history.
   */
  systemPrompt?: string;
  /**
   * Maximum number of steps (agent + tool calls) before LangGraph throws.
   * Default: `25`.
   */
  recursionLimit?: number;
}

/**
 * The core LangGraph-powered conversational agent.
 *
 * `GloveAgent` owns a compiled `StateGraph` that implements the standard
 * ReAct loop (agent → tools → agent → … → END).  All conversation state is
 * persisted in an in-memory `MemorySaver` keyed by `conversationId`, so each
 * channel conversation has its own independent multi-turn history.
 *
 * ## Usage
 * ```ts
 * const agent = new GloveAgent(model, tools, { systemPrompt: "You are helpful." });
 * agent.addChannel(new CliChannel());
 * await agent.start();
 * ```
 */
export class GloveAgent {
  private readonly graph: ReturnType<typeof this.buildGraph>;
  private readonly channels: Channel[] = [];

  constructor(
    private readonly model: BaseChatModel,
    private readonly tools: StructuredToolInterface[],
    private readonly config: AgentConfig = {},
  ) {
    if (!model.bindTools) {
      throw new Error(
        "GloveAgent requires a chat model that supports tool calling (bindTools). " +
          "Use ChatOpenAI, ChatAnthropic, or another function-calling-capable model.",
      );
    }
    this.graph = this.buildGraph();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Attach a channel.  Must be called before {@link start}. */
  addChannel(channel: Channel): this {
    this.channels.push(channel);
    return this;
  }

  /** Register message handlers on all channels and call `start()` on each. */
  async start(): Promise<void> {
    for (const channel of this.channels) {
      channel.onMessage(async (message) => {
        logger.debug(`Incoming message on channel "${channel.name}" (conversation: ${message.conversationId})`);
        await this.dispatchMessage(message, channel).catch(async (err) => {
          const detail = formatError(err);
          logger.error(`Error handling message on channel "${channel.name}": ${detail}`, err);
          await channel
            .sendMessage({
              conversationId: message.conversationId,
              text: `Sorry, an error occurred processing your message`,
            })
            .catch((e: unknown) => logger.error("Failed to send error reply", e));
        });
      });

      await channel.start();
      logger.info(`Channel started: ${channel.name}`);
    }
  }

  /** Stop all channels and release resources. */
  async stop(): Promise<void> {
    for (const channel of this.channels) {
      await channel.stop();
    }
  }

  /**
   * Invoke the graph synchronously (waits for the full response).
   * Useful for non-streaming channels or programmatic use.
   */
  async invoke(text: string, conversationId: string): Promise<string> {
    const result = await this.graph.invoke(
      { messages: [new HumanMessage(text)] },
      {
        configurable: { thread_id: conversationId },
        recursionLimit: this.config.recursionLimit ?? 25,
      },
    );

    const last = result.messages.at(-1);
    if (!last) throw new Error("Agent returned no messages");
    return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  }

  /**
   * Stream the agent's response token-by-token.
   * Yields only the text chunks produced by the agent node (not tool output).
   */
  async *stream(text: string, conversationId: string): AsyncGenerator<string> {
    const streamResult = await this.graph.stream(
      { messages: [new HumanMessage(text)] },
      {
        configurable: { thread_id: conversationId },
        streamMode: "messages",
        recursionLimit: this.config.recursionLimit ?? 25,
      },
    );

    for await (const [chunk, metadata] of streamResult as AsyncIterable<
      [unknown, { langgraph_node?: string }]
    >) {
      if (
        chunk instanceof AIMessageChunk &&
        (metadata as { langgraph_node?: string }).langgraph_node === "agent" &&
        typeof chunk.content === "string" &&
        chunk.content
      ) {
        yield chunk.content;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async dispatchMessage(message: IncomingMessage, sourceChannel: Channel): Promise<void> {
    const observers = this.channels.filter((ch) => ch !== sourceChannel && ch.receiveAll);

    // Mirror the user's message to observers before the agent replies.
    for (const ch of observers) {
      await ch
        .sendMessage({ conversationId: message.conversationId, text: message.text, role: "user" })
        .catch((e: unknown) => logger.error(`Failed to forward user message to channel "${ch.name}"`, e));
    }

    if (sourceChannel.supportsStreaming) {
      let fullText = "";
      const baseStream = this.stream(message.text, message.conversationId);

      // Intercept the stream so we can buffer the complete response for observers
      // without re-invoking the model.
      async function* teedStream(): AsyncGenerator<string> {
        for await (const chunk of baseStream) {
          fullText += chunk;
          yield chunk;
        }
      }

      await sourceChannel.sendStream(message.conversationId, teedStream());

      for (const ch of observers) {
        await ch
          .sendMessage({ conversationId: message.conversationId, text: fullText, role: "agent" })
          .catch((e: unknown) => logger.error(`Failed to broadcast to channel "${ch.name}"`, e));
      }
    } else {
      const response = await this.invoke(message.text, message.conversationId);
      await sourceChannel.sendMessage({ conversationId: message.conversationId, text: response });

      for (const ch of observers) {
        await ch
          .sendMessage({ conversationId: message.conversationId, text: response, role: "agent" })
          .catch((e: unknown) => logger.error(`Failed to broadcast to channel "${ch.name}"`, e));
      }
    }
  }

  private buildGraph() {
    const toolNode = new ToolNode(this.tools);
    // bindTools existence is validated in the constructor
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const modelWithTools = this.model.bindTools!(this.tools);
    const { systemPrompt } = this.config;

    const callAgent = async (state: typeof MessagesAnnotation.State) => {
      const messages: BaseMessage[] = systemPrompt
        ? [new SystemMessage(systemPrompt), ...state.messages]
        : [...state.messages];

      const response = await modelWithTools.invoke(messages);
      return { messages: [response] };
    };

    const routeAfterAgent = (
      state: typeof MessagesAnnotation.State,
    ): "tools" | typeof END => {
      const last = state.messages.at(-1) as AIMessage;
      return last.tool_calls?.length ? "tools" : END;
    };

    const checkpointer = new MemorySaver();

    return new StateGraph(MessagesAnnotation)
      .addNode("agent", callAgent)
      .addNode("tools", toolNode)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", routeAfterAgent)
      .addEdge("tools", "agent")
      .compile({ checkpointer });
  }
}
