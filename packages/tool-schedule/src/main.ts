/**
 * Entry point for the tool-schedule server.
 *
 * The scheduler reads tasks from `config/schedule.json` and executes them on
 * the cron schedule defined per-task.  Execution is performed by calling the
 * gateway's internal Admin API (`POST /api/internal/invoke`).
 *
 * Environment variables:
 *   GLOVE_CONFIG_DIR      — path to config directory  (default: ./config)
 *   GLOVE_SECRETS_DIR     — path to secrets directory (default: ./secrets)
 *   GLOVE_ADMIN_API_URL   — gateway Admin API base URL (default: http://127.0.0.1:8081)
 *   GLOVE_SCHEDULE_FILE   — path to schedule.json (default: <configDir>/schedule.json)
 */

import path from "node:path";
import { launchToolServer } from "@langgraph-glove/tool-server";
import { ScheduleService } from "./ScheduleService";
import { listTasksToolMetadata, handleListTasks } from "./tools/ListTasksTool";
import { addTaskToolMetadata, handleAddTask } from "./tools/AddTaskTool";
import { updateTaskToolMetadata, handleUpdateTask } from "./tools/UpdateTaskTool";
import { runTaskNowToolMetadata, handleRunTaskNow } from "./tools/RunTaskNowTool";
import {
  removeTaskToolMetadata,
  handleRemoveTask,
  clearAllTasksToolMetadata,
  handleClearAllTasks,
} from "./tools/RemoveTaskTool";
import {
  pauseSchedulerToolMetadata,
  handlePauseScheduler,
  resumeSchedulerToolMetadata,
  handleResumeScheduler,
} from "./tools/PauseResumeTool";
import { getStatusToolMetadata, handleGetStatus } from "./tools/GetStatusTool";

const adminApiUrl = process.env["GLOVE_ADMIN_API_URL"] ?? "http://127.0.0.1:8081";
const configDir = path.resolve(process.env["GLOVE_CONFIG_DIR"] ?? "config");
const secretsDir = path.resolve(process.env["GLOVE_SECRETS_DIR"] ?? "secrets");
const scheduleFile =
  process.env["GLOVE_SCHEDULE_FILE"] ?? path.join(configDir, "schedule.json");

/**
 * Invokes the agent by calling the gateway's internal REST endpoint.
 * The gateway must be running and its Admin API must be reachable at
 * `adminApiUrl`.
 */
async function invokeAgent(params: {
  agentKey: string;
  conversationId: string;
  prompt: string;
  graphKey?: string;
  personalToken?: string;
}): Promise<string> {
  const base = adminApiUrl.endsWith("/") ? adminApiUrl.slice(0, -1) : adminApiUrl;
  const response = await fetch(`${base}/api/internal/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `invokeAgent HTTP ${response.status}: ${body || response.statusText}`,
    );
  }

  const data = (await response.json()) as { result?: string; error?: string };
  if (data.error) throw new Error(`invokeAgent error: ${data.error}`);
  return data.result ?? "";
}

async function emitSystemEvent(event: {
  event: string;
  timestamp: string;
  taskId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const base = adminApiUrl.endsWith("/") ? adminApiUrl.slice(0, -1) : adminApiUrl;
  const response = await fetch(`${base}/api/internal/system-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: "system:schedule",
      text: JSON.stringify(event),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`emitSystemEvent HTTP ${response.status}: ${body || response.statusText}`);
  }
}

async function sendChannelMessage(params: {
  conversationId: string;
  text: string;
  role?: "agent" | "error";
  channelName?: string;
}): Promise<void> {
  const base = adminApiUrl.endsWith("/") ? adminApiUrl.slice(0, -1) : adminApiUrl;
  const response = await fetch(`${base}/api/internal/channel-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`sendChannelMessage HTTP ${response.status}: ${body || response.statusText}`);
  }
}

const service = new ScheduleService({
  configPath: scheduleFile,
  secretsDir,
  invokeAgent,
  emitSystemEvent,
  sendChannelMessage,
});

await service.start();

await launchToolServer({
  toolKey: "schedule",
  configDir,
  secretsDir,
  register(server) {
    server.register(listTasksToolMetadata, handleListTasks(service));
    server.register(addTaskToolMetadata, handleAddTask(service));
    server.register(updateTaskToolMetadata, handleUpdateTask(service));
    server.register(runTaskNowToolMetadata, handleRunTaskNow(service));
    server.register(removeTaskToolMetadata, handleRemoveTask(service, adminApiUrl));
    server.register(clearAllTasksToolMetadata, handleClearAllTasks(service, adminApiUrl));
    server.register(pauseSchedulerToolMetadata, handlePauseScheduler(service, adminApiUrl));
    server.register(resumeSchedulerToolMetadata, handleResumeScheduler(service, adminApiUrl));
    server.register(getStatusToolMetadata, handleGetStatus(service));
  },
});
