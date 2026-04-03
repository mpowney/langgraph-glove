import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
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

  /**
   * @param onPrompt  Optional callback invoked with the formatted prompt text
   *                  for each model call.  Useful for forwarding prompts to
   *                  observer channels in addition to the log.
   */
  constructor(private readonly onPrompt?: (formatted: string) => void) {
    super();
  }

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
  ): void {
    const modelName =
      (llm as { id?: string[] }).id?.at(-1) ??
      (llm as { name?: string }).name ??
      "unknown";

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
    });
  }
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
