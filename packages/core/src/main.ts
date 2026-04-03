/**
 * Production entry point for the langgraph-glove gateway.
 *
 * Loads config from the paths set via environment variables (or sensible
 * defaults), creates the gateway, and starts it.
 *
 * Environment variables:
 *   GLOVE_CONFIG_DIR   - path to config directory  (default: ./config)
 *   GLOVE_SECRETS_DIR  - path to secrets directory (default: ./secrets)
 *
 * Flags:
 *   --web              - also start the WebChannel (browser UI)
 *   --web-port <n>     - port for the WebChannel  (default: 8080)
 *   --no-cli           - disable the CLI channel
 *
 * Usage:
 *   node dist/main.js [--web] [--web-port 3000] [--no-cli]
 */

import path from "node:path";
import { ConfigLoader } from "@langgraph-glove/config";
import { Gateway } from "./gateway/Gateway";
import { LogService } from "./logging/LogService";
import { FileSubscriber } from "./logging/FileSubscriber";
import { LogLevel } from "./logging/LogLevel";
import { CliChannel } from "./channels/CliChannel";
import { WebChannel } from "./channels/WebChannel";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const useWeb = args.includes("--web");
const noCli = args.includes("--no-cli");
const webPortIndex = args.indexOf("--web-port");
const webPort = webPortIndex !== -1 ? parseInt(args[webPortIndex + 1] ?? "8080", 10) : 8080;

// ---------------------------------------------------------------------------
// Logging - set up before anything else
// ---------------------------------------------------------------------------

const logLevel = (process.env["LOG_LEVEL"] ?? "INFO").toUpperCase();
const level = LogLevel[logLevel as keyof typeof LogLevel] ?? LogLevel.INFO;

if (process.env["LOG_FILE"]) {
  LogService.subscribe(new FileSubscriber(level));
}

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

const configDir = path.resolve(process.env["GLOVE_CONFIG_DIR"] ?? "config");
const secretsDir = path.resolve(process.env["GLOVE_SECRETS_DIR"] ?? "secrets");

// ---------------------------------------------------------------------------
// Pre-read config for WebChannel appInfo (synchronous, lightweight)
// ---------------------------------------------------------------------------

let defaultAgentDescription: string | undefined;
let checkpointDbPath: string | undefined;
try {
  const earlyConfig = new ConfigLoader(configDir, secretsDir).load();
  defaultAgentDescription = earlyConfig.agents["default"]?.description;
  checkpointDbPath = path.resolve(earlyConfig.gateway.dbPath ?? "data/checkpoints.sqlite");
} catch {
  // Config will be validated properly inside Gateway.start() - ignore here
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

const channels = [];
if (!noCli) channels.push(new CliChannel());
if (useWeb) {
  const apiPort = parseInt(process.env["GLOVE_API_PORT"] ?? "8081", 10);
  const apiHost = process.env["GLOVE_API_HOST"] ?? "localhost";
  channels.push(
    new WebChannel({
      port: webPort,
      receiveAll: true,
      appInfo: {
        name: "LangGraph Glove",
        agentDescription: defaultAgentDescription,
        apiUrl: `http://${apiHost}:${apiPort}`,
      },
      checkpointDbPath,
    }),
  );
}

const gateway = new Gateway({
  configDir,
  secretsDir,
  channels,
});

await gateway.start();
