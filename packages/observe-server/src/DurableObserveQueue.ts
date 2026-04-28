import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DurableQueueRecord } from "./types.js";

export interface ObserveQueueModuleDiagnostics {
  pending: number;
  dueNow: number;
  nextAttemptAt?: number;
  latestQueuedAt?: number;
  lastError?: string;
}

export interface ObserveQueueDiagnostics {
  totalPending: number;
  totalDueNow: number;
  oldestCreatedAt?: number;
  byModule: Record<string, ObserveQueueModuleDiagnostics>;
}

export class DurableObserveQueue {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const absoluteDbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(absoluteDbPath), { recursive: true });
    this.db = new Database(absoluteDbPath);
    this.db.pragma("journal_mode = WAL");
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  enqueue(
    moduleKey: string,
    eventJson: string,
    attemptCount: number,
    nextAttemptAt: number,
    lastError?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO observe_delivery_queue (module_key, event_json, attempt_count, next_attempt_at, last_error)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(moduleKey, eventJson, attemptCount, nextAttemptAt, lastError ?? null);
  }

  listDue(nowMs: number, limit: number): DurableQueueRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, module_key, event_json, attempt_count, next_attempt_at
         FROM observe_delivery_queue
         WHERE next_attempt_at <= ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(nowMs, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: Number(row.id),
      moduleKey: String(row.module_key),
      eventJson: String(row.event_json),
      attemptCount: Number(row.attempt_count),
      nextAttemptAt: Number(row.next_attempt_at),
    }));
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM observe_delivery_queue WHERE id = ?").run(id);
  }

  markFailure(id: number, attemptCount: number, nextAttemptAt: number, lastError: string): void {
    this.db
      .prepare(
        `UPDATE observe_delivery_queue
         SET attempt_count = ?, next_attempt_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(attemptCount, nextAttemptAt, lastError, id);
  }

  getDiagnostics(nowMs: number): ObserveQueueDiagnostics {
    const totalsRow = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_pending,
           SUM(CASE WHEN next_attempt_at <= ? THEN 1 ELSE 0 END) AS total_due_now,
           MIN(created_at) AS oldest_created_at
         FROM observe_delivery_queue`,
      )
      .get(nowMs) as Record<string, unknown>;

    const moduleRows = this.db
      .prepare(
        `SELECT
           q1.module_key,
           COUNT(*) AS pending,
           SUM(CASE WHEN q1.next_attempt_at <= ? THEN 1 ELSE 0 END) AS due_now,
           MIN(q1.next_attempt_at) AS next_attempt_at,
           MAX(q1.created_at) AS latest_queued_at,
           (
             SELECT q2.last_error
             FROM observe_delivery_queue q2
             WHERE q2.module_key = q1.module_key
               AND q2.last_error IS NOT NULL
               AND TRIM(q2.last_error) <> ''
             ORDER BY q2.id DESC
             LIMIT 1
           ) AS last_error
         FROM observe_delivery_queue q1
         GROUP BY q1.module_key`,
      )
      .all(nowMs) as Array<Record<string, unknown>>;

    const byModule: Record<string, ObserveQueueModuleDiagnostics> = {};
    for (const row of moduleRows) {
      const moduleKey = String(row.module_key);
      byModule[moduleKey] = {
        pending: Number(row.pending ?? 0),
        dueNow: Number(row.due_now ?? 0),
        nextAttemptAt:
          row.next_attempt_at === null || row.next_attempt_at === undefined
            ? undefined
            : Number(row.next_attempt_at),
        latestQueuedAt:
          row.latest_queued_at === null || row.latest_queued_at === undefined
            ? undefined
            : Number(row.latest_queued_at),
        lastError:
          typeof row.last_error === "string" && row.last_error.trim().length > 0
            ? row.last_error
            : undefined,
      };
    }

    const oldestCreatedAt =
      totalsRow.oldest_created_at === null || totalsRow.oldest_created_at === undefined
        ? undefined
        : Number(totalsRow.oldest_created_at);

    return {
      totalPending: Number(totalsRow.total_pending ?? 0),
      totalDueNow: Number(totalsRow.total_due_now ?? 0),
      oldestCreatedAt,
      byModule,
    };
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observe_delivery_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_key TEXT NOT NULL,
        event_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_observe_delivery_queue_due
        ON observe_delivery_queue (next_attempt_at, id);
      CREATE INDEX IF NOT EXISTS idx_observe_delivery_queue_module
        ON observe_delivery_queue (module_key);
    `);
  }
}
