import { readFileSync } from "node:fs";
import path from "node:path";
import { launchToolServer } from "@langgraph-glove/tool-server";
import { webSearchToolMetadata, createWebSearchHandler } from "./tools/WebSearchTool";

// Resolve SearXNG URL from secrets/urls.json
const secretsDir = path.resolve(process.env["GLOVE_SECRETS_DIR"] ?? "secrets");
const urlsPath = path.join(secretsDir, "urls.json");
const urls = JSON.parse(readFileSync(urlsPath, "utf-8")) as Record<string, string>;
const searxngUrl = urls["searxng-url"];

if (!searxngUrl) {
  throw new Error(
    `Missing "searxng-url" in ${urlsPath}. ` +
      "Add it to secrets/urls.json, e.g. { \"searxng-url\": \"http://localhost:8080\" }",
  );
}

const handleWebSearch = createWebSearchHandler(searxngUrl);

await launchToolServer({
  toolKey: "search",
  register(server) {
    server.register(webSearchToolMetadata, handleWebSearch);
  },
});
