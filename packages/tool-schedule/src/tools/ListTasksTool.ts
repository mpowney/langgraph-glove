import type { ToolMetadata } from "@langgraph-glove/tool-server";
import type { ScheduleService } from "../ScheduleService";

export const listTasksToolMetadata: ToolMetadata = {
  name: "schedule_list_tasks",
  description:
    "List all scheduled tasks. Returns each task's id, name, type (user/agent/system), " +
    "cron expression, target agentKey, enabled status, and prompt. " +
    "Does not require privileged access.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

export function handleListTasks(service: ScheduleService) {
  return async (_params: Record<string, unknown>): Promise<unknown> => {
    const tasks = service.listTasks();
    return {
      paused: service.isPaused,
      count: tasks.length,
      tasks,
    };
  };
}
