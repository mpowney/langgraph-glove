import React, { useMemo, useState, useCallback, useEffect } from "react";
import { FluentProvider, makeStyles } from "@fluentui/react-components";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAppInfo } from "./hooks/useAppInfo";
import { useTheme } from "./hooks/useTheme";
import { AppHeader } from "./components/AppHeader";
import { ChatArea } from "./components/ChatArea";
import { InputBar } from "./components/InputBar";
import { ConversationBrowser } from "./components/ConversationBrowser";
import { MemoryAdmin } from "./components/MemoryAdmin";
import { checkMemoryToolAvailability } from "./hooks/memoryRpcClient";

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
  const [browserOpen, setBrowserOpen] = useState(false);
  const [memoryAdminOpen, setMemoryAdminOpen] = useState(false);
  const [memoryAvailable, setMemoryAvailable] = useState(false);

  const setShowAllPersisted = useCallback((value: boolean) => {
    localStorage.setItem("showAll", String(value));
    setShowAll(value);
  }, []);

  const isStreaming = useMemo(
    () => messages.some((m) => m.isStreaming),
    [messages],
  );
  const inputDisabled = status !== "connected" || isStreaming;
  const configuredMemoryToolUrl = (import.meta.env.VITE_MEMORY_TOOL_URL as string | undefined)?.trim() ?? "";
  const memoryToolUrl = import.meta.env.DEV
    ? (configuredMemoryToolUrl ? "/_memory_tool" : "")
    : configuredMemoryToolUrl;

  useEffect(() => {
    let active = true;

    const checkMemoryAvailability = async () => {
      const health = await checkMemoryToolAvailability(memoryToolUrl);
      if (!active) return;
      setMemoryAvailable(health.available);
    };

    void checkMemoryAvailability();
    return () => {
      active = false;
    };
  }, [memoryToolUrl]);

  const visibleMessages = useMemo(
    () => showAll ? messages : messages.filter((m) => m.conversationId === myConversationId),
    [messages, showAll, myConversationId],
  );

  return (
    <FluentProvider theme={theme}>
      <div className={styles.shell}>
        <AppHeader
          appInfo={appInfo}
          status={status}
          showAll={showAll}
          onToggleShowAll={setShowAllPersisted}
          memoryAdminEnabled={memoryAvailable}
          onOpenMemoryAdmin={() => setMemoryAdminOpen(true)}
          onOpenBrowser={() => setBrowserOpen(true)}
        />
        <ChatArea messages={visibleMessages} myConversationId={myConversationId} showAll={showAll} />
        <InputBar onSend={sendMessage} disabled={inputDisabled} />
        <ConversationBrowser open={browserOpen} onClose={() => setBrowserOpen(false)} apiBaseUrl={appInfo?.apiUrl} />
        <MemoryAdmin open={memoryAdminOpen} onClose={() => setMemoryAdminOpen(false)} memoryToolUrl={memoryToolUrl} />
      </div>
    </FluentProvider>
  );
}

export default App;
