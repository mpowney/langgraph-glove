import React, { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Text,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AUTH_TOKEN_STORAGE_KEY } from "../../../hooks/authSession";

const useStyles = makeStyles({
  dialogSurface: {
    width: "90vw",
    maxWidth: "90vw",
    maxHeight: "90vh",
  },
  previewContainer: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  previewImage: {
    maxWidth: "100%",
    maxHeight: "60dvh",
    objectFit: "contain",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  previewFrame: {
    width: "100%",
    minHeight: "360px",
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
  previewHint: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

const CONVERSATION_ID_STORAGE_KEY = "glove_conversation_id";

interface ContentListItem {
  contentRef: string;
  fileName?: string;
  mimeType?: string;
  deletedAt?: string;
  previewUrl?: string;
}

interface ContentListResponse {
  items: ContentListItem[];
}

interface SandboxArtifactPreviewDialogProps {
  open: boolean;
  href: string;
  fileName: string;
  onClose: () => void;
}

export function SandboxArtifactPreviewDialog({
  open,
  href,
  fileName,
  onClose,
}: SandboxArtifactPreviewDialogProps) {
  const styles = useStyles();
  const [resolvedDownloadUrl, setResolvedDownloadUrl] = useState<string | null>(null);
  const [resolvedPreviewUrl, setResolvedPreviewUrl] = useState<string | null>(null);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewMimeType, setPreviewMimeType] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const authHeaders = useMemo<Record<string, string>>(() => {
    const token = sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
    if (!token) return {} as Record<string, string>;
    return { Authorization: `Bearer ${token}` };
  }, [open]);

  useEffect(() => {
    if (open) return;
    setResolvedPreviewUrl(null);
    setResolvedDownloadUrl(null);
    setResolveError(null);
    setIsResolving(false);
    setIsDownloading(false);
    setPreviewText(null);
    setPreviewMimeType(null);
    setPreviewObjectUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [open]);

  useEffect(() => {
    return () => {
      if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
      }
    };
  }, [previewObjectUrl]);

  useEffect(() => {
    if (!open) return;

    const conversationId = localStorage.getItem(CONVERSATION_ID_STORAGE_KEY)?.trim() ?? "";
    const normalizedFileName = fileName.trim().toLowerCase();
    if (!normalizedFileName) {
      setResolvedPreviewUrl(null);
      setResolveError("Unable to resolve preview: missing file name.");
      return;
    }

    let active = true;

    const fetchList = async (conversationScoped: boolean): Promise<ContentListItem[]> => {
      const params = new URLSearchParams();
      params.set("limit", "200");
      if (conversationScoped && conversationId) {
        params.set("conversationId", conversationId);
      }
      const response = await fetch(`/api/content?${params.toString()}`, {
        headers: authHeaders,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as ContentListResponse;
      return data.items ?? [];
    };

    const resolvePreview = async () => {
      setIsResolving(true);
      setResolveError(null);
      setResolvedPreviewUrl(null);
      setResolvedDownloadUrl(null);
      setPreviewText(null);
      setPreviewMimeType(null);
      setPreviewObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });

      try {
        const scopedItems = await fetchList(true);
        let match = scopedItems.find(
          (item) => !item.deletedAt && item.fileName?.trim().toLowerCase() === normalizedFileName,
        );

        if (!match) {
          const globalItems = await fetchList(false);
          match = globalItems.find(
            (item) => !item.deletedAt && item.fileName?.trim().toLowerCase() === normalizedFileName,
          );
        }

        if (!active) return;

        if (!match) {
          setResolveError(`No content record found for file \"${fileName}\".`);
          return;
        }

        const previewUrl = match.previewUrl || `/api/content/${encodeURIComponent(match.contentRef)}/preview`;
        const downloadUrl = `/api/content/${encodeURIComponent(match.contentRef)}/download`;
        const previewResponse = await fetch(previewUrl, {
          headers: authHeaders,
        });
        if (!previewResponse.ok) {
          let detail = `HTTP ${previewResponse.status}`;
          try {
            const payload = (await previewResponse.json()) as { error?: string };
            if (payload.error) {
              detail = payload.error;
            }
          } catch {
            // Keep generic status when no JSON error payload is available.
          }
          throw new Error(detail);
        }

        const mimeType = (previewResponse.headers.get("content-type") || match.mimeType || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (active) {
          setPreviewMimeType(mimeType || null);
        }

        if (
          mimeType.startsWith("text/")
          || mimeType === "application/json"
          || mimeType.endsWith("+json")
        ) {
          const bodyText = await previewResponse.text();
          if (!active) return;
          setResolvedPreviewUrl(previewUrl);
          setPreviewText(bodyText);
          return;
        }

        const previewBlob = await previewResponse.blob();

        if (!active) return;

        const objectUrl = URL.createObjectURL(previewBlob);
        setResolvedPreviewUrl(previewUrl);
        setResolvedDownloadUrl(downloadUrl);
        setPreviewObjectUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return objectUrl;
        });
      } catch (err) {
        if (!active) return;
        setResolveError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) {
          setIsResolving(false);
        }
      }
    };

    void resolvePreview();

    return () => {
      active = false;
    };
  }, [open, fileName, authHeaders]);

  const handleDownload = async () => {
    if (!resolvedDownloadUrl || isDownloading) return;
    setIsDownloading(true);
    try {
      const response = await fetch(resolvedDownloadUrl, { headers: authHeaders });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) {
            detail = payload.error;
          }
        } catch {
          // Keep generic status when no JSON error payload is available.
        }
        throw new Error(detail);
      }

      const blob = await response.blob();
      const tempUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = tempUrl;
      a.download = fileName;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(tempUrl);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) {
          onClose();
        }
      }}
    >
      <DialogSurface className={styles.dialogSurface}>
        <DialogBody>
          <DialogTitle>{fileName}</DialogTitle>
          <DialogContent>
            <div className={styles.previewContainer}>
              {isResolving ? (
                <Spinner label="Loading preview..." />
              ) : resolveError ? (
                <Text className={styles.errorText}>
                  {resolveError || "Preview could not be resolved."}
                </Text>
              ) : previewText !== null ? (
                <pre className={styles.previewText}>{previewText || "(empty)"}</pre>
              ) : previewObjectUrl && previewMimeType?.startsWith("image/") ? (
                <img src={previewObjectUrl} alt={fileName} className={styles.previewImage} />
              ) : previewObjectUrl ? (
                <iframe
                  src={previewObjectUrl}
                  className={styles.previewFrame}
                  title={`Preview ${fileName}`}
                />
              ) : (
                <Text className={styles.previewHint}>
                  Preview is not available for this file.
                </Text>
              )}
              <Text className={styles.previewHint}>{href}</Text>
              {resolvedPreviewUrl && (
                <Text className={styles.previewHint}>Resolved preview: {resolvedPreviewUrl}</Text>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="secondary"
              onClick={() => { void handleDownload(); }}
              disabled={Boolean(resolveError) || isResolving || !resolvedDownloadUrl || isDownloading}
            >
              {isDownloading ? "Downloading..." : "Download"}
            </Button>
            <Button appearance="primary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
