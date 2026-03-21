/**
 * Entry point for the tool-weather-au server.
 *
 * Select the RPC transport at runtime via the RPC_MODE environment variable:
 *
 *   RPC_MODE=http   PORT=3001       node dist/main.js   (default)
 *   RPC_MODE=unix                   node dist/main.js
 *   (socket path derived from tool name: /tmp/langgraph-glove-weather_au.sock)
 *
 * The agent (in @langgraph-glove/core) connects to this process using the
 * matching RpcClient implementation.
 */

import { HttpToolServer, UnixSocketToolServer } from "@langgraph-glove/tool-server";
import type { ToolServer } from "@langgraph-glove/tool-server";
import { weatherToolMetadata, handleWeather } from "./tools/WeatherTool";

const mode = (process.env["RPC_MODE"] ?? "http").toLowerCase();

let server: ToolServer;

if (mode === "unix") {
  server = new UnixSocketToolServer("weather_au");
} else {
  const port = Number(process.env["PORT"] ?? 3001);
  server = new HttpToolServer(port);
}

// Register all tools
server.register(weatherToolMetadata, handleWeather);

// Start
await server.start();
console.log(`Australian weather tool server running in "${mode}" mode. Press Ctrl-C to stop.`);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  await server.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await server.stop();
  process.exit(0);
});
