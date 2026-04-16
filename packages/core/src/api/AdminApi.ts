import http from "node:http";
import express, { type Express } from "express";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";
import type { Request } from "express";
import { ConversationMetadataService } from "./ConversationMetadataService.js";
import { registerSecretsRoutes } from "./SecretsRoutes.js";
import type {
  ToolServerEntry,
  GloveConfig,
  AgentEntry,
  GraphEntry,
  SubgraphProfile,
} from "@langgraph-glove/config";
import type { AuthService, AuthenticatedUser } from "../auth/AuthService";
import { UnixSocketRpcClient } from "../rpc/UnixSocketRpcClient";
import type {
  ToolDefinition,
  AgentCapabilityEntry,
  AgentCapabilityRegistry,
  RpcRequest,
  RpcResponse,
} from "../rpc/RpcProtocol";

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

interface PrivilegedAccessStatusQuery {
  conversationId?: string;
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
  title: string | null;
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
  title?: string;
}

export type TopologyNodeType = "graph" | "agent" | "subgraph" | "model" | "tool";

export interface TopologyNode {
  id: string;
  type: TopologyNodeType;
  key: string;
  label: string;
  meta?: Record<string, unknown>;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  relation:
    | "graph-orchestrator"
    | "graph-sub-agent"
    | "graph-memory-subgraph"
    | "graph-compression-subgraph"
    | "subgraph-agent"
    | "agent-model"
    | "agent-tool";
  meta?: Record<string, unknown>;
}

export interface TopologyPayload {
  generatedAt: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  counts: {
    graphs: number;
    agents: number;
    subgraphs: number;
    models: number;
    tools: number;
  };
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
  /** Loaded runtime config used to build topology payloads. */
  config?: GloveConfig;
  /**
   * Optional callback that lets internal tool servers (e.g. tool-schedule)
   * trigger an agent invocation via `POST /api/internal/invoke`.
   *
   * When not provided the endpoint returns 503.
   */
  invokeAgent?: (params: {
    agentKey: string;
    conversationId: string;
    prompt: string;
    /** Optional graph key from graphs.json (defaults to "default"). */
    graphKey?: string;
    /** Optional personal token so user-requested tasks can access encrypted memories. */
    personalToken?: string;
    /** Optional scheduled-run observability options for receiveAgentProcessing channels. */
    observability?: {
      enabled?: boolean;
      conversationId?: string;
      sourceChannel?: string;
      taskId?: string;
      scheduleType?: "cron" | "once";
      trigger?: "cron" | "once-minute-sweep" | "manual-now";
    };
  }) => Promise<string>;
  /** Optional callback for localhost trusted services to emit receiveSystem messages. */
  sendSystemMessage?: (params: {
    conversationId: string;
    text: string;
    role?: "system-event";
  }) => Promise<void>;
  /** Optional callback for trusted services to send agent-style messages to channels. */
  sendChannelMessage?: (params: {
    conversationId: string;
    text: string;
    role?: "agent" | "error";
    channelName?: string;
  }) => Promise<void>;
  /**
   * Path to the secrets directory.
   *
   * When provided together with `authService`, the server exposes privileged
   * secrets management endpoints:
   *
   *   GET  /api/secrets/files    — list secret JSON files
   *   GET  /api/secrets          — list all secret names (not values)
   *   GET  /api/secrets/:name    — retrieve a specific secret value
   *   POST /api/secrets          — add or update a secret
   *
   * All endpoints require an authenticated session **and** an active privilege
   * grant so that secrets remain inaccessible to agents.
   *
   * Defaults to the `GLOVE_SECRETS_DIR` environment variable when not supplied.
   */
  secretsDir?: string;
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
  private readonly config?: GloveConfig;
  private readonly invokeAgent?: AdminApiConfig["invokeAgent"];
  private readonly sendSystemMessage?: AdminApiConfig["sendSystemMessage"];
  private readonly sendChannelMessage?: AdminApiConfig["sendChannelMessage"];
  private readonly secretsDir?: string;
  private readonly app: Express;
  private httpServer?: http.Server;
  private readonly unixSocketRpcClients = new Map<string, UnixSocketRpcClient>();

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
    this.config = config.config;
    this.invokeAgent = config.invokeAgent;
    this.sendSystemMessage = config.sendSystemMessage;
    this.sendChannelMessage = config.sendChannelMessage;
    this.secretsDir = config.secretsDir;

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
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Privilege-Grant-Id, X-Conversation-Id");
      if (_req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });

    if (this.authService) {
      this.app.get("/api/auth/status", (_req, res) => {
        res.json(this.authService?.getStatus() ?? {
          setupRequired: false,
          minPasswordLength: 12,
          passkeyRegistered: false,
          privilegeTokenRegistered: false,
        });
      });

      this.app.post("/api/auth/privilege-token/register", (req, res) => {
        const user = requireAuthUser(req, res, this.authService!);
        if (!user) return;

        const token = readBodyString(req.body, "token");
        const currentToken = readBodyString(req.body, "currentToken");
        if (!token) {
          res.status(400).json({ error: "token is required" });
          return;
        }

        const hasPrivilegeToken = this.authService!.getStatus().privilegeTokenRegistered;
        if (hasPrivilegeToken) {
          if (!currentToken) {
            res.status(400).json({ error: "currentToken is required when replacing privilege token" });
            return;
          }
          if (!this.authService!.validatePrivilegeToken(currentToken)) {
            res.status(401).json({ error: "Current privilege token is invalid" });
            return;
          }
        }

        try {
          this.authService!.registerPrivilegeToken(user.userId, token);
          res.status(204).send();
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      this.app.post("/api/auth/privileged-access/activate", (req, res) => {
        const user = requireAuthUser(req, res, this.authService!);
        if (!user) return;

        const conversationId = readBodyString(req.body, "conversationId");
        const token = readBodyString(req.body, "token");
        const usePasskey = readBodyBoolean(req.body, "usePasskey");
        const passkeySessionToken = readBodyString(req.body, "passkeySessionToken");
        if (!conversationId) {
          res.status(400).json({ error: "conversationId is required" });
          return;
        }

        const hasRegisteredPrivilegeToken = this.authService!.getStatus().privilegeTokenRegistered;
        if (token && !hasRegisteredPrivilegeToken) {
          res.status(400).json({ error: "Privilege token is not registered yet" });
          return;
        }
        if (token && !this.authService!.validatePrivilegeToken(token)) {
          res.status(401).json({ error: "Invalid privilege token" });
          return;
        }

        const canActivateWithToken = Boolean(token);
        const passkeySessionUser = passkeySessionToken
          ? this.authService!.authenticateSession(passkeySessionToken)
          : null;
        const canActivateWithPasskey = Boolean(
          usePasskey
          && passkeySessionUser
          && passkeySessionUser.userId === user.userId
          && this.authService!.userHasPasskey(user.userId),
        );
        if (!canActivateWithToken && !canActivateWithPasskey) {
          res.status(400).json({ error: "Provide a privilege token or use passkey activation" });
          return;
        }

        try {
          const grant = this.authService!.createPrivilegeGrant(user.userId, conversationId, 10);
          res.json({
            active: true,
            conversationId: grant.conversationId,
            grantId: grant.grantId,
            expiresAt: grant.expiresAt,
          });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        }
      });

      this.app.get("/api/auth/privileged-access/status", (req, res) => {
        if (!requireAuthUser(req, res, this.authService!)) return;

        const conversationId = String((req.query as PrivilegedAccessStatusQuery).conversationId ?? "").trim();
        if (!conversationId) {
          res.status(400).json({ error: "conversationId is required" });
          return;
        }

        const status = this.authService!.getPrivilegeGrantStatus(conversationId);
        res.json(status);
      });

      this.app.post("/api/auth/privileged-access/revoke", (req, res) => {
        if (!requireAuthUser(req, res, this.authService!)) return;

        const conversationId = readBodyString(req.body, "conversationId");
        if (!conversationId) {
          res.status(400).json({ error: "conversationId is required" });
          return;
        }

        this.authService!.revokePrivilegeGrant(conversationId);
        res.status(204).send();
      });

      // Internal endpoint used by tool-admin to gate privileged tool execution.
      // This should only be called from local trusted processes.
      this.app.post("/api/internal/validate-privilege-grant", (req, res) => {
        const grantId = readBodyString(req.body, "grantId");
        const conversationId = readBodyString(req.body, "conversationId");
        if (!grantId || !conversationId) {
          res.status(400).json({ error: "grantId and conversationId are required" });
          return;
        }

        const valid = this.authService!.validatePrivilegeGrant(grantId, conversationId);
        if (!valid) {
          res.status(401).json({ error: "Invalid or expired privilege grant" });
          return;
        }

        res.json({ valid: true });
      });

      // Internal endpoint used by tool-schedule and other trusted tool servers to
      // invoke the agent programmatically.  Restricted to localhost callers.
      this.app.post("/api/internal/invoke", (req, res) => {
        void (async () => {
          // Restrict to loopback addresses only — this endpoint must not be
          // reachable from external networks.
          const remoteIp = req.socket.remoteAddress ?? "";
          if (remoteIp !== "127.0.0.1" && remoteIp !== "::1" && remoteIp !== "::ffff:127.0.0.1") {
            res.status(403).json({ error: "Forbidden: only localhost callers are allowed" });
            return;
          }
          if (!this.invokeAgent) {
            res.status(503).json({ error: "Agent invocation is not available" });
            return;
          }
          const agentKey = readBodyString(req.body, "agentKey");
          const conversationId = readBodyString(req.body, "conversationId");
          const prompt = readBodyString(req.body, "prompt");
          const graphKey = readBodyString(req.body, "graphKey") || undefined;
          const personalToken = readBodyString(req.body, "personalToken") || undefined;
          const observabilityRaw =
            typeof req.body === "object" && req.body !== null
              ? (req.body as Record<string, unknown>)["observability"]
              : undefined;
          const observability =
            typeof observabilityRaw === "object" && observabilityRaw !== null
              ? {
                  enabled:
                    typeof (observabilityRaw as Record<string, unknown>)["enabled"] === "boolean"
                      ? ((observabilityRaw as Record<string, unknown>)["enabled"] as boolean)
                      : undefined,
                  conversationId:
                    typeof (observabilityRaw as Record<string, unknown>)["conversationId"] === "string"
                      ? ((observabilityRaw as Record<string, unknown>)["conversationId"] as string)
                      : undefined,
                  sourceChannel:
                    typeof (observabilityRaw as Record<string, unknown>)["sourceChannel"] === "string"
                      ? ((observabilityRaw as Record<string, unknown>)["sourceChannel"] as string)
                      : undefined,
                  taskId:
                    typeof (observabilityRaw as Record<string, unknown>)["taskId"] === "string"
                      ? ((observabilityRaw as Record<string, unknown>)["taskId"] as string)
                      : undefined,
                  scheduleType:
                    (observabilityRaw as Record<string, unknown>)["scheduleType"] === "cron"
                    || (observabilityRaw as Record<string, unknown>)["scheduleType"] === "once"
                      ? ((observabilityRaw as Record<string, unknown>)["scheduleType"] as "cron" | "once")
                      : undefined,
                  trigger:
                    (observabilityRaw as Record<string, unknown>)["trigger"] === "cron"
                    || (observabilityRaw as Record<string, unknown>)["trigger"] === "once-minute-sweep"
                    || (observabilityRaw as Record<string, unknown>)["trigger"] === "manual-now"
                      ? ((observabilityRaw as Record<string, unknown>)["trigger"] as "cron" | "once-minute-sweep" | "manual-now")
                      : undefined,
                }
              : undefined;
          if (!conversationId || !prompt) {
            res.status(400).json({ error: "conversationId and prompt are required" });
            return;
          }

          if (this.sendSystemMessage) {
            try {
              await this.sendSystemMessage({
                conversationId,
                text: JSON.stringify(
                  {
                    event: "internal-invoke-request",
                    timestamp: new Date().toISOString(),
                    details: {
                      agentKey: agentKey || "default",
                      graphKey: graphKey || "default",
                      prompt,
                      ...(observability ? { observability } : {}),
                    },
                  },
                  null,
                  2,
                ),
                role: "system-event",
              });
            } catch {
              // Keep invoke flow resilient when the system-message sink is unavailable.
            }
          }

          try {
            const result = await this.invokeAgent({
              agentKey: agentKey || "default",
              conversationId,
              prompt,
              graphKey,
              personalToken,
              observability,
            });
            res.json({ result });
          } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });

      // Internal endpoint for trusted local services to emit receiveSystem runtime
      // observability messages (for example scheduler minute-sweep events).
      this.app.post("/api/internal/system-message", (req, res) => {
        void (async () => {
          const remoteIp = req.socket.remoteAddress ?? "";
          if (remoteIp !== "127.0.0.1" && remoteIp !== "::1" && remoteIp !== "::ffff:127.0.0.1") {
            res.status(403).json({ error: "Forbidden: only localhost callers are allowed" });
            return;
          }
          if (!this.sendSystemMessage) {
            res.status(503).json({ error: "System message sink is not available" });
            return;
          }

          const text = readBodyString(req.body, "text");
          const conversationId =
            readBodyString(req.body, "conversationId") || "system:schedule";
          if (!text) {
            res.status(400).json({ error: "text is required" });
            return;
          }

          try {
            await this.sendSystemMessage({
              conversationId,
              text,
              role: "system-event",
            });
            res.status(204).send();
          } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });

      // Internal endpoint for trusted local services to deliver responses into
      // a specific channel conversation context.
      this.app.post("/api/internal/channel-message", (req, res) => {
        void (async () => {
          const remoteIp = req.socket.remoteAddress ?? "";
          if (remoteIp !== "127.0.0.1" && remoteIp !== "::1" && remoteIp !== "::ffff:127.0.0.1") {
            res.status(403).json({ error: "Forbidden: only localhost callers are allowed" });
            return;
          }
          if (!this.sendChannelMessage) {
            res.status(503).json({ error: "Channel message sink is not available" });
            return;
          }

          const conversationId = readBodyString(req.body, "conversationId");
          const text = readBodyString(req.body, "text");
          const role = readBodyString(req.body, "role");
          const channelName = readBodyString(req.body, "channelName") || undefined;
          if (!conversationId || !text) {
            res.status(400).json({ error: "conversationId and text are required" });
            return;
          }

          try {
            await this.sendChannelMessage({
              conversationId,
              text,
              role: role === "error" ? "error" : "agent",
              channelName,
            });
            res.status(204).send();
          } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
          }
        })();
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

    // -----------------------------------------------------------------------
    // Secrets management endpoints
    //
    // All endpoints require an authenticated session AND an active privilege
    // grant.  Secrets are managed exclusively through these first-class Admin
    // API endpoints so they can never be accessed by agents via tool paths.
    // -----------------------------------------------------------------------
    if (this.authService) {
      registerSecretsRoutes(this.app, {
        secretsDir: this.secretsDir,
        authService: this.authService,
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

      const rest = typeof req.params["0"] === "string" && req.params["0"].length > 0
        ? `/${req.params["0"]}`
        : "";

      if (entry.transport === "unix-socket") {
        if (!entry.socketName) {
          res.status(500).json({ error: `Tool "${toolName}" is missing required socketName` });
          return;
        }
        if (req.method !== "POST") {
          res.status(405).json({ error: "Unix-socket tool RPC proxy only supports POST /rpc" });
          return;
        }
        if (rest !== "/rpc") {
          res.status(400).json({
            error: "Unix-socket tool RPC proxy only supports the /rpc endpoint",
          });
          return;
        }

        const body = req.body as Partial<RpcRequest> | undefined;
        if (!body || typeof body.id !== "string" || typeof body.method !== "string") {
          res.status(400).json({ error: "Invalid RPC request: missing id or method" });
          return;
        }

        const params =
          body.params && typeof body.params === "object" && !Array.isArray(body.params)
            ? (body.params as Record<string, unknown>)
            : {};

        const client = this.getOrCreateUnixSocketRpcClient(entry.socketName);
        try {
          const result = await client.call(body.method, params);
          const response: RpcResponse = { id: body.id, result };
          res.json(response);
        } catch (err) {
          const response: RpcResponse = {
            id: body.id,
            error: err instanceof Error ? err.message : String(err),
          };
          res.json(response);
        }
        return;
      }

      if (entry.transport !== "http" || !entry.url) {
        res.status(400).json({
          error: `Tool "${toolName}" has an unsupported transport configuration`,
        });
        return;
      }

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

    this.app.get("/api/topology", (req, res) => {
      if (!requireAuth(req, res)) return;
      if (!this.config) {
        res.status(503).json({ error: "Topology config is not available" });
        return;
      }

      const payload = buildTopologyPayload({
        config: this.config,
        toolRegistry: this.toolRegistry,
        agentCapabilities: this.agentCapabilities,
      });
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
      const conversationMetadataService = new ConversationMetadataService(dbPath);
      conversationMetadataService.ensureSchema();

      // List all conversation threads
      this.app.get("/api/conversations", (req, res) => {
        if (!requireAuth(req, res)) return;
        try {
          const db = new Database(dbPath, { readonly: true, fileMustExist: true });
          const rows = db.prepare<[], ConversationRow>(`
            SELECT
              grouped.thread_id,
              grouped.checkpoint_count,
              grouped.latest_checkpoint_id,
              meta.title
            FROM (
              SELECT
                thread_id,
                COUNT(*) AS checkpoint_count,
                MAX(checkpoint_id) AS latest_checkpoint_id
              FROM checkpoints
              WHERE checkpoint_ns = ''
              GROUP BY thread_id
            ) AS grouped
            LEFT JOIN conversation_metadata AS meta
              ON meta.thread_id = grouped.thread_id
            ORDER BY grouped.latest_checkpoint_id DESC
          `).all();
          db.close();

          const summaries: ConversationSummary[] = rows.map((r) => ({
            threadId: r.thread_id,
            messageCount: r.checkpoint_count,
            latestCheckpointId: r.latest_checkpoint_id,
            ...(typeof r.title === "string" && r.title.trim().length > 0 ? { title: r.title } : {}),
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

  private getOrCreateUnixSocketRpcClient(socketName: string): UnixSocketRpcClient {
    const existing = this.unixSocketRpcClients.get(socketName);
    if (existing) return existing;

    const client = new UnixSocketRpcClient(socketName);
    this.unixSocketRpcClients.set(socketName, client);
    return client;
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
      const finalize = async (): Promise<void> => {
        for (const client of this.unixSocketRpcClients.values()) {
          await client.disconnect().catch(() => undefined);
        }
        this.unixSocketRpcClients.clear();
      };

      if (!this.httpServer) {
        void finalize().then(() => resolve(), reject);
        return;
      }

      this.httpServer.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        void finalize().then(() => resolve(), reject);
      });
    });
  }
}

function readBodyString(body: unknown, key: string): string {
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") return "";
  return value.trim();
}

function readBodyBoolean(body: unknown, key: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  return (body as Record<string, unknown>)[key] === true;
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

function buildTopologyPayload(params: {
  config: GloveConfig;
  toolRegistry: ToolDefinition[];
  agentCapabilities: AgentCapabilityEntry[];
}): TopologyPayload {
  const { config, toolRegistry, agentCapabilities } = params;
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];

  const nodeById = new Map<string, TopologyNode>();
  const edgeById = new Set<string>();

  const hasText = (value: string | null | undefined): value is string =>
    typeof value === "string" && value.trim().length > 0;

  const addNode = (node: TopologyNode): void => {
    const existing = nodeById.get(node.id);
    if (existing) {
      const mergedNode: TopologyNode = {
        ...existing,
        ...node,
        key: hasText(node.key) ? node.key : existing.key,
        label: hasText(node.label) ? node.label : existing.label,
        meta: {
          ...(existing.meta ?? {}),
          ...(node.meta ?? {}),
        },
      };

      nodeById.set(node.id, mergedNode);
      const existingIndex = nodes.findIndex((entry) => entry.id === node.id);
      if (existingIndex !== -1) {
        nodes[existingIndex] = mergedNode;
      }
      return;
    }

    nodeById.set(node.id, node);
    nodes.push(node);
  };

  const addEdge = (edge: TopologyEdge): void => {
    if (edgeById.has(edge.id)) return;
    edgeById.add(edge.id);
    edges.push(edge);
  };

  const graphNodeId = (key: string) => `graph:${key}`;
  const agentNodeId = (key: string) => `agent:${key}`;
  const subgraphNodeId = (key: string) => `subgraph:${key}`;
  const modelNodeId = (key: string) => `model:${key}`;
  const toolNodeId = (key: string) => `tool:${key}`;

  const knownToolNames = new Set<string>(toolRegistry.map((tool) => tool.name));
  const fallbackToolNames = new Set<string>();

  for (const [graphKey, graphEntry] of Object.entries(config.graphs as Record<string, GraphEntry>)) {
    addNode({
      id: graphNodeId(graphKey),
      type: "graph",
      key: graphKey,
      label: graphKey,
      meta: {
        orchestratorAgentKey: graphEntry.orchestratorAgentKey,
        subAgentCount: graphEntry.subAgentKeys?.length ?? 0,
      },
    });

    const orchestratorId = agentNodeId(graphEntry.orchestratorAgentKey);
    addNode({
      id: orchestratorId,
      type: "agent",
      key: graphEntry.orchestratorAgentKey,
      label: graphEntry.orchestratorAgentKey,
      meta: { role: "orchestrator" },
    });
    addEdge({
      id: `${graphNodeId(graphKey)}->${orchestratorId}:graph-orchestrator`,
      source: graphNodeId(graphKey),
      target: orchestratorId,
      relation: "graph-orchestrator",
    });

    for (const subAgentKey of graphEntry.subAgentKeys ?? []) {
      const subAgentId = agentNodeId(subAgentKey);
      addNode({
        id: subAgentId,
        type: "agent",
        key: subAgentKey,
        label: subAgentKey,
        meta: { role: "sub-agent" },
      });
      addEdge({
        id: `${graphNodeId(graphKey)}->${subAgentId}:graph-sub-agent`,
        source: graphNodeId(graphKey),
        target: subAgentId,
        relation: "graph-sub-agent",
      });
    }

    const memorySubgraph = graphEntry.subgraphs?.memory;
    if (memorySubgraph) {
      const subgraphId = subgraphNodeId(memorySubgraph);
      addNode({
        id: subgraphId,
        type: "subgraph",
        key: memorySubgraph,
        label: memorySubgraph,
        meta: { role: "memory" },
      });
      addEdge({
        id: `${graphNodeId(graphKey)}->${subgraphId}:graph-memory-subgraph`,
        source: graphNodeId(graphKey),
        target: subgraphId,
        relation: "graph-memory-subgraph",
      });
    }

    for (const [compressionRole, compressionSubgraph] of Object.entries(graphEntry.subgraphs?.compression ?? {})) {
      const subgraphId = subgraphNodeId(compressionSubgraph);
      addNode({
        id: subgraphId,
        type: "subgraph",
        key: compressionSubgraph,
        label: compressionSubgraph,
        meta: { role: "compression" },
      });
      addEdge({
        id: `${graphNodeId(graphKey)}->${subgraphId}:${compressionRole}:graph-compression-subgraph`,
        source: graphNodeId(graphKey),
        target: subgraphId,
        relation: "graph-compression-subgraph",
        meta: { compressionRole },
      });
    }
  }

  for (const [subgraphKey, profile] of Object.entries(config.subgraphs as Record<string, SubgraphProfile>)) {
    const subgraphId = subgraphNodeId(subgraphKey);
    addNode({
      id: subgraphId,
      type: "subgraph",
      key: subgraphKey,
      label: subgraphKey,
      meta: {
        hasCompression: Boolean(profile.compression),
      },
    });

    if (profile.agentKey) {
      const linkedAgentId = agentNodeId(profile.agentKey);
      addNode({
        id: linkedAgentId,
        type: "agent",
        key: profile.agentKey,
        label: profile.agentKey,
      });
      addEdge({
        id: `${subgraphId}->${linkedAgentId}:subgraph-agent`,
        source: subgraphId,
        target: linkedAgentId,
        relation: "subgraph-agent",
      });
    }
  }

  for (const [agentKey, agentEntry] of Object.entries(config.agents as Record<string, AgentEntry>)) {
    const agentId = agentNodeId(agentKey);
    const modelKey = agentEntry.modelKey ?? "default";
    addNode({
      id: agentId,
      type: "agent",
      key: agentKey,
      label: agentKey,
      meta: {
        description: agentEntry.description ?? "",
      },
    });

    addNode({
      id: modelNodeId(modelKey),
      type: "model",
      key: modelKey,
      label: modelKey,
    });
    addEdge({
      id: `${agentId}->${modelNodeId(modelKey)}:agent-model`,
      source: agentId,
      target: modelNodeId(modelKey),
      relation: "agent-model",
    });
  }

  for (const modelKey of Object.keys(config.models)) {
    addNode({
      id: modelNodeId(modelKey),
      type: "model",
      key: modelKey,
      label: modelKey,
    });
  }

  for (const tool of toolRegistry) {
    addNode({
      id: toolNodeId(tool.name),
      type: "tool",
      key: tool.name,
      label: tool.name,
      meta: {
        description: tool.description,
        requiresPrivilegedAccess: Boolean(tool.requiresPrivilegedAccess),
      },
    });
  }

  for (const capability of agentCapabilities) {
    const agentId = agentNodeId(capability.key);
    addNode({
      id: agentId,
      type: "agent",
      key: capability.key,
      label: capability.key,
      meta: {
        description: capability.description,
      },
    });

    const modelId = modelNodeId(capability.modelKey);
    addNode({
      id: modelId,
      type: "model",
      key: capability.modelKey,
      label: capability.modelKey,
    });
    addEdge({
      id: `${agentId}->${modelId}:agent-model`,
      source: agentId,
      target: modelId,
      relation: "agent-model",
    });

    const capabilityTools = capability.tools ?? [...knownToolNames];
    for (const toolName of capabilityTools) {
      if (!knownToolNames.has(toolName)) {
        fallbackToolNames.add(toolName);
      }

      const toolId = toolNodeId(toolName);
      addNode({
        id: toolId,
        type: "tool",
        key: toolName,
        label: toolName,
      });
      addEdge({
        id: `${agentId}->${toolId}:agent-tool`,
        source: agentId,
        target: toolId,
        relation: "agent-tool",
        meta: {
          unrestrictedToolAccess: capability.tools === null,
        },
      });
    }
  }

  for (const toolName of fallbackToolNames) {
    addNode({
      id: toolNodeId(toolName),
      type: "tool",
      key: toolName,
      label: toolName,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    counts: {
      graphs: nodes.filter((node) => node.type === "graph").length,
      agents: nodes.filter((node) => node.type === "agent").length,
      subgraphs: nodes.filter((node) => node.type === "subgraph").length,
      models: nodes.filter((node) => node.type === "model").length,
      tools: nodes.filter((node) => node.type === "tool").length,
    },
  };
}

/** Extract the RP ID (hostname only) from a full origin URL. */
function getRpId(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return "localhost";
  }
}
