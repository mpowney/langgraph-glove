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
 *   --cli              - enable the CLI channel regardless of channels.json
 *   --no-cli           - disable the CLI channel regardless of channels.json
 *   --regenerate-setup-token - print a new setup token and exit (for initial setup or if the original token is lost)
 *   --reset-auth       - wipe all auth state and print a fresh setup token, then exit
 *
 * Usage:
 *   node dist/main.js [--cli|--no-cli]
 */

import path from "node:path";
import {
  ConfigLoader,
  resolveConfigEntry,
  DEFAULT_GRAPH_ENTRY,
  type AgentEntry,
  type ModelEntry,
  type ChannelEntry,
} from "@langgraph-glove/config";
import { Gateway } from "./gateway/Gateway";
import { LogService } from "./logging/LogService";
import { FileSubscriber } from "./logging/FileSubscriber";
import { LogLevel } from "./logging/LogLevel";
import { getChannelEntryByKey } from "./channels/Channel";
import { createCliChannelFromConfig } from "./channels/CliChannel";
import { createWebChannelFromConfig } from "./channels/WebChannel";
import { createBlueBubblesChannelFromConfig } from "./channels/BlueBubblesChannel";
import { createObservabilityChannelFromConfig } from "./channels/ObservabilityChannel";
import { AuthService } from "./auth/AuthService";
import { Logger } from "./logging";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const regenerateSetupToken = args.includes("--regenerate-setup-token");
const resetAuth = args.includes("--reset-auth");

let cliOverride: boolean | undefined;
for (const arg of args) {
  if (arg === "--cli") {
    cliOverride = true;
  } else if (arg === "--no-cli") {
    cliOverride = false;
  }
}

// ---------------------------------------------------------------------------
// Logging - set up before anything else
// ---------------------------------------------------------------------------

const logLevel = (process.env["LOG_LEVEL"] ?? "INFO").toUpperCase();
const level = LogLevel[logLevel as keyof typeof LogLevel] ?? LogLevel.INFO;
const logger = new Logger("main");

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
let defaultModelKey: string | undefined;
let defaultModelContextWindowTokens: number | undefined;
let apiUrl: string | undefined;
let channelsConfig: Record<string, ChannelEntry> = {};
try {
  const earlyConfig = new ConfigLoader(configDir, secretsDir).load();
  const defaultGraphEntry = earlyConfig.graphs["default"] ?? DEFAULT_GRAPH_ENTRY;
  const orchestratorAgentKey = defaultGraphEntry.orchestratorAgentKey;
  defaultAgentDescription = resolveConfigEntry(
    earlyConfig.agents as Record<string, AgentEntry>,
    orchestratorAgentKey,
  ).description;
  channelsConfig = earlyConfig.channels as Record<string, ChannelEntry>;
  const defaultAgent = resolveConfigEntry(
    earlyConfig.agents as Record<string, AgentEntry>,
    orchestratorAgentKey,
  );
  defaultModelKey = defaultAgent.modelKey ?? "default";
  const defaultModel = resolveConfigEntry(
    earlyConfig.models as Record<string, ModelEntry>,
    defaultModelKey,
  );
  defaultModelContextWindowTokens = defaultModel.contextWindowTokens;
  checkpointDbPath = path.resolve(earlyConfig.gateway.conversationDbPath ?? "data/checkpoints.sqlite");
  const configuredApiHost = earlyConfig.gateway.apiHost ?? "localhost";
  const browserApiHost = configuredApiHost === "0.0.0.0" ? "localhost" : configuredApiHost;
  const configuredApiPort = earlyConfig.gateway.apiPort ?? 8081;
  apiUrl = `http://${browserApiHost}:${configuredApiPort}`;
} catch (err) {
  console.warn("Failed to load config during startup (this is expected if the config files are not yet set up). Using defaults for WebChannel appInfo.", { error: (err as Error).message });
  logger.warn("Failed to load config during startup (this is expected if the config files are not yet set up). Using defaults for WebChannel appInfo.");
  // Config will be validated properly inside Gateway.start() - ignore here
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

if (regenerateSetupToken) {
  const config = new ConfigLoader(configDir, secretsDir).load();
  const auth = new AuthService({
    dbPath: config.gateway.conversationDbPath ?? "data/checkpoints.sqlite",
    config: config.gateway.auth,
  });

  try {
    const setupToken = auth.regenerateBootstrapToken();
    // Use stdout so operators can copy the token from terminal output.
    console.log(`Setup token (expires ${setupToken.expiresAt}): ${setupToken.token}`);
  } finally {
    auth.close();
  }

  process.exit(0);
}

if (resetAuth) {
  const config = new ConfigLoader(configDir, secretsDir).load();
  const auth = new AuthService({
    dbPath: config.gateway.conversationDbPath ?? "data/checkpoints.sqlite",
    config: config.gateway.auth,
  });

  try {
    const setupToken = auth.resetAuth();
    console.log("Auth state reset. All users, sessions, and passkeys have been removed.");
    console.log(`New setup token (expires ${setupToken.expiresAt}): ${setupToken.token}`);
  } finally {
    auth.close();
  }

  process.exit(0);
}

const channels = [];
const cliEntry = getChannelEntryByKey(channelsConfig, "cli");
const cliEnabled = cliOverride ?? cliEntry?.enabled !== false;
if (cliEnabled) {
  const cliChannel = createCliChannelFromConfig(cliEntry);
  if (cliChannel) {
    channels.push(cliChannel);
  }
}

const webEntry = getChannelEntryByKey(channelsConfig, "web");
if (webEntry && webEntry.enabled !== false) {
  channels.push(
    createWebChannelFromConfig(webEntry, {
      checkpointDbPath,
      appInfo: {
        name: "LangGraph Glove",
        agentDescription: defaultAgentDescription,
        apiUrl,
        modelKey: defaultModelKey,
        modelContextWindowTokens: defaultModelContextWindowTokens,
        ...(defaultModelContextWindowTokens ? { modelContextWindowSource: "config" } : {}),
      },
    }),
  );
}

const blueBubblesEntry = getChannelEntryByKey(channelsConfig, "bluebubbles");
if (blueBubblesEntry && blueBubblesEntry.enabled !== false) {
  channels.push(createBlueBubblesChannelFromConfig(blueBubblesEntry));
}

const observabilityEntry = getChannelEntryByKey(channelsConfig, "observability");
if (observabilityEntry && observabilityEntry.enabled !== false) {
  channels.push(
    createObservabilityChannelFromConfig(observabilityEntry, {
      appInfo: {
        name: "LangGraph Glove Observability",
        description: "Topology view for graphs, agents, models, and tools",
        apiUrl,
      },
    }),
  );
}

const gateway = new Gateway({
  configDir,
  secretsDir,
  channels,
});

await gateway.start();
