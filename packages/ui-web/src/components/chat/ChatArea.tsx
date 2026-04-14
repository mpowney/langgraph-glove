import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { ChatMessage } from "./ChatMessage";
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
});

interface ChatAreaProps {
  messages: ChatEntry[];
  myConversationId: string;
  showAll: boolean;
  showAccordionAndSubAgentMessages: boolean;
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
  showAccordionAndSubAgentMessages,
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
      && entry.streamSource !== "sub-agent",
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
  const filteredMessages = messages.filter((entry) => {
    if (!showSystemMessages && entry.role === "system-event") {
      return false;
    }
    if (showAccordionAndSubAgentMessages) {
      return true;
    }
    const isSubAgentMessage = entry.role === "agent" && entry.streamSource === "sub-agent";
    const isAccordionMessage =
      entry.role === "prompt"
      || entry.role === "tool-call"
      || entry.role === "tool-result"
      || entry.role === "agent-transfer"
      || entry.role === "model-call"
      || entry.role === "graph-definition"
      || entry.role === "model-response"
      || entry.role === "system-event"
      || entry.role === "error";
    return !isSubAgentMessage && !isAccordionMessage;
  });

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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
  }, []);

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
          return (
          <ChatMessage
            key={entry.id}
            entry={entry}
            collapseSubAgentStream={mainAgentStreaming}
            modelContextWindowTokens={modelContextWindowTokens}
            sessionLabel={
              isForeignConversation
                ? formatSessionLabel(entry.conversationId)
                : undefined
            }
            sessionConversationId={isForeignConversation ? entry.conversationId : undefined}
            chatGuid={isForeignConversation ? chatGuidByConversationId.get(entry.conversationId) : undefined}
            onRequestSwitchConversation={onRequestSwitchConversation}
          />
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
