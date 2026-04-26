import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { promises as fsPromises } from "node:fs";
import Database from "better-sqlite3";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  ConfigLoader,
  EmbeddingRegistry,
  ModelRegistry,
  type ImapToolConfig,
  type ToolServerEntry,
} from "@langgraph-glove/config";
import {
  AttachmentProcessorRegistry,
  createDefaultAttachmentProcessors,
} from "./attachments/AttachmentProcessors";
import type { ToolHealthResult } from "@langgraph-glove/tool-server";

const execFile = promisify(execFileCallback);

export interface CrawlInput {
  folder?: string;
  since?: string;
  full?: boolean;
}

export interface SearchInput {
  query: string;
  folder?: string;
  limit?: number;
  chunkSource?: "email" | "attachment";
  year?: number;
  month?: number;
  day?: number;
  dateField?: "sentAt" | "receivedAt" | "updatedAt";
  from?: string;
  subject?: string;
  hasAttachments?: boolean;
  sortBy?: "relevance" | "sentAt" | "receivedAt" | "updatedAt";
  sortDirection?: "asc" | "desc";
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

export interface ListAttachmentsInput {
  limit?: number;
  offset?: number;
}

export interface GetAttachmentInput {
  attachmentId: string;
}

interface ResolvedImapSettings {
  toolKey: string;
  displayName?: string;
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
  embeddingBatchSize: number;
  embeddingModelKey: string;
  indexingStrategy: "immediate" | "deferred";
  indexDbPath: string;
  urlTemplate?: string;
  attachment: ResolvedAttachmentSettings;
}

interface ResolvedAttachmentSettings {
  enabled: boolean;
  mimeAllowList: string[] | null;
  maxFileSizeBytes: number;
  parallelism: number;
  ocrModelKey: string;
  photoCaptionModelKey: string;
  pdfMaxOcrPages: number;
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
  created_at: string;
  updated_at: string;
  item_url: string | null;
  chunk_source: "email" | "attachment";
  attachment_id: string | null;
  attachment_filename: string | null;
  attachment_mime_type: string | null;
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
  attachments: ParsedAttachmentRecord[];
}

interface ParsedAttachmentRecord {
  id: string;
  emailId: string;
  attachmentIndex: number;
  filename: string;
  contentType: string;
  fileSizeBytes: number;
  contentHash: string;
  content: Buffer;
}

interface ChunkRecord {
  id: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  content: string;
}

interface CrawlProgressState {
  startedAtMs: number;
  lastLoggedAtMs: number;
  changedEmails: number;
}

interface CrawlRuntimeState {
  active: boolean;
  mode: "full" | "incremental";
  startedAtMs: number;
  startedAtIso: string;
  currentFolder: string | null;
  totalFolders: number;
  completedFolders: number;
  crawledEmails: number;
  changedEmails: number;
  indexedChunks: number;
  lastFinishedAtIso: string | null;
}

interface EstimateCacheState {
  capturedAtMs: number;
  value: Record<string, unknown>;
}

interface AttachmentTask {
  emailId: string;
  attachment: ParsedAttachmentRecord;
}

interface AttachmentLogState {
  startedAtMs: number;
  lastLoggedAtMs: number;
  queued: number;
  processed: number;
  indexed: number;
  skipped: number;
  failed: number;
}

interface ImapErrorDetails {
  code: string;
  syscall: string;
  message: string;
}

export class ImapIndexService {
  private readonly settings: ResolvedImapSettings;
  private readonly db: Database.Database;
  private readonly embeddingRegistry: EmbeddingRegistry;
  private readonly modelRegistry: ModelRegistry;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly configDir: string;
  private readonly attachmentProcessors: AttachmentProcessorRegistry;
  private crawlRuntime: CrawlRuntimeState | null = null;
  private estimateCache: EstimateCacheState | null = null;
  private crawlAbortRequested = false;
  private readonly attachmentQueue: AttachmentTask[] = [];
  private activeAttachmentTasks = 0;
  private activeEmailIndexingTasks = 0;
  private attachmentDrainDeferredLogged = false;
  private readonly econnResetFailureTimestampsMs: number[] = [];
  private lastEconnResetSignature: string | null = null;
  private lastEconnResetRecordedAtMs = 0;
  private crawlStoppedByImapErrors = false;
  private crawlStopReason: string | null = null;
  private readonly attachmentLogState: AttachmentLogState = {
    startedAtMs: Date.now(),
    lastLoggedAtMs: 0,
    queued: 0,
    processed: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
  };
  private static readonly ESTIMATE_CACHE_TTL_MS = 30_000;
  private static readonly DEFAULT_PDF_DPI = 180;
  private static readonly IMAP_SOCKET_TIMEOUT_MS = 10 * 60 * 1000;
  private static readonly ECONNRESET_FAILURE_WINDOW_MS = 60 * 60 * 1000;
  private static readonly ECONNRESET_FAILURE_LIMIT = 5;
  private static readonly ECONNRESET_DEDUPE_MS = 5000;

  private static readonly SEARCH_EMBED_TIMEOUT_MS = 10_000;
  private static readonly SEARCH_MAX_CANDIDATE_ROWS = 12_000;
  constructor(options: { toolKey: string; configDir?: string; secretsDir?: string }) {
    this.configDir = path.resolve(options.configDir ?? process.env["GLOVE_CONFIG_DIR"] ?? "config");
    const secretsDir = path.resolve(options.secretsDir ?? process.env["GLOVE_SECRETS_DIR"] ?? "secrets");

    const loader = new ConfigLoader(this.configDir, secretsDir);
    const config = loader.load();
    this.embeddingRegistry = new EmbeddingRegistry(config.models);
    this.modelRegistry = new ModelRegistry(config.models);

    const entry = config.tools[options.toolKey] as ToolServerEntry | undefined;
    if (!entry?.imap) {
      throw new Error(`tools.json entry "${options.toolKey}" must define an "imap" configuration block`);
    }

    this.settings = this.resolveSettings(options.toolKey, entry.imap);
    this.attachmentProcessors = new AttachmentProcessorRegistry(createDefaultAttachmentProcessors());
    const dbPath = this.resolveProjectPath(this.settings.indexDbPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();

    if (this.settings.indexingStrategy === "immediate") {
      this.embeddingRegistry.get(this.settings.embeddingModelKey);
    }

    if (this.settings.attachment.enabled) {
      this.modelRegistry.get(this.settings.attachment.ocrModelKey);
      this.modelRegistry.get(this.settings.attachment.photoCaptionModelKey);
      console.log(
        `[tool-imap] attachment indexing enabled tool=${this.settings.toolKey} `
        + `parallelism=${this.settings.attachment.parallelism} maxFileBytes=${this.settings.attachment.maxFileSizeBytes} `
        + `ocrModel=${this.settings.attachment.ocrModelKey} captionModel=${this.settings.attachment.photoCaptionModelKey}`,
      );
    }
  }

  async start(): Promise<void> {
    if (this.crawlStoppedByImapErrors) {
      process.stderr.write(`[tool-imap] startup crawl disabled: ${this.crawlStopReason ?? "IMAP crawl has been stopped"}\n`);
      return;
    }

    if (this.settings.crawlMode === "startup" || this.settings.crawlMode === "continuous-sync") {
      try {
        await this.crawl({ full: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.isRecoverableImapConnectionError(error)) {
          process.stderr.write(`[tool-imap] startup crawl recoverable IMAP failure: ${message}\n`);
        } else {
          throw error;
        }
      }
    }

    if (this.settings.crawlMode === "continuous-sync" && !this.crawlStoppedByImapErrors) {
      this.pollTimer = setInterval(() => {
        if (this.crawlStoppedByImapErrors) {
          if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
          }
          return;
        }
        void this.crawl({ full: false }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (this.isRecoverableImapConnectionError(error)) {
            process.stderr.write(`[tool-imap] poll crawl recoverable IMAP failure: ${message}\n`);
            return;
          }
          process.stderr.write(`[tool-imap] poll crawl failed: ${message}\n`);
        });
      }, this.settings.pollIntervalMs);
    }
  }

  async checkHealth(): Promise<Omit<ToolHealthResult, "latencyMs">> {
    if (!this.settings.attachment.enabled) {
      return {
        ok: true,
        summary: "Attachment indexing is disabled; no external PDF dependencies required",
        dependencies: [],
      };
    }

    const dependencies: ToolHealthResult["dependencies"] = [];
    for (const binary of ["pdftotext", "pdftoppm"]) {
      try {
        const { stdout } = await execFile("which", [binary], { maxBuffer: 64 * 1024 }) as {
          stdout: string;
          stderr: string;
        };
        dependencies.push({
          name: binary,
          ok: true,
          detail: stdout.trim(),
        });
      } catch {
        dependencies.push({
          name: binary,
          ok: false,
          detail: `${binary} is not installed or not available on PATH.`,
        });
      }
    }

    const ok = dependencies.every((dependency) => dependency.ok || dependency.severity === "warning");
    return {
      ok,
      summary: ok
        ? "PDF extraction dependencies are available"
        : "Missing PDF extraction dependencies for attachment indexing",
      dependencies,
    };
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const messageCount = this.db.prepare("SELECT COUNT(*) AS count FROM imap_emails").get() as { count: number };
    const chunkCount = this.db.prepare("SELECT COUNT(*) AS count FROM imap_email_chunks").get() as { count: number };
    const embeddingCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM imap_chunk_embeddings WHERE status = 'indexed'",
    ).get() as { count: number };
    const attachmentCount = this.db.prepare("SELECT COUNT(*) AS count FROM imap_email_attachments").get() as { count: number };
    const attachmentChunkCount = this.db.prepare("SELECT COUNT(*) AS count FROM imap_attachment_chunks").get() as { count: number };
    const attachmentMarkdownCount = this.db.prepare("SELECT COUNT(*) AS count FROM imap_attachment_markdown").get() as { count: number };
    const attachmentEmbeddingCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM imap_attachment_embeddings WHERE status = 'indexed'",
    ).get() as { count: number };
    const queuedFileCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM imap_email_attachments WHERE extraction_status IN ('queued', 'processing')",
    ).get() as { count: number };
    const indexedFileCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM imap_email_attachments WHERE extraction_status = 'indexed'",
    ).get() as { count: number };

    const folders = this.db.prepare("SELECT folder, last_uid, last_crawled_at, last_error FROM imap_crawl_state ORDER BY folder ASC")
      .all() as Array<{ folder: string; last_uid: number | null; last_crawled_at: string | null; last_error: string | null }>;

    const crawlRuntime = this.getCrawlRuntimeSnapshot();
    this.pruneEconnResetFailures(Date.now());

    return {
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
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
        embeddingBatchSize: this.settings.embeddingBatchSize,
      },
      attachmentIndexing: {
        enabled: this.settings.attachment.enabled,
        mimeAllowList: this.settings.attachment.mimeAllowList,
        defaultSupportedMimeTypes: this.attachmentProcessors.supportedMimeTypes(),
        maxFileSizeBytes: this.settings.attachment.maxFileSizeBytes,
        parallelism: this.settings.attachment.parallelism,
        ocrModelKey: this.settings.attachment.ocrModelKey,
        photoCaptionModelKey: this.settings.attachment.photoCaptionModelKey,
        pdfMaxOcrPages: this.settings.attachment.pdfMaxOcrPages,
        activeQueue: this.attachmentQueue.length,
        activeTasks: this.activeAttachmentTasks,
      },
      totals: {
        emails: messageCount.count,
        chunks: chunkCount.count,
        indexedEmbeddings: embeddingCount.count,
        attachments: attachmentCount.count,
        attachmentChunks: attachmentChunkCount.count,
        attachmentMarkdown: attachmentMarkdownCount.count,
        indexedAttachmentEmbeddings: attachmentEmbeddingCount.count,
        queuedFiles: queuedFileCount.count,
        indexedFiles: indexedFileCount.count,
      },
      folders,
      crawlRuntime,
      imapConnectionHealth: {
        stopped: this.crawlStoppedByImapErrors,
        stopReason: this.crawlStopReason,
        econnresetFailuresLastHour: this.econnResetFailureTimestampsMs.length,
        stopThreshold: ImapIndexService.ECONNRESET_FAILURE_LIMIT,
        failureWindowMs: ImapIndexService.ECONNRESET_FAILURE_WINDOW_MS,
      },
    };
  }

  async remainingEstimate(input: { forceRefreshEstimate?: boolean } = {}): Promise<Record<string, unknown>> {
    return this.getEstimateWithCache({ forceRefresh: input.forceRefreshEstimate === true });
  }

  async stopCrawl(): Promise<Record<string, unknown>> {
    if (!this.crawlRuntime?.active) {
      return {
        toolKey: this.settings.toolKey,
        displayName: this.settings.displayName,
        stopped: false,
        reason: "No crawl is currently active",
      };
    }
    this.crawlAbortRequested = true;
    // Also directly mark as inactive so status reflects the stop immediately,
    // even if the crawl loop hasn't yet checked the abort flag.
    this.crawlRuntime.active = false;
    this.crawlRuntime.currentFolder = null;
    return { toolKey: this.settings.toolKey, displayName: this.settings.displayName, stopped: true };
  }

  async startCrawl(): Promise<Record<string, unknown>> {
    if (this.crawlStoppedByImapErrors) {
      return {
        toolKey: this.settings.toolKey,
        displayName: this.settings.displayName,
        started: false,
        reason: this.crawlStopReason ?? "IMAP crawl has been stopped",
      };
    }

    if (this.crawlRuntime?.active) {
      return {
        toolKey: this.settings.toolKey,
        displayName: this.settings.displayName,
        started: false,
        reason: "A crawl is already in progress",
      };
    }
    void this.crawl({ full: false }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[tool-imap] manual start crawl failed: ${message}\n`);
    });
    return { toolKey: this.settings.toolKey, displayName: this.settings.displayName, started: true };
  }

  async crawl(input: CrawlInput = {}): Promise<Record<string, unknown>> {
    if (this.crawlStoppedByImapErrors) {
      return {
        skipped: true,
        reason: this.crawlStopReason ?? "IMAP crawl has been stopped",
        toolKey: this.settings.toolKey,
      };
    }

    if (this.crawlRuntime?.active) {
      return {
        skipped: true,
        reason: "A crawl is already in progress",
        toolKey: this.settings.toolKey,
      };
    }

    this.crawlAbortRequested = false;

    let folders: string[] = [];
    const since = input.since ? new Date(input.since) : null;
    if (since && Number.isNaN(since.getTime())) {
      throw new Error('"since" must be a valid ISO timestamp');
    }

    const client = this.createClient();

    const mode: "full" | "incremental" = input.full ? "full" : "incremental";
    const crawlStartedAt = new Date().toISOString();
    this.crawlRuntime = {
      active: true,
      mode,
      startedAtMs: Date.now(),
      startedAtIso: crawlStartedAt,
      currentFolder: null,
      totalFolders: 0,
      completedFolders: 0,
      crawledEmails: 0,
      changedEmails: 0,
      indexedChunks: 0,
      lastFinishedAtIso: this.crawlRuntime?.lastFinishedAtIso ?? null,
    };

    let crawledCount = 0;
    let indexedCount = 0;
    const folderSummaries: Array<Record<string, unknown>> = [];
    const progress: CrawlProgressState = {
      startedAtMs: Date.now(),
      lastLoggedAtMs: Date.now(),
      changedEmails: 0,
    };

    try {
      await client.connect();
      this.estimateCache = null;
      folders = await this.resolveFoldersToCrawl(client, input.folder);
      if (this.crawlRuntime) {
        this.crawlRuntime.totalFolders = folders.length;
      }

      console.log(
        `[tool-imap] crawl started tool=${this.settings.toolKey} folders=${folders.length} `
        + `indexingStrategy=${this.settings.indexingStrategy} embeddingModel=${this.settings.embeddingModelKey}`,
      );

      for (const folder of folders) {
        if (this.crawlAbortRequested) {
          console.log(`[tool-imap] crawl aborted before folder=${folder} tool=${this.settings.toolKey}`);
          break;
        }
        if (this.crawlRuntime) {
          this.crawlRuntime.currentFolder = folder;
        }
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
          if (this.crawlRuntime) {
            this.crawlRuntime.crawledEmails = crawledCount;
          }

          if (changed) {
            progress.changedEmails += 1;
            const chunks = await this.reindexEmail(parsed.id);
            folderIndexed += chunks;
            indexedCount += chunks;
            if (this.crawlRuntime) {
              this.crawlRuntime.changedEmails = progress.changedEmails;
              this.crawlRuntime.indexedChunks = indexedCount;
            }

            if (this.canProcessAttachmentsForEmail(parsed.id) && parsed.attachments.length > 0) {
              this.enqueueAttachmentTasks(parsed.id, parsed.attachments);
            }
          }

          this.maybeLogCrawlProgress(progress, {
            folder,
            foldersCompleted: folderSummaries.length,
            totalFolders: folders.length,
            crawledCount,
            changedEmails: progress.changedEmails,
            indexedCount,
            force: false,
          });

          newestUid = Math.max(newestUid, parsed.uid);

          if (this.crawlAbortRequested || folderCrawled >= this.settings.batchSize) {
            break;
          }
        }

        this.upsertFolderState(folder, newestUid, null);
        folderSummaries.push({ folder, crawled: folderCrawled, indexed: folderIndexed, lastUid: newestUid });
        if (this.crawlRuntime) {
          this.crawlRuntime.completedFolders = folderSummaries.length;
        }
        this.maybeLogCrawlProgress(progress, {
          folder,
          foldersCompleted: folderSummaries.length,
          totalFolders: folders.length,
          crawledCount,
          changedEmails: progress.changedEmails,
          indexedCount,
          force: true,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isRecoverableImapConnectionError(error)) {
        this.recordEconnResetFailure(error, "crawl");
      }
      for (const folder of folders) {
        const state = this.getFolderState(folder);
        this.upsertFolderState(folder, state.lastUid ?? 0, message);
      }
      throw error;
    } finally {
      await client.logout().catch(() => undefined);
      const finishedAtIso = new Date().toISOString();
      if (this.crawlRuntime) {
        this.crawlRuntime.active = false;
        this.crawlRuntime.currentFolder = null;
        this.crawlRuntime.lastFinishedAtIso = finishedAtIso;
      }
      this.estimateCache = null;
    }

    this.maybeLogAttachmentProgress(true);

    return {
      mode,
      startedAt: crawlStartedAt,
      finishedAt: new Date().toISOString(),
      folders: folderSummaries,
      crawled: crawledCount,
      indexedChunks: indexedCount,
    };
  }

  async search(input: SearchInput): Promise<Record<string, unknown>> {
    const query = input.query?.trim();
    if (!query) throw new Error('"query" is required');

    const chunkSource = input.chunkSource?.trim().toLowerCase();
    if (chunkSource && chunkSource !== "email" && chunkSource !== "attachment") {
      throw new Error('"chunkSource" must be one of: "email", "attachment"');
    }

    const dateField = normalizeSearchDateField(input.dateField);
    const sortBy = normalizeSearchSortBy(input.sortBy);
    const sortDirection = normalizeSortDirection(input.sortDirection);
    const year = normalizeSearchYear(input.year);
    const month = normalizeSearchMonth(input.month);
    const day = normalizeSearchDay(input.day);
    const fromFilter = buildCaseInsensitiveLikePattern(input.from);
    const subjectFilter = buildCaseInsensitiveLikePattern(input.subject);
    const hasAttachments = typeof input.hasAttachments === "boolean" ? Number(input.hasAttachments) : null;
    const dateColumn = resolveSearchDateColumn(dateField);
    const queryTerms = tokenize(query);
    const wildcardQuery = isWildcardQuery(query, queryTerms);

    if (wildcardQuery) {
      return this.searchByMetadata(input, {
        query,
        chunkSource,
        dateField,
        dateColumn,
        sortBy,
        sortDirection,
        year,
        month,
        day,
        fromFilter,
        subjectFilter,
        hasAttachments,
      });
    }

    const rows = this.db.prepare(
      `
      SELECT * FROM (
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
        m.created_at,
        m.updated_at,
        m.item_url,
        'email' AS chunk_source,
        NULL AS attachment_id,
        NULL AS attachment_filename,
        NULL AS attachment_mime_type
      FROM imap_email_chunks c
      INNER JOIN imap_emails m ON m.id = c.email_id
      LEFT JOIN imap_chunk_embeddings e ON e.chunk_id = c.id
      WHERE (? IS NULL OR m.folder = ?)
        AND (? IS NULL OR ? = 'email')
        AND (? IS NULL OR LOWER(m.from_addr) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR LOWER(m.subject) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR CAST(strftime('%Y', ${dateColumn}) AS INTEGER) = ?)
        AND (? IS NULL OR CAST(strftime('%m', ${dateColumn}) AS INTEGER) = ?)
        AND (? IS NULL OR CAST(strftime('%d', ${dateColumn}) AS INTEGER) = ?)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM imap_email_attachments att WHERE att.email_id = m.id) = ?)
      LIMIT ?
      )

      UNION ALL

      SELECT * FROM (
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
        m.created_at,
        m.updated_at,
        m.item_url,
        'attachment' AS chunk_source,
        c.attachment_id,
        a.filename AS attachment_filename,
        a.mime_type AS attachment_mime_type
      FROM imap_attachment_chunks c
      INNER JOIN imap_emails m ON m.id = c.email_id
      INNER JOIN imap_email_attachments a ON a.id = c.attachment_id
      LEFT JOIN imap_attachment_embeddings e ON e.chunk_id = c.id
      WHERE (? IS NULL OR m.folder = ?)
        AND (? IS NULL OR ? = 'attachment')
        AND (? IS NULL OR LOWER(m.from_addr) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR LOWER(m.subject) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR CAST(strftime('%Y', ${dateColumn}) AS INTEGER) = ?)
        AND (? IS NULL OR CAST(strftime('%m', ${dateColumn}) AS INTEGER) = ?)
        AND (? IS NULL OR CAST(strftime('%d', ${dateColumn}) AS INTEGER) = ?)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM imap_email_attachments att WHERE att.email_id = m.id) = ?)
      LIMIT ?
      )
      `,
    ).all(
      input.folder ?? null,
      input.folder ?? null,
      chunkSource ?? null,
      chunkSource ?? null,
      fromFilter,
      fromFilter,
      subjectFilter,
      subjectFilter,
      year,
      year,
      month,
      month,
      day,
      day,
      hasAttachments,
      hasAttachments,
      ImapIndexService.SEARCH_MAX_CANDIDATE_ROWS,
      input.folder ?? null,
      input.folder ?? null,
      chunkSource ?? null,
      chunkSource ?? null,
      fromFilter,
      fromFilter,
      subjectFilter,
      subjectFilter,
      year,
      year,
      month,
      month,
      day,
      day,
      hasAttachments,
      hasAttachments,
      ImapIndexService.SEARCH_MAX_CANDIDATE_ROWS,
    ) as ChunkRow[];

    let queryVector: number[] | null = null;
    try {
      queryVector = await this.getQueryEmbedding(query, rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[tool-imap] search embedding fallback tool=${this.settings.toolKey} `
        + `model=${this.settings.embeddingModelKey} reason=${message}`,
      );
    }

    const grouped = new Map<string, {
      email: Pick<EmailRow, "id" | "folder" | "uid" | "message_id" | "thread_id" | "subject" | "subject_slug" | "from_addr" | "to_addrs" | "sent_at" | "in_reply_to" | "created_at" | "updated_at">;
      score: number;
      excerpts: string[];
      hitSources: Set<string>;
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
          SELECT id, folder, uid, message_id, thread_id, subject, subject_slug, from_addr, to_addrs, sent_at, in_reply_to, created_at, updated_at
          FROM imap_emails
          WHERE id = ?
          LIMIT 1
          `,
        ).get(row.email_id) as Pick<EmailRow, "id" | "folder" | "uid" | "message_id" | "thread_id" | "subject" | "subject_slug" | "from_addr" | "to_addrs" | "sent_at" | "in_reply_to" | "created_at" | "updated_at"> | undefined;

        if (!summary) continue;

        grouped.set(row.email_id, {
          email: summary,
          score,
          excerpts: [formatExcerpt(row, excerptForQuery(row.content, queryTerms))],
          hitSources: new Set([row.chunk_source]),
        });
        continue;
      }

      current.score += score;
      current.hitSources.add(row.chunk_source);
      if (current.excerpts.length < 3) {
        current.excerpts.push(formatExcerpt(row, excerptForQuery(row.content, queryTerms)));
      }
    }

    const limit = Math.max(1, Math.min(50, input.limit ?? 10));
    const results = [...grouped.values()]
      .sort((left, right) => compareSearchEntries(left, right, sortBy, sortDirection))
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        toolKey: this.settings.toolKey,
        displayName: this.settings.displayName,
        email: this.decorateEmailSummary(entry.email),
        score: Number(entry.score.toFixed(4)),
        hitSources: [...entry.hitSources].sort((left, right) => left.localeCompare(right)),
      }));

    const references = results
      .map((entry) => ({
        url: entry.email.itemUrl,
        title: entry.email.subject,
      }))
      .filter((entry) => typeof entry.url === "string" && entry.url.trim().length > 0)
      .map((entry) => ({
        url: entry.url as string,
        title: typeof entry.title === "string" && entry.title.trim().length > 0
          ? entry.title
          : (entry.url as string),
        kind: "email",
        sourceTool: "imap_search",
      }));

    return {
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
      query,
      filters: {
        folder: input.folder ?? null,
        chunkSource: chunkSource ?? "all",
        from: input.from?.trim() || null,
        subject: input.subject?.trim() || null,
        hasAttachments: typeof input.hasAttachments === "boolean" ? input.hasAttachments : null,
        dateField,
        year,
        month,
        day,
      },
      sort: {
        by: sortBy,
        direction: sortDirection,
      },
      chunkSource: chunkSource ?? "all",
      retrievalMode: queryVector ? "vector-hybrid" : "lexical-fallback",
      embeddingModelKey: this.settings.embeddingModelKey,
      indexingStrategy: this.settings.indexingStrategy,
      candidateRowsScanned: rows.length,
      results,
      references,
    };
  }

  private searchByMetadata(
    input: SearchInput,
    context: {
      query: string;
      chunkSource: string | undefined;
      dateField: "sentAt" | "receivedAt" | "updatedAt";
      dateColumn: string;
      sortBy: "relevance" | "sentAt" | "receivedAt" | "updatedAt";
      sortDirection: "asc" | "desc";
      year: number | null;
      month: number | null;
      day: number | null;
      fromFilter: string | null;
      subjectFilter: string | null;
      hasAttachments: number | null;
    },
  ): Record<string, unknown> {
    const effectiveSortBy = context.sortBy === "relevance" ? "receivedAt" : context.sortBy;
    const { sortColumn, sortDirectionSql } = resolveMetadataSortClause(effectiveSortBy, context.sortDirection);
    const chunkSource = context.chunkSource;

    const rows = this.db.prepare(
      `
      SELECT
        m.id,
        m.folder,
        m.uid,
        m.message_id,
        m.thread_id,
        m.subject,
        m.subject_slug,
        m.from_addr,
        m.to_addrs,
        m.sent_at,
        m.in_reply_to,
        m.created_at,
        m.updated_at
      FROM imap_emails m
      WHERE (? IS NULL OR m.folder = ?)
        AND (? IS NULL OR LOWER(m.from_addr) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR LOWER(m.subject) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR CAST(strftime('%Y', ${context.dateColumn}) AS INTEGER) = ?)
        AND (? IS NULL OR CAST(strftime('%m', ${context.dateColumn}) AS INTEGER) = ?)
        AND (? IS NULL OR CAST(strftime('%d', ${context.dateColumn}) AS INTEGER) = ?)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM imap_email_attachments att WHERE att.email_id = m.id) = ?)
        AND (? IS NULL OR ? = 'email')
        AND (? IS NULL OR EXISTS(SELECT 1 FROM imap_email_attachments att WHERE att.email_id = m.id))
      ORDER BY ${sortColumn} ${sortDirectionSql}, m.uid DESC
      LIMIT ?
      `,
    ).all(
      input.folder ?? null,
      input.folder ?? null,
      context.fromFilter,
      context.fromFilter,
      context.subjectFilter,
      context.subjectFilter,
      context.year,
      context.year,
      context.month,
      context.month,
      context.day,
      context.day,
      context.hasAttachments,
      context.hasAttachments,
      chunkSource ?? null,
      chunkSource ?? null,
      chunkSource ?? null,
      Math.max(1, Math.min(50, input.limit ?? 10)),
    ) as Array<
      Pick<EmailRow, "id" | "folder" | "uid" | "message_id" | "thread_id" | "subject" | "subject_slug" | "from_addr" | "to_addrs" | "sent_at" | "in_reply_to" | "created_at" | "updated_at">
    >;

    const hitSource = chunkSource === "attachment" ? "attachment" : "email";
    const results = rows.map((row) => ({
      email: this.decorateEmailSummary(row),
      score: 0,
      excerpts: [] as string[],
      hitSources: [hitSource],
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
    }));

    const references = results
      .map((entry) => ({
        url: entry.email.itemUrl,
        title: entry.email.subject,
      }))
      .filter((entry) => typeof entry.url === "string" && entry.url.trim().length > 0)
      .map((entry) => ({
        url: entry.url as string,
        title: typeof entry.title === "string" && entry.title.trim().length > 0
          ? entry.title
          : (entry.url as string),
        kind: "email",
        sourceTool: "imap_search",
      }));

    return {
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
      query: context.query,
      filters: {
        folder: input.folder ?? null,
        chunkSource: chunkSource ?? "all",
        from: input.from?.trim() || null,
        subject: input.subject?.trim() || null,
        hasAttachments: typeof input.hasAttachments === "boolean" ? input.hasAttachments : null,
        dateField: context.dateField,
        year: context.year,
        month: context.month,
        day: context.day,
      },
      sort: {
        by: effectiveSortBy,
        direction: context.sortDirection,
      },
      chunkSource: chunkSource ?? "all",
      retrievalMode: "metadata-fallback",
      embeddingModelKey: this.settings.embeddingModelKey,
      indexingStrategy: this.settings.indexingStrategy,
      candidateRowsScanned: rows.length,
      results,
      references,
    };
  }

  getEmail(input: GetEmailInput): Record<string, unknown> {
    const row = this.resolveEmail(input);
    const email = this.toEmailResult(row);
    const url = this.generateUrlFromMetadata({
      messageId: row.message_id,
      threadId: row.thread_id,
      uid: row.uid,
      folder: row.folder,
      inReplyTo: row.in_reply_to,
      from: row.from_addr,
      to: parseJsonArray(row.to_addrs).join(","),
      date: row.sent_at,
      subjectSlug: row.subject_slug,
    });
    const references = url
      ? [{
          url,
          title: row.subject?.trim().length ? row.subject : url,
          kind: "email",
          sourceTool: "imap_get_email",
        }]
      : [];
    return {
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
      ...email,
      references,
    };
  }

  getThread(input: GetThreadInput): Record<string, unknown> {
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    let threadId = this.normalizeQualifiedThreadId(input.threadId) ?? null;

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

    const emails = rows.map((row) => this.toEmailResult(row));
    const references = rows
      .map((row) => {
        const url = this.generateUrlFromMetadata({
          messageId: row.message_id,
          threadId: row.thread_id,
          uid: row.uid,
          folder: row.folder,
          inReplyTo: row.in_reply_to,
          from: row.from_addr,
          to: parseJsonArray(row.to_addrs).join(","),
          date: row.sent_at,
          subjectSlug: row.subject_slug,
        });
        return { url, row };
      })
      .filter((entry) => typeof entry.url === "string" && entry.url.trim().length > 0)
      .map((entry) => ({
        url: entry.url,
        title: entry.row.subject?.trim().length ? entry.row.subject : entry.url,
        kind: "email",
        sourceTool: "imap_get_thread",
      }));

    return {
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
      threadId,
      qualifiedThreadId: this.qualifyScopedId(threadId),
      count: rows.length,
      emails,
      references,
    };
  }

  listAttachments(input: ListAttachmentsInput = {}): Record<string, unknown> {
    const limit = Math.max(1, Math.min(200, input.limit ?? 100));
    const offset = Math.max(0, input.offset ?? 0);

    const total = (this.db.prepare(
      "SELECT COUNT(DISTINCT content_hash) AS count FROM imap_email_attachments",
    ).get() as { count: number }).count;

    const rows = this.db.prepare(
      `
      SELECT
        a.id,
        a.email_id,
        a.attachment_index,
        a.filename,
        a.mime_type,
        a.file_size_bytes,
        a.extraction_status,
        a.extraction_error,
        a.created_at,
        a.updated_at,
        m.subject,
        m.subject_slug,
        m.from_addr,
        m.to_addrs,
        m.sent_at,
        m.message_id,
        m.thread_id,
        m.in_reply_to,
        m.uid,
        m.folder,
        (
          SELECT COUNT(*)
          FROM imap_attachment_chunks c
          WHERE c.attachment_id = a.id
        ) AS chunk_count,
        (
          SELECT c.content
          FROM imap_attachment_chunks c
          WHERE c.attachment_id = a.id
          ORDER BY c.chunk_index ASC
          LIMIT 1
        ) AS text_preview
      FROM imap_email_attachments a
      INNER JOIN imap_emails m ON m.id = a.email_id
      WHERE a.id = (
        SELECT a2.id
        FROM imap_email_attachments a2
        WHERE a2.content_hash = a.content_hash
        ORDER BY a2.updated_at DESC, a2.id DESC
        LIMIT 1
      )
      ORDER BY a.updated_at DESC, a.id DESC
      LIMIT ? OFFSET ?
      `,
    ).all(limit, offset) as Array<{
      id: string;
      email_id: string;
      attachment_index: number;
      filename: string;
      mime_type: string;
      file_size_bytes: number;
      extraction_status: string;
      extraction_error: string | null;
      created_at: string;
      updated_at: string;
      subject: string;
      subject_slug: string;
      from_addr: string;
      to_addrs: string;
      sent_at: string | null;
      message_id: string | null;
      thread_id: string | null;
      in_reply_to: string | null;
      uid: number;
      folder: string;
      chunk_count: number;
      text_preview: string | null;
    }>;

    return {
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
      total,
      limit,
      offset,
      items: rows.map((row) => {
        const itemUrl = this.generateUrlFromMetadata({
          messageId: row.message_id,
          threadId: row.thread_id,
          uid: row.uid,
          folder: row.folder,
          inReplyTo: row.in_reply_to,
          from: row.from_addr,
          to: parseJsonArray(row.to_addrs).join(","),
          date: row.sent_at,
          subjectSlug: row.subject_slug,
        });

        return {
        attachmentId: row.id,
        emailId: row.email_id,
        attachmentIndex: row.attachment_index,
        fileName: row.filename,
        mimeType: row.mime_type,
        fileSizeBytes: row.file_size_bytes,
        extractionStatus: row.extraction_status,
        extractionError: row.extraction_error ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        chunkCount: row.chunk_count,
        textPreview: row.text_preview ?? "",
        email: {
          subject: row.subject,
          from: row.from_addr,
          sentAt: row.sent_at,
          messageId: row.message_id,
          threadId: row.thread_id,
          uid: row.uid,
          folder: row.folder,
          itemUrl,
        },
        };
      }),
    };
  }

  getAttachment(input: GetAttachmentInput): Record<string, unknown> {
    const attachmentId = input.attachmentId?.trim();
    if (!attachmentId) {
      throw new Error("attachmentId is required");
    }

    const row = this.db.prepare(
      `
      SELECT
        a.id,
        a.email_id,
        a.attachment_index,
        a.filename,
        a.mime_type,
        a.file_size_bytes,
        a.extraction_status,
        a.extraction_error,
        a.created_at,
        a.updated_at,
        m.subject,
        m.subject_slug,
        m.from_addr,
        m.to_addrs,
        m.sent_at,
        m.message_id,
        m.thread_id,
        m.in_reply_to,
        m.uid,
        m.folder,
        md.markdown_content
      FROM imap_email_attachments a
      INNER JOIN imap_emails m ON m.id = a.email_id
      LEFT JOIN imap_attachment_markdown md ON md.attachment_id = a.id
      WHERE a.id = ?
      LIMIT 1
      `,
    ).get(attachmentId) as {
      id: string;
      email_id: string;
      attachment_index: number;
      filename: string;
      mime_type: string;
      file_size_bytes: number;
      extraction_status: string;
      extraction_error: string | null;
      created_at: string;
      updated_at: string;
      subject: string;
      subject_slug: string;
      from_addr: string;
      to_addrs: string;
      sent_at: string | null;
      message_id: string | null;
      thread_id: string | null;
      in_reply_to: string | null;
      uid: number;
      folder: string;
      markdown_content: string | null;
    } | undefined;

    if (!row) {
      throw new Error(`Attachment not found: ${attachmentId}`);
    }

    const chunks = this.db.prepare(
      `
      SELECT content
      FROM imap_attachment_chunks
      WHERE attachment_id = ?
      ORDER BY chunk_index ASC
      `,
    ).all(attachmentId) as Array<{ content: string }>;

    const text = chunks.map((chunk) => chunk.content).join("\n\n");
    const itemUrl = this.generateUrlFromMetadata({
      messageId: row.message_id,
      threadId: row.thread_id,
      uid: row.uid,
      folder: row.folder,
      inReplyTo: row.in_reply_to,
      from: row.from_addr,
      to: parseJsonArray(row.to_addrs).join(","),
      date: row.sent_at,
      subjectSlug: row.subject_slug,
    });

    const references = itemUrl
      ? [{
          url: itemUrl,
          title: row.subject?.trim().length ? row.subject : itemUrl,
          kind: "email",
          sourceTool: "imap_get_attachment",
        }]
      : [];

    return {
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
      attachmentId: row.id,
      emailId: row.email_id,
      attachmentIndex: row.attachment_index,
      fileName: row.filename,
      mimeType: row.mime_type,
      fileSizeBytes: row.file_size_bytes,
      extractionStatus: row.extraction_status,
      extractionError: row.extraction_error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      text,
      markdownText: row.markdown_content ?? undefined,
      email: {
        subject: row.subject,
        from: row.from_addr,
        sentAt: row.sent_at,
        messageId: row.message_id,
        threadId: row.thread_id,
        uid: row.uid,
        folder: row.folder,
        itemUrl,
      },
      references,
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
      return {
        toolKey: this.settings.toolKey,
        displayName: this.settings.displayName,
        reindexed: 1,
        chunkCount,
        emailId: row.id,
        qualifiedEmailId: this.qualifyScopedId(row.id),
      };
    }

    const rows = this.db.prepare("SELECT id FROM imap_emails ORDER BY updated_at DESC").all() as Array<{ id: string }>;
    let totalChunks = 0;
    for (const row of rows) {
      totalChunks += await this.reindexEmail(row.id);
    }

    return {
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
      reindexed: rows.length,
      chunkCount: totalChunks,
    };
  }

  async clearIndex(): Promise<Record<string, unknown>> {
    if (this.crawlRuntime?.active) {
      this.crawlAbortRequested = true;
    }

    const countsBefore = {
      emails: (this.db.prepare("SELECT COUNT(*) AS count FROM imap_emails").get() as { count: number }).count,
      chunks: (this.db.prepare("SELECT COUNT(*) AS count FROM imap_email_chunks").get() as { count: number }).count,
      embeddings: (this.db.prepare("SELECT COUNT(*) AS count FROM imap_chunk_embeddings").get() as { count: number }).count,
      attachments: (this.db.prepare("SELECT COUNT(*) AS count FROM imap_email_attachments").get() as { count: number }).count,
      attachmentChunks: (this.db.prepare("SELECT COUNT(*) AS count FROM imap_attachment_chunks").get() as { count: number }).count,
      attachmentMarkdown: (this.db.prepare("SELECT COUNT(*) AS count FROM imap_attachment_markdown").get() as { count: number }).count,
      attachmentEmbeddings: (this.db.prepare("SELECT COUNT(*) AS count FROM imap_attachment_embeddings").get() as { count: number }).count,
      folderState: (this.db.prepare("SELECT COUNT(*) AS count FROM imap_crawl_state").get() as { count: number }).count,
    };

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM imap_crawl_state").run();
      this.db.prepare("DELETE FROM imap_emails").run();
    });
    tx();

    this.estimateCache = null;

    const willAutoCrawl = this.settings.crawlMode !== "manual";
    if (willAutoCrawl) {
      void this.crawl({ full: true }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[tool-imap] post-clear crawl failed: ${message}\n`);
      });
    }

    return {
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
      clearedAt: new Date().toISOString(),
      countsBefore,
      nextCrawlMode: this.settings.crawlMode,
      note: willAutoCrawl
        ? "Index cleared: a full crawl has been started to repopulate from scratch"
        : "Crawl mode is manual: run imap_crawl to repopulate the index",
    };
  }

  getDisplayName(): string | undefined {
    return this.settings.displayName;
  }

  private createClient(): ImapFlow {
    const client = new ImapFlow({
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.secure,
      socketTimeout: ImapIndexService.IMAP_SOCKET_TIMEOUT_MS,
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

    client.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isRecoverableImapConnectionError(error)) {
        this.recordEconnResetFailure(error, "client-event");
        process.stderr.write(`[tool-imap] IMAP recoverable connection error observed: ${message}\n`);
        return;
      }
      process.stderr.write(`[tool-imap] IMAP client error: ${message}\n`);
    });

    return client;
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

    const attachments = (parsed.attachments ?? []).map((attachment, index) => {
      const contentType = normalizeMimeType(attachment.contentType);
      const filename = attachment.filename?.trim() || `attachment-${index + 1}`;
      const content = attachment.content ?? Buffer.alloc(0);
      const attachmentId = buildAttachmentId(id, index);

      return {
        id: attachmentId,
        emailId: id,
        attachmentIndex: index,
        filename,
        contentType,
        fileSizeBytes: content.byteLength,
        contentHash: hashBuffer(content),
        content,
      } satisfies ParsedAttachmentRecord;
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
      itemUrl: null,
      attachments,
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
      null,
      now,
      now,
    );

    return !existing || existing.body_hash !== record.bodyHash || existing.id !== record.id;
  }

  private async reindexEmail(emailId: string): Promise<number> {
    const row = this.db.prepare("SELECT * FROM imap_emails WHERE id = ? LIMIT 1").get(emailId) as EmailRow | undefined;
    if (!row) return 0;

    const chunks = chunkText(row.body_text, this.settings.chunkSize, this.settings.chunkOverlap);
    this.activeEmailIndexingTasks += 1;
    let vectors: Array<number[] | null>;
    try {
      vectors = await this.embedChunks(chunks);
    } finally {
      this.activeEmailIndexingTasks = Math.max(0, this.activeEmailIndexingTasks - 1);
    }
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
    this.drainAttachmentQueue();
    return chunks.length;
  }

  private canProcessAttachmentsForEmail(emailId: string): boolean {
    if (!this.settings.attachment.enabled) {
      return false;
    }
    if (this.settings.indexingStrategy !== "immediate") {
      return false;
    }
    return this.isEmailEmbeddingIndexed(emailId);
  }

  private isEmailEmbeddingIndexed(emailId: string): boolean {
    const chunkCount = (this.db.prepare(
      "SELECT COUNT(*) AS count FROM imap_email_chunks WHERE email_id = ?",
    ).get(emailId) as { count: number }).count;

    if (chunkCount === 0) {
      return true;
    }

    const indexedCount = (this.db.prepare(
      "SELECT COUNT(*) AS count FROM imap_chunk_embeddings WHERE email_id = ? AND status = 'indexed'",
    ).get(emailId) as { count: number }).count;

    return indexedCount === chunkCount;
  }

  private enqueueAttachmentTasks(emailId: string, attachments: ParsedAttachmentRecord[]): void {
    this.attachmentLogState.queued += attachments.length;
    for (const attachment of attachments) {
      this.attachmentQueue.push({ emailId, attachment });
    }
    this.logAttachmentEvent(
      `queued emailId=${emailId} added=${attachments.length} queue=${this.attachmentQueue.length}`,
    );
    this.maybeLogAttachmentProgress(false);
    this.drainAttachmentQueue();
  }

  private drainAttachmentQueue(): void {
    if (!this.settings.attachment.enabled) {
      return;
    }
    if (this.activeEmailIndexingTasks > 0) {
      if (!this.attachmentDrainDeferredLogged) {
        this.attachmentDrainDeferredLogged = true;
        this.logAttachmentEvent(
          `deferred queue=${this.attachmentQueue.length} activeEmailTasks=${this.activeEmailIndexingTasks}`,
        );
      }
      setImmediate(() => this.drainAttachmentQueue());
      return;
    }

    if (this.attachmentDrainDeferredLogged) {
      this.attachmentDrainDeferredLogged = false;
      this.logAttachmentEvent("resumed after email-priority deferral");
    }

    while (
      this.activeAttachmentTasks < this.settings.attachment.parallelism
      && this.attachmentQueue.length > 0
    ) {
      const task = this.attachmentQueue.shift();
      if (!task) {
        return;
      }

      this.activeAttachmentTasks += 1;
      this.logAttachmentEvent(
        `start attachmentId=${task.attachment.id} emailId=${task.emailId} mime=${task.attachment.contentType} `
        + `size=${task.attachment.fileSizeBytes}B active=${this.activeAttachmentTasks} queue=${this.attachmentQueue.length}`,
      );
      void this.processAttachmentTask(task)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[tool-imap] attachment processing failed: ${message}\n`);
        })
        .finally(() => {
          this.activeAttachmentTasks = Math.max(0, this.activeAttachmentTasks - 1);
          this.maybeLogAttachmentProgress(false);
          this.drainAttachmentQueue();
        });
    }
  }

  private async processAttachmentTask(task: AttachmentTask): Promise<void> {
    const { attachment } = task;
    const now = new Date().toISOString();

    this.db.prepare(
      `
      INSERT INTO imap_email_attachments (
        id,
        email_id,
        attachment_index,
        filename,
        mime_type,
        file_size_bytes,
        content_hash,
        extraction_status,
        extraction_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email_id, attachment_index) DO UPDATE SET
        id = excluded.id,
        filename = excluded.filename,
        mime_type = excluded.mime_type,
        file_size_bytes = excluded.file_size_bytes,
        content_hash = excluded.content_hash,
        extraction_status = excluded.extraction_status,
        extraction_error = excluded.extraction_error,
        updated_at = excluded.updated_at
      `,
    ).run(
      attachment.id,
      attachment.emailId,
      attachment.attachmentIndex,
      attachment.filename,
      attachment.contentType,
      attachment.fileSizeBytes,
      attachment.contentHash,
      "queued",
      null,
      now,
      now,
    );

    if (!this.isAttachmentMimeAllowed(attachment.contentType)) {
      this.replaceAttachmentMarkdown(attachment.id, null);
      this.attachmentLogState.processed += 1;
      this.attachmentLogState.skipped += 1;
      this.logAttachmentEvent(
        `skip-mime attachmentId=${attachment.id} emailId=${attachment.emailId} mime=${attachment.contentType}`,
      );
      this.markAttachmentStatus(attachment.id, "skipped-mime", null);
      return;
    }

    if (attachment.fileSizeBytes > this.settings.attachment.maxFileSizeBytes) {
      this.replaceAttachmentMarkdown(attachment.id, null);
      this.attachmentLogState.processed += 1;
      this.attachmentLogState.skipped += 1;
      this.logAttachmentEvent(
        `skip-size attachmentId=${attachment.id} emailId=${attachment.emailId} size=${attachment.fileSizeBytes}B`,
      );
      this.markAttachmentStatus(attachment.id, "skipped-size", null);
      return;
    }

    const processor = this.attachmentProcessors.resolve(attachment.contentType);
    if (!processor) {
      this.replaceAttachmentMarkdown(attachment.id, null);
      this.attachmentLogState.processed += 1;
      this.attachmentLogState.skipped += 1;
      this.logAttachmentEvent(
        `skip-unsupported attachmentId=${attachment.id} emailId=${attachment.emailId} mime=${attachment.contentType}`,
      );
      this.markAttachmentStatus(attachment.id, "skipped-unsupported", null);
      return;
    }

    this.markAttachmentStatus(attachment.id, "processing", null);

    try {
      const extraction = await processor.extract(
        {
          content: attachment.content,
          contentType: attachment.contentType,
          filename: attachment.filename,
        },
        {
          extractPdfLayoutText: (input) => this.extractPdfLayoutText(input.content, input.filename),
          ocrPdfPages: (input) => this.ocrPdfPages(input.content, input.filename),
          ocrImage: (input) => this.ocrImageAttachment(input.content, input.contentType, input.filename),
          describePhoto: (input) => this.describePhotoAttachment(input.content, input.contentType, input.filename),
        },
      );
      const text = extraction.text.trim();
      const markdownText = extraction.markdownText?.trim() ?? "";

      if (!text) {
        this.replaceAttachmentMarkdown(attachment.id, null);
        this.replaceAttachmentChunksAndEmbeddings(attachment.id, attachment.emailId, []);
        this.attachmentLogState.processed += 1;
        this.attachmentLogState.skipped += 1;
        this.logAttachmentEvent(
          `skip-empty attachmentId=${attachment.id} emailId=${attachment.emailId} mime=${attachment.contentType}`,
        );
        this.markAttachmentStatus(attachment.id, "skipped-empty", null);
        return;
      }

      const chunks = chunkText(text, this.settings.chunkSize, this.settings.chunkOverlap);
      const vectors = await this.embedChunks(chunks);
      this.replaceAttachmentChunksAndEmbeddings(attachment.id, attachment.emailId, chunks, vectors);
      this.replaceAttachmentMarkdown(attachment.id, markdownText.length > 0 ? markdownText : null);
      this.attachmentLogState.processed += 1;
      this.attachmentLogState.indexed += 1;
      this.logAttachmentEvent(
        `indexed attachmentId=${attachment.id} emailId=${attachment.emailId} chunks=${chunks.length}`,
      );
      this.markAttachmentStatus(attachment.id, "indexed", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.replaceAttachmentMarkdown(attachment.id, null);
      this.attachmentLogState.processed += 1;
      this.attachmentLogState.failed += 1;
      this.logAttachmentEvent(
        `failed attachmentId=${attachment.id} emailId=${attachment.emailId} error=${message.slice(0, 200)}`,
      );
      this.markAttachmentStatus(attachment.id, "failed", message.slice(0, 2000));
      throw error;
    }
  }

  private isAttachmentMimeAllowed(contentType: string): boolean {
    const normalized = normalizeMimeType(contentType);
    if (!this.settings.attachment.mimeAllowList) {
      return this.attachmentProcessors.resolve(normalized) !== null;
    }
    return this.settings.attachment.mimeAllowList.includes(normalized);
  }

  private markAttachmentStatus(attachmentId: string, status: string, error: string | null): void {
    this.db.prepare(
      "UPDATE imap_email_attachments SET extraction_status = ?, extraction_error = ?, updated_at = ? WHERE id = ?",
    ).run(status, error, new Date().toISOString(), attachmentId);
  }

  private replaceAttachmentChunksAndEmbeddings(
    attachmentId: string,
    emailId: string,
    chunks: ChunkRecord[],
    vectors: Array<number[] | null> = [],
  ): void {
    const now = new Date().toISOString();
    const status = this.settings.indexingStrategy === "immediate" ? "indexed" : "pending";

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM imap_attachment_embeddings WHERE attachment_id = ?").run(attachmentId);
      this.db.prepare("DELETE FROM imap_attachment_chunks WHERE attachment_id = ?").run(attachmentId);

      const insertChunk = this.db.prepare(
        `
        INSERT INTO imap_attachment_chunks (
          id,
          attachment_id,
          email_id,
          chunk_index,
          start_offset,
          end_offset,
          content,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );

      const insertEmbedding = this.db.prepare(
        `
        INSERT INTO imap_attachment_embeddings (
          chunk_id,
          attachment_id,
          email_id,
          embedding_model_key,
          vector_json,
          status,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      );

      for (const [index, chunk] of chunks.entries()) {
        insertChunk.run(
          chunk.id,
          attachmentId,
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
          attachmentId,
          emailId,
          this.settings.embeddingModelKey,
          vectors[index] ? JSON.stringify(vectors[index]) : null,
          status,
          now,
        );
      }
    });

    tx();
  }

  private replaceAttachmentMarkdown(attachmentId: string, markdownText: string | null): void {
    const normalized = markdownText?.trim() ?? "";
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM imap_attachment_markdown WHERE attachment_id = ?").run(attachmentId);
      if (!normalized) {
        return;
      }
      this.db.prepare(
        `
        INSERT INTO imap_attachment_markdown (
          attachment_id,
          markdown_content,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?)
        `,
      ).run(attachmentId, normalized, now, now);
    });

    tx();
  }

  private async extractPdfLayoutText(content: Buffer, filename: string): Promise<string | null> {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "imap-pdf-text-"));
    const inputPath = path.join(tempDir, sanitizeFilename(filename || "document.pdf"));
    try {
      await fsPromises.writeFile(inputPath, content);
      const result = await execFile("pdftotext", ["-layout", inputPath, "-"], {
        maxBuffer: 20 * 1024 * 1024,
      }) as { stdout: string; stderr: string };
      const text = result.stdout.trim();
      return text || null;
    } catch {
      return null;
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async ocrPdfPages(content: Buffer, filename: string): Promise<string> {
    const pages = await this.renderPdfPagesToPng(content, filename);
    if (!pages.length) return "";

    const limitedPages = pages.slice(0, this.settings.attachment.pdfMaxOcrPages);
    const parts: string[] = [];
    for (const [index, pageImage] of limitedPages.entries()) {
      const pageText = await this.runOllamaVisionPrompt({
        modelKey: this.settings.attachment.ocrModelKey,
        prompt: "Extract all visible text in reading order from this document page. Keep line breaks where meaningful. Do not add commentary.",
        image: pageImage,
        contentType: "image/png",
      });
      const normalized = pageText.trim();
      if (normalized) {
        parts.push(`[Page ${index + 1}]\n${normalized}`);
      }
    }
    return parts.join("\n\n");
  }

  private async renderPdfPagesToPng(content: Buffer, filename: string): Promise<Buffer[]> {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "imap-pdf-ocr-"));
    const inputPath = path.join(tempDir, sanitizeFilename(filename || "document.pdf"));
    const outputPrefix = path.join(tempDir, "page");
    try {
      await fsPromises.writeFile(inputPath, content);
      await execFile("pdftoppm", [
        "-png",
        "-r",
        String(ImapIndexService.DEFAULT_PDF_DPI),
        inputPath,
        outputPrefix,
      ], {
        maxBuffer: 20 * 1024 * 1024,
      });

      const files = (await fsPromises.readdir(tempDir))
        .filter((name) => /^page-\d+\.png$/i.test(name))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

      const buffers: Buffer[] = [];
      for (const file of files) {
        buffers.push(await fsPromises.readFile(path.join(tempDir, file)));
      }
      return buffers;
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async ocrImageAttachment(content: Buffer, contentType: string, filename: string): Promise<string> {
    return this.runOllamaVisionPrompt({
      modelKey: this.settings.attachment.ocrModelKey,
      prompt: `Extract all visible text from this image attachment named "${filename}". Return only extracted text in reading order.`,
      image: content,
      contentType,
    });
  }

  private async describePhotoAttachment(content: Buffer, contentType: string, filename: string): Promise<string> {
    return this.runOllamaVisionPrompt({
      modelKey: this.settings.attachment.photoCaptionModelKey,
      prompt: `Describe this photo attachment named "${filename}" for semantic search. Focus on people, objects, scene, actions, text signs, and notable context in 3-6 concise sentences.`,
      image: content,
      contentType,
    });
  }

  private async runOllamaVisionPrompt(input: {
    modelKey: string;
    prompt: string;
    image: Buffer;
    contentType: string;
  }): Promise<string> {
    const entry = this.modelRegistry.resolveEntry(input.modelKey);
    if (entry.provider !== "ollama") {
      throw new Error(
        `Attachment vision model must use provider=ollama modelKey=${input.modelKey} `
        + `provider=${entry.provider} model=${entry.model}`,
      );
    }

    const baseUrl = (entry.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: entry.model,
        prompt: input.prompt,
        images: [input.image.toString("base64")],
        stream: false,
        keep_alive: entry.keepAlive,
        options: {
          temperature: entry.temperature ?? 0,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Ollama request failed status=${response.status} modelKey=${input.modelKey} model=${entry.model} `
        + `baseUrl=${baseUrl}: ${errorBody.slice(0, 500)}`,
      );
    }

    const payload = await response.json() as { response?: string };
    return (payload.response ?? "").trim();
  }

  private async embedChunks(chunks: ChunkRecord[]): Promise<Array<number[] | null>> {
    if (!chunks.length) return [];
    if (this.settings.indexingStrategy !== "immediate") {
      return chunks.map(() => null);
    }

    const embeddings = this.embeddingRegistry.get(this.settings.embeddingModelKey);
    const vectors: number[][] = [];
    for (let index = 0; index < chunks.length; index += this.settings.embeddingBatchSize) {
      const batch = chunks.slice(index, index + this.settings.embeddingBatchSize);
      const batchVectors = await embeddings.embedDocuments(batch.map((chunk) => chunk.content));
      for (const vector of batchVectors) {
        vectors.push([...vector]);
      }
    }
    return vectors;
  }

  private async getQueryEmbedding(query: string, rows: ChunkRow[]): Promise<number[] | null> {
    if (this.settings.indexingStrategy !== "immediate") return null;

    const hasIndexedVectors = rows.some((row) => row.embedding_status === "indexed" && row.vector_json);
    if (!hasIndexedVectors) return null;

    const embeddings = this.embeddingRegistry.get(this.settings.embeddingModelKey);
    const vector = await withTimeout(
      embeddings.embedQuery(query),
      ImapIndexService.SEARCH_EMBED_TIMEOUT_MS,
      `embedding request timed out after ${ImapIndexService.SEARCH_EMBED_TIMEOUT_MS}ms`,
    );
    return [...vector];
  }

  private resolveEmail(input: GetEmailInput): EmailRow {
    const resolvedEmailId = this.normalizeQualifiedEmailId(input.emailId);
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
      resolvedEmailId ?? null,
      resolvedEmailId ?? null,
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
    const itemUrl = this.generateUrlFromMetadata({
      messageId: row.message_id,
      threadId: row.thread_id,
      uid: row.uid,
      folder: row.folder,
      inReplyTo: row.in_reply_to,
      from: row.from_addr,
      to: parseJsonArray(row.to_addrs).join(","),
      date: row.sent_at,
      subjectSlug: row.subject_slug,
    });
    return {
      id: row.id,
      qualifiedId: this.qualifyScopedId(row.id),
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
      folder: row.folder,
      uid: row.uid,
      messageId: row.message_id,
      threadId: row.thread_id,
      qualifiedThreadId: row.thread_id ? this.qualifyScopedId(row.thread_id) : null,
      inReplyTo: row.in_reply_to,
      subject: row.subject,
      subjectSlug: row.subject_slug,
      from: row.from_addr,
      to: parseJsonArray(row.to_addrs),
      sentAt: row.sent_at,
      receivedAt: row.created_at,
      body: row.body_text,
      itemUrl,
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

  private qualifyScopedId(id: string): string {
    return `${this.settings.toolKey}:${id}`;
  }

  private normalizeQualifiedEmailId(emailId?: string): string | undefined {
    const value = emailId?.trim();
    if (!value) return undefined;
    const prefix = `${this.settings.toolKey}:`;
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }

    const separatorIndex = value.indexOf(":");
    if (separatorIndex > 0) {
      const instanceKey = value.slice(0, separatorIndex);
      if (instanceKey !== this.settings.toolKey) {
        throw new Error(`Email id belongs to IMAP instance \"${instanceKey}\", not \"${this.settings.toolKey}\"`);
      }
      return value.slice(separatorIndex + 1);
    }

    return value;
  }

  private normalizeQualifiedThreadId(threadId?: string): string | undefined {
    const value = threadId?.trim();
    if (!value) return undefined;
    const prefix = `${this.settings.toolKey}:`;
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
  }

  private decorateEmailSummary(
    email: Pick<EmailRow, "id" | "folder" | "uid" | "message_id" | "thread_id" | "subject" | "subject_slug" | "from_addr" | "to_addrs" | "sent_at" | "in_reply_to" | "created_at" | "updated_at">,
  ): Record<string, unknown> {
    const itemUrl = this.generateUrlFromMetadata({
      messageId: email.message_id,
      threadId: email.thread_id,
      uid: email.uid,
      folder: email.folder,
      inReplyTo: email.in_reply_to,
      from: email.from_addr,
      to: parseJsonArray(email.to_addrs).join(","),
      date: email.sent_at,
      subjectSlug: email.subject_slug,
    });
    return {
      id: email.id,
      qualifiedId: this.qualifyScopedId(email.id),
      toolKey: this.settings.toolKey,
      displayName: this.settings.displayName,
      folder: email.folder,
      uid: email.uid,
      messageId: email.message_id,
      threadId: email.thread_id,
      qualifiedThreadId: email.thread_id ? this.qualifyScopedId(email.thread_id) : null,
      subject: email.subject,
      from: email.from_addr,
      sentAt: email.sent_at,
      receivedAt: email.created_at,
      createdAt: email.created_at,
      updatedAt: email.updated_at,
      itemUrl,
    };
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

      CREATE TABLE IF NOT EXISTS imap_email_attachments (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL,
        attachment_index INTEGER NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        extraction_status TEXT NOT NULL,
        extraction_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(email_id) REFERENCES imap_emails(id) ON DELETE CASCADE,
        UNIQUE(email_id, attachment_index)
      );

      CREATE INDEX IF NOT EXISTS idx_imap_email_attachments_email_id ON imap_email_attachments(email_id);
      CREATE INDEX IF NOT EXISTS idx_imap_email_attachments_status ON imap_email_attachments(extraction_status);

      CREATE TABLE IF NOT EXISTS imap_attachment_chunks (
        id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL,
        email_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(attachment_id) REFERENCES imap_email_attachments(id) ON DELETE CASCADE,
        FOREIGN KEY(email_id) REFERENCES imap_emails(id) ON DELETE CASCADE,
        UNIQUE(attachment_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_imap_attachment_chunks_attachment_id ON imap_attachment_chunks(attachment_id);
      CREATE INDEX IF NOT EXISTS idx_imap_attachment_chunks_email_id ON imap_attachment_chunks(email_id);

      CREATE TABLE IF NOT EXISTS imap_attachment_embeddings (
        chunk_id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL,
        email_id TEXT NOT NULL,
        embedding_model_key TEXT NOT NULL,
        vector_json TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES imap_attachment_chunks(id) ON DELETE CASCADE,
        FOREIGN KEY(attachment_id) REFERENCES imap_email_attachments(id) ON DELETE CASCADE,
        FOREIGN KEY(email_id) REFERENCES imap_emails(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_imap_attachment_embeddings_attachment_id ON imap_attachment_embeddings(attachment_id);
      CREATE INDEX IF NOT EXISTS idx_imap_attachment_embeddings_email_id ON imap_attachment_embeddings(email_id);

      CREATE TABLE IF NOT EXISTS imap_attachment_markdown (
        attachment_id TEXT PRIMARY KEY,
        markdown_content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(attachment_id) REFERENCES imap_email_attachments(id) ON DELETE CASCADE
      );
    `);
  }

  private resolveSettings(toolKey: string, entry: ImapToolConfig): ResolvedImapSettings {
    const secure = entry.server.secure ?? true;
    const displayName = entry.displayName?.trim();
    const allFoldersExcept = dedupe(entry.crawl?.allFoldersExcept ?? []);
    const mimeAllowList = entry.attachment?.mimeAllowList && entry.attachment.mimeAllowList.length > 0
      ? dedupe(entry.attachment.mimeAllowList.map((mimeType) => normalizeMimeType(mimeType)))
      : null;
    return {
      toolKey,
      displayName: displayName && displayName.length > 0 ? displayName : undefined,
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
      embeddingBatchSize: entry.vector?.embeddingBatchSize ?? 8,
      embeddingModelKey: entry.vector?.embeddingModelKey ?? "default",
      indexingStrategy: entry.vector?.indexingStrategy ?? "immediate",
      indexDbPath: entry.indexDbPath ?? `data/imap-${slugify(toolKey)}.sqlite`,
      urlTemplate: entry.urlTemplate,
      attachment: {
        enabled: entry.attachment?.enabled ?? false,
        mimeAllowList,
        maxFileSizeBytes: entry.attachment?.maxFileSizeBytes ?? 100 * 1024 * 1024,
        parallelism: entry.attachment?.parallelism ?? 2,
        ocrModelKey: entry.attachment?.ocrModelKey ?? "imap-ocr-vision",
        photoCaptionModelKey: entry.attachment?.photoCaptionModelKey ?? "imap-photo-caption",
        pdfMaxOcrPages: entry.attachment?.pdfMaxOcrPages ?? 8,
      },
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

  private getCrawlRuntimeSnapshot(): Record<string, unknown> {
    if (!this.crawlRuntime) {
      return {
        active: false,
      };
    }

    const elapsedMs = this.crawlRuntime.active
      ? Math.max(0, Date.now() - this.crawlRuntime.startedAtMs)
      : 0;

    return {
      active: this.crawlRuntime.active,
      mode: this.crawlRuntime.mode,
      startedAt: this.crawlRuntime.startedAtIso,
      elapsedMs,
      currentFolder: this.crawlRuntime.currentFolder,
      totalFolders: this.crawlRuntime.totalFolders,
      completedFolders: this.crawlRuntime.completedFolders,
      crawledEmails: this.crawlRuntime.crawledEmails,
      changedEmails: this.crawlRuntime.changedEmails,
      indexedChunks: this.crawlRuntime.indexedChunks,
      lastFinishedAt: this.crawlRuntime.lastFinishedAtIso,
    };
  }

  private isEconnResetError(error: unknown): boolean {
    const details = this.getImapErrorDetails(error);
    return details.code === "ECONNRESET" || /\beconnreset\b/i.test(details.message);
  }

  private isSocketTimeoutError(error: unknown): boolean {
    const details = this.getImapErrorDetails(error);
    return details.code === "ETIMEDOUT" || /socket timeout|timed out/i.test(details.message);
  }

  private isRecoverableImapConnectionError(error: unknown): boolean {
    return this.isEconnResetError(error) || this.isSocketTimeoutError(error);
  }

  private getImapErrorDetails(error: unknown): ImapErrorDetails {
    const candidate = error as {
      code?: unknown;
      syscall?: unknown;
      message?: unknown;
    } | null;

    const code = typeof candidate?.code === "string" ? candidate.code : "UNKNOWN";
    const syscall = typeof candidate?.syscall === "string" ? candidate.syscall : "unknown";
    const message = error instanceof Error
      ? error.message
      : typeof candidate?.message === "string"
        ? candidate.message
        : String(error);

    return {
      code,
      syscall,
      message,
    };
  }

  private pruneEconnResetFailures(nowMs: number): void {
    const cutoff = nowMs - ImapIndexService.ECONNRESET_FAILURE_WINDOW_MS;
    while (this.econnResetFailureTimestampsMs.length && this.econnResetFailureTimestampsMs[0]! < cutoff) {
      this.econnResetFailureTimestampsMs.shift();
    }
  }

  private recordEconnResetFailure(error: unknown, source: "crawl" | "client-event"): void {
    const now = Date.now();
    const details = this.getImapErrorDetails(error);
    const signature = `${details.code}|${details.syscall}|${details.message}`;
    if (
      this.lastEconnResetSignature === signature
      && now - this.lastEconnResetRecordedAtMs < ImapIndexService.ECONNRESET_DEDUPE_MS
    ) {
      return;
    }

    this.lastEconnResetSignature = signature;
    this.lastEconnResetRecordedAtMs = now;
    this.econnResetFailureTimestampsMs.push(now);
    this.pruneEconnResetFailures(now);

    const failureCount = this.econnResetFailureTimestampsMs.length;
    process.stderr.write(
      `[tool-imap] IMAP ${details.code} failure source=${source} syscall=${details.syscall} `
      + `countLastHour=${failureCount}/${ImapIndexService.ECONNRESET_FAILURE_LIMIT} message=${details.message}\n`,
    );

    if (failureCount > ImapIndexService.ECONNRESET_FAILURE_LIMIT && !this.crawlStoppedByImapErrors) {
      this.crawlStoppedByImapErrors = true;
      this.crawlStopReason =
        `Stopped after ${failureCount} recoverable IMAP connection failures within ${ImapIndexService.ECONNRESET_FAILURE_WINDOW_MS / 60000} minutes`;
      this.crawlAbortRequested = true;

      if (this.crawlRuntime) {
        this.crawlRuntime.active = false;
        this.crawlRuntime.currentFolder = null;
      }

      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }

      process.stderr.write(`[tool-imap] ${this.crawlStopReason}\n`);
    }
  }

  private async estimateRemainingEmails(): Promise<Record<string, unknown>> {
    const client = this.createClient();
    try {
      await client.connect();
      const folders = await this.resolveFoldersToCrawl(client);
      const byFolder: Array<Record<string, unknown>> = [];
      let remainingEmails = 0;

      for (const folder of folders) {
        await client.mailboxOpen(folder);
        const maxUid = await this.getMaxUid(client, folder);
        const state = this.getFolderState(folder);
        const crawledToUid = state.lastUid ?? 0;
        const remaining = Math.max(0, maxUid - crawledToUid);
        remainingEmails += remaining;
        byFolder.push({
          folder,
          crawledToUid,
          maxUid,
          remainingEmails: remaining,
        });
      }

      return {
        available: true,
        remainingEmails,
        byFolder,
      };
    } catch (error) {
      return {
        available: false,
        remainingEmails: null,
        byFolder: [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async getEstimateWithCache(input: { forceRefresh?: boolean } = {}): Promise<Record<string, unknown>> {
    const now = Date.now();
    const forceRefresh = input.forceRefresh === true;
    if (!forceRefresh && this.estimateCache) {
      const ageMs = now - this.estimateCache.capturedAtMs;
      if (ageMs >= 0 && ageMs < ImapIndexService.ESTIMATE_CACHE_TTL_MS) {
        return {
          ...this.estimateCache.value,
          cache: {
            hit: true,
            ageMs,
            ttlMs: ImapIndexService.ESTIMATE_CACHE_TTL_MS,
          },
        };
      }
    }

    const fresh = await this.estimateRemainingEmails();
    this.estimateCache = {
      capturedAtMs: now,
      value: fresh,
    };

    return {
      ...fresh,
      cache: {
        hit: false,
        ageMs: 0,
        ttlMs: ImapIndexService.ESTIMATE_CACHE_TTL_MS,
      },
    };
  }

  private maybeLogCrawlProgress(
    progress: CrawlProgressState,
    details: {
      folder: string;
      foldersCompleted: number;
      totalFolders: number;
      crawledCount: number;
      changedEmails: number;
      indexedCount: number;
      force: boolean;
    },
  ): void {
    const now = Date.now();
    const elapsedMs = now - progress.startedAtMs;
    const shouldLog = details.force
      || details.crawledCount === 1
      || details.crawledCount % 25 === 0
      || now - progress.lastLoggedAtMs >= 15000;

    if (!shouldLog) {
      return;
    }

    progress.lastLoggedAtMs = now;
    const embeddingStatus = this.settings.indexingStrategy === "immediate" ? "indexed" : "pending";
    console.log(
      `[tool-imap] crawl progress tool=${this.settings.toolKey} `
      + `folder=${details.folder} folders=${details.foldersCompleted}/${details.totalFolders} `
      + `emails=${details.crawledCount} changed=${details.changedEmails} `
      + `chunks=${details.indexedCount} embeddings=${embeddingStatus} `
      + `model=${this.settings.embeddingModelKey} elapsedMs=${elapsedMs}`,
    );
  }

  private logAttachmentEvent(message: string): void {
    console.log(`[tool-imap] attachment ${message} tool=${this.settings.toolKey}`);
  }

  private maybeLogAttachmentProgress(force: boolean): void {
    const now = Date.now();
    const shouldLog = force
      || this.attachmentLogState.processed === 1
      || this.attachmentLogState.processed % 10 === 0
      || now - this.attachmentLogState.lastLoggedAtMs >= 15000;

    if (!shouldLog) {
      return;
    }

    this.attachmentLogState.lastLoggedAtMs = now;
    const elapsedMs = Math.max(0, now - this.attachmentLogState.startedAtMs);
    this.logAttachmentEvent(
      `progress queued=${this.attachmentLogState.queued} processed=${this.attachmentLogState.processed} `
      + `indexed=${this.attachmentLogState.indexed} skipped=${this.attachmentLogState.skipped} `
      + `failed=${this.attachmentLogState.failed} queue=${this.attachmentQueue.length} `
      + `active=${this.activeAttachmentTasks} elapsedMs=${elapsedMs}`,
    );
  }

  private generateUrlFromMetadata(metadata: Record<string, string | number | null | undefined>): string | null {
    if (!this.settings.urlTemplate) return null;
    return this.renderItemUrl(metadata);
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

function normalizeSearchDateField(
  value: SearchInput["dateField"],
): "sentAt" | "receivedAt" | "updatedAt" {
  return value ?? "sentAt";
}

function normalizeSearchSortBy(
  value: SearchInput["sortBy"],
): "relevance" | "sentAt" | "receivedAt" | "updatedAt" {
  return value ?? "relevance";
}

function normalizeSortDirection(value: SearchInput["sortDirection"]): "asc" | "desc" {
  return value === "asc" ? "asc" : "desc";
}

function normalizeSearchYear(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 9999) {
    throw new Error('"year" must be an integer between 1 and 9999');
  }
  return value;
}

function normalizeSearchMonth(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new Error('"month" must be an integer between 1 and 12');
  }
  return value;
}

function normalizeSearchDay(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    throw new Error('"day" must be an integer between 1 and 31');
  }
  return value;
}

function isWildcardQuery(query: string, queryTerms: string[]): boolean {
  if (queryTerms.length > 0) return false;
  const compact = query.replaceAll(/\s+/g, "");
  return compact === "*" || compact === "%" || compact === "*:*";
}

function buildCaseInsensitiveLikePattern(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  const escaped = trimmed
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  return `%${escaped}%`;
}

function resolveSearchDateColumn(dateField: "sentAt" | "receivedAt" | "updatedAt"): string {
  switch (dateField) {
    case "receivedAt":
      return "m.created_at";
    case "updatedAt":
      return "m.updated_at";
    case "sentAt":
    default:
      return "m.sent_at";
  }
}

function resolveMetadataSortClause(
  sortBy: "sentAt" | "receivedAt" | "updatedAt",
  sortDirection: "asc" | "desc",
): { sortColumn: string; sortDirectionSql: "ASC" | "DESC" } {
  const sortColumn = (() => {
    switch (sortBy) {
      case "receivedAt":
        return "m.created_at";
      case "updatedAt":
        return "m.updated_at";
      case "sentAt":
      default:
        return "m.sent_at";
    }
  })();

  return {
    sortColumn,
    sortDirectionSql: sortDirection === "asc" ? "ASC" : "DESC",
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function toSortableTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareSearchEntries(
  left: {
    email: Pick<EmailRow, "sent_at" | "created_at" | "updated_at">;
    score: number;
  },
  right: {
    email: Pick<EmailRow, "sent_at" | "created_at" | "updated_at">;
    score: number;
  },
  sortBy: "relevance" | "sentAt" | "receivedAt" | "updatedAt",
  sortDirection: "asc" | "desc",
): number {
  const direction = sortDirection === "asc" ? 1 : -1;

  if (sortBy === "relevance") {
    const diff = left.score - right.score;
    if (diff !== 0) return diff * direction;
    return (toSortableTimestamp(left.email.sent_at) - toSortableTimestamp(right.email.sent_at)) * -1;
  }

  const leftTimestamp = (() => {
    switch (sortBy) {
      case "receivedAt":
        return toSortableTimestamp(left.email.created_at);
      case "updatedAt":
        return toSortableTimestamp(left.email.updated_at);
      case "sentAt":
      default:
        return toSortableTimestamp(left.email.sent_at);
    }
  })();

  const rightTimestamp = (() => {
    switch (sortBy) {
      case "receivedAt":
        return toSortableTimestamp(right.email.created_at);
      case "updatedAt":
        return toSortableTimestamp(right.email.updated_at);
      case "sentAt":
      default:
        return toSortableTimestamp(right.email.sent_at);
    }
  })();

  const timestampDiff = leftTimestamp - rightTimestamp;
  if (timestampDiff !== 0) return timestampDiff * direction;
  return (left.score - right.score) * -1;
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

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildAttachmentId(emailId: string, attachmentIndex: number): string {
  const digest = createHash("sha1")
    .update(`${emailId}|${attachmentIndex}`)
    .digest("hex")
    .slice(0, 12);
  return `${emailId}-att-${attachmentIndex}-${digest}`;
}

function normalizeMimeType(value: string | null | undefined): string {
  const normalized = value?.toLowerCase().split(";")[0]?.trim();
  return normalized || "application/octet-stream";
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

function formatExcerpt(row: ChunkRow, excerpt: string): string {
  if (row.chunk_source !== "attachment") {
    return excerpt;
  }

  const name = row.attachment_filename ?? "attachment";
  const mime = row.attachment_mime_type ?? "unknown";
  return `[Attachment: ${name} (${mime})] ${excerpt}`;
}

function sanitizeFilename(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
  return normalized || "document.pdf";
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
