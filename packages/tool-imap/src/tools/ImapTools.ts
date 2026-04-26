import type { ToolHandler, ToolMetadata } from "@langgraph-glove/tool-server";
import { ImapIndexService } from "../ImapIndexService";

export interface ImapToolDefinition {
  metadata: ToolMetadata;
  handler: ToolHandler;
}

function describeForInstance(description: string, displayName?: string): string {
  const label = displayName?.trim();
  if (!label) return description;
  return `${description} IMAP instance: ${label}.`;
}

export function createImapTools(service: ImapIndexService): ImapToolDefinition[] {
  const displayName = service.getDisplayName();

  return [
    {
      metadata: {
        name: "imap_crawl",
        description: describeForInstance("Crawl emails from IMAP folders and (re)build chunk/vector index rows.", displayName),
        requiresPrivilegedAccess: true,
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
        description: describeForInstance("Run hybrid lexical + vector search across indexed emails.", displayName),
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query text." },
            folder: { type: "string", description: "Optional folder filter." },
            limit: { type: "number", description: "Maximum results to return." },
            year: { type: "number", description: "Optional 4-digit year filter for the selected date field." },
            month: { type: "number", description: "Optional month filter (1-12) for the selected date field." },
            day: { type: "number", description: "Optional day-of-month filter (1-31) for the selected date field." },
            dateField: {
              type: "string",
              enum: ["sentAt", "receivedAt", "updatedAt"],
              description: "Which date field to use for year/month/day filtering. receivedAt uses the local index receipt timestamp.",
            },
            from: { type: "string", description: "Optional case-insensitive sender filter." },
            subject: { type: "string", description: "Optional case-insensitive subject filter." },
            hasAttachments: { type: "boolean", description: "Optional filter for messages that do or do not have attachments." },
            sortBy: {
              type: "string",
              enum: ["relevance", "sentAt", "receivedAt", "updatedAt"],
              description: "Sort results by relevance or one of the indexed date fields.",
            },
            sortDirection: {
              type: "string",
              enum: ["asc", "desc"],
              description: "Sort direction. Defaults to descending.",
            },
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
        year: params["year"] as number | undefined,
        month: params["month"] as number | undefined,
        day: params["day"] as number | undefined,
        dateField: params["dateField"] as "sentAt" | "receivedAt" | "updatedAt" | undefined,
        from: params["from"] as string | undefined,
        subject: params["subject"] as string | undefined,
        hasAttachments: params["hasAttachments"] as boolean | undefined,
        sortBy: params["sortBy"] as "relevance" | "sentAt" | "receivedAt" | "updatedAt" | undefined,
        sortDirection: params["sortDirection"] as "asc" | "desc" | undefined,
        chunkSource: params["chunkSource"] as "email" | "attachment" | undefined,
      }),
    },
    {
      metadata: {
        name: "imap_get_email",
        description: describeForInstance("Get one indexed email by internal id, message-id, or folder+uid.", displayName),
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
        description: describeForInstance("Get all indexed emails in the same thread.", displayName),
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
        description: describeForInstance("Rebuild chunk/vector rows for one email or the entire indexed mailbox.", displayName),
        requiresPrivilegedAccess: true,
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
        description: describeForInstance("Show crawl/index state, counts, and folder checkpoints for this IMAP instance.", displayName),
        requiresPrivilegedAccess: true,
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
        description: describeForInstance("Estimate how many emails remain to be crawled by querying IMAP folder UIDs.", displayName),
        requiresPrivilegedAccess: true,
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
        description: describeForInstance("Stop the currently running IMAP crawl. Has no effect if no crawl is active.", displayName),
        requiresPrivilegedAccess: true,
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
        description: describeForInstance("Start an incremental IMAP crawl in the background. Has no effect if a crawl is already running.", displayName),
        requiresPrivilegedAccess: true,
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
        description: describeForInstance("Clear all indexed IMAP data and crawl checkpoints so future crawls re-ingest from scratch.", displayName),
        requiresPrivilegedAccess: true,
        parameters: {
          type: "object",
          properties: {},
        },
      },
      handler: async () => service.clearIndex(),
    },
  ];
}
