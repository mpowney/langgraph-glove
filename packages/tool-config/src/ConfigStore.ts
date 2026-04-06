import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ConfigVersion {
  id: string;
  filename: string;
  content: string;
  savedAt: string;
  description?: string;
}

export interface ConfigVersionSummary {
  id: string;
  filename: string;
  savedAt: string;
  description?: string;
  /** Number of characters in the stored content */
  contentLength: number;
}

/**
 * SQLite-backed store for config file version history.
 *
 * Each time a config file is written via the config tool, the previous
 * content is saved here for auditing and rollback purposes.
 */
export class ConfigStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config_history (
        id          TEXT PRIMARY KEY,
        filename    TEXT NOT NULL,
        content     TEXT NOT NULL,
        saved_at    TEXT NOT NULL,
        description TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_config_history_filename
        ON config_history(filename, saved_at DESC);
    `);
  }

  /**
   * Save a snapshot of the current config file content before it is overwritten.
   */
  saveVersion(filename: string, content: string, description?: string): ConfigVersionSummary {
    const id = randomUUID();
    const savedAt = new Date().toISOString();

    const stmt = this.db.prepare(
      `INSERT INTO config_history (id, filename, content, saved_at, description)
       VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run(id, filename, content, savedAt, description ?? null);

    return {
      id,
      filename,
      savedAt,
      description,
      contentLength: content.length,
    };
  }

  /**
   * List all stored versions for a given filename, newest first.
   */
  listVersions(filename: string): ConfigVersionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, filename, saved_at, description, length(content) AS content_length
         FROM config_history
         WHERE filename = ?
         ORDER BY saved_at DESC`,
      )
      .all(filename) as Array<{
      id: string;
      filename: string;
      saved_at: string;
      description: string | null;
      content_length: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      savedAt: r.saved_at,
      description: r.description ?? undefined,
      contentLength: r.content_length,
    }));
  }

  /**
   * Retrieve a specific version by ID.
   */
  getVersion(id: string): ConfigVersion | null {
    const row = this.db
      .prepare(
        `SELECT id, filename, content, saved_at, description
         FROM config_history
         WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          filename: string;
          content: string;
          saved_at: string;
          description: string | null;
        }
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      filename: row.filename,
      content: row.content,
      savedAt: row.saved_at,
      description: row.description ?? undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
