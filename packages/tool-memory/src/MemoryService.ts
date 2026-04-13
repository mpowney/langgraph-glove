import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  ConfigLoader,
  EmbeddingRegistry,
  resolveConfigEntry,
  type MemoryEntry,
  type MemoryRetentionTier,
} from "@langgraph-glove/config";

export interface MemoryReference {
  memoryId?: string;
  slug?: string;
  storagePath?: string;
  personalToken?: string;
}

export interface MemoryDocument {
  id: string;
  slug: string;
  title: string;
  scope: string;
  tags: string[];
  status: string;
  retentionTier: MemoryRetentionTier;
  storagePath: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  personal: boolean;
  content: string;
}

export interface MemorySummary {
  id: string;
  slug: string;
  title: string;
  scope: string;
  tags: string[];
  status: string;
  retentionTier: MemoryRetentionTier;
  storagePath: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  personal: boolean;
  lastIndexedAt?: string;
}

export interface CreateMemoryInput {
  title: string;
  content: string;
  scope?: string;
  tags?: string[];
  retentionTier?: MemoryRetentionTier;
  personal?: boolean;
  personalToken?: string;
}

export interface AppendMemoryInput extends MemoryReference {
  content: string;
}

export interface UpdateMemoryInput extends MemoryReference {
  title?: string;
  content?: string;
  scope?: string;
  tags?: string[];
  retentionTier?: MemoryRetentionTier;
  status?: string;
  personal?: boolean;
}

export interface ListMemoriesInput {
  scope?: string;
  tag?: string;
  limit?: number;
}

export interface SearchMemoriesInput {
  query: string;
  scope?: string;
  limit?: number;
  personalToken?: string;
}

export interface ReindexMemoryInput extends MemoryReference {}

export interface DeleteMemoryInput extends MemoryReference {}

export interface DeleteMemoryResult {
  deleted: boolean;
  memoryId: string;
  storagePath: string;
}

export interface ReindexResult {
  reindexed: number;
  chunkCount: number;
  embeddingStatus: "indexed" | "pending" | "disabled";
  embeddingModelKey: string;
}

export interface SearchResultItem {
  memory: MemorySummary;
  score: number;
  excerpts: string[];
}

export interface SearchMemoriesResult {
  query: string;
  retrievalMode: "vector-hybrid" | "lexical-fallback";
  embeddingModelKey: string;
  indexingStrategy: "immediate" | "deferred";
  results: SearchResultItem[];
}

interface MemoryRow {
  id: string;
  slug: string;
  title: string;
  scope: string;
  tags_json: string;
  status: string;
  retention_tier: MemoryRetentionTier;
  storage_path: string;
  created_at: string;
  updated_at: string;
  revision: number;
  is_personal: number;
  last_indexed_at: string | null;
  embedding_model_key: string | null;
  content_hash: string;
}

interface ChunkRow {
  id: string;
  memory_id: string;
  chunk_index: number;
  content: string;
  vector_json: string | null;
  embedding_status: string | null;
  embedding_model_key: string | null;
  title: string;
  scope: string;
  tags_json: string;
  status: string;
  retention_tier: MemoryRetentionTier;
  storage_path: string;
  created_at: string;
  updated_at: string;
  revision: number;
  is_personal: number;
  last_indexed_at: string | null;
}

interface ResolvedMemoryConfig {
  enabled: boolean;
  storageMode: "markdown-sqlite";
  storageDir: string;
  indexDbPath: string;
  defaultScope: string;
  embeddingModelKey: string;
  indexingStrategy: "immediate" | "deferred";
  chunkSize: number;
  chunkOverlap: number;
  retrievalTopK: number;
  maxChunksPerMemory: number;
  includeChunks: boolean;
  hotDays: number;
  warmDays: number;
}

interface ChunkRecord {
  id: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  content: string;
}

const FRONTMATTER_MARKER = "---";
const PERSONAL_PAYLOAD_PREFIX = "glove-personal-v1:";

export class MemoryService {
  private readonly configDir: string;
  private readonly settings: ResolvedMemoryConfig;
  private readonly storageDir: string;
  private readonly dbPath: string;
  private readonly db: Database.Database;
  private readonly embeddingRegistry: EmbeddingRegistry;

  constructor(options: { configDir?: string; secretsDir?: string; profileKey?: string } = {}) {
    this.configDir = path.resolve(options.configDir ?? process.env["GLOVE_CONFIG_DIR"] ?? "config");
    const secretsDir = path.resolve(
      options.secretsDir ?? process.env["GLOVE_SECRETS_DIR"] ?? "secrets",
    );

    const loader = new ConfigLoader(this.configDir, secretsDir);
    const config = loader.load();
    this.embeddingRegistry = new EmbeddingRegistry(config.models);
    const entry = resolveConfigEntry(
      config.memories as Record<string, MemoryEntry>,
      options.profileKey ?? "default",
    );

    this.settings = this.resolveSettings(entry);
    this.storageDir = this.resolveProjectPath(this.settings.storageDir);
    this.dbPath = this.resolveProjectPath(this.settings.indexDbPath);

    fs.mkdirSync(this.storageDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
    this.migrateStoragePathsToRelative();

    if (this.shouldGenerateEmbeddings()) {
      this.embeddingRegistry.get(this.settings.embeddingModelKey);
    }
  }

  validateEmbeddingsModel(): void {
    if (this.shouldGenerateEmbeddings()) {
      try {
        this.embeddingRegistry.get(this.settings.embeddingModelKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Embeddings model "${this.settings.embeddingModelKey}" is not available: ${message}`,
        );
      }
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      enabled: this.settings.enabled,
      storageMode: this.settings.storageMode,
      storageDir: this.storageDir,
      indexDbPath: this.dbPath,
      defaultScope: this.settings.defaultScope,
      embeddingModelKey: this.settings.embeddingModelKey,
      indexingStrategy: this.settings.indexingStrategy,
      chunking: {
        chunkSize: this.settings.chunkSize,
        chunkOverlap: this.settings.chunkOverlap,
      },
      retrieval: {
        topK: this.settings.retrievalTopK,
        maxChunksPerMemory: this.settings.maxChunksPerMemory,
        includeChunks: this.settings.includeChunks,
      },
      tiers: {
        hotDays: this.settings.hotDays,
        warmDays: this.settings.warmDays,
      },
    };
  }

  async createMemory(input: CreateMemoryInput): Promise<MemoryDocument> {
    const title = requireNonEmpty(input.title, "memory_create: 'title' is required");
    const content = requireNonEmpty(input.content, "memory_create: 'content' is required");
    const now = new Date().toISOString();
    const id = randomUUID();
    const slug = uniqueSlug(slugify(title), id);
    const storagePath = `${slug}.md`;

    const document: MemoryDocument = {
      id,
      slug,
      title,
      scope: input.scope?.trim() || this.settings.defaultScope,
      tags: normalizeTags(input.tags),
      status: "active",
      retentionTier: input.retentionTier ?? "hot",
      storagePath,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      personal: input.personal ?? false,
      content,
    };

    this.writeMemoryDocument(document, input.personalToken);
    this.upsertMemoryRow(document);
    await this.reindexDocument(document);
    return document;
  }

  async appendMemory(input: AppendMemoryInput): Promise<MemoryDocument> {
    const content = requireNonEmpty(input.content, "memory_append: 'content' is required");
    const document = this.resolveMemoryDocument(input);
    document.content = document.content.trimEnd()
      ? `${document.content.trimEnd()}\n\n${content}`
      : content;
    document.updatedAt = new Date().toISOString();
    document.revision += 1;
    document.retentionTier = "hot";

    this.writeMemoryDocument(document, input.personalToken);
    this.upsertMemoryRow(document);
    await this.reindexDocument(document);
    return document;
  }

  async updateMemory(input: UpdateMemoryInput): Promise<MemoryDocument> {
    const document = this.resolveMemoryDocument(input);

    if (input.title !== undefined) {
      document.title = requireNonEmpty(input.title, "memory_update: 'title' cannot be empty");
    }
    if (input.content !== undefined) {
      document.content = requireNonEmpty(input.content, "memory_update: 'content' cannot be empty");
    }
    if (input.scope !== undefined) {
      document.scope = requireNonEmpty(input.scope, "memory_update: 'scope' cannot be empty");
    }
    if (input.tags !== undefined) {
      document.tags = normalizeTags(input.tags);
    }
    if (input.retentionTier !== undefined) {
      document.retentionTier = input.retentionTier;
    }
    if (input.status !== undefined) {
      document.status = requireNonEmpty(input.status, "memory_update: 'status' cannot be empty");
    }
    if (input.personal !== undefined) {
      document.personal = Boolean(input.personal);
    }

    document.updatedAt = new Date().toISOString();
    document.revision += 1;

    this.writeMemoryDocument(document, input.personalToken);
    this.upsertMemoryRow(document);
    await this.reindexDocument(document);
    return document;
  }

  getMemory(reference: MemoryReference): MemoryDocument {
    return this.resolveMemoryDocument(reference);
  }

  listMemories(input: ListMemoriesInput = {}): MemorySummary[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM memories
          WHERE (? IS NULL OR scope = ?)
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(input.scope ?? null, input.scope ?? null, limit) as MemoryRow[];

    const summaries = rows.map((row) => this.rowToSummary(row));
    if (!input.tag) return summaries;

    return summaries.filter((summary) => summary.tags.includes(input.tag!));
  }

  async searchMemories(input: SearchMemoriesInput): Promise<SearchMemoriesResult> {
    const query = requireNonEmpty(input.query, "memory_search: 'query' is required");
    const limit = Math.max(1, Math.min(input.limit ?? this.settings.retrievalTopK, 20));
    const queryTerms = tokenize(query);

    const rows = this.db
      .prepare(
        `
          SELECT
            c.id,
            c.memory_id,
            c.chunk_index,
            c.content,
            e.vector_json,
            e.status AS embedding_status,
            e.embedding_model_key,
            m.title,
            m.scope,
            m.tags_json,
            m.status,
            m.retention_tier,
            m.storage_path,
            m.created_at,
            m.updated_at,
            m.revision,
            m.is_personal,
            m.last_indexed_at
          FROM memory_chunks c
          INNER JOIN memories m ON m.id = c.memory_id
          LEFT JOIN memory_chunk_embeddings e ON e.chunk_id = c.id
          WHERE m.status = 'active'
            AND (? IS NULL OR m.scope = ?)
        `,
      )
      .all(input.scope ?? null, input.scope ?? null) as ChunkRow[];

    const queryVector = await this.getQueryEmbedding(query, rows);
    const retrievalMode: SearchMemoriesResult["retrievalMode"] = queryVector
      ? "vector-hybrid"
      : "lexical-fallback";

    const scored = rows
      .map((row) => ({
        row,
        score: scoreChunk(query, queryTerms, row) + scoreVectorMatch(queryVector, row),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);

    const grouped = new Map<string, SearchResultItem>();

    for (const item of scored) {
      const existing = grouped.get(item.row.memory_id);
      const excerpt = excerptForQuery(item.row.content, queryTerms);
      const summary = this.chunkRowToSummary(item.row);
      const canRevealExcerpt = !summary.personal || hasPersonalToken(input.personalToken);

      if (!existing) {
        grouped.set(item.row.memory_id, {
          memory: summary,
          score: item.score,
          excerpts: this.settings.includeChunks && canRevealExcerpt ? [excerpt] : [],
        });
        if (grouped.size >= limit) continue;
        continue;
      }

      if (
        existing.excerpts.length < this.settings.maxChunksPerMemory
        && this.settings.includeChunks
        && canRevealExcerpt
      ) {
        existing.excerpts.push(excerpt);
      }
      existing.score = Math.max(existing.score, item.score);
    }

    const results = Array.from(grouped.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    return {
      query,
      retrievalMode,
      embeddingModelKey: this.settings.embeddingModelKey,
      indexingStrategy: this.settings.indexingStrategy,
      results,
    };
  }

  async reindexMemory(input: ReindexMemoryInput = {}): Promise<ReindexResult> {
    const references = hasReference(input)
      ? [this.resolveMemoryDocument(input)]
      : this.listMemories({ limit: 10_000 })
        .filter((summary) => !summary.personal || hasPersonalToken(input.personalToken))
        .map((summary) => this.getMemory({
          memoryId: summary.id,
          personalToken: input.personalToken,
        }));

    let chunkCount = 0;
    for (const document of references) {
      chunkCount += await this.reindexDocument(document);
    }

    const embeddingStatus: ReindexResult["embeddingStatus"] = this.shouldGenerateEmbeddings()
      ? "indexed"
      : this.settings.embeddingModelKey
        ? "pending"
        : "disabled";

    return {
      reindexed: references.length,
      chunkCount,
      embeddingStatus,
      embeddingModelKey: this.settings.embeddingModelKey,
    };
  }

  deleteMemory(input: DeleteMemoryInput): DeleteMemoryResult {
    const row = this.resolveMemoryRow(input);
    const resolvedStoragePath = this.resolveStoragePath(row.storage_path);
    const relativeStoragePath = this.toStoredStoragePath(row.storage_path);

    this.db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);

    try {
      fs.rmSync(resolvedStoragePath, { force: true });
    } catch {
      // Ignore filesystem cleanup errors — DB deletion is authoritative.
    }

    return {
      deleted: true,
      memoryId: row.id,
      storagePath: relativeStoragePath,
    };
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        scope TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        retention_tier TEXT NOT NULL,
        storage_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        is_personal INTEGER NOT NULL DEFAULT 0,
        last_indexed_at TEXT,
        embedding_model_key TEXT,
        content_hash TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        UNIQUE(memory_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_chunks_memory_id ON memory_chunks(memory_id);

      CREATE TABLE IF NOT EXISTS memory_chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        embedding_model_key TEXT NOT NULL,
        vector_json TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES memory_chunks(id) ON DELETE CASCADE,
        FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_chunk_embeddings_memory_id
        ON memory_chunk_embeddings(memory_id);
    `);

    const hasPersonalColumn = this.db
      .prepare<[], { count: number }>(`
        SELECT COUNT(*) AS count
        FROM pragma_table_info('memories')
        WHERE name = 'is_personal'
      `)
      .get()?.count ?? 0;

    if (hasPersonalColumn === 0) {
      this.db.exec("ALTER TABLE memories ADD COLUMN is_personal INTEGER NOT NULL DEFAULT 0");
    }
  }

  private resolveSettings(entry: MemoryEntry): ResolvedMemoryConfig {
    return {
      enabled: entry.enabled ?? true,
      storageMode: entry.storageMode ?? "markdown-sqlite",
      storageDir: entry.storageDir ?? "memories",
      indexDbPath: entry.indexDbPath ?? "data/memories.sqlite",
      defaultScope: entry.defaultScope ?? "general",
      embeddingModelKey: entry.embeddingModelKey ?? "default",
      indexingStrategy: entry.indexingStrategy ?? "deferred",
      chunkSize: entry.chunking?.chunkSize ?? 800,
      chunkOverlap: entry.chunking?.chunkOverlap ?? 120,
      retrievalTopK: entry.retrieval?.topK ?? 5,
      maxChunksPerMemory: entry.retrieval?.maxChunksPerMemory ?? 2,
      includeChunks: entry.retrieval?.includeChunks ?? true,
      hotDays: entry.tiers?.hotDays ?? 30,
      warmDays: entry.tiers?.warmDays ?? 180,
    };
  }

  private resolveProjectPath(targetPath: string): string {
    if (path.isAbsolute(targetPath)) return targetPath;
    return path.resolve(this.configDir, "..", targetPath);
  }

  private resolveStoragePath(storagePath: string): string {
    if (path.isAbsolute(storagePath)) return storagePath;
    return path.resolve(this.storageDir, storagePath);
  }

  private toStoredStoragePath(storagePath: string): string {
    const resolvedPath = this.resolveStoragePath(storagePath);
    const relativePath = path.relative(this.storageDir, resolvedPath);

    if (!relativePath) {
      return path.basename(resolvedPath);
    }

    return relativePath;
  }

  private buildStoragePathCandidates(storagePath: string): string[] {
    const candidates = new Set<string>();

    if (storagePath.trim()) {
      candidates.add(storagePath);
    }

    if (path.isAbsolute(storagePath)) {
      candidates.add(path.normalize(storagePath));
      candidates.add(this.toStoredStoragePath(storagePath));
      return Array.from(candidates);
    }

    candidates.add(path.resolve(storagePath));
    candidates.add(path.resolve(this.storageDir, storagePath));
    candidates.add(this.toStoredStoragePath(storagePath));

    return Array.from(candidates);
  }

  private migrateStoragePathsToRelative(): void {
    const rows = this.db
      .prepare<[], { id: string; storage_path: string }>(
        "SELECT id, storage_path FROM memories",
      )
      .all();

    const update = this.db.prepare(
      "UPDATE memories SET storage_path = ? WHERE id = ?",
    );

    for (const row of rows) {
      const relativePath = this.toStoredStoragePath(row.storage_path);
      if (relativePath !== row.storage_path) {
        update.run(relativePath, row.id);
      }
    }
  }

  private resolveMemoryDocument(reference: MemoryReference): MemoryDocument {
    const row = this.resolveMemoryRow(reference);
    const resolvedStoragePath = this.resolveStoragePath(row.storage_path);
    const relativeStoragePath = this.toStoredStoragePath(row.storage_path);
    const raw = fs.readFileSync(resolvedStoragePath, "utf8");
    const parsed = parseMemoryDocument(raw, resolvedStoragePath);

    const document: MemoryDocument = {
      ...parsed,
      storagePath: relativeStoragePath,
      personal: row.is_personal === 1,
    };

    if (!document.personal) {
      return document;
    }

    const token = requirePersonalToken(
      reference.personalToken,
      "This memory is marked personal. Provide 'personalToken' to retrieve content.",
    );

    if (isEncryptedPersonalContent(document.content)) {
      document.content = decryptPersonalContent(document.content, token, document.id);
    }

    return document;
  }

  private resolveMemoryRow(reference: MemoryReference): MemoryRow {
    if (!hasReference(reference)) {
      throw new Error("memory reference requires one of memoryId, slug, or storagePath");
    }

    const storagePathCandidates = reference.storagePath
      ? this.buildStoragePathCandidates(reference.storagePath)
      : [];

    const storagePathSql = storagePathCandidates.length
      ? `OR storage_path IN (${storagePathCandidates.map(() => "?").join(", ")})`
      : "";

    const row = this.db
      .prepare(
        `
          SELECT *
          FROM memories
          WHERE (? IS NOT NULL AND id = ?)
             OR (? IS NOT NULL AND slug = ?)
             ${storagePathSql}
          LIMIT 1
        `,
      )
      .get(
        reference.memoryId ?? null,
        reference.memoryId ?? null,
        reference.slug ?? null,
        reference.slug ?? null,
        ...storagePathCandidates,
      ) as MemoryRow | undefined;

    if (!row) {
      throw new Error("Memory not found for the provided reference");
    }

    return row;
  }

  private writeMemoryDocument(document: MemoryDocument, personalToken?: string): void {
    const resolvedStoragePath = this.resolveStoragePath(document.storagePath);
    fs.mkdirSync(path.dirname(resolvedStoragePath), { recursive: true });

    const diskDocument: MemoryDocument = {
      ...document,
      content: document.personal
        ? encryptPersonalContent(
          document.content,
          requirePersonalToken(
            personalToken,
            "'personalToken' is required when creating or updating a personal memory",
          ),
          document.id,
        )
        : document.content,
    };

    fs.writeFileSync(resolvedStoragePath, serializeMemoryDocument(diskDocument), "utf8");
  }

  private upsertMemoryRow(document: MemoryDocument): void {
    const contentHash = hashContent(document.content);

    this.db
      .prepare(
        `
          INSERT INTO memories (
            id,
            slug,
            title,
            scope,
            tags_json,
            status,
            retention_tier,
            storage_path,
            created_at,
            updated_at,
            revision,
            is_personal,
            embedding_model_key,
            content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            slug = excluded.slug,
            title = excluded.title,
            scope = excluded.scope,
            tags_json = excluded.tags_json,
            status = excluded.status,
            retention_tier = excluded.retention_tier,
            storage_path = excluded.storage_path,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            revision = excluded.revision,
            is_personal = excluded.is_personal,
            embedding_model_key = excluded.embedding_model_key,
            content_hash = excluded.content_hash
        `,
      )
      .run(
        document.id,
        document.slug,
        document.title,
        document.scope,
        JSON.stringify(document.tags),
        document.status,
        document.retentionTier,
        this.toStoredStoragePath(document.storagePath),
        document.createdAt,
        document.updatedAt,
        document.revision,
        document.personal ? 1 : 0,
        this.settings.embeddingModelKey,
        contentHash,
      );
  }

  private async reindexDocument(document: MemoryDocument): Promise<number> {
    const now = new Date().toISOString();
    const chunks = chunkText(document.content, this.settings.chunkSize, this.settings.chunkOverlap);
    const vectors = await this.embedChunks(chunks);
    const embeddingStatus = this.shouldGenerateEmbeddings()
      ? "indexed"
      : this.settings.embeddingModelKey
        ? "pending"
        : "disabled";

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_chunk_embeddings WHERE memory_id = ?").run(document.id);
      this.db.prepare("DELETE FROM memory_chunks WHERE memory_id = ?").run(document.id);

      const insertChunk = this.db.prepare(
        `
          INSERT INTO memory_chunks (
            id,
            memory_id,
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
          INSERT INTO memory_chunk_embeddings (
            chunk_id,
            memory_id,
            embedding_model_key,
            vector_json,
            status,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
      );

      for (const [index, chunk] of chunks.entries()) {
        const vector = vectors[index];
        insertChunk.run(
          chunk.id,
          document.id,
          chunk.chunkIndex,
          chunk.startOffset,
          chunk.endOffset,
          chunk.content,
          now,
          now,
        );
        insertEmbedding.run(
          chunk.id,
          document.id,
          this.settings.embeddingModelKey,
          vector ? JSON.stringify(vector) : null,
          embeddingStatus,
          now,
        );
      }

      this.db
        .prepare(
          `
            UPDATE memories
            SET last_indexed_at = ?, embedding_model_key = ?
            WHERE id = ?
          `,
        )
        .run(now, this.settings.embeddingModelKey, document.id);
    });

    tx();
    return chunks.length;
  }

  private shouldGenerateEmbeddings(): boolean {
    return this.settings.indexingStrategy === "immediate" && Boolean(this.settings.embeddingModelKey);
  }

  private async embedChunks(chunks: ChunkRecord[]): Promise<Array<number[] | null>> {
    if (!chunks.length) return [];
    if (!this.shouldGenerateEmbeddings()) {
      return chunks.map(() => null);
    }

    const embeddings = this.embeddingRegistry.get(this.settings.embeddingModelKey);
    const vectors = await embeddings.embedDocuments(chunks.map((chunk) => chunk.content));
    return vectors.map((vector: number[]) => [...vector]);
  }

  private async getQueryEmbedding(
    query: string,
    rows: ChunkRow[],
  ): Promise<number[] | null> {
    if (!this.shouldGenerateEmbeddings()) return null;

    const hasIndexedVectors = rows.some(
      (row) => row.embedding_status === "indexed" && row.vector_json,
    );
    if (!hasIndexedVectors) return null;

    const embeddings = this.embeddingRegistry.get(this.settings.embeddingModelKey);
    const vector = await embeddings.embedQuery(query);
    return [...vector];
  }

  private rowToSummary(row: MemoryRow): MemorySummary {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      scope: row.scope,
      tags: parseTags(row.tags_json),
      status: row.status,
      retentionTier: row.retention_tier,
      storagePath: this.toStoredStoragePath(row.storage_path),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      personal: row.is_personal === 1,
      lastIndexedAt: row.last_indexed_at ?? undefined,
    };
  }

  private chunkRowToSummary(row: ChunkRow): MemorySummary {
    return {
      id: row.memory_id,
      slug: path.basename(row.storage_path, ".md"),
      title: row.title,
      scope: row.scope,
      tags: parseTags(row.tags_json),
      status: row.status,
      retentionTier: row.retention_tier,
      storagePath: this.toStoredStoragePath(row.storage_path),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      personal: row.is_personal === 1,
      lastIndexedAt: row.last_indexed_at ?? undefined,
    };
  }
}

function parseMemoryDocument(raw: string, storagePath: string): MemoryDocument {
  const { metadata, content } = parseFrontmatter(raw);

  return {
    id: requireNonEmpty(metadata.id, `Memory file is missing 'id': ${storagePath}`),
    slug: requireNonEmpty(metadata.slug, `Memory file is missing 'slug': ${storagePath}`),
    title: requireNonEmpty(metadata.title, `Memory file is missing 'title': ${storagePath}`),
    scope: metadata.scope?.trim() || "general",
    tags: metadata.tags ? normalizeTags(metadata.tags.split(",")) : [],
    status: metadata.status?.trim() || "active",
    retentionTier: parseRetentionTier(metadata.retentionTier),
    storagePath,
    createdAt: requireNonEmpty(
      metadata.createdAt,
      `Memory file is missing 'createdAt': ${storagePath}`,
    ),
    updatedAt: requireNonEmpty(
      metadata.updatedAt,
      `Memory file is missing 'updatedAt': ${storagePath}`,
    ),
    revision: parseInteger(metadata.revision, 1),
    personal: parseBoolean(metadata.personal, false),
    content,
  };
}

function serializeMemoryDocument(document: MemoryDocument): string {
  const frontmatter = [
    FRONTMATTER_MARKER,
    `id: ${escapeValue(document.id)}`,
    `slug: ${escapeValue(document.slug)}`,
    `title: ${escapeValue(document.title)}`,
    `scope: ${escapeValue(document.scope)}`,
    `tags: ${escapeValue(document.tags.join(", "))}`,
    `status: ${escapeValue(document.status)}`,
    `retentionTier: ${document.retentionTier}`,
    `createdAt: ${document.createdAt}`,
    `updatedAt: ${document.updatedAt}`,
    `revision: ${document.revision}`,
    `personal: ${document.personal ? "true" : "false"}`,
    FRONTMATTER_MARKER,
    "",
  ];

  return `${frontmatter.join("\n")}${document.content.trim()}\n`;
}

function parseFrontmatter(raw: string): { metadata: Record<string, string>; content: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_MARKER}\n`)) {
    return { metadata: {}, content: normalized.trim() };
  }

  const endMarker = `\n${FRONTMATTER_MARKER}\n`;
  const endIndex = normalized.indexOf(endMarker, FRONTMATTER_MARKER.length + 1);
  if (endIndex === -1) {
    return { metadata: {}, content: normalized.trim() };
  }

  const metadataBlock = normalized.slice(FRONTMATTER_MARKER.length + 1, endIndex);
  const content = normalized.slice(endIndex + endMarker.length).trim();
  const metadata: Record<string, string> = {};

  for (const line of metadataBlock.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    metadata[key] = value;
  }

  return { metadata, content };
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
      const paragraphBreak = normalized.lastIndexOf("\n\n", end);
      const lineBreak = normalized.lastIndexOf("\n", end);
      const whitespace = normalized.lastIndexOf(" ", end);
      const preferredBreak = [paragraphBreak, lineBreak, whitespace].find(
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

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function scoreChunk(query: string, queryTerms: string[], row: ChunkRow): number {
  const haystack = `${row.title}\n${row.content}\n${row.tags_json}`.toLowerCase();
  let score = haystack.includes(query.toLowerCase()) ? 5 : 0;

  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 2;
  }

  if (score <= 0) return 0;

  if (row.scope.toLowerCase() === "general") score += 0.25;
  if (row.retention_tier === "hot") score += 0.5;
  return score;
}

function scoreVectorMatch(queryVector: number[] | null, row: ChunkRow): number {
  if (!queryVector || row.embedding_status !== "indexed" || !row.vector_json) return 0;

  const storedVector = parseVector(row.vector_json);
  if (!storedVector || storedVector.length !== queryVector.length) return 0;

  const similarity = cosineSimilarity(queryVector, storedVector);
  if (!Number.isFinite(similarity) || similarity <= 0) return 0;
  return similarity * 20;
}

function excerptForQuery(content: string, queryTerms: string[]): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const lower = normalized.toLowerCase();
  const matchIndex = queryTerms
    .map((term) => lower.indexOf(term))
    .find((index) => index >= 0) ?? 0;

  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(normalized.length, matchIndex + 200);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    return Array.isArray(parsed) ? normalizeTags(parsed.map(String)) : [];
  } catch {
    return [];
  }
}

function normalizeTags(tags?: string[]): string[] {
  if (!tags?.length) return [];
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

function requireNonEmpty(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function parseRetentionTier(value: string | undefined): MemoryRetentionTier {
  if (value === "warm" || value === "cold") return value;
  return "hot";
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function hasPersonalToken(token: string | undefined): boolean {
  return Boolean(token?.trim());
}

function requirePersonalToken(token: string | undefined, message: string): string {
  const normalized = token?.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function isEncryptedPersonalContent(content: string): boolean {
  return content.startsWith(PERSONAL_PAYLOAD_PREFIX);
}

function encryptPersonalContent(content: string, personalToken: string, memoryId: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = derivePersonalKey(personalToken, memoryId, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = {
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };

  return `${PERSONAL_PAYLOAD_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decryptPersonalContent(payload: string, personalToken: string, memoryId: string): string {
  const encoded = payload.slice(PERSONAL_PAYLOAD_PREFIX.length);
  let parsed: {
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };

  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      salt: string;
      iv: string;
      tag: string;
      ciphertext: string;
    };
  } catch {
    throw new Error("Invalid encrypted personal memory payload");
  }

  try {
    const salt = Buffer.from(parsed.salt, "base64url");
    const iv = Buffer.from(parsed.iv, "base64url");
    const tag = Buffer.from(parsed.tag, "base64url");
    const ciphertext = Buffer.from(parsed.ciphertext, "base64url");
    const key = derivePersonalKey(personalToken, memoryId, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new Error("Unable to decrypt personal memory content. Verify the personal token.");
  }
}

function derivePersonalKey(personalToken: string, memoryId: string, salt: Buffer): Buffer {
  return scryptSync(`${personalToken}:${memoryId}`, salt, 32);
}

function escapeValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "memory";
}

function uniqueSlug(baseSlug: string, id: string): string {
  return `${baseSlug}--${id.slice(0, 8)}`;
}

function hasReference(reference: MemoryReference): boolean {
  return Boolean(reference.memoryId || reference.slug || reference.storagePath);
}
