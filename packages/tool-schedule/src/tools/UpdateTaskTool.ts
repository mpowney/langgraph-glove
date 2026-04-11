import type { ToolMetadata } from "@langgraph-glove/tool-server";
import type { ScheduleService, TaskType } from "../ScheduleService";

export const updateTaskToolMetadata: ToolMetadata = {
  name: "schedule_update_task",
  description:
    "Update an existing scheduled task by its id. Only the fields provided will be changed. " +
    "No privileged access is required to update tasks.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Task id to update.",
      },
      name: { type: "string", description: "New human-readable label." },
      type: {
        type: "string",
        enum: ["user", "agent", "system"],
        description: "New task type.",
      },
      scheduleType: {
        type: "string",
        enum: ["cron", "once"],
        description: "New schedule type.",
      },
      cron: { type: "string", description: "New cron expression." },
      runAt: {
        type: "string",
        description: "New once-off run timestamp (ISO datetime).",
      },
      agentKey: { type: "string", description: "New target agent key." },
      prompt: { type: "string", description: "New prompt." },
      enabled: { type: "boolean", description: "Enable or disable the task." },
      personalToken: {
        type: "string",
        description:
          "Updated personal token. Use '{SECRET:name}' references instead of raw values.",
      },
      conversationId: { type: "string", description: "New conversation ID." },
      sourceChannel: { type: "string", description: "Updated source channel key." },
      sourceConversationId: { type: "string", description: "Updated source conversation ID." },
      sourceMetadata: {
        type: "object",
        description: "Updated source metadata payload.",
        additionalProperties: true,
      },
      sendAgentReplyToSource: {
        type: "boolean",
        description: "Enable or disable sending task replies to source channel context.",
      },
      startConversation: {
        type: "boolean",
        description: "Enable or disable proactive starter message before execution.",
      },
      starterText: { type: "string", description: "Updated starter message text." },
    },
    required: ["id"],
  },
};

export function handleUpdateTask(service: ScheduleService) {
  return async (params: Record<string, unknown>): Promise<unknown> => {
    const id = asString(params, "id");
    if (!id) throw new Error("'id' is required");

    const updates: Parameters<typeof service.updateTask>[1] = {};

    if (typeof params["name"] === "string") updates.name = params["name"].trim();
    if (typeof params["type"] === "string") {
      const t = params["type"] as TaskType;
      if (!["user", "agent", "system"].includes(t)) {
        throw new Error("'type' must be one of: user, agent, system");
      }
      updates.type = t;
    }
    if (typeof params["scheduleType"] === "string") {
      const scheduleType = params["scheduleType"].trim();
      if (!["cron", "once"].includes(scheduleType)) {
        throw new Error("'scheduleType' must be one of: cron, once");
      }
      updates.scheduleType = scheduleType as "cron" | "once";
    }
    if (typeof params["cron"] === "string") updates.cron = params["cron"].trim();
    if (typeof params["runAt"] === "string") updates.runAt = params["runAt"].trim();
    if (typeof params["agentKey"] === "string") updates.agentKey = params["agentKey"].trim();
    if (typeof params["prompt"] === "string") updates.prompt = params["prompt"].trim();
    if (typeof params["enabled"] === "boolean") updates.enabled = params["enabled"];
    if (typeof params["personalToken"] === "string") {
      updates.personalToken = params["personalToken"].trim() || null;
    }
    if (typeof params["conversationId"] === "string") {
      updates.conversationId = params["conversationId"].trim();
    }

    const sourceChannel = typeof params["sourceChannel"] === "string" ? params["sourceChannel"].trim() : "";
    const sourceConversationId = typeof params["sourceConversationId"] === "string" ? params["sourceConversationId"].trim() : "";
    if (sourceChannel && sourceConversationId) {
      const sourceMetadata =
        typeof params["sourceMetadata"] === "object" && params["sourceMetadata"] !== null
          ? (params["sourceMetadata"] as Record<string, unknown>)
          : undefined;
      updates.sourceContext = {
        channel: sourceChannel,
        conversationId: sourceConversationId,
        ...(sourceMetadata ? { metadata: sourceMetadata } : {}),
      };
    }

    if (
      typeof params["sendAgentReplyToSource"] === "boolean"
      || typeof params["startConversation"] === "boolean"
      || typeof params["starterText"] === "string"
    ) {
      updates.delivery = {
        ...(typeof params["sendAgentReplyToSource"] === "boolean"
          ? { sendAgentReplyToSource: params["sendAgentReplyToSource"] }
          : {}),
        ...(typeof params["startConversation"] === "boolean"
          ? { startConversation: params["startConversation"] }
          : {}),
        ...(typeof params["starterText"] === "string"
          ? { starterText: params["starterText"].trim() }
          : {}),
      };
    }

    const task = await service.updateTask(id, updates);
    return { success: true, task };
  };
}

function asString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v.trim() : "";
}
