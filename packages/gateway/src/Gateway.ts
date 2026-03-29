import { EventEmitter } from "node:events";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  ConfigLoader,
  ModelRegistry,
  resolveConfigEntry,
  type GloveConfig,
  type AgentEntry,
  type ToolServerEntry,
} from "@langgraph-glove/config";
import {
  GloveAgent,
  Logger,
  LogService,
  HttpRpcClient,
  UnixSocketRpcClient,
  RemoteTool,
  type RpcClient,
  type Channel,
} from "@langgraph-glove/core";

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
      logger.info("Loading configuration…");
      this.configLoader = new ConfigLoader(
        this.options.configDir,
        this.options.secretsDir,
      );
      this.config = this.configLoader.load();
      LogService.addRedactions(this.configLoader.secrets.values);
      logger.info("Configuration loaded");

      // 2. Model registry
      this.models = new ModelRegistry(this.config.models);

      // 3. Persistence
      const dbPath = this.config.gateway.dbPath ?? "data/checkpoints.sqlite";
      this.checkpointer = SqliteSaver.fromConnString(dbPath);
      logger.info(`SQLite persistence: ${dbPath}`);

      // 4. Tool discovery
      const tools = await this.discoverTools(this.config.tools);
      logger.info(`Discovered ${tools.length} tool(s) from ${Object.keys(this.config.tools).length} server(s)`);

      // 5. Agent
      const agentEntry = resolveConfigEntry(
        this.config.agents as Record<string, AgentEntry>,
        "default",
      );
      const model = this.models.get(agentEntry.modelKey ?? "default");

      this.agent = new GloveAgent(model, tools, {
        systemPrompt: agentEntry.systemPrompt,
        recursionLimit: agentEntry.recursionLimit,
        checkpointer: this.checkpointer,
      });

      // 6. Channels
      for (const channel of this.options.channels ?? []) {
        this.agent.addChannel(channel);
      }
      await this.agent.start();
      logger.info("Agent and channels started");

      // 7. Health server
      const healthPort = this.config.gateway.healthPort ?? 9090;
      const healthHost = this.config.gateway.healthHost ?? "0.0.0.0";
      this.healthServer = new HealthServer(this);
      await this.healthServer.listen(healthPort, healthHost);
      logger.info(`Health endpoint: http://${healthHost}:${healthPort}/health`);

      // 8. Signal handlers
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
    logger.info("Gateway shutting down…");

    // Remove signal handlers
    for (const cleanup of this.shutdownHandlers) cleanup();
    this.shutdownHandlers = [];

    // Stop health server
    if (this.healthServer) {
      await this.healthServer.close();
      this.healthServer = null;
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

  /** Connect to all tool servers declared in tools.json and discover their tools. */
  private async discoverTools(
    toolsConfig: Record<string, ToolServerEntry>,
  ): Promise<StructuredToolInterface[]> {
    const allTools: StructuredToolInterface[] = [];

    const entries = Object.entries(toolsConfig).filter(
      ([, entry]) => entry.enabled !== false,
    );

    await Promise.all(
      entries.map(async ([name, entry]) => {
        try {
          const client = this.createRpcClient(name, entry);
          this.rpcClients.push(client);
          await client.connect();
          const tools = await RemoteTool.fromServer(client);
          allTools.push(...tools);
          logger.info(`Tool server "${name}": ${tools.length} tool(s) discovered`);
        } catch (err) {
          logger.error(`Failed to connect to tool server "${name}"`, err);
        }
      }),
    );

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

import express from "express";
import type { Server } from "node:http";

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
