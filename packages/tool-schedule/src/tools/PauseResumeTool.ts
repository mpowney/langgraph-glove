import type { ToolMetadata } from "@langgraph-glove/tool-server";
import type { ScheduleService } from "../ScheduleService";
import { validatePrivilegeGrant } from "../validatePrivilegeGrant";

export const pauseSchedulerToolMetadata: ToolMetadata = {
  name: "schedule_pause",
  description:
    "Pause the task scheduler. While paused, no scheduled tasks will fire automatically. " +
    "Existing tasks are preserved and will resume when schedule_resume is called. " +
    "Requires privileged access.",
  parameters: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        description: "Active conversation ID (required for privilege validation).",
      },
      privilegeGrantId: {
        type: "string",
        description: "Short-lived privilege grant ID.",
      },
    },
    required: ["conversationId", "privilegeGrantId"],
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
  description:
    "Resume the task scheduler after it was paused with schedule_pause. " +
    "All enabled tasks will be rescheduled immediately. " +
    "Requires privileged access.",
  parameters: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        description: "Active conversation ID (required for privilege validation).",
      },
      privilegeGrantId: {
        type: "string",
        description: "Short-lived privilege grant ID.",
      },
    },
    required: ["conversationId", "privilegeGrantId"],
  },
};

export function handleResumeScheduler(service: ScheduleService, adminApiUrl: string) {
  return async (params: Record<string, unknown>): Promise<unknown> => {
    await validatePrivilegeGrant(params, adminApiUrl);
    service.resume();
    return { success: true, message: "Scheduler resumed" };
  };
}
