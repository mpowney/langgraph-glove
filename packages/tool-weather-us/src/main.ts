/**
 * Entry point for the tool-weather-us server.
 *
 * The US weather tool always uses a Unix socket — the socket path is derived
 * from the tool name automatically:
 *
 *   node dist/main.js
 *   (listens on /tmp/langgraph-glove-weather_us.sock)
 *
 * HTTP mode is also available for convenience:
 *
 *   RPC_MODE=http   PORT=3003   node dist/main.js
 *
 * The agent (in @langgraph-glove/core) connects via UnixSocketRpcClient("weather_us").
 */

import { HttpToolServer, UnixSocketToolServer } from "@langgraph-glove/tool-server";
import type { ToolServer } from "@langgraph-glove/tool-server";
import { weatherToolMetadata, handleWeather } from "./tools/WeatherTool.js";

const mode = (process.env["RPC_MODE"] ?? "unix").toLowerCase();

let server: ToolServer;

if (mode === "unix") {
  server = new UnixSocketToolServer("weather_us");
} else {
  const port = Number(process.env["PORT"] ?? 3003);
  server = new HttpToolServer(port);
}

// Register all tools
server.register(weatherToolMetadata, handleWeather);

// Start
await server.start();
console.log(`US weather tool server running in "${mode}" mode. Press Ctrl-C to stop.`);

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
