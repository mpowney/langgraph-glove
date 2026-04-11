/**
 * ScheduleService — manages the schedule.json task list and drives an embedded
 * cron scheduler.
 *
 * ## Schedule config (`config/schedule.json`)
 *
 * ```json
 * {
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
  /**
   * Standard cron expression (5 or 6 fields).
   * Examples: `"0 3 * * *"`, `"*\/15 * * * *"`.
   */
  cron: string;
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
}

export interface ScheduleConfig {
  tasks: ScheduledTask[];
}

// ---------------------------------------------------------------------------
// ScheduleService
// ---------------------------------------------------------------------------

const SECRET_PATTERN = /^\{SECRET:([^}]+)\}$/;

export class ScheduleService {
  private tasks: ScheduledTask[] = [];
  private cronJobs = new Map<string, cron.ScheduledTask>();
  private paused = false;
  private readonly configPath: string;
  private readonly secretStore: SecretStore;
  /** Called by the cron runner to execute a task against the gateway agent. */
  private readonly invokeAgent: (params: {
    agentKey: string;
    conversationId: string;
    prompt: string;
    personalToken?: string;
  }) => Promise<string>;

  constructor(options: {
    configPath: string;
    secretsDir: string;
    invokeAgent: (params: {
      agentKey: string;
      conversationId: string;
      prompt: string;
      personalToken?: string;
    }) => Promise<string>;
  }) {
    this.configPath = options.configPath;
    this.secretStore = new SecretStore();
    this.secretStore.load(options.secretsDir);
    this.invokeAgent = options.invokeAgent;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Load schedule.json, start all enabled cron jobs. */
  async start(): Promise<void> {
    await this.load();
    this.rebuildCronJobs();
    console.log(`[ScheduleService] Started with ${this.tasks.length} task(s)`);
  }

  /** Stop all cron jobs. */
  stop(): void {
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();
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
    console.log("[ScheduleService] Paused");
  }

  resume(): void {
    this.paused = false;
    this.rebuildCronJobs();
    console.log("[ScheduleService] Resumed");
  }

  get isPaused(): boolean {
    return this.paused;
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
    if (!cron.validate(input.cron)) {
      throw new Error(`Invalid cron expression: "${input.cron}"`);
    }
    const task: ScheduledTask = {
      ...input,
      id,
      enabled: input.enabled ?? true,
      conversationId: input.conversationId ?? `schedule-${id}`,
    };
    this.tasks.push(task);
    await this.save();
    if (!this.paused && task.enabled) {
      this.scheduleSingleTask(task);
    }
    return this.sanitiseForOutput(task);
  }

  async updateTask(id: string, updates: Partial<Omit<ScheduledTask, "id">>): Promise<ScheduledTask> {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error(`Task "${id}" not found`);
    if (updates.cron !== undefined && !cron.validate(updates.cron)) {
      throw new Error(`Invalid cron expression: "${updates.cron}"`);
    }
    const updated = { ...this.tasks[idx] as ScheduledTask, ...updates };
    this.tasks[idx] = updated;
    await this.save();
    // Rebuild this task's cron job to pick up changes
    const existing = this.cronJobs.get(id);
    if (existing) {
      existing.stop();
      this.cronJobs.delete(id);
    }
    if (!this.paused && updated.enabled) {
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
    return this.executeTask(task);
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
      if (task.enabled) {
        this.scheduleSingleTask(task);
      }
    }
    console.log(`[ScheduleService] Rebuilt cron jobs for ${this.cronJobs.size} enabled task(s)`);
  }

  private scheduleSingleTask(task: ScheduledTask): void {
    if (!cron.validate(task.cron)) {
      console.error(`[ScheduleService] Skipping task "${task.id}" — invalid cron: "${task.cron}"`);
      return;
    }
    const job = cron.schedule(task.cron, () => {
      this.executeTask(task).catch((err: unknown) => {
        console.error(`[ScheduleService] Task "${task.id}" (${task.name}) failed:`, err);
      });
    });
    this.cronJobs.set(task.id, job);
    console.log(`[ScheduleService] Scheduled task "${task.id}" (${task.name}) @ ${task.cron}`);
  }

  private async executeTask(task: ScheduledTask): Promise<string> {
    console.log(`[ScheduleService] Executing task "${task.id}" (${task.name})`);
    const personalToken = await this.resolvePersonalToken(task);
    const agentKey = task.agentKey ?? "default";
    const conversationId = task.conversationId ?? `schedule-${task.id}`;

    // When a specific agent is targeted the prompt is prefixed so the
    // orchestrator knows which sub-agent should handle it.
    const prompt =
      agentKey !== "default"
        ? `[Scheduled task — delegate to the ${agentKey} agent] ${task.prompt}`
        : task.prompt;

    const result = await this.invokeAgent({ agentKey, conversationId, prompt, personalToken });
    console.log(`[ScheduleService] Task "${task.id}" completed`);
    return result;
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

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, "utf-8");
      const parsed = JSON.parse(raw) as ScheduleConfig;
      this.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
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
    const config: ScheduleConfig = { tasks: this.tasks };
    const dir = path.dirname(this.configPath);
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }
}
