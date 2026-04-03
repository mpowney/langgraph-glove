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
            storagePath: { type: "string", description: "Absolute path to the markdown file." },
            content: { type: "string", description: "Markdown content to append." },
          },
          required: ["content"],
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.appendMemory({
        memoryId: params["memoryId"] as string | undefined,
        slug: params["slug"] as string | undefined,
        storagePath: params["storagePath"] as string | undefined,
        content: params["content"] as string,
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
            storagePath: { type: "string", description: "Absolute path to the markdown file." },
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
          },
          required: ["query"],
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.searchMemories({
        query: params["query"] as string,
        scope: params["scope"] as string | undefined,
        limit: params["limit"] as number | undefined,
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
            storagePath: { type: "string", description: "Absolute path to the markdown file." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.getMemory({
        memoryId: params["memoryId"] as string | undefined,
        slug: params["slug"] as string | undefined,
        storagePath: params["storagePath"] as string | undefined,
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
            storagePath: { type: "string", description: "Absolute path to the markdown file." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => memoryService.reindexMemory({
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
