import React, { useEffect } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Spinner,
  Divider,
  Badge,
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
} from "@fluentui/react-components";
import { Dismiss24Regular, ArrowLeft24Regular, ArrowClockwise24Regular } from "@fluentui/react-icons";
import { useConversationBrowser } from "../hooks/useConversationBrowser";
import type { BrowserMessage } from "../types";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerActions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalM} 0`,
    overflowY: "auto",
  },
  // Conversation list
  conversationItem: {
    display: "flex",
    flexDirection: "column",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  conversationId: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    wordBreak: "break-all",
  },
  conversationMeta: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    marginTop: tokens.spacingVerticalXXS,
  },
  // Message list
  messageItem: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    borderLeft: `3px solid transparent`,
  },
  messageHuman: {
    borderLeftColor: tokens.colorBrandBackground,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  messageAi: {
    borderLeftColor: "#33cc33",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  messageTool: {
    borderLeftColor: "#9966cc",
    backgroundColor: tokens.colorNeutralBackground3,
  },
  messageSystem: {
    borderLeftColor: tokens.colorNeutralStroke1,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  messageRole: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: tokens.colorNeutralForeground3,
  },
  messageContent: {
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    color: tokens.colorNeutralForeground1,
    maxHeight: "200px",
    overflowY: "auto",
  },
  toolCallChip: {
    display: "inline-block",
    padding: `1px ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground4,
    fontSize: tokens.fontSizeBase100,
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground2,
    marginRight: tokens.spacingHorizontalXS,
  },
  empty: {
    padding: tokens.spacingVerticalL,
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  threadTitle: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    wordBreak: "break-all",
    padding: `0 ${tokens.spacingHorizontalM}`,
  },
});

const ROLE_LABELS: Record<BrowserMessage["role"], string> = {
  human: "User",
  ai: "Agent",
  tool: "Tool",
  system: "System",
};

interface MessageViewProps {
  message: BrowserMessage;
}

function MessageView({ message }: MessageViewProps) {
  const styles = useStyles();
  const roleClass =
    message.role === "human"
      ? styles.messageHuman
      : message.role === "ai"
        ? styles.messageAi
        : message.role === "tool"
          ? styles.messageTool
          : styles.messageSystem;

  return (
    <div className={`${styles.messageItem} ${roleClass}`}>
      <Text className={styles.messageRole}>{ROLE_LABELS[message.role]}</Text>
      {message.tool_calls?.length ? (
        <div>
          {message.tool_calls.map((tc) => (
            <span key={tc.id} className={styles.toolCallChip}>
              {tc.name}(…)
            </span>
          ))}
        </div>
      ) : null}
      {message.tool_call_id && (
        <Text className={styles.messageRole} style={{ color: "inherit", opacity: 0.6 }}>
          tool_call_id: {message.tool_call_id}
        </Text>
      )}
      <Text className={styles.messageContent}>{message.content || <em>(empty)</em>}</Text>
    </div>
  );
}

export interface ConversationBrowserProps {
  open: boolean;
  onClose: () => void;
  /** Base URL of the AdminApi server. Defaults to same origin when absent. */
  apiBaseUrl?: string;
  /** Optional bearer token for protected admin API routes. */
  authToken?: string;
}

export function ConversationBrowser({
  open,
  onClose,
  apiBaseUrl = "",
  authToken,
}: ConversationBrowserProps) {
  const styles = useStyles();
  const {
    conversations,
    messages,
    selectedThreadId,
    listState,
    messagesState,
    listError,
    messagesError,
    loadConversations,
    loadMessages,
    clearSelection,
  } = useConversationBrowser(apiBaseUrl);

  // Reload conversation list whenever the drawer opens
  useEffect(() => {
    if (open) {
      clearSelection();
      void loadConversations(authToken);
    }
  }, [open, clearSelection, loadConversations, authToken]);

  const inMessageView = selectedThreadId !== null;

  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, { open: o }) => { if (!o) onClose(); }}
      position="end"
      size="medium"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <div className={styles.headerActions}>
              {inMessageView && (
                <Button
                  appearance="subtle"
                  icon={<ArrowLeft24Regular />}
                  onClick={clearSelection}
                  aria-label="Back to conversations"
                />
              )}
              <Button
                appearance="subtle"
                icon={<ArrowClockwise24Regular />}
                onClick={inMessageView && selectedThreadId
                  ? () => void loadMessages(selectedThreadId, authToken)
                  : () => void loadConversations(authToken)}
                aria-label="Refresh"
              />
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                onClick={onClose}
                aria-label="Close"
              />
            </div>
          }
        >
          {inMessageView ? "Conversation" : "Conversations"}
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div className={styles.body}>
          {!inMessageView ? (
            // ── Conversation list ──────────────────────────────────────────
            <>
              {listState === "loading" && <Spinner label="Loading conversations…" />}
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
                    onClick={() => void loadMessages(conv.threadId, authToken)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && loadMessages(conv.threadId)}
                  >
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
          ) : (
            // ── Message list ───────────────────────────────────────────────
            <>
              <Text className={styles.threadTitle}>{selectedThreadId}</Text>
              {messagesState === "loading" && <Spinner label="Loading messages…" />}
              {messagesState === "error" && (
                <Text className={styles.errorText}>{messagesError}</Text>
              )}
              {messagesState === "idle" && messages.length === 0 && (
                <Text className={styles.empty}>No messages in this conversation.</Text>
              )}
              {messages.map((msg, i) => (
                <React.Fragment key={msg.id || i}>
                  {i > 0 && <Divider />}
                  <MessageView message={msg} />
                </React.Fragment>
              ))}
            </>
          )}
        </div>
      </DrawerBody>
    </OverlayDrawer>
  );
}
