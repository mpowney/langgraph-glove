import path from "node:path";
import { ConfigLoader, type ToolServerEntry } from "@langgraph-glove/config";
import { HttpToolServer } from "./HttpToolServer";
import { UnixSocketToolServer } from "./UnixSocketToolServer";
import type { ToolServer } from "./ToolServer";

export interface LaunchOptions {
  /** Key in tools.json that this tool server corresponds to. */
  toolKey: string;
  /**
   * Register all tools on the server before it starts.
   * Called with the created server instance — call `server.register(...)` inside.
   */
  register: (server: ToolServer) => void;
  /** Override path to config directory (default: GLOVE_CONFIG_DIR or ./config) */
  configDir?: string;
  /** Override path to secrets directory (default: GLOVE_SECRETS_DIR or ./secrets) */
  secretsDir?: string;
}

/**
 * Config-driven launcher for tool servers.
 *
 * Reads `tools.json` via the config package, looks up the entry by `toolKey`,
 * creates the appropriate server (HTTP or Unix socket), registers tools, starts
 * the server, and installs graceful shutdown handlers.
 *
 * @example
 * ```ts
 * import { launchToolServer } from "@langgraph-glove/tool-server";
 * import { weatherToolMetadata, handleWeather } from "./tools/WeatherTool.js";
 *
 * await launchToolServer({
 *   toolKey: "weather-au",
 *   register(server) {
 *     server.register(weatherToolMetadata, handleWeather);
 *   },
 * });
 * ```
 */
export async function launchToolServer(options: LaunchOptions): Promise<ToolServer> {
  const configDir = path.resolve(
    options.configDir ?? process.env["GLOVE_CONFIG_DIR"] ?? "config",
  );
  const secretsDir = path.resolve(
    options.secretsDir ?? process.env["GLOVE_SECRETS_DIR"] ?? "secrets",
  );

  const loader = new ConfigLoader(configDir, secretsDir);
  const config = loader.load();

  const entry = config.tools[options.toolKey] as ToolServerEntry | undefined;
  if (!entry) {
    throw new Error(
      `Tool key "${options.toolKey}" not found in tools.json. ` +
      `Available keys: ${Object.keys(config.tools).join(", ") || "(none)"}`,
    );
  }

  if (entry.enabled === false) {
    throw new Error(`Tool "${options.toolKey}" is disabled in tools.json.`);
  }

  let server: ToolServer;

  switch (entry.transport) {
    case "http": {
      if (!entry.url) {
        throw new Error(`Tool "${options.toolKey}" (http) requires a "url" field in tools.json.`);
      }
      const url = new URL(entry.url);
      const port = parseInt(url.port, 10) || 80;
      const host = url.hostname;
      server = new HttpToolServer(port, host);
      break;
    }
    case "unix-socket": {
      const socketName = entry.socketName ?? options.toolKey;
      server = new UnixSocketToolServer(socketName);
      break;
    }
    default:
      throw new Error(`Unknown transport "${entry.transport as string}" for tool "${options.toolKey}".`);
  }

  options.register(server);

  await server.start();

  const label = entry.transport === "http" ? entry.url! : `unix-socket (${entry.socketName ?? options.toolKey})`;
  console.log(`Tool server "${options.toolKey}" running on ${label}. Press Ctrl-C to stop.`);

  const shutdown = async () => {
    console.log("\nShutting down…");
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}
