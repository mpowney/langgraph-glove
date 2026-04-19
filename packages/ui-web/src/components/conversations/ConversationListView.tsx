import React from "react";
import { Badge, Divider, Spinner, Text } from "@fluentui/react-components";
import type { ConversationSummary } from "../../types";
import { useConversationBrowserStyles } from "./styles";

interface ConversationListViewProps {
  listState: "idle" | "loading" | "error";
  listError: string | null;
  conversations: ConversationSummary[];
  authToken?: string;
  onLoadMessages: (threadId: string, authToken?: string) => Promise<void>;
}

export function ConversationListView({
  listState,
  listError,
  conversations,
  authToken,
  onLoadMessages,
}: ConversationListViewProps) {
  const styles = useConversationBrowserStyles();

  return (
    <>
      {listState === "loading" && <Spinner label="Loading conversations..." />}
      {listState === "error" && (
        <Text className={styles.errorText}>{listError}</Text>
      )}
      {listState === "idle" && conversations.length === 0 && (
        <Text className={styles.empty}>No conversations found.</Text>
      )}
      {conversations.map((conv, i) => (
        <React.Fragment key={conv.threadId}>
          {i > 0 && <Divider />}
          <div
            className={styles.conversationItem}
            onClick={() => void onLoadMessages(conv.threadId, authToken)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void onLoadMessages(conv.threadId, authToken);
              }
            }}
          >
            {conv.title ? (
              <Text className={styles.conversationTitle}>{conv.title}</Text>
            ) : null}
            <Text className={styles.conversationId}>{conv.threadId}</Text>
            <div className={styles.conversationMeta}>
              <Badge appearance="tint" color="informative" size="small">
                {conv.messageCount} checkpoint{conv.messageCount !== 1 ? "s" : ""}
              </Badge>
            </div>
          </div>
        </React.Fragment>
      ))}
    </>
  );
}
