import { launchToolServer } from "@langgraph-glove/tool-server";
import { MemoryService } from "./MemoryService";
import { createMemoryTools } from "./tools/MemoryTools";

const memoryService = new MemoryService();

await launchToolServer({
  toolKey: "memory",
  register(server) {
    for (const toolDef of createMemoryTools(memoryService)) {
      server.register(toolDef.metadata, toolDef.handler);
    }
  },
});
