import type { ToolMetadata } from "@langgraph-glove/tool-server";
import type { ScheduleService } from "../ScheduleService";

export const getStatusToolMetadata: ToolMetadata = {
  name: "schedule_get_status",
  description:
    "Get scheduler runtime status including pause state, minute sweep status, task counts, " +
    "and last execution outcome.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

export function handleGetStatus(service: ScheduleService) {
  return async (_params: Record<string, unknown>): Promise<unknown> => {
    return {
      success: true,
      status: service.getStatus(),
    };
  };
}
