/**
 * Minimal example: CLI channel + remote weather tool over HTTP RPC.
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
 * RPC transport:
 *   Start the weather tool server first:
 *     cd packages/tool-example && RPC_MODE=http PORT=3001 node dist/main.js
 *   Then run:
 *     cd packages/core && node dist/examples/cli.js
 *
 *   Switch to Unix socket:
 *     RPC_MODE=unix SOCKET_PATH=/tmp/weather.sock node dist/examples/cli.js
 */

import { z } from "zod";
import { GloveAgent } from "../agent/Agent";
import { CliChannel } from "../channels/CliChannel";
import { HttpRpcClient } from "../rpc/HttpRpcClient";
import { UnixSocketRpcClient } from "../rpc/UnixSocketRpcClient";
import type { RpcClient } from "../rpc/RpcClient";
import { RemoteTool } from "../tools/RemoteTool";
import { createModel } from "../llm/createModel";
import { LogService, ConsoleSubscriber, FileSubscriber, LogLevel } from "../logging/index";

// ---------------------------------------------------------------------------
// Logging — subscribe before anything else so all startup messages are captured
// ---------------------------------------------------------------------------

LogService.subscribe(new ConsoleSubscriber(LogLevel.INFO));

// Optionally also write DEBUG+ to a log file (path from LOG_FILE env var)
if (process.env["LOG_FILE"]) {
  LogService.subscribe(new FileSubscriber(LogLevel.DEBUG));
}

// ---------------------------------------------------------------------------
// Transport selection — swap between unix / http at runtime
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
// LLM + Agent  (provider selected from LLM_PROVIDER env var)
// ---------------------------------------------------------------------------

const model = createModel();

const agent = new GloveAgent(model, [weatherTool], {
  systemPrompt:
    "You are a helpful assistant with access to real-time weather data. " +
    "Answer concisely and always include the unit when reporting temperatures.",
});

agent.addChannel(new CliChannel());

await agent.start();
