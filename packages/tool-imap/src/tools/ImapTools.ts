import type { ToolHandler, ToolMetadata } from "@langgraph-glove/tool-server";
import { ImapIndexService } from "../ImapIndexService";

export interface ImapToolDefinition {
  metadata: ToolMetadata;
  handler: ToolHandler;
}

export function createImapTools(service: ImapIndexService): ImapToolDefinition[] {
  return [
    {
      metadata: {
        name: "imap_crawl",
        description: "Crawl emails from IMAP folders and (re)build chunk/vector index rows.",
        parameters: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Optional folder override (defaults to configured folders)." },
            since: { type: "string", description: "Optional ISO date lower bound for ingestion." },
            full: { type: "boolean", description: "When true, force full crawl instead of incremental UID crawl." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => service.crawl({
        folder: params["folder"] as string | undefined,
        since: params["since"] as string | undefined,
        full: params["full"] as boolean | undefined,
      }),
    },
    {
      metadata: {
        name: "imap_search",
        description: "Run hybrid lexical + vector search across indexed emails.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query text." },
            folder: { type: "string", description: "Optional folder filter." },
            limit: { type: "number", description: "Maximum results to return." },
            chunkSource: {
              type: "string",
              enum: ["email", "attachment"],
              description: "Optional content source filter. When omitted, searches both email and attachment chunks.",
            },
          },
          required: ["query"],
        },
      },
      handler: async (params: Record<string, unknown>) => service.search({
        query: params["query"] as string,
        folder: params["folder"] as string | undefined,
        limit: params["limit"] as number | undefined,
        chunkSource: params["chunkSource"] as "email" | "attachment" | undefined,
      }),
    },
    {
      metadata: {
        name: "imap_get_email",
        description: "Get one indexed email by internal id, message-id, or folder+uid.",
        parameters: {
          type: "object",
          properties: {
            emailId: { type: "string", description: "Internal indexed email id." },
            messageId: { type: "string", description: "RFC822 message-id." },
            folder: { type: "string", description: "Folder used with uid." },
            uid: { type: "number", description: "IMAP uid within the folder." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => service.getEmail({
        emailId: params["emailId"] as string | undefined,
        messageId: params["messageId"] as string | undefined,
        folder: params["folder"] as string | undefined,
        uid: params["uid"] as number | undefined,
      }),
    },
    {
      metadata: {
        name: "imap_get_thread",
        description: "Get all indexed emails in the same thread.",
        parameters: {
          type: "object",
          properties: {
            threadId: { type: "string", description: "Thread id from IMAP metadata." },
            messageId: { type: "string", description: "Resolve thread by known message-id." },
            limit: { type: "number", description: "Maximum thread emails to return." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => service.getThread({
        threadId: params["threadId"] as string | undefined,
        messageId: params["messageId"] as string | undefined,
        limit: params["limit"] as number | undefined,
      }),
    },
    {
      metadata: {
        name: "imap_reindex",
        description: "Rebuild chunk/vector rows for one email or the entire indexed mailbox.",
        parameters: {
          type: "object",
          properties: {
            emailId: { type: "string", description: "Internal indexed email id." },
            folder: { type: "string", description: "Folder used with uid." },
            uid: { type: "number", description: "IMAP uid within the folder." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => service.reindex({
        emailId: params["emailId"] as string | undefined,
        folder: params["folder"] as string | undefined,
        uid: params["uid"] as number | undefined,
      }),
    },
    {
      metadata: {
        name: "imap_status",
        description: "Show crawl/index state, counts, and folder checkpoints for this IMAP instance.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
      handler: async () => service.status(),
    },
    {
      metadata: {
        name: "imap_estimate_remaining",
        description: "Estimate how many emails remain to be crawled by querying IMAP folder UIDs.",
        parameters: {
          type: "object",
          properties: {
            forceRefreshEstimate: {
              type: "boolean",
              description: "When true, bypass cached estimate and refresh from IMAP immediately.",
            },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => service.remainingEstimate({
        forceRefreshEstimate: params["forceRefreshEstimate"] as boolean | undefined,
      }),
    },
    {
      metadata: {
        name: "imap_stop_crawl",
        description: "Stop the currently running IMAP crawl. Has no effect if no crawl is active.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
      handler: async () => service.stopCrawl(),
    },
    {
      metadata: {
        name: "imap_start_crawl",
        description: "Start an incremental IMAP crawl in the background. Has no effect if a crawl is already running.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
      handler: async () => service.startCrawl(),
    },
    {
      metadata: {
        name: "imap_clear_index",
        description: "Clear all indexed IMAP data and crawl checkpoints so future crawls re-ingest from scratch.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
      handler: async () => service.clearIndex(),
    },
  ];
}
