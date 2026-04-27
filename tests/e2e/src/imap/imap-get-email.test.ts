/**
 * E2E tests for the `imap_get_email` tool.
 *
 * Requires a running tool-imap instance.  Configure via environment variables
 * (see src/helpers/TestConfig.ts for the full list).
 *
 * Quick start:
 *   E2E_IMAP_TOOL_KEY=imap-gmail pnpm --filter @langgraph-glove/tests-e2e test:imap
 *
 * What is tested:
 *   1. `imap_get_email` can retrieve an email by emailId returned from a prior
 *      `imap_search` call.
 *   2. When the retrieved email has attachments, the tool successfully fetches
 *      the attachment bytes from the IMAP server and uploads them via the
 *      content-upload path.
 *   3. Detailed diagnostic output is printed at each step so that the
 *      uid-mismatch error ("Email source not found on IMAP server for folder
 *      … uid …") can be traced to the exact email record.
 *
 * Background — the UID bug:
 *   `ImapIndexService.fetchIndexedEmailSourceByUid` calls
 *   `client.fetch(String(uid), { uid: true, envelope: true, source: true, threadId: true })`
 *   where `uid: true` is placed in the *query fields* object (second argument).
 *   That flag tells ImapFlow to *return* the UID field in the response, but it
 *   does NOT tell ImapFlow to interpret the range as UIDs — that requires a
 *   *third* argument `{ uid: true }`.  Without the third argument ImapFlow
 *   treats the range as a sequence number, which is a different value.  When
 *   sequence numbers differ from UIDs (the common case after deletions or
 *   expunges) the wrong message — or no message at all — is fetched, and the
 *   tool throws an internal error.
 *
 *   The test suite surfaces this by logging the uid and the actual error
 *   returned, making the root cause easy to confirm.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadE2EConfig } from "../helpers/TestConfig.js";
import {
  ToolRpcClient,
  socketPathForTool,
} from "../helpers/RpcClient.js";
import { ContentUploadStub } from "../helpers/ContentUploadStub.js";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const config = loadE2EConfig();

let client: ToolRpcClient;
let uploadStub: ContentUploadStub | undefined;
let uploadAuth: Record<string, unknown>;

/** Emails discovered via imap_search that we use as fixtures for imap_get_email. */
interface EmailFixture {
  id: string;
  uid: number;
  folder: string;
  messageId: string | null;
  subject: string;
  hasAttachments: boolean;
}

let emailFixtures: EmailFixture[] = [];

beforeAll(async () => {
  // Build the RPC client.
  if (config.imapTransport === "http") {
    client = new ToolRpcClient({
      transport: "http",
      baseUrl: config.imapHttpUrl!,
      timeoutMs: 60_000,
    });
  } else {
    client = new ToolRpcClient({
      transport: "unix-socket",
      socketPath: socketPathForTool(config.imapToolKey),
      timeoutMs: 60_000,
    });
  }

  // Set up content-upload auth.
  if (config.contentUploadUrl) {
    uploadAuth = {
      token: process.env["E2E_CONTENT_UPLOAD_TOKEN"] ?? "e2e-test-token",
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      transport: "http",
      gatewayBaseUrl: config.contentUploadUrl,
    };
  } else {
    uploadStub = new ContentUploadStub();
    await uploadStub.start();
    uploadAuth = uploadStub.makeUploadAuth();
  }

  console.log(
    `[e2e] imap_get_email — tool: ${config.imapToolKey}, transport: ${config.imapTransport}`,
  );

  // Discover real email fixtures by running a broad search.
  // We intentionally use a search that is likely to include emails both with
  // and without attachments.
  try {
    const searchResponse = await client.call("imap_search", {
      query: config.searchQuery,
      limit: 10,
      contentUploadAuth: uploadAuth,
    });

    if (!searchResponse.error) {
      const result = searchResponse.result as Record<string, unknown>;
      const results = result["results"] as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(results)) {
        for (const entry of results) {
          const email = entry["email"] as Record<string, unknown> | undefined;
          if (!email) continue;
          emailFixtures.push({
            id: String(email["id"] ?? ""),
            uid: Number(email["uid"] ?? 0),
            folder: String(email["folder"] ?? ""),
            messageId: typeof email["messageId"] === "string" ? email["messageId"] : null,
            subject: String(email["subject"] ?? "(no subject)"),
            hasAttachments: Boolean(
              typeof email["attachmentCount"] === "number"
                ? email["attachmentCount"] > 0
                : (entry["chunkSource"] === "attachment"),
            ),
          });
        }
      }
    }

    // Also search specifically for emails with attachments.
    const attachmentSearchResponse = await client.call("imap_search", {
      query: config.searchQuery,
      hasAttachments: true,
      limit: 5,
      contentUploadAuth: uploadAuth,
    });
    if (!attachmentSearchResponse.error) {
      const result = attachmentSearchResponse.result as Record<string, unknown>;
      const results = result["results"] as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(results)) {
        for (const entry of results) {
          const email = entry["email"] as Record<string, unknown> | undefined;
          if (!email) continue;
          const id = String(email["id"] ?? "");
          // Avoid duplicates.
          if (!emailFixtures.some((f) => f.id === id)) {
            emailFixtures.push({
              id,
              uid: Number(email["uid"] ?? 0),
              folder: String(email["folder"] ?? ""),
              messageId: typeof email["messageId"] === "string" ? email["messageId"] : null,
              subject: String(email["subject"] ?? "(no subject)"),
              hasAttachments: true,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn("[e2e] Could not load email fixtures from imap_search:", err);
  }

  console.log(`[e2e] loaded ${emailFixtures.length} email fixture(s) for imap_get_email tests`);
  for (const f of emailFixtures) {
    console.log(
      `[e2e]   fixture — id: ${f.id}, uid: ${f.uid}, folder: ${f.folder}, ` +
      `messageId: ${f.messageId}, subject: "${f.subject}", hasAttachments: ${f.hasAttachments}`,
    );
  }
});

afterAll(async () => {
  await uploadStub?.stop();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("imap_get_email — retrieval by emailId", () => {
  it("retrieves an email without error for each fixture", async () => {
    if (emailFixtures.length === 0) {
      console.warn("[e2e] No email fixtures available — skipping.");
      return;
    }

    for (const fixture of emailFixtures.slice(0, 5)) {
      console.log(
        `[e2e] calling imap_get_email for emailId="${fixture.id}" ` +
        `(uid=${fixture.uid}, folder="${fixture.folder}")`,
      );

      const response = await client.call("imap_get_email", {
        emailId: fixture.id,
        contentUploadAuth: uploadAuth,
      });

      console.log(
        `[e2e] imap_get_email response for emailId="${fixture.id}":`,
        JSON.stringify(response, null, 2),
      );

      if (response.error) {
        console.error(
          `[e2e] ERROR for emailId="${fixture.id}" (uid=${fixture.uid}, folder="${fixture.folder}"):`,
          response.error,
        );
        console.error(
          "[e2e] DIAGNOSTIC: If the error mentions uid or 'Email source not found', " +
          "this confirms the UID mismatch bug in fetchIndexedEmailSourceByUid. " +
          `The stored uid is ${fixture.uid} but ImapFlow may be treating it as a ` +
          "sequence number.  Check that client.fetch() receives { uid: true } as " +
          "the *third* argument (options), not as part of the query fields.",
        );
      }

      expect(response.error).toBeUndefined();

      const result = response.result as Record<string, unknown>;
      expect(result).toBeTruthy();
      expect(result).toHaveProperty("email");
    }
  });
});

describe("imap_get_email — attachment content items (exercises full UID fetch path)", () => {
  it("returns attachment content items for emails that have attachments", async () => {
    const attachmentFixtures = emailFixtures.filter((f) => f.hasAttachments);

    if (attachmentFixtures.length === 0) {
      console.warn(
        "[e2e] No email fixtures with attachments found — " +
        "ensure the indexed mailbox has at least one email with an attachment.",
      );
      return;
    }

    for (const fixture of attachmentFixtures.slice(0, 3)) {
      console.log(
        `[e2e] calling imap_get_email (with attachment) for emailId="${fixture.id}" ` +
        `(uid=${fixture.uid}, folder="${fixture.folder}", messageId="${fixture.messageId}")`,
      );

      const response = await client.call("imap_get_email", {
        emailId: fixture.id,
        contentUploadAuth: uploadAuth,
      });

      console.log(
        `[e2e] imap_get_email (attachment) response for emailId="${fixture.id}":`,
        JSON.stringify(response, null, 2),
      );

      if (response.error) {
        console.error(
          `[e2e] ERROR retrieving attachment for emailId="${fixture.id}" ` +
          `(uid=${fixture.uid}, folder="${fixture.folder}", messageId="${fixture.messageId}"):`,
          response.error,
        );
        console.error(
          "[e2e] DIAGNOSTIC — UID mismatch check:\n" +
          `  Stored UID in index: ${fixture.uid}\n` +
          `  Folder: "${fixture.folder}"\n` +
          `  MessageId: "${fixture.messageId}"\n` +
          "  In ImapIndexService.fetchIndexedEmailSourceByUid, the call:\n" +
          "    client.fetch(String(uid), { uid: true, envelope: true, source: true, threadId: true })\n" +
          "  passes uid: true in the *query fields* (2nd arg), not the *options* (3rd arg).\n" +
          "  ImapFlow therefore treats the range as a sequence number, not a UID.\n" +
          "  Fix: client.fetch(String(uid), { envelope: true, source: true, threadId: true }, { uid: true })",
        );
      }

      expect(response.error).toBeUndefined();

      const result = response.result as Record<string, unknown>;
      const contentItems = result["contentItems"] as unknown[] | undefined;
      const attachmentCount = result["attachmentCount"];

      console.log(`[e2e] attachmentCount: ${attachmentCount}, contentItems: ${contentItems?.length ?? 0}`);

      expect(typeof attachmentCount).toBe("number");
      expect((attachmentCount as number)).toBeGreaterThan(0);
      expect(Array.isArray(contentItems)).toBe(true);
      expect((contentItems as unknown[]).length).toBeGreaterThan(0);

      for (const item of contentItems ?? []) {
        const ci = item as Record<string, unknown>;
        console.log(
          `[e2e]   contentItem — contentRef: ${ci["contentRef"]}, ` +
          `fileName: ${ci["fileName"]}, mimeType: ${ci["mimeType"]}, bytes: ${ci["byteLength"]}`,
        );
        expect(ci).toHaveProperty("contentRef");
        expect(ci).toHaveProperty("fileName");
        expect(ci).toHaveProperty("mimeType");
      }
    }
  });

  it("retrieval by messageId also returns attachment content items", async () => {
    const attachmentFixtures = emailFixtures.filter((f) => f.hasAttachments && f.messageId);

    if (attachmentFixtures.length === 0) {
      console.warn("[e2e] No attachment fixtures with messageId — skipping.");
      return;
    }

    const fixture = attachmentFixtures[0]!;
    console.log(
      `[e2e] calling imap_get_email by messageId="${fixture.messageId}" ` +
      `(uid=${fixture.uid}, folder="${fixture.folder}")`,
    );

    const response = await client.call("imap_get_email", {
      messageId: fixture.messageId,
      contentUploadAuth: uploadAuth,
    });

    console.log(
      "[e2e] imap_get_email (by messageId) response:",
      JSON.stringify(response, null, 2),
    );

    if (response.error) {
      console.error(
        `[e2e] ERROR (by messageId "${fixture.messageId}"):`, response.error,
      );
    }

    expect(response.error).toBeUndefined();

    const result = response.result as Record<string, unknown>;
    const contentItems = result["contentItems"] as unknown[] | undefined;
    expect(Array.isArray(contentItems)).toBe(true);
    expect((contentItems as unknown[]).length).toBeGreaterThan(0);
  });
});
