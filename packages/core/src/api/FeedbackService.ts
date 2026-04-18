import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";

export type FeedbackSignal = "like" | "dislike";

export interface PromptCatalogInput {
  agentKey: string;
  modelKey: string;
  promptOriginal: string;
  promptResolved: string;
}

export interface PromptUsageInput {
  conversationId?: string;
  runId?: string;
  batchIndex?: number;
  modelName: string;
  modelKey?: string;
  promptResolved?: string;
  promptResolvedHash?: string;
}

export interface PromptUsageRecord {
  usageId: string;
  promptCatalogId?: string;
  modelKey?: string;
  modelName: string;
  promptOriginal?: string;
  promptOriginalHash?: string;
  promptResolved?: string;
  promptResolvedHash?: string;
  runId?: string;
  batchIndex: number;
  conversationId?: string;
}

export interface FeedbackEventInput {
  conversationId: string;
  messageId: string;
  messageRole: string;
  signal: FeedbackSignal;
  modelName: string;
  modelKey?: string;
  promptUsageId?: string;
  promptOriginalHash?: string;
  promptResolvedHash?: string;
  checkpointId?: string;
  agentKey?: string;
  sourceView?: "live" | "history";
  note?: string;
  userId?: string;
}

export interface PromptDiagnosisRow {
  promptResolvedHash: string;
  promptText: string;
  likeCount: number;
  dislikeCount: number;
  signalCount: number;
  latestDislikedMessage: string;
  latestFeedbackAt: string;
}

export interface PromptDiagnosisSummary {
  mostLiked: PromptDiagnosisRow[];
  mostDisliked: PromptDiagnosisRow[];
}

interface PromptCatalogRow {
  id: string;
  agent_key: string;
  model_key: string;
  prompt_original: string;
  prompt_original_hash: string;
  prompt_resolved: string;
  prompt_resolved_hash: string;
}

interface PromptUsageRow {
  id: string;
  prompt_catalog_id: string | null;
  model_key: string | null;
  model_name: string;
  prompt_original: string | null;
  prompt_original_hash: string | null;
  prompt_resolved: string | null;
  prompt_resolved_hash: string | null;
  run_id: string | null;
  batch_index: number;
  conversation_id: string | null;
}

interface FeedbackEventRow {
  id: string;
  conversation_id: string;
  message_id: string;
  message_role: string;
  signal: FeedbackSignal;
  model_name: string;
  model_key: string | null;
  prompt_usage_id: string | null;
  prompt_original_hash: string | null;
  prompt_resolved_hash: string | null;
  checkpoint_id: string | null;
  agent_key: string | null;
  source_view: string | null;
  note: string | null;
  user_id: string | null;
  created_at: string;
}

interface PromptDiagnosisSqlRow {
  prompt_resolved_hash: string;
  prompt_text: string;
  like_count: number;
  dislike_count: number;
  signal_count: number;
  latest_disliked_message: string | null;
  latest_feedback_at: string;
}

export class FeedbackService {
  constructor(private readonly dbPath: string) {}

  ensureSchema(): void {
    const db = new Database(this.dbPath);
    try {
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_catalog (
          id TEXT PRIMARY KEY,
          agent_key TEXT NOT NULL,
          model_key TEXT NOT NULL,
          prompt_original TEXT NOT NULL,
          prompt_original_hash TEXT NOT NULL,
          prompt_resolved TEXT NOT NULL,
          prompt_resolved_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE(prompt_original_hash, prompt_resolved_hash, model_key, agent_key)
        );

        CREATE TABLE IF NOT EXISTS prompt_usage_events (
          id TEXT PRIMARY KEY,
          prompt_catalog_id TEXT,
          model_key TEXT,
          model_name TEXT NOT NULL,
          prompt_original TEXT,
          prompt_original_hash TEXT,
          prompt_resolved TEXT,
          prompt_resolved_hash TEXT,
          run_id TEXT,
          batch_index INTEGER NOT NULL DEFAULT 1,
          conversation_id TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE(run_id, batch_index),
          FOREIGN KEY(prompt_catalog_id) REFERENCES prompt_catalog(id)
        );

        CREATE TABLE IF NOT EXISTS ui_feedback_events (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          message_role TEXT NOT NULL,
          signal TEXT NOT NULL,
          model_name TEXT NOT NULL,
          model_key TEXT,
          prompt_usage_id TEXT,
          prompt_original_hash TEXT,
          prompt_resolved_hash TEXT,
          checkpoint_id TEXT,
          agent_key TEXT,
          source_view TEXT,
          note TEXT,
          user_id TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE(conversation_id, message_id),
          FOREIGN KEY(prompt_usage_id) REFERENCES prompt_usage_events(id)
        );

        CREATE INDEX IF NOT EXISTS idx_prompt_catalog_resolved_hash
          ON prompt_catalog(prompt_resolved_hash);
        CREATE INDEX IF NOT EXISTS idx_prompt_usage_conversation
          ON prompt_usage_events(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_prompt_usage_resolved_hash
          ON prompt_usage_events(prompt_resolved_hash);
        CREATE INDEX IF NOT EXISTS idx_feedback_prompt_resolved_hash
          ON ui_feedback_events(prompt_resolved_hash);
        CREATE INDEX IF NOT EXISTS idx_feedback_message
          ON ui_feedback_events(conversation_id, message_id);
        CREATE INDEX IF NOT EXISTS idx_feedback_model
          ON ui_feedback_events(model_key, model_name);
      `);
    } finally {
      db.close();
    }
  }

  logPromptCatalog(input: PromptCatalogInput): void {
    const promptOriginalHash = computePromptHash(input.promptOriginal);
    const promptResolvedHash = computePromptHash(input.promptResolved);
    const db = new Database(this.dbPath, { fileMustExist: true });
    try {
      db
        .prepare(
          `
          INSERT INTO prompt_catalog (
            id,
            agent_key,
            model_key,
            prompt_original,
            prompt_original_hash,
            prompt_resolved,
            prompt_resolved_hash
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(prompt_original_hash, prompt_resolved_hash, model_key, agent_key) DO NOTHING
          `,
        )
        .run(
          uuidv4(),
          input.agentKey,
          input.modelKey,
          input.promptOriginal,
          promptOriginalHash,
          input.promptResolved,
          promptResolvedHash,
        );
    } finally {
      db.close();
    }
  }

  logPromptUsage(input: PromptUsageInput): PromptUsageRecord {
    const batchIndex = Math.max(1, input.batchIndex ?? 1);
    const promptResolved = input.promptResolved;
    const promptResolvedHash = input.promptResolvedHash ?? (promptResolved ? computePromptHash(promptResolved) : undefined);

    const db = new Database(this.dbPath, { fileMustExist: true });
    try {
      const catalog = promptResolvedHash
        ? db
            .prepare<[string], PromptCatalogRow>(
              `
              SELECT id, agent_key, model_key, prompt_original, prompt_original_hash, prompt_resolved, prompt_resolved_hash
              FROM prompt_catalog
              WHERE prompt_resolved_hash = ?
              ORDER BY created_at DESC
              LIMIT 1
              `,
            )
            .get(promptResolvedHash)
        : undefined;

      const usageId = uuidv4();
      db
        .prepare(
          `
          INSERT INTO prompt_usage_events (
            id,
            prompt_catalog_id,
            model_key,
            model_name,
            prompt_original,
            prompt_original_hash,
            prompt_resolved,
            prompt_resolved_hash,
            run_id,
            batch_index,
            conversation_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, batch_index) DO UPDATE SET
            model_key = excluded.model_key,
            model_name = excluded.model_name,
            prompt_original = excluded.prompt_original,
            prompt_original_hash = excluded.prompt_original_hash,
            prompt_resolved = excluded.prompt_resolved,
            prompt_resolved_hash = excluded.prompt_resolved_hash,
            conversation_id = excluded.conversation_id
          `,
        )
        .run(
          usageId,
          catalog?.id ?? null,
          input.modelKey ?? catalog?.model_key ?? null,
          input.modelName,
          catalog?.prompt_original ?? null,
          catalog?.prompt_original_hash ?? null,
          promptResolved ?? catalog?.prompt_resolved ?? null,
          promptResolvedHash ?? catalog?.prompt_resolved_hash ?? null,
          input.runId ?? null,
          batchIndex,
          input.conversationId ?? null,
        );

      const row = db
        .prepare<[string | null, number], PromptUsageRow>(
          `
          SELECT
            id,
            prompt_catalog_id,
            model_key,
            model_name,
            prompt_original,
            prompt_original_hash,
            prompt_resolved,
            prompt_resolved_hash,
            run_id,
            batch_index,
            conversation_id
          FROM prompt_usage_events
          WHERE run_id IS ? AND batch_index = ?
          ORDER BY created_at DESC
          LIMIT 1
          `,
        )
        .get(input.runId ?? null, batchIndex);

      return {
        usageId: row?.id ?? usageId,
        promptCatalogId: row?.prompt_catalog_id ?? undefined,
        modelKey: row?.model_key ?? undefined,
        modelName: row?.model_name ?? input.modelName,
        promptOriginal: row?.prompt_original ?? undefined,
        promptOriginalHash: row?.prompt_original_hash ?? undefined,
        promptResolved: row?.prompt_resolved ?? promptResolved,
        promptResolvedHash: row?.prompt_resolved_hash ?? promptResolvedHash,
        runId: row?.run_id ?? input.runId,
        batchIndex: row?.batch_index ?? batchIndex,
        conversationId: row?.conversation_id ?? input.conversationId,
      };
    } finally {
      db.close();
    }
  }

  upsertFeedbackEvent(input: FeedbackEventInput): FeedbackEventRow {
    const id = uuidv4();
    const db = new Database(this.dbPath, { fileMustExist: true });
    try {
      db
        .prepare(
          `
          INSERT INTO ui_feedback_events (
            id,
            conversation_id,
            message_id,
            message_role,
            signal,
            model_name,
            model_key,
            prompt_usage_id,
            prompt_original_hash,
            prompt_resolved_hash,
            checkpoint_id,
            agent_key,
            source_view,
            note,
            user_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id, message_id) DO UPDATE SET
            signal = excluded.signal,
            message_role = excluded.message_role,
            model_name = excluded.model_name,
            model_key = excluded.model_key,
            prompt_usage_id = excluded.prompt_usage_id,
            prompt_original_hash = excluded.prompt_original_hash,
            prompt_resolved_hash = excluded.prompt_resolved_hash,
            checkpoint_id = excluded.checkpoint_id,
            agent_key = excluded.agent_key,
            source_view = excluded.source_view,
            note = excluded.note,
            user_id = excluded.user_id,
            created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          `,
        )
        .run(
          id,
          input.conversationId,
          input.messageId,
          input.messageRole,
          input.signal,
          input.modelName,
          input.modelKey ?? null,
          input.promptUsageId ?? null,
          input.promptOriginalHash ?? null,
          input.promptResolvedHash ?? null,
          input.checkpointId ?? null,
          input.agentKey ?? null,
          input.sourceView ?? null,
          input.note ?? null,
          input.userId ?? null,
        );

      const row = db
        .prepare<[string, string], FeedbackEventRow>(
          `
          SELECT
            id,
            conversation_id,
            message_id,
            message_role,
            signal,
            model_name,
            model_key,
            prompt_usage_id,
            prompt_original_hash,
            prompt_resolved_hash,
            checkpoint_id,
            agent_key,
            source_view,
            note,
            user_id,
            created_at
          FROM ui_feedback_events
          WHERE conversation_id = ? AND message_id = ?
          LIMIT 1
          `,
        )
        .get(input.conversationId, input.messageId);

      if (!row) {
        throw new Error("Failed to persist feedback event");
      }
      return row;
    } finally {
      db.close();
    }
  }

  getFeedbackEvent(id: string): FeedbackEventRow | undefined {
    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      return db
        .prepare<[string], FeedbackEventRow>(
          `
          SELECT
            id,
            conversation_id,
            message_id,
            message_role,
            signal,
            model_name,
            model_key,
            prompt_usage_id,
            prompt_original_hash,
            prompt_resolved_hash,
            checkpoint_id,
            agent_key,
            source_view,
            note,
            user_id,
            created_at
          FROM ui_feedback_events
          WHERE id = ?
          LIMIT 1
          `,
        )
        .get(id);
    } finally {
      db.close();
    }
  }

  getFeedbackByMessage(conversationId: string, messageId: string): FeedbackEventRow | undefined {
    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      return db
        .prepare<[string, string], FeedbackEventRow>(
          `
          SELECT
            id,
            conversation_id,
            message_id,
            message_role,
            signal,
            model_name,
            model_key,
            prompt_usage_id,
            prompt_original_hash,
            prompt_resolved_hash,
            checkpoint_id,
            agent_key,
            source_view,
            note,
            user_id,
            created_at
          FROM ui_feedback_events
          WHERE conversation_id = ? AND message_id = ?
          LIMIT 1
          `,
        )
        .get(conversationId, messageId);
    } finally {
      db.close();
    }
  }

  getPromptDiagnosisSummary(limit = 10): PromptDiagnosisSummary {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 10;
    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      const mostLiked = this.queryPromptDiagnosisBySignal(db, "like", safeLimit);
      const mostDisliked = this.queryPromptDiagnosisBySignal(db, "dislike", safeLimit);
      return { mostLiked, mostDisliked };
    } finally {
      db.close();
    }
  }

  private queryPromptDiagnosisBySignal(
    db: Database.Database,
    signal: FeedbackSignal,
    limit: number,
  ): PromptDiagnosisRow[] {
    const rows = db
      .prepare<[FeedbackSignal, number], PromptDiagnosisSqlRow>(
        `
        SELECT
          events.prompt_resolved_hash,
          (
            SELECT pue.prompt_resolved
            FROM prompt_usage_events AS pue
            WHERE pue.prompt_resolved_hash = events.prompt_resolved_hash
              AND pue.prompt_resolved IS NOT NULL
              AND TRIM(pue.prompt_resolved) <> ''
            ORDER BY pue.created_at DESC
            LIMIT 1
          ) AS prompt_text,
          SUM(CASE WHEN events.signal = 'like' THEN 1 ELSE 0 END) AS like_count,
          SUM(CASE WHEN events.signal = 'dislike' THEN 1 ELSE 0 END) AS dislike_count,
          SUM(CASE WHEN events.signal = ? THEN 1 ELSE 0 END) AS signal_count,
          (
            SELECT disliked.note
            FROM ui_feedback_events AS disliked
            WHERE disliked.prompt_resolved_hash = events.prompt_resolved_hash
              AND disliked.signal = 'dislike'
              AND disliked.note IS NOT NULL
              AND TRIM(disliked.note) <> ''
            ORDER BY disliked.created_at DESC
            LIMIT 1
          ) AS latest_disliked_message,
          MAX(events.created_at) AS latest_feedback_at
        FROM ui_feedback_events AS events
        WHERE events.prompt_resolved_hash IS NOT NULL
          AND TRIM(events.prompt_resolved_hash) <> ''
        GROUP BY events.prompt_resolved_hash
        HAVING signal_count > 0
          AND prompt_text IS NOT NULL
          AND TRIM(prompt_text) <> ''
        ORDER BY signal_count DESC, latest_feedback_at DESC
        LIMIT ?
        `,
      )
      .all(signal, limit);

    return rows.map((row) => ({
      promptResolvedHash: row.prompt_resolved_hash,
      promptText: row.prompt_text,
      likeCount: row.like_count,
      dislikeCount: row.dislike_count,
      signalCount: row.signal_count,
      latestDislikedMessage: row.latest_disliked_message?.trim() ?? "",
      latestFeedbackAt: row.latest_feedback_at,
    }));
  }
}

export function computePromptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
