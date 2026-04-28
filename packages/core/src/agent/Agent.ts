import { HumanMessage, AIMessageChunk } from "@langchain/core/messages";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { ObservabilityConfig } from "@langgraph-glove/config";
import type {
  Channel,
  IncomingMessage,
  OutgoingContentItem,
  OutgoingToolReference,
  OutgoingStreamChunk,
  StreamSource,
} from "../channels/Channel";
import { Logger } from "../logging/Logger";
import { LlmCallbackHandler } from "../logging/LlmCallbackHandler";
import type { ToolDefinition, ToolEventMetadata } from "../rpc/RpcProtocol";
import { ObservabilityMiddleware } from "../observability/ObservabilityMiddleware.js";
import { isGenericToolName, toolNameFromToolCallId, resolveToolName } from "./toolNameUtils.js";

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

function extractContentItems(value: unknown): OutgoingContentItem[] {
  const itemsByRef = new Map<string, OutgoingContentItem>();

  const ensureItem = (contentRef: string): OutgoingContentItem => {
    const existing = itemsByRef.get(contentRef);
    if (existing) return existing;
    const created: OutgoingContentItem = {
      contentRef,
      downloadPath: `/api/content/${encodeURIComponent(contentRef)}/download`,
      previewPath: `/api/content/${encodeURIComponent(contentRef)}/preview`,
    };
    itemsByRef.set(contentRef, created);
    return created;
  };

  const readString = (record: Record<string, unknown>, key: string): string | undefined => {
    const value = record[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const readNumber = (record: Record<string, unknown>, key: string): number | undefined => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  const collect = (input: unknown): void => {
    if (!input) return;

    if (typeof input === "string") {
      const trimmed = input.trim();
      if (/^content_[a-f0-9-]+$/i.test(trimmed)) {
        ensureItem(trimmed);
      }

      const matches = trimmed.match(/content_[a-f0-9-]+/gi);
      if (matches) {
        for (const match of matches) ensureItem(match);
      }

      const parsed = parseJsonMaybe(trimmed);
      if (parsed !== input) {
        collect(parsed);
      }
      return;
    }

    if (Array.isArray(input)) {
      for (const item of input) collect(item);
      return;
    }

    if (typeof input === "object") {
      const record = input as Record<string, unknown>;
      if (typeof record["contentRef"] === "string") {
        const contentRef = record["contentRef"] as string;
        const item = ensureItem(contentRef);
        item.fileName =
          readString(record, "fileName")
          ?? readString(record, "filename")
          ?? readString(record, "name")
          ?? item.fileName;
        item.mimeType =
          readString(record, "mimeType")
          ?? readString(record, "mime")
          ?? item.mimeType;
        item.byteLength =
          readNumber(record, "byteLength")
          ?? readNumber(record, "size")
          ?? item.byteLength;
      }
      if (Array.isArray(record["contentRefs"])) {
        for (const ref of record["contentRefs"] as unknown[]) {
          if (typeof ref === "string") ensureItem(ref);
        }
      }
      for (const nested of Object.values(record)) {
        collect(nested);
      }
    }
  };

  collect(value);
  return [...itemsByRef.values()];
}

function buildOutgoingContentItemsFromToolOutput(content: string): OutgoingContentItem[] | undefined {
  const items = extractContentItems(content);
  return items.length > 0 ? items : undefined;
}

function mergeOutgoingContentItems(
  ...groups: Array<OutgoingContentItem[] | undefined>
): OutgoingContentItem[] | undefined {
  const merged = new Map<string, OutgoingContentItem>();

  for (const group of groups) {
    if (!group) continue;
    for (const item of group) {
      const existing = merged.get(item.contentRef);
      merged.set(item.contentRef, {
        ...(existing ?? {}),
        ...item,
      });
    }
  }

  return merged.size > 0 ? [...merged.values()] : undefined;
}

function mergeOutgoingToolReferences(
  ...groups: Array<OutgoingToolReference[] | undefined>
): OutgoingToolReference[] | undefined {
  const merged = new Map<string, OutgoingToolReference>();

  for (const group of groups) {
    if (!group) continue;
    for (const reference of group) {
      const key = `${reference.url}|${reference.title ?? ""}|${reference.sourceTool ?? ""}`;
      merged.set(key, reference);
    }
  }

  return merged.size > 0 ? [...merged.values()] : undefined;
}

function readStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 1;
  } catch {
    return false;
  }
}

function extractAgentKeyFromCallbackMetadata(metadata: unknown): string | undefined {
  if (!isObject(metadata)) return undefined;

  const readCandidate = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const normalized = trimmed.toLowerCase();
    if (
      normalized === "default"
      || normalized === "orchestrator"
      || normalized === "tools"
      || normalized === "agent"
    ) {
      return undefined;
    }
    return trimmed;
  };

  const direct = readCandidate(metadata.agentKey)
    ?? readCandidate(metadata.agent_key)
    ?? readCandidate(metadata.langgraph_node)
    ?? readCandidate(metadata.node);
  if (direct) return direct;

  if (isObject(metadata.metadata)) {
    return extractAgentKeyFromCallbackMetadata(metadata.metadata);
  }
  return undefined;
}

function buildOutgoingToolReferencesFromToolOutput(
  toolName: string | undefined,
  output: unknown,
  toolArgs: unknown,
): OutgoingToolReference[] | undefined {
  const referencesByUrl = new Map<string, OutgoingToolReference>();
  const normalizedOutput = (() => {
    if (typeof output === "string") {
      return parseJsonMaybe(output);
    }
    if (!isObject(output)) return output;

    if (typeof output.content === "string") {
      const parsedContent = parseJsonMaybe(output.content);
      if (parsedContent !== output.content) return parsedContent;
    }

    const kwargs = isObject(output.kwargs) ? output.kwargs : undefined;
    if (!kwargs) return output;
    if (typeof kwargs.content === "string") {
      const parsed = parseJsonMaybe(kwargs.content);
      if (parsed !== kwargs.content) return parsed;
    }
    if (Object.prototype.hasOwnProperty.call(kwargs, "content")) {
      return kwargs.content;
    }
    return output;
  })();

  const addReference = (
    urlCandidate: unknown,
    titleCandidate: unknown,
    kind: string,
    metadata?: Record<string, unknown>,
  ): void => {
    if (typeof urlCandidate !== "string") return;
    const url = urlCandidate.trim();
    if (!url || !isAbsoluteUrl(url)) return;

    const title =
      typeof titleCandidate === "string" && titleCandidate.trim().length > 0
        ? titleCandidate.trim()
        : url;

    referencesByUrl.set(url, {
      url,
      title,
      kind,
      ...(toolName ? { sourceTool: toolName } : {}),
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  };

  const addReferenceFromRecord = (candidate: unknown, fallbackKind = "resource"): void => {
    const record = asRecord(candidate);
    if (!record) return;

    const nestedLink = asRecord(record.link);
    const nestedResource = asRecord(record.resource);
    const url = readStringField(record, ["url", "href", "link"])
      ?? readStringField(nestedLink ?? {}, ["url", "href"])
      ?? readStringField(nestedResource ?? {}, ["url", "href"]);
    if (!url) return;

    const title =
      readStringField(record, ["title", "name", "label"])
      ?? readStringField(nestedLink ?? {}, ["title", "name", "label"])
      ?? readStringField(nestedResource ?? {}, ["title", "name", "label"])
      ?? url;
    const kind = readStringField(record, ["kind", "type", "category"]) ?? fallbackKind;

    addReference(url, title, kind);
  };

  if (Array.isArray(normalizedOutput)) {
    for (const item of normalizedOutput) {
      addReferenceFromRecord(item);
    }
  } else if (isObject(normalizedOutput)) {
    for (const field of ["references", "links", "resources", "urls"]) {
      const value = normalizedOutput[field];
      if (Array.isArray(value)) {
        for (const item of value) {
          addReferenceFromRecord(item);
        }
      } else {
        addReferenceFromRecord(value);
      }
    }

    if (!Array.isArray(normalizedOutput.references) && !Array.isArray(normalizedOutput.links)) {
      addReferenceFromRecord(normalizedOutput);
    }
  }

  if (toolName === "web_get_content" && isObject(toolArgs)) {
    addReference(toolArgs.url, toolArgs.url, "web", {
      ...(typeof toolArgs.selector === "string" ? { selector: toolArgs.selector } : {}),
    });
  }

  if (toolName === "web_search" && isObject(normalizedOutput) && Array.isArray(normalizedOutput.results)) {
    for (const result of normalizedOutput.results) {
      if (!isObject(result)) continue;
      addReference(result.url, result.title, "web");
    }
  }

  if (
    (toolName === "imap_search" || toolName === "imap_get_email" || toolName === "imap_get_thread")
    && isObject(normalizedOutput)
  ) {
    const addEmailReference = (emailValue: unknown): void => {
      if (!isObject(emailValue)) return;
      const url = readStringField(emailValue, ["itemUrl", "item_url"]);
      if (!url) return;
      const title =
        readStringField(emailValue, ["subject", "title"])
        ?? readStringField(emailValue, ["messageId", "id"])
        ?? url;
      addReference(url, title, "email");
    };

    if (toolName === "imap_search" && Array.isArray(normalizedOutput.results)) {
      for (const result of normalizedOutput.results) {
        if (!isObject(result)) continue;
        addEmailReference(result.email);
      }
    } else if (toolName === "imap_get_thread" && Array.isArray(normalizedOutput.emails)) {
      for (const email of normalizedOutput.emails) {
        addEmailReference(email);
      }
    } else {
      addEmailReference(normalizedOutput);
    }
  }

  if (
    (toolName === "browse_open" || toolName === "browse_submit_form")
    && isObject(normalizedOutput)
  ) {
    addReference(normalizedOutput.url, normalizedOutput.title, "web", {
      ...(typeof normalizedOutput.sessionId === "string" ? { sessionId: normalizedOutput.sessionId } : {}),
    });
  }

  const references = [...referencesByUrl.values()];
  return references.length > 0 ? references : undefined;
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

// resolveToolName, isGenericToolName, toolNameFromToolCallId are imported from ./toolNameUtils.js
// Keep a reference to suppress unused-import warnings for the re-exported helpers.
void isGenericToolName;
void toolNameFromToolCallId;

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
   * Optional provider for runtime content upload auth payloads keyed by tool
   * name. Called per turn so short-lived upload tokens stay fresh.
   */
  getContentUploadAuthByTool?: (conversationId: string) => Record<string, unknown>;
  /**
  * Optional static graph metadata emitted to `receiveAgentProcessing` channels when a
   * message is dispatched, so observers can see which graph processed it.
   */
  graphInfo?: GraphDispatchInfo;
  /**
   * Optional callback fired after a turn completes with a final assistant
   * response, regardless of whether the source channel used streaming.
   */
  onTurnComplete?: (params: {
    conversationId: string;
    userText: string;
    assistantText: string;
    sourceChannel: string;
    graphKey?: string;
  }) => void | Promise<void>;
  /** Optional observability routing/filtering config. */
  observability?: ObservabilityConfig;
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
  /** Track conversations that have been stopped by "!stop" command. */
  private readonly stoppedConversations = new Set<string>();
  /** Track conversations with an active run (stream or invoke in progress). */
  private readonly activeConversations = new Set<string>();

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
          const receiveAgentProcessingOthers = this.channels.filter(
            (ch) => ch.receiveAgentProcessing && ch !== channel,
          );
          const errorTargets = [channel, ...receiveAgentProcessingOthers];
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

      // Register command handler for special commands like "!stop"
      channel.setCommandHandler(async (command, conversationId) => {
        if (command.trim().toLowerCase() === "!stop") {
          const wasActive = this.activeConversations.has(conversationId);
          if (wasActive) {
            this.stopConversation(conversationId);
            await channel
              .sendMessage({
                conversationId,
                role: "agent",
                text: "Processing stopped.",
              })
              .catch((e: unknown) => logger.error(`Failed to send stop confirmation on channel "${channel.name}"`, e));
          } else {
            await channel
              .sendMessage({
                conversationId,
                role: "agent",
                text: "No active processing to stop.",
              })
              .catch((e: unknown) => logger.error(`Failed to send stop response on channel "${channel.name}"`, e));
          }
        }
      });

      await channel.start();
      logger.info(`Channel started: ${channel.name}`);
    }
  }

  /**
   * Stop processing for a specific conversation (triggered by "!stop" command).
   * Only has effect if the conversation has an active run.
   * For streaming runs, this will break out of the streaming loop.
   */
  stopConversation(conversationId: string): void {
    this.stoppedConversations.add(conversationId);
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
    runtimeContext?: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.graph.invoke(
      { messages: [new HumanMessage(text)] },
      {
        configurable: {
          thread_id: conversationId,
          conversationId,
          ...(personalToken ? { personalToken } : {}),
          ...(privilegeGrantId ? { privilegeGrantId } : {}),
          ...(runtimeContext ?? {}),
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
    onToolEvent?: (
      role: "tool-call" | "tool-result" | "agent-transfer",
      text: string,
      toolName?: string,
      metadata?: ToolEventMetadata,
      contentItems?: OutgoingContentItem[],
      references?: OutgoingToolReference[],
    ) => void,
    onToolNameHint?: (toolCallId: string, toolName: string) => void,
    personalToken?: string,
    privilegeGrantId?: string,
    runtimeContext?: Record<string, unknown>,
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
          ...(runtimeContext ?? {}),
        },
        streamMode: "messages",
        recursionLimit: this.config.recursionLimit ?? 25,
        callbacks,
      },
    );

    for await (const [chunk, metadata] of streamResult as AsyncIterable<
      [unknown, { langgraph_node?: string }]
    >) {
      // Check if this conversation has been stopped via "!stop" command
      if (this.stoppedConversations.has(conversationId)) {
        this.stoppedConversations.delete(conversationId);
        break;
      }
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
              if (
                typeof tc.id === "string"
                && typeof tc.name === "string"
                && !isGenericToolName(tc.name)
              ) {
                onToolNameHint?.(tc.id, tc.name);
              }
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
                onToolEvent("agent-transfer", JSON.stringify({ agent: targetAgent, request }), undefined);
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

    const receiveAgentProcessingChannels = this.channels.filter((ch) => ch.receiveAgentProcessing);
    const mirrorTargets = receiveAgentProcessingChannels.filter((ch) => ch !== sourceChannel);
    const observabilityTargets = receiveAgentProcessingChannels;
    const observability = new ObservabilityMiddleware({
      channels: observabilityTargets,
      config: this.config.observability,
    });
    const scopesEnabled = observability.areScopesEnabled();
    const invokeScopeId = `invoke_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    if (scopesEnabled) {
      observability.emitScope({
        conversationId: message.conversationId,
        source: "agent",
        scopeType: "InvokeAgent",
        scope: {
          scopeId: invokeScopeId,
          phase: "start",
          input: message.text,
          sourceChannel: sourceChannel.name,
          startedAt: new Date().toISOString(),
        },
      });
    }

    if (observabilityTargets.length > 0 && this.config.graphInfo) {
      const graphInfoText = JSON.stringify(
        {
          type: "graph-info",
          graphName: this.config.graphInfo.graphKey,
          graph: this.config.graphInfo,
          sourceChannel: sourceChannel.name,
          ...(message.metadata?.chatGuid !== undefined ? { chatGuid: message.metadata.chatGuid } : {}),
        },
        null,
        2,
      );
      observability.emit({
        conversationId: message.conversationId,
        text: graphInfoText,
        role: "graph-definition",
        source: "agent",
        payload: {
          type: "graph-info",
          graphName: this.config.graphInfo.graphKey,
          graph: this.config.graphInfo,
          sourceChannel: sourceChannel.name,
          ...(message.metadata?.chatGuid !== undefined ? { chatGuid: message.metadata.chatGuid } : {}),
        },
      });
    }

    // Mirror the user's message to other receiveAgentProcessing channels before the agent replies.
    // Do not mirror back to the source channel; UI channels already render their own local input.
    for (const ch of mirrorTargets) {
      await ch
        .sendMessage({ conversationId: message.conversationId, text: message.text, role: "user" })
        .catch((e: unknown) => logger.error(`Failed to forward user message to channel "${ch.name}"`, e));
    }

    // Build a per-dispatch callback handler that logs prompts and also forwards
    // them to receiveAgentProcessing channels so they can be inspected in real time.
    // This includes the source channel when it is configured with receiveAgentProcessing=true.
    const sendPrompt = observabilityTargets.length
      ? (formatted: string): void => {
          observability.emit({
            conversationId: message.conversationId,
            text: formatted,
            role: "prompt",
            source: "agent",
          });
        }
      : undefined;
    const sendModelCall = observabilityTargets.length
      ? (payload: Record<string, unknown>): void => {
          const text = JSON.stringify(payload, null, 2);
          observability.emit({
            conversationId: message.conversationId,
            text,
            role: "model-call",
            source: "agent",
            payload,
          });

          if (scopesEnabled) {
            observability.emitScope({
              conversationId: message.conversationId,
              source: "agent",
              scopeType: "Inference",
              scope: {
                phase: "request",
                request: payload,
                timestamp: new Date().toISOString(),
              },
            });
          }
        }
      : undefined;
    const sendModelResponse = observabilityTargets.length
      ? (payload: Record<string, unknown>): void => {
          const text = JSON.stringify(payload, null, 2);
          observability.emit({
            conversationId: message.conversationId,
            text,
            role: "model-response",
            source: "agent",
            payload,
          });

          if (scopesEnabled) {
            observability.emitScope({
              conversationId: message.conversationId,
              source: "agent",
              scopeType: "Inference",
              scope: {
                phase: "response",
                response: payload,
                timestamp: new Date().toISOString(),
              },
            });
          }
        }
      : undefined;
    const handler = new LlmCallbackHandler(sendPrompt, sendModelCall, sendModelResponse);
    let pendingToolContentItems: OutgoingContentItem[] | undefined;
    let pendingToolReferences: OutgoingToolReference[] | undefined;

    // Forward tool calls, results, and agent transfers to receiveAgentProcessing channels.
    const toolLookup = this.config.toolLookup;
    const onToolEvent = (
      role: "tool-call" | "tool-result" | "agent-transfer",
      text: string,
      toolName?: string,
      toolEventMetadata?: ToolEventMetadata,
      contentItems?: OutgoingContentItem[],
      references?: OutgoingToolReference[],
    ): void => {
      if (role === "tool-result") {
        pendingToolContentItems = mergeOutgoingContentItems(pendingToolContentItems, contentItems);
        pendingToolReferences = mergeOutgoingToolReferences(pendingToolReferences, references);
      }

      if (observabilityTargets.length === 0) return;

      const resolvedToolName = (() => {
        if (toolName && !isGenericToolName(toolName)) return toolName;
        const metaToolName = toolEventMetadata?.tool?.name;
        if (typeof metaToolName === "string" && !isGenericToolName(metaToolName)) {
          return metaToolName;
        }
        return toolName;
      })();
      observability.emit({
        conversationId: message.conversationId,
        text,
        role,
        source: "agent",
        toolName: resolvedToolName,
        toolEventMetadata,
        contentItems,
        references,
        payload: parseJsonMaybe(text),
        agentKey: toolEventMetadata?.agentKey,
      });
    };

    // Emit tool-call and tool-result events from callback hooks so UI
    // observability does not depend on provider-specific stream chunk types.
    const toolRunNameByRunId = new Map<string, string>();
    const toolStartArgsByRunId = new Map<string, unknown>();
    const toolAgentKeyByRunId = new Map<string, string>();
    const toolStartedAtByRunId = new Map<string, number>();
    const toolNameByCallId = new Map<string, string>();
    const toolStartCallback = BaseCallbackHandler.fromMethods({
          handleToolStart: (
            tool,
            input,
            runId,
            _parentRunId,
            _tags,
            metadata,
            runName,
            toolCallId,
          ): void => {
            const resolvedToolName = resolveToolName(
              typeof runName === "string" ? runName : undefined,
              tool,
              typeof toolCallId === "string" ? toolCallId : undefined,
              metadata,
            );
            const hintedToolName =
              typeof toolCallId === "string"
                ? toolNameByCallId.get(toolCallId)
                : undefined;
            const toolName =
              hintedToolName && !isGenericToolName(hintedToolName)
                ? hintedToolName
                : resolvedToolName;
            toolRunNameByRunId.set(String(runId), toolName);
            const args = parseJsonMaybe(input);
            toolStartArgsByRunId.set(String(runId), args);
            toolStartedAtByRunId.set(String(runId), Date.now());
            const agentKey = extractAgentKeyFromCallbackMetadata(metadata);
            if (agentKey) {
              toolAgentKeyByRunId.set(String(runId), agentKey);
            }
            const toolDef = toolLookup ? toolLookup(toolName) : undefined;
            const meta: ToolEventMetadata | undefined = toolDef
              ? { tool: toolDef, ...(agentKey ? { agentKey } : {}) }
              : undefined;
            onToolEvent(
              "tool-call",
              JSON.stringify({
                name: toolName,
                args: redactSensitiveArgs(args),
                ...(toolCallId ? { id: toolCallId } : {}),
                type: "tool_call",
              }),
              toolName,
              meta,
            );

            if (scopesEnabled) {
              observability.emitScope({
                conversationId: message.conversationId,
                source: "agent",
                scopeType: "ExecuteTool",
                toolName,
                ...(agentKey ? { agentKey } : {}),
                scope: {
                  phase: "start",
                  runId: String(runId),
                  toolCallId,
                  arguments: redactSensitiveArgs(args),
                  timestamp: new Date().toISOString(),
                },
              });
            }
          },
          handleToolEnd: (output, runId): void => {
            const runKey = String(runId);
            const toolName = toolRunNameByRunId.get(runKey);
            toolRunNameByRunId.delete(runKey);
            const startArgs = toolStartArgsByRunId.get(runKey);
            toolStartArgsByRunId.delete(runKey);
            const agentKey = toolAgentKeyByRunId.get(runKey);
            toolAgentKeyByRunId.delete(runKey);
            const startedAt = toolStartedAtByRunId.get(runKey);
            toolStartedAtByRunId.delete(runKey);
            const content = (() => {
              if (typeof output === "string") return output;
              try {
                return JSON.stringify(output);
              } catch {
                return String(output);
              }
            })();
            const toolDef = toolName && toolLookup ? toolLookup(toolName) : undefined;
            const meta: ToolEventMetadata | undefined = toolDef
              ? { tool: toolDef, ...(agentKey ? { agentKey } : {}) }
              : undefined;
            const contentItems = buildOutgoingContentItemsFromToolOutput(content);
            const references = buildOutgoingToolReferencesFromToolOutput(toolName, output, startArgs);
            const toolResultPayload: Record<string, unknown> = { name: toolName, content };
            if (references && references.length > 0) {
              toolResultPayload.references = references;
            }
            onToolEvent(
              "tool-result",
              JSON.stringify(toolResultPayload),
              toolName,
              meta,
              contentItems,
              references,
            );

            if (scopesEnabled) {
              observability.emitScope({
                conversationId: message.conversationId,
                source: "agent",
                scopeType: "ExecuteTool",
                ...(toolName ? { toolName } : {}),
                ...(agentKey ? { agentKey } : {}),
                scope: {
                  phase: "end",
                  runId: runKey,
                  durationMs: typeof startedAt === "number" ? Math.max(0, Date.now() - startedAt) : undefined,
                  result: parseJsonMaybe(content),
                  timestamp: new Date().toISOString(),
                },
              });
            }
          },
          handleToolError: (error, runId): void => {
            const runKey = String(runId);
            const toolName = toolRunNameByRunId.get(runKey);
            toolRunNameByRunId.delete(runKey);
            toolStartArgsByRunId.delete(runKey);
            const agentKey = toolAgentKeyByRunId.get(runKey);
            toolAgentKeyByRunId.delete(runKey);
            const startedAt = toolStartedAtByRunId.get(runKey);
            toolStartedAtByRunId.delete(runKey);
            const errorMessage = error instanceof Error ? error.message : String(error);
            const toolDef = toolName && toolLookup ? toolLookup(toolName) : undefined;
            const meta: ToolEventMetadata | undefined = toolDef
              ? { tool: toolDef, ...(agentKey ? { agentKey } : {}) }
              : undefined;
            onToolEvent(
              "tool-result",
              JSON.stringify({ name: toolName, error: errorMessage }),
              toolName,
              meta,
            );

            if (scopesEnabled) {
              observability.emitScope({
                conversationId: message.conversationId,
                source: "agent",
                scopeType: "ExecuteTool",
                ...(toolName ? { toolName } : {}),
                ...(agentKey ? { agentKey } : {}),
                scope: {
                  phase: "error",
                  runId: runKey,
                  durationMs: typeof startedAt === "number" ? Math.max(0, Date.now() - startedAt) : undefined,
                  error: errorMessage,
                  timestamp: new Date().toISOString(),
                },
              });
            }
          },
        });
    const callbacks: BaseCallbackHandler[] = toolStartCallback
      ? [handler, toolStartCallback]
      : [handler];

    const safeSourceMetadata = (() => {
      if (!message.metadata) return {};
      const {
        personalToken: _omitPersonalToken,
        privilegeGrantId: _omitPrivilegeGrantId,
        contextOnly: _omitContextOnly,
        ...rest
      } = message.metadata;
      return rest;
    })();
    const runtimeContext = {
      ...safeSourceMetadata,
      sourceChannel: sourceChannel.name,
      sourceConversationId: message.conversationId,
      sourceMetadata: safeSourceMetadata,
      ...(typeof this.config.getContentUploadAuthByTool === "function"
        ? (() => {
            const byTool = this.config.getContentUploadAuthByTool(message.conversationId);
            return byTool && Object.keys(byTool).length > 0
              ? { contentUploadAuthByTool: byTool }
              : {};
          })()
        : {}),
    };

    const emitTurnComplete = (assistantText: string): void => {
      if (!assistantText.trim()) return;

      if (scopesEnabled) {
        observability.emitScope({
          conversationId: message.conversationId,
          source: "agent",
          scopeType: "InvokeAgent",
          scope: {
            scopeId: invokeScopeId,
            phase: "end",
            output: assistantText,
            completedAt: new Date().toISOString(),
          },
        });
      }

      const onTurnComplete = this.config.onTurnComplete;
      if (!onTurnComplete) return;
      void Promise.resolve(
        onTurnComplete({
          conversationId: message.conversationId,
          userText: message.text,
          assistantText,
          sourceChannel: sourceChannel.name,
          graphKey: this.config.graphInfo?.graphKey,
        }),
      ).catch((err: unknown) => {
        logger.error(
          `onTurnComplete callback failed for conversation "${message.conversationId}"`,
          err,
        );
      });
    };

    if (sourceChannel.supportsStreaming) {
      let fullText = "";
      const baseStream = this.stream(
        message.text,
        message.conversationId,
        callbacks,
        onToolEvent,
        (toolCallId, toolName) => {
          toolNameByCallId.set(toolCallId, toolName);
        },
        personalToken,
        privilegeGrantId,
        runtimeContext,
      );

      // Intercept the stream so we can buffer the complete response for observers
      // without re-invoking the model.
      async function* teedStream(): AsyncGenerator<OutgoingStreamChunk> {
        for await (const chunk of baseStream) {
          fullText += chunk.text;
          yield chunk;
        }
      }

      this.activeConversations.add(message.conversationId);
      try {
        await sourceChannel.sendStream(message.conversationId, teedStream());

        for (const ch of mirrorTargets) {
          await ch
            .sendMessage({ conversationId: message.conversationId, text: fullText, role: "agent" })
            .catch((e: unknown) => logger.error(`Failed to broadcast to channel "${ch.name}"`, e));
        }
        emitTurnComplete(fullText);
      } catch (err) {
        const detail = formatError(err);
        const canFallbackToInvoke = fullText.length === 0;
        if (!canFallbackToInvoke) {
          if (scopesEnabled) {
            observability.emitScope({
              conversationId: message.conversationId,
              source: "agent",
              scopeType: "InvokeAgent",
              scope: {
                scopeId: invokeScopeId,
                phase: "error",
                error: detail,
                timestamp: new Date().toISOString(),
              },
            });
          }
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
          runtimeContext,
        );

        await sourceChannel.sendMessage({
          conversationId: message.conversationId,
          text: fallbackResponse,
          role: "agent",
          ...(pendingToolContentItems ? { contentItems: pendingToolContentItems } : {}),
          ...(pendingToolReferences ? { references: pendingToolReferences } : {}),
        });

        for (const ch of mirrorTargets) {
          await ch
            .sendMessage({
              conversationId: message.conversationId,
              text: fallbackResponse,
              role: "agent",
              ...(pendingToolContentItems ? { contentItems: pendingToolContentItems } : {}),
              ...(pendingToolReferences ? { references: pendingToolReferences } : {}),
            })
            .catch((e: unknown) => logger.error(`Failed to broadcast fallback response to channel "${ch.name}"`, e));
        }
        emitTurnComplete(fallbackResponse);
      } finally {
        this.activeConversations.delete(message.conversationId);
        this.stoppedConversations.delete(message.conversationId);
      }
    } else {
      this.activeConversations.add(message.conversationId);
      try {
        const response = await this.invoke(
          message.text,
          message.conversationId,
          callbacks,
          personalToken,
          privilegeGrantId,
          runtimeContext,
        );
        await sourceChannel.sendMessage({
          conversationId: message.conversationId,
          text: response,
          ...(pendingToolContentItems ? { contentItems: pendingToolContentItems } : {}),
          ...(pendingToolReferences ? { references: pendingToolReferences } : {}),
        });

        for (const ch of mirrorTargets) {
          await ch
            .sendMessage({
              conversationId: message.conversationId,
              text: response,
              role: "agent",
              ...(pendingToolContentItems ? { contentItems: pendingToolContentItems } : {}),
              ...(pendingToolReferences ? { references: pendingToolReferences } : {}),
            })
            .catch((e: unknown) => logger.error(`Failed to broadcast to channel "${ch.name}"`, e));
        }
        emitTurnComplete(response);
      } catch (err) {
        if (scopesEnabled) {
          observability.emitScope({
            conversationId: message.conversationId,
            source: "agent",
            scopeType: "InvokeAgent",
            scope: {
              scopeId: invokeScopeId,
              phase: "error",
              error: formatError(err),
              timestamp: new Date().toISOString(),
            },
          });
        }
        throw err;
      } finally {
        this.activeConversations.delete(message.conversationId);
        this.stoppedConversations.delete(message.conversationId);
      }
    }
  }

}
