const SAFE_PROTOCOLS = new Set(["http:", "https:"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

export function isSafeHref(href: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
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
