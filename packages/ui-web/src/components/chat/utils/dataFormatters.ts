import type { CheckpointMetadata } from "../../../types";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toDisplayJson(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? fallback;
  } catch {
    return fallback;
  }
}

export function isEmptyPayload(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

export function isSpecificToolName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "tool";
}

export function tryFormatJsonString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const startsLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"');
  if (!startsLikeJson) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

export function formatReceivedAtTimestamp(receivedAt?: string): string {
  if (!receivedAt) return "unknown time";
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) return receivedAt;
  return date.toLocaleString();
}

export function resolveDisplayTimestamp(checkpoint?: CheckpointMetadata, receivedAt?: string): string {
  if (checkpoint?.timestamp) {
    const date = new Date(checkpoint.timestamp);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
    return checkpoint.timestamp;
  }
  return formatReceivedAtTimestamp(receivedAt);
}
