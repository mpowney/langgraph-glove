import http from "node:http";
import express, { type Express } from "express";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LcMessage {
  lc: number;
  type: string;
  id: string[];
  kwargs: {
    content: unknown;
    additional_kwargs?: Record<string, unknown>;
    response_metadata?: Record<string, unknown>;
    id?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  };
}

interface CheckpointRow {
  thread_id: string;
  checkpoint_id: string;
  checkpoint: string;
}

interface ConversationRow {
  thread_id: string;
  checkpoint_count: number;
  latest_checkpoint_id: string;
}

/** A single decoded message in a conversation. */
export interface BrowserMessage {
  id: string;
  role: "human" | "ai" | "tool" | "system";
  content: string;
  tool_calls?: Array<{ name: string; id: string; args: unknown }>;
  tool_call_id?: string;
}

/** Summary row returned by `GET /api/conversations`. */
export interface ConversationSummary {
  threadId: string;
  messageCount: number;
  latestCheckpointId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lcIdToRole(id: string[]): BrowserMessage["role"] {
  const cls = id.at(-1) ?? "";
  if (cls.startsWith("Human")) return "human";
  if (cls.startsWith("AI") || cls.startsWith("Ai")) return "ai";
  if (cls.startsWith("Tool")) return "tool";
  return "system";
}

function extractMessages(checkpointJson: string): BrowserMessage[] {
  try {
    const cp = JSON.parse(checkpointJson) as { channel_values?: { messages?: LcMessage[] } };
    const raw = cp.channel_values?.messages ?? [];
    return raw.map((m) => {
      const role = lcIdToRole(m.id);
      const content =
        typeof m.kwargs.content === "string"
          ? m.kwargs.content
          : JSON.stringify(m.kwargs.content);
      const tool_calls = m.kwargs.tool_calls?.length
        ? (m.kwargs.tool_calls as Array<{ name: string; id: string; args: unknown }>)
        : undefined;
      return {
        id: m.kwargs.id ?? uuidv4(),
        role,
        content,
        ...(tool_calls ? { tool_calls } : {}),
        ...(m.kwargs.tool_call_id ? { tool_call_id: m.kwargs.tool_call_id } : {}),
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// AdminApi
// ---------------------------------------------------------------------------

export interface AdminApiConfig {
  /** Port for the admin API HTTP server. Default: `8081`. */
  port?: number;
  /** Hostname to bind. Default: `"0.0.0.0"`. */
  host?: string;
  /**
   * Path to the SQLite checkpoint database. When provided the server exposes:
   *  - `GET /api/conversations`           → ConversationSummary[]
   *  - `GET /api/conversations/:threadId` → BrowserMessage[]
   */
  dbPath?: string;
  /**
   * Origins allowed to call this API (CORS).
   * Defaults to `*` so the SPA served on a different port can reach it.
   */
  allowedOrigins?: string | string[];
}

/**
 * Standalone HTTP server that exposes admin / system REST APIs.
 *
 * - `GET /api/conversations`           — list all conversation threads
 * - `GET /api/conversations/:threadId` — messages in a specific thread
 *
 * The server runs on a separate port from the WebChannel so that
 * administration and system tasks are cleanly separated from the chat UI.
 */
export class AdminApi {
  private readonly port: number;
  private readonly host: string;
  private readonly dbPath?: string;
  private readonly allowedOrigins: string;
  private readonly app: Express;
  private httpServer?: http.Server;

  constructor(config: AdminApiConfig = {}) {
    this.port = config.port ?? 8081;
    this.host = config.host ?? "0.0.0.0";
    this.dbPath = config.dbPath;

    const origins = config.allowedOrigins;
    this.allowedOrigins = Array.isArray(origins) ? origins.join(", ") : (origins ?? "*");

    this.app = express();
    this.registerRoutes();
  }

  /** The port this server will listen on. */
  get listenPort(): number {
    return this.port;
  }

  /** The host this server will bind to. */
  get listenHost(): string {
    return this.host;
  }

  private registerRoutes(): void {
    // CORS — allow the SPA (on a different origin/port) to call this API
    this.app.use((_req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", this.allowedOrigins);
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (_req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });

    if (this.dbPath) {
      const dbPath = this.dbPath;

      // List all conversation threads
      this.app.get("/api/conversations", (_req, res) => {
        try {
          const db = new Database(dbPath, { readonly: true, fileMustExist: true });
          const rows = db.prepare<[], ConversationRow>(`
            SELECT
              thread_id,
              COUNT(*) AS checkpoint_count,
              MAX(checkpoint_id) AS latest_checkpoint_id
            FROM checkpoints
            WHERE checkpoint_ns = ''
            GROUP BY thread_id
            ORDER BY MAX(checkpoint_id) DESC
          `).all();
          db.close();

          const summaries: ConversationSummary[] = rows.map((r) => ({
            threadId: r.thread_id,
            messageCount: r.checkpoint_count,
            latestCheckpointId: r.latest_checkpoint_id,
          }));
          res.json(summaries);
        } catch (err) {
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      // Get messages for a specific thread
      this.app.get("/api/conversations/:threadId", (req, res) => {
        const { threadId } = req.params;
        try {
          const db = new Database(dbPath, { readonly: true, fileMustExist: true });
          const row = db.prepare<[string], CheckpointRow>(`
            SELECT thread_id, checkpoint_id, checkpoint
            FROM checkpoints
            WHERE thread_id = ? AND checkpoint_ns = ''
            ORDER BY checkpoint_id DESC
            LIMIT 1
          `).get(threadId);
          db.close();

          if (!row) {
            res.status(404).json({ error: "Conversation not found" });
            return;
          }
          res.json(extractMessages(row.checkpoint as unknown as string));
        } catch (err) {
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
      });
    }
  }

  /** Start the HTTP server. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer(this.app);
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, this.host, () => resolve());
    });
  }

  /** Stop the HTTP server. */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
