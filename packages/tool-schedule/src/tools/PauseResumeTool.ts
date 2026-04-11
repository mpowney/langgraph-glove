import { validatePrivilegeGrant, type ToolMetadata } from "@langgraph-glove/tool-server";
import type { ScheduleService } from "../ScheduleService";

export const pauseSchedulerToolMetadata: ToolMetadata = {
  name: "schedule_pause",
  requiresPrivilegedAccess: true,
  description:
    "Pause the task scheduler. While paused, no scheduled tasks will fire automatically. " +
    "Existing tasks are preserved and will resume when schedule_resume is called. " +
    "Requires privileged access. Privileged context is injected automatically by runtime when enabled.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export function handlePauseScheduler(service: ScheduleService, adminApiUrl: string) {
  return async (params: Record<string, unknown>): Promise<unknown> => {
    await validatePrivilegeGrant(params, adminApiUrl);
    service.pause();
    return { success: true, message: "Scheduler paused" };
  };
}

export const resumeSchedulerToolMetadata: ToolMetadata = {
  name: "schedule_resume",
  requiresPrivilegedAccess: true,
  description:
    "Resume the task scheduler after it was paused with schedule_pause. " +
    "All enabled tasks will be rescheduled immediately. " +
    "Requires privileged access. Privileged context is injected automatically by runtime when enabled.",
  parameters: {
    type: "object",
    properties: {},
  },
};

export function handleResumeScheduler(service: ScheduleService, adminApiUrl: string) {
  return async (params: Record<string, unknown>): Promise<unknown> => {
    await validatePrivilegeGrant(params, adminApiUrl);
    service.resume();
    return { success: true, message: "Scheduler resumed" };
  };
}
