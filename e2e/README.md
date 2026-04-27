# E2E Tests — langgraph-glove

End-to-end tests that run against a **live local instance** of the solution.
No mock services are required (beyond the optional in-process content-upload stub).

## Prerequisites

1. A running **tool-imap** server (e.g. `imap-gmail` or `imap-icloud`).
2. The tool must have already indexed at least one email — ideally one with an
   attachment — via `imap_crawl`.

## Running the tests

```bash
# Install e2e dependencies
cd e2e && pnpm install

# Run all e2e tests (unix-socket transport, imap-gmail key)
E2E_IMAP_TOOL_KEY=imap-gmail pnpm test

# Run only the IMAP tests
E2E_IMAP_TOOL_KEY=imap-gmail pnpm test:imap

# Use HTTP transport instead of unix-socket
E2E_IMAP_TOOL_KEY=imap-gmail E2E_IMAP_HTTP_URL=http://localhost:3020 pnpm test:imap
```

Or from the workspace root:

```bash
E2E_IMAP_TOOL_KEY=imap-gmail pnpm e2e
```

## Environment variables

| Variable                  | Default        | Description |
|---------------------------|----------------|-------------|
| `E2E_IMAP_TOOL_KEY`       | `imap-gmail`   | Tool key from `tools.json` (used to derive the unix-socket path). |
| `E2E_IMAP_HTTP_URL`       | *(unset)*      | When set, use HTTP transport instead of unix-socket. Example: `http://localhost:3020`. |
| `E2E_CONTENT_UPLOAD_URL`  | *(unset)*      | Base URL of a real gateway for content uploads. When omitted an in-process stub is started automatically. |
| `E2E_CONTENT_UPLOAD_TOKEN`| `e2e-test-token` | Auth token when `E2E_CONTENT_UPLOAD_URL` is set. |
| `E2E_SEARCH_QUERY`        | `attachment`   | Default query string for `imap_search` tests. |

## IMAP attachment / UID bug investigation

The `imap_get_email` test suite includes detailed diagnostic output designed to
surface the following bug:

> `ImapIndexService.fetchIndexedEmailSourceByUid` calls
> `client.fetch(String(uid), { uid: true, … })` with `uid: true` in the
> **query fields** (second argument) rather than the **options** (third
> argument).  ImapFlow therefore treats the sequence range as a sequence
> number, not a UID.  When sequence numbers diverge from UIDs — which happens
> after deletions or expunges — the wrong message or no message is returned,
> causing the error:
> `"Email source not found on IMAP server for folder … uid …"`.

When the bug is present the test output will include a `DIAGNOSTIC` block that
prints the stored uid, folder, and messageId, plus the exact fix required.

### Fix

In `packages/tool-imap/src/ImapIndexService.ts`, inside
`fetchIndexedEmailSourceByUid`, change:

```typescript
// Before (broken — uid: true in query fields)
for await (const message of client.fetch(String(uid), {
  uid: true,
  envelope: true,
  source: true,
  threadId: true,
})) {
```

```typescript
// After (correct — uid: true in options)
for await (const message of client.fetch(String(uid), {
  envelope: true,
  source: true,
  threadId: true,
}, { uid: true })) {
```
