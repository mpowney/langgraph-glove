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
import { AuthGate } from "./components/AuthGate";
import { checkMemoryToolAvailability } from "./hooks/memoryRpcClient";
import { useAuth } from "./hooks/useAuth";

const PERSONAL_TOKEN_KEY = "glove_personal_token";

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
  const authApiBaseUrl = appInfo?.apiUrl ?? null;
  const auth = useAuth(authApiBaseUrl);
  const [personalToken, setPersonalTokenState] = useState<string>(
    () => sessionStorage.getItem(PERSONAL_TOKEN_KEY) ?? "",
  );
  const shouldConnect = !auth.loading;
  const webSocketPersonalToken = shouldConnect ? personalToken || undefined : undefined;
  const webSocketAuthToken = shouldConnect ? auth.token ?? undefined : undefined;
  const { messages, sendMessage, status, myConversationId } = useWebSocket(conversationId, webSocketPersonalToken, webSocketAuthToken);
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

  const setPersonalToken = useCallback((token: string) => {
    if (token) {
      sessionStorage.setItem(PERSONAL_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(PERSONAL_TOKEN_KEY);
    }
    setPersonalTokenState(token);
  }, []);

  const isStreaming = useMemo(
    () => messages.some((m) => m.isStreaming),
    [messages],
  );
  const inputDisabled = status !== "connected" || isStreaming;
  const configuredToolsBaseUrl = (import.meta.env.VITE_TOOLS_URL as string | undefined)?.trim() ?? "";
  const legacyMemoryToolUrl = (import.meta.env.VITE_MEMORY_TOOL_URL as string | undefined)?.trim() ?? "";
  // Use the generic tools route in dev; in production prefer a generic tools base
  // and keep VITE_MEMORY_TOOL_URL as a backward-compatible fallback.
  const memoryToolUrl = import.meta.env.DEV
    ? "/api/tools/_memory"
    : configuredToolsBaseUrl
      ? `${configuredToolsBaseUrl.replace(/\/$/, "")}/_memory`
      : legacyMemoryToolUrl;

  useEffect(() => {
    let active = true;

    const checkMemoryAvailability = async () => {
      const health = await checkMemoryToolAvailability(memoryToolUrl, auth.token ?? undefined);
      if (!active) return;
      setMemoryAvailable(health.available);
    };

    void checkMemoryAvailability();
    return () => {
      active = false;
    };
  }, [memoryToolUrl, auth.token]);

  const visibleMessages = useMemo(
    () => showAll ? messages : messages.filter((m) => m.conversationId === myConversationId),
    [messages, showAll, myConversationId],
  );

  if (authApiBaseUrl !== null && (auth.loading || !auth.authenticated)) {
    return (
      <FluentProvider theme={theme}>
        <AuthGate
          loading={auth.loading}
          setupRequired={auth.setupRequired}
          minPasswordLength={auth.minPasswordLength}
          error={auth.error}
          onLogin={auth.login}
          onSetup={auth.setup}
        />
      </FluentProvider>
    );
  }

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
          personalToken={personalToken}
          onSetPersonalToken={setPersonalToken}
        />
        <ChatArea messages={visibleMessages} myConversationId={myConversationId} showAll={showAll} />
        <InputBar onSend={sendMessage} disabled={inputDisabled} />
        <ConversationBrowser
          open={browserOpen}
          onClose={() => setBrowserOpen(false)}
          apiBaseUrl={appInfo?.apiUrl}
          authToken={auth.token ?? undefined}
        />
        <MemoryAdmin
          open={memoryAdminOpen}
          onClose={() => setMemoryAdminOpen(false)}
          memoryToolUrl={memoryToolUrl}
          authToken={auth.token ?? undefined}
          personalToken={personalToken}
        />
      </div>
    </FluentProvider>
  );
}

export default App;
