import { EventEmitter } from "node:events";
import express from "express";
import type { Server } from "node:http";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  ConfigLoader,
  ModelRegistry,
  ModelHealthChecker,
  resolveConfigEntry,
  type GloveConfig,
  type AgentEntry,
  type ToolServerEntry,
  type ModelHealthResult,
} from "@langgraph-glove/config";
import { GloveAgent } from "../agent/Agent";
import { buildSingleAgentGraph, buildOrchestratorGraph, type SubAgentDef } from "../agent/graphs";
import { Logger } from "../logging/Logger";
import { LogService } from "../logging/LogService";
import { HttpRpcClient } from "../rpc/HttpRpcClient";
import { UnixSocketRpcClient } from "../rpc/UnixSocketRpcClient";
import type { RpcClient } from "../rpc/RpcClient";
import { RemoteTool } from "../tools/RemoteTool";
import { getToolPayloadRefTool } from "../tools/ToolPayloadRefTool";
import { AdminApi } from "../api/AdminApi";
import { AuthService } from "../auth/AuthService";
import type { Channel } from "../channels/Channel";
import { WebChannel } from "../channels/WebChannel";

const logger = new Logger("Gateway");

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
  private shutdownHandlers: (() => void)[] = [];

  constructor(private readonly options: GatewayOptions) {
    super();
  }

  get state(): GatewayState {
    return this._state;
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
      // 1. Config + secrets
      logger.info("Loading configuration...");
      this.configLoader = new ConfigLoader(
        this.options.configDir,
        this.options.secretsDir,
      );
      this.config = this.configLoader.load();
      LogService.addRedactions(this.configLoader.secrets.values);
      logger.info("Configuration loaded");

      // 2. Model registry
      this.models = new ModelRegistry(this.config.models);

      // 3. Model health checks — probe only models used by configured agents
      const modelHealth = await this.checkModelHealth(this.models, this.config);
      this.updateWebChannelModelInfo(this.config, modelHealth);

      // 4. Persistence
      const dbPath = this.config.gateway.dbPath ?? "data/checkpoints.sqlite";
      this.checkpointer = SqliteSaver.fromConnString(dbPath);
      logger.info(`SQLite persistence: ${dbPath}`);

      // 5. Auth bootstrap
      this.authService = new AuthService({
        dbPath,
        config: this.config.gateway.auth,
      });
      const setupToken = this.authService.ensureBootstrapToken();
      if (setupToken) {
        logger.warn("Initial setup is required.");
        logger.warn("Use this setup token in the web UI to create your password:");
        logger.warn(`Setup token (expires ${setupToken.expiresAt}): ${setupToken.token}`);
        logger.warn("You can regenerate it with: pnpm --filter @langgraph-glove/core debug -- --regenerate-setup-token");
      }

      // 6. Tool discovery
      const tools = await this.discoverTools(this.config.tools);
      logger.info(`Discovered ${tools.length} tool(s) from ${Object.keys(this.config.tools).length} server(s)`);

      // 7. Build agent graph (single-agent or multi-agent orchestrator)
      const graph = this.buildAgentGraph(tools);

      this.agent = new GloveAgent(graph, {
        recursionLimit: resolveConfigEntry(
          this.config.agents as Record<string, AgentEntry>,
          "default",
        ).recursionLimit,
      });

      // 8. Channels
      // Inject the auth service into any channel that supports it — this
      // gates WebSocket upgrades behind the session token check.
      for (const ch of this.options.channels ?? []) {
        if (typeof (ch as unknown as { setAuthService?: unknown }).setAuthService === "function") {
          (ch as unknown as { setAuthService: (svc: AuthService) => void }).setAuthService(
            this.authService,
          );
        }
      }
      for (const channel of this.options.channels ?? []) {
        this.agent.addChannel(channel);
      }
      await this.agent.start();
      logger.info("Agent and channels started");

      // 9. Health server
      const healthPort = this.config.gateway.healthPort ?? 9090;
      const healthHost = this.config.gateway.healthHost ?? "0.0.0.0";
      this.healthServer = new HealthServer(this);
      await this.healthServer.listen(healthPort, healthHost);
      logger.info(`Health endpoint: http://${healthHost}:${healthPort}/health`);

      // 10. Admin API
      const apiPort = this.config.gateway.apiPort ?? 8081;
      const apiHost = this.config.gateway.apiHost ?? "0.0.0.0";
      this.adminApi = new AdminApi({
        port: apiPort,
        host: apiHost,
        dbPath: this.config.gateway.dbPath,
        authService: this.authService,
        toolsConfig: this.config.tools as Record<string, ToolServerEntry>,
      });
      await this.adminApi.listen();
      logger.info(`Admin API: http://${apiHost}:${apiPort}/api/conversations`);

      // 11. Signal handlers
      this.installSignalHandlers();

      this.setState("running");
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

    logger.info(`Model health checks: probing [${[...usedKeys].join(", ")}]…`);
    const checker = new ModelHealthChecker(models);
    const results = await checker.checkKeys([...usedKeys]);

    for (const result of results) {
      if (result.ok) {
        const contextPart = result.contextWindowTokens
          ? `, ctx=${result.contextWindowTokens}${result.contextWindowSource ? ` (${result.contextWindowSource})` : ""}`
          : "";
        logger.info(`  ✓ ${result.key} (${result.latencyMs}ms${contextPart})`);
      } else {
        const contextPart = result.contextWindowTokens
          ? `, ctx=${result.contextWindowTokens}${result.contextWindowSource ? ` (${result.contextWindowSource})` : ""}`
          : "";
        logger.warn(`  ✗ ${result.key} — ${result.error ?? "unknown error"} (${result.latencyMs}ms${contextPart})`);
      }
    }

    return results;
  }

  private updateWebChannelModelInfo(
    config: GloveConfig,
    modelHealth: ModelHealthResult[],
  ): void {
    const agents = config.agents as Record<string, AgentEntry>;
    const defaultEntry = resolveConfigEntry(agents, "default");
    const defaultModelKey = defaultEntry.modelKey ?? "default";
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
   * Build the appropriate LangGraph graph based on agents.json:
   * - If only "default" agent → single-agent ReAct graph
   * - If multiple agents → orchestrator graph with sub-agents
   */
  private buildAgentGraph(allTools: StructuredToolInterface[]) {
    const agents = this.config!.agents as Record<string, AgentEntry>;
    const models = this.models!;
    const checkpointer = this.checkpointer!;

    const subAgentKeys = Object.keys(agents).filter((k) => k !== "default");
    const defaultEntry = resolveConfigEntry(agents, "default");

    if (subAgentKeys.length === 0) {
      // Single-agent mode — standard ReAct loop
      const model = models.get(defaultEntry.modelKey ?? "default");
      const scopedTools = this.scopeTools(allTools, defaultEntry.tools);
      logger.info(`Single-agent mode (${scopedTools.length} tools)`);

      return buildSingleAgentGraph({
        model,
        tools: scopedTools,
        systemPrompt: this.resolveSystemPrompt(defaultEntry.systemPrompt, scopedTools),
        checkpointer,
      });
    }

    // Multi-agent orchestrator mode
    const subAgents: SubAgentDef[] = subAgentKeys.map((key) => {
      const entry = resolveConfigEntry(agents, key);
      const scopedTools = this.scopeTools(allTools, entry.tools);
      return {
        name: key,
        description: entry.description ?? key,
        model: models.get(entry.modelKey ?? "default"),
        tools: scopedTools,
        systemPrompt: this.resolveSystemPrompt(entry.systemPrompt, scopedTools),
      };
    });

    const orchestratorModel = models.get(defaultEntry.modelKey ?? "default");
    const orchestratorTools = this.scopeTools(allTools, defaultEntry.tools);

    logger.info(
      `Multi-agent orchestrator mode: ${subAgents.length} sub-agent(s) [${subAgentKeys.join(", ")}]`,
    );

    return buildOrchestratorGraph({
      orchestrator: {
        model: orchestratorModel,
        systemPrompt: this.resolveSystemPrompt(defaultEntry.systemPrompt, orchestratorTools),
        tools: orchestratorTools.length > 0 ? orchestratorTools : undefined,
      },
      subAgents,
      checkpointer,
    });
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

  /** Connect to all tool servers declared in tools.json and discover their tools. */
  private async discoverTools(
    toolsConfig: Record<string, ToolServerEntry>,
  ): Promise<StructuredToolInterface[]> {
    const allTools: StructuredToolInterface[] = [getToolPayloadRefTool];

    const entries = Object.entries(toolsConfig).filter(
      ([, entry]) => entry.enabled !== false,
    );

    await Promise.all(
      entries.map(async ([name, entry]): Promise<void> => {
        try {
          logger.debug(`Tool server "${name}": creating client...`);
          const client = this.createRpcClient(name, entry);
          this.rpcClients.push(client);
          logger.debug(`Tool server "${name}": connecting...`);
          await client.connect();
          logger.debug(`Tool server "${name}": connected, discovering tools...`);
          const tools = await RemoteTool.fromServer(client);
          allTools.push(...tools);
          logger.info(`Tool server "${name}": ${tools.length} tool(s) discovered`);
        } catch (err) {
          logger.error(`Failed to connect to tool server "${name}"`, err);
        }
        return;
      })
    );

    logger.debug("All tool discovery promises resolved");

    return allTools;
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

  private installSignalHandlers(): void {
    const shutdown = () => {
      this.stop().catch((err) => {
        logger.error("Error during shutdown", err);
        process.exit(1);
      });
    };

    const onSIGINT = () => { logger.info("Received SIGINT"); shutdown(); };
    const onSIGTERM = () => { logger.info("Received SIGTERM"); shutdown(); };

    process.on("SIGINT", onSIGINT);
    process.on("SIGTERM", onSIGTERM);

    this.shutdownHandlers.push(
      () => process.removeListener("SIGINT", onSIGINT),
      () => process.removeListener("SIGTERM", onSIGTERM),
    );
  }
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
