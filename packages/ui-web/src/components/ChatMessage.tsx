import React, { useEffect, useMemo, useState } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
} from "@fluentui/react-components";
import type { CheckpointMetadata } from "../types";
import { MarkdownContent } from "./MarkdownContent";
import { MessageAccordion } from "./MessageAccordion";
import { ParameterTable } from "./ParameterTable";
import type { ChatEntry, ToolEventMetadata } from "../types";

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

function formatReceivedAtTimestamp(receivedAt?: string): string {
  if (!receivedAt) return "unknown time";
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) return receivedAt;
  return date.toLocaleString();
}

function resolveSubAgentTimestamp(checkpoint?: CheckpointMetadata, receivedAt?: string): string {
  if (checkpoint?.timestamp) {
    const date = new Date(checkpoint.timestamp);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
    return checkpoint.timestamp;
  }
  return formatReceivedAtTimestamp(receivedAt);
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
  subAgentContainer: {
    display: "inline-block",
    width: "fit-content",
    maxWidth: "80vw",
  },
  subAgentAccordion: {
    display: "inline-block",
    width: "fit-content",
    maxWidth: "100%",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  subAgentHeaderRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  subAgentHeaderLabel: {
    // fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  subAgentHeaderAgent: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
  },
  subAgentHeaderTimestamp: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
  },
  subAgentPanel: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM} ${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
  },
  subAgentBubble: {
    width: "fit-content",
    maxWidth: "100%",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusXLarge,
    borderBottomLeftRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
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
  sessionSwitchButton: {
    appearance: "none",
    background: "none",
    border: "none",
    padding: 0,
    margin: 0,
    font: "inherit",
    color: tokens.colorBrandForeground1,
    textDecorationLine: "underline",
    cursor: "pointer",
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
  errorAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    backgroundColor: tokens.colorPaletteRedBackground1,
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
  toolMetaSection: {
    marginTop: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  toolMetaLabel: {
    marginBottom: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
  },
  toolMetaDesc: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    marginBottom: tokens.spacingVerticalXS,
  },
  modelCallAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteDarkOrangeBorder1}`,
    backgroundColor: tokens.colorPaletteDarkOrangeBackground1,
    paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  modelResponseAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteMarigoldBorder1}`,
    backgroundColor: tokens.colorPaletteMarigoldBackground1,
    paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
});

interface ChatMessageProps {
  entry: ChatEntry;
  /** Collapse sub-agent stream cards while main-agent stream is active. */
  collapseSubAgentStream?: boolean;
  /** Shown as a small muted label when viewing all conversations. */
  sessionLabel?: string;
  /** Full conversation id for a foreign-session message label. */
  sessionConversationId?: string;
  /** BlueBubbles chat GUID (e.g. phone number) for this conversation. */
  chatGuid?: string;
  /** Called when a user wants to switch the active conversation context. */
  onRequestSwitchConversation?: (conversationId: string) => void;
  /** Active model context window tokens for prompt-context estimation. */
  modelContextWindowTokens?: number;
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

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

function estimatePromptContextUsage(content: string, contextWindowTokens?: number): string {
  const chars = content.length;
  const approxTokens = Math.max(1, Math.ceil(chars / APPROX_CHARS_PER_TOKEN));
  const denominator =
    typeof contextWindowTokens === "number" && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const ratio = (approxTokens / denominator) * 100;
  const ratioLabel = ratio < 0.1 ? "<0.1" : ratio.toFixed(1);
  const tokenLabel = new Intl.NumberFormat().format(approxTokens);
  const windowLabel = new Intl.NumberFormat().format(denominator);
  return `~${tokenLabel} tokens (${ratioLabel}% of ${windowLabel} ctx)`;
}

function ToolMetaSection({ meta }: { meta: ToolEventMetadata }) {
  const styles = useStyles();
  const { tool } = meta;
  const hasParams = tool.parameters != null && typeof tool.parameters === "object";
  return (
    <div className={styles.toolMetaSection}>
      <Text block className={styles.toolMetaLabel}>Parameter instructions</Text>
      {tool.description && (
        <Text block className={styles.toolMetaDesc}>{tool.description}</Text>
      )}
      {hasParams ? (
        <ParameterTable parameters={tool.parameters as Record<string, unknown>} />
      ) : (
        <Text block className={styles.toolMetaDesc} style={{ fontStyle: "italic" }}>No parameter schema available</Text>
      )}
    </div>
  );
}

export function ChatMessage({
  entry,
  collapseSubAgentStream,
  sessionLabel,
  sessionConversationId,
  chatGuid,
  onRequestSwitchConversation,
  modelContextWindowTokens,
}: ChatMessageProps) {
  const styles = useStyles();
  const isSubAgentEntry = entry.role === "agent" && entry.streamSource === "sub-agent";
  const subAgentAccordionValue = useMemo(() => `sub-agent-${entry.id}`, [entry.id]);
  const [isSubAgentOpen, setIsSubAgentOpen] = useState<boolean>(Boolean(entry.isStreaming));

  useEffect(() => {
    if (!isSubAgentEntry) return;
    if (collapseSubAgentStream) {
      setIsSubAgentOpen(false);
      return;
    }
    if (entry.isStreaming) {
      setIsSubAgentOpen(true);
    }
  }, [isSubAgentEntry, collapseSubAgentStream, entry.isStreaming, entry.id]);

  const renderSessionLabel = (textAlign?: "left" | "right") => {
    if (!sessionLabel) return null;

    const canSwitch = Boolean(sessionConversationId && onRequestSwitchConversation);
    // Extract the meaningful part of the chatGuid (e.g. phone number after `;-;`).
    const chatGuidDisplay = chatGuid
      ? (chatGuid.includes(";-;") ? chatGuid.split(";-;").pop()! : chatGuid)
      : undefined;
    return (
      <Text block className={styles.sessionLabel} style={textAlign ? { textAlign } : undefined}>
        session {" "}
        {canSwitch ? (
          <button
            type="button"
            className={styles.sessionSwitchButton}
            onClick={() => onRequestSwitchConversation?.(sessionConversationId!)}
            title={`Switch to conversation ${sessionConversationId}`}
          >
            {sessionLabel}
          </button>
        ) : (
          sessionLabel
        )}
        {chatGuidDisplay && <> · {chatGuidDisplay}</>}
      </Text>
    );
  };

  if (entry.role === "user") {
    return (
      <div className={styles.userWrapper}>
        <div>
          {renderSessionLabel("right")}
          <Text className={styles.userBubble}>{entry.content}</Text>
        </div>
      </div>
    );
  }

  if (entry.role === "prompt") {
    const contextUsageEstimate = estimatePromptContextUsage(entry.content, modelContextWindowTokens);
    return (
      <div className={styles.promptWrapper}>
        <div>
          {renderSessionLabel()}
          <MessageAccordion
            className={styles.promptAccordion}
            itemValue="prompt"
            headerText="Prompt context"
            headerPreTimestampText={contextUsageEstimate}
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
          {renderSessionLabel()}
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
            {entry.toolEventMetadata && (
              <ToolMetaSection meta={entry.toolEventMetadata} />
            )}
          </MessageAccordion>
        </div>
      </div>
    );
  }

  if (entry.role === "model-call") {
    let modelName: string | undefined;
    let toolCount: number | undefined;
    let modelCallContent = entry.content;
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (isObject(parsed)) {
        if (typeof parsed.model === "string") {
          modelName = parsed.model;
        }
        const invocation = isObject(parsed.invocation) ? parsed.invocation : undefined;
        if (invocation && Array.isArray(invocation.tools)) {
          toolCount = invocation.tools.length;
        }
      }
      modelCallContent = toDisplayJson(parsed, entry.content);
    } catch {
      // leave raw content as-is
    }
    return (
      <div className={styles.promptWrapper}>
        <div>
          {renderSessionLabel()}
          <MessageAccordion
            className={styles.modelCallAccordion}
            itemValue="model-call"
            headerText={`Model call${modelName ? `: ${modelName}` : ""}`}
            headerPreTimestampText={typeof toolCount === "number" ? `${toolCount} tools` : undefined}
            panelClassName={styles.toolPanel}
            rawPayload={entry.content}
            receivedAt={entry.receivedAt}
            checkpoint={entry.checkpoint}
          >
            {modelCallContent}
          </MessageAccordion>
        </div>
      </div>
    );
  }

  if (entry.role === "graph-definition") {
    let graphName: string | undefined;
    let graphContent = entry.content;
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (isObject(parsed)) {
        if (typeof parsed.graphName === "string") {
          graphName = parsed.graphName;
        } else {
          const graph = isObject(parsed.graph) ? parsed.graph : undefined;
          if (graph && typeof graph.graphKey === "string") {
            graphName = graph.graphKey;
          }
        }
      }
      graphContent = toDisplayJson(parsed, entry.content);
    } catch {
      // leave raw content as-is
    }
    return (
      <div className={styles.promptWrapper}>
        <div>
          {renderSessionLabel()}
          <MessageAccordion
            className={styles.modelCallAccordion}
            itemValue="graph-definition"
            headerText={`Graph definition:${graphName ? ` ${graphName}` : ""}`}
            panelClassName={styles.toolPanel}
            rawPayload={entry.content}
            receivedAt={entry.receivedAt}
            checkpoint={entry.checkpoint}
          >
            {graphContent}
          </MessageAccordion>
        </div>
      </div>
    );
  }

  if (entry.role === "system-event") {
    let title = "System event";
    let eventContent = entry.content;
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (isObject(parsed) && typeof parsed.event === "string") {
        title = `System event: ${parsed.event}`;
      }
      eventContent = toDisplayJson(parsed, entry.content);
    } catch {
      // leave raw content as-is
    }
    return (
      <div className={styles.promptWrapper}>
        <div>
          {renderSessionLabel()}
          <MessageAccordion
            className={styles.modelCallAccordion}
            itemValue="system-event"
            headerText={title}
            panelClassName={styles.toolPanel}
            rawPayload={entry.content}
            receivedAt={entry.receivedAt}
            checkpoint={entry.checkpoint}
          >
            {eventContent}
          </MessageAccordion>
        </div>
      </div>
    );
  }

  if (entry.role === "model-response") {
    let modelName: string | undefined;
    let modelResponseContent = entry.content;
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (isObject(parsed) && typeof parsed.model === "string") {
        modelName = parsed.model;
      }
      modelResponseContent = toDisplayJson(parsed, entry.content);
    } catch {
      // leave raw content as-is
    }
    return (
      <div className={styles.promptWrapper}>
        <div>
          {renderSessionLabel()}
          <MessageAccordion
            className={styles.modelResponseAccordion}
            itemValue="model-response"
            headerText={`Model response${modelName ? `: ${modelName}` : ""}`}
            panelClassName={styles.toolPanel}
            rawPayload={entry.content}
            receivedAt={entry.receivedAt}
            checkpoint={entry.checkpoint}
          >
            {modelResponseContent}
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
          {renderSessionLabel()}
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
            {entry.toolEventMetadata && (
              <ToolMetaSection meta={entry.toolEventMetadata} />
            )}
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
          {renderSessionLabel()}
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
    if (entry.role === "error") {
      return (
        <div className={styles.promptWrapper}>
          <div>
            {renderSessionLabel()}
            <MessageAccordion
              className={styles.errorAccordion}
              itemValue="error"
              headerText="Error"
              panelClassName={styles.toolPanel}
              rawPayload={entry.content}
              receivedAt={entry.receivedAt}
              checkpoint={entry.checkpoint}
            >
              {entry.content}
            </MessageAccordion>
          </div>
        </div>
      );
    }

  if (isSubAgentEntry) {
    const openItems = isSubAgentOpen ? [subAgentAccordionValue] : [];
    return (
      <div className={styles.agentWrapper}>
        <div className={styles.subAgentContainer}>
          {renderSessionLabel()}
          <Accordion
            collapsible
            openItems={openItems}
            onToggle={(_, data) => {
              const next = Array.isArray(data.openItems)
                ? data.openItems.includes(subAgentAccordionValue)
                : data.openItems === subAgentAccordionValue;
              setIsSubAgentOpen(next);
            }}
            className={styles.subAgentAccordion}
          >
            <AccordionItem value={subAgentAccordionValue}>
              <AccordionHeader size="small">
                <span className={styles.subAgentHeaderRow}>
                  <span className={styles.subAgentHeaderLabel}>Sub-agent stream</span>
                  {entry.streamAgentKey ? (
                    <span className={styles.subAgentHeaderAgent}>{entry.streamAgentKey}</span>
                  ) : null}
                  <span className={styles.subAgentHeaderTimestamp}>
                    {resolveSubAgentTimestamp(entry.checkpoint, entry.receivedAt)}
                  </span>
                </span>
              </AccordionHeader>
              <AccordionPanel>
                <div className={styles.subAgentPanel}>
                  <div className={styles.subAgentBubble}>
                    <InlineContent content={entry.content} />
                    {entry.isStreaming && <span className={styles.cursor} aria-hidden />}
                  </div>
                </div>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        </div>
      </div>
    );
  }

  // agent
  return (
    <div className={styles.agentWrapper}>
      <div>
        {renderSessionLabel()}
        <div className={styles.agentBubble}>
          <InlineContent content={entry.content} />
          {entry.isStreaming && <span className={styles.cursor} aria-hidden />}
        </div>
      </div>
    </div>
  );
}
