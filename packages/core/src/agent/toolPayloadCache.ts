import { randomUUID } from "node:crypto";

const TOOL_MESSAGE_CACHE_MAX_ITEMS = Number.parseInt(
  process.env.GLOVE_TOOL_MESSAGE_CACHE_MAX_ITEMS ?? "256",
  10,
);

const oversizedToolPayloadCache = new Map<string, string>();

export function storeToolPayload(payload: string): string {
  const ref = `tool_payload_${randomUUID()}`;
  oversizedToolPayloadCache.set(ref, payload);

  while (oversizedToolPayloadCache.size > TOOL_MESSAGE_CACHE_MAX_ITEMS) {
    const oldestKey = oversizedToolPayloadCache.keys().next().value;
    if (!oldestKey) break;
    oversizedToolPayloadCache.delete(oldestKey);
  }

  return ref;
}

export function getToolPayload(ref: string): string | null {
  return oversizedToolPayloadCache.get(ref) ?? null;
}
