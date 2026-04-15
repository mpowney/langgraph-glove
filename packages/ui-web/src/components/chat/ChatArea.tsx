import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, makeStyles, tokens, Text } from "@fluentui/react-components";
import { ChatMessage } from "./ChatMessage";
import { formatMessageTimestamp } from "./utils/dataFormatters";
import type { ChatEntry } from "../../types";

const AUTO_SCROLL_LINE_THRESHOLD = 6;
const DEFAULT_LINE_HEIGHT_PX = 24;

function getLineHeightPx(element: HTMLElement): number {
  const { lineHeight, fontSize } = window.getComputedStyle(element);
  const parsedLineHeight = Number.parseFloat(lineHeight);
  if (Number.isFinite(parsedLineHeight)) {
    return parsedLineHeight;
  }

  const parsedFontSize = Number.parseFloat(fontSize);
  if (Number.isFinite(parsedFontSize)) {
    return parsedFontSize * 1.5;
  }

  return DEFAULT_LINE_HEIGHT_PX;
}

function isWithinAutoScrollThreshold(container: HTMLElement): boolean {
  const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
  const thresholdPx = getLineHeightPx(container) * AUTO_SCROLL_LINE_THRESHOLD;
  return distanceFromBottom <= thresholdPx;
}

function isProcessingDetailEntry(entry: ChatEntry): boolean {
  const isSubAgentMessage = entry.role === "agent" && entry.streamSource === "sub-agent";
  if (isSubAgentMessage) {
    return true;
  }

  return (
    entry.role === "prompt"
    || entry.role === "tool-call"
    || entry.role === "tool-result"
    || entry.role === "agent-transfer"
    || entry.role === "model-call"
    || entry.role === "graph-definition"
    || entry.role === "model-response"
    || entry.role === "system-event"
    || entry.role === "conversation-metadata"
    || entry.role === "error"
  );
}

function truncateSummary(text: string, limit = 120): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}...`;
}

function formatProcessingStatus(entry: ChatEntry): string {
  if (entry.role === "prompt") {
    return "Building prompt context";
  }

  if (entry.role === "tool-call") {
    const fallback = entry.toolName?.trim();
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (parsed && typeof parsed === "object") {
        const payload = parsed as Record<string, unknown>;
        const fn = payload.function && typeof payload.function === "object"
          ? payload.function as Record<string, unknown>
          : undefined;
        const parsedName = typeof payload.name === "string"
          ? payload.name
          : (fn && typeof fn.name === "string" ? fn.name : undefined);
        const toolName = parsedName?.trim() || fallback;
        return toolName ? `Calling tool: ${toolName}` : "Calling tool";
      }
    } catch {
      // fall back to toolName/raw content
    }
    return fallback ? `Calling tool: ${fallback}` : "Calling tool";
  }

  if (entry.role === "tool-result") {
    const fallback = entry.toolName?.trim();
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (parsed && typeof parsed === "object") {
        const payload = parsed as Record<string, unknown>;
        const parsedName = typeof payload.name === "string" ? payload.name : undefined;
        const toolName = parsedName?.trim() || fallback;
        return toolName ? `Tool completed: ${toolName}` : "Tool completed";
      }
    } catch {
      // fall back to toolName/raw content
    }
    return fallback ? `Tool completed: ${fallback}` : "Tool completed";
  }

  if (entry.role === "agent-transfer") {
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (parsed && typeof parsed === "object") {
        const payload = parsed as Record<string, unknown>;
        if (typeof payload.agent === "string" && payload.agent.trim()) {
          return `Transferring to ${payload.agent.trim()}`;
        }
      }
    } catch {
      // fall through
    }
    return "Transferring to sub-agent";
  }

  if (entry.role === "model-call") {
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (parsed && typeof parsed === "object") {
        const payload = parsed as Record<string, unknown>;
        if (typeof payload.model === "string" && payload.model.trim()) {
          return `Calling model: ${payload.model.trim()}`;
        }
      }
    } catch {
      // fall through
    }
    return "Calling model";
  }

  if (entry.role === "model-response") {
    return "Model responded";
  }

  if (entry.role === "graph-definition") {
    return "Preparing graph definition";
  }

  if (entry.role === "system-event") {
    try {
      const parsed = JSON.parse(entry.content) as unknown;
      if (parsed && typeof parsed === "object") {
        const payload = parsed as Record<string, unknown>;
        if (typeof payload.event === "string" && payload.event.trim()) {
          return `System event: ${payload.event.trim()}`;
        }
      }
    } catch {
      // fall through
    }
    return truncateSummary(`System event: ${entry.content.trim()}`);
  }

  if (entry.role === "error") {
    return truncateSummary(`Error: ${entry.content.trim()}`);
  }

  if (entry.role === "agent" && entry.streamSource === "sub-agent") {
    const subAgentName = entry.streamAgentKey?.trim();
    return subAgentName
      ? `Processing with ${subAgentName}`
      : "Processing with sub-agent";
  }

  return "Processing";
}

const useStyles = makeStyles({
  container: {
    flex: "1 1 auto",
    minHeight: 0,
    position: "relative",
    display: "flex",
    flexDirection: "column",
  },
  root: {
    flex: "1 1 auto",
    minHeight: 0,
    overflowY: "auto",
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}`,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  scrollToBottomButton: {
    position: "absolute",
    left: "50%",
    bottom: tokens.spacingVerticalL,
    transform: "translateX(-50%)",
    zIndex: 1,
    boxShadow: "0 6px 16px rgba(0, 0, 0, 0.2)",
  },
  empty: {
    flex: "1 1 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
  },
  processingStatusWrapper: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    marginTop: `-${tokens.spacingVerticalXS}`,
    maxWidth: "80vw",
    alignSelf: "flex-end",
  },
  messageTimestamp: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    fontStyle: "italic",
    whiteSpace: "nowrap",
    alignSelf: "flex-start",
  },
  processingStatusBubble: {
    maxWidth: "72%",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontStyle: "italic",
  },
  processingStatusEllipsis: {
    display: "inline-flex",
    marginLeft: tokens.spacingHorizontalXXS,
  },
  processingStatusDot: {
    display: "inline-block",
    width: "0.33em",
    textAlign: "center",
    animationName: {
      "0%, 70%, 100%": { transform: "translateY(0)", opacity: 0.55 },
      "35%": { transform: "translateY(-0.22em)", opacity: 1 },
    },
    animationDuration: "0.9s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  processingStatusDot1: {
    animationDelay: "0s",
  },
  processingStatusDot2: {
    animationDelay: "0.12s",
  },
  processingStatusDot3: {
    animationDelay: "0.24s",
  },
});

interface ChatAreaProps {
  messages: ChatEntry[];
  myConversationId: string;
  showAll: boolean;
  conversationTitles?: Map<string, string>;
  showAccordionAndSubAgentMessages: boolean;
  showInlineProcessingMessages: boolean;
  showSystemMessages: boolean;
  onRequestSwitchConversation?: (conversationId: string) => void;
  modelContextWindowTokens?: number;
}

function formatSessionLabel(conversationId: string): string {
  return conversationId.startsWith("any")
    ? conversationId.slice(0, 16)
    : conversationId.slice(0, 8);
}

export function ChatArea({
  messages,
  myConversationId,
  showAll,
  conversationTitles,
  showAccordionAndSubAgentMessages,
  showInlineProcessingMessages,
  showSystemMessages,
  onRequestSwitchConversation,
  modelContextWindowTokens,
}: ChatAreaProps) {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const mainAgentStreaming = messages.some(
    (entry) =>
      entry.role === "agent"
      && entry.isStreaming
      && entry.streamSource !== "sub-agent"
      && entry.conversationId === myConversationId,
  );

  // Build a map from conversationId → chatGuid by scanning graph-definition messages.
  const chatGuidByConversationId = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of messages) {
      if (entry.role !== "graph-definition") continue;
      try {
        const parsed = JSON.parse(entry.content) as unknown;
        if (
          parsed != null &&
          typeof parsed === "object" &&
          "chatGuid" in parsed &&
          typeof (parsed as Record<string, unknown>).chatGuid === "string"
        ) {
          map.set(entry.conversationId, (parsed as Record<string, unknown>).chatGuid as string);
        }
      } catch {
        // ignore malformed JSON
      }
    }
    return map;
  }, [messages]);
  const messagesRespectingSystemPreference = useMemo(
    () => messages.filter((entry) => showSystemMessages || entry.role !== "system-event"),
    [messages, showSystemMessages],
  );

  const filteredMessages = useMemo(() => {
    if (!showAccordionAndSubAgentMessages) {
      return messagesRespectingSystemPreference.filter((entry) => !isProcessingDetailEntry(entry));
    }
    if (showInlineProcessingMessages) {
      return messagesRespectingSystemPreference;
    }
    return messagesRespectingSystemPreference.filter((entry) => !isProcessingDetailEntry(entry));
  }, [
    messagesRespectingSystemPreference,
    showAccordionAndSubAgentMessages,
    showInlineProcessingMessages,
  ]);

  const inlineProcessingStatus = useMemo(() => {
    if (!showAccordionAndSubAgentMessages || showInlineProcessingMessages) {
      return new Map<string, { anchorMessageId: string; text: string; statusMessageId: string }>();
    }

    const statusByConversation = new Map<string, { anchorMessageId: string; text: string; statusMessageId: string }>();

    // Group messages by conversation ID
    const conversationIds = new Set(messagesRespectingSystemPreference.map((m) => m.conversationId));

    for (const convId of conversationIds) {
      const convMessages = messagesRespectingSystemPreference.filter((m) => m.conversationId === convId);

      // Find last user message by searching in reverse
      let lastUserIndex = -1;
      for (let i = convMessages.length - 1; i >= 0; i--) {
        if (convMessages[i].role === "user") {
          lastUserIndex = i;
          break;
        }
      }

      if (lastUserIndex < 0) {
        continue;
      }

      const anchorUserMessage = convMessages[lastUserIndex];
      const afterUserMessages = convMessages.slice(lastUserIndex + 1);
      const hasMainAgentReply = afterUserMessages.some(
        (entry) => entry.role === "agent" && entry.streamSource !== "sub-agent",
      );
      if (hasMainAgentReply) {
        continue;
      }

      const latestProcessingEntry = [...afterUserMessages]
        .reverse()
        .find((entry) => isProcessingDetailEntry(entry));
      if (!latestProcessingEntry) {
        continue;
      }

      statusByConversation.set(convId, {
        anchorMessageId: anchorUserMessage.id,
        text: formatProcessingStatus(latestProcessingEntry),
        statusMessageId: latestProcessingEntry.id,
      });
    }

    return statusByConversation;
  }, [
    messagesRespectingSystemPreference,
    showAccordionAndSubAgentMessages,
    showInlineProcessingMessages,
  ]);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      // Use instant follow for live updates to avoid smooth-scroll races while streaming.
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [messages]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      const isWithinThreshold = isWithinAutoScrollThreshold(container);
      shouldAutoScrollRef.current = isWithinThreshold;
      setAutoScrollEnabled((current) => (current === isWithinThreshold ? current : isWithinThreshold));
    };

    // Initialize from the current position so we respect user scroll state.
    const initiallyWithinThreshold = isWithinAutoScrollThreshold(container);
    shouldAutoScrollRef.current = initiallyWithinThreshold;
    setAutoScrollEnabled(initiallyWithinThreshold);
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [filteredMessages.length]);

  const handleScrollToBottom = () => {
    shouldAutoScrollRef.current = true;
    setAutoScrollEnabled(true);
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  if (filteredMessages.length === 0) {
    return <div className={styles.empty}>Start a conversation…</div>;
  }

  return (
    <div className={styles.container}>
      <div
        ref={containerRef}
        className={styles.root}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {filteredMessages.map((entry) => {
          const isForeignConversation = showAll && entry.conversationId !== myConversationId;
          const status = inlineProcessingStatus.get(entry.conversationId);
          const hasStatusForThisEntry = status && entry.id === status.anchorMessageId && entry.role === "user";
          return (
            <React.Fragment key={entry.id}>
              <ChatMessage
                entry={entry}
                collapseSubAgentStream={mainAgentStreaming}
                modelContextWindowTokens={modelContextWindowTokens}
                sessionLabel={
                  isForeignConversation
                    ? formatSessionLabel(entry.conversationId)
                    : undefined
                }
                sessionTitle={isForeignConversation ? conversationTitles?.get(entry.conversationId) : undefined}
                sessionConversationId={isForeignConversation ? entry.conversationId : undefined}
                chatGuid={isForeignConversation ? chatGuidByConversationId.get(entry.conversationId) : undefined}
                onRequestSwitchConversation={onRequestSwitchConversation}
                suppressTimestamp={hasStatusForThisEntry}
              />
              {(() => {
                const currentStatus = inlineProcessingStatus.get(entry.conversationId);
                if (!currentStatus || entry.id !== currentStatus.anchorMessageId) {
                  return null;
                }
                const timestamp = entry.role === "user" ? formatMessageTimestamp(entry.receivedAt) : null;
                return (
                  <div
                    className={styles.processingStatusWrapper}
                    key={currentStatus.statusMessageId}
                    aria-live="polite"
                  >
                    {timestamp && (
                      <Text block className={styles.messageTimestamp}>
                        {timestamp}
                      </Text>
                    )}
                    <div className={styles.processingStatusBubble}>
                      <span>{currentStatus.text}</span>
                      <span className={styles.processingStatusEllipsis} aria-hidden="true">
                        <span className={`${styles.processingStatusDot} ${styles.processingStatusDot1}`}>.</span>
                        <span className={`${styles.processingStatusDot} ${styles.processingStatusDot2}`}>.</span>
                        <span className={`${styles.processingStatusDot} ${styles.processingStatusDot3}`}>.</span>
                      </span>
                    </div>
                  </div>
                );
              })()}
            </React.Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {!autoScrollEnabled && (
        <Button
          className={styles.scrollToBottomButton}
          appearance="secondary"
          onClick={handleScrollToBottom}
        >
          Scroll to bottom
        </Button>
      )}
    </div>
  );
}
