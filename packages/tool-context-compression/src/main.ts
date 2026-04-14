import { launchToolServer } from "@langgraph-glove/tool-server";
import {
  createResearchCompressionHandler,
  researchCompressionToolMetadata,
} from "./tools/ResearchCompressionTool.js";

await launchToolServer({
  toolKey: "context-compression",
  register(server) {
    server.register(
      researchCompressionToolMetadata,
      createResearchCompressionHandler(),
    );
  },
});