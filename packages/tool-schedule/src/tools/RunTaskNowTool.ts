import type { ToolMetadata } from "@langgraph-glove/tool-server";
import type { ScheduleService } from "../ScheduleService";

export const runTaskNowToolMetadata: ToolMetadata = {
  name: "schedule_run_task_now",
  description:
    "Immediately execute a scheduled task by its id, without waiting for its next " +
    "scheduled time. Returns the agent's response. " +
    "No privileged access is required.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Id of the task to run immediately.",
      },
    },
    required: ["id"],
  },
};

export function handleRunTaskNow(service: ScheduleService) {
  return async (params: Record<string, unknown>): Promise<unknown> => {
    const id = typeof params["id"] === "string" ? params["id"].trim() : "";
    if (!id) throw new Error("'id' is required");
    const result = await service.runTaskNow(id);
    return { success: true, result };
  };
}
