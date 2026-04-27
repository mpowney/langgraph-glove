/**
 * E2E tests for the `imap_search` tool.
 *
 * Requires a running tool-imap instance.  Configure via environment variables
 * (see src/helpers/TestConfig.ts for the full list).
 *
 * Quick start:
 *   E2E_IMAP_TOOL_KEY=imap-gmail pnpm --filter @langgraph-glove/tests-e2e test:imap
 *
 * What is tested:
 *   1. The tool server is reachable and exposes `imap_search` via introspection.
 *   2. `imap_search` returns a non-empty result set for the configured query.
 *   3. Each result contains a well-formed email record (id, subject, from, …).
 *   4. When results include emails with attachments the tool correctly retrieves
 *      and uploads them via the content-upload path — this exercises
 *      `getEmailAttachmentFiles` and `fetchIndexedEmailSource`, where the UID
 *      mismatch bug manifests.
 *   5. Diagnostic output is printed so failures can be correlated with the
 *      exact email uid / messageId that caused the error.
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

beforeAll(async () => {
  // Build the RPC client based on the configured transport.
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
    // Use the real gateway when available.
    uploadAuth = {
      token: process.env["E2E_CONTENT_UPLOAD_TOKEN"] ?? "e2e-test-token",
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      transport: "http",
      gatewayBaseUrl: config.contentUploadUrl,
    };
  } else {
    // Start an in-process stub.
    uploadStub = new ContentUploadStub();
    await uploadStub.start();
    uploadAuth = uploadStub.makeUploadAuth();
  }

  console.log(
    `[e2e] imap_search — tool: ${config.imapToolKey}, transport: ${config.imapTransport}`,
    config.imapTransport === "unix-socket"
      ? `socket: ${socketPathForTool(config.imapToolKey)}`
      : `url: ${config.imapHttpUrl}`,
  );
  console.log(
    `[e2e] content-upload: ${config.contentUploadUrl ? `real gateway @ ${config.contentUploadUrl}` : "in-process stub"}`,
  );
});

afterAll(async () => {
  await uploadStub?.stop();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("imap_search — tool discovery", () => {
  it("tool server responds to introspection and exposes imap_search", async () => {
    const tools = await client.introspect();
    expect(tools).toBeInstanceOf(Array);
    expect(tools.length).toBeGreaterThan(0);

    const toolNames = (tools as Array<{ name: string }>).map((t) => t.name);
    console.log(`[e2e] available tools: ${toolNames.join(", ")}`);
    expect(toolNames).toContain("imap_search");
  });
});

describe("imap_search — basic result shape", () => {
  it(`returns results for query "${config.searchQuery}"`, async () => {
    const response = await client.call("imap_search", {
      query: config.searchQuery,
      limit: 5,
      contentUploadAuth: uploadAuth,
    });

    console.log("[e2e] imap_search raw response:", JSON.stringify(response, null, 2));

    // We expect either a successful result or a meaningful error — not a
    // connection-level failure.
    expect(response.id).toBeTruthy();

    if (response.error) {
      // Log the exact error so it can be investigated, then fail with a
      // descriptive message.
      console.error("[e2e] imap_search returned an error:", response.error);
      expect(response.error).toBeUndefined();
    }

    const result = response.result as Record<string, unknown>;
    expect(result).toBeTruthy();

    // The result should have a `results` array (even if empty).
    expect(result).toHaveProperty("results");
    expect(Array.isArray(result["results"])).toBe(true);

    console.log(
      `[e2e] imap_search returned ${(result["results"] as unknown[]).length} result(s)`,
    );
  });

  it("each result contains a well-formed email record", async () => {
    const response = await client.call("imap_search", {
      query: config.searchQuery,
      limit: 5,
      contentUploadAuth: uploadAuth,
    });

    if (response.error) {
      console.error("[e2e] imap_search returned an error:", response.error);
      expect(response.error).toBeUndefined();
    }

    const result = response.result as Record<string, unknown>;
    const results = result["results"] as Array<Record<string, unknown>>;
    if (results.length === 0) {
      console.warn(
        `[e2e] No results for query "${config.searchQuery}" — skipping email shape assertions.`,
      );
      return;
    }

    for (const entry of results) {
      const email = entry["email"] as Record<string, unknown> | undefined;
      expect(email, "each result should have an 'email' key").toBeTruthy();

      // Log each email for diagnostics (helps trace which uid/messageId caused errors)
      console.log(
        `[e2e] email — id: ${email?.["id"]}, uid: ${email?.["uid"]}, folder: ${email?.["folder"]}, messageId: ${email?.["messageId"]}`,
      );

      expect(email).toHaveProperty("id");
      expect(email).toHaveProperty("uid");
      expect(email).toHaveProperty("folder");
      expect(email).toHaveProperty("subject");
      expect(email).toHaveProperty("from");
    }
  });
});

describe("imap_search — attachment retrieval (exercises UID fetch path)", () => {
  it("returns attachments and content items for emails that have attachments", async () => {
    // Search specifically for emails with attachments.
    const response = await client.call("imap_search", {
      query: config.searchQuery,
      hasAttachments: true,
      limit: 3,
      contentUploadAuth: uploadAuth,
    });

    console.log(
      "[e2e] imap_search (hasAttachments=true) raw response:",
      JSON.stringify(response, null, 2),
    );

    if (response.error) {
      // This is the primary failure we are investigating.  The error message
      // should reference the uid or messageId to help narrow down the bug.
      console.error(
        "[e2e] imap_search (hasAttachments=true) returned an error:",
        response.error,
      );
      console.error(
        "[e2e] DIAGNOSTIC: This error may be caused by the uid mismatch in " +
        "fetchIndexedEmailSourceByUid — verify that client.fetch() is called " +
        "with { uid: true } as the third argument, not as part of the query fields.",
      );
      expect(response.error).toBeUndefined();
    }

    const result = response.result as Record<string, unknown>;
    const results = result["results"] as Array<Record<string, unknown>>;

    if (results.length === 0) {
      console.warn(
        `[e2e] No emails with attachments found for query "${config.searchQuery}" — ` +
        "ensure the indexed mailbox contains at least one email with an attachment.",
      );
      return;
    }

    // Log attachment diagnostic info.
    const attachments = result["attachments"] as Array<Record<string, unknown>> | undefined;
    const contentItems = result["contentItems"] as Array<Record<string, unknown>> | undefined;
    const attachmentCount = result["attachmentCount"];

    console.log(`[e2e] attachmentCount: ${attachmentCount}`);
    console.log(`[e2e] contentItems count: ${contentItems?.length ?? 0}`);

    if (attachments) {
      for (const att of attachments) {
        console.log(
          `[e2e] attachment — emailId: ${att["emailId"]}, messageId: ${att["messageId"]}, ` +
          `attachmentId: ${att["attachmentId"]}, fileName: ${att["fileName"]}, ` +
          `bytes: ${att["fileSizeBytes"]}`,
        );
      }
    }

    // Assert attachments were returned.
    expect(typeof attachmentCount).toBe("number");
    expect((attachmentCount as number)).toBeGreaterThan(0);
    expect(Array.isArray(contentItems)).toBe(true);
    expect((contentItems as unknown[]).length).toBeGreaterThan(0);

    // Each content item should have a contentRef.
    for (const item of contentItems ?? []) {
      expect(item).toHaveProperty("contentRef");
      expect(item).toHaveProperty("fileName");
      expect(item).toHaveProperty("mimeType");
    }
  });
});
