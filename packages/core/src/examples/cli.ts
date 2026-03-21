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
 * Tool servers (start both before running this):
 *   cd packages/tool-weather-au && RPC_MODE=http PORT=3001 node dist/main.js
 *   cd packages/tool-weather-eu && RPC_MODE=http PORT=3002 node dist/main.js
 *
 * Then run:
 *   cd packages/core && node dist/examples/cli.js
 *
 * Override URLs:
 *   WEATHER_AU_URL=http://localhost:3001
 *   WEATHER_EU_URL=http://localhost:3002
 */

import { z } from "zod";
import { GloveAgent } from "../agent/Agent";
import { CliChannel } from "../channels/CliChannel";
import { HttpRpcClient } from "../rpc/HttpRpcClient";
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
// RPC clients — one per tool server
// ---------------------------------------------------------------------------

const auClient = new HttpRpcClient(process.env["WEATHER_AU_URL"] ?? "http://localhost:3001");
const euClient = new HttpRpcClient(process.env["WEATHER_EU_URL"] ?? "http://localhost:3002");

await Promise.all([auClient.connect(), euClient.connect()]);

// ---------------------------------------------------------------------------
// Remote tools
// ---------------------------------------------------------------------------

const weatherAuTool = new RemoteTool(auClient, {
  name: "weather_au",
  description:
    "Get the current weather conditions for a location within Australia. " +
    "Returns temperature, conditions, humidity and wind speed.",
  schema: z.object({
    location: z.string().describe("City name within Australia, e.g. 'Sydney' or 'Melbourne'"),
    unit: z.enum(["celsius", "fahrenheit"]).optional().describe("Temperature unit"),
  }),
});

const weatherEuTool = new RemoteTool(euClient, {
  name: "weather_eu",
  description:
    "Get the current weather conditions for a location within Europe. " +
    "Returns temperature, conditions, humidity and wind speed.",
  schema: z.object({
    location: z.string().describe("City name within Europe, e.g. 'London' or 'Paris'"),
    unit: z.enum(["celsius", "fahrenheit"]).optional().describe("Temperature unit"),
  }),
});

// ---------------------------------------------------------------------------
// LLM + Agent
// ---------------------------------------------------------------------------

const model = createModel();

const agent = new GloveAgent(model, [weatherAuTool, weatherEuTool], {
  systemPrompt:
    "You are a helpful assistant with access to real-time weather data for Australia and Europe. " +
    "Use weather_au for Australian locations and weather_eu for European locations. " +
    "Answer concisely and always include the unit when reporting temperatures.",
});

agent.addChannel(new CliChannel());

await agent.start();
