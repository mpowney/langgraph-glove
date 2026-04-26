import path from "node:path";
import { launchToolServer } from "@langgraph-glove/tool-server";
import { ImapIndexService } from "./ImapIndexService";
import { createImapTools } from "./tools/ImapTools";

function resolveToolKey(): string {
  const fromEnv = process.env["TOOL_NAME"]?.trim();
  if (fromEnv) return fromEnv;

  const fromArg = process.argv[2]?.trim();
  if (fromArg) return fromArg;

  throw new Error("tool-imap requires TOOL_NAME env var or argv[2] for tools.json instance key");
}

function resolveConfigPaths(): { configDir: string; secretsDir: string } {
  return {
    configDir: path.resolve(process.env["GLOVE_CONFIG_DIR"] ?? "config"),
    secretsDir: path.resolve(process.env["GLOVE_SECRETS_DIR"] ?? "secrets"),
  };
}

const toolKey = resolveToolKey();
const { configDir, secretsDir } = resolveConfigPaths();
const service = new ImapIndexService({ toolKey, configDir, secretsDir });

await launchToolServer({
  toolKey,
  configDir,
  secretsDir,
  healthCheck: () => service.checkHealth(),
  register(server) {
    for (const toolDef of createImapTools(service)) {
      server.register(toolDef.metadata, toolDef.handler);
    }
  },
});

void service.start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[tool-imap] crawler startup failed: ${message}`);
  process.stderr.write(`[tool-imap] crawler startup failed: ${message}\n`);
});

const shutdown = async (): Promise<void> => {
  await service.stop();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
