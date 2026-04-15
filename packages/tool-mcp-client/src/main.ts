import path from "node:path";
import {
  ConfigLoader,
  type McpServerConfig,
  type ToolServerEntry,
} from "@langgraph-glove/config";
import { launchToolServer, type ToolMetadata } from "@langgraph-glove/tool-server";
import { createAuthProvider } from "./mcp/auth.js";
import { McpClient } from "./mcp/client.js";

interface RegisteredTool {
  metadata: ToolMetadata;
  remoteName: string;
}

function resolveConfigPaths(): { configDir: string; secretsDir: string } {
  return {
    configDir: path.resolve(process.env["GLOVE_CONFIG_DIR"] ?? "config"),
    secretsDir: path.resolve(process.env["GLOVE_SECRETS_DIR"] ?? "secrets"),
  };
}

function resolveToolKey(): string {
  const fromEnv = process.env["TOOL_NAME"]?.trim();
  if (fromEnv) return fromEnv;

  const fromArg = process.argv[2]?.trim();
  if (fromArg) return fromArg;

  throw new Error(
    "tool-mcp-client requires TOOL_NAME env var or argv[2] to select a tools.json instance key",
  );
}

function toObjectSchema(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    const asRecord = value as Record<string, unknown>;
    if (asRecord["type"] === "object") return asRecord;
    return {
      type: "object",
      properties: asRecord,
    };
  }

  return {
    type: "object",
    properties: {},
  };
}

function sanitizePrefix(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

function createPrefix(toolKey: string, mcp: McpServerConfig): string {
  if (mcp.toolNamePrefix) {
    return mcp.toolNamePrefix;
  }
  return `mcp_${sanitizePrefix(toolKey)}__`;
}

async function main(): Promise<void> {
  const toolKey = resolveToolKey();
  const { configDir, secretsDir } = resolveConfigPaths();

  const loader = new ConfigLoader(configDir, secretsDir);
  const config = loader.load();
  const entry = config.tools[toolKey] as ToolServerEntry | undefined;

  if (!entry) {
    throw new Error(`tools.json entry not found for tool key: ${toolKey}`);
  }

  if (!entry.mcp) {
    throw new Error(
      `tools.json entry \"${toolKey}\" is missing required \"mcp\" configuration`,
    );
  }

  const mcp = entry.mcp;
  const client = new McpClient({
    endpoint: mcp.endpoint,
    requestTimeoutMs: mcp.requestTimeoutMs,
    customHeaders: mcp.customHeaders,
    authProvider: createAuthProvider(mcp.auth),
  });

  const toolPrefix = createPrefix(toolKey, mcp);
  const remoteTools = await client.listTools();
  const registered: RegisteredTool[] = remoteTools.map((tool) => ({
    remoteName: tool.name,
    metadata: {
      name: `${toolPrefix}${tool.name}`,
      description: tool.description || `MCP tool ${tool.name}`,
      parameters: toObjectSchema(tool.inputSchema),
    },
  }));

  if (registered.length === 0) {
    console.warn(`No MCP tools discovered for instance \"${toolKey}\"`);
  }

  await launchToolServer({
    toolKey,
    configDir,
    secretsDir,
    register(server) {
      for (const tool of registered) {
        server.register(tool.metadata, async (params) => {
          const input =
            params && typeof params === "object" && !Array.isArray(params)
              ? (params as Record<string, unknown>)
              : {};
          return client.callTool(tool.remoteName, input);
        });
      }
    },
  });
}

await main();
