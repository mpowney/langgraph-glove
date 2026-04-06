import React, { useEffect, useRef } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { ChatMessage } from "./ChatMessage";
import type { ChatEntry } from "../types";

const useStyles = makeStyles({
  root: {
    flex: "1 1 auto",
    overflowY: "auto",
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}`,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
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
  onRequestSwitchConversation?: (conversationId: string) => void;
  modelContextWindowTokens?: number;
}

export function ChatArea({
  messages,
  myConversationId,
  showAll,
  onRequestSwitchConversation,
  modelContextWindowTokens,
}: ChatAreaProps) {
  const styles = useStyles();
  const bottomRef = useRef<HTMLDivElement>(null);
  const mainAgentStreaming = messages.some(
    (entry) =>
      entry.role === "agent"
      && entry.isStreaming
      && entry.streamSource !== "sub-agent",
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return <div className={styles.empty}>Start a conversation…</div>;
  }

  return (
    <div className={styles.root} role="log" aria-live="polite" aria-label="Chat messages">
      {messages.map((entry) => {
        const isForeignConversation = showAll && entry.conversationId !== myConversationId;
        return (
        <ChatMessage
          key={entry.id}
          entry={entry}
          collapseSubAgentStream={mainAgentStreaming}
          modelContextWindowTokens={modelContextWindowTokens}
          sessionLabel={
            isForeignConversation
              ? entry.conversationId.slice(0, 8)
              : undefined
          }
          sessionConversationId={isForeignConversation ? entry.conversationId : undefined}
          onRequestSwitchConversation={onRequestSwitchConversation}
        />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
