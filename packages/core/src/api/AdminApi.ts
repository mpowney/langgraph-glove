import http from "node:http";
import express, { type Express } from "express";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";
import type { Request } from "express";
import type { ToolServerEntry } from "@langgraph-glove/config";
import type { AuthService, AuthenticatedUser } from "../auth/AuthService";
import type { ToolDefinition, AgentCapabilityEntry, AgentCapabilityRegistry } from "../rpc/RpcProtocol";

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
  /** Optional auth service used to protect admin endpoints and expose auth APIs. */
  authService?: AuthService;
  /** Tool server config map used for HTTP proxying under `/api/tools/_<name>`. */
  toolsConfig?: Record<string, ToolServerEntry>;
  /** Discovered tool definitions served by `GET /api/tools/registry`. */
  toolRegistry?: ToolDefinition[];
  /** Agent capability entries served by `GET /api/agents/capabilities`. */
  agentCapabilities?: AgentCapabilityEntry[];
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
  private readonly authService?: AuthService;
  private readonly toolsConfig: Record<string, ToolServerEntry>;
  private readonly toolRegistry: ToolDefinition[];
  private readonly agentCapabilities: AgentCapabilityEntry[];
  private readonly app: Express;
  private httpServer?: http.Server;

  constructor(config: AdminApiConfig = {}) {
    this.port = config.port ?? 8081;
    this.host = config.host ?? "0.0.0.0";
    this.dbPath = config.dbPath;

    const origins = config.allowedOrigins;
    this.allowedOrigins = Array.isArray(origins) ? origins.join(", ") : (origins ?? "*");
    this.authService = config.authService;
    this.toolsConfig = config.toolsConfig ?? {};
    this.toolRegistry = config.toolRegistry ?? [];
    this.agentCapabilities = config.agentCapabilities ?? [];

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
    this.app.use(express.json({ limit: "64kb" }));

    const requireAuth = (req: express.Request, res: express.Response): boolean => {
      if (!this.authService) return true;
      const token = readBearerToken(req);
      if (!token) {
        res.status(401).json({ error: "Missing bearer token" });
        return false;
      }

      const user = this.authService.authenticateSession(token);
      if (!user) {
        res.status(401).json({ error: "Invalid or expired session" });
        return false;
      }

      return true;
    };

    // CORS — allow the SPA (on a different origin/port) to call this API
    this.app.use((_req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", this.allowedOrigins);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (_req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });

    if (this.authService) {
      this.app.get("/api/auth/status", (_req, res) => {
        res.json(this.authService?.getStatus() ?? { setupRequired: false, minPasswordLength: 12 });
      });

      this.app.post("/api/auth/setup", (req, res) => {
        const setupToken = readBodyString(req.body, "setupToken");
        const password = readBodyString(req.body, "password");
        if (!setupToken) {
          res.status(400).json({ error: "setupToken is required" });
          return;
        }

        try {
          const setup = this.authService?.completeSetup({
            setupToken,
            ...(password ? { password } : {}),
          });
          const session = password
            ? this.authService?.login(password)
            : (setup ? this.authService?.createSessionForUser(setup.userId) : undefined);
          res.json({
            token: session?.token,
            expiresAt: session?.expiresAt,
          });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      this.app.post("/api/auth/login", (req, res) => {
        const password = readBodyString(req.body, "password");
        if (!password) {
          res.status(400).json({ error: "password is required" });
          return;
        }

        try {
          const session = this.authService?.login(password);
          res.json(session);
        } catch (err) {
          res.status(401).json({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      this.app.post("/api/auth/logout", (req, res) => {
        const token = readBearerToken(req);
        if (!token) {
          res.status(401).json({ error: "Missing bearer token" });
          return;
        }

        this.authService?.revokeSession(token);
        res.status(204).send();
      });

      // -----------------------------------------------------------------------
      // Passkey (WebAuthn) endpoints
      // -----------------------------------------------------------------------

      // Begin passkey registration — requires an active session
      this.app.post("/api/auth/passkey/register/begin", (req, res) => {
        const user = requireAuthUser(req, res, this.authService!);
        if (!user) return;

        const origin = req.headers.origin ?? `http://${req.headers.host ?? "localhost"}`;
        const rpId = getRpId(origin);
        const rpName = "LangGraph Glove";

        void (async () => {
          try {
            const options = await this.authService!.beginPasskeyRegistration(user.userId, rpId, rpName);
            res.json(options);
          } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });

      // Complete passkey registration — requires an active session
      this.app.post("/api/auth/passkey/register/complete", (req, res) => {
        const user = requireAuthUser(req, res, this.authService!);
        if (!user) return;

        const origin = req.headers.origin ?? `http://${req.headers.host ?? "localhost"}`;
        const rpId = getRpId(origin);

        void (async () => {
          try {
            const result = await this.authService!.completePasskeyRegistration(
              user.userId,
              req.body,
              rpId,
              origin,
            );
            res.json(result);
          } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });

      // Begin passkey authentication — public
      this.app.post("/api/auth/passkey/authenticate/begin", (req, res) => {
        const origin = req.headers.origin ?? `http://${req.headers.host ?? "localhost"}`;
        const rpId = getRpId(origin);

        void (async () => {
          try {
            const options = await this.authService!.beginPasskeyAuthentication(rpId);
            res.json(options);
          } catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });

      // Complete passkey authentication — public, returns session token
      this.app.post("/api/auth/passkey/authenticate/complete", (req, res) => {
        const origin = req.headers.origin ?? `http://${req.headers.host ?? "localhost"}`;
        const rpId = getRpId(origin);

        void (async () => {
          try {
            const session = await this.authService!.completePasskeyAuthentication(
              req.body,
              rpId,
              origin,
            );
            res.json(session);
          } catch (err) {
            res.status(401).json({ error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });
    }

    const proxyToolRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      if (!requireAuth(req, res)) return;

      const rawToolParam = req.params["toolPath"];
      const toolRef = typeof rawToolParam === "string" ? rawToolParam.trim() : "";
      if (!toolRef.startsWith("_") || toolRef.length < 2) {
        res.status(400).json({ error: "Tool path must be in the form /api/tools/_<tool_name>" });
        return;
      }

      const toolName = toolRef.slice(1);
      const entry = this.toolsConfig[toolName];
      if (!entry || entry.enabled === false) {
        res.status(404).json({ error: `Tool "${toolName}" is not configured` });
        return;
      }
      if (entry.transport !== "http" || !entry.url) {
        res.status(400).json({
          error: `Tool "${toolName}" is not configured for HTTP RPC`,
        });
        return;
      }

      const rest = typeof req.params["0"] === "string" && req.params["0"].length > 0
        ? `/${req.params["0"]}`
        : "";
      const queryIndex = req.originalUrl.indexOf("?");
      const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";

      const baseUrl = entry.url.endsWith("/") ? entry.url.slice(0, -1) : entry.url;
      const targetUrl = `${baseUrl}${rest}${query}`;

      try {
        const headers: Record<string, string> = {};
        const contentType = req.header("content-type");
        if (contentType) {
          headers["content-type"] = contentType;
        }

        const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined;
        const upstream = await fetch(targetUrl, {
          method: req.method,
          headers,
          ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
        });

        const responseContentType = upstream.headers.get("content-type");
        if (responseContentType) {
          res.setHeader("content-type", responseContentType);
        }

        res.status(upstream.status).send(await upstream.text());
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : "Tool upstream unreachable" });
      }
    };

    // -----------------------------------------------------------------------
    // Tool registry — full parameter schemas for all discovered tools
    // -----------------------------------------------------------------------
    this.app.get("/api/tools/registry", (req, res) => {
      if (!requireAuth(req, res)) return;
      res.json(this.toolRegistry);
    });

    // -----------------------------------------------------------------------
    // Agent capability registry — agent/sub-agent to tool mapping
    // -----------------------------------------------------------------------
    this.app.get("/api/agents/capabilities", (req, res) => {
      if (!requireAuth(req, res)) return;
      const toolsByName: Record<string, ToolDefinition> = {};
      for (const t of this.toolRegistry) {
        toolsByName[t.name] = t;
      }
      const payload: AgentCapabilityRegistry = {
        agents: this.agentCapabilities,
        tools: toolsByName,
      };
      res.json(payload);
    });

    this.app.all("/api/tools/:toolPath", (req, res) => {
      void proxyToolRequest(req, res);
    });

    this.app.all("/api/tools/:toolPath/*", (req, res) => {
      void proxyToolRequest(req, res);
    });

    if (this.dbPath) {
      const dbPath = this.dbPath;

      // List all conversation threads
      this.app.get("/api/conversations", (req, res) => {
        if (!requireAuth(req, res)) return;
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
        if (!requireAuth(req, res)) return;
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

function readBodyString(body: unknown, key: string): string {
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") return "";
  return value.trim();
}

function readBearerToken(req: Request): string {
  const header = req.header("authorization");
  if (!header) return "";
  if (!header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}

/**
 * Like `requireAuth` but returns the authenticated user object, or writes a
 * 401 response and returns `null` when auth fails.
 */
function requireAuthUser(
  req: express.Request,
  res: express.Response,
  authService: AuthService,
): AuthenticatedUser | null {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return null;
  }
  const user = authService.authenticateSession(token);
  if (!user) {
    res.status(401).json({ error: "Invalid or expired session" });
    return null;
  }
  return user;
}

/** Extract the RP ID (hostname only) from a full origin URL. */
function getRpId(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return "localhost";
  }
}
