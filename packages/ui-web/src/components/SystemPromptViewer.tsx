import React from "react";
import { makeStyles, tokens, Text, Button } from "@fluentui/react-components";
import { MarkdownContent } from "./MarkdownContent";

const useStyles = makeStyles({
  pane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
  },
  toggleGroup: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
  },
  body: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  markdownScroll: {
    flex: 1,
    overflow: "auto",
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
  },
  rawPre: {
    flex: 1,
    margin: 0,
    overflow: "auto",
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
    fontSize: tokens.fontSizeBase200,
    lineHeight: "1.5",
  },
  rawTextarea: {
    flex: 1,
    resize: "none",
    border: "none",
    outline: "none",
    backgroundColor: "transparent",
    fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
    fontSize: tokens.fontSizeBase200,
    lineHeight: "1.5",
    color: tokens.colorNeutralForeground1,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
  },
  empty: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    textAlign: "center",
  },
});

export type SystemPromptViewMode = "markdown" | "raw";

export const SYSTEM_PROMPT_VIEW_MODE_KEY = "glove.systemPrompt.viewMode";

interface SystemPromptViewerProps {
  label: string;
  content: string;
  emptyMessage: string;
  viewMode: SystemPromptViewMode;
  onViewModeChange: (mode: SystemPromptViewMode) => void;
  /** If provided the content is editable in raw mode */
  onChange?: (value: string) => void;
}

export function SystemPromptViewer({
  label,
  content,
  emptyMessage,
  viewMode,
  onViewModeChange,
  onChange,
}: SystemPromptViewerProps) {
  const styles = useStyles();

  return (
    <div className={styles.pane}>
      <div className={styles.header}>
        <Text weight="semibold">{label}</Text>
        <div className={styles.toggleGroup}>
          <Button
            size="small"
            appearance={viewMode === "markdown" ? "primary" : "subtle"}
            onClick={() => onViewModeChange("markdown")}
          >
            Markdown
          </Button>
          <Button
            size="small"
            appearance={viewMode === "raw" ? "primary" : "subtle"}
            onClick={() => onViewModeChange("raw")}
          >
            Raw
          </Button>
        </div>
      </div>

      <div className={styles.body}>
        {content ? (
          viewMode === "markdown" ? (
            <div className={styles.markdownScroll}>
              <MarkdownContent content={content} />
            </div>
          ) : onChange ? (
            <textarea
              className={styles.rawTextarea}
              value={content}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <pre className={styles.rawPre}>{content}</pre>
          )
        ) : (
          <div className={styles.empty}>
            <Text style={{ color: tokens.colorNeutralForeground3 }}>
              {emptyMessage}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
