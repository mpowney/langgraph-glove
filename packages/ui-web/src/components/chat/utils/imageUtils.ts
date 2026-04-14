import type { ReactNode } from "react";

// Base64 prefixes that uniquely identify common image formats.
// Each entry is the base64 encoding of the format's magic bytes.
const IMAGE_BASE64_PREFIXES: Array<{ prefix: string; mime: string }> = [
  { prefix: "/9j/", mime: "image/jpeg" },
  { prefix: "iVBORw0KGgo", mime: "image/png" },
  { prefix: "R0lGOD", mime: "image/gif" },
  { prefix: "UklGR", mime: "image/webp" },
  { prefix: "Qk0", mime: "image/bmp" },
];

// Matches markdown data-uri image, bare data-uri image, and standalone base64 image payloads.
const DATA_IMAGE_RE = new RegExp(
  String.raw`!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=\r\n]+?)\)`
    + "|"
    + String.raw`(?<!\()(data:image\/[^;]+;base64,[A-Za-z0-9+/=\r\n]+)`
    + "|"
    + `((?:${IMAGE_BASE64_PREFIXES.map((p) => p.prefix.replace(/[/+]/g, "\\$&")).join("|")})[A-Za-z0-9+/=\\r\\n]{50,})`,
  "g",
);

export type ContentSegment =
  | { kind: "text"; content: string }
  | { kind: "image"; src: string; alt: string };

export interface StructuredImagePayload {
  width?: number;
  height?: number;
  data: string;
  format: string;
  encoding?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeImageFormat(format: string): string | null {
  const normalized = format.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "jpg") return "jpeg";
  if (normalized === "svg") return "svg+xml";
  const supportedFormats = new Set(["png", "jpeg", "gif", "webp", "bmp", "svg+xml"]);
  return supportedFormats.has(normalized) ? normalized : null;
}

export function toImagePayload(value: unknown): StructuredImagePayload | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      return toImagePayload(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  if (!isRecord(value)) return null;
  if (typeof value.data !== "string" || typeof value.format !== "string") return null;
  if (value.encoding != null && value.encoding !== "base64") return null;
  if (value.width != null && typeof value.width !== "number") return null;
  if (value.height != null && typeof value.height !== "number") return null;

  const format = normalizeImageFormat(value.format);
  if (!format) return null;

  return {
    data: value.data.replace(/\s+/g, ""),
    format,
    encoding: typeof value.encoding === "string" ? value.encoding : "base64",
    width: typeof value.width === "number" ? value.width : undefined,
    height: typeof value.height === "number" ? value.height : undefined,
  };
}

export function payloadToDataUri(payload: StructuredImagePayload): string {
  return `data:image/${payload.format};base64,${payload.data}`;
}

export function getStructuredImageSource(content: string): string | null {
  const directImage = toImagePayload(content);
  if (directImage) {
    return payloadToDataUri(directImage);
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && "content" in parsed) {
      const nestedImage = toImagePayload(parsed.content);
      if (nestedImage) {
        return payloadToDataUri(nestedImage);
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function splitContentWithImages(content: string): ContentSegment[] {
  const structuredImageSrc = getStructuredImageSource(content);
  if (structuredImageSrc) {
    return [{ kind: "image", src: structuredImageSrc, alt: "" }];
  }

  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  DATA_IMAGE_RE.lastIndex = 0;

  for (const match of content.matchAll(DATA_IMAGE_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ kind: "text", content: content.slice(lastIndex, start) });
    }

    let src: string;
    if (match[2]) {
      src = match[2].replace(/[\r\n\s]/g, "");
    } else if (match[3]) {
      src = match[3].replace(/[\r\n\s]/g, "");
    } else {
      const raw = (match[4] ?? "").replace(/[\r\n\s]/g, "");
      const mime = IMAGE_BASE64_PREFIXES.find((p) => raw.startsWith(p.prefix))?.mime ?? "image/png";
      src = `data:${mime};base64,${raw}`;
    }

    segments.push({ kind: "image", src, alt: match[1] ?? "" });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({ kind: "text", content: content.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ kind: "text", content }];
}

export function getAccordionImagePayload(rawPayload: unknown, children: ReactNode): StructuredImagePayload | null {
  if (typeof children === "string") {
    const fromChildren = toImagePayload(children);
    if (fromChildren) return fromChildren;
  }

  const fromRawPayload = toImagePayload(rawPayload);
  if (fromRawPayload) return fromRawPayload;

  if (typeof rawPayload === "string") {
    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      if (isRecord(parsed) && "content" in parsed) {
        return toImagePayload(parsed.content);
      }
    } catch {
      return null;
    }
  }

  return null;
}
