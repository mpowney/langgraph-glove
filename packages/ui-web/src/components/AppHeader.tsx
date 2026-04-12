import React, { useState } from "react";
import {
  makeStyles,
  mergeClasses,
  tokens,
  Text,
  Switch,
  Button,
  Tooltip,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Field,
  Input,
  Spinner,
} from "@fluentui/react-components";
import {
  ArrowReset24Regular,
  Brain24Regular,
  Chat24Regular,
  DocumentEdit24Regular,
  LockClosed24Regular,
  LockClosed24Filled,
  Wrench24Regular,
} from "@fluentui/react-icons";
import type { AppInfo, ConnectionStatus } from "../types";
import { PrivilegedAccessButton } from "./PrivilegedAccessButton";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    flexShrink: 0,
  },
  titleGroup: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  title: {
    color: tokens.colorNeutralForegroundOnBrand,
    fontWeight: tokens.fontWeightSemibold,
  },
  description: {
    color: tokens.colorNeutralForegroundOnBrand,
    opacity: 0.8,
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  statusDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    flexShrink: 0,
  },
  dotConnected: {
    backgroundColor: "#33cc33",
    boxShadow: "0 0 4px #33cc33",
  },
  dotConnecting: {
    backgroundColor: "#ffaa00",
    boxShadow: "0 0 4px #ffaa00",
  },
  dotError: {
    backgroundColor: "#ff3333",
    boxShadow: "0 0 4px #ff3333",
  },
  statusLabel: {
    color: tokens.colorNeutralForegroundOnBrand,
    opacity: 0.9,
  },
  switchLabel: {
    color: tokens.colorNeutralForegroundOnBrand,
    opacity: 0.9,
  },
  tokenActive: {
    color: tokens.colorPaletteGreenForeground1,
  },
  tokenPopover: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    minWidth: "260px",
  },
});

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Connection error",
};

interface AppHeaderProps {
  appInfo: AppInfo | null;
  status: ConnectionStatus;
  showAll: boolean;
  onToggleShowAll: (value: boolean) => void;
  showAccordionAndSubAgentMessages: boolean;
  onToggleShowAccordionAndSubAgentMessages: (value: boolean) => void;
  showSystemMessages: boolean;
  onToggleShowSystemMessages: (value: boolean) => void;
  onStartNewConversation: () => void;
  memoryAdminEnabled: boolean;
  onOpenMemoryAdmin: () => void;
  onOpenBrowser: () => void;
  onOpenToolsPanel: () => void;
  onOpenConfigAdmin: () => void;
  /** Currently active personal token (empty string = none). */
  personalToken: string;
  onSetPersonalToken: (token: string) => void;
  passkeyEnabled?: boolean;
  onGeneratePersonalTokenWithPasskey?: () => Promise<string | null>;
  privilegedAccessActive: boolean;
  privilegedAccessExpiresAt?: string;
  onEnablePrivilegedAccessWithToken: (token: string) => Promise<boolean>;
  onEnablePrivilegedAccessWithPasskey?: () => Promise<boolean>;
  onDisablePrivilegedAccess: () => void;
  privilegeTokenRegistered: boolean;
  onRegisterPrivilegeToken: (newToken: string, currentToken?: string) => Promise<boolean>;
  authError?: string | null;
}

export function AppHeader({
  appInfo,
  status,
  showAll,
  onToggleShowAll,
  showAccordionAndSubAgentMessages,
  onToggleShowAccordionAndSubAgentMessages,
  showSystemMessages,
  onToggleShowSystemMessages,
  onStartNewConversation,
  memoryAdminEnabled,
  onOpenMemoryAdmin,
  onOpenBrowser,
  onOpenToolsPanel,
  onOpenConfigAdmin,
  personalToken,
  onSetPersonalToken,
  passkeyEnabled = false,
  onGeneratePersonalTokenWithPasskey,
  privilegedAccessActive,
  privilegedAccessExpiresAt,
  onEnablePrivilegedAccessWithToken,
  onEnablePrivilegedAccessWithPasskey,
  onDisablePrivilegedAccess,
  privilegeTokenRegistered,
  onRegisterPrivilegeToken,
  authError,
}: AppHeaderProps) {
  const styles = useStyles();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [draftToken, setDraftToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [isGeneratingWithPasskey, setIsGeneratingWithPasskey] = useState(false);
  const dotClass =
    status === "connected"
      ? styles.dotConnected
      : status === "connecting"
        ? styles.dotConnecting
        : styles.dotError;

  const handleOpenPopover = () => {
    setDraftToken(personalToken);
    setTokenError(null);
    setPopoverOpen(true);
  };

  const handleSetToken = () => {
    setTokenError(null);
    onSetPersonalToken(draftToken.trim());
    setPopoverOpen(false);
  };

  const handleClearToken = () => {
    setTokenError(null);
    onSetPersonalToken("");
    setDraftToken("");
    setPopoverOpen(false);
  };

  const handleGenerateTokenWithPasskey = async () => {
    if (!onGeneratePersonalTokenWithPasskey) return;

    setTokenError(null);
    setIsGeneratingWithPasskey(true);
    const generatedToken = await onGeneratePersonalTokenWithPasskey();
    setIsGeneratingWithPasskey(false);

    if (!generatedToken) {
      setTokenError("Passkey verification failed. Try again.");
      return;
    }

    onSetPersonalToken(generatedToken);
    setDraftToken(generatedToken);
    setPopoverOpen(false);
  };

  return (
    <header className={styles.root}>
      <div className={styles.titleGroup}>
        <Text size={500} className={styles.title}>
          {appInfo?.name ?? "LangGraph Glove"}
        </Text>
        {appInfo?.agentDescription && (
          <Text size={200} className={styles.description}>
            {appInfo.agentDescription}
          </Text>
        )}
      </div>
      <div className={styles.statusRow} role="status" aria-label={`WebSocket: ${STATUS_LABELS[status]}`}>
        <Switch
          checked={showAll}
          onChange={(_, data) => onToggleShowAll(data.checked)}
          label={<Text size={100} className={styles.switchLabel}>All conversations</Text>}
        />
        <Switch
          checked={showAccordionAndSubAgentMessages}
          onChange={(_, data) => onToggleShowAccordionAndSubAgentMessages(data.checked)}
          label={<Text size={100} className={styles.switchLabel}>Agent processing details</Text>}
        />
        <Switch
          checked={showSystemMessages}
          onChange={(_, data) => onToggleShowSystemMessages(data.checked)}
          label={<Text size={100} className={styles.switchLabel}>System messages</Text>}
        />
        <Button
          appearance="secondary"
          icon={<ArrowReset24Regular />}
          onClick={onStartNewConversation}
          size="small"
        >
          Start new conversation
        </Button>
        <Tooltip content="Browse conversation history" relationship="label">
          <Button
            appearance="subtle"
            icon={<Chat24Regular />}
            onClick={onOpenBrowser}
            style={{ color: tokens.colorNeutralForegroundOnBrand }}
            aria-label="Browse conversation history"
          />
        </Tooltip>
        <Tooltip content="Tools &amp; agents reference" relationship="label">
          <Button
            appearance="subtle"
            icon={<Wrench24Regular />}
            onClick={onOpenToolsPanel}
            style={{ color: tokens.colorNeutralForegroundOnBrand }}
            aria-label="Tools and agents reference"
          />
        </Tooltip>
        <Tooltip content="Config editor" relationship="label">
          <Button
            appearance="subtle"
            icon={<DocumentEdit24Regular />}
            onClick={onOpenConfigAdmin}
            style={{ color: tokens.colorNeutralForegroundOnBrand }}
            aria-label="Config editor"
          />
        </Tooltip>
        <Tooltip
          content={memoryAdminEnabled
            ? "Open memory admin"
            : "Memory tool unavailable"}
          relationship="label"
        >
          <Button
            appearance="subtle"
            icon={<Brain24Regular />}
            onClick={onOpenMemoryAdmin}
            disabled={!memoryAdminEnabled}
            style={{ color: tokens.colorNeutralForegroundOnBrand }}
            aria-label="Open memory admin"
          />
        </Tooltip>
        <Popover open={popoverOpen} onOpenChange={(_, data) => { if (!data.open) setPopoverOpen(false); }}>
          <PopoverTrigger disableButtonEnhancement>
            <Tooltip
              content={personalToken ? "Personal token active — click to change" : "Set personal token for encrypted memories"}
              relationship="label"
            >
              <Button
                appearance="subtle"
                icon={personalToken ? <LockClosed24Filled className={styles.tokenActive} /> : <LockClosed24Regular />}
                onClick={handleOpenPopover}
                style={{ color: tokens.colorNeutralForegroundOnBrand }}
                aria-label={personalToken ? "Personal token active" : "Set personal token"}
              />
            </Tooltip>
          </PopoverTrigger>
          <PopoverSurface>
            <div className={styles.tokenPopover}>
              <Text weight="semibold">Personal memory token</Text>
              <Text size={200} style={{ maxWidth: "300px" }}>
                A personal memory token is used to encrypt personal or sensitive 
                information stored as memories. Any time the agent needs access
                to encrypted memories, the token must be provided.
              </Text>
              {passkeyEnabled && onGeneratePersonalTokenWithPasskey && (
                <Button
                  appearance="secondary"
                  onClick={() => { void handleGenerateTokenWithPasskey(); }}
                  disabled={isGeneratingWithPasskey}
                >
                  {isGeneratingWithPasskey ? <Spinner size="tiny" /> : "Use passkey"}
                </Button>
              )}
              <Field label="Token">
                <Input
                  type="password"
                  value={draftToken}
                  onChange={(_, data) => setDraftToken(data.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSetToken(); }}
                  placeholder="Enter personal token"
                  autoFocus
                />
              </Field>
              {tokenError && (
                <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                  {tokenError}
                </Text>
              )}
              <div style={{ display: "flex", gap: tokens.spacingHorizontalS, justifyContent: "flex-end" }}>
                {personalToken && (
                  <Button appearance="subtle" onClick={handleClearToken}>
                    Clear
                  </Button>
                )}
                <Button
                  appearance="primary"
                  onClick={handleSetToken}
                  disabled={!draftToken.trim() || isGeneratingWithPasskey}
                >
                  Set token
                </Button>
              </div>
            </div>
          </PopoverSurface>
        </Popover>
        <PrivilegedAccessButton
          onBrand
          privilegedAccessActive={privilegedAccessActive}
          privilegedAccessExpiresAt={privilegedAccessExpiresAt}
          onEnablePrivilegedAccessWithToken={onEnablePrivilegedAccessWithToken}
          onEnablePrivilegedAccessWithPasskey={onEnablePrivilegedAccessWithPasskey}
          onDisablePrivilegedAccess={onDisablePrivilegedAccess}
          privilegeTokenRegistered={privilegeTokenRegistered}
          onRegisterPrivilegeToken={onRegisterPrivilegeToken}
          authError={authError}
          passkeyEnabled={passkeyEnabled}
        />
        <span className={mergeClasses(styles.statusDot, dotClass)} aria-hidden />
        <Text size={100} className={styles.statusLabel}>
          {STATUS_LABELS[status]}
        </Text>
      </div>
    </header>
  );
}
