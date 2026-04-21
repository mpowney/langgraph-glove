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
  const normalized = href.replace(/^sandbox:/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] ?? href : href;
}

export function isImageArtifactFileName(fileName: string): boolean {
  const nameParts = fileName.toLowerCase().split(".");
  const extension = nameParts.length > 1 ? nameParts[nameParts.length - 1] ?? "" : "";
  return IMAGE_EXTENSIONS.has(extension);
}
