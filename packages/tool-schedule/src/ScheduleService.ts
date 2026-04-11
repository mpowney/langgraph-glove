/**
 * ScheduleService — manages the schedule.json task list and drives an embedded
 * cron scheduler.
 *
 * ## Schedule config (`config/schedule.json`)
 *
 * ```json
 * {
 *   "executionGraphKey": "schedule-system",
 *   "tasks": [
 *     {
 *       "id": "<uuid>",
 *       "name": "Daily memory consolidation",
 *       "type": "system",
 *       "cron": "0 3 * * *",
 *       "agentKey": "memory",
 *       "prompt": "Consolidate and reindex all memories.",
 *       "enabled": true,
 *       "personalToken": null
 *     }
 *   ]
 * }
 * ```
 *
 * ## Task types
 * - `"user"`   — explicitly requested by a human user (may carry a personal
 *                token so the agent can decrypt personal memories)
 * - `"agent"`  — inferred from a conversation by an AI agent
 * - `"system"` — maintenance / housekeeping tasks with no personal context
 *
 * ## Personal token handling
 * User tasks may optionally include a `personalToken`.  Because this token is
 * used to decrypt private memories it is sensitive; callers should either:
 *   1. Omit it (recommended for most tasks), or
 *   2. Store it as a `{SECRET:name}` reference so it is resolved from the
 *      secrets store rather than kept in plaintext inside schedule.json.
 *
 * The ScheduleService resolves `{SECRET:name}` placeholders at *execution*
 * time using the SecretStore, not at load time, so the plaintext value is
 * never written to disk.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import cron from "node-cron";
import { SecretStore } from "@langgraph-glove/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskType = "user" | "agent" | "system";
export type ScheduleType = "cron" | "once";
export type OnceTaskState = "pending" | "running" | "completed" | "failed";

export interface TaskSourceContext {
  /** Channel name where the scheduling request originated (for example "web" or "bluebubbles"). */
  channel: string;
  /** Channel-scoped conversation identifier to continue in the same context. */
  conversationId: string;
  /** Optional source sender identifier. */
  sender?: string;
  /** Channel-specific metadata captured when scheduling was requested (for example BlueBubbles chatGuid). */
  metadata?: Record<string, unknown>;
  /** ISO timestamp when source context was captured. */
  capturedAt?: string;
}

export interface TaskDeliveryConfig {
  /** When true, send the final agent response back to sourceContext channel/conversation. */
  sendAgentReplyToSource?: boolean;
  /** When true, send a starter message before invoking the task prompt. */
  startConversation?: boolean;
  /** Optional starter text used when startConversation=true. */
  starterText?: string;
}

export interface SchedulerSystemEvent {
  event:
    | "scheduler-started"
    | "scheduler-paused"
    | "scheduler-resumed"
    | "minute-sweep"
    | "task-started"
    | "task-completed"
    | "task-failed";
  timestamp: string;
  taskId?: string;
  details?: Record<string, unknown>;
}

export interface ScheduledTask {
  /** Stable unique identifier for this task. */
  id: string;
  /** Human-readable label. */
  name: string;
  /**
   * Who created / owns this task:
   * - `"user"`   — explicit user request (personal token supported)
   * - `"agent"`  — inferred from a conversation
   * - `"system"` — maintenance / housekeeping
   */
  type: TaskType;
  /** Task schedule mode. Defaults to "cron" for legacy entries. */
  scheduleType?: ScheduleType;
  /** Cron expression when scheduleType = "cron". */
  cron?: string;
  /** ISO datetime when scheduleType = "once". Normalized to minute precision. */
  runAt?: string;
  /**
   * Key of the agent that should handle this task (e.g. `"memory"`,
   * `"researcher"`, `"default"`).  If omitted the orchestrator default agent
   * is used.
   */
  agentKey?: string;
  /**
   * Prompt sent to the agent when the task runs.  May contain template
   * variables resolved at execution time.
   */
  prompt: string;
  /** When `false` the task is skipped by the cron runner. Default: `true`. */
  enabled: boolean;
  /**
   * Optional personal token for `"user"` tasks that need to access encrypted
   * personal memories.  Use `"{SECRET:name}"` to reference a secrets-store
   * entry rather than storing the raw value here.
   */
  personalToken?: string | null;
  /**
   * Conversation ID to use when invoking the agent.  A stable, deterministic
   * ID keeps the task's conversation history separate from interactive chats.
   * Auto-generated if omitted.
   */
  conversationId?: string;
  /** Once-task state tracking. */
  onceState?: OnceTaskState;
  /** Timestamp of latest run attempt. */
  lastRunAt?: string;
  /** Timestamp when a once task completed successfully. */
  completedAt?: string;
  /** Last execution error, when present. */
  lastError?: string;
  /** Original channel context used to continue follow-up interaction in-place. */
  sourceContext?: TaskSourceContext;
  /** Delivery behavior for proactive/start and post-run reply messaging. */
  delivery?: TaskDeliveryConfig;
}

export interface ScheduleConfig {
  /** Graph key used when executing scheduled tasks via gateway invoke API. */
  executionGraphKey?: string;
  tasks: ScheduledTask[];
}

export interface SchedulerStatus {
  paused: boolean;
  minuteSweepRunning: boolean;
  lastSweepMinute?: string;
  totalTasks: number;
  enabledTasks: number;
  cronTasks: number;
  onceTasks: number;
  enabledCronTasks: number;
  enabledOnceTasks: number;
  lastExecutionAt?: string;
  lastExecutionTaskId?: string;
  lastExecutionResult?: "success" | "failed";
  lastExecutionError?: string;
}

// ---------------------------------------------------------------------------
// ScheduleService
// ---------------------------------------------------------------------------

const SECRET_PATTERN = /^\{SECRET:([^}]+)\}$/;

export class ScheduleService {
  private static readonly DEFAULT_EXECUTION_GRAPH_KEY = "schedule-system";
  private tasks: ScheduledTask[] = [];
  private cronJobs = new Map<string, cron.ScheduledTask>();
  private minuteSweepJob: cron.ScheduledTask | null = null;
  private minuteSweepRunning = false;
  private lastSweepMinute: string | null = null;
  private paused = false;
  private lastExecutionAt?: string;
  private lastExecutionTaskId?: string;
  private lastExecutionResult?: "success" | "failed";
  private lastExecutionError?: string;
  private executionGraphKey = ScheduleService.DEFAULT_EXECUTION_GRAPH_KEY;
  private readonly configPath: string;
  private readonly secretStore: SecretStore;
  /** Called by the cron runner to execute a task against the gateway agent. */
  private readonly invokeAgent: (params: {
    agentKey: string;
    conversationId: string;
    prompt: string;
    graphKey?: string;
    personalToken?: string;
  }) => Promise<string>;

  constructor(options: {
    configPath: string;
    secretsDir: string;
    invokeAgent: (params: {
      agentKey: string;
      conversationId: string;
      prompt: string;
      graphKey?: string;
      personalToken?: string;
    }) => Promise<string>;
    emitSystemEvent?: (event: SchedulerSystemEvent) => Promise<void> | void;
    sendChannelMessage?: (params: {
      conversationId: string;
      text: string;
      role?: "agent" | "error";
      channelName?: string;
    }) => Promise<void>;
  }) {
    this.configPath = options.configPath;
    this.secretStore = new SecretStore();
    this.secretStore.load(options.secretsDir);
    this.invokeAgent = options.invokeAgent;
    this.emitSystemEvent = options.emitSystemEvent;
    this.sendChannelMessage = options.sendChannelMessage;
  }

  private readonly emitSystemEvent?: (event: SchedulerSystemEvent) => Promise<void> | void;
  private readonly sendChannelMessage?: (params: {
    conversationId: string;
    text: string;
    role?: "agent" | "error";
    channelName?: string;
  }) => Promise<void>;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Load schedule.json, start all enabled cron jobs. */
  async start(): Promise<void> {
    await this.load();
    this.rebuildCronJobs();
    this.startMinuteSweep();
    await this.emitEvent("scheduler-started", {
      paused: this.paused,
      cronTaskCount: this.countEnabledCronTasks(),
      onceTaskCount: this.countEnabledOnceTasks(),
    });
    console.log(`[ScheduleService] Started with ${this.tasks.length} task(s)`);
  }

  /** Stop all cron jobs. */
  stop(): void {
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();
    if (this.minuteSweepJob) {
      this.minuteSweepJob.stop();
      this.minuteSweepJob = null;
    }
    console.log("[ScheduleService] Stopped");
  }

  // -------------------------------------------------------------------------
  // Pause / resume
  // -------------------------------------------------------------------------

  pause(): void {
    this.paused = true;
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    if (this.minuteSweepJob) {
      this.minuteSweepJob.stop();
    }
    void this.emitEvent("scheduler-paused", {
      cronTaskCount: this.countEnabledCronTasks(),
      onceTaskCount: this.countEnabledOnceTasks(),
    });
    console.log("[ScheduleService] Paused");
  }

  resume(): void {
    this.paused = false;
    this.rebuildCronJobs();
    this.startMinuteSweep();
    void this.emitEvent("scheduler-resumed", {
      cronTaskCount: this.countEnabledCronTasks(),
      onceTaskCount: this.countEnabledOnceTasks(),
    });
    console.log("[ScheduleService] Resumed");
  }

  get isPaused(): boolean {
    return this.paused;
  }

  getStatus(): SchedulerStatus {
    const cronTasks = this.tasks.filter((task) => this.getScheduleType(task) === "cron").length;
    const onceTasks = this.tasks.length - cronTasks;
    const enabledTasks = this.tasks.filter((task) => task.enabled).length;
    return {
      paused: this.paused,
      minuteSweepRunning: this.minuteSweepRunning,
      ...(this.lastSweepMinute ? { lastSweepMinute: this.lastSweepMinute } : {}),
      totalTasks: this.tasks.length,
      enabledTasks,
      cronTasks,
      onceTasks,
      enabledCronTasks: this.countEnabledCronTasks(),
      enabledOnceTasks: this.countEnabledOnceTasks(),
      ...(this.lastExecutionAt ? { lastExecutionAt: this.lastExecutionAt } : {}),
      ...(this.lastExecutionTaskId ? { lastExecutionTaskId: this.lastExecutionTaskId } : {}),
      ...(this.lastExecutionResult ? { lastExecutionResult: this.lastExecutionResult } : {}),
      ...(this.lastExecutionError ? { lastExecutionError: this.lastExecutionError } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  listTasks(): ScheduledTask[] {
    return this.tasks.map((t) => this.sanitiseForOutput(t));
  }

  getTask(id: string): ScheduledTask | undefined {
    const task = this.tasks.find((t) => t.id === id);
    return task ? this.sanitiseForOutput(task) : undefined;
  }

  async addTask(input: Omit<ScheduledTask, "id"> & { id?: string }): Promise<ScheduledTask> {
    const id = input.id ?? uuidv4();
    const task = this.normaliseAndValidateTask({
      ...input,
      id,
      conversationId: input.conversationId ?? `schedule-${id}`,
      enabled: input.enabled ?? true,
    });
    this.tasks.push(task);
    await this.save();
    if (!this.paused && task.enabled && task.scheduleType !== "once") {
      this.scheduleSingleTask(task);
    }
    return this.sanitiseForOutput(task);
  }

  async updateTask(id: string, updates: Partial<Omit<ScheduledTask, "id">>): Promise<ScheduledTask> {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Task "${id}" not found`);
    const updated = this.normaliseAndValidateTask({
      ...(this.tasks[idx] as ScheduledTask),
      ...updates,
    });
    this.tasks[idx] = updated;
    await this.save();
    // Rebuild this task's cron job to pick up changes
    const existing = this.cronJobs.get(id);
    if (existing) {
      existing.stop();
      this.cronJobs.delete(id);
    }
    if (!this.paused && updated.enabled && updated.scheduleType !== "once") {
      this.scheduleSingleTask(updated);
    }
    return this.sanitiseForOutput(updated);
  }

  async removeTask(id: string): Promise<void> {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Task "${id}" not found`);
    this.tasks.splice(idx, 1);
    const job = this.cronJobs.get(id);
    if (job) {
      job.stop();
      this.cronJobs.delete(id);
    }
    await this.save();
  }

  async removeAllTasks(): Promise<void> {
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();
    this.tasks = [];
    await this.save();
  }

  // -------------------------------------------------------------------------
  // Immediate execution
  // -------------------------------------------------------------------------

  async runTaskNow(id: string): Promise<string> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`Task "${id}" not found`);
    return this.executeTask(task, "manual-now");
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private rebuildCronJobs(): void {
    // Stop and clear all existing jobs
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();
    if (this.paused) return;
    for (const task of this.tasks) {
      if (task.enabled && this.getScheduleType(task) === "cron") {
        this.scheduleSingleTask(task);
      }
    }
    console.log(`[ScheduleService] Rebuilt cron jobs for ${this.cronJobs.size} enabled task(s)`);
  }

  private scheduleSingleTask(task: ScheduledTask): void {
    const cronExpr = task.cron?.trim() ?? "";
    if (!cron.validate(cronExpr)) {
      console.error(`[ScheduleService] Skipping task "${task.id}" — invalid cron: "${cronExpr}"`);
      return;
    }
    const job = cron.schedule(cronExpr, () => {
      this.executeTask(task, "cron").catch((err: unknown) => {
        console.error(`[ScheduleService] Task "${task.id}" (${task.name}) failed:`, err);
      });
    });
    this.cronJobs.set(task.id, job);
    console.log(`[ScheduleService] Scheduled task "${task.id}" (${task.name}) @ ${cronExpr}`);
  }

  private startMinuteSweep(): void {
    if (this.minuteSweepJob) {
      this.minuteSweepJob.stop();
      this.minuteSweepJob = null;
    }
    this.minuteSweepJob = cron.schedule("* * * * *", () => {
      this.runDueOnceTasks().catch((err: unknown) => {
        console.error("[ScheduleService] Minute sweep failed:", err);
      });
    });
    console.log("[ScheduleService] Started once-task minute sweep");
  }

  private async runDueOnceTasks(): Promise<void> {
    if (this.paused || this.minuteSweepRunning) return;
    const minute = this.currentMinuteIso();
    if (this.lastSweepMinute === minute) return;

    this.minuteSweepRunning = true;
    this.lastSweepMinute = minute;
    try {
      const dueTasks = this.tasks.filter((task) => this.isOnceTaskDue(task, minute));
      await this.emitEvent("minute-sweep", {
        minute,
        dueCount: dueTasks.length,
      });
      for (const task of dueTasks) {
        await this.executeTask(task, "once-minute-sweep").catch((err: unknown) => {
          console.error(`[ScheduleService] Once task "${task.id}" (${task.name}) failed:`, err);
        });
      }
    } finally {
      this.minuteSweepRunning = false;
    }
  }

  private async executeTask(task: ScheduledTask, trigger: "cron" | "once-minute-sweep" | "manual-now"): Promise<string> {
    console.log(`[ScheduleService] Executing task "${task.id}" (${task.name})`);

    const scheduleType = this.getScheduleType(task);
    if (scheduleType === "once") {
      await this.markOnceTaskStarted(task.id);
    }

    await this.emitEvent("task-started", {
      taskId: task.id,
      name: task.name,
      scheduleType,
      trigger,
    });

    const personalToken = await this.resolvePersonalToken(task);
    const agentKey = task.agentKey ?? "default";
    const conversationId = task.conversationId ?? `schedule-${task.id}`;

    if (task.delivery?.startConversation && task.delivery.starterText) {
      await this.deliverToSource(task, task.delivery.starterText, "agent");
    }

    // When a specific agent is targeted the prompt is prefixed so the
    // orchestrator knows which sub-agent should handle it.
    const prompt =
      agentKey !== "default"
        ? `[Scheduled task — delegate to the ${agentKey} agent] ${task.prompt}`
        : task.prompt;

    try {
      const result = await this.invokeAgent({
        agentKey,
        conversationId,
        prompt,
        graphKey: this.executionGraphKey,
        personalToken,
      });

      if (scheduleType === "once") {
        await this.markOnceTaskCompleted(task.id);
      }
      this.lastExecutionAt = new Date().toISOString();
      this.lastExecutionTaskId = task.id;
      this.lastExecutionResult = "success";
      this.lastExecutionError = undefined;

      if (task.delivery?.sendAgentReplyToSource !== false) {
        await this.deliverToSource(task, result, "agent");
      }

      await this.emitEvent("task-completed", {
        taskId: task.id,
        name: task.name,
        scheduleType,
        trigger,
      });
      console.log(`[ScheduleService] Task "${task.id}" completed`);
      return result;
    } catch (err) {
      const errText = this.stringifyError(err);
      if (scheduleType === "once") {
        await this.markOnceTaskFailed(task.id, errText);
      }
      this.lastExecutionAt = new Date().toISOString();
      this.lastExecutionTaskId = task.id;
      this.lastExecutionResult = "failed";
      this.lastExecutionError = errText;

      if (task.delivery?.sendAgentReplyToSource !== false) {
        await this.deliverToSource(task, `Scheduled task failed: ${errText}`, "error");
      }

      await this.emitEvent("task-failed", {
        taskId: task.id,
        name: task.name,
        scheduleType,
        trigger,
        error: errText,
      });
      throw err;
    }
  }

  private async deliverToSource(
    task: ScheduledTask,
    text: string,
    role: "agent" | "error",
  ): Promise<void> {
    if (!this.sendChannelMessage) return;
    const source = task.sourceContext;
    if (!source?.channel) return;

    const chatGuid = typeof source.metadata?.chatGuid === "string"
      ? source.metadata.chatGuid
      : undefined;
    const targetConversationId =
      source.channel === "bluebubbles"
        ? (chatGuid ?? source.conversationId)
        : source.conversationId;
    if (!targetConversationId) return;

    await this.sendChannelMessage({
      channelName: source.channel,
      conversationId: targetConversationId,
      text,
      role,
    });
  }

  /**
   * Resolve the personal token for a task.
   *
   * - `null` / `undefined` → no personal token
   * - `"{SECRET:name}"`    → resolved from the secrets store at execution time
   * - any other string     → used as-is
   */
  private async resolvePersonalToken(task: ScheduledTask): Promise<string | undefined> {
    if (!task.personalToken) return undefined;
    const match = SECRET_PATTERN.exec(task.personalToken);
    if (match) {
      const secretName = match[1] ?? "";
      if (!secretName) return undefined;
      try {
        return this.secretStore.get(secretName);
      } catch {
        console.warn(`[ScheduleService] Secret "${secretName}" not found for task "${task.id}"; proceeding without personal token`);
        return undefined;
      }
    }
    return task.personalToken;
  }

  /** Strip the raw personal token value before returning data to callers. */
  private sanitiseForOutput(task: ScheduledTask): ScheduledTask {
    if (!task.personalToken) return task;
    // If stored as a secret reference, the reference is safe to expose.
    // If stored as a raw value, redact it.
    const isSecretRef = SECRET_PATTERN.test(task.personalToken);
    return {
      ...task,
      personalToken: isSecretRef ? task.personalToken : "[REDACTED]",
    };
  }

  private getScheduleType(task: ScheduledTask): ScheduleType {
    return task.scheduleType === "once" ? "once" : "cron";
  }

  private normaliseAndValidateTask(task: ScheduledTask): ScheduledTask {
    const scheduleType = task.scheduleType === "once" ? "once" : "cron";
    const normalised: ScheduledTask = {
      ...task,
      name: task.name.trim(),
      type: task.type,
      prompt: task.prompt.trim(),
      enabled: task.enabled ?? true,
      scheduleType,
      agentKey: task.agentKey?.trim() || undefined,
      conversationId: task.conversationId?.trim() || `schedule-${task.id}`,
      personalToken: task.personalToken ?? null,
      sourceContext: this.normaliseSourceContext(task.sourceContext),
      delivery: this.normaliseDelivery(task.delivery),
    };

    if (!normalised.name) throw new Error("Task name is required");
    if (!normalised.prompt) throw new Error("Task prompt is required");

    if (scheduleType === "cron") {
      const cronExpr = normalised.cron?.trim() ?? "";
      if (!cronExpr) throw new Error("'cron' is required when scheduleType is 'cron'");
      if (!cron.validate(cronExpr)) {
        throw new Error(`Invalid cron expression: "${cronExpr}"`);
      }
      normalised.cron = cronExpr;
      delete normalised.runAt;
      delete normalised.onceState;
      delete normalised.completedAt;
      delete normalised.lastError;
      return normalised;
    }

    const runAtMinute = this.normalizeToMinuteIso(normalised.runAt);
    if (!runAtMinute) {
      throw new Error("'runAt' is required when scheduleType is 'once'");
    }

    normalised.runAt = runAtMinute;
    delete normalised.cron;
    normalised.onceState = this.normaliseOnceState(normalised.onceState);
    if (normalised.onceState !== "completed") {
      delete normalised.completedAt;
    }
    if (normalised.onceState !== "failed") {
      delete normalised.lastError;
    }
    return normalised;
  }

  private normaliseSourceContext(input: TaskSourceContext | undefined): TaskSourceContext | undefined {
    if (!input) return undefined;
    const channel = input.channel?.trim();
    const conversationId = input.conversationId?.trim();
    if (!channel || !conversationId) return undefined;
    return {
      channel,
      conversationId,
      ...(input.sender?.trim() ? { sender: input.sender.trim() } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      capturedAt: input.capturedAt ?? new Date().toISOString(),
    };
  }

  private normaliseDelivery(input: TaskDeliveryConfig | undefined): TaskDeliveryConfig {
    const sendAgentReplyToSource = input?.sendAgentReplyToSource ?? true;
    const startConversation = input?.startConversation ?? false;
    return {
      sendAgentReplyToSource,
      startConversation,
      ...(input?.starterText?.trim() ? { starterText: input.starterText.trim() } : {}),
    };
  }

  private normaliseOnceState(state: OnceTaskState | undefined): OnceTaskState {
    if (state === "running" || state === "completed" || state === "failed") return state;
    return "pending";
  }

  private currentMinuteIso(): string {
    return new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  }

  private normalizeToMinuteIso(value: string | undefined): string | null {
    if (!value?.trim()) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    parsed.setUTCSeconds(0, 0);
    return parsed.toISOString();
  }

  private isOnceTaskDue(task: ScheduledTask, minuteIso: string): boolean {
    if (!task.enabled) return false;
    if (this.getScheduleType(task) !== "once") return false;
    const runAtMinute = this.normalizeToMinuteIso(task.runAt);
    if (!runAtMinute) return false;
    if (task.onceState === "completed") return false;
    if (task.onceState === "running") return false;
    if (task.lastRunAt && this.normalizeToMinuteIso(task.lastRunAt) === minuteIso) {
      return false;
    }
    return runAtMinute <= minuteIso;
  }

  private async markOnceTaskStarted(taskId: string): Promise<void> {
    const idx = this.tasks.findIndex((task) => task.id === taskId);
    if (idx === -1) return;
    const task = this.tasks[idx] as ScheduledTask;
    if (this.getScheduleType(task) !== "once") return;
    this.tasks[idx] = {
      ...task,
      onceState: "running",
      lastRunAt: this.currentMinuteIso(),
      lastError: undefined,
    };
    await this.save();
  }

  private async markOnceTaskCompleted(taskId: string): Promise<void> {
    const idx = this.tasks.findIndex((task) => task.id === taskId);
    if (idx === -1) return;
    const task = this.tasks[idx] as ScheduledTask;
    if (this.getScheduleType(task) !== "once") return;
    this.tasks[idx] = {
      ...task,
      onceState: "completed",
      completedAt: new Date().toISOString(),
    };
    await this.save();
  }

  private async markOnceTaskFailed(taskId: string, error: string): Promise<void> {
    const idx = this.tasks.findIndex((task) => task.id === taskId);
    if (idx === -1) return;
    const task = this.tasks[idx] as ScheduledTask;
    if (this.getScheduleType(task) !== "once") return;
    this.tasks[idx] = {
      ...task,
      onceState: "failed",
      lastError: error,
    };
    await this.save();
  }

  private countEnabledCronTasks(): number {
    return this.tasks.filter((task) => task.enabled && this.getScheduleType(task) === "cron").length;
  }

  private countEnabledOnceTasks(): number {
    return this.tasks.filter((task) => task.enabled && this.getScheduleType(task) === "once").length;
  }

  private async emitEvent(
    event: SchedulerSystemEvent["event"],
    details?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.emitSystemEvent) return;
    try {
      await this.emitSystemEvent({
        event,
        timestamp: new Date().toISOString(),
        ...(details ? { details } : {}),
      });
    } catch {
      // Keep scheduler flow resilient when observability sinks are unavailable.
    }
  }

  private stringifyError(err: unknown): string {
    if (err instanceof Error) return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, "utf-8");
      const parsed = JSON.parse(raw) as ScheduleConfig;
      this.executionGraphKey =
        typeof parsed.executionGraphKey === "string" && parsed.executionGraphKey.trim().length > 0
          ? parsed.executionGraphKey.trim()
          : ScheduleService.DEFAULT_EXECUTION_GRAPH_KEY;
      const incoming = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      this.tasks = incoming
        .filter((candidate): candidate is ScheduledTask => typeof candidate === "object" && candidate !== null)
        .map((candidate) => {
          const id =
            typeof candidate.id === "string" && candidate.id.trim()
              ? candidate.id
              : uuidv4();
          const base: ScheduledTask = {
            ...candidate,
            id,
            enabled: candidate.enabled ?? true,
            conversationId: candidate.conversationId ?? `schedule-${id}`,
            scheduleType: candidate.scheduleType === "once" ? "once" : "cron",
          };
          return this.normaliseAndValidateTask(base);
        });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // No schedule file yet — start with empty list
        this.tasks = [];
        await this.save();
      } else {
        throw err;
      }
    }
  }

  private async save(): Promise<void> {
    const config: ScheduleConfig = {
      executionGraphKey: this.executionGraphKey,
      tasks: this.tasks,
    };
    const dir = path.dirname(this.configPath);
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }
}
