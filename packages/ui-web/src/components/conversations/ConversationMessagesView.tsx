import React from "react";
import { Divider, Spinner, Text } from "@fluentui/react-components";
import type { BrowserMessage } from "../../types";
import type { FeedbackSignal } from "../../hooks/useFeedback";
import { ConversationMessageCard } from "./ConversationMessageCard";
import { useConversationBrowserStyles } from "./styles";

interface ConversationMessagesViewProps {
  selectedThreadId: string;
  messagesState: "idle" | "loading" | "error";
  messagesError: string | null;
  messages: BrowserMessage[];
  onSubmitFeedback?: (threadId: string, message: BrowserMessage, signal: FeedbackSignal, sourceView: "history") => Promise<void>;
}

export function ConversationMessagesView({
  selectedThreadId,
  messagesState,
  messagesError,
  messages,
  onSubmitFeedback,
}: ConversationMessagesViewProps) {
  const styles = useConversationBrowserStyles();

  return (
    <>
      <Text className={styles.threadTitle}>{selectedThreadId}</Text>
      {messagesState === "loading" && <Spinner label="Loading messages..." />}
      {messagesState === "error" && (
        <Text className={styles.errorText}>{messagesError}</Text>
      )}
      {messagesState === "idle" && messages.length === 0 && (
        <Text className={styles.empty}>No messages in this conversation.</Text>
      )}
      {messages.map((message, i) => (
        <React.Fragment key={message.id || i}>
          {i > 0 && <Divider />}
          <ConversationMessageCard
            threadId={selectedThreadId}
            message={message}
            onSubmitFeedback={onSubmitFeedback}
          />
        </React.Fragment>
      ))}
    </>
  );
}
