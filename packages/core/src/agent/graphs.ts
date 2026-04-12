import {
  HumanMessage,
  SystemMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { randomUUID } from "node:crypto";
import {
  StateGraph,
  MessagesAnnotation,
  Command,
  END,
  START,
  MemorySaver,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { storeToolPayload } from "./toolPayloadCache";

// ---------------------------------------------------------------------------
// Single-agent ReAct graph
// ---------------------------------------------------------------------------

export interface SingleAgentGraphConfig {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  systemPrompt?: string;
  /** Pass a checkpointer for standalone use. Omit when the graph will be used as a subgraph. */
  checkpointer?: BaseCheckpointSaver;
}

interface ParsedTextToolCall {
  name: string;
  args: Record<string, unknown>;
}

const TOOL_ERROR_MARKERS = [
  "error",
  "failed",
  "exception",
  "invalid",
  "timed out",
  "timeout",
  "unavailable",
  "connection refused",
];

const TOOL_MESSAGE_SUMMARY_CHAR_LIMIT = Number.parseInt(
  process.env.GLOVE_TOOL_MESSAGE_SUMMARY_CHAR_LIMIT ?? "12000",
  10,
);
const TOOL_MESSAGE_SUMMARY_PREVIEW_CHAR_LIMIT = Number.parseInt(
  process.env.GLOVE_TOOL_MESSAGE_SUMMARY_PREVIEW_CHAR_LIMIT ?? "1200",
  10,
);

function summarizeOversizedToolMessage(message: ToolMessage): ToolMessage {
  const text = messageText(message.content);
  if (!text || text.length <= TOOL_MESSAGE_SUMMARY_CHAR_LIMIT) {
    return message;
  }

  const ref = storeToolPayload(text);

  const preview = text.slice(0, TOOL_MESSAGE_SUMMARY_PREVIEW_CHAR_LIMIT);
  const summary = [
    "[tool output summarized for context window efficiency]",
    `payloadRef=${ref}`,
    `originalChars=${text.length}`,
    `previewChars=${preview.length}`,
    "preview:",
    preview,
  ].join("\n");

  const typed = message as ToolMessage & {
    tool_call_id?: string;
    name?: string;
  };

  return new ToolMessage({
    content: summary,
    tool_call_id: typed.tool_call_id,
    name: typed.name,
  });
}

function summarizeMessagesForModel(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (message instanceof ToolMessage) {
      return summarizeOversizedToolMessage(message);
    }
    return message;
  });
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === "string") {
    const text = stripCodeFence(args);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON; keep raw string under a conventional key.
    }
    return { input: args };
  }
  return { input: args };
}

interface ToolExecutionContext {
  conversationId?: string;
  privilegeGrantId?: string;
}

interface ToolCallLike {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

function readToolExecutionContext(config: unknown): ToolExecutionContext {
  if (!config || typeof config !== "object") return {};
  const configurable = (config as { configurable?: unknown }).configurable;
  if (!configurable || typeof configurable !== "object") return {};

  const typed = configurable as Record<string, unknown>;
  const explicitConversationId =
    typeof typed.conversationId === "string" ? typed.conversationId : undefined;
  const threadId = typeof typed.thread_id === "string" ? typed.thread_id : undefined;
  const conversationId = explicitConversationId ?? (threadId === "runtime" ? undefined : threadId);
  const privilegeGrantId =
    typeof typed.privilegeGrantId === "string" ? typed.privilegeGrantId : undefined;

  return { conversationId, privilegeGrantId };
}

function toolRequiresPrivilegedAccess(tool: StructuredToolInterface): boolean {
  if (!("requiresPrivilegedAccess" in tool)) return false;
  return (tool as { requiresPrivilegedAccess?: unknown }).requiresPrivilegedAccess === true;
}

function injectToolContextArgs(
  toolCall: ToolCallLike,
  toolsByName: Map<string, StructuredToolInterface>,
  context: ToolExecutionContext,
): ToolCallLike {
  const tool = toolsByName.get(toolCall.name);
  if (!tool) return toolCall;

  const args = { ...toolCall.args };

  if (
    toolRequiresPrivilegedAccess(tool) &&
    !args.conversationId &&
    context.conversationId
  ) {
    args.conversationId = context.conversationId;
  }

  if (
    toolRequiresPrivilegedAccess(tool) &&
    !args.privilegeGrantId &&
    context.privilegeGrantId
  ) {
    args.privilegeGrantId = context.privilegeGrantId;
  }

  return { ...toolCall, args };
}

function extractTextToolCall(
  content: unknown,
  allowedToolNames: Set<string>,
): ParsedTextToolCall | null {
  if (typeof content !== "string") return null;
  const text = stripCodeFence(content);

  try {
    const parsed = JSON.parse(text) as {
      name?: unknown;
      args?: unknown;
      arguments?: unknown;
      parameters?: unknown;
    };
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name || !allowedToolNames.has(name)) return null;

    return {
      name,
      args: normalizeToolArgs(parsed.args ?? parsed.arguments ?? parsed.parameters),
    };
  } catch {
    return null;
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function normalizeErrorMessage(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\b(call|id|run|request|tool)_?[a-z0-9_-]*\b/g, "")
    .trim();
}

function isToolErrorMessage(message: BaseMessage): message is ToolMessage {
  if (!(message instanceof ToolMessage)) return false;
  const text = messageText(message.content).toLowerCase();
  if (!text) return false;
  return TOOL_ERROR_MARKERS.some((marker) => text.includes(marker));
}

function hasRepeatedRecentToolFailure(messages: BaseMessage[]): boolean {
  const last = messages.at(-1);
  if (!last || !isToolErrorMessage(last)) return false;

  const normalizedLast = normalizeErrorMessage(messageText(last.content));
  let recentErrors = 1;

  // Look back over the most recent turns for another matching failure.
  for (let i = messages.length - 2; i >= 0 && i >= messages.length - 10; i -= 1) {
    const candidate = messages[i];
    if (!isToolErrorMessage(candidate)) continue;

    recentErrors += 1;
    const normalizedCandidate = normalizeErrorMessage(messageText(candidate.content));
    if (normalizedCandidate && normalizedCandidate === normalizedLast) {
      return true;
    }
  }

  return recentErrors >= 3;
}

function buildToolFailureResponse(messages: BaseMessage[]): AIMessage {
  const last = messages.at(-1);
  const detail =
    last instanceof ToolMessage
      ? messageText(last.content).trim().slice(0, 280)
      : "";

  const content = detail
    ? `I stopped retrying because tool calls are repeatedly failing. Last error: ${detail}`
    : "I stopped retrying because tool calls are repeatedly failing. Please verify the tool input or tool availability and try again.";

  return new AIMessage({ content });
}

/**
 * Build a standard ReAct agent graph: agent → tools → agent → … → END.
 *
 * When used standalone, pass a `checkpointer` for persistence.
 * When used as a sub-agent inside an orchestrator, omit the checkpointer —
 * the parent graph handles persistence.
 */
export function buildSingleAgentGraph(config: SingleAgentGraphConfig) {
  const { model, tools, systemPrompt, checkpointer } = config;

  if (!model.bindTools) {
    throw new Error(
      "buildSingleAgentGraph requires a chat model that supports tool calling (bindTools).",
    );
  }

  const toolNode = new ToolNode(tools);
  const modelWithTools = model.bindTools(tools);
  const toolNames = new Set(tools.map((t) => t.name));
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  const callAgent = async (
    state: typeof MessagesAnnotation.State,
    config?: unknown,
  ) => {
    const toolExecutionContext = readToolExecutionContext(config);
    const rawMessages: BaseMessage[] = systemPrompt
      ? [new SystemMessage(systemPrompt), ...state.messages]
      : [...state.messages];
    const messages = summarizeMessagesForModel(rawMessages);
    const response = await modelWithTools.invoke(messages);

    // Some local models emit JSON tool intents as plain text instead of native
    // tool_call metadata (e.g. {"name":"memory_create","arguments":{...}}).
    // Recover those intents so the ReAct loop can execute the tool.
    if (!response.tool_calls?.length) {
      const textToolCall = extractTextToolCall(response.content, toolNames);
      if (textToolCall) {
        (response as AIMessage & {
          tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
        }).tool_calls = [
          {
            id: `text_tool_${randomUUID()}`,
            name: textToolCall.name,
            args: textToolCall.args,
          },
        ];
      }
    }

    if (response.tool_calls?.length) {
      response.tool_calls = response.tool_calls.map((toolCall) =>
        injectToolContextArgs(
          {
            id: toolCall.id,
            name: toolCall.name,
            args: normalizeToolArgs(toolCall.args),
          },
          toolsByName,
          toolExecutionContext,
        ),
      );
    }

    return { messages: [response] };
  };

  const routeAfterAgent = (
    state: typeof MessagesAnnotation.State,
  ): "tools" | typeof END => {
    const last = state.messages.at(-1) as AIMessage;
    return last.tool_calls?.length ? "tools" : END;
  };

  const toolFailureStopNode = async (state: typeof MessagesAnnotation.State) => {
    return { messages: [buildToolFailureResponse(state.messages)] };
  };

  const routeAfterTools = (
    state: typeof MessagesAnnotation.State,
  ): "agent" | "tool_failure_stop" => {
    return hasRepeatedRecentToolFailure(state.messages) ? "tool_failure_stop" : "agent";
  };

  return new StateGraph(MessagesAnnotation)
    .addNode("agent", callAgent)
    .addNode("tools", toolNode)
    .addNode("tool_failure_stop", toolFailureStopNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent)
    .addConditionalEdges("tools", routeAfterTools)
    .addEdge("tool_failure_stop", END)
    .compile({ checkpointer });
}

// ---------------------------------------------------------------------------
// Multi-agent orchestrator graph
// ---------------------------------------------------------------------------

export interface SubAgentDef {
  /** Unique name for this sub-agent (used as graph node name). */
  name: string;
  /** Human-readable description — the orchestrator uses this to decide when to delegate. */
  description: string;
  model: BaseChatModel;
  /** Tools available to this sub-agent. */
  tools: StructuredToolInterface[];
  systemPrompt?: string;
  /** Maximum LangGraph recursion limit for this sub-agent invocation. */
  recursionLimit?: number;
}

export interface OrchestratorGraphConfig {
  orchestrator: {
    model: BaseChatModel;
    systemPrompt?: string;
    /** Orchestrator's own tools (in addition to auto-generated handoff tools). */
    tools?: StructuredToolInterface[];
  };
  subAgents: SubAgentDef[];
  checkpointer?: BaseCheckpointSaver;
}

interface ParsedHandoff {
  targetAgent: string;
  request: string;
}

function parseHandoffRequest(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const request = (args as { request?: unknown }).request;
  if (typeof request === "string") return request.trim();
  if (request && typeof request === "object") {
    const value = (request as { value?: unknown }).value;
    if (typeof value === "string") return value.trim();
  }
  return "";
}

function extractTextHandoff(content: unknown): ParsedHandoff | null {
  if (typeof content !== "string") return null;
  const text = content.trim();
  if (!text.includes("transfer_to_")) return null;

  try {
    const parsed = JSON.parse(text) as { name?: string; args?: unknown; parameters?: unknown };
    if (!parsed.name?.startsWith("transfer_to_")) return null;
    const targetAgent = parsed.name.replace(/^transfer_to_/, "");
    const request = parseHandoffRequest(parsed.args) || parseHandoffRequest(parsed.parameters);
    return { targetAgent, request };
  } catch {
    // Some local models emit near-JSON fragments; recover with regex.
    const nameMatch = text.match(/"name"\s*:\s*"(transfer_to_[^"]+)"/);
    if (!nameMatch) return null;
    const targetAgent = nameMatch[1].replace(/^transfer_to_/, "");

    const stringRequestMatch = text.match(/"request"\s*:\s*"([^"]+)"/);
    if (stringRequestMatch) {
      return { targetAgent, request: stringRequestMatch[1].trim() };
    }

    const valueRequestMatch = text.match(/"request"\s*:\s*\{[^}]*"value"\s*:\s*"([^"]+)"/);
    return { targetAgent, request: valueRequestMatch?.[1]?.trim() ?? "" };
  }
}

/**
 * Build a multi-agent orchestrator graph.
 *
 * Structure:
 * ```
 * START → orchestrator ──→ sub-agent-A → orchestrator
 *                      ├─→ sub-agent-B → orchestrator
 *                      ├─→ orchestrator_tools → orchestrator
 *                      └─→ END
 * ```
 *
 * The orchestrator model receives auto-generated `transfer_to_<name>` tools
 * for each sub-agent. When it calls one of these, the graph routes to that
 * sub-agent's ReAct loop. When the sub-agent finishes, control returns to
 * the orchestrator, which can delegate again or respond directly.
 */
export function buildOrchestratorGraph(config: OrchestratorGraphConfig) {
  const { orchestrator, subAgents, checkpointer } = config;

  if (!orchestrator.model.bindTools) {
    throw new Error(
      "buildOrchestratorGraph requires a chat model that supports tool calling (bindTools).",
    );
  }

  // -- Create handoff tools (one per sub-agent) -----------------------------
  const handoffTools = subAgents.map((sa) =>
    tool(
      async () => `Transferred to ${sa.name}.`,
      {
        name: `transfer_to_${sa.name}`,
        description: `Hand off the conversation to the "${sa.name}" agent. ${sa.description}`,
        schema: z.object({
          request: z.string().describe("A summary of what you need this agent to do"),
        }),
      },
    ),
  );

  const handoffToolNames: Set<string> = new Set(handoffTools.map((t) => t.name));
  const allOrchestratorTools = [
    ...(orchestrator.tools ?? []),
    ...handoffTools,
  ];
  const orchestratorModelWithTools =
    orchestrator.model.bindTools(allOrchestratorTools);

  // -- Build sub-agent subgraphs (no checkpointer — parent handles it) ------
  const subAgentGraphs = new Map<string, ReturnType<typeof buildSingleAgentGraph>>();
  for (const sa of subAgents) {
    if (!sa.model.bindTools) {
      throw new Error(
        `Sub-agent "${sa.name}" requires a chat model that supports tool calling.`,
      );
    }
    subAgentGraphs.set(
      sa.name,
      buildSingleAgentGraph({
        model: sa.model,
        tools: sa.tools,
        systemPrompt: sa.systemPrompt,
        // No checkpointer — parent graph owns persistence
      }),
    );
  }

  // -- Orchestrator node ----------------------------------------------------
  const orchestratorNode = async (state: typeof MessagesAnnotation.State) => {
    const rawMessages: BaseMessage[] = orchestrator.systemPrompt
      ? [new SystemMessage(orchestrator.systemPrompt), ...state.messages]
      : [...state.messages];
    const messages = summarizeMessagesForModel(rawMessages);

    const response = await orchestratorModelWithTools.invoke(messages);

    // Check for handoff tool calls
    if (response.tool_calls?.length) {
      const handoffCall = response.tool_calls.find((tc: { name: string }) =>
        handoffToolNames.has(tc.name),
      );
      if (handoffCall) {
        const targetAgent = handoffCall.name.replace(/^transfer_to_/, "");
        // Respond to the handoff tool call so the conversation stays valid,
        // then route to the sub-agent via Command.
        const toolResponse = new ToolMessage({
          content: (() => {
            const req =
              typeof handoffCall.args?.request === "string" ? handoffCall.args.request.trim() : "";
            return req
              ? `Transferring to ${targetAgent} agent. Task: ${req}`
              : `Transferring to ${targetAgent} agent.`;
          })(),
          tool_call_id: handoffCall.id!,
        });

        return new Command({
          goto: targetAgent as never,
          update: { messages: [response, toolResponse] },
        });
      }
    }

    // Fallback: some local models emit transfer JSON as plain text instead of
    // native tool calls. Detect and treat it as a handoff anyway.
    const textHandoff = extractTextHandoff(response.content);
    if (textHandoff) {
      const toolResponse = new ToolMessage({
        content: textHandoff.request
          ? `Transferring to ${textHandoff.targetAgent} agent. Task: ${textHandoff.request}`
          : `Transferring to ${textHandoff.targetAgent} agent.`,
        tool_call_id: "text_handoff_fallback",
      });
      return new Command({
        goto: textHandoff.targetAgent as never,
        update: { messages: [response, toolResponse] },
      });
    }

    // No handoff — either regular tool calls or final answer
    return { messages: [response] };
  };

  // -- Routing after orchestrator (only fires for non-Command returns) ------
  const hasOrchestratorTools = (orchestrator.tools?.length ?? 0) > 0;

  const routeAfterOrchestrator = (
    state: typeof MessagesAnnotation.State,
  ): string => {
    const last = state.messages.at(-1) as AIMessage;
    if (last.tool_calls?.length && hasOrchestratorTools) {
      return "orchestrator_tools";
    }
    return END;
  };

  // -- Assemble the graph ---------------------------------------------------
  // LangGraph's TypeScript types track node names at compile time, but our
  // node set is dynamic (sub-agents come from config), so we use `any` for
  // the builder chain.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let graph: any = new StateGraph(MessagesAnnotation);

  graph = graph.addNode("orchestrator", orchestratorNode, {
    ends: [...subAgentGraphs.keys()],
  });

  // Orchestrator's own tool node (optional)
  if (hasOrchestratorTools) {
    graph = graph.addNode("orchestrator_tools", new ToolNode(orchestrator.tools!));
    graph = graph.addConditionalEdges("orchestrator", routeAfterOrchestrator);
    graph = graph.addEdge("orchestrator_tools", "orchestrator");
  } else {
    graph = graph.addConditionalEdges("orchestrator", routeAfterOrchestrator);
  }

  // Sub-agent subgraph nodes
  for (const [name, subGraph] of subAgentGraphs) {
    const subAgentDef = subAgents.find((sa) => sa.name === name);

    graph = graph.addNode(
      name,
      async (state: typeof MessagesAnnotation.State, runtimeConfig?: unknown) => {
        const invokeConfig =
          runtimeConfig && typeof runtimeConfig === "object"
            ? { ...(runtimeConfig as Record<string, unknown>) }
            : {};

        if (subAgentDef?.recursionLimit !== undefined) {
          invokeConfig.recursionLimit = subAgentDef.recursionLimit;
        }

        return subGraph.invoke(state, invokeConfig);
      },
    );
    graph = graph.addEdge(name, "orchestrator");
  }

  graph = graph.addEdge(START, "orchestrator");

  return graph.compile({ checkpointer: checkpointer ?? new MemorySaver() });
}
