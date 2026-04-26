import { createUuid } from "../uuid";

interface RpcResponse<T> {
  id: string;
  result?: T;
  error?: string;
}

export interface ImapToolSummary {
  toolKey: string;
  displayName?: string;
  transport: "http" | "unix-socket";
  enabled: boolean;
  crawlMode: "manual" | "startup" | "continuous-sync";
  indexingStrategy: "immediate" | "deferred";
  indexDbPath?: string;
}

export interface ImapListToolsResult {
  generatedAt: string;
  count: number;
  tools: ImapToolSummary[];
}

export interface ImapToolStatusEntry {
  toolKey: string;
  status?: {
    crawlMode?: string;
    totals?: {
      emails?: number;
      chunks?: number;
      indexedEmbeddings?: number;
      queuedFiles?: number;
      indexedFiles?: number;
    };
    crawlRuntime?: {
      active?: boolean;
      currentFolder?: string | null;
      completedFolders?: number;
      totalFolders?: number;
      crawledEmails?: number;
      changedEmails?: number;
      indexedChunks?: number;
      elapsedMs?: number;
      startedAt?: string;
      lastFinishedAt?: string | null;
    };
  };
  error?: string;
}

export interface ImapCrawlStatusResult {
  generatedAt: string;
  tools: ImapToolStatusEntry[];
  summary: {
    totalTools: number;
    failedTools: number;
    activeCrawls: number;
  };
}

export interface ImapRemainingEstimateEntry {
  toolKey: string;
  estimate?: {
    available?: boolean;
    remainingEmails?: number | null;
    byFolder?: Array<{
      folder: string;
      crawledToUid: number;
      maxUid: number;
      remainingEmails: number;
    }>;
    error?: string;
    cache?: {
      hit?: boolean;
      ageMs?: number;
      ttlMs?: number;
    };
  };
  error?: string;
}

export interface ImapRemainingEstimateResult {
  generatedAt: string;
  tools: ImapRemainingEstimateEntry[];
  summary: {
    totalTools: number;
    failedTools: number;
    toolsWithEstimate: number;
    estimatedRemainingEmails: number;
  };
}

export interface ImapRemainingEstimateOptions {
  forceRefreshEstimate?: boolean;
}

export interface ImapClearIndexResult {
  toolKey: string;
  displayName?: string;
  clearedAt: string;
  countsBefore: {
    emails: number;
    chunks: number;
    embeddings: number;
    folderState: number;
  };
  nextCrawlMode: "manual" | "startup" | "continuous-sync";
  note: string;
}

function buildHeaders(
  authToken: string | undefined,
  privilegedGrantId: string,
  conversationId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Privilege-Grant-Id": privilegedGrantId,
    "X-Conversation-Id": conversationId,
  };
  const token = authToken?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function callImapRpc<T>(
  apiBaseUrl: string,
  method: string,
  params: Record<string, unknown>,
  authToken: string | undefined,
  privilegedGrantId: string,
  conversationId: string,
): Promise<T> {
  if (!privilegedGrantId.trim() || !conversationId.trim()) {
    throw new Error("Privileged access is required for IMAP status");
  }

  const response = await fetch(`${apiBaseUrl}/api/imap/rpc`, {
    method: "POST",
    headers: buildHeaders(authToken, privilegedGrantId, conversationId),
    body: JSON.stringify({
      id: createUuid(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = (await response.json()) as RpcResponse<T>;
  if (payload.error !== undefined) {
    throw new Error(payload.error);
  }
  if (payload.result === undefined) {
    throw new Error("RPC response missing result");
  }

  return payload.result;
}

export async function listImapInstances(
  apiBaseUrl: string,
  authToken: string | undefined,
  privilegedGrantId: string,
  conversationId: string,
): Promise<ImapListToolsResult> {
  if (!privilegedGrantId.trim() || !conversationId.trim()) {
    throw new Error("Privileged access is required for IMAP status");
  }

  const response = await fetch(`${apiBaseUrl}/api/imap/instances`, {
    method: "GET",
    headers: buildHeaders(authToken, privilegedGrantId, conversationId),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    generatedAt: string;
    count: number;
    instances: ImapToolSummary[];
  };

  return {
    generatedAt: payload.generatedAt,
    count: payload.count,
    tools: payload.instances,
  };
}

export async function listImapTools(
  apiBaseUrl: string,
  authToken: string | undefined,
  privilegedGrantId: string,
  conversationId: string,
): Promise<ImapListToolsResult> {
  return listImapInstances(apiBaseUrl, authToken, privilegedGrantId, conversationId);
}

export async function getImapCrawlStatus(
  apiBaseUrl: string,
  authToken: string | undefined,
  privilegedGrantId: string,
  conversationId: string,
): Promise<ImapCrawlStatusResult> {
  const instances = await listImapInstances(apiBaseUrl, authToken, privilegedGrantId, conversationId);
  const tools = await Promise.all(instances.tools.map(async ({ toolKey }) => {
    try {
      const status = await callImapRpc<ImapToolStatusEntry["status"]>(
        apiBaseUrl,
        "imap_status",
        { toolKey },
        authToken,
        privilegedGrantId,
        conversationId,
      );
      return { toolKey, status } satisfies ImapToolStatusEntry;
    } catch (err) {
      return {
        toolKey,
        error: err instanceof Error ? err.message : String(err),
      } satisfies ImapToolStatusEntry;
    }
  }));

  const summary = tools.reduce(
    (acc, entry) => {
      if (!entry.status) {
        acc.failedTools += 1;
        return acc;
      }
      if (entry.status.crawlRuntime?.active) {
        acc.activeCrawls += 1;
      }
      return acc;
    },
    {
      totalTools: tools.length,
      failedTools: 0,
      activeCrawls: 0,
    },
  );

  return {
    generatedAt: new Date().toISOString(),
    tools,
    summary,
  };
}

export async function getImapRemainingEstimate(
  apiBaseUrl: string,
  authToken: string | undefined,
  privilegedGrantId: string,
  conversationId: string,
  options: ImapRemainingEstimateOptions = {},
): Promise<ImapRemainingEstimateResult> {
  const instances = await listImapInstances(apiBaseUrl, authToken, privilegedGrantId, conversationId);
  const tools = await Promise.all(instances.tools.map(async ({ toolKey }) => {
    try {
      const estimate = await callImapRpc<ImapRemainingEstimateEntry["estimate"]>(
        apiBaseUrl,
        "imap_estimate_remaining",
        {
          toolKey,
          forceRefreshEstimate: options.forceRefreshEstimate,
        },
        authToken,
        privilegedGrantId,
        conversationId,
      );
      return { toolKey, estimate } satisfies ImapRemainingEstimateEntry;
    } catch (err) {
      return {
        toolKey,
        error: err instanceof Error ? err.message : String(err),
      } satisfies ImapRemainingEstimateEntry;
    }
  }));

  const summary = tools.reduce(
    (acc, entry) => {
      if (!entry.estimate) {
        acc.failedTools += 1;
        return acc;
      }
      const remaining = entry.estimate.remainingEmails;
      if (typeof remaining === "number" && Number.isFinite(remaining)) {
        acc.toolsWithEstimate += 1;
        acc.estimatedRemainingEmails += remaining;
      }
      return acc;
    },
    {
      totalTools: tools.length,
      failedTools: 0,
      toolsWithEstimate: 0,
      estimatedRemainingEmails: 0,
    },
  );

  return {
    generatedAt: new Date().toISOString(),
    tools,
    summary,
  };
}

export interface ImapStopCrawlResult {
  toolKey: string;
  displayName?: string;
  stopped: boolean;
  reason?: string;
}

export interface ImapStartCrawlResult {
  toolKey: string;
  displayName?: string;
  started: boolean;
  reason?: string;
}

export async function stopImapCrawl(
  apiBaseUrl: string,
  authToken: string | undefined,
  privilegedGrantId: string,
  conversationId: string,
  toolKey: string,
): Promise<ImapStopCrawlResult> {
  return callImapRpc<ImapStopCrawlResult>(
    apiBaseUrl,
    "imap_stop_crawl",
    { toolKey },
    authToken,
    privilegedGrantId,
    conversationId,
  );
}

export async function startImapCrawl(
  apiBaseUrl: string,
  authToken: string | undefined,
  privilegedGrantId: string,
  conversationId: string,
  toolKey: string,
): Promise<ImapStartCrawlResult> {
  return callImapRpc<ImapStartCrawlResult>(
    apiBaseUrl,
    "imap_start_crawl",
    { toolKey },
    authToken,
    privilegedGrantId,
    conversationId,
  );
}

export async function clearImapIndex(
  apiBaseUrl: string,
  authToken: string | undefined,
  privilegedGrantId: string,
  conversationId: string,
  toolKey: string,
): Promise<ImapClearIndexResult> {
  return callImapRpc<ImapClearIndexResult>(
    apiBaseUrl,
    "imap_clear_index",
    { toolKey },
    authToken,
    privilegedGrantId,
    conversationId,
  );
}
