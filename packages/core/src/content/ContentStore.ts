import Database from "better-sqlite3";

export interface ContentStoreConfig {
  dbPath: string;
}

export interface CreateUploadSessionInput {
  uploadId: string;
  contentRef: string;
  conversationId: string;
  toolName: string;
  fileName?: string;
  mimeType?: string;
  expectedBytes?: number;
  systemPromptText?: string;
  systemPromptHash?: string;
  expiresAt: string;
}

export interface UploadSessionRecord {
  uploadId: string;
  contentRef: string;
  conversationId: string;
  toolName: string;
  status: "pending" | "complete" | "aborted";
  expectedBytes?: number;
  receivedBytes: number;
  expiresAt: string;
}

export interface ContentMetadata {
  contentRef: string;
  conversationId: string;
  toolName: string;
  fileName?: string;
  mimeType?: string;
  byteLength: number;
  sha256?: string;
  createdAt: string;
  deletedAt?: string;
}

export interface ListContentMetadataOptions {
  conversationId?: string;
  toolName?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Dedicated SQLite store for uploaded tool-generated content.
 *
 * This intentionally remains separate from checkpoints/auth tables so binary
 * payload churn does not impact conversation checkpoint storage patterns.
 */
export class ContentStore {
  private readonly db: Database.Database;

  constructor(config: ContentStoreConfig) {
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_items (
        content_ref TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        file_name TEXT,
        mime_type TEXT,
        byte_length INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        system_prompt_text TEXT,
        system_prompt_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS content_chunks (
        content_ref TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        data BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (content_ref, chunk_index),
        FOREIGN KEY (content_ref) REFERENCES content_items(content_ref) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_content_items_conversation_id
        ON content_items(conversation_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_content_items_tool_name
        ON content_items(tool_name, created_at DESC);

      CREATE TABLE IF NOT EXISTS content_upload_sessions (
        upload_id TEXT PRIMARY KEY,
        content_ref TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        expected_bytes INTEGER,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (content_ref) REFERENCES content_items(content_ref) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_upload_sessions_content_ref
        ON content_upload_sessions(content_ref);

      CREATE INDEX IF NOT EXISTS idx_upload_sessions_status
        ON content_upload_sessions(status, expires_at);
    `);
  }

  createUploadSession(input: CreateUploadSessionInput): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO content_items (
              content_ref,
              conversation_id,
              tool_name,
              file_name,
              mime_type,
              byte_length,
              system_prompt_text,
              system_prompt_hash
            ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
          `,
        )
        .run(
          input.contentRef,
          input.conversationId,
          input.toolName,
          input.fileName ?? null,
          input.mimeType ?? null,
          input.systemPromptText ?? null,
          input.systemPromptHash ?? null,
        );

      this.db
        .prepare(
          `
            INSERT INTO content_upload_sessions (
              upload_id,
              content_ref,
              conversation_id,
              tool_name,
              expected_bytes,
              received_bytes,
              status,
              expires_at
            ) VALUES (?, ?, ?, ?, ?, 0, 'pending', ?)
          `,
        )
        .run(
          input.uploadId,
          input.contentRef,
          input.conversationId,
          input.toolName,
          input.expectedBytes ?? null,
          input.expiresAt,
        );
    });

    tx();
  }

  getUploadSession(uploadId: string): UploadSessionRecord | undefined {
    const row = this.db
      .prepare<
        [string],
        {
          upload_id: string;
          content_ref: string;
          conversation_id: string;
          tool_name: string;
          status: string;
          expected_bytes: number | null;
          received_bytes: number;
          expires_at: string;
        }
      >(
        `
          SELECT upload_id, content_ref, conversation_id, tool_name, status, expected_bytes, received_bytes, expires_at
          FROM content_upload_sessions
          WHERE upload_id = ?
          LIMIT 1
        `,
      )
      .get(uploadId);

    if (!row) return undefined;
    return {
      uploadId: row.upload_id,
      contentRef: row.content_ref,
      conversationId: row.conversation_id,
      toolName: row.tool_name,
      status:
        row.status === "complete"
          ? "complete"
          : row.status === "aborted"
            ? "aborted"
            : "pending",
      expectedBytes: row.expected_bytes ?? undefined,
      receivedBytes: row.received_bytes,
      expiresAt: row.expires_at,
    };
  }

  appendUploadChunk(uploadId: string, chunkIndex: number, data: Buffer): number {
    const session = this.getUploadSession(uploadId);
    if (!session) {
      throw new Error("Unknown upload session");
    }
    if (session.status !== "pending") {
      throw new Error("Upload session is not pending");
    }

    const existing = this.db
      .prepare<[string, number], { count: number }>(
        `SELECT COUNT(1) AS count FROM content_chunks WHERE content_ref = ? AND chunk_index = ?`,
      )
      .get(session.contentRef, chunkIndex);
    if ((existing?.count ?? 0) > 0) {
      throw new Error(`Chunk ${chunkIndex} already exists`);
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO content_chunks (content_ref, chunk_index, data) VALUES (?, ?, ?)`,
        )
        .run(session.contentRef, chunkIndex, data);

      this.db
        .prepare(
          `
            UPDATE content_upload_sessions
            SET received_bytes = received_bytes + ?,
                updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            WHERE upload_id = ?
          `,
        )
        .run(data.byteLength, uploadId);

      this.db
        .prepare(
          `
            UPDATE content_items
            SET byte_length = byte_length + ?
            WHERE content_ref = ?
          `,
        )
        .run(data.byteLength, session.contentRef);
    });

    tx();

    const updated = this.getUploadSession(uploadId);
    return updated?.receivedBytes ?? 0;
  }

  finalizeUploadSession(uploadId: string, sha256?: string): ContentMetadata {
    const session = this.getUploadSession(uploadId);
    if (!session) {
      throw new Error("Unknown upload session");
    }
    if (session.status !== "pending") {
      throw new Error("Upload session is not pending");
    }

    if (session.expectedBytes !== undefined && session.expectedBytes !== session.receivedBytes) {
      throw new Error(
        `Upload byte count mismatch: expected ${session.expectedBytes}, received ${session.receivedBytes}`,
      );
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE content_upload_sessions
            SET status = 'complete',
                updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            WHERE upload_id = ?
          `,
        )
        .run(uploadId);

      this.db
        .prepare(
          `
            UPDATE content_items
            SET sha256 = COALESCE(?, sha256)
            WHERE content_ref = ?
          `,
        )
        .run(sha256 ?? null, session.contentRef);
    });

    tx();

    const metadata = this.getContentMetadata(session.contentRef);
    if (!metadata) {
      throw new Error("Uploaded content metadata not found");
    }
    return metadata;
  }

  abortUploadSession(uploadId: string): void {
    const session = this.getUploadSession(uploadId);
    if (!session) return;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE content_upload_sessions
            SET status = 'aborted',
                updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            WHERE upload_id = ?
          `,
        )
        .run(uploadId);

      this.db
        .prepare(`DELETE FROM content_items WHERE content_ref = ?`)
        .run(session.contentRef);
    });

    tx();
  }

  getContentMetadata(contentRef: string): ContentMetadata | undefined {
    const row = this.db
      .prepare<
        [string],
        {
          content_ref: string;
          conversation_id: string;
          tool_name: string;
          file_name: string | null;
          mime_type: string | null;
          byte_length: number;
          sha256: string | null;
          created_at: string;
          deleted_at: string | null;
        }
      >(
        `
          SELECT content_ref, conversation_id, tool_name, file_name, mime_type, byte_length, sha256, created_at, deleted_at
          FROM content_items
          WHERE content_ref = ?
          LIMIT 1
        `,
      )
      .get(contentRef);

    if (!row) return undefined;
    return {
      contentRef: row.content_ref,
      conversationId: row.conversation_id,
      toolName: row.tool_name,
      fileName: row.file_name ?? undefined,
      mimeType: row.mime_type ?? undefined,
      byteLength: row.byte_length,
      sha256: row.sha256 ?? undefined,
      createdAt: row.created_at,
      deletedAt: row.deleted_at ?? undefined,
    };
  }

  getContentBytes(contentRef: string): Buffer | undefined {
    const row = this.db
      .prepare<[string], { deleted_at: string | null }>(
        `SELECT deleted_at FROM content_items WHERE content_ref = ? LIMIT 1`,
      )
      .get(contentRef);

    if (!row) return undefined;
    if (row.deleted_at) return undefined;

    const chunks = this.db
      .prepare<[string], { data: Buffer }>(
        `
          SELECT data
          FROM content_chunks
          WHERE content_ref = ?
          ORDER BY chunk_index ASC
        `,
      )
      .all(contentRef);

    if (chunks.length === 0) return Buffer.alloc(0);
    return Buffer.concat(chunks.map((chunk) => chunk.data));
  }

  deleteContent(contentRef: string): void {
    this.db
      .prepare(
        `
          UPDATE content_items
          SET deleted_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          WHERE content_ref = ?
        `,
      )
      .run(contentRef);
  }

  listContentMetadata(options: ListContentMetadataOptions = {}): ContentMetadata[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.conversationId?.trim()) {
      clauses.push("conversation_id = ?");
      params.push(options.conversationId.trim());
    }

    if (options.toolName?.trim()) {
      clauses.push("tool_name = ?");
      params.push(options.toolName.trim());
    }

    if (!options.includeDeleted) {
      clauses.push("deleted_at IS NULL");
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Number.isFinite(options.limit) ? Math.min(Math.max(options.limit ?? 100, 1), 500) : 100;
    const offset = Number.isFinite(options.offset) ? Math.max(options.offset ?? 0, 0) : 0;

    const rows = this.db
      .prepare<
        unknown[],
        {
          content_ref: string;
          conversation_id: string;
          tool_name: string;
          file_name: string | null;
          mime_type: string | null;
          byte_length: number;
          sha256: string | null;
          created_at: string;
          deleted_at: string | null;
        }
      >(
        `
          SELECT content_ref, conversation_id, tool_name, file_name, mime_type, byte_length, sha256, created_at, deleted_at
          FROM content_items
          ${whereClause}
          ORDER BY created_at DESC, content_ref DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...params, limit, offset);

    return rows.map((row) => ({
      contentRef: row.content_ref,
      conversationId: row.conversation_id,
      toolName: row.tool_name,
      fileName: row.file_name ?? undefined,
      mimeType: row.mime_type ?? undefined,
      byteLength: row.byte_length,
      sha256: row.sha256 ?? undefined,
      createdAt: row.created_at,
      deletedAt: row.deleted_at ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}
