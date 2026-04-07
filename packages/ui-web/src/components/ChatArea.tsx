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
  showAccordionAndSubAgentMessages: boolean;
  onRequestSwitchConversation?: (conversationId: string) => void;
  modelContextWindowTokens?: number;
}

function formatSessionLabel(conversationId: string): string {
  return conversationId.startsWith("any")
    ? conversationId
    : conversationId.slice(0, 8);
}

export function ChatArea({
  messages,
  myConversationId,
  showAll,
  showAccordionAndSubAgentMessages,
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
  const filteredMessages = showAccordionAndSubAgentMessages
    ? messages
    : messages.filter((entry) => {
        const isSubAgentMessage = entry.role === "agent" && entry.streamSource === "sub-agent";
        const isAccordionMessage =
          entry.role === "prompt"
          || entry.role === "tool-call"
          || entry.role === "tool-result"
          || entry.role === "agent-transfer"
          || entry.role === "model-call"
          || entry.role === "model-response"
          || entry.role === "error";
        return !isSubAgentMessage && !isAccordionMessage;
      });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (filteredMessages.length === 0) {
    return <div className={styles.empty}>Start a conversation…</div>;
  }

  return (
    <div className={styles.root} role="log" aria-live="polite" aria-label="Chat messages">
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
          onRequestSwitchConversation={onRequestSwitchConversation}
        />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
