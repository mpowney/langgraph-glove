import React from "react";
import {
  makeStyles,
  tokens,
  Text,
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
} from "@fluentui/react-components";
import { MarkdownContent } from "./MarkdownContent";
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

function splitContentWithImages(content: string): ContentSegment[] {
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
    maxWidth: "80%",
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
});

interface ChatMessageProps {
  entry: ChatEntry;
  /** Shown as a small muted label when viewing all conversations. */
  sessionLabel?: string;
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
          <Accordion className={styles.promptAccordion} collapsible>
          <AccordionItem value="prompt">
            <AccordionHeader size="medium">Prompt context</AccordionHeader>
            <AccordionPanel>
              <div className={styles.promptPanel}>
                <InlineContent content={entry.content} />
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
