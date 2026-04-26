import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Divider,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwise24Regular, Dismiss24Regular, Open24Regular } from "@fluentui/react-icons";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  getImapAttachment,
  listImapAttachments,
  type ImapAttachmentDetailResult,
  type ImapAttachmentListItem,
} from "./imapRpcClient.js";

const PAGE_SIZE = 50;

const useStyles = makeStyles({
  drawer: {
    width: "100vw",
    maxWidth: "100vw",
  },
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(320px, 36%) minmax(0, 1fr)",
    gap: tokens.spacingHorizontalL,
    height: "100%",
    minHeight: 0,
    paddingBottom: tokens.spacingVerticalM,
    "@media (max-width: 900px)": {
      gridTemplateColumns: "1fr",
      gap: tokens.spacingVerticalM,
    },
  },
  pane: {
    minHeight: 0,
    overflow: "auto",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
  },
  detailHeaderRight: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    marginLeft: "auto",
  },
  pillRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
  },
  pill: {
    width: "fit-content",
    maxWidth: "100%",
    whiteSpace: "nowrap",
  },
  openEmailPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    minHeight: "24px",
    padding: `0 ${tokens.spacingHorizontalS}`,
    borderRadius: "2px",
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke2}`,
    color: tokens.colorBrandForeground2,
    textDecoration: "none",
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase200,
    whiteSpace: "nowrap",
    boxSizing: "border-box",
    ":hover": {
      backgroundColor: tokens.colorBrandBackground2Hover,
      textDecoration: "underline",
    },
  },
  openEmailIcon: {
    width: "14px",
    height: "14px",
    fontSize: "14px",
    lineHeight: "14px",
    flexShrink: 0,
    transform: "scale(0.9)",
    transformOrigin: "center",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  attachmentButton: {
    justifyContent: "flex-start",
    textAlign: "left",
    width: "100%",
    minHeight: "unset",
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  attachmentMeta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  selectedHint: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  detailTitle: {
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: "anywhere",
  },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    gap: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
  },
  key: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  value: {
    fontSize: tokens.fontSizeBase200,
    overflowWrap: "anywhere",
  },
  textContainer: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    minHeight: "180px",
    maxHeight: "52vh",
    overflow: "auto",
  },
  pre: {
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
  },
  pagination: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

interface ImapAttachmentBrowserDrawerProps {
  open: boolean;
  onClose: () => void;
  apiBaseUrl?: string;
  authToken?: string;
  privilegedGrantId: string;
  conversationId: string;
  toolKey: string;
  toolLabel: string;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIdx]}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString();
}

function isMarkdownContent(detail: ImapAttachmentDetailResult | null): boolean {
  if (!detail) return false;
  if (detail.markdownText?.trim()) return true;
  const filename = detail.fileName.toLowerCase();
  if (filename.endsWith(".md") || filename.endsWith(".markdown")) return true;
  if (detail.mimeType.toLowerCase().includes("markdown")) return true;

  const text = detail.text;
  if (!text) return false;
  return /(^|\n)#{1,6}\s+.+|(^|\n)\*\s+.+|(^|\n)-\s+.+|\[[^\]]+\]\([^\)]+\)/m.test(text);
}

export function ImapAttachmentBrowserDrawer({
  open,
  onClose,
  apiBaseUrl = "",
  authToken,
  privilegedGrantId,
  conversationId,
  toolKey,
  toolLabel,
}: ImapAttachmentBrowserDrawerProps) {
  const styles = useStyles();
  const [offset, setOffset] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [items, setItems] = useState<ImapAttachmentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ImapAttachmentDetailResult | null>(null);

  const canQuery = privilegedGrantId.trim().length > 0 && conversationId.trim().length > 0;

  const loadList = useCallback(async (nextOffset: number) => {
    if (!canQuery) return;
    setLoadingList(true);
    setListError(null);
    try {
      const result = await listImapAttachments(apiBaseUrl, authToken, privilegedGrantId, conversationId, {
        toolKey,
        limit: PAGE_SIZE,
        offset: nextOffset,
      });
      setItems(result.items ?? []);
      setTotal(typeof result.total === "number" ? result.total : 0);
      if (result.items.length > 0) {
        const currentSelected = result.items.find((item) => item.attachmentId === selectedAttachmentId);
        const firstId = currentSelected?.attachmentId ?? result.items[0]?.attachmentId ?? null;
        setSelectedAttachmentId(firstId);
      } else {
        setSelectedAttachmentId(null);
        setDetail(null);
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setItems([]);
      setTotal(0);
      setSelectedAttachmentId(null);
      setDetail(null);
    } finally {
      setLoadingList(false);
    }
  }, [apiBaseUrl, authToken, canQuery, conversationId, privilegedGrantId, selectedAttachmentId, toolKey]);

  const loadDetail = useCallback(async (attachmentId: string) => {
    if (!canQuery || !attachmentId) return;
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const result = await getImapAttachment(apiBaseUrl, authToken, privilegedGrantId, conversationId, {
        toolKey,
        attachmentId,
      });
      setDetail(result);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [apiBaseUrl, authToken, canQuery, conversationId, privilegedGrantId, toolKey]);

  useEffect(() => {
    if (!open) return;
    setOffset(0);
  }, [open, toolKey]);

  useEffect(() => {
    if (!open) return;
    void loadList(offset);
  }, [open, offset, loadList]);

  useEffect(() => {
    if (!open || !selectedAttachmentId) return;
    void loadDetail(selectedAttachmentId);
  }, [open, selectedAttachmentId, loadDetail]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  const selectedSummary = useMemo(
    () => items.find((item) => item.attachmentId === selectedAttachmentId),
    [items, selectedAttachmentId],
  );

  const preferredMarkdownText = detail?.markdownText?.trim() ?? "";
  const plainText = detail?.text?.trim() ?? "";
  const renderedContent = preferredMarkdownText || plainText;
  const markdown = preferredMarkdownText.length > 0 || isMarkdownContent(detail);
  const openEmailUrl = detail?.email?.itemUrl ?? selectedSummary?.email?.itemUrl;

  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
      position="end"
      size="full"
      className={styles.drawer}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss24Regular />}
              onClick={onClose}
              aria-label="Close IMAP attachment browser"
            />
          }
        >
          IMAP Attachment Browser: {toolLabel}
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody className={styles.body}>
        <div className={styles.pane}>
          <div className={styles.toolbar}>
            <Text weight="semibold">Indexed attachments</Text>
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowClockwise24Regular />}
              onClick={() => void loadList(offset)}
              disabled={!canQuery || loadingList}
            >
              Refresh
            </Button>
          </div>

          {!canQuery && <Text className={styles.selectedHint}>Enable privileged access to browse indexed attachments.</Text>}
          {listError && <Text className={styles.error}>{listError}</Text>}
          {loadingList && <Spinner size="tiny" label="Loading attachments..." />}

          <div className={styles.list}>
            {items.map((item) => (
              <Button
                key={item.attachmentId}
                appearance={item.attachmentId === selectedAttachmentId ? "primary" : "secondary"}
                className={styles.attachmentButton}
                onClick={() => setSelectedAttachmentId(item.attachmentId)}
              >
                <div>
                  <Text className={styles.attachmentMeta}>
                    {item.fileName} • {item.mimeType} • {formatBytes(item.fileSizeBytes)} • {item.email?.subject ?? "(no subject)"}
                  </Text>
                </div>
              </Button>
            ))}
          </div>

          {!loadingList && items.length === 0 && (
            <Text className={styles.selectedHint}>No indexed attachments found for this IMAP instance.</Text>
          )}

          <div className={styles.pagination}>
            <Text className={styles.attachmentMeta}>
              Showing {from}-{to} of {total}
            </Text>
            <div>
              <Button
                appearance="secondary"
                size="small"
                onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                disabled={offset <= 0 || loadingList}
              >
                Previous
              </Button>
              <Button
                appearance="secondary"
                size="small"
                onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
                disabled={loadingList || offset + PAGE_SIZE >= total}
              >
                Next
              </Button>
            </div>
          </div>
        </div>

        <div className={styles.pane}>
          <div className={styles.toolbar}>
            <Text weight="semibold">Attachment details</Text>
            <div className={styles.detailHeaderRight}>
              <div className={styles.pillRow}>
                {detail && (
                  <Badge
                    appearance="filled"
                    color={
                      detail.extractionStatus === "indexed"
                        ? "success"
                        : detail.extractionStatus === "failed"
                          ? "danger"
                          : "warning"
                    }
                    className={styles.pill}
                  >
                    {detail.extractionStatus}
                  </Badge>
                )}
              </div>
              {openEmailUrl && (
                <a
                  href={openEmailUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${styles.pill} ${styles.openEmailPill}`}
                >
                  Open email <Open24Regular className={styles.openEmailIcon} />
                </a>
              )}
            </div>
          </div>

          {!selectedAttachmentId && (
            <Text className={styles.selectedHint}>Select an attachment to inspect OCR/text and associated email metadata.</Text>
          )}

          {detailError && <Text className={styles.error}>{detailError}</Text>}
          {loadingDetail && <Spinner size="tiny" label="Loading attachment detail..." />}

          {detail && !loadingDetail && (
            <>
              <Text className={styles.detailTitle}>{detail.fileName}</Text>
              {detail.extractionError && <Text className={styles.error}>{detail.extractionError}</Text>}

              <div className={styles.detailGrid}>
                <Text className={styles.key}>MIME</Text>
                <Text className={styles.value}>{detail.mimeType}</Text>
                <Text className={styles.key}>Size</Text>
                <Text className={styles.value}>{formatBytes(detail.fileSizeBytes)}</Text>
                <Text className={styles.key}>Email subject</Text>
                <Text className={styles.value}>{detail.email?.subject ?? "-"}</Text>
                <Text className={styles.key}>From</Text>
                <Text className={styles.value}>{detail.email?.from ?? "-"}</Text>
                <Text className={styles.key}>Sent</Text>
                <Text className={styles.value}>{formatDate(detail.email?.sentAt)}</Text>
                <Text className={styles.key}>Folder / UID</Text>
                <Text className={styles.value}>{detail.email?.folder ?? "-"} / {detail.email?.uid ?? "-"}</Text>
                <Text className={styles.key}>Message-ID</Text>
                <Text className={styles.value}>{detail.email?.messageId ?? "-"}</Text>
              </div>

              <Divider />

              <Text weight="semibold">Extracted text</Text>
              <div className={styles.textContainer}>
                {renderedContent.length === 0 && (
                  <Text className={styles.selectedHint}>No extracted text is available for this attachment yet.</Text>
                )}
                {renderedContent.length > 0 && markdown && (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                    {renderedContent}
                  </ReactMarkdown>
                )}
                {renderedContent.length > 0 && !markdown && (
                  <pre className={styles.pre}>{renderedContent}</pre>
                )}
              </div>
            </>
          )}
        </div>
      </DrawerBody>
    </OverlayDrawer>
  );
}
