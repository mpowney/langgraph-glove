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
}

export function ChatArea({ messages, myConversationId, showAll }: ChatAreaProps) {
  const styles = useStyles();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return <div className={styles.empty}>Start a conversation…</div>;
  }

  return (
    <div className={styles.root} role="log" aria-live="polite" aria-label="Chat messages">
      {messages.map((entry) => (
        <ChatMessage
          key={entry.id}
          entry={entry}
          sessionLabel={
            showAll && entry.conversationId !== myConversationId
              ? entry.conversationId.slice(0, 8)
              : undefined
          }
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
