/**
 * Dual-channel entry point: CLI + Web (WebSocket) running simultaneously.
 *
 * Useful for testing: interact with the agent via the terminal while also
 * connecting a WebSocket client (or opening the browser UI) on the same
 * agent instance.
 *
 * LLM backend is selected via LLM_PROVIDER ("openai" | "ollama", default: openai).
 *
 * OpenAI prerequisites:
 *   OPENAI_API_KEY=sk-...  (required)
 *   OPENAI_MODEL=gpt-4o-mini  (optional)
 *
 * Ollama prerequisites:
 *   LLM_PROVIDER=ollama
 *   OLLAMA_URL=http://localhost:11434  (optional, this is the default)
 *   OLLAMA_MODEL=llama3.2  (optional, this is the default)
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

import { GloveAgent } from "../agent/Agent.js";
import { CliChannel } from "../channels/CliChannel.js";
import { WebChannel } from "../channels/WebChannel.js";
import { HttpRpcClient } from "../rpc/HttpRpcClient.js";
import { UnixSocketRpcClient } from "../rpc/UnixSocketRpcClient.js";
import { RemoteTool } from "../tools/RemoteTool.js";
import { createModel } from "../llm/createModel.js";
import { LogService, ConsoleSubscriber, FileSubscriber, LogLevel } from "../logging/index.js";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

LogService.subscribe(new ConsoleSubscriber(LogLevel.INFO));

if (process.env["LOG_FILE"]) {
  LogService.subscribe(new FileSubscriber(LogLevel.DEBUG));
}

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
// LLM + Agent
// ---------------------------------------------------------------------------

const model = createModel();

const agent = new GloveAgent(model, tools, {
  systemPrompt:
    "You are a helpful assistant with access to real-time weather data for Australia, Europe, and the United States. " +
    "Use weather_au for Australian locations, weather_eu for European locations, and weather_us for US locations. " +
    "Answer concisely and always include the unit when reporting temperatures.",
});

// ---------------------------------------------------------------------------
// Channels — CLI for terminal interaction, Web for socket/browser testing
// ---------------------------------------------------------------------------

const webPort = parseInt(process.env["WEB_PORT"] ?? "8080", 10);
const webHost = process.env["WEB_HOST"] ?? "0.0.0.0";

agent
  .addChannel(new CliChannel())
  .addChannel(new WebChannel({ port: webPort, host: webHost }));

await agent.start();
