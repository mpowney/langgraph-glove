import { HumanMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Channel, IncomingMessage, OutgoingStreamChunk, StreamSource } from "../channels/Channel";
import { Logger } from "../logging/Logger";
import { LlmCallbackHandler } from "../logging/LlmCallbackHandler";
import type { ToolDefinition, ToolEventMetadata } from "../rpc/RpcProtocol";

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

function redactSensitiveArgs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveArgs(entry));
  }
  if (!isObject(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|grant/i.test(key)) {
      redacted[key] = "[REDACTED]";
      continue;
    }
    redacted[key] = redactSensitiveArgs(entry);
  }
  return redacted;
}

function mergeArgumentFragment(existing: string | undefined, incoming: string): string {
  if (!existing) return incoming;
  if (!incoming) return existing;
  // Some providers stream cumulative argument strings; others stream deltas.
  if (incoming.startsWith(existing)) return incoming;
  if (existing.startsWith(incoming)) return existing;
  return `${existing}${incoming}`;
}

const MIN_OVERLAP_DEDUP_CHARS = 8;

/**
 * Normalize streamed model text to a pure delta.
 *
 * Some providers emit cumulative snapshots ("Hel", "Hello", "Hello world")
 * while others emit true deltas ("Hel", "lo", " world"). This helper accepts
 * either style and always returns only the newly-added suffix. It also guards
 * against duplicate/retransmitted chunks by trimming substantial overlap with
 * the current full text.
 */
function normalizeStreamTextDelta(previous: string | undefined, incoming: string): {
  fullText: string;
  delta: string;
} {
  if (!previous) {
    return { fullText: incoming, delta: incoming };
  }
  if (!incoming) {
    return { fullText: previous, delta: "" };
  }

  // Cumulative snapshot mode.
  if (incoming.startsWith(previous)) {
    return {
      fullText: incoming,
      delta: incoming.slice(previous.length),
    };
  }

  // Duplicate / out-of-order snapshot.
  if (previous.startsWith(incoming)) {
    return { fullText: previous, delta: "" };
  }

  // Retransmitted/overlapping chunk mode: trim the largest suffix/prefix
  // overlap so repeated websocket chunks don't duplicate rendered text.
  const maxOverlap = Math.min(previous.length, incoming.length);
  let overlap = 0;
  for (let i = maxOverlap; i >= MIN_OVERLAP_DEDUP_CHARS; i -= 1) {
    if (previous.slice(-i) === incoming.slice(0, i)) {
      overlap = i;
      break;
    }
  }
  if (overlap > 0) {
    const delta = incoming.slice(overlap);
    if (!delta) {
      return { fullText: previous, delta: "" };
    }
    return {
      fullText: `${previous}${delta}`,
      delta,
    };
  }

  // Delta mode (or mixed mode): append incoming to previous.
  return {
    fullText: `${previous}${incoming}`,
    delta: incoming,
  };
}

function isGenericToolName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 || ["tool", "structuredtool", "dynamictool", "remotetool"].includes(normalized);
}

function toolNameFromToolCallId(toolCallId?: string): string | undefined {
  if (!toolCallId) return undefined;
  // Example: "functions.web_search:5" -> "web_search"
  const match = toolCallId.match(/(?:^|\.)([a-zA-Z0-9_-]+)(?::\d+)?$/);
  if (!match) return undefined;
  const candidate = match[1];
  return isGenericToolName(candidate) ? undefined : candidate;
}

function resolveToolName(
  runName: string | undefined,
  tool: unknown,
  toolCallId: string | undefined,
): string {
  if (typeof runName === "string" && !isGenericToolName(runName)) {
    return runName;
  }

  const fromCallId = toolNameFromToolCallId(toolCallId);
  if (fromCallId) return fromCallId;

  if (isObject(tool)) {
    if (typeof tool.name === "string" && !isGenericToolName(tool.name)) {
      return tool.name;
    }
    const kwargs = isObject(tool.kwargs) ? tool.kwargs : undefined;
    if (kwargs && typeof kwargs.name === "string" && !isGenericToolName(kwargs.name)) {
      return kwargs.name;
    }
  }

  return "tool";
}

function resolveChunkStreamSource(
  langgraphNode: string | undefined,
  activeSubAgent?: string,
): { source: StreamSource; agentKey?: string } {
  const node = langgraphNode?.trim();
  const nodeLower = node?.toLowerCase();
  const activeLower = activeSubAgent?.toLowerCase();

  if (nodeLower === "orchestrator" || nodeLower === "orchestrator_tools") {
    return { source: "main" };
  }

  // In orchestrator mode, nested sub-graphs often surface generic node names
  // like "agent"/"tools". When a handoff is active, attribute those chunks
  // to the active sub-agent so the UI can keep streams separate.
  if (activeSubAgent) {
    if (!nodeLower || nodeLower === "agent" || nodeLower === "tools" || nodeLower === "tool_failure_stop") {
      return { source: "sub-agent", agentKey: activeSubAgent };
    }
    if (
      activeLower
      && (
        nodeLower === activeLower
        || nodeLower.startsWith(`${activeLower}.`)
        || nodeLower.startsWith(`${activeLower}:`)
        || nodeLower.includes(`.${activeLower}.`)
      )
    ) {
      return { source: "sub-agent", agentKey: activeSubAgent };
    }
  }

  if (!nodeLower || nodeLower === "agent") {
    return { source: "main" };
  }

  return { source: "sub-agent", agentKey: node };
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

function findRawToolCall(
  chunk: unknown,
  toolCall: { id?: string; name?: string },
  index: number,
): unknown {
  if (!isObject(chunk)) return undefined;
  const additional = isObject(chunk.additional_kwargs) ? chunk.additional_kwargs : undefined;
  const rawToolCalls = Array.isArray(additional?.tool_calls)
    ? (additional.tool_calls as unknown[])
    : undefined;
  if (!rawToolCalls?.length) return undefined;

  const byId = toolCall.id
    ? rawToolCalls.find((candidate) => isObject(candidate) && candidate.id === toolCall.id)
    : undefined;
  if (byId) return byId;

  const byName = toolCall.name
    ? rawToolCalls.find((candidate) => {
        if (!isObject(candidate)) return false;
        const fn = isObject(candidate.function) ? candidate.function : undefined;
        return fn?.name === toolCall.name || candidate.name === toolCall.name;
      })
    : undefined;
  if (byName) return byName;

  return rawToolCalls[index];
}

function recoverToolArgs(
  chunk: unknown,
  toolCall: { id?: string; name?: string; args?: unknown },
  index: number,
  bufferedArgs?: unknown,
): unknown {
  if (!isEmptyToolArgs(toolCall.args)) return toolCall.args;
  if (!isEmptyToolArgs(bufferedArgs)) return bufferedArgs;
  if (!isObject(chunk)) return toolCall.args;

  const rawCall = findRawToolCall(chunk, toolCall, index);
  const extractedFromRaw = extractArgsFromRawToolCall(rawCall);
  if (!isEmptyToolArgs(extractedFromRaw)) {
    return extractedFromRaw;
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

/** Minimal interface for privilege-grant expiry lookups. */
interface PrivilegeGrantChecker {
  getPrivilegeGrantStatus(conversationId: string): { active: boolean; expiresAt?: string };
}

/** Per-conversation token context held in server memory. */
interface ConversationTokenEntry {
  personalToken?: string;
  /** Absolute ms timestamp after which personalToken is discarded. */
  personalTokenExpiresAt?: number;
  privilegeGrantId?: string;
  /** Absolute ms timestamp after which privilegeGrantId is discarded. */
  privilegeGrantExpiresAt?: number;
}

interface GraphDispatchInfo {
  graphKey: string;
  mode: "single-agent" | "multi-agent";
  orchestratorAgentKey: string;
  subAgentKeys: string[];
}

export interface AgentConfig {
  /**
   * Maximum number of steps (agent + tool calls) before LangGraph throws.
   * Default: `25`.
   */
  recursionLimit?: number;
  /**
   * Optional lookup function that resolves a tool name to its full definition.
   * When provided, structured metadata is attached to `tool-call` and
   * `tool-result` outgoing messages so channels can surface parameter
   * instructions to clients.
   */
  toolLookup?: (toolName: string) => ToolDefinition | undefined;
  /**
   * TTL for personal tokens stored in the server-side conversation context (ms).
   * Default: 24 hours. The TTL is refreshed each time the token is re-provided.
   */
  personalTokenTtlMs?: number;
  /**
   * Fallback TTL for privilege grant IDs when `authService` is not provided (ms).
   * Default: 10 minutes. When `authService` is provided the actual grant expiry
   * from the database is used instead.
   */
  privilegeGrantFallbackTtlMs?: number;
  /**
   * Optional auth service for accurate privilege-grant expiry lookups.
   * When provided, grant status is verified on each resolution and grants that
   * have expired or been revoked server-side are evicted from the context immediately.
   */
  authService?: PrivilegeGrantChecker;
  /**
   * Optional static graph metadata emitted to `receiveAll` channels when a
   * message is dispatched, so observers can see which graph processed it.
   */
  graphInfo?: GraphDispatchInfo;
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
  /** Server-side per-conversation token context, keyed by conversationId. */
  private readonly conversationContext = new Map<string, ConversationTokenEntry>();

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
          const receiveAllOthers = this.channels.filter((ch) => ch.receiveAll && ch !== channel);
          const errorTargets = [channel, ...receiveAllOthers];
          for (const ch of errorTargets) {
            await ch
              .sendMessage({
                conversationId: message.conversationId,
                role: "error",
                text: detail,
              })
              .catch((e: unknown) => logger.error("Failed to send error reply", e));
          }
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
    callbacks: BaseCallbackHandler[] = [new LlmCallbackHandler()],
    personalToken?: string,
    privilegeGrantId?: string,
  ): Promise<string> {
    const result = await this.graph.invoke(
      { messages: [new HumanMessage(text)] },
      {
        configurable: {
          thread_id: conversationId,
          conversationId,
          ...(personalToken ? { personalToken } : {}),
          ...(privilegeGrantId ? { privilegeGrantId } : {}),
        },
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
    callbacks: BaseCallbackHandler[] = [new LlmCallbackHandler()],
    onToolEvent?: (role: "tool-call" | "tool-result" | "agent-transfer", text: string, metadata?: ToolEventMetadata) => void,
    personalToken?: string,
    privilegeGrantId?: string,
  ): AsyncGenerator<OutgoingStreamChunk> {
    const streamedToolArgsByKey = new Map<string, string>();
    const streamedTextBySourceKey = new Map<string, string>();
    let activeSubAgent: string | undefined;

    const toolCallKey = (tool: { id?: string; name?: string }, toolIndex: number): string => {
      if (typeof tool.id === "string" && tool.id.trim().length > 0) {
        return `id:${tool.id}`;
      }
      if (typeof tool.name === "string" && tool.name.trim().length > 0) {
        return `name:${tool.name}:${toolIndex}`;
      }
      return `index:${toolIndex}`;
    };

    const appendToolArgChunk = (tool: { id?: string; name?: string }, toolIndex: number, argsChunk: string): void => {
      if (!argsChunk) return;
      const key = toolCallKey(tool, toolIndex);
      const current = streamedToolArgsByKey.get(key);
      streamedToolArgsByKey.set(key, mergeArgumentFragment(current, argsChunk));
    };

    const appendToolArgsFromAdditionalKwargs = (chunk: unknown): void => {
      if (!isObject(chunk)) return;
      const additional = isObject(chunk.additional_kwargs) ? chunk.additional_kwargs : undefined;
      if (!additional) return;

      const singleFunctionCall = isObject(additional.function_call)
        ? additional.function_call
        : undefined;
      if (singleFunctionCall && typeof singleFunctionCall.arguments === "string") {
        appendToolArgChunk(
          {
            name: typeof singleFunctionCall.name === "string" ? singleFunctionCall.name : undefined,
          },
          0,
          singleFunctionCall.arguments,
        );
      }

      const toolCalls = Array.isArray(additional.tool_calls)
        ? (additional.tool_calls as unknown[])
        : undefined;
      if (!toolCalls?.length) return;

      for (const [candidateIndex, candidate] of toolCalls.entries()) {
        if (!isObject(candidate)) continue;
        const fn = isObject(candidate.function) ? candidate.function : undefined;
        const candidateId = typeof candidate.id === "string" ? candidate.id : undefined;
        const candidateName =
          typeof fn?.name === "string"
            ? fn.name
            : (typeof candidate.name === "string" ? candidate.name : undefined);
        const candidateArgs =
          typeof fn?.arguments === "string"
            ? fn.arguments
            : (typeof candidate.arguments === "string" ? candidate.arguments : undefined);
        const candidatePosition =
          typeof candidate.index === "number" ? candidate.index : candidateIndex;

        if (candidateArgs) {
          appendToolArgChunk(
            { id: candidateId, name: candidateName },
            candidatePosition,
            candidateArgs,
          );
        }
      }
    };

    const consumeBufferedToolArgs = (tool: { id?: string; name?: string }, toolIndex: number): unknown => {
      const key = toolCallKey(tool, toolIndex);
      const combined = streamedToolArgsByKey.get(key);
      if (!combined) return undefined;
      streamedToolArgsByKey.delete(key);
      return parseJsonMaybe(combined);
    };

    const streamResult = await this.graph.stream(
      { messages: [new HumanMessage(text)] },
      {
        configurable: {
          thread_id: conversationId,
          conversationId,
          ...(personalToken ? { personalToken } : {}),
          ...(privilegeGrantId ? { privilegeGrantId } : {}),
        },
        streamMode: "messages",
        recursionLimit: this.config.recursionLimit ?? 25,
        callbacks,
      },
    );

    for await (const [chunk, metadata] of streamResult as AsyncIterable<
      [unknown, { langgraph_node?: string }]
    >) {
      if (chunk instanceof AIMessageChunk) {
        appendToolArgsFromAdditionalKwargs(chunk);

        if (isObject(chunk) && Array.isArray(chunk.tool_call_chunks)) {
          for (const [chunkIndex, chunkCall] of chunk.tool_call_chunks.entries()) {
            if (!isObject(chunkCall) || typeof chunkCall.args !== "string") continue;
            const candidateId = typeof chunkCall.id === "string" ? chunkCall.id : undefined;
            const candidateName = typeof chunkCall.name === "string" ? chunkCall.name : undefined;
            const candidateIndex = typeof chunkCall.index === "number" ? chunkCall.index : chunkIndex;
            appendToolArgChunk(
              { id: candidateId, name: candidateName },
              candidateIndex,
              chunkCall.args,
            );
          }
        }

        if (chunk.tool_calls?.length) {
          // Completed tool-call decisions — fire event, don't yield text.
          if (onToolEvent) {
            for (const [toolIndex, tc] of chunk.tool_calls.entries()) {
              const bufferedArgs = consumeBufferedToolArgs(
                { id: tc.id, name: tc.name },
                toolIndex,
              );
              const rawCall = findRawToolCall(
                chunk,
                { id: tc.id, name: tc.name },
                toolIndex,
              );
              const resolvedArgs = recoverToolArgs(
                chunk,
                tc as { id?: string; name?: string; args?: unknown },
                toolIndex,
                bufferedArgs,
              );
              if (tc.name.startsWith("transfer_to_")) {
                // Orchestrator handoff to a sub-agent
                const targetAgent = tc.name.replace(/^transfer_to_/, "");
                activeSubAgent = targetAgent;
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
              }
            }
          }
        } else if (typeof chunk.content === "string" && chunk.content) {
          const source = resolveChunkStreamSource(metadata?.langgraph_node, activeSubAgent);
          if (source.source === "main" && metadata?.langgraph_node?.trim().toLowerCase() === "orchestrator") {
            // Once orchestrator resumes normal text generation, the delegated
            // sub-agent phase is complete.
            activeSubAgent = undefined;
          }
          const sourceKey = source.source === "sub-agent"
            ? `sub-agent:${source.agentKey ?? "unknown"}`
            : "main";
          const previousText = streamedTextBySourceKey.get(sourceKey);
          const normalized = normalizeStreamTextDelta(previousText, chunk.content);
          streamedTextBySourceKey.set(sourceKey, normalized.fullText);
          if (!normalized.delta) {
            continue;
          }
          yield {
            text: normalized.delta,
            source: source.source,
            ...(source.agentKey ? { agentKey: source.agentKey } : {}),
          };
        }
      } else if (chunk instanceof ToolMessage && onToolEvent) {
        const toolName = chunk.name ?? undefined;
        const content =
          typeof chunk.content === "string"
            ? chunk.content
            : JSON.stringify(chunk.content);
        const toolDef = toolName && this.config.toolLookup ? this.config.toolLookup(toolName) : undefined;
        const meta: ToolEventMetadata | undefined = toolDef ? { tool: toolDef } : undefined;
        onToolEvent("tool-result", JSON.stringify({ name: toolName, content }), meta);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Upsert the per-conversation token context from message metadata.
   *  - `string`    → set / refresh with TTL
   *  - `null`      → explicit clear (remove from stored context)
   *  - `undefined` → no change (field absent from metadata)
   */
  private updateConversationContext(
    conversationId: string,
    personalToken: string | null | undefined,
    privilegeGrantId: string | null | undefined,
  ): void {
    const now = Date.now();
    const personalTokenTtlMs = this.config.personalTokenTtlMs ?? 24 * 60 * 60 * 1000;
    const privilegeGrantFallbackTtlMs = this.config.privilegeGrantFallbackTtlMs ?? 10 * 60 * 1000;
    const entry: ConversationTokenEntry = this.conversationContext.get(conversationId) ?? {};

      if (personalToken !== undefined) {
      if (!personalToken) {
        delete entry.personalToken;
        delete entry.personalTokenExpiresAt;
      } else {
        entry.personalToken = personalToken;
        entry.personalTokenExpiresAt = now + personalTokenTtlMs;
      }
    }

    if (privilegeGrantId !== undefined) {
      if (!privilegeGrantId) {
        delete entry.privilegeGrantId;
        delete entry.privilegeGrantExpiresAt;
      } else {
        entry.privilegeGrantId = privilegeGrantId;
        // Prefer the actual grant expiry from AuthService; fall back to configurable TTL.
        const grantStatus = this.config.authService?.getPrivilegeGrantStatus(conversationId);
        entry.privilegeGrantExpiresAt =
          grantStatus?.active && grantStatus.expiresAt
            ? Date.parse(grantStatus.expiresAt)
            : now + privilegeGrantFallbackTtlMs;
      }
    }

    if (entry.personalToken !== undefined || entry.privilegeGrantId !== undefined) {
      this.conversationContext.set(conversationId, entry);
    } else {
      this.conversationContext.delete(conversationId);
    }
  }

  /**
   * Return the effective tokens for a conversation, evicting any that have
   * passed their expiry timestamp or whose privilege grant is no longer active.
   */
  private resolveConversationTokens(conversationId: string): {
    personalToken: string | undefined;
    privilegeGrantId: string | undefined;
  } {
    const now = Date.now();
    const entry = this.conversationContext.get(conversationId);
    if (!entry) return { personalToken: undefined, privilegeGrantId: undefined };

    let { personalToken, privilegeGrantId } = entry;

    if (
      personalToken !== undefined &&
      entry.personalTokenExpiresAt !== undefined &&
      entry.personalTokenExpiresAt <= now
    ) {
      delete entry.personalToken;
      delete entry.personalTokenExpiresAt;
      personalToken = undefined;
      logger.debug(`Personal token expired for conversation ${conversationId}`);
    }

    if (privilegeGrantId !== undefined) {
      const timestampExpired =
        entry.privilegeGrantExpiresAt !== undefined && entry.privilegeGrantExpiresAt <= now;
      const grantRevoked =
        !timestampExpired &&
        this.config.authService !== undefined &&
        !this.config.authService.getPrivilegeGrantStatus(conversationId).active;
      if (timestampExpired || grantRevoked) {
        delete entry.privilegeGrantId;
        delete entry.privilegeGrantExpiresAt;
        privilegeGrantId = undefined;
        logger.debug(`Privilege grant expired for conversation ${conversationId}`);
      }
    }

    if (entry.personalToken === undefined && entry.privilegeGrantId === undefined) {
      this.conversationContext.delete(conversationId);
    } else {
      this.conversationContext.set(conversationId, entry);
    }

    return { personalToken, privilegeGrantId };
  }

  private async dispatchMessage(message: IncomingMessage, sourceChannel: Channel): Promise<void> {
    // Extract metadata tokens: string = set/refresh, null = explicit clear, undefined = absent.
    const msgPersonalToken =
      typeof message.metadata?.personalToken === "string"
        ? message.metadata.personalToken
        : message.metadata?.personalToken === null
          ? null
          : undefined;
    const msgPrivilegeGrantId =
      typeof message.metadata?.privilegeGrantId === "string"
        ? message.metadata.privilegeGrantId
        : message.metadata?.privilegeGrantId === null
          ? null
          : undefined;

    this.updateConversationContext(message.conversationId, msgPersonalToken, msgPrivilegeGrantId);
    const { personalToken, privilegeGrantId } = this.resolveConversationTokens(message.conversationId);

    if (message.metadata?.contextOnly === true) {
      return;
    }

    const receiveAllChannels = this.channels.filter((ch) => ch.receiveAll);
    const mirrorTargets = receiveAllChannels.filter((ch) => ch !== sourceChannel);
    const observabilityTargets = receiveAllChannels;

    if (observabilityTargets.length > 0 && this.config.graphInfo) {
      const graphInfoText = JSON.stringify(
        {
          type: "graph-info",
          graphName: this.config.graphInfo.graphKey,
          graph: this.config.graphInfo,
          sourceChannel: sourceChannel.name,
        },
        null,
        2,
      );
      for (const ch of observabilityTargets) {
        ch
          .sendMessage({
            conversationId: message.conversationId,
            text: graphInfoText,
            role: "graph-definition",
          })
          .catch((e: unknown) => logger.error(`Failed to send graph info to channel "${ch.name}"`, e));
      }
    }

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
    const sendModelCall = observabilityTargets.length
      ? (payload: Record<string, unknown>): void => {
          const text = JSON.stringify(payload, null, 2);
          for (const ch of observabilityTargets) {
            ch
              .sendMessage({ conversationId: message.conversationId, text, role: "model-call" })
              .catch((e: unknown) => logger.error(`Failed to send model call to channel "${ch.name}"`, e));
          }
        }
      : undefined;
    const sendModelResponse = observabilityTargets.length
      ? (payload: Record<string, unknown>): void => {
          const text = JSON.stringify(payload, null, 2);
          for (const ch of observabilityTargets) {
            ch
              .sendMessage({ conversationId: message.conversationId, text, role: "model-response" })
              .catch((e: unknown) => logger.error(`Failed to send model response to channel "${ch.name}"`, e));
          }
        }
      : undefined;
    const handler = new LlmCallbackHandler(sendPrompt, sendModelCall, sendModelResponse);

    // Forward tool calls, results, and agent transfers to receiveAll channels.
    const toolLookup = this.config.toolLookup;
    const onToolEvent = observabilityTargets.length
      ? (role: "tool-call" | "tool-result" | "agent-transfer", text: string, toolEventMetadata?: ToolEventMetadata): void => {
          for (const ch of observabilityTargets) {
            ch
              .sendMessage({ conversationId: message.conversationId, text, role, toolEventMetadata })
              .catch((e: unknown) => logger.error(`Failed to send tool event to channel "${ch.name}"`, e));
          }
        }
      : undefined;

    // Emit tool-call events from actual tool execution input so the UI shows
    // the exact arguments that were invoked, independent of provider-specific
    // model chunk formats.
    const toolStartCallback = onToolEvent
      ? BaseCallbackHandler.fromMethods({
          handleToolStart: (
            tool,
            input,
            _runId,
            _parentRunId,
            _tags,
            _metadata,
            runName,
            toolCallId,
          ): void => {
            const toolName = resolveToolName(
              typeof runName === "string" ? runName : undefined,
              tool,
              typeof toolCallId === "string" ? toolCallId : undefined,
            );
            const args = parseJsonMaybe(input);
            const toolDef = toolLookup ? toolLookup(toolName) : undefined;
            const meta: ToolEventMetadata | undefined = toolDef
              ? { tool: toolDef }
              : undefined;
            onToolEvent(
              "tool-call",
              JSON.stringify({
                name: toolName,
                args: redactSensitiveArgs(args),
                ...(toolCallId ? { id: toolCallId } : {}),
                type: "tool_call",
              }),
              meta,
            );
          },
        })
      : undefined;
    const callbacks: BaseCallbackHandler[] = toolStartCallback
      ? [handler, toolStartCallback]
      : [handler];

    if (sourceChannel.supportsStreaming) {
      let fullText = "";
      const baseStream = this.stream(
        message.text,
        message.conversationId,
        callbacks,
        onToolEvent,
        personalToken,
        privilegeGrantId,
      );

      // Intercept the stream so we can buffer the complete response for observers
      // without re-invoking the model.
      async function* teedStream(): AsyncGenerator<OutgoingStreamChunk> {
        for await (const chunk of baseStream) {
          fullText += chunk.text;
          yield chunk;
        }
      }

      try {
        await sourceChannel.sendStream(message.conversationId, teedStream());

        for (const ch of mirrorTargets) {
          await ch
            .sendMessage({ conversationId: message.conversationId, text: fullText, role: "agent" })
            .catch((e: unknown) => logger.error(`Failed to broadcast to channel "${ch.name}"`, e));
        }
      } catch (err) {
        const detail = formatError(err);
        const canFallbackToInvoke = fullText.length === 0;
        if (!canFallbackToInvoke) {
          throw err;
        }

        logger.warn(
          `Streaming failed before any output; falling back to non-stream invoke (conversation: ${message.conversationId}): ${detail}`,
        );

        const fallbackResponse = await this.invoke(
          message.text,
          message.conversationId,
          callbacks,
          personalToken,
          privilegeGrantId,
        );

        await sourceChannel.sendMessage({
          conversationId: message.conversationId,
          text: fallbackResponse,
          role: "agent",
        });

        for (const ch of mirrorTargets) {
          await ch
            .sendMessage({ conversationId: message.conversationId, text: fallbackResponse, role: "agent" })
            .catch((e: unknown) => logger.error(`Failed to broadcast fallback response to channel "${ch.name}"`, e));
        }
      }
    } else {
      const response = await this.invoke(
        message.text,
        message.conversationId,
        callbacks,
        personalToken,
        privilegeGrantId,
      );
      await sourceChannel.sendMessage({ conversationId: message.conversationId, text: response });

      for (const ch of mirrorTargets) {
        await ch
          .sendMessage({ conversationId: message.conversationId, text: response, role: "agent" })
          .catch((e: unknown) => logger.error(`Failed to broadcast to channel "${ch.name}"`, e));
      }
    }
  }

}
