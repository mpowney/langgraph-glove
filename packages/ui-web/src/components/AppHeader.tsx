import React from "react";
import {
  makeStyles,
  tokens,
  Text,
  Switch,
  Button,
  Tooltip,
} from "@fluentui/react-components";
import { DatabaseSearch24Regular } from "@fluentui/react-icons";
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
  onOpenBrowser: () => void;
}

export function AppHeader({ appInfo, status, showAll, onToggleShowAll, onOpenBrowser }: AppHeaderProps) {
  const styles = useStyles();

  const dotClass =
    status === "connected"
      ? styles.dotConnected
      : status === "connecting"
        ? styles.dotConnecting
        : styles.dotError;

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
            icon={<DatabaseSearch24Regular />}
            onClick={onOpenBrowser}
            style={{ color: tokens.colorNeutralForegroundOnBrand }}
            aria-label="Browse conversation history"
          />
        </Tooltip>
        <span className={`${styles.statusDot} ${dotClass}`} aria-hidden />
        <Text size={100} className={styles.statusLabel}>
          {STATUS_LABELS[status]}
        </Text>
      </div>
    </header>
  );
}
