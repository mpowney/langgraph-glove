import React from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Spinner,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@fluentui/react-components";
import type { ConfigVersionSummary, ConfigVersion } from "../../types";

const useStyles = makeStyles({
  historyList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    maxHeight: "400px",
    overflowY: "auto",
  },
  historyItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  historyItemInfo: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    flex: 1,
  },
  versionPreview: {
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: tokens.fontSizeBase100,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    maxHeight: "300px",
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    marginTop: tokens.spacingVerticalS,
  },
});

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface HistoryDialogProps {
  open: boolean;
  selectedFile: string | null;
  history: ConfigVersionSummary[];
  historyState: "idle" | "loading" | "error";
  historyError: string | null;
  selectedVersion: ConfigVersion | null;
  versionState: "idle" | "loading" | "error";
  versionError: string | null;
  onClose: () => void;
  onLoadVersion: (versionId: string) => Promise<void>;
  onRestoreVersion: () => void;
}

export function HistoryDialog({
  open,
  selectedFile,
  history,
  historyState,
  historyError,
  selectedVersion,
  versionState,
  versionError,
  onClose,
  onLoadVersion,
  onRestoreVersion,
}: HistoryDialogProps) {
  const styles = useStyles();

  const handleOpenChange = (_: unknown, data: { open: boolean }) => {
    if (!data.open) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogSurface style={{ maxWidth: "700px", width: "90vw" }}>
        <DialogBody>
          <DialogTitle>Version History — {selectedFile}</DialogTitle>
          <DialogContent>
            {historyState === "loading" && <Spinner />}
            {historyError && (
              <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{historyError}</Text>
            )}
            {history.length === 0 && historyState === "idle" && (
              <Text>No version history available yet.</Text>
            )}
            <div className={styles.historyList}>
              {history.map((v: ConfigVersionSummary) => (
                <div key={v.id} className={styles.historyItem}>
                  <div className={styles.historyItemInfo}>
                    <Text size={200} weight="semibold">{formatDate(v.savedAt)}</Text>
                    {v.description && <Text size={200}>{v.description}</Text>}
                    <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                      {(v.contentLength / 1024).toFixed(1)} KB
                    </Text>
                  </div>
                  <Button
                    appearance="subtle"
                    size="small"
                    onClick={() => { void onLoadVersion(v.id); }}
                    disabled={versionState === "loading"}
                  >
                    Preview
                  </Button>
                </div>
              ))}
            </div>
            {selectedVersion && (
              <div>
                <Text weight="semibold" size={200}>
                  Preview: {formatDate(selectedVersion.savedAt)}
                </Text>
                {versionError && (
                  <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{versionError}</Text>
                )}
                <div className={styles.versionPreview}>
                  {selectedVersion.content}
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {selectedVersion && (
              <Button appearance="secondary" onClick={onRestoreVersion}>
                Restore this version
              </Button>
            )}
            <Button appearance="primary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
