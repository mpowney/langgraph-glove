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
    maxHeight: "65vh",
    objectFit: "contain",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
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
  isImageArtifact: boolean;
  onClose: () => void;
  onCopyLink: () => void;
}

export function SandboxArtifactPreviewDialog({
  open,
  href,
  fileName,
  isImageArtifact,
  onClose,
  onCopyLink,
}: SandboxArtifactPreviewDialogProps) {
  const styles = useStyles();
  const [resolvedPreviewUrl, setResolvedPreviewUrl] = useState<string | null>(null);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
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
    setResolveError(null);
    setIsResolving(false);
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
    if (!open || !isImageArtifact) return;

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
        const previewBlob = await previewResponse.blob();

        if (!active) return;

        const objectUrl = URL.createObjectURL(previewBlob);
        setResolvedPreviewUrl(previewUrl);
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
  }, [open, fileName, isImageArtifact, authHeaders]);

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
              {isImageArtifact ? (
                isResolving ? (
                  <Text className={styles.previewHint}>Resolving preview...</Text>
                ) : previewObjectUrl ? (
                  <img src={previewObjectUrl} alt={fileName} className={styles.previewImage} />
                ) : (
                  <Text className={styles.errorText}>
                    {resolveError || "Preview could not be resolved."}
                  </Text>
                )
              ) : (
                <Text className={styles.previewHint}>
                  Preview is not available for this file type in the inline dialog.
                </Text>
              )}
              <Text className={styles.previewHint}>{href}</Text>
              {resolvedPreviewUrl && (
                <Text className={styles.previewHint}>Resolved preview: {resolvedPreviewUrl}</Text>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCopyLink}>Copy link</Button>
            <Button appearance="primary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
