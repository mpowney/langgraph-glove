import React, { useMemo, useState, useCallback, useEffect } from "react";
import {
  FluentProvider,
  makeStyles,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Text,
} from "@fluentui/react-components";
import { useWebSocket } from "./hooks/useWebSocket";
import { useAppInfo } from "./hooks/useAppInfo";
import { useTheme } from "./hooks/useTheme";
import { AppHeader } from "./components/AppHeader";
import { ChatArea } from "./components/ChatArea";
import { InputBar } from "./components/InputBar";
import { ConversationBrowser } from "./components/ConversationBrowser";
import { MemoryAdmin } from "./components/MemoryAdmin";
import { ToolsPanel } from "./components/ToolsPanel";
import { AuthGate } from "./components/AuthGate";
import { checkMemoryToolAvailability } from "./hooks/memoryRpcClient";
import { useAuth } from "./hooks/useAuth";
import { createUuid } from "./uuid";

const PERSONAL_TOKEN_KEY = "glove_personal_token";
const CONVERSATION_ID_KEY = "glove_conversation_id";
const SHOW_DETAILS_KEY = "glove_show_accordion_and_sub_agents";
const SHOW_SYSTEM_MESSAGES_KEY = "glove_show_system_messages";

function resolveAuthApiBaseUrl(rawApiUrl: string | undefined): string | null {
  if (!rawApiUrl?.trim()) return null;

  try {
    const url = new URL(rawApiUrl);
    // If backend metadata points to a loopback/any address, use the current page host
    // so remote browsers still reach the same server machine.
    if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(url.hostname)) {
      url.hostname = window.location.hostname;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return rawApiUrl;
  }
}

function getOrCreateConversationId(): string {
  const existing = localStorage.getItem(CONVERSATION_ID_KEY)?.trim();
  if (existing) return existing;
  const generated = createUuid();
  localStorage.setItem(CONVERSATION_ID_KEY, generated);
  return generated;
}

function formatSessionLabel(conversationId: string): string {
  return conversationId.startsWith("any")
    ? conversationId.slice(0, 16)
    : conversationId.slice(0, 8);
}

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
  const resolvedAdminApiBaseUrl = resolveAuthApiBaseUrl(appInfo?.apiUrl) ?? "";
  const adminApiBaseUrl = import.meta.env.DEV ? "" : resolvedAdminApiBaseUrl;
  const authApiBaseUrl = adminApiBaseUrl;
  const auth = useAuth(authApiBaseUrl);
  const [personalToken, setPersonalTokenState] = useState<string>(
    () => sessionStorage.getItem(PERSONAL_TOKEN_KEY) ?? "",
  );
  const [conversationId, setConversationId] = useState<string>(() => getOrCreateConversationId());
  const [privilegedGrantId, setPrivilegedGrantId] = useState<string>("");
  const [privilegedExpiresAt, setPrivilegedExpiresAt] = useState<string | null>(null);
  const shouldConnect = !auth.loading;
  const webSocketPersonalToken = shouldConnect ? personalToken || undefined : undefined;
  const webSocketPrivilegeGrantId = shouldConnect ? privilegedGrantId || undefined : undefined;
  const webSocketAuthToken = shouldConnect ? auth.token ?? undefined : undefined;
  const { messages, sendMessage, status, myConversationId } = useWebSocket(
    conversationId,
    webSocketPersonalToken,
    webSocketPrivilegeGrantId,
    webSocketAuthToken,
  );
  const styles = useStyles();
  const [showAll, setShowAll] = useState(
    () => localStorage.getItem("showAll") === "true",
  );
  const [showAccordionAndSubAgentMessages, setShowAccordionAndSubAgentMessages] = useState(
    () => localStorage.getItem(SHOW_DETAILS_KEY) !== "false",
  );
  const [showSystemMessages, setShowSystemMessages] = useState(
    () => localStorage.getItem(SHOW_SYSTEM_MESSAGES_KEY) !== "false",
  );
  const [browserOpen, setBrowserOpen] = useState(false);
  const [memoryAdminOpen, setMemoryAdminOpen] = useState(false);
  const [toolsPanelOpen, setToolsPanelOpen] = useState(false);
  const [memoryAvailable, setMemoryAvailable] = useState(false);
  const [pendingConversationSwitchId, setPendingConversationSwitchId] = useState<string | null>(null);

  const setShowAllPersisted = useCallback((value: boolean) => {
    localStorage.setItem("showAll", String(value));
    setShowAll(value);
  }, []);

  const setShowAccordionAndSubAgentMessagesPersisted = useCallback((value: boolean) => {
    localStorage.setItem(SHOW_DETAILS_KEY, String(value));
    setShowAccordionAndSubAgentMessages(value);
  }, []);

  const setShowSystemMessagesPersisted = useCallback((value: boolean) => {
    localStorage.setItem(SHOW_SYSTEM_MESSAGES_KEY, String(value));
    setShowSystemMessages(value);
  }, []);

  const setPersonalToken = useCallback((token: string) => {
    if (token) {
      sessionStorage.setItem(PERSONAL_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(PERSONAL_TOKEN_KEY);
    }
    setPersonalTokenState(token);
  }, []);

  const registerPrivilegeToken = useCallback(async (newToken: string, currentToken?: string): Promise<boolean> => {
    return auth.registerPrivilegeToken(newToken, currentToken);
  }, [auth]);

  const activatePrivilegedAccessWithToken = useCallback(async (token: string): Promise<boolean> => {
    const activation = await auth.activatePrivilegedAccess(conversationId, { token });
    if (!activation?.active) return false;
    setPrivilegedGrantId(activation.grantId);
    setPrivilegedExpiresAt(activation.expiresAt);
    return true;
  }, [auth, conversationId]);

  const activatePrivilegedAccessWithPasskey = useCallback(async (): Promise<boolean> => {
    const activation = await auth.activatePrivilegedAccess(conversationId, { usePasskey: true });
    if (!activation?.active) return false;
    setPrivilegedGrantId(activation.grantId);
    setPrivilegedExpiresAt(activation.expiresAt);
    return true;
  }, [auth, conversationId]);

  const disablePrivilegedAccess = useCallback(async (): Promise<void> => {
    await auth.revokePrivilegedAccess(conversationId);
    setPrivilegedGrantId("");
    setPrivilegedExpiresAt(null);
  }, [auth, conversationId]);

  useEffect(() => {
    if (!privilegedExpiresAt) return;
    const expiryMs = Date.parse(privilegedExpiresAt);
    if (!Number.isFinite(expiryMs)) return;

    const remaining = expiryMs - Date.now();
    if (remaining <= 0) {
      setPrivilegedGrantId("");
      setPrivilegedExpiresAt(null);
      return;
    }

    const timer = window.setTimeout(() => {
      setPrivilegedGrantId("");
      setPrivilegedExpiresAt(null);
    }, remaining + 50);

    return () => window.clearTimeout(timer);
  }, [privilegedExpiresAt]);

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

  useEffect(() => {
    let active = true;

    const refreshPrivilegedStatus = async () => {
      if (!auth.token) return;
      const status = await auth.getPrivilegedAccessStatus(conversationId);
      if (!active || !status) return;

      if (!status.active) {
        setPrivilegedGrantId("");
        setPrivilegedExpiresAt(null);
        return;
      }

      if (status.grantId) {
        setPrivilegedGrantId(status.grantId);
      }
      setPrivilegedExpiresAt(status.expiresAt ?? null);
    };

    void refreshPrivilegedStatus();
    const timer = window.setInterval(() => {
      void refreshPrivilegedStatus();
    }, 30_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [auth.token, auth.getPrivilegedAccessStatus, conversationId]);

  const visibleMessages = useMemo(
    () => showAll ? messages : messages.filter((m) => m.conversationId === myConversationId),
    [messages, showAll, myConversationId],
  );

  const handleStartNewConversation = useCallback(() => {
    const nextConversationId = createUuid();
    localStorage.setItem(CONVERSATION_ID_KEY, nextConversationId);
    setConversationId(nextConversationId);
  }, []);

  const handleSwitchConversation = useCallback((targetConversationId: string) => {
    if (targetConversationId === conversationId) return;
    setPendingConversationSwitchId(targetConversationId);
  }, [conversationId]);

  const handleConfirmSwitchConversation = useCallback(() => {
    if (!pendingConversationSwitchId) return;
    localStorage.setItem(CONVERSATION_ID_KEY, pendingConversationSwitchId);
    setConversationId(pendingConversationSwitchId);
    setPendingConversationSwitchId(null);
  }, [pendingConversationSwitchId]);

  const handleCancelSwitchConversation = useCallback(() => {
    setPendingConversationSwitchId(null);
  }, []);

  if (authApiBaseUrl !== null && (auth.loading || !auth.authenticated || auth.promptPasskeySetup || auth.promptPrivilegeTokenSetup)
  ) {
    return (
      <FluentProvider theme={theme}>
        <AuthGate
          loading={auth.loading}
          setupRequired={auth.setupRequired}
          forcePasskeySetup={auth.promptPasskeySetup}
          passkeySetupRequired={auth.passkeySetupRequired}
          forcePrivilegeTokenSetup={auth.promptPrivilegeTokenSetup}
          minPasswordLength={auth.minPasswordLength}
          passkeyRegistered={auth.passkeyRegistered}
          privilegeTokenRegistered={auth.privilegeTokenRegistered}
          error={auth.error}
          onLogin={auth.login}
          onSetup={auth.setup}
          onLoginWithPasskey={auth.loginWithPasskey}
          onRegisterPasskey={auth.registerPasskey}
          onSkipPasskeySetup={auth.dismissPasskeySetupPrompt}
          onRegisterPrivilegeToken={registerPrivilegeToken}
          onSkipPrivilegeTokenSetup={auth.dismissPrivilegeTokenSetupPrompt}
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
          showAccordionAndSubAgentMessages={showAccordionAndSubAgentMessages}
          onToggleShowAccordionAndSubAgentMessages={setShowAccordionAndSubAgentMessagesPersisted}
          showSystemMessages={showSystemMessages}
          onToggleShowSystemMessages={setShowSystemMessagesPersisted}
          onStartNewConversation={handleStartNewConversation}
          memoryAdminEnabled={memoryAvailable}
          onOpenMemoryAdmin={() => setMemoryAdminOpen(true)}
          onOpenBrowser={() => setBrowserOpen(true)}
          onOpenToolsPanel={() => setToolsPanelOpen(true)}
          personalToken={personalToken}
          onSetPersonalToken={setPersonalToken}
          passkeyEnabled={auth.passkeyRegistered}
          onGeneratePersonalTokenWithPasskey={auth.generatePersonalTokenWithPasskey}
          privilegedAccessActive={Boolean(privilegedGrantId)}
          privilegedAccessExpiresAt={privilegedExpiresAt ?? undefined}
          onEnablePrivilegedAccessWithToken={activatePrivilegedAccessWithToken}
          onEnablePrivilegedAccessWithPasskey={activatePrivilegedAccessWithPasskey}
          onDisablePrivilegedAccess={() => { void disablePrivilegedAccess(); }}
          privilegeTokenRegistered={auth.privilegeTokenRegistered}
          onRegisterPrivilegeToken={registerPrivilegeToken}
          authError={auth.error}
        />
        <ChatArea
          messages={visibleMessages}
          myConversationId={myConversationId}
          showAll={showAll}
          showAccordionAndSubAgentMessages={showAccordionAndSubAgentMessages}
          showSystemMessages={showSystemMessages}
          onRequestSwitchConversation={handleSwitchConversation}
          modelContextWindowTokens={appInfo?.modelContextWindowTokens}
        />
        <InputBar onSend={sendMessage} disabled={inputDisabled} />
        <ConversationBrowser
          open={browserOpen}
          onClose={() => setBrowserOpen(false)}
          apiBaseUrl={adminApiBaseUrl}
          authToken={auth.token ?? undefined}
        />
        <ToolsPanel
          open={toolsPanelOpen}
          onClose={() => setToolsPanelOpen(false)}
          apiBaseUrl={adminApiBaseUrl}
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
      <Dialog
        open={Boolean(pendingConversationSwitchId)}
        onOpenChange={(_, data) => {
          if (!data.open) {
            handleCancelSwitchConversation();
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Switch conversation?</DialogTitle>
            <DialogContent>
              <Text block>
                {pendingConversationSwitchId
                  ? `Switch to session ${formatSessionLabel(pendingConversationSwitchId)}?`
                  : "Switch to this conversation?"}
              </Text>
              <Text block>
                Future messages and actions will use that conversation context.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={handleCancelSwitchConversation}>
                Cancel
              </Button>
              <Button appearance="primary" onClick={handleConfirmSwitchConversation}>
                Switch conversation
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </FluentProvider>
  );
}

export default App;
