import React, { useEffect, useMemo, useState } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Switch,
  Button,
  Tooltip,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Field,
  Input,
  Spinner,
  Divider,
} from "@fluentui/react-components";
import {
  ArrowReset24Regular,
  Brain24Regular,
  Chat24Regular,
  LockClosed24Regular,
  LockClosed24Filled,
  Wrench24Regular,
} from "@fluentui/react-icons";
import type { AppInfo, ConnectionStatus } from "../types";

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
  privilegedChip: {
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: "rgba(255, 255, 255, 0.16)",
    color: tokens.colorNeutralForegroundOnBrand,
  },
  privilegedActive: {
    backgroundColor: "rgba(31, 138, 62, 0.28)",
  },
  privilegedPopover: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    minWidth: "300px",
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
  const [privilegedPopoverOpen, setPrivilegedPopoverOpen] = useState(false);
  const [privilegedTokenDraft, setPrivilegedTokenDraft] = useState("");
  const [currentPrivilegeTokenDraft, setCurrentPrivilegeTokenDraft] = useState("");
  const [newPrivilegeTokenDraft, setNewPrivilegeTokenDraft] = useState("");
  const [confirmNewPrivilegeTokenDraft, setConfirmNewPrivilegeTokenDraft] = useState("");
  const [privilegedError, setPrivilegedError] = useState<string | null>(null);
  const [privilegedNotice, setPrivilegedNotice] = useState<string | null>(null);
  const [isEnablingPrivileged, setIsEnablingPrivileged] = useState(false);
  const [isUpdatingRegisteredToken, setIsUpdatingRegisteredToken] = useState(false);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [tokenDialogError, setTokenDialogError] = useState<string | null>(null);
  const [tokenDialogNotice, setTokenDialogNotice] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());

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

  useEffect(() => {
    if (!privilegedAccessActive || !privilegedAccessExpiresAt) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [privilegedAccessActive, privilegedAccessExpiresAt]);

  const privilegedCountdown = useMemo(() => {
    if (!privilegedAccessActive || !privilegedAccessExpiresAt) return null;
    const deltaMs = Date.parse(privilegedAccessExpiresAt) - nowMs;
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return "expiring";
    const totalSeconds = Math.ceil(deltaMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }, [privilegedAccessActive, privilegedAccessExpiresAt, nowMs]);

  const handleEnablePrivilegedWithToken = async () => {
    const token = privilegedTokenDraft.trim();
    if (!token) {
      setPrivilegedError("Privilege token is required");
      return;
    }

    setPrivilegedError(null);
    setPrivilegedNotice(null);
    setIsEnablingPrivileged(true);
    const ok = await onEnablePrivilegedAccessWithToken(token);
    setIsEnablingPrivileged(false);
    if (!ok) {
      setPrivilegedError(authError ?? "Unable to enable privileged access");
      return;
    }

    setPrivilegedTokenDraft("");
    setPrivilegedNotice("Privileged access enabled for 10 minutes.");
    setPrivilegedPopoverOpen(false);
  };

  const handleEnablePrivilegedWithPasskey = async () => {
    if (!onEnablePrivilegedAccessWithPasskey) return;
    setPrivilegedError(null);
    setPrivilegedNotice(null);
    setIsEnablingPrivileged(true);
    const ok = await onEnablePrivilegedAccessWithPasskey();
    setIsEnablingPrivileged(false);
    if (!ok) {
      setPrivilegedError(authError ?? "Passkey activation failed");
      return;
    }
    setPrivilegedTokenDraft("");
    setPrivilegedNotice("Privileged access enabled for 10 minutes.");
    setPrivilegedPopoverOpen(false);
  };

  const handleUpdateRegisteredPrivilegeToken = async () => {
    const currentToken = currentPrivilegeTokenDraft.trim();
    const newToken = newPrivilegeTokenDraft.trim();
    const confirmNewToken = confirmNewPrivilegeTokenDraft.trim();

    if (!currentToken) {
      setTokenDialogError("Current privilege token is required");
      return;
    }
    if (!newToken) {
      setTokenDialogError("New privilege token is required");
      return;
    }
    if (newToken !== confirmNewToken) {
      setTokenDialogError("New privilege token values do not match");
      return;
    }

    setTokenDialogError(null);
    setTokenDialogNotice(null);
    setIsUpdatingRegisteredToken(true);
    const ok = await onRegisterPrivilegeToken(newToken, currentToken);
    setIsUpdatingRegisteredToken(false);
    if (!ok) {
      setTokenDialogError(authError ?? "Unable to update privilege token");
      return;
    }

    setCurrentPrivilegeTokenDraft("");
    setNewPrivilegeTokenDraft("");
    setConfirmNewPrivilegeTokenDraft("");
    setTokenDialogError(null);
    setTokenDialogNotice("Privilege token updated.");
    setTokenDialogOpen(false);
    setPrivilegedNotice("Privilege token updated.");
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
        <Popover
          open={privilegedPopoverOpen}
          onOpenChange={(_, data) => {
            if (!data.open) {
              setPrivilegedPopoverOpen(false);
              setPrivilegedError(null);
              return;
            }
            setPrivilegedPopoverOpen(true);
          }}
        >
          <PopoverTrigger disableButtonEnhancement>
            <Button
              appearance="subtle"
              onClick={() => setPrivilegedPopoverOpen(true)}
              style={{ color: tokens.colorNeutralForegroundOnBrand }}
              aria-label={privilegedAccessActive ? "Privileged access active" : "Enable privileged access"}
            >
              <Text
                size={100}
                className={`${styles.privilegedChip} ${privilegedAccessActive ? styles.privilegedActive : ""}`}
              >
                {privilegedAccessActive
                  ? `Privileged access active${privilegedCountdown ? ` (${privilegedCountdown})` : ""}`
                  : "Privileged access inactive"}
              </Text>
            </Button>
          </PopoverTrigger>
          <PopoverSurface>
            <div className={styles.privilegedPopover}>
              <Text weight="semibold">Privileged access</Text>
              <Text size={200} style={{ maxWidth: "320px" }}>
                Enable a 10-minute privileged window before running admin tools.
              </Text>
              {!privilegeTokenRegistered && (
                <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                  Privilege token is not registered yet. Complete setup registration first.
                </Text>
              )}
              {privilegedAccessActive ? (
                <>
                  <Text size={200}>
                    Privileged access is active{privilegedCountdown ? ` (${privilegedCountdown} remaining)` : ""}.
                  </Text>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <Button appearance="secondary" onClick={onDisablePrivilegedAccess}>
                      Disable now
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <Field label="Privilege token">
                    <Input
                      type="password"
                      value={privilegedTokenDraft}
                      onChange={(_, data) => setPrivilegedTokenDraft(data.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void handleEnablePrivilegedWithToken(); }}
                      placeholder="Enter privilege token"
                    />
                  </Field>
                  <div style={{ display: "flex", gap: tokens.spacingHorizontalS, justifyContent: "flex-end" }}>
                    {passkeyEnabled && onEnablePrivilegedAccessWithPasskey && (
                      <Button
                        appearance="secondary"
                        onClick={() => { void handleEnablePrivilegedWithPasskey(); }}
                        disabled={isEnablingPrivileged}
                      >
                        Use passkey
                      </Button>
                    )}
                    <Button
                      appearance="primary"
                      onClick={() => { void handleEnablePrivilegedWithToken(); }}
                      disabled={isEnablingPrivileged || !privilegeTokenRegistered}
                    >
                      {isEnablingPrivileged ? <Spinner size="tiny" /> : "Enable"}
                    </Button>
                  </div>
                </>
              )}

              {privilegeTokenRegistered && !privilegedAccessActive && (
                <>
                  <Divider />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <Text size={200} weight="semibold">Change registered privilege token</Text>
                    <Dialog open={tokenDialogOpen} onOpenChange={(_, data) => {
                      setTokenDialogOpen(data.open);
                      if (!data.open) {
                        setTokenDialogError(null);
                        setTokenDialogNotice(null);
                      }
                    }}>
                      <DialogTrigger disableButtonEnhancement>
                        <Button
                          appearance="secondary"
                          onClick={() => {
                            setTokenDialogOpen(true);
                            setTokenDialogError(null);
                            setTokenDialogNotice(null);
                          }}
                        >
                          Change token
                        </Button>
                      </DialogTrigger>
                      <DialogSurface>
                        <DialogBody>
                          <DialogTitle>Change privilege token</DialogTitle>
                          <DialogContent>
                            <div style={{ display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS }}>
                              <Field label="Current token">
                                <Input
                                  type="password"
                                  value={currentPrivilegeTokenDraft}
                                  onChange={(_, data) => setCurrentPrivilegeTokenDraft(data.value)}
                                  autoFocus
                                />
                              </Field>
                              <Field label="New token">
                                <Input
                                  type="password"
                                  value={newPrivilegeTokenDraft}
                                  onChange={(_, data) => setNewPrivilegeTokenDraft(data.value)}
                                />
                              </Field>
                              <Field label="Confirm new token">
                                <Input
                                  type="password"
                                  value={confirmNewPrivilegeTokenDraft}
                                  onChange={(_, data) => setConfirmNewPrivilegeTokenDraft(data.value)}
                                  onKeyDown={(e) => { if (e.key === "Enter") void handleUpdateRegisteredPrivilegeToken(); }}
                                />
                              </Field>
                              {tokenDialogError && (
                                <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                  {tokenDialogError}
                                </Text>
                              )}
                              {tokenDialogNotice && (
                                <Text size={200} style={{ color: tokens.colorPaletteGreenForeground1 }}>
                                  {tokenDialogNotice}
                                </Text>
                              )}
                            </div>
                          </DialogContent>
                          <DialogActions>
                            <DialogTrigger disableButtonEnhancement>
                              <Button appearance="secondary">Cancel</Button>
                            </DialogTrigger>
                            <Button
                              appearance="primary"
                              onClick={() => { void handleUpdateRegisteredPrivilegeToken(); }}
                              disabled={isUpdatingRegisteredToken}
                            >
                              {isUpdatingRegisteredToken ? <Spinner size="tiny" /> : "Update token"}
                            </Button>
                          </DialogActions>
                        </DialogBody>
                      </DialogSurface>
                    </Dialog>
                  </div>
                </>
              )}
              {privilegedError && (
                <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                  {privilegedError}
                </Text>
              )}
              {privilegedNotice && (
                <Text size={200} style={{ color: tokens.colorPaletteGreenForeground1 }}>
                  {privilegedNotice}
                </Text>
              )}
            </div>
          </PopoverSurface>
        </Popover>
        <span className={`${styles.statusDot} ${dotClass}`} aria-hidden />
        <Text size={100} className={styles.statusLabel}>
          {STATUS_LABELS[status]}
        </Text>
      </div>
    </header>
  );
}
