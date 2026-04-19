import React, { useEffect } from "react";
import {
  Button,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
} from "@fluentui/react-components";
import {
  ArrowClockwise24Regular,
  ArrowLeft24Regular,
  Dismiss24Regular,
} from "@fluentui/react-icons";
import { useConversationBrowser } from "../../hooks/useConversationBrowser";
import type { BrowserMessage, FeedbackContext } from "../../types";
import type { FeedbackSignal } from "../../hooks/useFeedback";
import { ConversationListView } from "./ConversationListView";
import { ConversationMessagesView } from "./ConversationMessagesView";
import { useConversationBrowserStyles } from "./styles";

export interface ConversationBrowserProps {
  open: boolean;
  onClose: () => void;
  apiBaseUrl?: string;
  authToken?: string;
  onSubmitFeedback?: (threadId: string, message: BrowserMessage, signal: FeedbackSignal, sourceView: "history") => Promise<void>;
  defaultFeedbackContext?: FeedbackContext;
}

export function ConversationBrowser({
  open,
  onClose,
  apiBaseUrl = "",
  authToken,
  onSubmitFeedback,
  defaultFeedbackContext,
}: ConversationBrowserProps) {
  const styles = useConversationBrowserStyles();
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

  const messagesWithFeedback = React.useMemo(
    () => messages.map((message) => ({
      ...message,
      feedbackContext: message.feedbackContext ?? defaultFeedbackContext,
    })),
    [messages, defaultFeedbackContext],
  );

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
      onOpenChange={(_, { open: isOpen }) => { if (!isOpen) onClose(); }}
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
            <ConversationListView
              listState={listState}
              listError={listError}
              conversations={conversations}
              authToken={authToken}
              onLoadMessages={loadMessages}
            />
          ) : (
            <ConversationMessagesView
              selectedThreadId={selectedThreadId}
              messagesState={messagesState}
              messagesError={messagesError}
              messages={messagesWithFeedback}
              onSubmitFeedback={onSubmitFeedback}
            />
          )}
        </div>
      </DrawerBody>
    </OverlayDrawer>
  );
}
