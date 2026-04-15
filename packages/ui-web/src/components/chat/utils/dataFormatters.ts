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

export function formatMessageTimestamp(isoString?: string): string | null {
  if (!isoString) return null;

  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const messageDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor((today.getTime() - messageDate.getTime()) / (1000 * 60 * 60 * 24));

    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    if (diffDays === 0) {
      return timeStr;
    } else if (diffDays === 1) {
      return `Yesterday ${timeStr}`;
    } else if (diffDays < 7) {
      return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${timeStr}`;
    }
    return date.toLocaleDateString("en-US", {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return null;
  }
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
