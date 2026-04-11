import { EventEmitter } from "node:events";
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
import type { ToolDefinition, AgentCapabilityEntry } from "../rpc/RpcProtocol";
import type { ToolEventMetadata } from "../rpc/RpcProtocol";
import { LlmCallbackHandler } from "../logging/LlmCallbackHandler";
import { resolveToolName } from "../agent/toolNameUtils.js";

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

  /** Discovered tool definitions, populated after `discoverTools()`. */
  private toolRegistry: ToolDefinition[] = [];
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
      this.discoveredTools = tools;
      logger.info(`Discovered ${tools.length} tool(s) from ${Object.keys(this.config.tools).length} server(s)`);
      this.reportUnavailableConfiguredTools(this.config, tools);

      // 7. Build agent graph (single-agent or multi-agent orchestrator) using graphs.json "default" key
      const graph = this.buildAgentGraph(tools, "default");

      // Populate agent capability list from resolved agent config
      this.agentCapabilities = this.buildAgentCapabilities(this.config);

      const defaultGraphEntry = this.config.graphs["default"] ?? DEFAULT_GRAPH_ENTRY;
      const orchestratorEntry = resolveConfigEntry(
        this.config.agents as Record<string, AgentEntry>,
        defaultGraphEntry.orchestratorAgentKey,
      );
      this.agent = new GloveAgent(graph, {
        recursionLimit: orchestratorEntry.recursionLimit,
        toolLookup: (name) => this.toolRegistry.find((t) => t.name === name),
        authService: this.authService ?? undefined,
        graphInfo: {
          graphKey: "default",
          mode: (defaultGraphEntry.subAgentKeys?.length ?? 0) > 0 ? "multi-agent" : "single-agent",
          orchestratorAgentKey: defaultGraphEntry.orchestratorAgentKey,
          subAgentKeys: defaultGraphEntry.subAgentKeys ?? [],
        },
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
        toolRegistry: this.toolRegistry,
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
  ) {
    const agents = this.config!.agents as Record<string, AgentEntry>;
    const resolvedGraphEntry = this.config!.graphs[graphKey];
    if (!resolvedGraphEntry) {
      logger.warn(
        `Graph key "${graphKey}" not found in graphs.json — falling back to default graph entry (orchestrator: "default", no sub-agents)`,
      );
    }
    const graphEntry: GraphEntry = resolvedGraphEntry ?? DEFAULT_GRAPH_ENTRY;
    const models = this.models!;
    const checkpointer = this.checkpointer!;

    const orchestratorKey = graphEntry.orchestratorAgentKey;
    const subAgentKeys = graphEntry.subAgentKeys ?? [];
    const orchestratorEntry = resolveConfigEntry(agents, orchestratorKey);

    if (subAgentKeys.length === 0) {
      // Single-agent mode — standard ReAct loop
      const model = models.get(orchestratorEntry.modelKey ?? "default");
      const scopedTools = this.scopeTools(allTools, orchestratorEntry.tools);
      logger.info(`Graph "${graphKey}": single-agent mode (${scopedTools.length} tools)`);

      return buildSingleAgentGraph({
        model,
        tools: scopedTools,
        systemPrompt: this.resolveSystemPrompt(orchestratorEntry.systemPrompt, scopedTools),
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

    const orchestratorModel = models.get(orchestratorEntry.modelKey ?? "default");
    const orchestratorTools = this.scopeTools(allTools, orchestratorEntry.tools);

    logger.info(
      `Graph "${graphKey}": multi-agent orchestrator mode with ${subAgents.length} sub-agent(s) [${subAgentKeys.join(", ")}]`,
    );

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
    ): void => {
      if (!observabilityEnabled) return;
      for (const channel of targets) {
        channel
          .sendMessage({
            conversationId: observabilityConversationId,
            text,
            role,
            ...(toolEventMetadata ? { toolEventMetadata } : {}),
          })
          .catch((err: unknown) =>
            logger.error(`Failed to send observability message to channel "${channel.name}"`, err),
          );
      }
    };

    if (observabilityEnabled) {
      sendObservability(
        "graph-definition",
        JSON.stringify(
          {
            type: "graph-info",
            graphName: graphKey,
            graph: {
              graphKey,
              mode: graphKey === "default" ? "single-agent" : "multi-agent",
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
            _metadata,
            runName,
            toolCallId,
          ): void => {
            const toolName = resolveToolName(
              typeof runName === "string" ? runName : undefined,
              tool,
              typeof toolCallId === "string" ? toolCallId : undefined,
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
            sendObservability("tool-result", JSON.stringify({ name: toolName, content }), meta);
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
      return this.agent.invoke(
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
        },
      );
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
        },
        recursionLimit: orchestratorEntry.recursionLimit ?? 25,
        callbacks,
      },
    );

    const last = result.messages.at(-1);
    if (!last) throw new Error("Agent returned no messages");
    return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
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
          // Also capture raw metadata for the registry so the UI can read parameter schemas.
          const metadata = await client.listTools();
          this.toolRegistry.push(...metadata);
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
      tools: entry.tools === undefined ? null : entry.tools,
    }));
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
        const configured = entry.tools ?? [];
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
