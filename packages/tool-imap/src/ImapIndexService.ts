import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  ConfigLoader,
  EmbeddingRegistry,
  type ImapToolConfig,
  type ToolServerEntry,
} from "@langgraph-glove/config";

export interface CrawlInput {
  folder?: string;
  since?: string;
  full?: boolean;
}

export interface SearchInput {
  query: string;
  folder?: string;
  limit?: number;
}

export interface GetEmailInput {
  emailId?: string;
  folder?: string;
  uid?: number;
  messageId?: string;
}

export interface GetThreadInput {
  threadId?: string;
  messageId?: string;
  limit?: number;
}

export interface ReindexInput {
  emailId?: string;
  folder?: string;
  uid?: number;
}

interface ResolvedImapSettings {
  toolKey: string;
  host: string;
  port: number;
  secure: boolean;
  tlsRejectUnauthorized: boolean;
  user: string;
  password?: string;
  accessToken?: string;
  mailbox: string;
  crawlMode: "manual" | "startup" | "continuous-sync";
  folders: string[];
  allFoldersExcept: string[];
  batchSize: number;
  pollIntervalMs: number;
  chunkSize: number;
  chunkOverlap: number;
  embeddingModelKey: string;
  indexingStrategy: "immediate" | "deferred";
  indexDbPath: string;
  urlTemplate?: string;
}

interface EmailRow {
  id: string;
  folder: string;
  uid: number;
  message_id: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  subject: string;
  subject_slug: string;
  from_addr: string;
  to_addrs: string;
  sent_at: string | null;
  body_text: string;
  body_hash: string;
  item_url: string | null;
  created_at: string;
  updated_at: string;
}

interface ChunkRow {
  id: string;
  email_id: string;
  chunk_index: number;
  content: string;
  vector_json: string | null;
  embedding_status: string | null;
  folder: string;
  subject: string;
  from_addr: string;
  sent_at: string | null;
  item_url: string | null;
}

interface ParsedEmailRecord {
  id: string;
  folder: string;
  uid: number;
  messageId: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  subject: string;
  subjectSlug: string;
  fromAddr: string;
  toAddrs: string[];
  sentAt: string | null;
  bodyText: string;
  bodyHash: string;
  itemUrl: string | null;
}

interface ChunkRecord {
  id: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  content: string;
}

export class ImapIndexService {
  private readonly settings: ResolvedImapSettings;
  private readonly db: Database.Database;
  private readonly embeddingRegistry: EmbeddingRegistry;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly configDir: string;

  constructor(options: { toolKey: string; configDir?: string; secretsDir?: string }) {
    this.configDir = path.resolve(options.configDir ?? process.env["GLOVE_CONFIG_DIR"] ?? "config");
    const secretsDir = path.resolve(options.secretsDir ?? process.env["GLOVE_SECRETS_DIR"] ?? "secrets");

    const loader = new ConfigLoader(this.configDir, secretsDir);
    const config = loader.load();
    this.embeddingRegistry = new EmbeddingRegistry(config.models);

    const entry = config.tools[options.toolKey] as ToolServerEntry | undefined;
    if (!entry?.imap) {
      throw new Error(`tools.json entry "${options.toolKey}" must define an "imap" configuration block`);
    }

    this.settings = this.resolveSettings(options.toolKey, entry.imap);
    const dbPath = this.resolveProjectPath(this.settings.indexDbPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();

    if (this.settings.indexingStrategy === "immediate") {
      this.embeddingRegistry.get(this.settings.embeddingModelKey);
    }
  }

  async start(): Promise<void> {
    if (this.settings.crawlMode === "startup" || this.settings.crawlMode === "continuous-sync") {
      await this.crawl({ full: false });
    }

    if (this.settings.crawlMode === "continuous-sync") {
      this.pollTimer = setInterval(() => {
        void this.crawl({ full: false }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[tool-imap] poll crawl failed: ${message}\n`);
        });
      }, this.settings.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  status(): Record<string, unknown> {
    const messageCount = this.db.prepare("SELECT COUNT(*) AS count FROM imap_emails").get() as { count: number };
    const chunkCount = this.db.prepare("SELECT COUNT(*) AS count FROM imap_email_chunks").get() as { count: number };
    const embeddingCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM imap_chunk_embeddings WHERE status = 'indexed'",
    ).get() as { count: number };

    const folders = this.db.prepare("SELECT folder, last_uid, last_crawled_at, last_error FROM imap_crawl_state ORDER BY folder ASC")
      .all() as Array<{ folder: string; last_uid: number | null; last_crawled_at: string | null; last_error: string | null }>;

    return {
      toolKey: this.settings.toolKey,
      crawlMode: this.settings.crawlMode,
      crawlSelection: this.settings.allFoldersExcept.length > 0
        ? {
          mode: "all-folders-except",
          exclude: this.settings.allFoldersExcept,
        }
        : {
          mode: "explicit-folders",
          folders: this.settings.folders,
        },
      chunking: {
        chunkSize: this.settings.chunkSize,
        chunkOverlap: this.settings.chunkOverlap,
      },
      embeddings: {
        modelKey: this.settings.embeddingModelKey,
        indexingStrategy: this.settings.indexingStrategy,
      },
      totals: {
        emails: messageCount.count,
        chunks: chunkCount.count,
        indexedEmbeddings: embeddingCount.count,
      },
      folders,
    };
  }

  async crawl(input: CrawlInput = {}): Promise<Record<string, unknown>> {
    let folders: string[] = [];
    const since = input.since ? new Date(input.since) : null;
    if (since && Number.isNaN(since.getTime())) {
      throw new Error('"since" must be a valid ISO timestamp');
    }

    const client = this.createClient();
    await client.connect();

    let crawledCount = 0;
    let indexedCount = 0;
    const folderSummaries: Array<Record<string, unknown>> = [];

    try {
      folders = await this.resolveFoldersToCrawl(client, input.folder);

      for (const folder of folders) {
        await client.mailboxOpen(folder);
        const state = this.getFolderState(folder);
        const lowerBoundUid = !input.full && state.lastUid ? state.lastUid + 1 : 1;
        const maxUid = await this.getMaxUid(client, folder);

        if (maxUid < lowerBoundUid) {
          this.upsertFolderState(folder, maxUid, null);
          folderSummaries.push({ folder, crawled: 0, indexed: 0, lastUid: maxUid });
          continue;
        }

        const range = `${lowerBoundUid}:*`;
        let folderCrawled = 0;
        let folderIndexed = 0;
        let newestUid = state.lastUid ?? 0;

        for await (const message of client.fetch(range, {
          uid: true,
          envelope: true,
          source: true,
          threadId: true,
        })) {
          if (!message.uid || !message.source) continue;

          const envelopeDate = message.envelope?.date ?? null;
          if (since && envelopeDate && envelopeDate < since) {
            newestUid = Math.max(newestUid, message.uid);
            continue;
          }

          const parsed = await this.normalizeMessage({
            folder,
            uid: message.uid,
            source: message.source,
            threadId: message.threadId ? String(message.threadId) : null,
            fallbackSubject: message.envelope?.subject ?? "",
            fallbackInReplyTo: message.envelope?.inReplyTo?.[0] ? String(message.envelope.inReplyTo[0]) : null,
          });

          const changed = this.upsertEmail(parsed);
          folderCrawled += 1;
          crawledCount += 1;

          if (changed) {
            const chunks = await this.reindexEmail(parsed.id);
            folderIndexed += chunks;
            indexedCount += chunks;
          }

          newestUid = Math.max(newestUid, parsed.uid);

          if (folderCrawled >= this.settings.batchSize) {
            break;
          }
        }

        this.upsertFolderState(folder, newestUid, null);
        folderSummaries.push({ folder, crawled: folderCrawled, indexed: folderIndexed, lastUid: newestUid });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const folder of folders) {
        const state = this.getFolderState(folder);
        this.upsertFolderState(folder, state.lastUid ?? 0, message);
      }
      throw error;
    } finally {
      await client.logout();
    }

    return {
      mode: input.full ? "full" : "incremental",
      folders: folderSummaries,
      crawled: crawledCount,
      indexedChunks: indexedCount,
    };
  }

  async search(input: SearchInput): Promise<Record<string, unknown>> {
    const query = input.query?.trim();
    if (!query) throw new Error('"query" is required');

    const rows = this.db.prepare(
      `
      SELECT
        c.id,
        c.email_id,
        c.chunk_index,
        c.content,
        e.vector_json,
        e.status AS embedding_status,
        m.folder,
        m.subject,
        m.from_addr,
        m.sent_at,
        m.item_url
      FROM imap_email_chunks c
      INNER JOIN imap_emails m ON m.id = c.email_id
      LEFT JOIN imap_chunk_embeddings e ON e.chunk_id = c.id
      WHERE (? IS NULL OR m.folder = ?)
      `,
    ).all(input.folder ?? null, input.folder ?? null) as ChunkRow[];

    const queryTerms = tokenize(query);
    const queryVector = await this.getQueryEmbedding(query, rows);

    const grouped = new Map<string, {
      email: Pick<EmailRow, "id" | "folder" | "uid" | "message_id" | "thread_id" | "subject" | "from_addr" | "sent_at" | "item_url">;
      score: number;
      excerpts: string[];
    }>();

    for (const row of rows) {
      const lexical = scoreChunk(query, queryTerms, row);
      const vector = scoreVector(queryVector, row);
      const score = lexical + vector;
      if (score <= 0) continue;

      const current = grouped.get(row.email_id);
      if (!current) {
        const summary = this.db.prepare(
          `
          SELECT id, folder, uid, message_id, thread_id, subject, from_addr, sent_at, item_url
          FROM imap_emails
          WHERE id = ?
          LIMIT 1
          `,
        ).get(row.email_id) as Pick<EmailRow, "id" | "folder" | "uid" | "message_id" | "thread_id" | "subject" | "from_addr" | "sent_at" | "item_url"> | undefined;

        if (!summary) continue;

        grouped.set(row.email_id, {
          email: summary,
          score,
          excerpts: [excerptForQuery(row.content, queryTerms)],
        });
        continue;
      }

      current.score += score;
      if (current.excerpts.length < 3) {
        current.excerpts.push(excerptForQuery(row.content, queryTerms));
      }
    }

    const limit = Math.max(1, Math.min(50, input.limit ?? 10));
    const results = [...grouped.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => ({ ...entry, score: Number(entry.score.toFixed(4)) }));

    return {
      query,
      retrievalMode: queryVector ? "vector-hybrid" : "lexical-fallback",
      embeddingModelKey: this.settings.embeddingModelKey,
      indexingStrategy: this.settings.indexingStrategy,
      results,
    };
  }

  getEmail(input: GetEmailInput): Record<string, unknown> {
    const row = this.resolveEmail(input);
    return this.toEmailResult(row);
  }

  getThread(input: GetThreadInput): Record<string, unknown> {
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    let threadId = input.threadId?.trim() || null;

    if (!threadId && input.messageId) {
      const byMessage = this.db.prepare(
        "SELECT thread_id FROM imap_emails WHERE message_id = ? LIMIT 1",
      ).get(input.messageId) as { thread_id: string | null } | undefined;
      threadId = byMessage?.thread_id ?? null;
    }

    if (!threadId) {
      throw new Error("Provide threadId or messageId that resolves to a thread");
    }

    const rows = this.db.prepare(
      `
      SELECT *
      FROM imap_emails
      WHERE thread_id = ?
      ORDER BY sent_at ASC, uid ASC
      LIMIT ?
      `,
    ).all(threadId, limit) as EmailRow[];

    return {
      threadId,
      count: rows.length,
      emails: rows.map((row) => this.toEmailResult(row)),
    };
  }

  async reindex(input: ReindexInput = {}): Promise<Record<string, unknown>> {
    if (input.emailId || (input.folder && input.uid)) {
      const row = this.resolveEmail({
        emailId: input.emailId,
        folder: input.folder,
        uid: input.uid,
      });
      const chunkCount = await this.reindexEmail(row.id);
      return { reindexed: 1, chunkCount };
    }

    const rows = this.db.prepare("SELECT id FROM imap_emails ORDER BY updated_at DESC").all() as Array<{ id: string }>;
    let totalChunks = 0;
    for (const row of rows) {
      totalChunks += await this.reindexEmail(row.id);
    }

    return {
      reindexed: rows.length,
      chunkCount: totalChunks,
    };
  }

  private createClient(): ImapFlow {
    return new ImapFlow({
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.secure,
      auth: {
        user: this.settings.user,
        pass: this.settings.password,
        accessToken: this.settings.accessToken,
      },
      tls: {
        rejectUnauthorized: this.settings.tlsRejectUnauthorized,
      },
      logger: false,
    });
  }

  private async normalizeMessage(input: {
    folder: string;
    uid: number;
    source: Buffer;
    threadId: string | null;
    fallbackSubject: string;
    fallbackInReplyTo: string | null;
  }): Promise<ParsedEmailRecord> {
    const parsed = await simpleParser(input.source, {
      skipHtmlToText: false,
      skipTextToHtml: true,
    });

    const subject = (parsed.subject ?? input.fallbackSubject ?? "(no subject)").trim() || "(no subject)";
    const sentDate = parsed.date ? new Date(parsed.date) : null;
    const sentAt = sentDate && !Number.isNaN(sentDate.getTime()) ? sentDate.toISOString() : null;

    const body = (parsed.text ?? stripHtml(parsed.html ? String(parsed.html) : "") ?? "").trim();
    const messageId = parsed.messageId ? normalizeMessageId(parsed.messageId) : null;
    const inReplyTo = parsed.inReplyTo ? normalizeMessageId(String(parsed.inReplyTo)) : input.fallbackInReplyTo;

    const fromAddr = addressList(parsed.from).join(", ");
    const toAddrs = addressList(parsed.to);
    const subjectSlug = slugify(subject);

    const id = buildEmailId(input.folder, input.uid, messageId);
    const bodyHash = hashText(body);
    const itemUrl = this.renderItemUrl({
      messageId,
      uid: input.uid,
      folder: input.folder,
      threadId: input.threadId,
      inReplyTo,
      from: fromAddr,
      to: toAddrs.join(","),
      date: sentAt,
      subjectSlug,
    });

    return {
      id,
      folder: input.folder,
      uid: input.uid,
      messageId,
      threadId: input.threadId,
      inReplyTo,
      subject,
      subjectSlug,
      fromAddr,
      toAddrs,
      sentAt,
      bodyText: body,
      bodyHash,
      itemUrl,
    };
  }

  private upsertEmail(record: ParsedEmailRecord): boolean {
    const now = new Date().toISOString();

    const existing = this.db.prepare(
      "SELECT id, body_hash FROM imap_emails WHERE folder = ? AND uid = ? LIMIT 1",
    ).get(record.folder, record.uid) as { id: string; body_hash: string } | undefined;

    this.db.prepare(
      `
      INSERT INTO imap_emails (
        id,
        folder,
        uid,
        message_id,
        thread_id,
        in_reply_to,
        subject,
        subject_slug,
        from_addr,
        to_addrs,
        sent_at,
        body_text,
        body_hash,
        item_url,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(folder, uid) DO UPDATE SET
        id = excluded.id,
        message_id = excluded.message_id,
        thread_id = excluded.thread_id,
        in_reply_to = excluded.in_reply_to,
        subject = excluded.subject,
        subject_slug = excluded.subject_slug,
        from_addr = excluded.from_addr,
        to_addrs = excluded.to_addrs,
        sent_at = excluded.sent_at,
        body_text = excluded.body_text,
        body_hash = excluded.body_hash,
        item_url = excluded.item_url,
        updated_at = excluded.updated_at
      `,
    ).run(
      record.id,
      record.folder,
      record.uid,
      record.messageId,
      record.threadId,
      record.inReplyTo,
      record.subject,
      record.subjectSlug,
      record.fromAddr,
      JSON.stringify(record.toAddrs),
      record.sentAt,
      record.bodyText,
      record.bodyHash,
      record.itemUrl,
      now,
      now,
    );

    return !existing || existing.body_hash !== record.bodyHash || existing.id !== record.id;
  }

  private async reindexEmail(emailId: string): Promise<number> {
    const row = this.db.prepare("SELECT * FROM imap_emails WHERE id = ? LIMIT 1").get(emailId) as EmailRow | undefined;
    if (!row) return 0;

    const chunks = chunkText(row.body_text, this.settings.chunkSize, this.settings.chunkOverlap);
    const vectors = await this.embedChunks(chunks);
    const status = this.settings.indexingStrategy === "immediate" ? "indexed" : "pending";
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM imap_chunk_embeddings WHERE email_id = ?").run(emailId);
      this.db.prepare("DELETE FROM imap_email_chunks WHERE email_id = ?").run(emailId);

      const insertChunk = this.db.prepare(
        `
        INSERT INTO imap_email_chunks (
          id,
          email_id,
          chunk_index,
          start_offset,
          end_offset,
          content,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      const insertEmbedding = this.db.prepare(
        `
        INSERT INTO imap_chunk_embeddings (
          chunk_id,
          email_id,
          embedding_model_key,
          vector_json,
          status,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        `,
      );

      for (const [index, chunk] of chunks.entries()) {
        insertChunk.run(
          chunk.id,
          emailId,
          chunk.chunkIndex,
          chunk.startOffset,
          chunk.endOffset,
          chunk.content,
          now,
          now,
        );
        insertEmbedding.run(
          chunk.id,
          emailId,
          this.settings.embeddingModelKey,
          vectors[index] ? JSON.stringify(vectors[index]) : null,
          status,
          now,
        );
      }
    });

    tx();
    return chunks.length;
  }

  private async embedChunks(chunks: ChunkRecord[]): Promise<Array<number[] | null>> {
    if (!chunks.length) return [];
    if (this.settings.indexingStrategy !== "immediate") {
      return chunks.map(() => null);
    }

    const embeddings = this.embeddingRegistry.get(this.settings.embeddingModelKey);
    const vectors = await embeddings.embedDocuments(chunks.map((chunk) => chunk.content));
    return vectors.map((vector) => [...vector]);
  }

  private async getQueryEmbedding(query: string, rows: ChunkRow[]): Promise<number[] | null> {
    if (this.settings.indexingStrategy !== "immediate") return null;

    const hasIndexedVectors = rows.some((row) => row.embedding_status === "indexed" && row.vector_json);
    if (!hasIndexedVectors) return null;

    const embeddings = this.embeddingRegistry.get(this.settings.embeddingModelKey);
    const vector = await embeddings.embedQuery(query);
    return [...vector];
  }

  private resolveEmail(input: GetEmailInput): EmailRow {
    const row = this.db.prepare(
      `
      SELECT *
      FROM imap_emails
      WHERE (? IS NOT NULL AND id = ?)
         OR (? IS NOT NULL AND message_id = ?)
         OR (? IS NOT NULL AND ? IS NOT NULL AND folder = ? AND uid = ?)
      LIMIT 1
      `,
    ).get(
      input.emailId ?? null,
      input.emailId ?? null,
      input.messageId ?? null,
      input.messageId ?? null,
      input.folder ?? null,
      input.uid ?? null,
      input.folder ?? null,
      input.uid ?? null,
    ) as EmailRow | undefined;

    if (!row) {
      throw new Error("Email not found for provided reference");
    }

    return row;
  }

  private toEmailResult(row: EmailRow): Record<string, unknown> {
    return {
      id: row.id,
      folder: row.folder,
      uid: row.uid,
      messageId: row.message_id,
      threadId: row.thread_id,
      inReplyTo: row.in_reply_to,
      subject: row.subject,
      subjectSlug: row.subject_slug,
      from: row.from_addr,
      to: parseJsonArray(row.to_addrs),
      sentAt: row.sent_at,
      body: row.body_text,
      itemUrl: row.item_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getFolderState(folder: string): { lastUid: number | null } {
    const row = this.db.prepare(
      "SELECT last_uid FROM imap_crawl_state WHERE folder = ? LIMIT 1",
    ).get(folder) as { last_uid: number | null } | undefined;

    return {
      lastUid: row?.last_uid ?? null,
    };
  }

  private upsertFolderState(folder: string, lastUid: number, lastError: string | null): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `
      INSERT INTO imap_crawl_state (folder, last_uid, last_crawled_at, last_error)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(folder) DO UPDATE SET
        last_uid = excluded.last_uid,
        last_crawled_at = excluded.last_crawled_at,
        last_error = excluded.last_error
      `,
    ).run(folder, lastUid, now, lastError);
  }

  private async getMaxUid(client: ImapFlow, folder: string): Promise<number> {
    const status = await client.status(folder, { uidNext: true });
    return status.uidNext ? Math.max(0, status.uidNext - 1) : 0;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS imap_emails (
        id TEXT PRIMARY KEY,
        folder TEXT NOT NULL,
        uid INTEGER NOT NULL,
        message_id TEXT,
        thread_id TEXT,
        in_reply_to TEXT,
        subject TEXT NOT NULL,
        subject_slug TEXT NOT NULL,
        from_addr TEXT NOT NULL,
        to_addrs TEXT NOT NULL,
        sent_at TEXT,
        body_text TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        item_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(folder, uid)
      );

      CREATE INDEX IF NOT EXISTS idx_imap_emails_message_id ON imap_emails(message_id);
      CREATE INDEX IF NOT EXISTS idx_imap_emails_thread_id ON imap_emails(thread_id);
      CREATE INDEX IF NOT EXISTS idx_imap_emails_sent_at ON imap_emails(sent_at DESC);

      CREATE TABLE IF NOT EXISTS imap_email_chunks (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(email_id) REFERENCES imap_emails(id) ON DELETE CASCADE,
        UNIQUE(email_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_imap_email_chunks_email_id ON imap_email_chunks(email_id);

      CREATE TABLE IF NOT EXISTS imap_chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL,
        embedding_model_key TEXT NOT NULL,
        vector_json TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES imap_email_chunks(id) ON DELETE CASCADE,
        FOREIGN KEY(email_id) REFERENCES imap_emails(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_imap_chunk_embeddings_email_id ON imap_chunk_embeddings(email_id);

      CREATE TABLE IF NOT EXISTS imap_crawl_state (
        folder TEXT PRIMARY KEY,
        last_uid INTEGER,
        last_crawled_at TEXT,
        last_error TEXT
      );
    `);
  }

  private resolveSettings(toolKey: string, entry: ImapToolConfig): ResolvedImapSettings {
    const secure = entry.server.secure ?? true;
    const allFoldersExcept = dedupe(entry.crawl?.allFoldersExcept ?? []);
    return {
      toolKey,
      host: entry.server.host,
      port: entry.server.port ?? (secure ? 993 : 143),
      secure,
      tlsRejectUnauthorized: entry.server.tlsRejectUnauthorized ?? true,
      user: entry.server.auth.user,
      password: entry.server.auth.password,
      accessToken: entry.server.auth.accessToken,
      mailbox: entry.mailbox ?? "INBOX",
      crawlMode: entry.crawl?.mode ?? "continuous-sync",
      allFoldersExcept,
      folders: (entry.crawl?.folders && entry.crawl.folders.length > 0)
        ? dedupe(entry.crawl.folders)
        : [entry.mailbox ?? "INBOX"],
      batchSize: entry.crawl?.batchSize ?? 10000,
      pollIntervalMs: entry.crawl?.pollIntervalMs ?? 5 * 60 * 1000,
      chunkSize: entry.vector?.chunking?.chunkSize ?? 800,
      chunkOverlap: entry.vector?.chunking?.chunkOverlap ?? 120,
      embeddingModelKey: entry.vector?.embeddingModelKey ?? "default",
      indexingStrategy: entry.vector?.indexingStrategy ?? "immediate",
      indexDbPath: entry.indexDbPath ?? `data/imap-${slugify(toolKey)}.sqlite`,
      urlTemplate: entry.urlTemplate,
    };
  }

  private async resolveFoldersToCrawl(client: ImapFlow, requestedFolder?: string): Promise<string[]> {
    if (requestedFolder?.trim()) {
      return [requestedFolder.trim()];
    }

    if (!this.settings.allFoldersExcept.length) {
      return this.settings.folders;
    }

    const exclude = new Set(this.settings.allFoldersExcept.map((folder) => folder.toLowerCase()));
    const folders = await client.list();

    return dedupe(
      folders
        .filter((folder) => !folder.flags.has("\\Noselect"))
        .map((folder) => folder.path)
        .filter((pathValue) => !exclude.has(pathValue.toLowerCase())),
    );
  }

  private resolveProjectPath(targetPath: string): string {
    if (path.isAbsolute(targetPath)) return targetPath;
    return path.resolve(this.configDir, "..", targetPath);
  }

  private renderItemUrl(metadata: Record<string, string | number | null | undefined>): string | null {
    if (!this.settings.urlTemplate) return null;

    const template = this.settings.urlTemplate;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
      const value = metadata[key];
      if (value === null || value === undefined) return "";
      return encodeURIComponent(String(value));
    });
  }
}

function buildEmailId(folder: string, uid: number, messageId: string | null): string {
  if (messageId) {
    const digest = createHash("sha1").update(`${folder}|${uid}|${messageId}`).digest("hex").slice(0, 12);
    return `${slugify(folder)}-${uid}-${digest}`;
  }
  return `${slugify(folder)}-${uid}`;
}

function stripHtml(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
  return normalized || "item";
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, "");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addressList(input: unknown): string[] {
  const value = input as { value?: Array<{ name?: string; address?: string }> } | undefined;
  if (!value?.value?.length) return [];

  return value.value
    .map((entry) => {
      const address = entry.address?.trim();
      if (!address) return null;
      const name = entry.name?.trim();
      return name ? `${name} <${address}>` : address;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String);
  } catch {
    return [];
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function scoreChunk(query: string, queryTerms: string[], row: ChunkRow): number {
  const haystack = `${row.subject}\n${row.from_addr}\n${row.content}`.toLowerCase();
  let score = haystack.includes(query.toLowerCase()) ? 5 : 0;

  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 2;
  }

  if (score <= 0) return 0;

  if (row.sent_at) {
    const sentTs = Date.parse(row.sent_at);
    if (Number.isFinite(sentTs)) {
      const daysOld = (Date.now() - sentTs) / (1000 * 60 * 60 * 24);
      if (daysOld <= 7) score += 1.5;
      else if (daysOld <= 30) score += 0.75;
    }
  }

  return score;
}

function scoreVector(queryVector: number[] | null, row: ChunkRow): number {
  if (!queryVector || row.embedding_status !== "indexed" || !row.vector_json) return 0;

  const storedVector = parseVector(row.vector_json);
  if (!storedVector || storedVector.length !== queryVector.length) return 0;

  const similarity = cosineSimilarity(queryVector, storedVector);
  if (!Number.isFinite(similarity) || similarity <= 0) return 0;
  return similarity * 20;
}

function parseVector(vectorJson: string): number[] | null {
  try {
    const parsed = JSON.parse(vectorJson) as unknown;
    if (!Array.isArray(parsed)) return null;

    const vector = parsed.map((value) => Number(value));
    return vector.every((value) => Number.isFinite(value)) ? vector : null;
  } catch {
    return null;
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! * left[index]!;
    rightMagnitude += right[index]! * right[index]!;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function excerptForQuery(content: string, queryTerms: string[]): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const lower = normalized.toLowerCase();
  const matchIndex = queryTerms
    .map((term) => lower.indexOf(term))
    .find((index) => index >= 0) ?? 0;

  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(normalized.length, matchIndex + 220);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function chunkText(content: string, chunkSize: number, chunkOverlap: number): ChunkRecord[] {
  const normalized = content.trim();
  if (!normalized) return [];

  const chunks: ChunkRecord[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);

    if (end < normalized.length) {
      const quotedBreak = normalized.lastIndexOf("\n> ", end);
      const forwardedBreak = normalized.lastIndexOf("---------- Forwarded message", end);
      const paragraphBreak = normalized.lastIndexOf("\n\n", end);
      const lineBreak = normalized.lastIndexOf("\n", end);
      const whitespace = normalized.lastIndexOf(" ", end);
      const preferredBreak = [quotedBreak, forwardedBreak, paragraphBreak, lineBreak, whitespace].find(
        (candidate) => candidate > start + Math.floor(chunkSize / 2),
      );
      if (preferredBreak !== undefined && preferredBreak > start) {
        end = preferredBreak;
      }
    }

    const chunkContent = normalized.slice(start, end).trim();
    if (chunkContent) {
      chunks.push({
        id: randomUUID(),
        chunkIndex,
        startOffset: start,
        endOffset: end,
        content: chunkContent,
      });
      chunkIndex += 1;
    }

    if (end >= normalized.length) break;
    const nextStart = Math.max(end - chunkOverlap, start + 1);
    if (nextStart <= start) break;
    start = nextStart;
  }

  return chunks;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
