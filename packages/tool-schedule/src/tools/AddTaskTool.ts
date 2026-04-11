import type { ToolMetadata } from "@langgraph-glove/tool-server";
import type { ScheduleService, TaskType } from "../ScheduleService";

export const addTaskToolMetadata: ToolMetadata = {
  name: "schedule_add_task",
  description:
    "Add a new scheduled task. The task will run according to the given cron expression " +
    "and send the specified prompt to the named agent. " +
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
          "Example: '0 3 * * *' runs at 03:00 every day.",
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
    },
    required: ["name", "type", "cron", "prompt"],
  },
};

export function handleAddTask(service: ScheduleService) {
  return async (params: Record<string, unknown>): Promise<unknown> => {
    const name = asString(params, "name");
    const type = asString(params, "type") as TaskType;
    const cronExpr = asString(params, "cron");
    const prompt = asString(params, "prompt");

    if (!name) throw new Error("'name' is required");
    if (!["user", "agent", "system"].includes(type)) {
      throw new Error("'type' must be one of: user, agent, system");
    }
    if (!cronExpr) throw new Error("'cron' is required");
    if (!prompt) throw new Error("'prompt' is required");

    const task = await service.addTask({
      name,
      type,
      cron: cronExpr,
      prompt,
      agentKey: asStringOrUndefined(params, "agentKey"),
      enabled: typeof params["enabled"] === "boolean" ? params["enabled"] : true,
      personalToken: asStringOrUndefined(params, "personalToken") ?? null,
      conversationId: asStringOrUndefined(params, "conversationId"),
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
