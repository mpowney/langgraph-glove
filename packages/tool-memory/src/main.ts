import { launchToolServer } from "@langgraph-glove/tool-server";
import { MemoryService } from "./MemoryService";
import { createMemoryTools } from "./tools/MemoryTools";

const memoryService = new MemoryService();

try {
  memoryService.validateEmbeddingsModel();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[tool-memory] startup failed: ${message}`);
  process.stderr.write(`[tool-memory] startup failed: ${message}\n`);
  process.exit(1);
}

await launchToolServer({
  toolKey: "memory",
  register(server) {
    for (const toolDef of createMemoryTools(memoryService)) {
      server.register(toolDef.metadata, toolDef.handler);
    }
  },
});
