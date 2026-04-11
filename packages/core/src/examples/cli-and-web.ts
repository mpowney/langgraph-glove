/**
 * Dual-channel entry point: CLI + Web (WebSocket) running simultaneously.
 *
 * Configuration is loaded from the project-level `config/` and `secrets/`
 * directories. See `config/models.json` for model provider setup.
 *
 * Web channel:
 *   WEB_PORT=8080  (optional, default 8080)
 *   WEB_HOST=0.0.0.0  (optional)
 *   Browser UI:  http://localhost:8080
 *   WebSocket:   ws://localhost:8080
 *
 * Tool servers (start all three before running this):
 *   cd packages/tool-weather-au && RPC_MODE=http PORT=3001 node dist/main.js
 *   cd packages/tool-weather-eu && RPC_MODE=http PORT=3002 node dist/main.js
 *   cd packages/tool-weather-us && node dist/main.js
 *   (US tool listens on /tmp/langgraph-glove-weather_us.sock)
 *
 * Then run:
 *   cd packages/core && node dist/examples/cli-and-web.js
 *
 * Override HTTP URLs:
 *   WEATHER_AU_URL=http://localhost:3001
 *   WEATHER_EU_URL=http://localhost:3002
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { GloveAgent } from "../agent/Agent";
import { buildSingleAgentGraph } from "../agent/graphs";
import { CliChannel } from "../channels/CliChannel";
import { WebChannel } from "../channels/WebChannel";
import { HttpRpcClient } from "../rpc/HttpRpcClient";
import { UnixSocketRpcClient } from "../rpc/UnixSocketRpcClient";
import { RemoteTool } from "../tools/RemoteTool";
import { LogService, ConsoleSubscriber, FileSubscriber, LogLevel } from "../logging/index";
import { ConfigLoader, ModelRegistry, resolveConfigEntry } from "@langgraph-glove/config";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { AgentEntry } from "@langgraph-glove/config";

// ---------------------------------------------------------------------------
// Project root (two levels up from packages/core/src/examples/)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..", "..", "..");
const configDir = path.join(projectRoot, "config");
const secretsDir = path.join(projectRoot, "secrets");

// ---------------------------------------------------------------------------
// Config + Secrets
// ---------------------------------------------------------------------------

const loader = new ConfigLoader(configDir, secretsDir);
const config = loader.load();

// ---------------------------------------------------------------------------
// Logging (register secret redactions before any logging occurs)
// ---------------------------------------------------------------------------

LogService.addRedactions(loader.secrets.values);
LogService.subscribe(new ConsoleSubscriber(LogLevel.INFO));

if (process.env["LOG_FILE"]) {
  LogService.subscribe(new FileSubscriber(LogLevel.DEBUG));
}

// ---------------------------------------------------------------------------
// Model Registry + Persistence
// ---------------------------------------------------------------------------

const models = new ModelRegistry(config.models);

const dbPath = path.join(projectRoot, "data", "checkpoints.sqlite");
const checkpointer = SqliteSaver.fromConnString(dbPath);

// ---------------------------------------------------------------------------
// RPC clients — HTTP for AU/EU, Unix socket for US
// ---------------------------------------------------------------------------

const auClient = new HttpRpcClient(process.env["WEATHER_AU_URL"] ?? "http://localhost:3001");
const euClient = new HttpRpcClient(process.env["WEATHER_EU_URL"] ?? "http://localhost:3002");
const usClient = new UnixSocketRpcClient("weather_us");

await Promise.all([auClient.connect(), euClient.connect(), usClient.connect()]);

// ---------------------------------------------------------------------------
// Remote tools — discovered automatically from each server via introspection
// ---------------------------------------------------------------------------

const [auTools, euTools, usTools] = await Promise.all([
  RemoteTool.fromServer(auClient),
  RemoteTool.fromServer(euClient),
  RemoteTool.fromServer(usClient),
]);
const tools = [...auTools, ...euTools, ...usTools];

// ---------------------------------------------------------------------------
// Agent (config-driven)
// ---------------------------------------------------------------------------

const agentEntry = resolveConfigEntry(
  config.agents as Record<string, AgentEntry>,
  "default",
);
const model = models.get(agentEntry.modelKey);

const graph = buildSingleAgentGraph({
  model,
  tools,
  systemPrompt: agentEntry.systemPrompt,
  checkpointer,
});
const agent = new GloveAgent(graph, {
  recursionLimit: agentEntry.recursionLimit,
});

// ---------------------------------------------------------------------------
// Channels — CLI for terminal interaction, Web for socket/browser testing
// ---------------------------------------------------------------------------

const webPort = parseInt(process.env["WEB_PORT"] ?? "8080", 10);
const webHost = process.env["WEB_HOST"] ?? "0.0.0.0";

agent
  .addChannel(new CliChannel())
  .addChannel(
    new WebChannel({
      port: webPort,
      host: webHost,
      receiveAgentProcessing: true,
      receiveSystem: true,
    }),
  );

await agent.start();
