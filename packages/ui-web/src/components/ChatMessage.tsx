import React from "react";
import {
  makeStyles,
  tokens,
  Text,
} from "@fluentui/react-components";
import { MarkdownContent } from "./MarkdownContent";
import { MessageAccordion } from "./MessageAccordion";
import type { ChatEntry } from "../types";

// Base64 prefixes that uniquely identify common image formats.
// Each entry is the base64 encoding of the format's magic bytes.
const IMAGE_BASE64_PREFIXES: Array<{ prefix: string; mime: string }> = [
  { prefix: "/9j/",        mime: "image/jpeg" }, // FF D8 FF
  { prefix: "iVBORw0KGgo", mime: "image/png"  }, // 89 50 4E 47 …
  { prefix: "R0lGOD",      mime: "image/gif"  }, // GIF87a / GIF89a
  { prefix: "UklGR",       mime: "image/webp" }, // RIFF….WEBP
  { prefix: "Qk0",         mime: "image/bmp"  }, // BM
];

// Matches (in order of capture group):
//  Group 1 + 2 : markdown image syntax  ![alt](data:image/…;base64,…)
//  Group 3     : bare data URI          data:image/…;base64,…
//  Group 4     : standalone base64 block whose prefix identifies a known image format
const DATA_IMAGE_RE = new RegExp(
  // markdown data-URI image
  String.raw`!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=\r\n]+?)\)` +
  "|" +
  // bare data URI (not preceded by '(' to avoid double-matching)
  String.raw`(?<!\()(data:image\/[^;]+;base64,[A-Za-z0-9+/=\r\n]+)` +
  "|" +
  // standalone base64 block beginning with a recognised image magic-byte prefix
  `((?:${IMAGE_BASE64_PREFIXES.map((p) => p.prefix.replace(/[/+]/g, "\\$&")).join("|")})[A-Za-z0-9+/=\\r\\n]{50,})`,
  "g",
);

type ContentSegment =
  | { kind: "text"; content: string }
  | { kind: "image"; src: string; alt: string };

interface StructuredImagePayload {
  width?: number;
  height?: number;
  data: string;
  format: string;
  encoding?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function normalizeImageFormat(format: string): string | null {
  const normalized = format.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "jpg") return "jpeg";
  if (normalized === "svg") return "svg+xml";
  const supportedFormats = new Set(["png", "jpeg", "gif", "webp", "bmp", "svg+xml"]);
  return supportedFormats.has(normalized) ? normalized : null;
}

function toStructuredImagePayload(value: unknown): StructuredImagePayload | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      return toStructuredImagePayload(JSON.parse(trimmed));
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

function getStructuredImageSource(content: string): string | null {
  const directImage = toStructuredImagePayload(content);
  if (directImage) {
    return `data:image/${directImage.format};base64,${directImage.data}`;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && "content" in parsed) {
      const nestedImage = toStructuredImagePayload(parsed.content);
      if (nestedImage) {
        return `data:image/${nestedImage.format};base64,${nestedImage.data}`;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function splitContentWithImages(content: string): ContentSegment[] {
  const structuredImageSrc = getStructuredImageSource(content);
  if (structuredImageSrc) {
    return [{ kind: "image", src: structuredImageSrc, alt: "" }];
  }

  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  DATA_IMAGE_RE.lastIndex = 0;

  for (const match of content.matchAll(DATA_IMAGE_RE)) {
    const start = match.index!;
    if (start > lastIndex) {
      segments.push({ kind: "text", content: content.slice(lastIndex, start) });
    }

    let src: string;
    if (match[2]) {
      // Markdown data URI: ![alt](data:image/…;base64,…)
      src = match[2].replace(/[\r\n\s]/g, "");
    } else if (match[3]) {
      // Bare data URI: data:image/…;base64,…
      src = match[3].replace(/[\r\n\s]/g, "");
    } else {
      // Standalone base64 block — infer MIME type from prefix
      const raw = match[4].replace(/[\r\n\s]/g, "");
      const mime =
        IMAGE_BASE64_PREFIXES.find((p) => raw.startsWith(p.prefix))?.mime ??
        "image/png";
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

interface InlineContentProps {
  content: string;
}

function InlineContent({ content }: InlineContentProps) {
  const segments = splitContentWithImages(content);
  if (segments.length === 1 && segments[0].kind === "text") {
    return <MarkdownContent content={content} />;
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "image" ? (
          <img
            key={i}
            src={seg.src}
            alt={seg.alt}
            style={{ maxWidth: "100%", borderRadius: "4px", display: "block", margin: "4px 0" }}
          />
        ) : seg.content.trim() ? (
          <MarkdownContent key={i} content={seg.content} />
        ) : null
      )}
    </>
  );
}

const useStyles = makeStyles({
  // ── Wrapper / alignment ───────────────────────────────────────────────────
  userWrapper: {
    display: "flex",
    justifyContent: "flex-end",
  },
  agentWrapper: {
    display: "flex",
    justifyContent: "flex-start",
  },
  promptWrapper: {
    display: "flex",
    justifyContent: "flex-start",
  },

  // ── Bubble shapes ─────────────────────────────────────────────────────────
  userBubble: {
    maxWidth: "72%",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusXLarge,
    borderBottomRightRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: "1.5",
  },
  agentBubble: {
    width: "80vw",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusXLarge,
    borderBottomLeftRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    wordBreak: "break-word",
  },

  // ── Streaming cursor ───────────────────────────────────────────────────────
  cursor: {
    display: "inline-block",
    width: "2px",
    height: "1em",
    backgroundColor: tokens.colorBrandForeground1,
    marginLeft: "2px",
    verticalAlign: "text-bottom",
    animationName: {
      "50%": { opacity: 0 },
    },
    animationDuration: "0.7s",
    animationIterationCount: "infinite",
    animationTimingFunction: "step-end",
  },

  // ── Session label (shown in "all conversations" mode for foreign sessions) ──
  sessionLabel: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalXXS,
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
  },

  // ── Prompt accordion ──────────────────────────────────────────────────────
  promptAccordion: {
    // maxWidth: "80%",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  promptPanel: {
    maxHeight: "300px",
    overflowY: "auto",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}  ${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalM}`,
    fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },

  // ── Tool call / result accordions ─────────────────────────────────────────
  toolCallAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteYellowBorder1}`,
    backgroundColor: tokens.colorPaletteYellowBackground1,
    paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  toolResultAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteGreenBorder1}`,
    backgroundColor: tokens.colorPaletteGreenBackground1,
    paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  agentTransferAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteBerryBorder1}`,
    backgroundColor: tokens.colorPaletteBerryBackground1,
    paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  toolPanel: {
    maxHeight: "300px",
    overflowY: "auto",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM} ${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalM}`,
    fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
});

interface ChatMessageProps {
  entry: ChatEntry;
  /** Shown as a small muted label when viewing all conversations. */
  sessionLabel?: string;
}

function toDisplayJson(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? fallback;
  } catch {
    return fallback;
  }
}

function isEmptyPayload(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

function tryFormatJsonString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const startsLikeJson =
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith('"');
  if (!startsLikeJson) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

export function ChatMessage({ entry, sessionLabel }: ChatMessageProps) {
  const styles = useStyles();

  if (entry.role === "user") {
    return (
      <div className={styles.userWrapper}>
        <div>
          {sessionLabel && (
            <Text block className={styles.sessionLabel} style={{ textAlign: "right" }}>
              session {sessionLabel}
            </Text>
          )}
          <Text className={styles.userBubble}>{entry.content}</Text>
        </div>
      </div>
    );
  }

  if (entry.role === "prompt") {
    return (
      <div className={styles.promptWrapper}>
        <div>
          {sessionLabel && (
            <Text block className={styles.sessionLabel}>session {sessionLabel}</Text>
          )}
          <MessageAccordion
            className={styles.promptAccordion}
            itemValue="prompt"
            headerText="Prompt context"
            panelClassName={styles.promptPanel}
            rawPayload={entry.content}
            receivedAt={entry.receivedAt}
            checkpoint={entry.checkpoint}
          >
            <InlineContent content={entry.content} />
          </MessageAccordion>
        </div>
      </div>
    );
  }
        

  if (entry.role === "tool-call") {
    let toolName = "tool";
    let toolArgs = entry.content;
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (isObject(parsed)) {
        const fn = isObject(parsed.function) ? parsed.function : undefined;
        if (typeof parsed.name === "string") {
          toolName = parsed.name;
        } else if (fn && typeof fn.name === "string") {
          toolName = fn.name;
        }

        const candidates: unknown[] = [
          parsed.args,
          parsed.arguments,
          fn?.arguments,
          parsed.body,
          parsed.call,
          parsed.raw,
        ];
        const firstNonEmpty = candidates.find((candidate) => !isEmptyPayload(candidate));
        if (firstNonEmpty != null) {
          toolArgs = typeof firstNonEmpty === "string"
            ? tryFormatJsonString(firstNonEmpty)
            : toDisplayJson(firstNonEmpty, entry.content);
        } else {
          toolArgs = toDisplayJson(parsed, entry.content);
        }
      } else {
        toolArgs = toDisplayJson(parsed, entry.content);
      }
    } catch {
      // leave raw content as-is
    }
    return (
      <div className={styles.promptWrapper}>
        <div>
          {sessionLabel && (
            <Text block className={styles.sessionLabel}>session {sessionLabel}</Text>
          )}
          <MessageAccordion
            className={styles.toolCallAccordion}
            itemValue="tool-call"
            headerText={`Tool call: ${toolName}`}
            panelClassName={styles.toolPanel}
            rawPayload={entry.content}
            receivedAt={entry.receivedAt}
            checkpoint={entry.checkpoint}
          >
            {toolArgs}
          </MessageAccordion>
        </div>
      </div>
    );
  }

  if (entry.role === "tool-result") {
    let toolName: string | undefined;
    let toolContent = entry.content;
    try {
      const parsed = JSON.parse(entry.content) as { name?: string; content?: string };
      toolName = parsed.name;
      toolContent = parsed.content ?? toolContent;
    } catch {
      // leave raw content as-is
    }
    return (
      <div className={styles.promptWrapper}>
        <div>
          {sessionLabel && (
            <Text block className={styles.sessionLabel}>session {sessionLabel}</Text>
          )}
          <MessageAccordion
            className={styles.toolResultAccordion}
            itemValue="tool-result"
            headerText={`Tool result${toolName ? `: ${toolName}` : ""}`}
            panelClassName={styles.toolPanel}
            rawPayload={entry.content}
            receivedAt={entry.receivedAt}
            checkpoint={entry.checkpoint}
          >
            {toolContent}
          </MessageAccordion>
        </div>
      </div>
    );
  }

  if (entry.role === "agent-transfer") {
    let targetAgent = "sub-agent";
    let request: string | undefined;
    try {
      const parsed = JSON.parse(entry.content) as { agent?: string; request?: string };
      targetAgent = parsed.agent ?? targetAgent;
      request = parsed.request;
    } catch {
      // leave raw content as-is
    }
    return (
      <div className={styles.promptWrapper}>
        <div>
          {sessionLabel && (
            <Text block className={styles.sessionLabel}>session {sessionLabel}</Text>
          )}
          <MessageAccordion
            className={styles.agentTransferAccordion}
            itemValue="agent-transfer"
            headerText={`-> Transferring to: ${targetAgent}`}
            panelClassName={styles.toolPanel}
            rawPayload={entry.content}
            receivedAt={entry.receivedAt}
            checkpoint={entry.checkpoint}
          >
            {request ?? ""}
          </MessageAccordion>
        </div>
      </div>
    );
  }

  // agent
  return (
    <div className={styles.agentWrapper}>
      <div>
        {sessionLabel && (
          <Text block className={styles.sessionLabel}>session {sessionLabel}</Text>
        )}
        <div className={styles.agentBubble}>
          <InlineContent content={entry.content} />
          {entry.isStreaming && <span className={styles.cursor} aria-hidden />}
        </div>
      </div>
    </div>
  );
}
