/**
 * Entry point for the tool-example server.
 *
 * Select the RPC transport at runtime via the RPC_MODE environment variable:
 *
 *   RPC_MODE=http   PORT=3001       node dist/main.js   (default)
 *   RPC_MODE=unix   SOCKET_PATH=/tmp/weather.sock  node dist/main.js
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
  const socketPath = process.env["SOCKET_PATH"] ?? "/tmp/langgraph-glove-weather.sock";
  server = new UnixSocketToolServer(socketPath);
} else {
  const port = Number(process.env["PORT"] ?? 3001);
  server = new HttpToolServer(port);
}

// Register all tools
server.register(weatherToolMetadata, handleWeather);

// Start
await server.start();
console.log(`Weather tool server running in "${mode}" mode. Press Ctrl-C to stop.`);

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
