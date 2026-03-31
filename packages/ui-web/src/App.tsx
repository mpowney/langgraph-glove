import React, { useMemo, useState, useCallback } from "react";
import { FluentProvider, makeStyles } from "@fluentui/react-components";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAppInfo } from "./hooks/useAppInfo";
import { useTheme } from "./hooks/useTheme";
import { AppHeader } from "./components/AppHeader";
import { ChatArea } from "./components/ChatArea";
import { InputBar } from "./components/InputBar";

const conversationId = crypto.randomUUID();

const useStyles = makeStyles({
  shell: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    overflow: "hidden",
  },
});

function App() {
  const theme = useTheme();
  const appInfo = useAppInfo();
  const { messages, sendMessage, status, myConversationId } = useWebSocket(conversationId);
  const styles = useStyles();
  const [showAll, setShowAll] = useState(
    () => localStorage.getItem("showAll") === "true",
  );

  const setShowAllPersisted = useCallback((value: boolean) => {
    localStorage.setItem("showAll", String(value));
    setShowAll(value);
  }, []);

  const isStreaming = useMemo(
    () => messages.some((m) => m.isStreaming),
    [messages],
  );
  const inputDisabled = status !== "connected" || isStreaming;

  const visibleMessages = useMemo(
    () => showAll ? messages : messages.filter((m) => m.conversationId === myConversationId),
    [messages, showAll, myConversationId],
  );

  return (
    <FluentProvider theme={theme}>
      <div className={styles.shell}>
        <AppHeader appInfo={appInfo} status={status} showAll={showAll} onToggleShowAll={setShowAllPersisted} />
        <ChatArea messages={visibleMessages} myConversationId={myConversationId} showAll={showAll} />
        <InputBar onSend={sendMessage} disabled={inputDisabled} />
      </div>
    </FluentProvider>
  );
}

export default App;
