import React, { useState } from "react";
import {
  makeStyles,
  mergeClasses,
  tokens,
  Text,
  Button,
  Spinner,
  Divider,
  Tooltip,
} from "@fluentui/react-components";
import {
  Add24Regular,
  Eye24Regular,
  EyeOff24Regular,
  Edit24Regular,
} from "@fluentui/react-icons";
import type { SecretEntry } from "../../hooks/useSecrets";
import { SecretDialog } from "./SecretDialog";

const useStyles = makeStyles({
  root: {
    width: "220px",
    flexShrink: 0,
    borderLeft: `1px solid ${tokens.colorNeutralStroke1}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: `0 ${tokens.spacingHorizontalXS}`,
  },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    gap: tokens.spacingHorizontalXS,
  },
  itemActive: {
    backgroundColor: tokens.colorPaletteGreenBackground1,
  },
  itemName: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "Consolas, 'Courier New', monospace",
  },
  itemNameActive: {
    color: tokens.colorPaletteGreenForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  itemActions: {
    display: "flex",
    gap: "2px",
    flexShrink: 0,
  },
  revealedValue: {
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    marginBottom: tokens.spacingVerticalXS,
    wordBreak: "break-all",
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
  },
  emptyState: {
    padding: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground3,
  },
});

interface SecretsPanelProps {
  secrets: SecretEntry[];
  secretFiles: Array<{ name: string }>;
  secretsLoading: boolean;
  secretsError?: string | null;
  upsertError?: string | null;
  upsertLoading: boolean;
  /** Secret names referenced in the currently-edited config item */
  activeSecretNames: string[];
  onRevealSecret: (name: string) => Promise<string | null>;
  onSaveSecret: (file: string, name: string, value: string) => Promise<boolean>;
}

export function SecretsPanel({
  secrets,
  secretFiles,
  secretsLoading,
  secretsError,
  upsertError,
  upsertLoading,
  activeSecretNames,
  onRevealSecret,
  onSaveSecret,
}: SecretsPanelProps) {
  const styles = useStyles();
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [revealingName, setRevealingName] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingSecret, setEditingSecret] = useState<SecretEntry | null>(null);

  const handleToggleReveal = async (name: string) => {
    if (revealedValues[name] !== undefined) {
      // Hide it
      setRevealedValues((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      return;
    }

    setRevealingName(name);
    const value = await onRevealSecret(name);
    setRevealingName(null);
    if (value !== null) {
      setRevealedValues((prev) => ({ ...prev, [name]: value }));
    }
  };

  const activeSet = new Set(activeSecretNames);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text weight="semibold" size={200}>
          Secrets
        </Text>
        <Tooltip content="Add secret" relationship="label">
          <Button
            appearance="subtle"
            icon={<Add24Regular />}
            size="small"
            onClick={() => {
              setEditingSecret(null);
              setAddDialogOpen(true);
            }}
          />
        </Tooltip>
      </div>
      <Divider />

      {secretsLoading && (
        <div className={styles.emptyState}>
          <Spinner size="tiny" />
        </div>
      )}
      {secretsError && (
        <Text size={100} className={styles.emptyState}>
          {secretsError}
        </Text>
      )}

      <div className={styles.list}>
        {secrets.length === 0 && !secretsLoading && (
          <Text size={100} className={styles.emptyState}>
            No secrets found
          </Text>
        )}
        {secrets.map((secret) => {
          const isActive = activeSet.has(secret.name);
          const isRevealed = revealedValues[secret.name] !== undefined;
          const isRevealing = revealingName === secret.name;

          return (
            <div key={`${secret.file}:${secret.name}`}>
              <div
                className={mergeClasses(
                  styles.item,
                  isActive && styles.itemActive,
                )}
              >
                <Tooltip content={secret.name} relationship="label">
                  <Text
                    size={100}
                    className={mergeClasses(
                      styles.itemName,
                      isActive && styles.itemNameActive,
                    )}
                  >
                    {secret.name}
                  </Text>
                </Tooltip>
                <div className={styles.itemActions}>
                  <Tooltip
                    content={isRevealed ? "Hide value" : "Show value"}
                    relationship="label"
                  >
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={
                        isRevealing ? (
                          <Spinner size="tiny" />
                        ) : isRevealed ? (
                          <EyeOff24Regular />
                        ) : (
                          <Eye24Regular />
                        )
                      }
                      onClick={() => {
                        void handleToggleReveal(secret.name);
                      }}
                      disabled={isRevealing}
                    />
                  </Tooltip>
                  <Tooltip content="Edit value" relationship="label">
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<Edit24Regular />}
                      onClick={() => {
                        setEditingSecret(secret);
                        setAddDialogOpen(true);
                      }}
                    />
                  </Tooltip>
                </div>
              </div>
              {isRevealed && (
                <div className={styles.revealedValue}>
                  {revealedValues[secret.name]}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <SecretDialog
        open={addDialogOpen}
        onClose={() => {
          setAddDialogOpen(false);
          setEditingSecret(null);
        }}
        initialName={editingSecret?.name}
        initialFile={editingSecret?.file}
        secretFiles={secretFiles}
        isSaving={upsertLoading}
        saveError={upsertError}
        onSave={onSaveSecret}
      />
    </div>
  );
}
