import Database from "better-sqlite3";

interface TitleRow {
  title: string;
}

export class ConversationMetadataService {
  constructor(private readonly dbPath: string) {}

  ensureSchema(): void {
    const db = new Database(this.dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_metadata (
          thread_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
      `);
    } finally {
      db.close();
    }
  }

  getTitle(threadId: string): string | undefined {
    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare<[string], TitleRow>("SELECT title FROM conversation_metadata WHERE thread_id = ? LIMIT 1")
        .get(threadId);
      return row?.title;
    } finally {
      db.close();
    }
  }

  upsertTitle(threadId: string, title: string): void {
    const db = new Database(this.dbPath, { fileMustExist: true });
    try {
      db
        .prepare(
          `
          INSERT INTO conversation_metadata (thread_id, title)
          VALUES (?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET
            title = excluded.title,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          `,
        )
        .run(threadId, title);
    } finally {
      db.close();
    }
  }
}
