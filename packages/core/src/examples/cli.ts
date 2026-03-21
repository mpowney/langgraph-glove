/**
 * Minimal example: CLI channel + remote weather tools over HTTP RPC.
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
 * Tool servers (start all three before running this):
 *   cd packages/tool-weather-au && RPC_MODE=http PORT=3001 node dist/main.js
 *   cd packages/tool-weather-eu && RPC_MODE=http PORT=3002 node dist/main.js
 *   cd packages/tool-weather-us && node dist/main.js
 *   (US tool listens on /tmp/langgraph-glove-weather_us.sock)
 *
 * Then run:
 *   cd packages/core && node dist/examples/cli.js
 *
 * Override HTTP URLs:
 *   WEATHER_AU_URL=http://localhost:3001
 *   WEATHER_EU_URL=http://localhost:3002
 */

import { GloveAgent } from "../agent/Agent";
import { CliChannel } from "../channels/CliChannel";
import { HttpRpcClient } from "../rpc/HttpRpcClient";
import { UnixSocketRpcClient } from "../rpc/UnixSocketRpcClient";
import { RemoteTool } from "../tools/RemoteTool";
import { createModel } from "../llm/createModel";
import { LogService, ConsoleSubscriber, FileSubscriber, LogLevel } from "../logging/index";

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

agent.addChannel(new CliChannel());

await agent.start();
