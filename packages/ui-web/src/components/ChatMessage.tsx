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
    maxWidth: "80%",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    overflow: "hidden",
  },
  promptPanel: {
    maxHeight: "300px",
    overflowY: "auto",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
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
            <AccordionHeader size="small">Prompt context</AccordionHeader>
            <AccordionPanel>
              <div className={styles.promptPanel}>
                <MarkdownContent content={entry.content} />
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
          <MarkdownContent content={entry.content} />
          {entry.isStreaming && <span className={styles.cursor} aria-hidden />}
        </div>
      </div>
    </div>
  );
}
