import React, { useEffect, useMemo, useState } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
} from "@fluentui/react-components";
import { ThumbLike16Regular, ThumbDislike16Regular } from "@fluentui/react-icons";
import { MessageAccordion } from "./accordions/MessageAccordion";
import { InlineContent } from "./content/InlineContent";
import { ToolMetaSection } from "./metadata/ToolMetaSection";
import { SubAgentMessageRenderer } from "./subagent/SubAgentMessageRenderer";
import {
  isEmptyPayload,
  isObject,
  reorderModelResponsePayload,
  isSpecificToolName,
  toDisplayJson,
  tryFormatJsonString,
} from "./utils/dataFormatters";
import { estimatePromptContextUsage } from "./utils/promptAnalytics";
import { splitContentWithImages } from "./utils/imageUtils";
import { formatMessageTimestamp } from "./utils/dataFormatters";
import type { ChatEntry } from "../../types";
import type { FeedbackSignal } from "../../hooks/useFeedback";

const useStyles = makeStyles({
  // ── Wrapper / alignment ───────────────────────────────────────────────────
  userWrapper: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
  },
  userMessageContainer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    width: "fit-content",
    maxWidth: "80vw",
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
    display: "inline-block",
    width: "fit-content",
    maxWidth: "80vw",
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

  // ── Message timestamp ────────────────────────────────────────────────────────
  messageTimestamp: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    marginTop: tokens.spacingVerticalXXS,
    fontStyle: "italic",
    alignSelf: "flex-start",
  },

  // ── Prompt accordion ──────────────────────────────────────────────────────
  promptAccordion: {
    // maxWidth: "80%",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    // paddingRight: tokens.spacingHorizontalM,
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
    // paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  toolResultAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteGreenBorder1}`,
    backgroundColor: tokens.colorPaletteGreenBackground1,
    // paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  agentTransferAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteBerryBorder1}`,
    backgroundColor: tokens.colorPaletteBerryBackground1,
    // paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  errorAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    backgroundColor: tokens.colorPaletteRedBackground1,
    // paddingRight: tokens.spacingHorizontalM,
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
  toolMetaDesc: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    marginBottom: tokens.spacingVerticalXS,
  },
  modelCallAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteDarkOrangeBorder1}`,
    backgroundColor: tokens.colorPaletteDarkOrangeBackground1,
    // paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  modelResponseAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteMarigoldBorder1}`,
    backgroundColor: tokens.colorPaletteMarigoldBackground1,
    // paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  conversationMetadataAccordion: {
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteLightGreenBorder1}`,
    backgroundColor: tokens.colorPaletteLightGreenBackground1,
    // paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  feedbackRow: {
    display: "flex",
    gap: "2px",
    alignItems: "center",
  },
  feedbackButton: {
    minWidth: "unset",
    padding: "0 1px",
    height: "13px",
    width: "auto",
  },
});

interface ChatMessageProps {
  entry: ChatEntry;
  /** Collapse sub-agent stream cards while main-agent stream is active. */
  collapseSubAgentStream?: boolean;
  /** Shown as a small muted label when viewing all conversations. */
  sessionLabel?: string;
  /** Generated conversation title shown in italics after the session label. */
  sessionTitle?: string;
  /** Full conversation id for a foreign-session message label. */
  sessionConversationId?: string;
  /** BlueBubbles chat GUID (e.g. phone number) for this conversation. */
  chatGuid?: string;
  /** Called when a user wants to switch the active conversation context. */
  onRequestSwitchConversation?: (conversationId: string) => void;
  /** Active model context window tokens for prompt-context estimation. */
  modelContextWindowTokens?: number;
  /** Suppress timestamp rendering (e.g., when status message will show it instead). */
  suppressTimestamp?: boolean;
  onSubmitFeedback?: (entry: ChatEntry, signal: FeedbackSignal, sourceView: "live") => Promise<void>;
}

export function ChatMessage({
  entry,
  collapseSubAgentStream,
  sessionLabel,
  sessionTitle,
  sessionConversationId,
  chatGuid,
  onRequestSwitchConversation,
  modelContextWindowTokens,
  suppressTimestamp,
  onSubmitFeedback,
}: ChatMessageProps) {
  const styles = useStyles();
  const isSubAgentEntry = entry.role === "agent" && entry.streamSource === "sub-agent";
  const subAgentAccordionValue = useMemo(() => `sub-agent-${entry.id}`, [entry.id]);
  const [isSubAgentOpen, setIsSubAgentOpen] = useState<boolean>(Boolean(entry.isStreaming));
  const [feedbackSignal, setFeedbackSignal] = useState<FeedbackSignal | null>(null);
  const [feedbackPending, setFeedbackPending] = useState(false);

  const feedbackAllowed = (
    entry.role === "agent"
    || entry.role === "tool-call"
    || entry.role === "tool-result"
    || entry.role === "model-call"
    || entry.role === "model-response"
    || entry.role === "agent-transfer"
  ) && !entry.isStreaming;

  const submitFeedback = async (signal: FeedbackSignal): Promise<void> => {
    if (!onSubmitFeedback || feedbackPending) return;
    setFeedbackPending(true);
    try {
      await onSubmitFeedback(entry, signal, "live");
      setFeedbackSignal(signal);
    } finally {
      setFeedbackPending(false);
    }
  };

  const renderFeedbackButtons = () => {
    if (!feedbackAllowed) return null;
    return (
      <div className={styles.feedbackRow}>
        <Button
          size="small"
          className={styles.feedbackButton}
          appearance={feedbackSignal === "like" ? "primary" : "subtle"}
          icon={<ThumbLike16Regular style={{ width: "13px", height: "13px" }} />}
          aria-label="Like this message"
          disabled={feedbackPending}
          onClick={() => { void submitFeedback("like"); }}
        />
        <Button
          size="small"
          className={styles.feedbackButton}
          appearance={feedbackSignal === "dislike" ? "primary" : "subtle"}
          icon={<ThumbDislike16Regular style={{ width: "13px", height: "13px" }} />}
          aria-label="Dislike this message"
          disabled={feedbackPending}
          onClick={() => { void submitFeedback("dislike"); }}
        />
      </div>
    );
  };

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
        {sessionTitle && <em style={{ opacity: 0.75 }}> — {sessionTitle}</em>}
      </Text>
    );
  };

  if (entry.role === "user") {
    const timestamp = !suppressTimestamp ? formatMessageTimestamp(entry.receivedAt) : null;
    return (
      <div className={styles.userWrapper}>
        {renderSessionLabel("right")}
        <div className={styles.userMessageContainer}>
          <Text className={styles.userBubble}>{entry.content}</Text>
          {timestamp && <Text block className={styles.messageTimestamp}>{timestamp}</Text>}
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
    let parsedToolName: string | undefined;
    let toolArgs = entry.content;
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (isObject(parsed)) {
        const fn = isObject(parsed.function) ? parsed.function : undefined;
        if (typeof parsed.name === "string") {
          parsedToolName = parsed.name;
        } else if (fn && typeof fn.name === "string") {
          parsedToolName = fn.name;
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
    const toolName = [
      entry.toolName,
      entry.toolEventMetadata?.tool?.name,
      parsedToolName,
    ].find((candidate) => isSpecificToolName(candidate)) ?? "tool";
    const toolNameDebugSource = isSpecificToolName(entry.toolName)
      ? "entry.toolName"
      : (isSpecificToolName(entry.toolEventMetadata?.tool?.name)
        ? "toolEventMetadata.tool.name"
        : (isSpecificToolName(parsedToolName)
          ? "payload.name"
          : "fallback:tool"));
    const toolNameDebugLine = `[debug tool-call] source=${toolNameDebugSource} entry=${entry.toolName ?? "<empty>"} meta=${entry.toolEventMetadata?.tool?.name ?? "<empty>"} payload=${parsedToolName ?? "<empty>"}`;
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
            headerActions={renderFeedbackButtons()}
          >
            <Text block className={styles.toolMetaDesc}>{toolNameDebugLine}</Text>
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
            headerActions={renderFeedbackButtons()}
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

  if (entry.role === "conversation-metadata") {
    let headerText = "Conversation metadata";
    let displayContent = entry.content;
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (isObject(parsed) && typeof parsed.title === "string") {
        headerText = `Conversation title: ${parsed.title}`;
      }
      displayContent = toDisplayJson(parsed, entry.content);
    } catch {
      // leave raw content as-is
    }
    return (
      <div className={styles.promptWrapper}>
        <div>
          {renderSessionLabel()}
          <MessageAccordion
            className={styles.conversationMetadataAccordion}
            itemValue="conversation-metadata"
            headerText={headerText}
            panelClassName={styles.toolPanel}
            rawPayload={entry.content}
            receivedAt={entry.receivedAt}
            checkpoint={entry.checkpoint}
          >
            {displayContent}
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
      modelResponseContent = toDisplayJson(reorderModelResponsePayload(parsed), entry.content);
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
            headerActions={renderFeedbackButtons()}
          >
            {modelResponseContent}
          </MessageAccordion>
        </div>
      </div>
    );
  }

  if (entry.role === "tool-result") {
    let parsedToolName: string | undefined;
    let toolContent = entry.content;
    try {
      const parsed = JSON.parse(entry.content) as { name?: string; content?: string };
      parsedToolName = parsed.name;
      toolContent = parsed.content ?? toolContent;
    } catch {
      // leave raw content as-is
    }
    const toolName = [
      entry.toolName,
      entry.toolEventMetadata?.tool?.name,
      parsedToolName,
    ].find((candidate) => isSpecificToolName(candidate));
    const toolNameDebugSource = isSpecificToolName(entry.toolName)
      ? "entry.toolName"
      : (isSpecificToolName(entry.toolEventMetadata?.tool?.name)
        ? "toolEventMetadata.tool.name"
        : (isSpecificToolName(parsedToolName)
          ? "payload.name"
          : "none"));
    const toolNameDebugLine = `[debug tool-result] source=${toolNameDebugSource} entry=${entry.toolName ?? "<empty>"} meta=${entry.toolEventMetadata?.tool?.name ?? "<empty>"} payload=${parsedToolName ?? "<empty>"}`;
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
            headerActions={renderFeedbackButtons()}
          >
            <Text block className={styles.toolMetaDesc}>{toolNameDebugLine}</Text>
            {splitContentWithImages(toolContent).map((segment, i) =>
              segment.kind === "image" ? (
                <img
                  key={i}
                  src={segment.src}
                  alt={segment.alt || "tool image result"}
                  style={{ display: "block", maxWidth: "100%", height: "auto", margin: "4px 0", borderRadius: "4px" }}
                />
              ) : (
                <span key={i}>{segment.content}</span>
              ),
            )}
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
            headerActions={renderFeedbackButtons()}
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
    return (
      <SubAgentMessageRenderer
        entry={entry}
        isOpen={isSubAgentOpen}
        accordionValue={subAgentAccordionValue}
        onToggle={setIsSubAgentOpen}
        sessionLabelNode={renderSessionLabel()}
        showCursor={entry.isStreaming}
        cursorClassName={styles.cursor}
      />
    );
  }

  // agent
  const timestamp = !suppressTimestamp ? formatMessageTimestamp(entry.receivedAt) : null;
  return (
    <div className={styles.agentWrapper}>
      <div>
        {renderSessionLabel()}
        <div className={styles.agentBubble}>
          <InlineContent content={entry.content} />
          {entry.isStreaming && <span className={styles.cursor} aria-hidden />}
        </div>
          {(timestamp || feedbackAllowed) && (
            <div className={styles.feedbackRow} style={{ marginTop: tokens.spacingVerticalXXS }}>
              {timestamp && <Text className={styles.messageTimestamp}>{timestamp}</Text>}
              {renderFeedbackButtons()}
            </div>
          )}
      </div>
    </div>
  );
}
