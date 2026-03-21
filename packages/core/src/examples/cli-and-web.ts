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
 * RPC transport (tool server):
 *   Start the weather tool server first:
 *     cd packages/tool-example && RPC_MODE=http PORT=3001 node dist/main.js
 *   Then run:
 *     cd packages/core && node dist/examples/cli-and-web.js
 *
 *   Switch to Unix socket:
 *     RPC_MODE=unix SOCKET_PATH=/tmp/weather.sock node dist/examples/cli-and-web.js
 */

import { z } from "zod";
import { GloveAgent } from "../agent/Agent.js";
import { CliChannel } from "../channels/CliChannel.js";
import { WebChannel } from "../channels/WebChannel.js";
import { HttpRpcClient } from "../rpc/HttpRpcClient.js";
import { UnixSocketRpcClient } from "../rpc/UnixSocketRpcClient.js";
import type { RpcClient } from "../rpc/RpcClient.js";
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
// Transport selection
// ---------------------------------------------------------------------------

const rpcMode = (process.env["RPC_MODE"] ?? "http").toLowerCase();

let rpcClient: RpcClient;
if (rpcMode === "unix") {
  const socketPath = process.env["SOCKET_PATH"] ?? "/tmp/langgraph-glove-weather.sock";
  rpcClient = new UnixSocketRpcClient(socketPath);
} else {
  const toolServerUrl = process.env["TOOL_SERVER_URL"] ?? "http://localhost:3001";
  rpcClient = new HttpRpcClient(toolServerUrl);
}

await rpcClient.connect();

// ---------------------------------------------------------------------------
// Remote tools
// ---------------------------------------------------------------------------

const weatherTool = new RemoteTool(rpcClient, {
  name: "weather",
  description:
    "Get the current weather conditions for a given location. " +
    "Returns temperature, conditions, humidity and wind speed.",
  schema: z.object({
    location: z.string().describe("City name, e.g. 'London' or 'New York, NY'"),
    unit: z.enum(["celsius", "fahrenheit"]).optional().describe("Temperature unit"),
  }),
});

// ---------------------------------------------------------------------------
// LLM + Agent
// ---------------------------------------------------------------------------

const model = createModel();

const agent = new GloveAgent(model, [weatherTool], {
  systemPrompt:
    "You are a helpful assistant with access to real-time weather data. " +
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
