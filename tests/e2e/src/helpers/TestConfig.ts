/**
 * E2E Test Configuration
 *
 * All settings are driven by environment variables so that the same test
 * binary can be pointed at different running instances without code changes.
 *
 * Required env vars (at least one tool transport must be reachable):
 *
 *   E2E_IMAP_TOOL_KEY        - Key name of the IMAP tool instance (e.g. "imap-gmail").
 *                              Used to derive the unix-socket path unless
 *                              E2E_IMAP_HTTP_URL is set.
 *   E2E_IMAP_HTTP_URL        - If set, use HTTP transport instead of unix-socket.
 *                              Example: "http://localhost:3020"
 *
 * Optional:
 *   E2E_CONTENT_UPLOAD_URL   - Base URL of a running gateway that accepts the
 *                              content-upload RPC calls.  When omitted an
 *                              in-process stub server is started automatically.
 *   E2E_SEARCH_QUERY         - Default search query used in imap_search tests.
 *                              Defaults to "attachment".
 */

export interface E2EConfig {
  /** Unix-socket name derived from the tool key, e.g. "imap-my-tool" → socket at `/tmp/langgraph-glove-imap-my-tool.sock` */
  imapToolKey: string;
  /** Transport to use when calling the tool server. */
  imapTransport: "http" | "unix-socket";
  /** Base URL for HTTP transport (only used when imapTransport === "http"). */
  imapHttpUrl: string | undefined;
  /** Base URL of a real gateway content-upload endpoint. */
  contentUploadUrl: string | undefined;
  /** Default query for imap_search tests. */
  searchQuery: string;
}

export function loadE2EConfig(): E2EConfig {
  const imapToolKey = process.env["E2E_IMAP_TOOL_KEY"]?.trim() || "imap-gmail";
  const imapHttpUrl = process.env["E2E_IMAP_HTTP_URL"]?.trim() || undefined;
  const imapTransport: "http" | "unix-socket" = imapHttpUrl ? "http" : "unix-socket";
  const contentUploadUrl = process.env["E2E_CONTENT_UPLOAD_URL"]?.trim() || undefined;
  const searchQuery = process.env["E2E_SEARCH_QUERY"]?.trim() || "attachment";

  return {
    imapToolKey,
    imapTransport,
    imapHttpUrl,
    contentUploadUrl,
    searchQuery,
  };
}
