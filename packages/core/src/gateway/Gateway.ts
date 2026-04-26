import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  ConfigLoader,
  ModelRegistry,
  ModelHealthChecker,
  resolveConfigEntry,
  DEFAULT_GRAPH_ENTRY,
  type GloveConfig,
  type AgentEntry,
  type GraphEntry,
  type SubgraphProfile,
  type ToolServerEntry,
  type ModelHealthResult,
} from "@langgraph-glove/config";
import { GloveAgent } from "../agent/Agent";
import {
  buildSingleAgentGraph,
  buildOrchestratorGraph,
  type CompressionRuntimeConfig,
  type SubAgentDef,
} from "../agent/graphs";
import { Logger } from "../logging/Logger";
import { LogService } from "../logging/LogService";
import { HttpRpcClient } from "../rpc/HttpRpcClient";
import { UnixSocketRpcClient } from "../rpc/UnixSocketRpcClient";
import type { RpcClient } from "../rpc/RpcClient";
import { RemoteTool } from "../tools/RemoteTool";
import { createImapRouterTools, type ImapRouterInstanceConfig } from "../tools/ImapRouterTools.js";
import { getToolPayloadRefTool } from "../tools/ToolPayloadRefTool";
import { AdminApi } from "../api/AdminApi";
import { ConversationMetadataService } from "../api/ConversationMetadataService";
import { AuthService } from "../auth/AuthService";
import { ContentStore } from "../content/ContentStore";
import { ContentUploadTokenService } from "../content/ContentUploadTokenService";
import { GatewayContentUnixSocketServer } from "../content/GatewayContentUnixSocketServer";
import type { Channel } from "../channels/Channel";
import { WebChannel } from "../channels/WebChannel";
import type { OutgoingContentItem } from "../channels/Channel";
import type {
  ToolDefinition,
  ToolServerStatus,
  AgentCapabilityEntry,
  ContentUploadAuthPayload,
  RpcRequest,
  RpcResponse,
} from "../rpc/RpcProtocol";
import type { ToolEventMetadata } from "../rpc/RpcProtocol";
import { LlmCallbackHandler } from "../logging/LlmCallbackHandler";
import { isGenericToolName, resolveToolName } from "../agent/toolNameUtils.js";

const logger = new Logger("Gateway");
const CONVERSATION_TITLE_GRAPH_KEY = "conversation-title";
const CONVERSATION_TITLE_MAX_CHARS = 80;
const STARTUP_SLOW_STEP_MS = 2000;
const IMAP_CRAWL_CONTROL_TIMEOUT_MS = 1500;

interface StartupPhaseTiming {
  phase: string;
  durationMs: number;
  slow: boolean;
}

export interface GatewayOptions {
  /** Path to the config directory. */
  configDir: string;
  /** Path to the secrets directory. */
  secretsDir: string;
  /**
   * Additional channels to register (e.g. CliChannel for dev mode).
   * Channels defined in channels.json are created automatically in the future;
   * for now pass concrete instances here.
   */
  channels?: Channel[];
}

export type GatewayState = "stopped" | "starting" | "running" | "stopping";

/**
 * Central application gateway that owns the full agent lifecycle:
 *
 * 1. Load config and secrets
 * 2. Create model registry
 * 3. Connect to tool servers and discover tools
 * 4. Create agent with persistence
 * 5. Start channels
 * 6. Serve health endpoint
 * 7. Handle graceful shutdown
 *
 * ## Events
 * - `stateChange` — emitted whenever the gateway state transitions
 * - `error`       — emitted on non-fatal errors (channel failures, etc.)
 */
export class Gateway extends EventEmitter {
  private _state: GatewayState = "stopped";
  private agent: GloveAgent | null = null;
  private checkpointer: BaseCheckpointSaver | null = null;
  private rpcClients: RpcClient[] = [];
  private config: GloveConfig | null = null;
  private configLoader: ConfigLoader | null = null;
  private models: ModelRegistry | null = null;
  private healthServer: HealthServer | null = null;
  private adminApi: AdminApi | null = null;
  private authService: AuthService | null = null;
  private contentStore: ContentStore | null = null;
  private contentUnixSocketServer: GatewayContentUnixSocketServer | null = null;
  private readonly contentUploadTokenService = new ContentUploadTokenService();
  private conversationMetadataService: ConversationMetadataService | null = null;
  private readonly titleGenerationInFlight = new Set<string>();
  private shutdownHandlers: (() => void)[] = [];
  private shutdownSignal: NodeJS.Signals | null = null;

  /** Discovered tool definitions, populated after `discoverTools()`. */
  private toolRegistry: ToolDefinition[] = [];
  /** Mapping of tools.json server key -> discovered tool names. */
  private discoveredToolNamesByServer: Record<string, string[]> = {};
  /** Per-server bootstrap status, populated after `discoverTools()`. */
  private toolServerStatuses = new Map<string, ToolServerStatus>();
  /** Agent capability entries, populated after `buildAgentGraph()`. */
  private agentCapabilities: AgentCapabilityEntry[] = [];
  /** Tool set discovered during startup, reused to build non-default graphs on demand. */
  private discoveredTools: StructuredToolInterface[] = [];

  constructor(private readonly options: GatewayOptions) {
    super();
  }

  get state(): GatewayState {
    return this._state;
  }

  get toolServerStatusMap(): Map<string, ToolServerStatus> {
    return this.toolServerStatuses;
  }

  private setState(state: GatewayState): void {
    this._state = state;
    this.emit("stateChange", state);
  }

  /** Start the gateway — load config, connect tools, create agent, start channels. */
  async start(): Promise<void> {
    if (this._state !== "stopped") {
      throw new Error(`Cannot start gateway in state "${this._state}"`);
    }
    this.setState("starting");

    try {
      const startupStartedAt = Date.now();
      const startupPhases: StartupPhaseTiming[] = [];
      let dbPath = "data/checkpoints.sqlite";
      let tools: StructuredToolInterface[] = [];

      await this.measureStartupPhase("config+secrets", startupPhases, async () => {
        logger.info("Loading configuration...");
        this.configLoader = new ConfigLoader(
          this.options.configDir,
          this.options.secretsDir,
        );
        this.config = this.configLoader.load();
        LogService.addRedactions(this.configLoader.secrets.values);
        logger.info("Configuration loaded");
      });

      await this.measureStartupPhase("model-registry", startupPhases, async () => {
        this.models = new ModelRegistry(this.config!.models);
      });

      await this.measureStartupPhase("model-health-checks", startupPhases, async () => {
        const resumeImapCrawls = await this.pauseImapCrawlsForHealthChecks(this.config!.tools);
        try {
          const modelHealth = await this.checkModelHealth(this.models!, this.config!);
          this.updateWebChannelModelInfo(this.config!, modelHealth);
        } finally {
          await resumeImapCrawls();
        }
      });

      await this.measureStartupPhase("persistence-init", startupPhases, async () => {
        dbPath = this.config!.gateway.dbPath ?? "data/checkpoints.sqlite";
        this.checkpointer = SqliteSaver.fromConnString(dbPath);
        this.conversationMetadataService = new ConversationMetadataService(dbPath);
        this.conversationMetadataService.ensureSchema();
        logger.info(`SQLite persistence: ${dbPath}`);

        const contentDbPath = this.config!.gateway.contentDbPath ?? "data/content.sqlite";
        this.contentStore = new ContentStore({ dbPath: contentDbPath });
        this.contentStore.ensureSchema();
        logger.info(`SQLite content store: ${contentDbPath}`);

        const deletedRetentionDays = this.config!.gateway.deletedContentRetentionDays;
        if (deletedRetentionDays && deletedRetentionDays > 0) {
          const cleanupDeletedContent = () => {
            if (!this.contentStore) return;
            try {
              const purged = this.contentStore.purgeDeletedContentOlderThanDays(deletedRetentionDays);
              if (purged > 0) {
                logger.info(
                  `Deleted-content retention cleanup purged ${purged} row(s) older than ${deletedRetentionDays} day(s)`,
                );
              }
            } catch (err) {
              logger.error("Deleted-content retention cleanup failed", err);
            }
          };

          cleanupDeletedContent();

          const cleanupIntervalMs = 60 * 60 * 1000;
          const cleanupTimer = setInterval(cleanupDeletedContent, cleanupIntervalMs);
          cleanupTimer.unref();
          this.shutdownHandlers.push(() => clearInterval(cleanupTimer));

          logger.info(
            `Deleted-content retention enabled: ${deletedRetentionDays} day(s) (hourly cleanup)`,
          );
        }
      });

      await this.measureStartupPhase("content-socket", startupPhases, async () => {
        const contentSocketName = process.env["GLOVE_GATEWAY_CONTENT_UPLOAD_SOCKET"] ?? "gateway_content_upload";
        this.contentUnixSocketServer = new GatewayContentUnixSocketServer({
          socketName: contentSocketName,
          handler: async (request) => this.handleContentRpcRequest(request),
        });
        await this.contentUnixSocketServer.start();
        logger.info(`Gateway content unix-socket RPC: ${contentSocketName}`);
      });

      await this.measureStartupPhase("auth-bootstrap", startupPhases, async () => {
        this.authService = new AuthService({
          dbPath,
          config: this.config!.gateway.auth,
        });
        const setupToken = this.authService.ensureBootstrapToken();
        if (setupToken) {
          logger.warn("Initial setup is required.");
          logger.warn("Use this setup token in the web UI to create your password:");
          logger.warn(`Setup token (expires ${setupToken.expiresAt}): ${setupToken.token}`);
          logger.warn("You can regenerate it with: pnpm --filter @langgraph-glove/core debug -- --regenerate-setup-token");
        }
      });

      await this.measureStartupPhase("tool-discovery", startupPhases, async () => {
        tools = await this.discoverTools(this.config!.tools);
        this.discoveredTools = tools;
        logger.info(`Discovered ${tools.length} tool(s) from ${Object.keys(this.config!.tools).length} server(s)`);
        this.reportUnavailableConfiguredTools(this.config!, tools);
      });

      const graph = await this.measureStartupPhase("graph-build", startupPhases, async () => {
        return this.buildAgentGraph(tools, "default");
      });

      await this.measureStartupPhase("agent+channels", startupPhases, async () => {
        this.agentCapabilities = this.buildAgentCapabilities(this.config!);

        const defaultGraphEntry = this.config!.graphs["default"] ?? DEFAULT_GRAPH_ENTRY;
        const orchestratorEntry = resolveConfigEntry(
          this.config!.agents as Record<string, AgentEntry>,
          defaultGraphEntry.orchestratorAgentKey,
        );
        this.agent = new GloveAgent(graph, {
          recursionLimit: orchestratorEntry.recursionLimit,
          toolLookup: (name) => this.toolRegistry.find((t) => t.name === name),
          getContentUploadAuthByTool: (conversationId) => this.buildContentUploadAuthByTool(conversationId),
          authService: this.authService ?? undefined,
          graphInfo: {
            graphKey: "default",
            mode: (defaultGraphEntry.subAgentKeys?.length ?? 0) > 0 ? "multi-agent" : "single-agent",
            orchestratorAgentKey: defaultGraphEntry.orchestratorAgentKey,
            subAgentKeys: defaultGraphEntry.subAgentKeys ?? [],
          },
          onTurnComplete: ({ conversationId, userText, assistantText, graphKey }) => {
            this.maybeScheduleConversationTitleGeneration({
              graphKey: graphKey ?? "default",
              conversationId,
              userPrompt: userText,
              assistantResponse: assistantText,
            });
          },
        });

        // Inject the auth service into any channel that supports it — this
        // gates WebSocket upgrades behind the session token check.
        for (const ch of this.options.channels ?? []) {
          if (typeof (ch as unknown as { setAuthService?: unknown }).setAuthService === "function") {
            (ch as unknown as { setAuthService: (svc: AuthService) => void }).setAuthService(
              this.authService!,
            );
          }
        }
        for (const channel of this.options.channels ?? []) {
          this.agent.addChannel(channel);
        }
        await this.agent.start();
        logger.info("Agent and channels started");
      });

      await this.measureStartupPhase("health-server", startupPhases, async () => {
        const healthPort = this.config!.gateway.healthPort ?? 9090;
        const healthHost = this.config!.gateway.healthHost ?? "0.0.0.0";
        this.healthServer = new HealthServer(this);
        await this.healthServer.listen(healthPort, healthHost);
        logger.info(`Health endpoint: http://${healthHost}:${healthPort}/health`);
      });

      await this.measureStartupPhase("admin-api", startupPhases, async () => {
        const apiPort = this.config!.gateway.apiPort ?? 8081;
        const apiHost = this.config!.gateway.apiHost ?? "0.0.0.0";
        this.adminApi = new AdminApi({
          port: apiPort,
          host: apiHost,
          dbPath: this.config!.gateway.dbPath,
          authService: this.authService ?? undefined,
          config: this.config!,
          toolsConfig: this.config!.tools as Record<string, ToolServerEntry>,
          toolRegistry: this.toolRegistry,
          toolServerStatuses: this.toolServerStatuses,
          agentCapabilities: this.agentCapabilities,
          invokeAgent: async ({ conversationId, prompt, graphKey, personalToken, observability }) => {
            return this.invokeConfiguredGraph({
              conversationId,
              prompt,
              personalToken,
              graphKey,
              observability,
            });
          },
          sendSystemMessage: async ({ conversationId, text, role }) => {
            const targets = (this.options.channels ?? []).filter((channel) => channel.receiveSystem);
            for (const channel of targets) {
              await channel
                .sendMessage({
                  conversationId,
                  text,
                  role: role ?? "system-event",
                })
                .catch((err: unknown) =>
                  logger.error(`Failed to send system message to channel "${channel.name}"`, err),
                );
            }
          },
          sendChannelMessage: async ({ conversationId, text, role, channelName }) => {
            const allChannels = this.options.channels ?? [];
            const targets = channelName
              ? allChannels.filter((channel) => channel.name === channelName)
              : allChannels;

            if (targets.length === 0) {
              throw new Error(`No channel target available for channelName="${channelName ?? "*"}"`);
            }

            for (const channel of targets) {
              await channel
                .sendMessage({
                  conversationId,
                  text,
                  role: role ?? "agent",
                })
                .catch((err: unknown) =>
                  logger.error(`Failed to send channel message to channel "${channel.name}"`, err),
                );
            }
          },
          handleContentRpc: async (request) => this.handleContentRpcRequest(request),
          listContent: ({ conversationId, toolName, includeDeleted, limit, offset }) => {
            const rows = this.contentStore?.listContentMetadata({
              conversationId,
              toolName,
              includeDeleted,
              limit,
              offset,
            }) ?? [];
            return rows.map((item) => ({
              contentRef: item.contentRef,
              conversationId: item.conversationId,
              toolName: item.toolName,
              fileName: item.fileName,
              mimeType: item.mimeType,
              byteLength: item.byteLength,
              createdAt: item.createdAt,
              deletedAt: item.deletedAt,
            }));
          },
          getContentByRef: (contentRef) => {
            const item = this.contentStore?.getContentMetadata(contentRef);
            if (!item) return undefined;
            return {
              contentRef: item.contentRef,
              conversationId: item.conversationId,
              toolName: item.toolName,
              fileName: item.fileName,
              mimeType: item.mimeType,
              byteLength: item.byteLength,
              createdAt: item.createdAt,
              deletedAt: item.deletedAt,
            };
          },
          getContentBytesByRef: (contentRef) => this.contentStore?.getContentBytes(contentRef),
          deleteContentByRef: (contentRef) => {
            this.contentStore?.deleteContent(contentRef);
          },
        });
        await this.adminApi.listen();
        logger.info(`Admin API: http://${apiHost}:${apiPort}/api/conversations`);
      });

      // 11. Signal handlers
      this.installSignalHandlers();

      this.setState("running");
      this.logStartupSummary(startupStartedAt, startupPhases);
      logger.info("Gateway is running");
    } catch (err) {
      this.setState("stopped");
      throw err;
    }
  }

  /** Gracefully stop the gateway — disconnect channels, tool clients, health server. */
  async stop(): Promise<void> {
    if (this._state !== "running") return;
    this.setState("stopping");
    logger.info("Gateway shutting down...");

    // Remove signal handlers
    for (const cleanup of this.shutdownHandlers) cleanup();
    this.shutdownHandlers = [];

    // Stop health server
    if (this.healthServer) {
      await this.healthServer.close();
      this.healthServer = null;
    }

    // Stop admin API
    if (this.adminApi) {
      await this.adminApi.close();
      this.adminApi = null;
    }

    if (this.authService) {
      this.authService.close();
      this.authService = null;
    }

    if (this.contentUnixSocketServer) {
      await this.contentUnixSocketServer.stop();
      this.contentUnixSocketServer = null;
    }

    if (this.contentStore) {
      this.contentStore.close();
      this.contentStore = null;
    }

    // Stop agent + channels
    if (this.agent) {
      await this.agent.stop();
      this.agent = null;
    }

    // Disconnect tool RPC clients
    for (const client of this.rpcClients) {
      await client.disconnect().catch((e: unknown) =>
        logger.error("Error disconnecting RPC client", e),
      );
    }
    this.rpcClients = [];

    this.setState("stopped");
    logger.info("Gateway stopped");
  }

  /**
   * Probe the subset of models referenced by agents.json.
   *
   * Unknown / unused model keys are silently skipped.  A failed probe logs a
   * warning but does NOT abort startup — the intent is to surface problems
   * early, not to gate the whole system on a transient provider outage.
   */
  private async checkModelHealth(models: ModelRegistry, config: GloveConfig): Promise<ModelHealthResult[]> {
    const agents = config.agents as Record<string, AgentEntry>;
    const usedKeys = new Set(
      Object.values(agents)
        .map((a) => a.modelKey ?? "default")
        .filter((k) => models.keys().includes(k)),
    );

    if (usedKeys.size === 0) return [];

    const keys = [...usedKeys];
    logger.info(`Model health checks: probing [${keys.join(", ")}]…`);
    const checker = new ModelHealthChecker(models);
    const results = await Promise.all(
      keys.map(async (key) => {
        logger.info(`  … ${key}: probe started`);
        const result = await checker.check(key);
        const slowMarker = result.latencyMs >= STARTUP_SLOW_STEP_MS ? " [slow]" : "";
        if (result.ok) {
          const contextPart = result.contextWindowTokens
            ? `, ctx=${result.contextWindowTokens}${result.contextWindowSource ? ` (${result.contextWindowSource})` : ""}`
            : "";
          logger.info(`  ✓ ${result.key} (${result.latencyMs}ms${contextPart})${slowMarker}`);
        } else {
          const contextPart = result.contextWindowTokens
            ? `, ctx=${result.contextWindowTokens}${result.contextWindowSource ? ` (${result.contextWindowSource})` : ""}`
            : "";
          logger.warn(`  ✗ ${result.key} — ${result.error ?? "unknown error"} (${result.latencyMs}ms${contextPart})${slowMarker}`);
        }
        return result;
      }),
    );

    const rankedResults = [...results].sort((a, b) => b.latencyMs - a.latencyMs);
    logger.info(
      `Model health checks by duration: ${rankedResults
        .map((result) => `${result.key}=${result.latencyMs}ms`)
        .join(", ")}`,
    );
    const slowest = rankedResults[0];
    if (slowest) {
      const message = `Slowest model health check: ${slowest.key} (${slowest.latencyMs}ms)`;
      if (slowest.latencyMs >= STARTUP_SLOW_STEP_MS) {
        logger.warn(`${message} [slow]`);
      } else {
        logger.info(message);
      }
    }

    return results;
  }

  private async pauseImapCrawlsForHealthChecks(
    toolsConfig: Record<string, ToolServerEntry>,
  ): Promise<() => Promise<void>> {
    const imapEntries = Object.entries(toolsConfig).filter(
      ([, entry]) => entry.enabled !== false && Boolean(entry.imap),
    );
    if (imapEntries.length === 0) {
      return async () => {};
    }

    const pausedClients: Array<{ key: string; client: RpcClient }> = [];
    logger.info(`IMAP crawl pause: attempting ${imapEntries.length} instance(s) before model health checks`);

    for (const [key, entry] of imapEntries) {
      const client = this.createRpcClient(key, entry);
      try {
        await this.withTimeout(
          client.connect(),
          IMAP_CRAWL_CONTROL_TIMEOUT_MS,
          `IMAP pause connect timeout for "${key}"`,
        );
        const result = await this.withTimeout(
          client.call("imap_stop_crawl", {}),
          IMAP_CRAWL_CONTROL_TIMEOUT_MS,
          `IMAP pause RPC timeout for "${key}"`,
        );

        if (this.wasImapCrawlStopped(result)) {
          pausedClients.push({ key, client });
          logger.info(`IMAP crawl pause: "${key}" paused for model health checks`);
        } else {
          await client.disconnect().catch(() => undefined);
          logger.debug(`IMAP crawl pause: "${key}" had no active crawl to pause`);
        }
      } catch (err) {
        await client.disconnect().catch(() => undefined);
        logger.debug(`IMAP crawl pause skipped for "${key}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return async () => {
      if (pausedClients.length === 0) return;
      logger.info(`IMAP crawl resume: restoring ${pausedClients.length} paused instance(s)`);
      for (const { key, client } of pausedClients) {
        try {
          await this.withTimeout(
            client.call("imap_start_crawl", {}),
            IMAP_CRAWL_CONTROL_TIMEOUT_MS,
            `IMAP resume RPC timeout for "${key}"`,
          );
          logger.info(`IMAP crawl resume: "${key}" resumed`);
        } catch (err) {
          logger.warn(`IMAP crawl resume failed for "${key}": ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          await client.disconnect().catch(() => undefined);
        }
      }
    };
  }

  private wasImapCrawlStopped(result: unknown): boolean {
    if (!result || typeof result !== "object") return false;
    const value = (result as Record<string, unknown>)["stopped"];
    return value === true;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(label)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private updateWebChannelModelInfo(
    config: GloveConfig,
    modelHealth: ModelHealthResult[],
  ): void {
    const agents = config.agents as Record<string, AgentEntry>;
    const defaultGraphEntry = config.graphs["default"] ?? DEFAULT_GRAPH_ENTRY;
    const orchestratorEntry = resolveConfigEntry(agents, defaultGraphEntry.orchestratorAgentKey);
    const defaultModelKey = orchestratorEntry.modelKey ?? "default";
    const defaultModelHealth = modelHealth.find((result) => result.key === defaultModelKey);

    const appInfoPatch: {
      modelKey: string;
      modelContextWindowTokens?: number;
      modelContextWindowSource?: string;
    } = {
      modelKey: defaultModelKey,
      ...(defaultModelHealth?.contextWindowTokens
        ? { modelContextWindowTokens: defaultModelHealth.contextWindowTokens }
        : {}),
      ...(defaultModelHealth?.contextWindowSource
        ? { modelContextWindowSource: defaultModelHealth.contextWindowSource }
        : {}),
    };

    for (const channel of this.options.channels ?? []) {
      if (channel instanceof WebChannel) {
        channel.setAppInfo(appInfoPatch);
      }
    }
  }

  /**
   * Build the appropriate LangGraph graph based on graphs.json and agents.json:
   * - Reads the named graph entry from graphs.json (defaults to "default")
   * - If the graph entry has no sub-agents → single-agent ReAct graph
   * - If the graph entry has sub-agents → orchestrator graph with sub-agents
   */
  private buildAgentGraph(
    allTools: StructuredToolInterface[],
    graphKey: string = "default",
    options?: {
      checkpointerOverride?: BaseCheckpointSaver | null;
    },
  ) {
    const agents = this.config!.agents as Record<string, AgentEntry>;
    const subgraphs = (this.config as GloveConfig & {
      subgraphs?: Record<string, SubgraphProfile>;
    }).subgraphs ?? {};
    const resolvedGraphEntry = this.config!.graphs[graphKey];
    if (!resolvedGraphEntry) {
      logger.warn(
        `Graph key "${graphKey}" not found in graphs.json — falling back to default graph entry (orchestrator: "default", no sub-agents)`,
      );
    }
    const graphEntry: GraphEntry = resolvedGraphEntry ?? DEFAULT_GRAPH_ENTRY;
    const models = this.models!;
    const checkpointer = options?.checkpointerOverride === undefined
      ? this.checkpointer!
      : (options.checkpointerOverride ?? undefined);

    const orchestratorKey = graphEntry.orchestratorAgentKey;
    const subAgentKeys = [...(graphEntry.subAgentKeys ?? [])];
    const memorySubgraphKey = (graphEntry as GraphEntry & {
      subgraphs?: { memory?: string };
    }).subgraphs?.memory;
    const memorySubgraphProfile = memorySubgraphKey
      ? this.resolveSubgraphProfile(subgraphs, memorySubgraphKey)
      : undefined;

    if (memorySubgraphProfile && !subAgentKeys.includes("memory")) {
      subAgentKeys.push("memory");
    }

    const orchestratorEntry = resolveConfigEntry(agents, orchestratorKey);

    if (subAgentKeys.length === 0) {
      // Single-agent mode — standard ReAct loop
      const model = models.get(orchestratorEntry.modelKey ?? "default");
      const scopedTools = this.scopeTools(allTools, this.resolveAllowedToolNames(orchestratorEntry));
      const compression = this.resolveCompressionRuntimeConfig({
        allTools,
        agentEntry: orchestratorEntry,
        agentKey: orchestratorKey,
        graphEntry,
        subgraphs,
      });
      logger.info(`Graph "${graphKey}": single-agent mode (${scopedTools.length} tools)`);
      if (compression) {
        logger.info(
          `Graph "${graphKey}": agent "${orchestratorKey}" compression tool "${compression.toolName}" resolved`,
        );
      }

      return buildSingleAgentGraph({
        model,
        tools: scopedTools,
        systemPrompt: this.resolveSystemPrompt(orchestratorEntry.systemPrompt, scopedTools),
        compression,
        checkpointer,
      });
    }

    // Multi-agent orchestrator mode
    const subAgents: SubAgentDef[] = subAgentKeys.map((key) => {
      const entry =
        key === "memory" && memorySubgraphProfile
          ? this.resolveAgentEntryFromSubgraphProfile(agents, memorySubgraphProfile)
          : resolveConfigEntry(agents, key);
      const scopedTools = this.scopeTools(allTools, this.resolveAllowedToolNames(entry));
      const compression = this.resolveCompressionRuntimeConfig({
        allTools,
        agentEntry: entry,
        agentKey: key,
        graphEntry,
        subgraphs,
      });
      return {
        name: key,
        description: entry.description ?? key,
        model: models.get(entry.modelKey ?? "default"),
        tools: scopedTools,
        systemPrompt: this.resolveSystemPrompt(entry.systemPrompt, scopedTools),
        recursionLimit: entry.recursionLimit,
        compression,
      };
    });

    const orchestratorModel = models.get(orchestratorEntry.modelKey ?? "default");
    const orchestratorTools = this.scopeTools(
      allTools,
      this.resolveAllowedToolNames(orchestratorEntry),
    );

    logger.info(
      `Graph "${graphKey}": multi-agent orchestrator mode with ${subAgents.length} sub-agent(s) [${subAgentKeys.join(", ")}]`,
    );
    if (memorySubgraphKey) {
      logger.info(
        `Graph "${graphKey}": memory subgraph profile "${memorySubgraphKey}" resolved`,
      );
    }
    for (const subAgent of subAgents) {
      if (!subAgent.compression) continue;
      logger.info(
        `Graph "${graphKey}": agent "${subAgent.name}" compression tool "${subAgent.compression.toolName}" resolved`,
      );
    }

    return buildOrchestratorGraph({
      orchestrator: {
        model: orchestratorModel,
        systemPrompt: this.resolveSystemPrompt(orchestratorEntry.systemPrompt, orchestratorTools),
        tools: orchestratorTools.length > 0 ? orchestratorTools : undefined,
      },
      subAgents,
      checkpointer,
    });
  }

  private async invokeConfiguredGraph(params: {
    conversationId: string;
    prompt: string;
    graphKey?: string;
    personalToken?: string;
    disableConversationTitleGeneration?: boolean;
    observability?: {
      enabled?: boolean;
      conversationId?: string;
      sourceChannel?: string;
      taskId?: string;
      scheduleType?: "cron" | "once";
      trigger?: "cron" | "once-minute-sweep" | "manual-now";
    };
  }): Promise<string> {
    const graphKey = params.graphKey?.trim() || "default";
    const targets = (this.options.channels ?? []).filter((channel) => channel.receiveAgentProcessing);
    const observabilityEnabled = params.observability?.enabled === true && targets.length > 0;
    const observabilityConversationId =
      params.observability?.conversationId?.trim() || params.conversationId;

    const sendObservability = (
      role: "prompt" | "tool-call" | "tool-result" | "model-call" | "model-response" | "graph-definition" | "system-event" | "agent-transfer",
      text: string,
      toolEventMetadata?: ToolEventMetadata,
      toolName?: string,
      contentItems?: OutgoingContentItem[],
    ): void => {
      if (!observabilityEnabled) return;
      const resolvedToolName = (() => {
        if (toolName && !isGenericToolName(toolName)) return toolName;
        const metaToolName = toolEventMetadata?.tool?.name;
        if (typeof metaToolName === "string" && !isGenericToolName(metaToolName)) {
          return metaToolName;
        }
        return toolName;
      })();
      for (const channel of targets) {
        channel
          .sendMessage({
            conversationId: observabilityConversationId,
            text,
            role,
            ...(resolvedToolName ? { toolName: resolvedToolName } : {}),
            ...(toolEventMetadata ? { toolEventMetadata } : {}),
            ...(contentItems && contentItems.length > 0 ? { contentItems } : {}),
          })
          .catch((err: unknown) =>
            logger.error(`Failed to send observability message to channel "${channel.name}"`, err),
          );
      }
    };

    const contentUploadAuthByTool = this.buildContentUploadAuthByTool(params.conversationId);

    if (observabilityEnabled) {
      sendObservability(
        "graph-definition",
        JSON.stringify(
          {
            type: "graph-info",
            graphName: graphKey,
            graph: {
              graphKey,
              mode: (() => {
                const entry = this.config?.graphs[graphKey] ?? DEFAULT_GRAPH_ENTRY;
                return (entry.subAgentKeys?.length ?? 0) > 0 ? "multi-agent" : "single-agent";
              })(),
              memorySubgraphKey: (
                this.config?.graphs[graphKey] as GraphEntry & { subgraphs?: { memory?: string } } | undefined
              )?.subgraphs?.memory,
              compressionSubgraphKeys: (
                this.config?.graphs[graphKey] as GraphEntry & { subgraphs?: { compression?: Record<string, string> } } | undefined
              )?.subgraphs?.compression,
            },
            sourceChannel: params.observability?.sourceChannel ?? "scheduled",
            schedule: {
              taskId: params.observability?.taskId,
              scheduleType: params.observability?.scheduleType,
              trigger: params.observability?.trigger,
            },
          },
          null,
          2,
        ),
      );
    }

    const llmHandler = new LlmCallbackHandler(
      observabilityEnabled ? (formatted: string) => sendObservability("prompt", formatted) : undefined,
      observabilityEnabled
        ? (payload: Record<string, unknown>) =>
            sendObservability("model-call", JSON.stringify(payload, null, 2))
        : undefined,
      observabilityEnabled
        ? (payload: Record<string, unknown>) =>
            sendObservability("model-response", JSON.stringify(payload, null, 2))
        : undefined,
    );

    const toolRunNameByRunId = new Map<string, string>();
    const toolCallbackHandler = observabilityEnabled
      ? BaseCallbackHandler.fromMethods({
          handleToolStart: (
            tool,
            input,
            runId,
            _parentRunId,
            _tags,
            metadata,
            runName,
            toolCallId,
          ): void => {
            const toolName = resolveToolName(
              typeof runName === "string" ? runName : undefined,
              tool,
              typeof toolCallId === "string" ? toolCallId : undefined,
              metadata,
            );
            toolRunNameByRunId.set(String(runId), toolName);

            const parsedInput = parseJsonMaybe(input);
            const toolDef = this.toolRegistry.find((entry) => entry.name === toolName);
            const meta: ToolEventMetadata | undefined = toolDef
              ? { tool: toolDef }
              : undefined;

            if (toolName.startsWith("transfer_to_")) {
              const targetAgent = toolName.replace(/^transfer_to_/, "");
              const request = typeof parsedInput === "object" && parsedInput !== null && "request" in parsedInput
                ? (() => {
                    const val = (parsedInput as Record<string, unknown>)["request"];
                    if (typeof val === "string") return val;
                    if (val == null) return "";
                    try { return JSON.stringify(val); } catch { return String(val); }
                  })()
                : "";
              sendObservability(
                "agent-transfer",
                JSON.stringify({ agent: targetAgent, request }),
              );
            } else {
              sendObservability(
                "tool-call",
                JSON.stringify({
                  name: toolName,
                  args: parsedInput,
                  ...(typeof toolCallId === "string" && toolCallId.length > 0 ? { id: toolCallId } : {}),
                  type: "tool_call",
                }),
                meta,
                toolName,
              );
            }
          },
          handleToolEnd: (output, runId): void => {
            const runKey = String(runId);
            const toolName = toolRunNameByRunId.get(runKey);
            toolRunNameByRunId.delete(runKey);
            const toolDef = toolName ? this.toolRegistry.find((entry) => entry.name === toolName) : undefined;
            const meta: ToolEventMetadata | undefined = toolDef
              ? { tool: toolDef }
              : undefined;
            const content = typeof output === "string" ? output : safeStringify(output);
            const contentItems = this.resolveContentItemsFromToolOutput(content);
            sendObservability(
              "tool-result",
              JSON.stringify({ name: toolName, content }),
              meta,
              toolName,
              contentItems,
            );
          },
          handleToolError: (_error, runId): void => {
            toolRunNameByRunId.delete(String(runId));
          },
        })
      : undefined;
    const callbacks: BaseCallbackHandler[] = toolCallbackHandler
      ? [llmHandler, toolCallbackHandler]
      : [llmHandler];

    if (graphKey === "default") {
      if (!this.agent) throw new Error("Agent is not running");
      const defaultGraphEntry = this.config!.graphs["default"] ?? DEFAULT_GRAPH_ENTRY;
      const defaultOrchestratorEntry = resolveConfigEntry(
        this.config!.agents as Record<string, AgentEntry>,
        defaultGraphEntry.orchestratorAgentKey,
      );
      const responseText = await this.agent.invoke(
        params.prompt,
        params.conversationId,
        callbacks,
        params.personalToken,
        undefined,
        {
          sourceChannel: params.observability?.sourceChannel ?? "scheduled",
          sourceConversationId: params.conversationId,
          sourceMetadata: {
            trigger: params.observability?.trigger,
            taskId: params.observability?.taskId,
            scheduleType: params.observability?.scheduleType,
          },
          ...(Object.keys(contentUploadAuthByTool).length > 0
            ? { contentUploadAuthByTool }
            : {}),
          ...(defaultOrchestratorEntry.maxInlineToolResultBytes !== undefined
            ? { maxInlineToolResultBytes: defaultOrchestratorEntry.maxInlineToolResultBytes }
            : {}),
        },
      );
      this.maybeScheduleConversationTitleGeneration({
        graphKey,
        conversationId: params.conversationId,
        userPrompt: params.prompt,
        assistantResponse: responseText,
        disableConversationTitleGeneration: params.disableConversationTitleGeneration,
      });
      return responseText;
    }

    if (!this.config || !this.models || !this.checkpointer) {
      throw new Error("Gateway is not fully initialized");
    }

    const graph = this.buildAgentGraph(this.discoveredTools, graphKey);
    const graphEntry = this.config.graphs[graphKey] ?? DEFAULT_GRAPH_ENTRY;
    const orchestratorEntry = resolveConfigEntry(
      this.config.agents as Record<string, AgentEntry>,
      graphEntry.orchestratorAgentKey,
    );

    const result = await graph.invoke(
      { messages: [new HumanMessage(params.prompt)] },
      {
        configurable: {
          thread_id: params.conversationId,
          conversationId: params.conversationId,
          ...(params.personalToken ? { personalToken: params.personalToken } : {}),
          ...(Object.keys(contentUploadAuthByTool).length > 0
            ? { contentUploadAuthByTool }
            : {}),
          ...(orchestratorEntry.maxInlineToolResultBytes !== undefined
            ? { maxInlineToolResultBytes: orchestratorEntry.maxInlineToolResultBytes }
            : {}),
        },
        recursionLimit: orchestratorEntry.recursionLimit ?? 25,
        callbacks,
      },
    );

    const last = result.messages.at(-1);
    if (!last) throw new Error("Agent returned no messages");
    const responseText = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    this.maybeScheduleConversationTitleGeneration({
      graphKey,
      conversationId: params.conversationId,
      userPrompt: params.prompt,
      assistantResponse: responseText,
      disableConversationTitleGeneration: params.disableConversationTitleGeneration,
    });
    return responseText;
  }

  private maybeScheduleConversationTitleGeneration(params: {
    graphKey: string;
    conversationId: string;
    userPrompt: string;
    assistantResponse: string;
    disableConversationTitleGeneration?: boolean;
  }): void {
    if (params.disableConversationTitleGeneration) return;
    if (params.graphKey !== "default") return;
    if (!this.conversationMetadataService) return;

    const hasTitleGraph = Boolean(this.config?.graphs[CONVERSATION_TITLE_GRAPH_KEY]);
    if (!hasTitleGraph) return;

    const userPrompt = params.userPrompt.trim();
    if (!userPrompt) return;

    void this.generateConversationTitle({
      conversationId: params.conversationId,
      userPrompt,
      assistantResponse: params.assistantResponse,
    }).catch((err: unknown) => {
      logger.error(
        `Failed to generate conversation title for conversation "${params.conversationId}"`,
        err,
      );
    });
  }

  private async generateConversationTitle(params: {
    conversationId: string;
    userPrompt: string;
    assistantResponse: string;
  }): Promise<void> {
    if (!this.conversationMetadataService) return;

    const existingTitle = this.conversationMetadataService.getTitle(params.conversationId)?.trim();
    if (existingTitle) return;

    if (this.titleGenerationInFlight.has(params.conversationId)) return;
    this.titleGenerationInFlight.add(params.conversationId);

    try {
      const fallbackTitle = buildFallbackConversationTitle(params.userPrompt);
      const titlePrompt = buildConversationTitlePrompt({
        userPrompt: params.userPrompt,
        assistantResponse: params.assistantResponse,
      });

      let generatedTitle = "";
      try {
        generatedTitle = await this.invokeConfiguredGraph({
          conversationId: params.conversationId,
          prompt: titlePrompt,
          graphKey: CONVERSATION_TITLE_GRAPH_KEY,
          disableConversationTitleGeneration: true,
          observability: { enabled: true },
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.warn(
          `Conversation title graph invocation failed for conversation "${params.conversationId}"; using fallback title (${detail})`,
        );
      }

      const title = normalizeConversationTitle(generatedTitle) ?? fallbackTitle;
      this.conversationMetadataService.upsertTitle(params.conversationId, title);

      // Broadcast the generated title to all channels as a metadata event.
      const allChannels = this.options.channels ?? [];
      const metadataPayload = JSON.stringify({ title });
      for (const channel of allChannels) {
        channel
          .sendMessage({
            conversationId: params.conversationId,
            text: metadataPayload,
            role: "conversation-metadata",
          })
          .catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            logger.warn(`Failed to broadcast conversation title to channel "${channel.name}": ${detail}`);
          });
      }
    } finally {
      this.titleGenerationInFlight.delete(params.conversationId);
    }
  }

  private resolveAgentEntryFromSubgraphProfile(
    agents: Record<string, AgentEntry>,
    profile: SubgraphProfile,
  ): AgentEntry {
    const baseEntry = resolveConfigEntry(agents, profile.agentKey ?? "memory");

    return {
      ...baseEntry,
      ...(profile.modelKey ? { modelKey: profile.modelKey } : {}),
      ...(profile.systemPrompt ? { systemPrompt: profile.systemPrompt } : {}),
      ...(profile.description ? { description: profile.description } : {}),
      ...(profile.tools ? { tools: profile.tools } : {}),
      ...(profile.recursionLimit !== undefined ? { recursionLimit: profile.recursionLimit } : {}),
    };
  }

  private resolveSubgraphProfile(
    subgraphs: Record<string, SubgraphProfile>,
    subgraphKey: string,
  ): SubgraphProfile {
    const profile = subgraphs[subgraphKey];
    if (!profile) {
      throw new Error(
        `Subgraph key "${subgraphKey}" not found. Available: ${Object.keys(subgraphs).join(", ")}`,
      );
    }

    const base = subgraphs["default"];
    if (!base || subgraphKey === "default") return profile;

    return {
      ...base,
      ...profile,
    };
  }

  private resolveCompressionRuntimeConfig(params: {
    allTools: StructuredToolInterface[];
    agentEntry: AgentEntry;
    agentKey: string;
    graphEntry: GraphEntry;
    subgraphs: Record<string, SubgraphProfile>;
  }): CompressionRuntimeConfig | undefined {
    const graphCompressionSubgraphKey = params.graphEntry.subgraphs?.compression?.[params.agentKey];
    const subgraphKey = graphCompressionSubgraphKey ?? params.agentEntry.compressionSubgraph;
    if (!subgraphKey) return undefined;

    const profile = this.resolveSubgraphProfile(params.subgraphs, subgraphKey);
    const compression = profile.compression;
    if (!compression) {
      throw new Error(
        `Compression subgraph "${subgraphKey}" for agent "${params.agentKey}" does not define a compression block`,
      );
    }

    const tool = params.allTools.find((candidate) => candidate.name === compression.tool);
    if (!tool) {
      throw new Error(
        `Compression subgraph "${subgraphKey}" for agent "${params.agentKey}" references unknown tool "${compression.tool}"`,
      );
    }

    return {
      tool,
      toolName: compression.tool,
      mode: compression.mode ?? "research-digest",
      preserveRecentMessages: compression.preserveRecentMessages ?? 6,
      messageCountThreshold: compression.messageCountThreshold ?? 12,
      charThreshold: compression.charThreshold ?? 16000,
      maxDigestChars: compression.maxDigestChars ?? 4000,
    };
  }

  /**
   * Resolve the `{tool-descriptions}` placeholder in a system prompt.
   *
   * Each tool line is formatted as `"- <name>: <description>"` where any
   * `{name}` token inside the tool's own description is first replaced with
   * the tool's name. If the placeholder is absent the prompt is returned
   * unchanged.
   */
  private resolveSystemPrompt(
    systemPrompt: string | undefined,
    tools: StructuredToolInterface[],
  ): string | undefined {
    if (!systemPrompt?.includes("{tool-descriptions}")) return systemPrompt;
    const lines = tools.map((t) => {
      const desc = t.description.replaceAll("{name}", t.name);
      return `- ${t.name}: ${desc}`;
    });
    return systemPrompt.replace("{tool-descriptions}", `\n${lines.join("\n")}\n\n`);
  }

  /**
   * Filter tools by an allow-list of tool names.
   * If `allowedNames` is empty or undefined, all tools are returned.
   */
  private scopeTools(
    allTools: StructuredToolInterface[],
    allowedNames?: string[],
  ): StructuredToolInterface[] {
    if (allowedNames === undefined) return allTools;
    if (allowedNames.length === 0) return [];
    const allowed = new Set(allowedNames);
    return allTools.filter((t) => allowed.has(t.name));
  }

  /**
   * Resolve an agent's effective allow-list from explicit tool names and
   * tools discovered from configured tool server keys.
   */
  private resolveAllowedToolNames(entry: AgentEntry): string[] | undefined {
    const explicit = entry.tools;
    const rawAutoDiscoveryKeys = (entry as Record<string, unknown>)["autoToolDiscovery"];
    const autoDiscoveryKeys = Array.isArray(rawAutoDiscoveryKeys)
      ? rawAutoDiscoveryKeys.filter((value): value is string => typeof value === "string")
      : undefined;

    if (explicit === undefined && autoDiscoveryKeys === undefined) {
      return undefined;
    }

    const resolved = new Set<string>(explicit ?? []);
    for (const serverKey of autoDiscoveryKeys ?? []) {
      const discovered = this.discoveredToolNamesByServer[serverKey] ?? [];
      for (const toolName of discovered) {
        resolved.add(toolName);
      }
    }

    return [...resolved];
  }

  /** Connect to all tool servers declared in tools.json and discover their tools. */
  private async discoverTools(
    toolsConfig: Record<string, ToolServerEntry>,
  ): Promise<StructuredToolInterface[]> {
    const allTools: StructuredToolInterface[] = [getToolPayloadRefTool];
    const imapInstances: ImapRouterInstanceConfig[] = [];
    this.discoveredToolNamesByServer = {};
    this.toolServerStatuses = new Map();

    // Seed registry with the built-in tool payload ref tool so it appears in the catalog.
    this.toolRegistry = [
      {
        name: getToolPayloadRefTool.name,
        description: getToolPayloadRefTool.description,
        parameters: {},
      },
    ];

    const entries = Object.entries(toolsConfig).filter(
      ([, entry]) => entry.enabled !== false,
    );

    // Seed every enabled server as configured-but-not-yet-discovered.
    for (const [name] of entries) {
      this.toolServerStatuses.set(name, { key: name, configured: true, discovered: false, toolNames: [] });
    }

    await Promise.all(
      entries.map(async ([name, entry]): Promise<void> => {
        const startedAt = Date.now();
        try {
          logger.debug(`Tool server "${name}": creating client...`);
          const client = this.createRpcClient(name, entry);
          this.rpcClients.push(client);
          logger.debug(`Tool server "${name}": connecting...`);
          await client.connect();
          logger.debug(`Tool server "${name}": connected, discovering tools...`);
          const metadata = await client.listTools();

          if (entry.imap) {
            imapInstances.push({
              key: name,
              displayName: entry.imap.displayName,
              transport: entry.transport,
              crawlMode: entry.imap.crawl?.mode,
              indexingStrategy: entry.imap.vector?.indexingStrategy,
              indexDbPath: entry.imap.indexDbPath,
              client,
              metadata,
            });
            this.logStartupSubstep("tool-discovery", `server:${name}`, startedAt);
            logger.info(`Tool server "${name}": ${metadata.length} IMAP backend tool(s) discovered`);
            return;
          }

          const tools = await RemoteTool.fromServer(client);
          allTools.push(...tools);
          const toolNames = [...new Set(tools.map((tool) => tool.name))];
          this.discoveredToolNamesByServer[name] = toolNames;
          this.toolRegistry.push(...metadata);
          this.toolServerStatuses.set(name, { key: name, configured: true, discovered: true, toolNames });
          this.logStartupSubstep("tool-discovery", `server:${name}`, startedAt);
          logger.info(`Tool server "${name}": ${tools.length} tool(s) discovered`);
        } catch (err) {
          this.logStartupSubstep("tool-discovery", `server:${name}`, startedAt, false);
          this.discoveredToolNamesByServer[name] = [];
          this.toolServerStatuses.set(name, {
            key: name,
            configured: true,
            discovered: false,
            error: err instanceof Error ? err.message : String(err),
            toolNames: [],
          });
          logger.error(`Failed to connect to tool server "${name}"`, err);
        }
        return;
      })
    );

    if (imapInstances.length > 0) {
      const imapRouter = createImapRouterTools(imapInstances);
      allTools.push(...imapRouter.tools);
      this.toolRegistry.push(...imapRouter.toolDefinitions);
      const imapToolNames = [...imapRouter.toolNames];
      for (const instance of imapInstances) {
        this.discoveredToolNamesByServer[instance.key] = imapToolNames;
        this.toolServerStatuses.set(instance.key, {
          key: instance.key,
          configured: true,
          discovered: true,
          toolNames: imapToolNames,
        });
      }
      logger.info(
        `IMAP router: ${imapRouter.tools.length} canonical tool(s) synthesized across ${imapInstances.length} instance(s)`,
      );
    }

    logger.debug("All tool discovery promises resolved");

    return allTools;
  }

  private async measureStartupPhase<T>(
    phase: string,
    startupPhases: StartupPhaseTiming[],
    action: () => Promise<T> | T,
  ): Promise<T> {
    logger.info(`Startup phase "${phase}": begin`);
    const startedAt = Date.now();
    try {
      const result = await action();
      const durationMs = Date.now() - startedAt;
      const slow = durationMs >= STARTUP_SLOW_STEP_MS;
      startupPhases.push({ phase, durationMs, slow });
      if (slow) {
        logger.warn(`Startup phase "${phase}": complete in ${durationMs}ms [slow]`);
      } else {
        logger.info(`Startup phase "${phase}": complete in ${durationMs}ms`);
      }
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      logger.error(`Startup phase "${phase}": failed after ${durationMs}ms`, err);
      throw err;
    }
  }

  private logStartupSubstep(
    phase: string,
    substep: string,
    startedAt: number,
    ok: boolean = true,
  ): void {
    const durationMs = Date.now() - startedAt;
    const slow = durationMs >= STARTUP_SLOW_STEP_MS;
    const base = `Startup substep "${phase}/${substep}": ${ok ? "complete" : "failed"} in ${durationMs}ms`;
    if (!ok) {
      logger.warn(`${base}${slow ? " [slow]" : ""}`);
      return;
    }
    if (slow) {
      logger.warn(`${base} [slow]`);
      return;
    }
    logger.info(base);
  }

  private logStartupSummary(startupStartedAt: number, startupPhases: StartupPhaseTiming[]): void {
    const totalDurationMs = Date.now() - startupStartedAt;
    const slowPhases = startupPhases
      .filter((phase) => phase.slow)
      .sort((a, b) => b.durationMs - a.durationMs);

    if (slowPhases.length === 0) {
      logger.info(`Startup summary: total ${totalDurationMs}ms; no slow phases (threshold=${STARTUP_SLOW_STEP_MS}ms)`);
      return;
    }

    const slowPhaseSummary = slowPhases
      .map((phase) => `${phase.phase}=${phase.durationMs}ms`)
      .join(", ");
    logger.warn(
      `Startup summary: total ${totalDurationMs}ms; slow phases (threshold=${STARTUP_SLOW_STEP_MS}ms): ${slowPhaseSummary}`,
    );
  }

  private createRpcClient(name: string, entry: ToolServerEntry): RpcClient {
    switch (entry.transport) {
      case "http":
        if (!entry.url) throw new Error(`Tool server "${name}" (http) requires a "url" field`);
        return new HttpRpcClient(entry.url);
      case "unix-socket":
        if (!entry.socketName) throw new Error(`Tool server "${name}" (unix-socket) requires a "socketName" field`);
        return new UnixSocketRpcClient(entry.socketName);
      default:
        throw new Error(`Unknown transport "${entry.transport as string}" for tool server "${name}"`);
    }
  }

  /**
   * Derive agent capability entries from the loaded config so the Admin API
   * can serve `GET /api/agents/capabilities`.
   */
  private buildAgentCapabilities(config: GloveConfig): AgentCapabilityEntry[] {
    const agents = config.agents as Record<string, AgentEntry>;
    return Object.entries(agents).map(([key, entry]) => ({
      key,
      description: entry.description ?? key,
      modelKey: entry.modelKey ?? "default",
      // `undefined` means no restriction (all tools); empty array means none.
      tools: this.resolveAllowedToolNames(entry) ?? null,
    }));
  }

  private resolveContentItemsFromToolOutput(content: string): OutgoingContentItem[] | undefined {
    const refs = extractContentRefs(content);
    if (refs.length === 0) return undefined;
    if (!this.contentStore) return undefined;

    const items: OutgoingContentItem[] = [];
    for (const contentRef of refs) {
      const meta = this.contentStore.getContentMetadata(contentRef);
      if (!meta) continue;
      items.push({
        contentRef,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        byteLength: meta.byteLength,
        downloadPath: `/api/content/${encodeURIComponent(contentRef)}/download`,
        previewPath: `/api/content/${encodeURIComponent(contentRef)}/preview`,
      });
    }

    return items.length > 0 ? items : undefined;
  }

  private async handleContentRpcRequest(request: RpcRequest): Promise<RpcResponse> {
    if (!this.contentStore) {
      return { id: request.id, error: "Content store is not initialized" };
    }

    const params = request.params ?? {};
    const readString = (key: string): string | undefined =>
      typeof params[key] === "string" ? (params[key] as string) : undefined;
    const readNumber = (key: string): number | undefined => {
      const value = params[key];
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    };

    const token = readString("token");
    if (!token) {
      return { id: request.id, error: "Missing content upload token" };
    }

    const claims = this.contentUploadTokenService.validate(token);
    if (!claims) {
      return { id: request.id, error: "Invalid or expired content upload token" };
    }

    try {
      switch (request.method) {
        case "__content_upload_init__": {
          const expectedBytes = readNumber("expectedBytes");
          const uploadId = randomUUID();
          const contentRef = `content_${randomUUID()}`;

          this.contentStore.createUploadSession({
            uploadId,
            contentRef,
            conversationId: claims.conversationId,
            toolName: claims.toolName,
            fileName: readString("fileName"),
            mimeType: readString("mimeType"),
            expectedBytes,
            systemPromptText: readString("systemPromptText"),
            systemPromptHash: readString("systemPromptHash"),
            expiresAt: claims.expiresAt,
          });

          return {
            id: request.id,
            result: {
              uploadId,
              contentRef,
              expiresAt: claims.expiresAt,
            },
          };
        }
        case "__content_upload_chunk__": {
          const uploadId = readString("uploadId");
          const chunkIndex = readNumber("chunkIndex");
          const dataBase64 = readString("dataBase64");
          if (!uploadId || chunkIndex === undefined || !dataBase64) {
            return {
              id: request.id,
              error: "uploadId, chunkIndex, and dataBase64 are required",
            };
          }

          const session = this.contentStore.getUploadSession(uploadId);
          if (!session) {
            return { id: request.id, error: "Unknown upload session" };
          }
          if (session.conversationId !== claims.conversationId || session.toolName !== claims.toolName) {
            return { id: request.id, error: "Upload session does not match token scope" };
          }

          const chunkBuffer = Buffer.from(dataBase64, "base64");
          const receivedBytes = this.contentStore.appendUploadChunk(uploadId, chunkIndex, chunkBuffer);
          return {
            id: request.id,
            result: {
              uploadId,
              receivedBytes,
            },
          };
        }
        case "__content_upload_finalize__": {
          const uploadId = readString("uploadId");
          if (!uploadId) {
            return { id: request.id, error: "uploadId is required" };
          }

          const session = this.contentStore.getUploadSession(uploadId);
          if (!session) {
            return { id: request.id, error: "Unknown upload session" };
          }
          if (session.conversationId !== claims.conversationId || session.toolName !== claims.toolName) {
            return { id: request.id, error: "Upload session does not match token scope" };
          }

          const metadata = this.contentStore.finalizeUploadSession(uploadId, readString("sha256"));
          return {
            id: request.id,
            result: {
              uploadId,
              contentRef: metadata.contentRef,
              byteLength: metadata.byteLength,
              mimeType: metadata.mimeType,
              fileName: metadata.fileName,
            },
          };
        }
        case "__content_upload_abort__": {
          const uploadId = readString("uploadId");
          if (!uploadId) {
            return { id: request.id, error: "uploadId is required" };
          }

          const session = this.contentStore.getUploadSession(uploadId);
          if (!session) {
            return { id: request.id, error: "Unknown upload session" };
          }
          if (session.conversationId !== claims.conversationId || session.toolName !== claims.toolName) {
            return { id: request.id, error: "Upload session does not match token scope" };
          }

          this.contentStore.abortUploadSession(uploadId);
          return {
            id: request.id,
            result: { uploadId, aborted: true },
          };
        }
        default:
          return { id: request.id, error: `Unknown internal content RPC method: ${request.method}` };
      }
    } catch (err) {
      return {
        id: request.id,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private resolveGatewayPublicBaseUrl(): string {
    const configured = this.config?.gateway.publicBaseUrl?.trim();
    if (configured) return configured.replace(/\/$/, "");

    const host = this.config?.gateway.apiHost ?? "127.0.0.1";
    const safeHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const port = this.config?.gateway.apiPort ?? 8081;
    return `http://${safeHost}:${port}`;
  }

  private resolveToolServerEntryForTool(toolName: string): ToolServerEntry | undefined {
    if (!this.config) return undefined;

    for (const [serverKey, toolNames] of Object.entries(this.discoveredToolNamesByServer)) {
      if (!toolNames.includes(toolName)) continue;
      const entry = this.config.tools[serverKey] as ToolServerEntry | undefined;
      if (entry && entry.enabled !== false) {
        return entry;
      }
    }

    return undefined;
  }

  private buildContentUploadAuthByTool(conversationId: string): Record<string, ContentUploadAuthPayload> {
    const authByTool: Record<string, ContentUploadAuthPayload> = {};
    const ttlSeconds = this.config?.gateway.contentUploadTokenTtlSeconds ?? 300;
    const gatewayBaseUrl = this.resolveGatewayPublicBaseUrl();

    for (const tool of this.toolRegistry) {
      if (!tool.supportsContentUpload) continue;

      const serverEntry = this.resolveToolServerEntryForTool(tool.name);
      if (!serverEntry) continue;

      const issued = this.contentUploadTokenService.issue(
        {
          conversationId,
          toolName: tool.name,
        },
        ttlSeconds,
      );

      authByTool[tool.name] = {
        token: issued.token,
        expiresAt: issued.expiresAt,
        transport: serverEntry.transport,
        ...(serverEntry.transport === "http"
          ? { gatewayBaseUrl }
          : { socketName: process.env["GLOVE_GATEWAY_CONTENT_UPLOAD_SOCKET"] ?? "gateway_content_upload" }),
      };
    }

    return authByTool;
  }

  /**
   * Log a startup summary of configured tools that were not discovered.
   *
   * This highlights provider/tool outages early so operators can correlate
   * missing capabilities with runtime behavior.
   */
  private reportUnavailableConfiguredTools(
    config: GloveConfig,
    discoveredTools: StructuredToolInterface[],
  ): void {
    const discoveredNames = new Set(discoveredTools.map((tool) => tool.name));
    const agents = config.agents as Record<string, AgentEntry>;

    const missingByAgent = Object.entries(agents)
      .map(([agentKey, entry]) => {
        const configured = this.resolveAllowedToolNames(entry) ?? [];
        const missing = configured.filter((toolName) => !discoveredNames.has(toolName));
        return { agentKey, missing };
      })
      .filter((row) => row.missing.length > 0);

    if (missingByAgent.length === 0) {
      logger.info("All configured agent tools are available at startup");
      return;
    }

    const missingUnique = [...new Set(missingByAgent.flatMap((row) => row.missing))].sort();
    logger.warn(
      `Unavailable configured tools at startup (${missingUnique.length}): ${missingUnique.join(", ")}`,
    );
    for (const row of missingByAgent) {
      logger.warn(`  Agent "${row.agentKey}" missing tools: ${row.missing.join(", ")}`);
    }
  }

  private installSignalHandlers(): void {
    const shutdown = (signal: NodeJS.Signals) => {
      if (this.shutdownSignal) {
        logger.warn(`Received ${signal} while shutdown from ${this.shutdownSignal} is still in progress; forcing exit`);
        process.exit(1);
      }

      this.shutdownSignal = signal;
      const forceExitTimer = setTimeout(() => {
        logger.error(`Timed out while shutting down after ${signal}; forcing exit`);
        process.exit(1);
      }, 10_000);
      forceExitTimer.unref();

      this.stop()
        .then(() => {
          clearTimeout(forceExitTimer);
          process.exit(0);
        })
        .catch((err) => {
          clearTimeout(forceExitTimer);
          logger.error("Error during shutdown", err);
          process.exit(1);
        });
    };

    const onSIGINT = () => { logger.info("Received SIGINT"); shutdown("SIGINT"); };
    const onSIGTERM = () => { logger.info("Received SIGTERM"); shutdown("SIGTERM"); };

    process.on("SIGINT", onSIGINT);
    process.on("SIGTERM", onSIGTERM);

    this.shutdownHandlers.push(
      () => process.removeListener("SIGINT", onSIGINT),
      () => process.removeListener("SIGTERM", onSIGTERM),
    );
  }
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractContentRefs(value: unknown): string[] {
  const refs = new Set<string>();

  const collect = (input: unknown): void => {
    if (!input) return;

    if (typeof input === "string") {
      const trimmed = input.trim();
      if (/^content_[a-f0-9-]+$/i.test(trimmed)) {
        refs.add(trimmed);
      }
      const parsed = parseJsonMaybe(trimmed);
      if (parsed !== input) {
        collect(parsed);
      }
      return;
    }

    if (Array.isArray(input)) {
      for (const item of input) collect(item);
      return;
    }

    if (typeof input === "object") {
      const record = input as Record<string, unknown>;
      if (typeof record["contentRef"] === "string") {
        refs.add(record["contentRef"] as string);
      }
      if (Array.isArray(record["contentRefs"])) {
        for (const ref of record["contentRefs"] as unknown[]) {
          if (typeof ref === "string") refs.add(ref);
        }
      }
      for (const nested of Object.values(record)) {
        collect(nested);
      }
    }
  };

  collect(value);
  return [...refs];
}

function normalizeConversationTitle(value: string): string | undefined {
  const trimmed = value.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!trimmed) return undefined;
  const singleLine = trimmed.replace(/\s+/g, " ");
  if (!singleLine) return undefined;
  if (singleLine.length <= CONVERSATION_TITLE_MAX_CHARS) return singleLine;
  return `${singleLine.slice(0, CONVERSATION_TITLE_MAX_CHARS - 1)}...`;
}

function buildFallbackConversationTitle(userPrompt: string): string {
  const cleaned = userPrompt.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled conversation";
  if (cleaned.length <= CONVERSATION_TITLE_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, CONVERSATION_TITLE_MAX_CHARS - 1)}...`;
}

function buildConversationTitlePrompt(params: {
  userPrompt: string;
  assistantResponse: string;
}): string {
  const assistantSnippet = params.assistantResponse.trim().slice(0, 1000);
  return [
    "Generate a concise title for this conversation.",
    "Return only the title text.",
    "",
    `User: ${params.userPrompt.trim()}`,
    `Assistant: ${assistantSnippet}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Health HTTP server
// ---------------------------------------------------------------------------

export class HealthServer {
  private server: Server | null = null;

  constructor(private readonly gateway: Gateway) {}

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const app = express();

      app.get("/health", (_req, res) => {
        const state = this.gateway.state;
        const status = state === "running" ? 200 : 503;
        res.status(status).json({ status: state, timestamp: new Date().toISOString() });
      });

      this.server = app.listen(port, host, () => resolve());
      this.server.once("error", reject);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
