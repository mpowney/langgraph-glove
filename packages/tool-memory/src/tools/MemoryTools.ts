import type { ToolHandler, ToolMetadata } from "@langgraph-glove/tool-server";
import { MemoryService } from "../MemoryService";

export interface MemoryToolDefinition {
  metadata: ToolMetadata;
  handler: ToolHandler;
}

export function createMemoryTools(memoryService: MemoryService): MemoryToolDefinition[] {
  return [
    {
      metadata: {
        name: "memory_create",
        description:
          "Use {name} to create a new persistent memory stored as markdown and indexed into SQLite chunk metadata with vector embeddings.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short title for the memory." },
            content: { type: "string", description: "Markdown body for the memory." },
            scope: { type: "string", description: "Optional logical scope, such as user, project, or task." },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags used for later filtering.",
            },
            retentionTier: {
              type: "string",
              enum: ["hot", "warm", "cold"],
              description: "Initial retention tier for the memory.",
            },
            personal: {
              type: "boolean",
              description: "Mark memory content as personal. Only personal memories are encrypted in the privacy pipeline.",
            },
            personalToken: {
              type: "string",
              description: "Personal token used when storing personal memory content.",
            },
          },
          required: ["title", "content"],
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.createMemory({
        title: params["title"] as string,
        content: params["content"] as string,
        scope: params["scope"] as string | undefined,
        tags: params["tags"] as string[] | undefined,
        retentionTier: params["retentionTier"] as "hot" | "warm" | "cold" | undefined,
        personal: params["personal"] as boolean | undefined,
        personalToken: params["personalToken"] as string | undefined,
      }),
    },
    {
      metadata: {
        name: "memory_append",
        description:
          "Use {name} to accumulate additional content into an existing memory and reindex only that memory's chunks.",
        parameters: {
          type: "object",
          properties: {
            memoryId: { type: "string", description: "Stable memory id." },
            slug: { type: "string", description: "Slug derived from the title." },
            storagePath: { type: "string", description: "Path to the markdown file relative to the configured memories directory." },
            content: { type: "string", description: "Markdown content to append." },
            personalToken: {
              type: "string",
              description: "Personal token required when appending to personal memory.",
            },
          },
          required: ["content"],
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.appendMemory({
        memoryId: params["memoryId"] as string | undefined,
        slug: params["slug"] as string | undefined,
        storagePath: params["storagePath"] as string | undefined,
        content: params["content"] as string,
        personalToken: params["personalToken"] as string | undefined,
      }),
    },
    {
      metadata: {
        name: "memory_update",
        description:
          "Use {name} to replace or revise an existing memory by id, slug, or storage path, then rebuild its index rows.",
        parameters: {
          type: "object",
          properties: {
            memoryId: { type: "string", description: "Stable memory id." },
            slug: { type: "string", description: "Slug derived from the title." },
            storagePath: { type: "string", description: "Path to the markdown file relative to the configured memories directory." },
            title: { type: "string", description: "Replacement title." },
            content: { type: "string", description: "Replacement markdown content." },
            scope: { type: "string", description: "Replacement logical scope." },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Replacement tags.",
            },
            retentionTier: {
              type: "string",
              enum: ["hot", "warm", "cold"],
              description: "Replacement retention tier.",
            },
            status: { type: "string", description: "Replacement status, for example active or archived." },
            personal: {
              type: "boolean",
              description: "Set whether this memory is personal.",
            },
            personalToken: {
              type: "string",
              description: "Personal token used when modifying personal memory content.",
            },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.updateMemory({
        memoryId: params["memoryId"] as string | undefined,
        slug: params["slug"] as string | undefined,
        storagePath: params["storagePath"] as string | undefined,
        title: params["title"] as string | undefined,
        content: params["content"] as string | undefined,
        scope: params["scope"] as string | undefined,
        tags: params["tags"] as string[] | undefined,
        retentionTier: params["retentionTier"] as "hot" | "warm" | "cold" | undefined,
        status: params["status"] as string | undefined,
        personal: params["personal"] as boolean | undefined,
        personalToken: params["personalToken"] as string | undefined,
      }),
    },
    {
      metadata: {
        name: "memory_search",
        description:
          "Use {name} to search memory with a specified query, optionally filtering by scope or tag.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for across stored memories." },
            scope: { type: "string", description: "Optional scope filter." },
            limit: { type: "number", description: "Maximum number of memories to return." },
            personalToken: {
              type: "string",
              description: "Personal token required to include excerpts from personal memories.",
            },
          },
          required: ["query"],
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.searchMemories({
        query: params["query"] as string,
        scope: params["scope"] as string | undefined,
        limit: params["limit"] as number | undefined,
        personalToken: params["personalToken"] as string | undefined,
      }),
    },
    {
      metadata: {
        name: "memory_get",
        description:
          "Use {name} to fetch a stored markdown memory, including its metadata, revision, and body content.",
        parameters: {
          type: "object",
          properties: {
            memoryId: { type: "string", description: "Stable memory id." },
            slug: { type: "string", description: "Slug derived from the title." },
            storagePath: { type: "string", description: "Path to the markdown file relative to the configured memories directory." },
            personalToken: {
              type: "string",
              description: "Personal token required when retrieving personal memory content.",
            },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.getMemory({
        memoryId: params["memoryId"] as string | undefined,
        slug: params["slug"] as string | undefined,
        storagePath: params["storagePath"] as string | undefined,
        personalToken: params["personalToken"] as string | undefined,
      }),
    },
    {
      metadata: {
        name: "memory_list",
        description:
          "Use {name} to browse stored memories and filter them by scope or tag without loading full content.",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", description: "Optional scope filter." },
            tag: { type: "string", description: "Optional tag filter." },
            limit: { type: "number", description: "Maximum number of memories to return." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.listMemories({
        scope: params["scope"] as string | undefined,
        tag: params["tag"] as string | undefined,
        limit: params["limit"] as number | undefined,
      }),
    },
    {
      metadata: {
        name: "memory_reindex",
        description:
          "Use {name} to rebuild chunk rows and vector embeddings for one memory or for the full memory catalog.",
        parameters: {
          type: "object",
          properties: {
            memoryId: { type: "string", description: "Stable memory id." },
            slug: { type: "string", description: "Slug derived from the title." },
            storagePath: { type: "string", description: "Path to the markdown file relative to the configured memories directory." },
            personalToken: {
              type: "string",
              description: "Personal token used when reindexing personal memory content.",
            },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.reindexMemory({
        memoryId: params["memoryId"] as string | undefined,
        slug: params["slug"] as string | undefined,
        storagePath: params["storagePath"] as string | undefined,
        personalToken: params["personalToken"] as string | undefined,
      }),
    },
    {
      metadata: {
        name: "memory_delete",
        description:
          "Use {name} to permanently delete a memory markdown file and all indexed rows by id, slug, or storage path.",
        parameters: {
          type: "object",
          properties: {
            memoryId: { type: "string", description: "Stable memory id." },
            slug: { type: "string", description: "Slug derived from the title." },
            storagePath: { type: "string", description: "Path to the markdown file relative to the configured memories directory." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.deleteMemory({
        memoryId: params["memoryId"] as string | undefined,
        slug: params["slug"] as string | undefined,
        storagePath: params["storagePath"] as string | undefined,
      }),
    },
    {
      metadata: {
        name: "memory_config",
        description:
          "Use {name} to inspect the active memory configuration, including chunking, retrieval, and embedding model settings.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
      handler: async () => memoryService.getConfig(),
    },
  ];
}
