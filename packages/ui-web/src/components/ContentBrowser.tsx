import React, { useEffect, useMemo, useState } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Spinner,
  Divider,
  Badge,
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  Input,
  MessageBar,
  Dialog,
  DialogSurface,
  DialogBody as FluentDialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@fluentui/react-components";
import { Dismiss24Regular, ArrowLeft24Regular, ArrowClockwise24Regular } from "@fluentui/react-icons";
import { useContentBrowser } from "../hooks/useContentBrowser";

const useStyles = makeStyles({
  headerActions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalM} 0`,
    overflowY: "auto",
  },
  toolbar: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: `0 ${tokens.spacingHorizontalM}`,
  },
  openByRefRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  listItem: {
    display: "flex",
    flexDirection: "column",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  listHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
  },
  listActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  listPrimary: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    wordBreak: "break-word",
  },
  listSecondary: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    wordBreak: "break-all",
  },
  listMeta: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXXS,
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  empty: {
    padding: tokens.spacingVerticalL,
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
  detailWrap: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: `0 ${tokens.spacingHorizontalM}`,
  },
  detailRef: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    wordBreak: "break-all",
  },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(120px, 160px) 1fr",
    rowGap: tokens.spacingVerticalXS,
    columnGap: tokens.spacingHorizontalM,
  },
  detailLabel: {
    color: tokens.colorNeutralForeground3,
  },
  detailValue: {
    color: tokens.colorNeutralForeground1,
    wordBreak: "break-word",
    fontFamily: tokens.fontFamilyMonospace,
  },
  actionRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  previewPanel: {
    marginTop: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  previewFrame: {
    width: "100%",
    minHeight: "360px",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  previewImage: {
    maxWidth: "100%",
    maxHeight: "60dvh",
    objectFit: "contain",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  previewText: {
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingVerticalS,
    maxHeight: "60dvh",
    overflowY: "auto",
  },
});

function formatBytes(bytes?: number): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

export interface ContentBrowserProps {
  open: boolean;
  onClose: () => void;
  apiBaseUrl?: string;
  authToken?: string;
  initialContentRef?: string | null;
  onSelectContentRef?: (contentRef: string | null) => void;
}

export function ContentBrowser({
  open,
  onClose,
  apiBaseUrl = "",
  authToken,
  initialContentRef,
  onSelectContentRef,
}: ContentBrowserProps) {
  const styles = useStyles();
  const {
    items,
    selectedContentRef,
    selectedItem,
    listState,
    detailsState,
    listError,
    detailsError,
    loadList,
    loadContent,
    deleteContent,
    clearSelection,
  } = useContentBrowser(apiBaseUrl);
  const [refInput, setRefInput] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pendingDeleteRef, setPendingDeleteRef] = useState<string | null>(null);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewMimeType, setPreviewMimeType] = useState<string | null>(null);

  const activeRef = selectedItem?.contentRef ?? selectedContentRef ?? null;

  const previewHref = useMemo(() => {
    if (!activeRef) return "";
    return selectedItem?.previewUrl || `${apiBaseUrl}/api/content/${encodeURIComponent(activeRef)}/preview`;
  }, [activeRef, selectedItem?.previewUrl, apiBaseUrl]);

  const downloadHref = useMemo(() => {
    if (!activeRef) return "";
    return selectedItem?.downloadUrl || `${apiBaseUrl}/api/content/${encodeURIComponent(activeRef)}/download`;
  }, [activeRef, selectedItem?.downloadUrl, apiBaseUrl]);

  const directLink = useMemo(() => {
    if (!activeRef) return "";
    const encodedRef = encodeURIComponent(activeRef);
    return `${window.location.origin}${window.location.pathname}${window.location.search}#/content/${encodedRef}`;
  }, [activeRef]);

  const authHeaders = useMemo(() => {
    if (!authToken) return {} as Record<string, string>;
    return { Authorization: `Bearer ${authToken}` };
  }, [authToken]);

  const clearPreview = () => {
    setPreviewLoading(false);
    setPreviewError(null);
    setPreviewText(null);
    setPreviewMimeType(null);
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
    }
    setPreviewObjectUrl(null);
  };

  const clearActionMessages = () => {
    setActionError(null);
    setActionSuccess(null);
  };

  const openDeleteDialog = (contentRef: string) => {
    if (deleting) return;
    clearActionMessages();
    setPendingDeleteRef(contentRef);
    setDeleteDialogOpen(true);
  };

  const closeDeleteDialog = () => {
    if (deleting) return;
    setDeleteDialogOpen(false);
    setPendingDeleteRef(null);
  };

  const confirmDelete = async () => {
    if (!pendingDeleteRef || deleting) return;

    setDeleting(true);
    clearActionMessages();

    try {
      await deleteContent(pendingDeleteRef, authToken);
      clearPreview();
      await Promise.all([
        loadList({ authToken }),
        ...(selectedContentRef === pendingDeleteRef || selectedItem?.contentRef === pendingDeleteRef
          ? [loadContent(pendingDeleteRef, authToken)]
          : []),
      ]);
      setActionSuccess("Content deleted.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
      setPendingDeleteRef(null);
    }
  };

  const loadPreviewInline = async () => {
    if (!activeRef) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewText(null);
    setPreviewMimeType(null);
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      setPreviewObjectUrl(null);
    }

    try {
      const response = await fetch(previewHref, { headers: authHeaders });
      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) errorMessage = payload.error;
        } catch {
          // Ignore JSON parsing errors for non-JSON responses.
        }
        throw new Error(errorMessage);
      }

      const mimeType = (response.headers.get("content-type") || selectedItem?.mimeType || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      setPreviewMimeType(mimeType || null);

      if (
        mimeType.startsWith("text/")
        || mimeType === "application/json"
        || mimeType.endsWith("+json")
      ) {
        const bodyText = await response.text();
        setPreviewText(bodyText);
      } else {
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        setPreviewObjectUrl(objectUrl);
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    clearActionMessages();
    void loadList({ authToken });
    if (initialContentRef?.trim()) {
      void loadContent(initialContentRef, authToken);
    } else {
      clearSelection();
    }
  }, [open, authToken, initialContentRef, loadList, loadContent, clearSelection]);

  useEffect(() => {
    if (!open) return;
    if (!initialContentRef?.trim()) return;
    if (initialContentRef === selectedContentRef) return;
    void loadContent(initialContentRef, authToken);
  }, [open, initialContentRef, selectedContentRef, authToken, loadContent]);

  useEffect(() => {
    return () => {
      if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
      }
    };
  }, [previewObjectUrl]);

  const inDetailView = Boolean(activeRef);

  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, { open: nextOpen }) => {
        if (!nextOpen) onClose();
      }}
      position="end"
      size="large"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <div className={styles.headerActions}>
              {inDetailView && (
                <Button
                  appearance="subtle"
                  icon={<ArrowLeft24Regular />}
                  onClick={() => {
                    clearSelection();
                    clearPreview();
                    onSelectContentRef?.(null);
                  }}
                  aria-label="Back to content list"
                />
              )}
              <Button
                appearance="subtle"
                icon={<ArrowClockwise24Regular />}
                onClick={inDetailView && activeRef
                  ? () => void loadContent(activeRef, authToken)
                  : () => void loadList({ authToken })}
                aria-label="Refresh"
              />
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                onClick={onClose}
                aria-label="Close"
              />
            </div>
          }
        >
          {inDetailView ? "Content item" : "Content browser"}
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div className={styles.body}>
          {!inDetailView ? (
            <>
              <div className={styles.toolbar}>
                <Text size={200}>Browse uploaded content stored in SQLite.</Text>
                <div className={styles.openByRefRow}>
                  <Input
                    value={refInput}
                    onChange={(_, data) => setRefInput(data.value)}
                    placeholder="Open content by reference"
                  />
                  <Button
                    appearance="secondary"
                    onClick={() => {
                      const nextRef = refInput.trim();
                      if (!nextRef) return;
                      clearPreview();
                      void loadContent(nextRef, authToken);
                      onSelectContentRef?.(nextRef);
                    }}
                  >
                    Open
                  </Button>
                </div>
              </div>

              <Divider />

              {listState === "loading" && <Spinner label="Loading content…" />}
              {listState === "error" && <Text className={styles.errorText}>{listError}</Text>}
              {listState === "idle" && items.length === 0 && (
                <Text className={styles.empty}>No content items found.</Text>
              )}

              {items.map((item, index) => (
                <React.Fragment key={item.contentRef}>
                  {index > 0 && <Divider />}
                  <div
                    className={styles.listItem}
                    onClick={() => {
                      clearActionMessages();
                      clearPreview();
                      void loadContent(item.contentRef, authToken);
                      onSelectContentRef?.(item.contentRef);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      clearActionMessages();
                      clearPreview();
                      void loadContent(item.contentRef, authToken);
                      onSelectContentRef?.(item.contentRef);
                    }}
                  >
                    <div className={styles.listHeader}>
                      <Text className={styles.listPrimary}>{item.fileName || item.contentRef}</Text>
                      <div className={styles.listActions}>
                        <Button
                          size="small"
                          appearance="subtle"
                          disabled={Boolean(item.deletedAt) || deleting}
                          onClick={(e) => {
                            e.stopPropagation();
                            openDeleteDialog(item.contentRef);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                    <Text className={styles.listSecondary}>{item.contentRef}</Text>
                    <div className={styles.listMeta}>
                      <Badge appearance="tint" color="informative" size="small">
                        {formatBytes(item.byteLength)}
                      </Badge>
                      <Badge appearance="outline" color="subtle" size="small">
                        {item.mimeType || "application/octet-stream"}
                      </Badge>
                      {item.deletedAt ? (
                        <Badge appearance="filled" color="danger" size="small">
                          deleted
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </React.Fragment>
              ))}
            </>
          ) : (
            <>
              {detailsState === "loading" && <Spinner label="Loading content details…" />}
              {detailsState === "error" && <Text className={styles.errorText}>{detailsError}</Text>}
              {detailsState === "idle" && selectedItem && (
                <div className={styles.detailWrap}>
                  {actionSuccess && (
                    <MessageBar intent="success">
                      {actionSuccess}
                    </MessageBar>
                  )}
                  {actionError && (
                    <MessageBar intent="error">
                      {actionError}
                    </MessageBar>
                  )}
                  <Text className={styles.detailRef}>{selectedItem.contentRef}</Text>
                  <div className={styles.detailGrid}>
                    <Text className={styles.detailLabel}>File name</Text>
                    <Text className={styles.detailValue}>{selectedItem.fileName || "(none)"}</Text>

                    <Text className={styles.detailLabel}>Conversation</Text>
                    <Text className={styles.detailValue}>{selectedItem.conversationId}</Text>

                    <Text className={styles.detailLabel}>Tool</Text>
                    <Text className={styles.detailValue}>{selectedItem.toolName}</Text>

                    <Text className={styles.detailLabel}>MIME type</Text>
                    <Text className={styles.detailValue}>{selectedItem.mimeType || "application/octet-stream"}</Text>

                    <Text className={styles.detailLabel}>Size</Text>
                    <Text className={styles.detailValue}>{formatBytes(selectedItem.byteLength)}</Text>

                    <Text className={styles.detailLabel}>Created</Text>
                    <Text className={styles.detailValue}>{selectedItem.createdAt}</Text>

                    <Text className={styles.detailLabel}>Deleted</Text>
                    <Text className={styles.detailValue}>{selectedItem.deletedAt || "No"}</Text>
                  </div>

                  <div className={styles.actionRow}>
                    <Button appearance="secondary" onClick={() => { void loadPreviewInline(); }}>
                      Preview
                    </Button>
                    <Button as="a" href={downloadHref} target="_blank" rel="noreferrer" appearance="primary">
                      Download
                    </Button>
                    <Button
                      appearance="secondary"
                      onClick={() => {
                        if (!directLink) return;
                        void navigator.clipboard?.writeText(directLink);
                      }}
                    >
                      Copy direct link
                    </Button>
                    <Button
                      appearance="secondary"
                      disabled={Boolean(selectedItem.deletedAt) || deleting}
                      onClick={() => {
                        if (!selectedItem) return;
                        openDeleteDialog(selectedItem.contentRef);
                      }}
                    >
                      {deleting ? "Deleting…" : "Delete"}
                    </Button>
                  </div>

                  {(previewLoading || previewError || previewText !== null || previewObjectUrl) && (
                    <div className={styles.previewPanel}>
                      <Text weight="semibold">Inline preview</Text>
                      {previewLoading && <Spinner label="Loading preview…" />}
                      {!previewLoading && previewError && (
                        <Text className={styles.errorText}>{previewError}</Text>
                      )}
                      {!previewLoading && !previewError && previewText !== null && (
                        <pre className={styles.previewText}>{previewText || "(empty)"}</pre>
                      )}
                      {!previewLoading && !previewError && previewObjectUrl && previewMimeType?.startsWith("image/") && (
                        <img
                          src={previewObjectUrl}
                          alt={selectedItem.fileName || selectedItem.contentRef}
                          className={styles.previewImage}
                        />
                      )}
                      {!previewLoading && !previewError && previewObjectUrl && !previewMimeType?.startsWith("image/") && (
                        <iframe
                          src={previewObjectUrl}
                          className={styles.previewFrame}
                          title={`Preview ${selectedItem.contentRef}`}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </DrawerBody>
      <Dialog open={deleteDialogOpen} onOpenChange={(_, data) => { if (!data.open) closeDeleteDialog(); }}>
        <DialogSurface>
          <FluentDialogBody>
            <DialogTitle>Delete content</DialogTitle>
            <DialogContent>
              Delete content <Text className={styles.detailRef}>{pendingDeleteRef ?? ""}</Text>? This marks it as deleted and hides downloads and previews.
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={closeDeleteDialog} disabled={deleting}>
                Cancel
              </Button>
              <Button appearance="primary" onClick={() => { void confirmDelete(); }} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            </DialogActions>
          </FluentDialogBody>
        </DialogSurface>
      </Dialog>
    </OverlayDrawer>
  );
}
