import type { ToolHandler, ToolMetadata } from "@langgraph-glove/tool-server";
import { ImapIndexService } from "../ImapIndexService.js";

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
          },
          required: ["query"],
        },
      },
      handler: async (params: Record<string, unknown>) => service.search({
        query: params["query"] as string,
        folder: params["folder"] as string | undefined,
        limit: params["limit"] as number | undefined,
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
  ];
}
