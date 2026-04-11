import type { ToolMetadata } from "@langgraph-glove/tool-server";
import type { ScheduleService, TaskType, ScheduleType } from "../ScheduleService";

export const addTaskToolMetadata: ToolMetadata = {
  name: "schedule_add_task",
  description:
    "Add a new scheduled task. Supports recurring cron tasks and once-off minute-level tasks. " +
    "The task prompt is sent through the schedule graph when it runs. " +
    "No privileged access is required to add tasks.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Human-readable label for the task.",
      },
      type: {
        type: "string",
        enum: ["user", "agent", "system"],
        description:
          "Task origin: 'user' for explicit user requests (supports personalToken), " +
          "'agent' for AI-inferred tasks, 'system' for maintenance tasks.",
      },
      cron: {
        type: "string",
        description:
          "Standard 5-field cron expression (minute hour day-of-month month day-of-week). " +
          "Required when scheduleType='cron'. Example: '0 3 * * *' runs at 03:00 every day.",
      },
      scheduleType: {
        type: "string",
        enum: ["cron", "once"],
        description: "Schedule mode. Defaults to 'cron' for backwards compatibility.",
      },
      runAt: {
        type: "string",
        description:
          "ISO datetime for once-off execution (nearest minute). " +
          "Required when scheduleType='once'.",
      },
      agentKey: {
        type: "string",
        description:
          "Key of the agent to invoke (e.g. 'memory', 'researcher', 'default'). " +
          "Defaults to 'default' when omitted.",
      },
      prompt: {
        type: "string",
        description: "Prompt sent to the agent when the task fires.",
      },
      enabled: {
        type: "boolean",
        description: "Whether the task is active. Defaults to true.",
      },
      personalToken: {
        type: "string",
        description:
          "Optional personal token for 'user' tasks that need to access encrypted personal " +
          "memories. Use a '{SECRET:name}' reference rather than a raw token value.",
      },
      conversationId: {
        type: "string",
        description:
          "Stable conversation ID used when invoking the agent. Auto-generated if omitted.",
      },
      sourceChannel: {
        type: "string",
        description:
          "Origin channel key (for example 'web' or 'bluebubbles') used to continue interaction in the same channel.",
      },
      sourceConversationId: {
        type: "string",
        description:
          "Origin channel conversation ID where follow-up scheduled responses should be delivered.",
      },
      sourceMetadata: {
        type: "object",
        description:
          "Optional source channel metadata captured at scheduling time (for example BlueBubbles chatGuid).",
        additionalProperties: true,
      },
      sendAgentReplyToSource: {
        type: "boolean",
        description:
          "When true (default), send scheduled execution responses back to the source channel context.",
      },
      startConversation: {
        type: "boolean",
        description:
          "When true, send starterText before the scheduled task prompt is executed.",
      },
      starterText: {
        type: "string",
        description:
          "Optional proactive message sent first when startConversation=true.",
      },
    },
    required: ["name", "type", "prompt"],
  },
};

export function handleAddTask(service: ScheduleService) {
  return async (params: Record<string, unknown>): Promise<unknown> => {
    const name = asString(params, "name");
    const type = asString(params, "type") as TaskType;
    const scheduleType = (asString(params, "scheduleType") || "cron") as ScheduleType;
    const cronExpr = asString(params, "cron");
    const runAt = asStringOrUndefined(params, "runAt");
    const prompt = asString(params, "prompt");

    if (!name) throw new Error("'name' is required");
    if (!["user", "agent", "system"].includes(type)) {
      throw new Error("'type' must be one of: user, agent, system");
    }
    if (!["cron", "once"].includes(scheduleType)) {
      throw new Error("'scheduleType' must be one of: cron, once");
    }
    if (scheduleType === "cron" && !cronExpr) {
      throw new Error("'cron' is required when scheduleType is 'cron'");
    }
    if (scheduleType === "once" && !runAt) {
      throw new Error("'runAt' is required when scheduleType is 'once'");
    }
    if (!prompt) throw new Error("'prompt' is required");

    const task = await service.addTask({
      name,
      type,
      scheduleType,
      ...(cronExpr ? { cron: cronExpr } : {}),
      ...(runAt ? { runAt } : {}),
      prompt,
      agentKey: asStringOrUndefined(params, "agentKey"),
      enabled: typeof params["enabled"] === "boolean" ? params["enabled"] : true,
      personalToken: asStringOrUndefined(params, "personalToken") ?? null,
      conversationId: asStringOrUndefined(params, "conversationId"),
      sourceContext: buildSourceContext(params),
      delivery: {
        sendAgentReplyToSource:
          typeof params["sendAgentReplyToSource"] === "boolean"
            ? params["sendAgentReplyToSource"]
            : undefined,
        startConversation:
          typeof params["startConversation"] === "boolean"
            ? params["startConversation"]
            : undefined,
        starterText: asStringOrUndefined(params, "starterText"),
      },
    });

    return { success: true, task };
  };
}

function asString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v.trim() : "";
}

function asStringOrUndefined(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function buildSourceContext(params: Record<string, unknown>) {
  const sourceChannel = asStringOrUndefined(params, "sourceChannel");
  const sourceConversationId = asStringOrUndefined(params, "sourceConversationId");
  if (!sourceChannel || !sourceConversationId) return undefined;

  const sourceMetadata =
    typeof params["sourceMetadata"] === "object" && params["sourceMetadata"] !== null
      ? (params["sourceMetadata"] as Record<string, unknown>)
      : undefined;

  return {
    channel: sourceChannel,
    conversationId: sourceConversationId,
    ...(sourceMetadata ? { metadata: sourceMetadata } : {}),
  };
}
