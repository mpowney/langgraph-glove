import path from "node:path";
import { MemoryService } from "../MemoryService.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const workspaceRoot = path.resolve(process.cwd(), "../..");
  const configDir = process.env["GLOVE_CONFIG_DIR"] ?? path.join(workspaceRoot, "config");
  const secretsDir = process.env["GLOVE_SECRETS_DIR"] ?? path.join(workspaceRoot, "secrets");

  const memory = new MemoryService({ configDir, secretsDir });

  const created = await memory.createMemory({
    title: `Smoke memory ${Date.now()}`,
    content:
      "This memory validates end-to-end memory operations including vector indexing and retrieval.",
    scope: "smoke",
    tags: ["smoke", "integration"],
  });

  assert(created.id, "createMemory did not return an id");

  const appended = await memory.appendMemory({
    memoryId: created.id,
    content: "Additional context was appended during the smoke test.",
  });
  assert(appended.revision > created.revision, "appendMemory did not increase revision");

  const updated = await memory.updateMemory({
    memoryId: created.id,
    tags: ["smoke", "integration", "updated"],
    status: "active",
  });
  assert(updated.tags.includes("updated"), "updateMemory did not update tags");

  const reindexed = await memory.reindexMemory({ memoryId: created.id });
  assert(reindexed.reindexed === 1, "reindexMemory did not target exactly one memory");
  assert(reindexed.chunkCount >= 1, "reindexMemory returned zero chunks");

  const searched = await memory.searchMemories({
    query: "vector indexing retrieval smoke",
    scope: "smoke",
    limit: 5,
  });
  assert(searched.results.length >= 1, "searchMemories returned no results");

  const listed = memory.listMemories({ scope: "smoke", limit: 10 });
  assert(listed.some((m) => m.id === created.id), "listMemories did not include created memory");

  const fetched = memory.getMemory({ memoryId: created.id });
  assert(fetched.content.includes("smoke test"), "getMemory did not return expected content");

  console.log(
    JSON.stringify(
      {
        ok: true,
        memoryId: created.id,
        retrievalMode: searched.retrievalMode,
        embeddingModelKey: searched.embeddingModelKey,
        chunkCount: reindexed.chunkCount,
        topResultId: searched.results[0]?.memory.id,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory smoke failed: ${message}`);
  process.exit(1);
});
