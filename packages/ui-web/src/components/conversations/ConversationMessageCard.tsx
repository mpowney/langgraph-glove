import React from "react";
import { Button, Text, mergeClasses } from "@fluentui/react-components";
import { ThumbLike24Regular, ThumbDislike24Regular } from "@fluentui/react-icons";
import type { BrowserMessage } from "../../types";
import type { FeedbackSignal } from "../../hooks/useFeedback";
import {
  formatMessageTimestamp,
  reorderModelResponsePayload,
  toDisplayJson,
} from "../chat/utils/dataFormatters";
import { ROLE_LABELS } from "./roleMeta";
import { useConversationBrowserStyles } from "./styles";

interface ConversationMessageCardProps {
  threadId: string;
  message: BrowserMessage;
  onSubmitFeedback?: (threadId: string, message: BrowserMessage, signal: FeedbackSignal, sourceView: "history") => Promise<void>;
}

function roleClassName(message: BrowserMessage, styles: ReturnType<typeof useConversationBrowserStyles>): string {
  switch (message.role) {
    case "human":
      return styles.roleUser;
    case "ai":
      return styles.roleAgent;
    case "prompt":
      return styles.rolePrompt;
    case "tool":
      return styles.roleToolResult;
    case "tool-call":
      return styles.roleToolCall;
    case "tool-result":
      return styles.roleToolResult;
    case "agent-transfer":
      return styles.roleAgentTransfer;
    case "model-call":
      return styles.roleModelCall;
    case "model-response":
      return styles.roleModelResponse;
    case "graph-definition":
      return styles.roleGraphDefinition;
    case "system":
      return styles.roleSystem;
    case "system-event":
      return styles.roleSystem;
    default:
      return styles.roleError;
  }
}

export function ConversationMessageCard({
  threadId,
  message,
  onSubmitFeedback,
}: ConversationMessageCardProps) {
  const styles = useConversationBrowserStyles();
  const [selectedSignal, setSelectedSignal] = React.useState<FeedbackSignal | null>(null);
  const [pending, setPending] = React.useState(false);

  const handleFeedback = async (signal: FeedbackSignal): Promise<void> => {
    if (!onSubmitFeedback || pending) return;
    setPending(true);
    try {
      await onSubmitFeedback(threadId, message, signal, "history");
      setSelectedSignal(signal);
    } finally {
      setPending(false);
    }
  };

  const displayContent = React.useMemo(() => {
    if (message.role !== "model-response") return message.content;
    try {
      const parsed = JSON.parse(message.content) as unknown;
      return toDisplayJson(reorderModelResponsePayload(parsed), message.content);
    } catch {
      return message.content;
    }
  }, [message.content, message.role]);

  return (
    <div className={mergeClasses(styles.messageItem, roleClassName(message, styles))}>
      <Text className={styles.messageRole}>{ROLE_LABELS[message.role]}</Text>
      {message.tool_calls?.length ? (
        <div>
          {message.tool_calls.map((tc) => (
            <span key={tc.id} className={styles.toolCallChip}>
              {tc.name}(...)
            </span>
          ))}
        </div>
      ) : null}
      {message.tool_call_id && (
        <Text className={styles.messageRole} style={{ color: "inherit", opacity: 0.6 }}>
          tool_call_id: {message.tool_call_id}
        </Text>
      )}
      {message.toolName && (
        <Text className={styles.messageRole} style={{ color: "inherit", opacity: 0.7 }}>
          tool: {message.toolName}
        </Text>
      )}
      <Text className={styles.messageContent}>{displayContent || <em>(empty)</em>}</Text>
      {message.receivedAt && (
        <Text className={styles.messageTimestamp}>{formatMessageTimestamp(message.receivedAt)}</Text>
      )}
      {message.role !== "human" && (
        <div className={styles.feedbackRow}>
          <Button
            size="small"
            appearance={selectedSignal === "like" ? "primary" : "subtle"}
            icon={<ThumbLike24Regular />}
            aria-label="Like this history message"
            disabled={pending}
            onClick={() => { void handleFeedback("like"); }}
          />
          <Button
            size="small"
            appearance={selectedSignal === "dislike" ? "primary" : "subtle"}
            icon={<ThumbDislike24Regular />}
            aria-label="Dislike this history message"
            disabled={pending}
            onClick={() => { void handleFeedback("dislike"); }}
          />
        </div>
      )}
    </div>
  );
}
