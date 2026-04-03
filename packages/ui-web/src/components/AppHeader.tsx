import React, { useState } from "react";
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
  Field,
  Input,
} from "@fluentui/react-components";
import {
  Brain24Regular,
  Chat24Regular,
  LockClosed24Regular,
  LockClosed24Filled,
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
  memoryAdminEnabled: boolean;
  onOpenMemoryAdmin: () => void;
  onOpenBrowser: () => void;
  /** Currently active personal token (empty string = none). */
  personalToken: string;
  onSetPersonalToken: (token: string) => void;
}

export function AppHeader({
  appInfo,
  status,
  showAll,
  onToggleShowAll,
  memoryAdminEnabled,
  onOpenMemoryAdmin,
  onOpenBrowser,
  personalToken,
  onSetPersonalToken,
}: AppHeaderProps) {
  const styles = useStyles();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [draftToken, setDraftToken] = useState("");

  const dotClass =
    status === "connected"
      ? styles.dotConnected
      : status === "connecting"
        ? styles.dotConnecting
        : styles.dotError;

  const handleOpenPopover = () => {
    setDraftToken(personalToken);
    setPopoverOpen(true);
  };

  const handleSetToken = () => {
    onSetPersonalToken(draftToken.trim());
    setPopoverOpen(false);
  };

  const handleClearToken = () => {
    onSetPersonalToken("");
    setDraftToken("");
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
        <Tooltip content="Browse conversation history" relationship="label">
          <Button
            appearance="subtle"
            icon={<Chat24Regular />}
            onClick={onOpenBrowser}
            style={{ color: tokens.colorNeutralForegroundOnBrand }}
            aria-label="Browse conversation history"
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
              <Text size={200}>
                This token unlocks encrypted personal memories during this conversation.
                It is never sent to the server except as part of tool calls — it is not
                logged and is cleared when you close the tab.
              </Text>
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
              <div style={{ display: "flex", gap: tokens.spacingHorizontalS, justifyContent: "flex-end" }}>
                {personalToken && (
                  <Button appearance="subtle" onClick={handleClearToken}>
                    Clear
                  </Button>
                )}
                <Button appearance="primary" onClick={handleSetToken} disabled={!draftToken.trim()}>
                  Set token
                </Button>
              </div>
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
