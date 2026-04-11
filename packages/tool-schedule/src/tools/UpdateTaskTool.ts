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
      cron: { type: "string", description: "New cron expression." },
      agentKey: { type: "string", description: "New target agent key." },
      prompt: { type: "string", description: "New prompt." },
      enabled: { type: "boolean", description: "Enable or disable the task." },
      personalToken: {
        type: "string",
        description:
          "Updated personal token. Use '{SECRET:name}' references instead of raw values.",
      },
      conversationId: { type: "string", description: "New conversation ID." },
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
    if (typeof params["cron"] === "string") updates.cron = params["cron"].trim();
    if (typeof params["agentKey"] === "string") updates.agentKey = params["agentKey"].trim();
    if (typeof params["prompt"] === "string") updates.prompt = params["prompt"].trim();
    if (typeof params["enabled"] === "boolean") updates.enabled = params["enabled"];
    if (typeof params["personalToken"] === "string") {
      updates.personalToken = params["personalToken"].trim() || null;
    }
    if (typeof params["conversationId"] === "string") {
      updates.conversationId = params["conversationId"].trim();
    }

    const task = await service.updateTask(id, updates);
    return { success: true, task };
  };
}

function asString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v.trim() : "";
}
