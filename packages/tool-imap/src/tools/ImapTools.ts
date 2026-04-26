import { createHash } from "node:crypto";
import {
  GatewayContentUploadClient,
  type ContentUploadAuthPayload,
  type ToolHandler,
  type ToolMetadata,
} from "@langgraph-glove/tool-server";
import { ImapIndexService } from "../ImapIndexService";

export interface ImapToolDefinition {
  metadata: ToolMetadata;
  handler: ToolHandler;
}

const DEFAULT_UPLOAD_CHUNK_BYTES = 256 * 1024;
const DEFAULT_EMAIL_ATTACHMENT_TTL_SECONDS = 300;

function describeForInstance(description: string, displayName?: string): string {
  const label = displayName?.trim();
  if (!label) return description;
  return `${description} IMAP instance: ${label}.`;
}

function readUploadAuth(params: Record<string, unknown>, toolName = "imap_get_attachment_file"): ContentUploadAuthPayload {
  const raw = params["contentUploadAuth"];
  if (!raw || typeof raw !== "object") {
    throw new Error(`${toolName}: missing runtime contentUploadAuth payload`);
  }

  const payload = raw as Record<string, unknown>;
  if (typeof payload.token !== "string") {
    throw new Error(`${toolName}: invalid contentUploadAuth.token`);
  }
  if (typeof payload.expiresAt !== "string") {
    throw new Error(`${toolName}: invalid contentUploadAuth.expiresAt`);
  }
  if (payload.transport !== "http" && payload.transport !== "unix-socket") {
    throw new Error(`${toolName}: invalid contentUploadAuth.transport`);
  }

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    transport: payload.transport,
    ...(typeof payload.gatewayBaseUrl === "string"
      ? { gatewayBaseUrl: payload.gatewayBaseUrl }
      : {}),
    ...(typeof payload.socketName === "string"
      ? { socketName: payload.socketName }
      : {}),
  };
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
        supportsContentUpload: true,
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
            ttlSeconds: { type: "number", description: "Optional attachment content TTL in seconds. Defaults to 300 seconds." },
          },
          required: ["query"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const searchResult = await service.search({
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
        });

        const ttlSeconds = typeof params["ttlSeconds"] === "number"
          ? Math.floor(params["ttlSeconds"])
          : DEFAULT_EMAIL_ATTACHMENT_TTL_SECONDS;
        if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
          throw new Error("imap_search: 'ttlSeconds' must be a positive integer when provided");
        }

        const rawResults = searchResult["results"];
        if (!Array.isArray(rawResults)) {
          return searchResult;
        }

        const emailRefByKey = new Map<string, { messageId?: string; emailId?: string }>();
        for (const entry of rawResults) {
          if (!entry || typeof entry !== "object") continue;
          const email = (entry as Record<string, unknown>)["email"];
          if (!email || typeof email !== "object") continue;

          const emailRecord = email as Record<string, unknown>;
          const messageIdValue = emailRecord["messageId"];
          const emailIdValue = emailRecord["id"];
          const messageId = typeof messageIdValue === "string" && messageIdValue.trim().length > 0
            ? messageIdValue.trim()
            : undefined;
          const emailId = typeof emailIdValue === "string" && emailIdValue.trim().length > 0
            ? emailIdValue.trim()
            : undefined;

          if (!messageId && !emailId) continue;
          const refKey = messageId ? `message:${messageId}` : `email:${emailId}`;
          emailRefByKey.set(refKey, { messageId, emailId });
        }
        const emailRefs = [...emailRefByKey.values()];

        if (emailRefs.length === 0) {
          return {
            ...searchResult,
            attachmentCount: 0,
            attachments: [],
            contentItems: [],
          };
        }

        const attachmentsToUpload = [] as Array<{ emailId?: string; messageId?: string; attachment: Awaited<ReturnType<ImapIndexService["getEmailAttachmentFiles"]>>["attachments"][number] }>;
        for (const emailRef of emailRefs) {
          const attachmentResult = emailRef.messageId
            ? await service.getEmailAttachmentFiles({ messageId: emailRef.messageId })
            : await service.getEmailAttachmentFiles({ emailId: emailRef.emailId });
          for (const attachment of attachmentResult.attachments) {
            attachmentsToUpload.push({
              emailId: emailRef.emailId,
              messageId: emailRef.messageId,
              attachment,
            });
          }
        }

        if (attachmentsToUpload.length === 0) {
          return {
            ...searchResult,
            attachmentCount: 0,
            attachments: [],
            contentItems: [],
          };
        }

        const uploadAuth = readUploadAuth(params, "imap_search");
        const uploadClient = new GatewayContentUploadClient(uploadAuth);
        const uploadedAttachments = [] as Array<Record<string, unknown>>;
        const contentItems = [] as Array<Record<string, unknown>>;

        for (const item of attachmentsToUpload) {
          const attachment = item.attachment;
          const sha256 = createHash("sha256").update(attachment.content).digest("hex");
          const init = await uploadClient.initUpload({
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            expectedBytes: attachment.content.byteLength,
            ttlSeconds,
          });

          try {
            let chunkIndex = 0;
            for (let offset = 0; offset < attachment.content.byteLength; offset += DEFAULT_UPLOAD_CHUNK_BYTES) {
              const chunk = attachment.content.subarray(
                offset,
                Math.min(offset + DEFAULT_UPLOAD_CHUNK_BYTES, attachment.content.byteLength),
              );
              await uploadClient.appendChunk(init.uploadId, chunkIndex, chunk);
              chunkIndex += 1;
            }

            const finalized = await uploadClient.finalizeUpload(init.uploadId, sha256);
            const contentItem = {
              contentRef: finalized.contentRef,
              fileName: finalized.fileName ?? attachment.fileName,
              mimeType: finalized.mimeType ?? attachment.mimeType,
              byteLength: finalized.byteLength,
            };
            contentItems.push(contentItem);
            uploadedAttachments.push({
              emailId: item.emailId,
              messageId: item.messageId,
              attachmentId: attachment.attachmentId,
              attachmentIndex: attachment.attachmentIndex,
              fileSizeBytes: attachment.fileSizeBytes,
              sha256,
              uploadId: finalized.uploadId,
              expiresAt: init.expiresAt,
              ...contentItem,
            });
          } catch (error) {
            await uploadClient.abortUpload(init.uploadId).catch(() => undefined);
            throw error;
          }
        }

        return {
          ...searchResult,
          attachmentCount: uploadedAttachments.length,
          attachments: uploadedAttachments,
          contentItems,
        };
      },
    },
    {
      metadata: {
        name: "imap_get_email",
        description: describeForInstance("Get one indexed email by internal id, message-id, or folder+uid.", displayName),
        supportsContentUpload: true,
        parameters: {
          type: "object",
          properties: {
            emailId: { type: "string", description: "Internal indexed email id." },
            messageId: { type: "string", description: "RFC822 message-id." },
            folder: { type: "string", description: "Folder used with uid." },
            uid: { type: "number", description: "IMAP uid within the folder." },
            ttlSeconds: { type: "number", description: "Optional attachment content TTL in seconds. Defaults to 300 seconds." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const emailRef = {
          emailId: params["emailId"] as string | undefined,
          messageId: params["messageId"] as string | undefined,
          folder: params["folder"] as string | undefined,
          uid: params["uid"] as number | undefined,
        };

        const ttlSeconds = typeof params["ttlSeconds"] === "number"
          ? Math.floor(params["ttlSeconds"])
          : DEFAULT_EMAIL_ATTACHMENT_TTL_SECONDS;
        if (ttlSeconds <= 0) {
          throw new Error("imap_get_email: 'ttlSeconds' must be a positive integer when provided");
        }

        const emailResult = service.getEmail(emailRef);
        const attachmentResult = await service.getEmailAttachmentFiles(emailRef);
        if (attachmentResult.attachments.length === 0) {
          return {
            ...emailResult,
            attachmentCount: 0,
            attachments: [],
            contentItems: [],
          };
        }

        const uploadAuth = readUploadAuth(params, "imap_get_email");
        const uploadClient = new GatewayContentUploadClient(uploadAuth);
        const uploadedAttachments = [] as Array<Record<string, unknown>>;
        const contentItems = [] as Array<Record<string, unknown>>;

        for (const attachment of attachmentResult.attachments) {
          const sha256 = createHash("sha256").update(attachment.content).digest("hex");
          const init = await uploadClient.initUpload({
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            expectedBytes: attachment.content.byteLength,
            ttlSeconds,
          });

          try {
            let chunkIndex = 0;
            for (let offset = 0; offset < attachment.content.byteLength; offset += DEFAULT_UPLOAD_CHUNK_BYTES) {
              const chunk = attachment.content.subarray(
                offset,
                Math.min(offset + DEFAULT_UPLOAD_CHUNK_BYTES, attachment.content.byteLength),
              );
              await uploadClient.appendChunk(init.uploadId, chunkIndex, chunk);
              chunkIndex += 1;
            }

            const finalized = await uploadClient.finalizeUpload(init.uploadId, sha256);
            const contentItem = {
              contentRef: finalized.contentRef,
              fileName: finalized.fileName ?? attachment.fileName,
              mimeType: finalized.mimeType ?? attachment.mimeType,
              byteLength: finalized.byteLength,
            };
            contentItems.push(contentItem);
            uploadedAttachments.push({
              attachmentId: attachment.attachmentId,
              attachmentIndex: attachment.attachmentIndex,
              fileSizeBytes: attachment.fileSizeBytes,
              sha256,
              uploadId: finalized.uploadId,
              expiresAt: init.expiresAt,
              ...contentItem,
            });
          } catch (error) {
            await uploadClient.abortUpload(init.uploadId).catch(() => undefined);
            throw error;
          }
        }

        return {
          ...emailResult,
          attachmentCount: uploadedAttachments.length,
          attachments: uploadedAttachments,
          contentItems,
        };
      },
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
        name: "imap_list_attachments",
        description: describeForInstance("List unique indexed attachments with linked email metadata.", displayName),
        requiresPrivilegedAccess: true,
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum attachments to return (1-200)." },
            offset: { type: "number", description: "Offset for paginated attachment browsing." },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => service.listAttachments({
        limit: params["limit"] as number | undefined,
        offset: params["offset"] as number | undefined,
      }),
    },
    {
      metadata: {
        name: "imap_get_attachment",
        description: describeForInstance("Get one indexed attachment including extracted OCR/text and linked email metadata.", displayName),
        requiresPrivilegedAccess: true,
        parameters: {
          type: "object",
          properties: {
            attachmentId: { type: "string", description: "Internal indexed attachment id." },
          },
          required: ["attachmentId"],
        },
      },
      handler: async (params: Record<string, unknown>) => service.getAttachment({
        attachmentId: params["attachmentId"] as string,
      }),
    },
    {
      metadata: {
        name: "imap_get_attachment_file",
        description: describeForInstance(
          "Retrieve attachment file bytes for a specific indexed email message-id and filename, then return the match or matches as content items for downstream channel delivery.",
          displayName,
        ),
        requiresPrivilegedAccess: true,
        supportsContentUpload: true,
        parameters: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "RFC822 message-id of the indexed email." },
            fileName: { type: "string", description: "Attachment filename to retrieve. Duplicate filename matches are all returned." },
            ttlSeconds: { type: "number", description: "Optional attachment content TTL in seconds. When omitted, the gateway default upload TTL is used." },
          },
          required: ["messageId", "fileName"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const messageId = typeof params["messageId"] === "string" ? params["messageId"].trim() : "";
        const fileName = typeof params["fileName"] === "string" ? params["fileName"].trim() : "";
        if (!messageId) {
          throw new Error("imap_get_attachment_file: 'messageId' is required");
        }
        if (!fileName) {
          throw new Error("imap_get_attachment_file: 'fileName' is required");
        }

        const ttlSeconds = typeof params["ttlSeconds"] === "number"
          ? Math.floor(params["ttlSeconds"])
          : undefined;
        if (ttlSeconds !== undefined && ttlSeconds <= 0) {
          throw new Error("imap_get_attachment_file: 'ttlSeconds' must be a positive integer when provided");
        }

        const uploadAuth = readUploadAuth(params);
        const uploadClient = new GatewayContentUploadClient(uploadAuth);
        const result = await service.getAttachmentFiles({
          messageId,
          fileName,
        });

        const uploadedAttachments = [] as Array<Record<string, unknown>>;
        const contentItems = [] as Array<Record<string, unknown>>;

        for (const attachment of result.attachments) {
          const sha256 = createHash("sha256").update(attachment.content).digest("hex");
          const init = await uploadClient.initUpload({
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            expectedBytes: attachment.content.byteLength,
            ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
          });

          try {
            let chunkIndex = 0;
            for (let offset = 0; offset < attachment.content.byteLength; offset += DEFAULT_UPLOAD_CHUNK_BYTES) {
              const chunk = attachment.content.subarray(
                offset,
                Math.min(offset + DEFAULT_UPLOAD_CHUNK_BYTES, attachment.content.byteLength),
              );
              await uploadClient.appendChunk(init.uploadId, chunkIndex, chunk);
              chunkIndex += 1;
            }

            const finalized = await uploadClient.finalizeUpload(init.uploadId, sha256);
            const contentItem = {
              contentRef: finalized.contentRef,
              fileName: finalized.fileName ?? attachment.fileName,
              mimeType: finalized.mimeType ?? attachment.mimeType,
              byteLength: finalized.byteLength,
            };
            contentItems.push(contentItem);
            uploadedAttachments.push({
              attachmentId: attachment.attachmentId,
              attachmentIndex: attachment.attachmentIndex,
              fileSizeBytes: attachment.fileSizeBytes,
              sha256,
              uploadId: finalized.uploadId,
              expiresAt: init.expiresAt,
              ...contentItem,
            });
          } catch (error) {
            await uploadClient.abortUpload(init.uploadId).catch(() => undefined);
            throw error;
          }
        }

        const itemUrl = typeof result.email["itemUrl"] === "string" ? result.email["itemUrl"] : undefined;
        const subject = typeof result.email["subject"] === "string" ? result.email["subject"] : undefined;
        const references = itemUrl
          ? [{
              url: itemUrl,
              title: subject?.trim().length ? subject : itemUrl,
              kind: "email",
              sourceTool: "imap_get_attachment_file",
            }]
          : [];

        return {
          displayName,
          messageId,
          requestedFileName: fileName,
          matchCount: uploadedAttachments.length,
          email: result.email,
          attachments: uploadedAttachments,
          contentItems,
          references,
        };
      },
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
