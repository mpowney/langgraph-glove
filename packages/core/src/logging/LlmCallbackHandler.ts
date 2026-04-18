import { createHash } from "node:crypto";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { Logger } from "./Logger";

const logger = new Logger("LlmCallbackHandler.ts");

/**
 * A LangChain callback handler that emits every prompt sent to a chat model
 * to the {@link LogService} at {@link LogLevel.VERBOSE}.
 *
 * Register it once as a callback in the LangGraph run config and it will be
 * propagated automatically to every nested model call in the graph.
 *
 * @example
 * ```ts
 * import { LlmCallbackHandler } from "@langgraph-glove/core";
 *
 * // Subscribe a verbose console subscriber so prompts are visible:
 * LogService.subscribe(new ConsoleSubscriber(LogLevel.VERBOSE));
 * ```
 * Prompt logging is handled automatically by `GloveAgent` — the callback is
 * added to every `graph.invoke()` / `graph.stream()` call.
 */
export class LlmCallbackHandler extends BaseCallbackHandler {
  name = "LlmCallbackHandler";
  private readonly modelNameByRunId = new Map<string, string>();
  private readonly batchTotalByRunId = new Map<string, number>();
  private readonly usageContextByRunBatch = new Map<string, PromptUsageCallbackResult>();

  constructor(
    private readonly onPrompt?: (formatted: string) => void,
    private readonly onModelCall?: (payload: Record<string, unknown>) => void,
    private readonly onModelResponse?: (payload: Record<string, unknown>) => void,
    private readonly context?: LlmCallbackContext,
  ) {
    super();
  }

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId?: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    const modelName =
      (llm as { id?: string[] }).id?.at(-1) ??
      (llm as { name?: string }).name ??
      "unknown";

    if (typeof runId === "string") {
      this.modelNameByRunId.set(runId, modelName);
      this.batchTotalByRunId.set(runId, messages.length);
    }

    messages.forEach((batch, batchIndex) => {
      const prefix =
        messages.length > 1 ? `[batch ${batchIndex + 1}/${messages.length}] ` : "";

      const formatted = batch
        .map((msg) => {
          const role = roleLabel(msg.type);
          let body = extractContent(msg.content);
          if (!body && msg instanceof AIMessage && msg.tool_calls?.length) {
          body = msg.tool_calls
              .map((tc) => `[tool_call: ${tc.name}(${JSON.stringify(tc.args)})]`)
              .join(", ");
          }
          return `  ${role}: ${body || "(empty)"}`;
        })
        .join("\n");

      const text = `Prompt to ${modelName} ${prefix}—\n${formatted}`;
      logger.verbose(text);
      this.onPrompt?.(text);

      const promptResolved = extractSystemPrompt(batch);
      const promptResolvedHash = promptResolved ? computePromptHash(promptResolved) : undefined;
      const batchNumber = batchIndex + 1;
      const usageContext = this.context?.onPromptUsage?.({
        conversationId: this.context?.conversationId,
        runId,
        batchIndex: batchNumber,
        modelName,
        modelKey: this.context?.modelKey,
        promptResolved,
        promptResolvedHash,
      }) ?? {
        modelKey: this.context?.modelKey,
        promptResolved,
        promptResolvedHash,
      };

      if (typeof runId === "string") {
        this.usageContextByRunBatch.set(runBatchKey(runId, batchNumber), usageContext);
      }

      this.onModelCall?.({
        runId,
        conversationId: this.context?.conversationId,
        agentKey: this.context?.agentKey,
        model: modelName,
        modelKey: usageContext.modelKey ?? this.context?.modelKey,
        promptUsageId: usageContext.usageId,
        promptOriginal: usageContext.promptOriginal,
        promptOriginalHash: usageContext.promptOriginalHash,
        promptResolved: usageContext.promptResolved ?? promptResolved,
        promptResolvedHash: usageContext.promptResolvedHash ?? promptResolvedHash,
        batch: {
          index: batchNumber,
          total: messages.length,
        },
        invocation: redactSensitiveValue(extraParams ?? {}),
      });
    });
  }

  handleLLMEnd(
    output: LLMResult,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    extraParams?: Record<string, unknown>,
  ): void {
    if (!this.onModelResponse) {
      this.cleanupRun(runId);
      return;
    }

    const modelName = this.modelNameByRunId.get(runId) ?? "unknown";
    const outputBatches = Array.isArray(output.generations) ? output.generations.length : 0;
    const totalBatches = this.batchTotalByRunId.get(runId) ?? Math.max(outputBatches, 1);
    const usageContext = this.usageContextByRunBatch.get(runBatchKey(runId, 1));

    this.onModelResponse({
      runId,
      conversationId: this.context?.conversationId,
      agentKey: this.context?.agentKey,
      model: modelName,
      modelKey: usageContext?.modelKey ?? this.context?.modelKey,
      promptUsageId: usageContext?.usageId,
      promptOriginal: usageContext?.promptOriginal,
      promptOriginalHash: usageContext?.promptOriginalHash,
      promptResolved: usageContext?.promptResolved,
      promptResolvedHash: usageContext?.promptResolvedHash,
      batch: {
        index: 1,
        total: totalBatches,
      },
      invocation: redactSensitiveValue(extraParams ?? {}),
      response: redactSensitiveValue(output),
    });

    this.cleanupRun(runId);
  }

  handleLLMError(err: unknown, runId: string): void {
    this.cleanupRun(runId);
    logger.warn(`Model run failed before completion: ${String(err)}`);
  }

  private cleanupRun(runId: string): void {
    this.modelNameByRunId.delete(runId);
    this.batchTotalByRunId.delete(runId);
    for (const key of this.usageContextByRunBatch.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.usageContextByRunBatch.delete(key);
      }
    }
  }
}

export interface PromptUsageCallbackInput {
  conversationId?: string;
  runId?: string;
  batchIndex: number;
  modelName: string;
  modelKey?: string;
  promptResolved?: string;
  promptResolvedHash?: string;
}

export interface PromptUsageCallbackResult {
  usageId?: string;
  modelKey?: string;
  promptOriginal?: string;
  promptOriginalHash?: string;
  promptResolved?: string;
  promptResolvedHash?: string;
}

export interface LlmCallbackContext {
  conversationId?: string;
  agentKey?: string;
  modelKey?: string;
  onPromptUsage?: (input: PromptUsageCallbackInput) => PromptUsageCallbackResult | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roleLabel(type: string): string {
  switch (type) {
    case "human":
      return "[Human]  ";
    case "ai":
      return "[AI]     ";
    case "system":
      return "[System] ";
    case "tool":
      return "[Tool]   ";
    case "function":
      return "[Func]   ";
    default:
      return `[${type}]`.padEnd(9);
  }
}

type MessageContent = string | Array<{ type: string; text?: string; [key: string]: unknown }>;

function extractContent(content: MessageContent): string {
  if (typeof content === "string") return content;

  // Content block arrays (vision models, etc.)
  const parts = content.map((block) => {
    if (typeof block === "string") return block;
    if (block.type === "text" && typeof block.text === "string") return block.text;
    return `[${block.type}]`;
  });
  return parts.join(" ");
}

function extractSystemPrompt(batch: BaseMessage[]): string | undefined {
  const systemMessage = batch.find((msg) => msg.type === "system");
  if (!systemMessage) return undefined;
  const text = extractContent(systemMessage.content as MessageContent).trim();
  return text || undefined;
}

function runBatchKey(runId: string, batchIndex: number): string {
  return `${runId}:${batchIndex}`;
}

function computePromptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_RE = /(?:api[_-]?key|token|authorization|cookie|password|secret|bearer|session)/i;

function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactSensitiveValue(child);
    }
    return out;
  }

  return value;
}
