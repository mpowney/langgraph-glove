import { validatePrivilegeGrant, type ToolMetadata } from "@langgraph-glove/tool-server";
import type { ScheduleService } from "../ScheduleService";

export const removeTaskToolMetadata: ToolMetadata = {
  name: "schedule_remove_task",
  requiresPrivilegedAccess: true,
  description:
    "Remove a scheduled task by its id. " +
    "Requires privileged access. Privileged context is injected automatically by runtime when enabled.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Id of the task to remove.",
      },
    },
    required: ["id"],
  },
};

export function handleRemoveTask(service: ScheduleService, adminApiUrl: string) {
  return async (params: Record<string, unknown>): Promise<unknown> => {
    await validatePrivilegeGrant(params, adminApiUrl);
    const id = typeof params["id"] === "string" ? params["id"].trim() : "";
    if (!id) throw new Error("'id' is required");
    await service.removeTask(id);
    return { success: true, message: `Task "${id}" removed` };
  };
}

export const clearAllTasksToolMetadata: ToolMetadata = {
  name: "schedule_clear_all_tasks",
  requiresPrivilegedAccess: true,
  description:
    "Remove ALL scheduled tasks. This is a destructive and irreversible operation. " +
    "Requires privileged access. Privileged context is injected automatically by runtime when enabled.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export function handleClearAllTasks(service: ScheduleService, adminApiUrl: string) {
  return async (params: Record<string, unknown>): Promise<unknown> => {
    await validatePrivilegeGrant(params, adminApiUrl);
    await service.removeAllTasks();
    return { success: true, message: "All tasks removed" };
  };
}
