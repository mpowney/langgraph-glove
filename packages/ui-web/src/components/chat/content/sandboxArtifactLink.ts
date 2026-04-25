const DEFAULT_SAFE_PROTOCOLS = new Set(["http", "https", "sandbox"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

function normalizeProtocol(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  let normalized = trimmed;
  if (normalized.endsWith(":")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.endsWith("://")) {
    normalized = normalized.slice(0, -3);
  }

  if (!/^[a-z][a-z0-9+.-]*$/u.test(normalized)) {
    return null;
  }

  return normalized;
}

function getAllowedProtocolSet(allowedProtocols?: string[]): Set<string> {
  const merged = new Set<string>(DEFAULT_SAFE_PROTOCOLS);
  for (const value of allowedProtocols ?? []) {
    const normalized = normalizeProtocol(value);
    if (normalized) {
      merged.add(normalized);
    }
  }
  return merged;
}

export function isSafeHref(href: string, allowedProtocols?: string[]): boolean {
  try {
    const protocol = new URL(href).protocol.replace(/:$/u, "").toLowerCase();
    return getAllowedProtocolSet(allowedProtocols).has(protocol);
  } catch {
    return false;
  }
}

export function isSandboxArtifactHref(href: string): boolean {
  try {
    const parsed = new URL(href);
    return parsed.protocol === "sandbox:" && parsed.pathname.startsWith("/mnt/data/");
  } catch {
    return href.startsWith("sandbox:/mnt/data/");
  }
}

export function getSandboxFilename(href: string): string {
  try {
    const parsed = new URL(href);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] ?? href : href;
  } catch {
    const normalized = href.replace(/^sandbox:/, "");
    const pathOnly = normalized.split("?")[0] ?? normalized;
    const parts = pathOnly.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] ?? href : href;
  }
}

export function isImageArtifactFileName(fileName: string): boolean {
  const nameParts = fileName.toLowerCase().split(".");
  const extension = nameParts.length > 1 ? nameParts[nameParts.length - 1] ?? "" : "";
  return IMAGE_EXTENSIONS.has(extension);
}

/**
 * Determines the display filename for a content item.
 * Priority: fileName > extracted from href path > fallback label
 * Ensures consistent display across all LinkPill locations.
 */
export function getContentItemDisplayName(
  fileName: string | undefined,
  href: string | undefined,
  fallback: string = "Attached file"
): string {
  // Use provided fileName if available
  if (fileName?.trim()) {
    return fileName.trim();
  }

  // Try to extract filename from the href path
  if (href && isSandboxArtifactHref(href)) {
    const extracted = getSandboxFilename(href);
    // Only use extracted name if it's not just "Attached file" (the fallback we'd embed)
    if (extracted && extracted !== fallback && extracted !== href) {
      return extracted;
    }
  }

  // Fall back to the provided fallback label
  return fallback;
}
