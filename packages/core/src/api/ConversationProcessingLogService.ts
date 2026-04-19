import Database from "better-sqlite3";

export type ProcessingMessageRole =
  | "prompt"
  | "tool-call"
  | "tool-result"
  | "agent-transfer"
  | "model-call"
  | "model-response"
  | "graph-definition"
  | "system-event";

const PROCESSING_ROLES = new Set<ProcessingMessageRole>([
  "prompt",
  "tool-call",
  "tool-result",
  "agent-transfer",
  "model-call",
  "model-response",
  "graph-definition",
  "system-event",
]);

function isProcessingMessageRole(value: string): value is ProcessingMessageRole {
  return PROCESSING_ROLES.has(value as ProcessingMessageRole);
}

export interface ConversationProcessingLogEntry {
  threadId: string;
  role: ProcessingMessageRole;
  content: string;
  createdAt?: string;
  toolName?: string;
}

interface ProcessingRow {
  id: number;
  role: string;
  content: string;
  created_at: string;
  tool_name: string | null;
}

/**
 * Persists non-checkpoint observability events so history views can replay
 * prompt/tool/model processing details after a page refresh.
 */
export class ConversationProcessingLogService {
  constructor(private readonly dbPath: string) {}

  ensureSchema(): void {
    const db = new Database(this.dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_processing_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tool_name TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_processing_events_thread_id_id
          ON conversation_processing_events(thread_id, id);
      `);
    } finally {
      db.close();
    }
  }

  append(entry: ConversationProcessingLogEntry): void {
    const db = new Database(this.dbPath);
    try {
      db.prepare(`
        INSERT INTO conversation_processing_events (thread_id, role, content, tool_name, created_at)
        VALUES (?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      `).run(
        entry.threadId,
        entry.role,
        entry.content,
        entry.toolName ?? null,
        entry.createdAt ?? null,
      );
    } finally {
      db.close();
    }
  }

  list(threadId: string): Array<{
    id: string;
    role: ProcessingMessageRole;
    content: string;
    receivedAt: string;
    toolName?: string;
  }> {
    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare<[string], ProcessingRow>(`
        SELECT id, role, content, created_at, tool_name
        FROM conversation_processing_events
        WHERE thread_id = ?
        ORDER BY id ASC
      `).all(threadId);

      const events: Array<{
        id: string;
        role: ProcessingMessageRole;
        content: string;
        receivedAt: string;
        toolName?: string;
      }> = [];

      for (const row of rows) {
        if (!isProcessingMessageRole(row.role)) continue;
        events.push({
          id: `processing-${row.id}`,
          role: row.role,
          content: row.content,
          receivedAt: row.created_at,
          ...(typeof row.tool_name === "string" && row.tool_name.trim().length > 0
            ? { toolName: row.tool_name }
            : {}),
        });
      }

      return events;
    } catch {
      return [];
    } finally {
      db.close();
    }
  }
}