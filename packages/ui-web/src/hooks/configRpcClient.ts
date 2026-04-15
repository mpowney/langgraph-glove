import type {
  ConfigFileSummary,
  ConfigValidationIssue,
  ConfigVersion,
  ConfigVersionSummary,
} from "../types";
import { createUuid } from "../uuid";

interface RpcResponse<T> {
  id: string;
  result?: T;
  error?: string;
}

export async function callConfigTool<T>(
  configToolUrl: string,
  method: string,
  params: Record<string, unknown>,
  authToken?: string,
): Promise<T> {
  if (!configToolUrl) {
    throw new Error("Config tool endpoint is not configured");
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const trimmedToken = authToken?.trim();
  if (trimmedToken) {
    headers.Authorization = `Bearer ${trimmedToken}`;
  }

  const res = await fetch(`${configToolUrl}/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: createUuid(),
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const payload = (await res.json()) as RpcResponse<T>;
  if (payload.error !== undefined) {
    throw new Error(payload.error);
  }
  if (payload.result === undefined) {
    throw new Error("RPC response missing result");
  }

  return payload.result;
}

export async function listConfigFiles(
  configToolUrl: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
): Promise<ConfigFileSummary[]> {
  const raw = await callConfigTool<string>(
    configToolUrl,
    "config_list_files",
    { privilegeGrantId, conversationId },
    authToken,
  );
  return JSON.parse(raw) as ConfigFileSummary[];
}

export async function readConfigFile(
  configToolUrl: string,
  file: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
): Promise<string> {
  return callConfigTool<string>(
    configToolUrl,
    "config_read_file",
    { file, privilegeGrantId, conversationId },
    authToken,
  );
}

export async function writeConfigFile(
  configToolUrl: string,
  file: string,
  content: string,
  description: string | undefined,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
): Promise<void> {
  await callConfigTool<string>(
    configToolUrl,
    "config_write_file",
    { file, content, description, privilegeGrantId, conversationId },
    authToken,
  );
}

export async function listConfigHistory(
  configToolUrl: string,
  file: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
): Promise<ConfigVersionSummary[]> {
  const raw = await callConfigTool<string>(
    configToolUrl,
    "config_list_history",
    { file, privilegeGrantId, conversationId },
    authToken,
  );
  return JSON.parse(raw) as ConfigVersionSummary[];
}

export async function getConfigVersion(
  configToolUrl: string,
  versionId: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
): Promise<ConfigVersion> {
  const raw = await callConfigTool<string>(
    configToolUrl,
    "config_get_version",
    { versionId, privilegeGrantId, conversationId },
    authToken,
  );
  return JSON.parse(raw) as ConfigVersion;
}

export async function listSecretFiles(
  adminApiUrl: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
): Promise<Array<{ name: string }>> {
  const url = `${adminApiUrl}/api/secrets/files`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Privilege-Grant-Id": privilegeGrantId,
    "X-Conversation-Id": conversationId,
  };
  if (authToken?.trim()) headers.Authorization = `Bearer ${authToken.trim()}`;

  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as Array<{ name: string }>;
}

export async function listSecrets(
  adminApiUrl: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
): Promise<Array<{ name: string; file: string }>> {
  const url = `${adminApiUrl}/api/secrets`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Privilege-Grant-Id": privilegeGrantId,
    "X-Conversation-Id": conversationId,
  };
  if (authToken?.trim()) headers.Authorization = `Bearer ${authToken.trim()}`;

  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as Array<{ name: string; file: string }>;
}

export async function getSecret(
  adminApiUrl: string,
  name: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
): Promise<{ name: string; value: string; file: string }> {
  const url = `${adminApiUrl}/api/secrets/${encodeURIComponent(name)}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Privilege-Grant-Id": privilegeGrantId,
    "X-Conversation-Id": conversationId,
  };
  if (authToken?.trim()) headers.Authorization = `Bearer ${authToken.trim()}`;

  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as { name: string; value: string; file: string };
}

export async function upsertSecret(
  adminApiUrl: string,
  file: string,
  name: string,
  value: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
): Promise<void> {
  const url = `${adminApiUrl}/api/secrets`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken?.trim()) headers.Authorization = `Bearer ${authToken.trim()}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ grantId: privilegeGrantId, conversationId, file, name, value }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export async function validateConfigFile(
  configToolUrl: string,
  file: string,
  content: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
): Promise<ConfigValidationIssue[]> {
  const raw = await callConfigTool<string>(
    configToolUrl,
    "config_validate_file",
    { file, content, privilegeGrantId, conversationId },
    authToken,
  );
  return JSON.parse(raw) as ConfigValidationIssue[];
}
