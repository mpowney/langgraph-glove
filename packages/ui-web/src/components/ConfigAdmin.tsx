import React, { useCallback, useEffect, useState, useMemo } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Spinner,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  Divider,
  Tab,
  TabList,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  MessageBar,
  MessageBarBody,
  Field,
  Textarea,
} from "@fluentui/react-components";
import {
  Dismiss24Regular,
  DocumentEdit24Regular,
  History24Regular,
  CheckmarkCircle24Regular,
  Save24Regular,
  ArrowReset24Regular,
  ChevronRight24Regular,
  Warning24Regular,
  ErrorCircle24Regular,
} from "@fluentui/react-icons";
import type {
  ConfigFileSummary,
  ConfigVersionSummary,
  ConfigValidationIssue,
} from "../types";
import { useConfigAdmin } from "../hooks/useConfigAdmin";

const useStyles = makeStyles({
  drawerBody: {
    display: "flex",
    flexDirection: "row",
    gap: "0",
    padding: "0",
    overflow: "hidden",
    height: "100%",
  },
  fileBrowser: {
    width: "200px",
    flexShrink: 0,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  fileBrowserTitle: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    fontWeight: tokens.fontWeightSemibold,
    flexShrink: 0,
  },
  fileList: {
    flex: 1,
    overflowY: "auto",
  },
  fileItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    cursor: "pointer",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  fileItemSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    ":hover": {
      backgroundColor: tokens.colorBrandBackground2Hover,
    },
  },
  editorPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  editorToolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
    gap: tokens.spacingHorizontalS,
  },
  editorToolbarRight: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  editorContent: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  rawEditorRoot: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    borderRadius: 0,
    border: "none",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  rawEditorTextarea: {
    flex: 1,
    minHeight: 0,
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: tokens.fontSizeBase200,
    lineHeight: "1.5",
    resize: "none",
    overflow: "auto",
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    padding: tokens.spacingHorizontalM,
  },
  friendlyEditorScroll: {
    flex: 1,
    overflowY: "auto",
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
  },
  editorBottomBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
    gap: tokens.spacingHorizontalS,
  },
  editorBottomBarRight: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground3,
  },
  issueList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    maxHeight: "120px",
    overflowY: "auto",
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  issueItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalXS,
    fontSize: tokens.fontSizeBase100,
  },
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
  friendlyEntry: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} 0`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  friendlyEntryKey: {
    fontWeight: tokens.fontWeightSemibold,
    fontFamily: "Consolas, 'Courier New', monospace",
  },
  friendlyField: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  noPrivileged: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalXL,
    textAlign: "center",
  },
});

interface ConfigAdminProps {
  open: boolean;
  onClose: () => void;
  configToolUrl: string;
  privilegeGrantId: string;
  conversationId: string;
  authToken?: string;
  /** Admin RPC handler to restart the core service */
  onRestartService?: () => Promise<void>;
}

type EditorTab = "raw" | "friendly";

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Simple friendly view for a single config entry. */
function FriendlyEntryEditor({
  entryKey,
  value,
  onChange,
}: {
  entryKey: string;
  value: unknown;
  onChange: (key: string, newValue: unknown) => void;
}) {
  const styles = useStyles();

  if (typeof value !== "object" || value === null) {
    return (
      <div className={styles.friendlyEntry}>
        <Text className={styles.friendlyEntryKey}>{entryKey}</Text>
        <Field label={entryKey}>
          <Textarea
            value={String(value)}
            onChange={(_, data) => onChange(entryKey, data.value)}
            rows={1}
          />
        </Field>
      </div>
    );
  }

  const obj = value as Record<string, unknown>;

  return (
    <div className={styles.friendlyEntry}>
      <Text className={styles.friendlyEntryKey}>{entryKey}</Text>
      {Object.entries(obj).map(([fieldKey, fieldValue]) => {
        const fieldLabel = fieldKey.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
        const stringValue =
          typeof fieldValue === "string"
            ? fieldValue
            : typeof fieldValue === "number" || typeof fieldValue === "boolean"
              ? String(fieldValue)
              : JSON.stringify(fieldValue, null, 2);

        const isLong =
          typeof fieldValue === "object" ||
          (typeof fieldValue === "string" && fieldValue.length > 80);

        return (
          <div key={fieldKey} className={styles.friendlyField}>
            <Field label={fieldLabel}>
              <Textarea
                value={stringValue}
                rows={isLong ? 4 : 1}
                onChange={(_, data) => {
                  let parsed: unknown = data.value;
                  if (typeof fieldValue === "number") {
                    parsed = Number(data.value);
                  } else if (typeof fieldValue === "boolean") {
                    parsed = data.value === "true";
                  } else if (typeof fieldValue === "object") {
                    try {
                      parsed = JSON.parse(data.value);
                    } catch {
                      parsed = data.value;
                    }
                  }
                  onChange(entryKey, { ...obj, [fieldKey]: parsed });
                }}
              />
            </Field>
          </div>
        );
      })}
    </div>
  );
}

export function ConfigAdmin({
  open,
  onClose,
  configToolUrl,
  privilegeGrantId,
  conversationId,
  authToken,
  onRestartService,
}: ConfigAdminProps) {
  const styles = useStyles();

  const {
    filesState,
    readState,
    writeState,
    historyState,
    versionState,
    filesError,
    readError,
    writeError,
    historyError,
    versionError,
    files,
    selectedFile,
    fileContent,
    history,
    selectedVersion,
    loadFiles,
    loadFileContent,
    saveFileContent,
    loadHistory,
    loadVersion,
    validateContent,
    clearSelectedVersion,
  } = useConfigAdmin(configToolUrl, privilegeGrantId, conversationId, authToken);

  const [editorTab, setEditorTab] = useState<EditorTab>("raw");
  const [draftContent, setDraftContent] = useState<string>("");
  const [isDirty, setIsDirty] = useState(false);
  const [validationIssues, setValidationIssues] = useState<ConfigValidationIssue[]>([]);
  const [showValidation, setShowValidation] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [checkDialogOpen, setCheckDialogOpen] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const hasPrivilege = Boolean(privilegeGrantId) && Boolean(conversationId);

  // Load files on open when privilege is available
  useEffect(() => {
    if (open && hasPrivilege) {
      void loadFiles();
    }
  }, [open, hasPrivilege, loadFiles]);

  // When a file is selected or fileContent changes, update draft
  useEffect(() => {
    setDraftContent(fileContent);
    setIsDirty(false);
    setValidationIssues([]);
    setShowValidation(false);
    setSaveNotice(null);
  }, [fileContent]);

  const handleSelectFile = useCallback(
    (filename: string) => {
      if (isDirty) {
        // TODO: could add a confirmation dialog here — for now just navigate away
      }
      void loadFileContent(filename);
      setEditorTab("raw");
    },
    [loadFileContent, isDirty],
  );

  const handleEditorChange = useCallback((value: string) => {
    setDraftContent(value);
    setIsDirty(true);
    setSaveNotice(null);
  }, []);

  const handleCheck = useCallback(() => {
    if (!selectedFile) return;
    const issues = validateContent(selectedFile, draftContent);
    setValidationIssues(issues);
    setShowValidation(true);
    setCheckDialogOpen(true);
  }, [selectedFile, draftContent, validateContent]);

  const handleSave = useCallback(async () => {
    if (!selectedFile) return;
    const ok = await saveFileContent(selectedFile, draftContent);
    if (ok) {
      setIsDirty(false);
      setSaveNotice(`Saved ${selectedFile} successfully.`);
    }
  }, [selectedFile, draftContent, saveFileContent]);

  const handleShowHistory = useCallback(async () => {
    if (!selectedFile) return;
    await loadHistory(selectedFile);
    setHistoryDialogOpen(true);
  }, [selectedFile, loadHistory]);

  const handleLoadVersion = useCallback(
    async (versionId: string) => {
      await loadVersion(versionId);
    },
    [loadVersion],
  );

  const handleRestoreVersion = useCallback(() => {
    if (!selectedVersion) return;
    setDraftContent(selectedVersion.content);
    setIsDirty(true);
    setHistoryDialogOpen(false);
    clearSelectedVersion();
  }, [selectedVersion, clearSelectedVersion]);

  const handleRestart = useCallback(async () => {
    if (!onRestartService) return;
    setIsRestarting(true);
    setRestartResult(null);
    try {
      await onRestartService();
      setRestartResult("Service restart initiated successfully.");
    } catch (err) {
      setRestartResult(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRestarting(false);
    }
  }, [onRestartService]);

  // Friendly editor: parse the draft content and allow editing
  const parsedConfig = useMemo(() => {
    try {
      return JSON.parse(draftContent) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [draftContent]);

  const handleFriendlyChange = useCallback(
    (key: string, value: unknown) => {
      if (!parsedConfig) return;
      const updated = { ...parsedConfig, [key]: value };
      const newContent = JSON.stringify(updated, null, 2);
      setDraftContent(newContent);
      setIsDirty(true);
      setSaveNotice(null);
    },
    [parsedConfig],
  );

  const renderEditorContent = () => {
    if (!selectedFile) {
      return (
        <div className={styles.emptyState}>
          <DocumentEdit24Regular style={{ fontSize: "48px" }} />
          <Text size={400}>Select a config file to edit</Text>
          <Text size={200}>Choose a file from the left panel</Text>
        </div>
      );
    }

    if (readState === "loading") {
      return (
        <div className={styles.emptyState}>
          <Spinner size="large" />
          <Text>Loading {selectedFile}…</Text>
        </div>
      );
    }

    if (readError) {
      return (
        <div className={styles.emptyState}>
          <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{readError}</Text>
        </div>
      );
    }

    if (editorTab === "raw") {
      return (
        <>
          <Textarea
            className={styles.rawEditorRoot}
            textarea={{ className: styles.rawEditorTextarea }}
            value={draftContent}
            onChange={(_, data) => handleEditorChange(data.value)}
            spellCheck={false}
            aria-label={`Raw JSON editor for ${selectedFile}`}
            resize="none"
            appearance="filled-darker"
          />
          {showValidation && validationIssues.length > 0 && (
            <div className={styles.issueList}>
              {validationIssues.map((issue, i) => (
                <div key={i} className={styles.issueItem}>
                  {issue.severity === "error" ? (
                    <ErrorCircle24Regular style={{ color: tokens.colorPaletteRedForeground1, flexShrink: 0 }} />
                  ) : (
                    <Warning24Regular style={{ color: tokens.colorPaletteYellowForeground1, flexShrink: 0 }} />
                  )}
                  <Text size={200}>
                    <strong>{issue.path}</strong>: {issue.message}
                  </Text>
                </div>
              ))}
            </div>
          )}
        </>
      );
    }

    // Friendly editor
    if (!parsedConfig) {
      return (
        <div className={styles.emptyState}>
          <ErrorCircle24Regular style={{ color: tokens.colorPaletteRedForeground1 }} />
          <Text>Invalid JSON — switch to Raw mode to fix syntax errors</Text>
        </div>
      );
    }

    return (
      <div className={styles.friendlyEditorScroll}>
        {Object.entries(parsedConfig).map(([key, value]) => (
          <FriendlyEntryEditor
            key={key}
            entryKey={key}
            value={value}
            onChange={handleFriendlyChange}
          />
        ))}
        {Object.keys(parsedConfig).length === 0 && (
          <Text>No entries — add entries in Raw mode.</Text>
        )}
      </div>
    );
  };

  if (!hasPrivilege) {
    return (
      <OverlayDrawer
        open={open}
        onOpenChange={(_, data) => { if (!data.open) onClose(); }}
        position="end"
        size="large"
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} aria-label="Close" />
            }
          >
            Config Editor
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className={styles.noPrivileged}>
            <Text size={500} weight="semibold">Privileged access required</Text>
            <Text>
              Enable privileged access from the header to use the config editor.
              All config operations require a valid privilege grant.
            </Text>
          </div>
        </DrawerBody>
      </OverlayDrawer>
    );
  }

  return (
    <>
      <OverlayDrawer
        open={open}
        onOpenChange={(_, data) => { if (!data.open) onClose(); }}
        position="end"
        size="large"
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} aria-label="Close" />
            }
          >
            Config Editor
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className={styles.drawerBody}>
            {/* File Browser */}
            <div className={styles.fileBrowser}>
              <Text className={styles.fileBrowserTitle} size={200}>Config Files</Text>
              <Divider />
              {filesState === "loading" && (
                <div style={{ padding: tokens.spacingHorizontalM, display: "flex", gap: tokens.spacingHorizontalS, alignItems: "center" }}>
                  <Spinner size="tiny" />
                  <Text size={200}>Loading…</Text>
                </div>
              )}
              {filesError && (
                <Text size={200} style={{ padding: tokens.spacingHorizontalM, color: tokens.colorPaletteRedForeground1 }}>
                  {filesError}
                </Text>
              )}
              <div className={styles.fileList}>
                {files.map((file: ConfigFileSummary) => (
                  <div
                    key={file.name}
                    className={`${styles.fileItem} ${selectedFile === file.name ? styles.fileItemSelected : ""}`}
                    onClick={() => handleSelectFile(file.name)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleSelectFile(file.name); }}
                    aria-selected={selectedFile === file.name}
                    aria-label={file.name}
                  >
                    <Text size={200}>{file.name}</Text>
                    <ChevronRight24Regular style={{ width: "14px", height: "14px", opacity: 0.5 }} />
                  </div>
                ))}
                {files.length === 0 && filesState === "idle" && (
                  <Text size={200} style={{ padding: tokens.spacingHorizontalM, color: tokens.colorNeutralForeground3 }}>
                    No files found
                  </Text>
                )}
              </div>
              {onRestartService && (
                <>
                  <Divider />
                  <div style={{ padding: tokens.spacingHorizontalS }}>
                    <Button
                      appearance="subtle"
                      icon={<ArrowReset24Regular />}
                      size="small"
                      onClick={() => setRestartDialogOpen(true)}
                      style={{ width: "100%" }}
                    >
                      Restart service
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* Editor Pane */}
            <div className={styles.editorPane}>
              {selectedFile && (
                <div className={styles.editorToolbar}>
                  <div style={{ display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS }}>
                    <Text weight="semibold" size={300}>{selectedFile}</Text>
                    {isDirty && (
                      <Text size={100} style={{ color: tokens.colorPaletteYellowForeground1 }}>
                        (modified)
                      </Text>
                    )}
                  </div>
                  <div className={styles.editorToolbarRight}>
                    <TabList
                      size="small"
                      selectedValue={editorTab}
                      onTabSelect={(_, data) => setEditorTab(data.value as EditorTab)}
                    >
                      <Tab value="raw">Raw JSON</Tab>
                      <Tab value="friendly">Friendly</Tab>
                    </TabList>
                    <Button
                      appearance="subtle"
                      icon={<History24Regular />}
                      size="small"
                      onClick={() => { void handleShowHistory(); }}
                    >
                      History
                    </Button>
                  </div>
                </div>
              )}

              <div className={styles.editorContent}>
                {renderEditorContent()}
              </div>

              {selectedFile && (
                <div className={styles.editorBottomBar}>
                  <div>
                    {saveNotice && (
                      <Text size={200} style={{ color: tokens.colorPaletteGreenForeground1 }}>
                        {saveNotice}
                      </Text>
                    )}
                    {writeError && (
                      <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                        {writeError}
                      </Text>
                    )}
                  </div>
                  <div className={styles.editorBottomBarRight}>
                    <Button
                      appearance="secondary"
                      icon={<CheckmarkCircle24Regular />}
                      size="small"
                      onClick={handleCheck}
                      disabled={!draftContent}
                    >
                      Check
                    </Button>
                    <Button
                      appearance="primary"
                      icon={writeState === "loading" ? <Spinner size="tiny" /> : <Save24Regular />}
                      size="small"
                      onClick={() => { void handleSave(); }}
                      disabled={!draftContent || writeState === "loading"}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DrawerBody>
      </OverlayDrawer>

      {/* Check / Validation dialog */}
      <Dialog open={checkDialogOpen} onOpenChange={(_, data) => { if (!data.open) setCheckDialogOpen(false); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Validation Results — {selectedFile}</DialogTitle>
            <DialogContent>
              {validationIssues.length === 0 ? (
                <MessageBar intent="success">
                  <MessageBarBody>Config file is valid — no issues found.</MessageBarBody>
                </MessageBar>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS }}>
                  <Text>Found {validationIssues.length} issue{validationIssues.length !== 1 ? "s" : ""}:</Text>
                  {validationIssues.map((issue, i) => (
                    <MessageBar key={i} intent={issue.severity === "error" ? "error" : "warning"}>
                      <MessageBarBody>
                        <strong>{issue.path}</strong>: {issue.message}
                      </MessageBarBody>
                    </MessageBar>
                  ))}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setCheckDialogOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* History dialog */}
      <Dialog
        open={historyDialogOpen}
        onOpenChange={(_, data) => {
          if (!data.open) {
            setHistoryDialogOpen(false);
            clearSelectedVersion();
          }
        }}
      >
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
                      onClick={() => { void handleLoadVersion(v.id); }}
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
                <Button appearance="secondary" onClick={handleRestoreVersion}>
                  Restore this version
                </Button>
              )}
              <Button
                appearance="primary"
                onClick={() => {
                  setHistoryDialogOpen(false);
                  clearSelectedVersion();
                }}
              >
                Close
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Restart service dialog */}
      <Dialog
        open={restartDialogOpen}
        onOpenChange={(_, data) => {
          if (!data.open) {
            setRestartDialogOpen(false);
            setRestartResult(null);
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Restart Core Service</DialogTitle>
            <DialogContent>
              <Text>
                This will restart the core gateway process. Active connections will be dropped and
                reconnected automatically. Are you sure?
              </Text>
              {restartResult && (
                <MessageBar
                  intent={restartResult.startsWith("Restart failed") ? "error" : "success"}
                  style={{ marginTop: tokens.spacingVerticalM }}
                >
                  <MessageBarBody>{restartResult}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => {
                  setRestartDialogOpen(false);
                  setRestartResult(null);
                }}
                disabled={isRestarting}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                icon={isRestarting ? <Spinner size="tiny" /> : <ArrowReset24Regular />}
                onClick={() => { void handleRestart(); }}
                disabled={isRestarting || Boolean(restartResult)}
              >
                {isRestarting ? "Restarting…" : "Restart"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
