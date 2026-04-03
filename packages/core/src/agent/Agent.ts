import { HumanMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import type { Channel, IncomingMessage } from "../channels/Channel";
import { Logger } from "../logging/Logger";
import { LlmCallbackHandler } from "../logging/LlmCallbackHandler";

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEmptyToolArgs(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractArgsFromRawToolCall(rawCall: unknown): unknown {
  if (!isObject(rawCall)) return undefined;
  const rawFunction = isObject(rawCall.function) ? rawCall.function : undefined;
  if (rawFunction && Object.prototype.hasOwnProperty.call(rawFunction, "arguments")) {
    return parseJsonMaybe(rawFunction.arguments);
  }
  if (Object.prototype.hasOwnProperty.call(rawCall, "arguments")) {
    return parseJsonMaybe(rawCall.arguments);
  }
  if (Object.prototype.hasOwnProperty.call(rawCall, "args")) {
    return parseJsonMaybe(rawCall.args);
  }
  return undefined;
}

function recoverToolArgs(
  chunk: unknown,
  toolCall: { id?: string; name?: string; args?: unknown },
  index: number,
): unknown {
  if (!isEmptyToolArgs(toolCall.args)) return toolCall.args;
  if (!isObject(chunk)) return toolCall.args;

  const additional = isObject(chunk.additional_kwargs) ? chunk.additional_kwargs : undefined;
  const rawToolCalls = Array.isArray(additional?.tool_calls)
    ? (additional.tool_calls as unknown[])
    : undefined;
  if (rawToolCalls?.length) {
    const byId = toolCall.id
      ? rawToolCalls.find((candidate) => isObject(candidate) && candidate.id === toolCall.id)
      : undefined;
    const byName = toolCall.name
      ? rawToolCalls.find((candidate) => {
          if (!isObject(candidate)) return false;
          const fn = isObject(candidate.function) ? candidate.function : undefined;
          return fn?.name === toolCall.name || candidate.name === toolCall.name;
        })
      : undefined;
    const byIndex = rawToolCalls[index];

    for (const candidate of [byId, byName, byIndex]) {
      const extracted = extractArgsFromRawToolCall(candidate);
      if (!isEmptyToolArgs(extracted)) return extracted;
    }
  }

  const toolCallChunks = Array.isArray(chunk.tool_call_chunks)
    ? (chunk.tool_call_chunks as unknown[])
    : undefined;
  if (toolCallChunks?.length) {
    const mergedArgs = toolCallChunks
      .filter((candidate, candidateIndex) => {
        if (!isObject(candidate)) return false;
        if (toolCall.id && typeof candidate.id === "string") return candidate.id === toolCall.id;
        if (toolCall.name && typeof candidate.name === "string") return candidate.name === toolCall.name;
        return candidateIndex === index;
      })
      .map((candidate) => (isObject(candidate) && typeof candidate.args === "string" ? candidate.args : ""))
      .join("");

    if (mergedArgs.trim().length > 0) {
      const parsed = parseJsonMaybe(mergedArgs);
      if (!isEmptyToolArgs(parsed)) return parsed;
    }
  }

  return toolCall.args;
}

export interface AgentConfig {
  /**
   * Maximum number of steps (agent + tool calls) before LangGraph throws.
   * Default: `25`.
   */
  recursionLimit?: number;
}

/**
 * The core LangGraph-powered conversational agent runtime.
 *
 * `GloveAgent` manages channel interactions and message dispatch for a
 * compiled LangGraph `StateGraph`.  The graph itself is constructed by the
 * builder functions in `./graphs.ts` (`buildSingleAgentGraph` or
 * `buildOrchestratorGraph`) and passed in at construction time.
 *
 * All conversation state is persisted via the graph's checkpointer, keyed by
 * `conversationId`, so each channel conversation has its own independent
 * multi-turn history.
 *
 * ## Usage
 * ```ts
 * import { buildSingleAgentGraph } from "./graphs";
 *
 * const graph = buildSingleAgentGraph({ model, tools, systemPrompt, checkpointer });
 * const agent = new GloveAgent(graph);
 * agent.addChannel(new CliChannel());
 * await agent.start();
 * ```
 */
export class GloveAgent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly graph: any;
  private readonly channels: Channel[] = [];

  /**
   * Create a GloveAgent from a pre-compiled LangGraph state graph.
   *
   * @param graph  A compiled `StateGraph` (from `buildSingleAgentGraph` or
   *               `buildOrchestratorGraph`).
   * @param config Optional runtime configuration.
   */
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graph: any,
    private readonly config: AgentConfig = {},
  ) {
    this.graph = graph;
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
  async invoke(
    text: string,
    conversationId: string,
    callbacks: LlmCallbackHandler[] = [new LlmCallbackHandler()],
  ): Promise<string> {
    const result = await this.graph.invoke(
      { messages: [new HumanMessage(text)] },
      {
        configurable: { thread_id: conversationId },
        recursionLimit: this.config.recursionLimit ?? 25,
        callbacks,
      },
    );

    const last = result.messages.at(-1);
    if (!last) throw new Error("Agent returned no messages");
    return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  }

  /**
   * Stream the agent's response token-by-token.
   * Yields text chunks produced by the agent node.  When `onToolEvent` is
   * provided, it is also called (synchronously, fire-and-forget) whenever a
   * completed tool call or tool result is encountered in the stream.
   *
   * @param onToolEvent - Optional callback invoked with role `"tool-call"` or
   *   `"tool-result"` and a JSON-serialised payload for each tool interaction.
   */
  async *stream(
    text: string,
    conversationId: string,
    callbacks: LlmCallbackHandler[] = [new LlmCallbackHandler()],
    onToolEvent?: (role: "tool-call" | "tool-result" | "agent-transfer", text: string) => void,
  ): AsyncGenerator<string> {
    const streamResult = await this.graph.stream(
      { messages: [new HumanMessage(text)] },
      {
        configurable: { thread_id: conversationId },
        streamMode: "messages",
        recursionLimit: this.config.recursionLimit ?? 25,
        callbacks,
      },
    );

    for await (const [chunk, _metadata] of streamResult as AsyncIterable<
      [unknown, { langgraph_node?: string }]
    >) {
      if (chunk instanceof AIMessageChunk) {
        if (chunk.tool_calls?.length) {
          // Completed tool-call decisions — fire event, don't yield text.
          if (onToolEvent) {
            for (const [toolIndex, tc] of chunk.tool_calls.entries()) {
              const resolvedArgs = recoverToolArgs(
                chunk,
                tc as { id?: string; name?: string; args?: unknown },
                toolIndex,
              );
              if (tc.name.startsWith("transfer_to_")) {
                // Orchestrator handoff to a sub-agent
                const targetAgent = tc.name.replace(/^transfer_to_/, "");
                const request =
                  typeof resolvedArgs === "object" && resolvedArgs !== null && "request" in resolvedArgs
                    ? (() => {
                        const value = (resolvedArgs as { request?: unknown }).request;
                        if (typeof value === "string") return value;
                        if (value == null) return "";
                        try {
                          return JSON.stringify(value);
                        } catch {
                          return String(value);
                        }
                      })()
                    : "";
                onToolEvent("agent-transfer", JSON.stringify({ agent: targetAgent, request }));
              } else {
                onToolEvent("tool-call", JSON.stringify({ name: tc.name, args: resolvedArgs }));
              }
            }
          }
        } else if (typeof chunk.content === "string" && chunk.content) {
          yield chunk.content;
        }
      } else if (chunk instanceof ToolMessage && onToolEvent) {
        const content =
          typeof chunk.content === "string"
            ? chunk.content
            : JSON.stringify(chunk.content);
        onToolEvent("tool-result", JSON.stringify({ name: chunk.name ?? undefined, content }));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async dispatchMessage(message: IncomingMessage, sourceChannel: Channel): Promise<void> {
    const receiveAllChannels = this.channels.filter((ch) => ch.receiveAll);
    const mirrorTargets = receiveAllChannels.filter((ch) => ch !== sourceChannel);
    const observabilityTargets = receiveAllChannels;

    // Mirror the user's message to other receiveAll channels before the agent replies.
    // Do not mirror back to the source channel; UI channels already render their own local input.
    for (const ch of mirrorTargets) {
      await ch
        .sendMessage({ conversationId: message.conversationId, text: message.text, role: "user" })
        .catch((e: unknown) => logger.error(`Failed to forward user message to channel "${ch.name}"`, e));
    }

    // Build a per-dispatch callback handler that logs prompts and also forwards
    // them to receiveAll channels so they can be inspected in real time.
    // This includes the source channel when it is configured with receiveAll=true.
    const sendPrompt = observabilityTargets.length
      ? (formatted: string): void => {
          for (const ch of observabilityTargets) {
            ch
              .sendMessage({ conversationId: message.conversationId, text: formatted, role: "prompt" })
              .catch((e: unknown) => logger.error(`Failed to send prompt to channel "${ch.name}"`, e));
          }
        }
      : undefined;
    const handler = new LlmCallbackHandler(sendPrompt);

    // Forward tool calls, results, and agent transfers to receiveAll channels.
    const onToolEvent = observabilityTargets.length
      ? (role: "tool-call" | "tool-result" | "agent-transfer", text: string): void => {
          for (const ch of observabilityTargets) {
            ch
              .sendMessage({ conversationId: message.conversationId, text, role })
              .catch((e: unknown) => logger.error(`Failed to send tool event to channel "${ch.name}"`, e));
          }
        }
      : undefined;

    if (sourceChannel.supportsStreaming) {
      let fullText = "";
      const baseStream = this.stream(message.text, message.conversationId, [handler], onToolEvent);

      // Intercept the stream so we can buffer the complete response for observers
      // without re-invoking the model.
      async function* teedStream(): AsyncGenerator<string> {
        for await (const chunk of baseStream) {
          fullText += chunk;
          yield chunk;
        }
      }

      await sourceChannel.sendStream(message.conversationId, teedStream());

      for (const ch of mirrorTargets) {
        await ch
          .sendMessage({ conversationId: message.conversationId, text: fullText, role: "agent" })
          .catch((e: unknown) => logger.error(`Failed to broadcast to channel "${ch.name}"`, e));
      }
    } else {
      const response = await this.invoke(message.text, message.conversationId, [handler]);
      await sourceChannel.sendMessage({ conversationId: message.conversationId, text: response });

      for (const ch of mirrorTargets) {
        await ch
          .sendMessage({ conversationId: message.conversationId, text: response, role: "agent" })
          .catch((e: unknown) => logger.error(`Failed to broadcast to channel "${ch.name}"`, e));
      }
    }
  }

}
