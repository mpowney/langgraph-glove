import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Divider,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  Spinner,
  Text,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwise24Regular } from "@fluentui/react-icons";
import {
  clearImapIndex,
  getImapCrawlStatus,
  getImapRemainingEstimate,
  listImapInstances,
  stopImapCrawl,
  startImapCrawl,
  type ImapCrawlStatusResult,
  type ImapListToolsResult,
  type ImapRemainingEstimateOptions,
  type ImapRemainingEstimateResult,
} from "../../hooks/imapRpcClient";

const useStyles = makeStyles({
  section: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  sectionLabel: {
    color: tokens.colorNeutralForeground3,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    paddingBottom: tokens.spacingVerticalXXS,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
  },
  summary: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
  },
  summaryKey: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  summaryValue: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
  },
  cardTitle: {
    fontFamily: tokens.fontFamilyMonospace,
    fontWeight: tokens.fontWeightSemibold,
  },
  cardGrid: {
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    gap: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
  },
  clearIndexButton: {
    width: "100%",
    justifyContent: "center",
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

interface ImapStatusSectionProps {
  open: boolean;
  apiBaseUrl?: string;
  authToken?: string;
  privilegedGrantId: string;
  conversationId: string;
}

function formatElapsed(elapsedMs?: number): string {
  if (!elapsedMs || elapsedMs <= 0) return "0s";
  const seconds = Math.round(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes <= 0) return `${remSeconds}s`;
  return `${minutes}m ${remSeconds}s`;
}

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat(undefined).format(value);
}

export function ImapStatusSection({
  open,
  apiBaseUrl = "",
  authToken,
  privilegedGrantId,
  conversationId,
}: ImapStatusSectionProps) {
  const styles = useStyles();
  const [statusLoading, setStatusLoading] = useState(false);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [clearingToolKey, setClearingToolKey] = useState<string | null>(null);
  const [stoppingToolKey, setStoppingToolKey] = useState<string | null>(null);
  const [startingToolKey, setStartingToolKey] = useState<string | null>(null);
  const [confirmClearToolKey, setConfirmClearToolKey] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [tools, setTools] = useState<ImapListToolsResult | null>(null);
  const [status, setStatus] = useState<ImapCrawlStatusResult | null>(null);
  const [estimate, setEstimate] = useState<ImapRemainingEstimateResult | null>(null);

  const privilegedReady = privilegedGrantId.trim().length > 0 && conversationId.trim().length > 0;

  const loadTools = useCallback(async () => {
    if (!privilegedReady) return;
    try {
      const toolsResult = await listImapInstances(apiBaseUrl, authToken, privilegedGrantId, conversationId);
      setTools(toolsResult);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }, [apiBaseUrl, authToken, privilegedGrantId, conversationId, privilegedReady]);

  const loadStatus = useCallback(async () => {
    if (!privilegedReady) return;
    setStatusLoading(true);
    setStatusError(null);
    try {
      const statusResult = await getImapCrawlStatus(apiBaseUrl, authToken, privilegedGrantId, conversationId);
      setStatus(statusResult);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusLoading(false);
    }
  }, [apiBaseUrl, authToken, privilegedGrantId, conversationId, privilegedReady]);

  const loadEstimate = useCallback(async (options: ImapRemainingEstimateOptions = {}) => {
    if (!privilegedReady) return;
    setEstimateLoading(true);
    setEstimateError(null);
    try {
      const estimateResult = await getImapRemainingEstimate(
        apiBaseUrl,
        authToken,
        privilegedGrantId,
        conversationId,
        options,
      );
      setEstimate(estimateResult);
    } catch (err) {
      setEstimateError(err instanceof Error ? err.message : String(err));
    } finally {
      setEstimateLoading(false);
    }
  }, [apiBaseUrl, authToken, privilegedGrantId, conversationId, privilegedReady]);

  const handleClearIndex = useCallback(async (toolKey: string) => {
    if (!privilegedReady) return;

    setClearingToolKey(toolKey);
    setStatusError(null);
    setEstimateError(null);
    try {
      // Stop any running crawl first (backend also sets abort flag, this is belt-and-suspenders)
      const toolStatus = status?.tools.find((t) => t.toolKey === toolKey);
      if (toolStatus?.status?.crawlRuntime?.active) {
        await stopImapCrawl(apiBaseUrl, authToken, privilegedGrantId, conversationId, toolKey);
        // Brief pause to let the abort propagate before clearing
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await clearImapIndex(apiBaseUrl, authToken, privilegedGrantId, conversationId, toolKey);
      await Promise.all([
        loadStatus(),
        loadEstimate({ forceRefreshEstimate: true }),
      ]);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearingToolKey(null);
    }
  }, [apiBaseUrl, authToken, privilegedGrantId, conversationId, privilegedReady, loadEstimate, loadStatus, status]);

  const handleStopCrawl = useCallback(async (toolKey: string) => {
    if (!privilegedReady) return;
    setStoppingToolKey(toolKey);
    try {
      await stopImapCrawl(apiBaseUrl, authToken, privilegedGrantId, conversationId, toolKey);
      // Poll until crawl is confirmed stopped (abort is async — crawl finishes its current message first)
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const updated = await getImapCrawlStatus(apiBaseUrl, authToken, privilegedGrantId, conversationId);
        setStatus(updated);
        const toolEntry = updated.tools.find((t) => t.toolKey === toolKey);
        if (!toolEntry?.status?.crawlRuntime?.active) break;
      }
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoppingToolKey(null);
    }
  }, [apiBaseUrl, authToken, privilegedGrantId, conversationId, privilegedReady]);

  const handleStartCrawl = useCallback(async (toolKey: string) => {
    if (!privilegedReady) return;
    setStartingToolKey(toolKey);
    try {
      await startImapCrawl(apiBaseUrl, authToken, privilegedGrantId, conversationId, toolKey);
      await loadStatus();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingToolKey(null);
    }
  }, [apiBaseUrl, authToken, privilegedGrantId, conversationId, privilegedReady, loadStatus]);

  useEffect(() => {
    if (!open || !privilegedReady) return;
    void loadTools();
    void loadStatus();
    void loadEstimate();

    const statusTimer = window.setInterval(() => {
      void loadStatus();
    }, 10000);
    const estimateTimer = window.setInterval(() => {
      void loadEstimate();
    }, 30000);

    return () => {
      window.clearInterval(statusTimer);
      window.clearInterval(estimateTimer);
    };
  }, [open, privilegedReady, loadEstimate, loadStatus, loadTools]);

  const statusesByKey = useMemo(() => {
    const map = new Map<string, NonNullable<ImapCrawlStatusResult["tools"][number]>>();
    for (const entry of status?.tools ?? []) {
      map.set(entry.toolKey, entry);
    }
    return map;
  }, [status]);

  const estimatesByKey = useMemo(() => {
    const map = new Map<string, NonNullable<ImapRemainingEstimateResult["tools"][number]>>();
    for (const entry of estimate?.tools ?? []) {
      map.set(entry.toolKey, entry);
    }
    return map;
  }, [estimate]);

  const formatEstimateValue = useCallback((toolKey: string) => {
    const entry = estimatesByKey.get(toolKey);
    const value = entry?.estimate?.remainingEmails;
    if (typeof value === "number" && Number.isFinite(value)) {
      return formatNumber(value);
    }
    if (estimateLoading && !estimate) {
      return "Calculating...";
    }
    if (entry?.error || entry?.estimate?.error || estimateError) {
      return "Unavailable";
    }
    if (estimateLoading) {
      return "Updating...";
    }
    return "-";
  }, [estimate, estimateError, estimateLoading, estimatesByKey]);

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <Text size={100} weight="semibold" className={styles.sectionLabel}>
          IMAP crawl status
        </Text>
        <Button
          size="small"
          appearance="subtle"
          icon={<ArrowClockwise24Regular />}
          onClick={() => {
            void loadStatus();
            void loadEstimate({ forceRefreshEstimate: true });
          }}
          disabled={!privilegedReady || statusLoading || estimateLoading}
        >
          Refresh
        </Button>
      </div>

      {!privilegedReady && (
        <Text className={styles.hint}>Enable privileged access to query IMAP indexing status.</Text>
      )}

      {privilegedReady && statusLoading && !status && (
        <Spinner size="tiny" label="Loading IMAP status..." />
      )}

      {statusError && <Text className={styles.error}>{statusError}</Text>}
      {!statusError && estimateError && <Text className={styles.error}>{estimateError}</Text>}

      {status && (
        <>
          <div className={styles.summary}>
            <Text className={styles.summaryKey}>Configured tools</Text>
            <Text className={styles.summaryValue}>{formatNumber(status.summary.totalTools)}</Text>
            <Text className={styles.summaryKey}>Active crawls</Text>
            <Text className={styles.summaryValue}>{formatNumber(status.summary.activeCrawls)}</Text>
            <Text className={styles.summaryKey}>Estimated emails remaining</Text>
            <Text className={styles.summaryValue}>
              {typeof estimate?.summary.estimatedRemainingEmails === "number"
                ? formatNumber(estimate.summary.estimatedRemainingEmails)
                : estimateLoading
                  ? "Calculating..."
                  : estimateError
                    ? "Unavailable"
                    : "-"}
            </Text>
            <Text className={styles.summaryKey}>Tools with status errors</Text>
            <Text className={styles.summaryValue}>{formatNumber(status.summary.failedTools)}</Text>
          </div>

          <Divider />

          {(tools?.tools ?? []).map((tool) => {
            const toolStatus = statusesByKey.get(tool.toolKey);
            const runtime = toolStatus?.status?.crawlRuntime;
            const totals = toolStatus?.status?.totals;
            const isClearingThisTool = clearingToolKey === tool.toolKey;
            const isStoppingThisTool = stoppingToolKey === tool.toolKey;
            const isStartingThisTool = startingToolKey === tool.toolKey;
            const isCrawlActive = runtime?.active === true;

            return (
              <div key={tool.toolKey} className={styles.card}>
                <div className={styles.cardHeader}>
                  <Text className={styles.cardTitle}>{tool.displayName?.trim() ? tool.displayName : tool.toolKey}</Text>
                  <Badge appearance="filled" color={runtime?.active ? "success" : "informative"}>
                    {runtime?.active ? "crawling" : "idle"}
                  </Badge>
                </div>

                {toolStatus?.error && <Text className={styles.error}>{toolStatus.error}</Text>}

                <div className={styles.cardGrid}>
                  <Text className={styles.summaryKey}>Instance key</Text>
                  <Text className={styles.summaryValue}>{tool.toolKey}</Text>
                  <Text className={styles.summaryKey}>Mode</Text>
                  <Text className={styles.summaryValue}>{tool.crawlMode}</Text>
                  <Text className={styles.summaryKey}>Indexing</Text>
                  <Text className={styles.summaryValue}>{tool.indexingStrategy}</Text>
                  <Text className={styles.summaryKey}>Emails indexed</Text>
                  <Text className={styles.summaryValue}>{formatNumber(totals?.emails)}</Text>
                  <Text className={styles.summaryKey}>Chunks indexed</Text>
                  <Text className={styles.summaryValue}>{formatNumber(totals?.chunks)}</Text>
                  <Text className={styles.summaryKey}>Files queued to index</Text>
                  <Text className={styles.summaryValue}>{formatNumber(totals?.queuedFiles)}</Text>
                  <Text className={styles.summaryKey}>Files indexed</Text>
                  <Text className={styles.summaryValue}>{formatNumber(totals?.indexedFiles)}</Text>
                  <Text className={styles.summaryKey}>Remaining emails (est.)</Text>
                  <Text className={styles.summaryValue}>{formatEstimateValue(tool.toolKey)}</Text>
                  <Text className={styles.summaryKey}>Folder progress</Text>
                  <Text className={styles.summaryValue}>
                    {formatNumber(runtime?.completedFolders)}/{formatNumber(runtime?.totalFolders)}
                  </Text>
                  <Text className={styles.summaryKey}>Elapsed</Text>
                  <Text className={styles.summaryValue}>{formatElapsed(runtime?.elapsedMs)}</Text>
                </div>

                <Button
                  appearance="secondary"
                  className={styles.clearIndexButton}
                  onClick={() => {
                    if (isCrawlActive) {
                      void handleStopCrawl(tool.toolKey);
                    } else {
                      void handleStartCrawl(tool.toolKey);
                    }
                  }}
                  disabled={!privilegedReady || statusLoading || Boolean(clearingToolKey) || isStoppingThisTool || isStartingThisTool}
                >
                  {isStoppingThisTool ? "Stopping..." : isStartingThisTool ? "Starting..." : isCrawlActive ? "Stop crawl" : "Start crawl"}
                </Button>

                <Button
                  appearance="secondary"
                  className={styles.clearIndexButton}
                  onClick={() => setConfirmClearToolKey(tool.toolKey)}
                  disabled={!privilegedReady || statusLoading || Boolean(clearingToolKey) || isStoppingThisTool || isStartingThisTool}
                >
                  {isClearingThisTool ? "Clearing..." : "Clear index"}
                </Button>
              </div>
            );
          })}

          {tools && tools.tools.length === 0 && (
            <Text className={styles.hint}>No enabled IMAP tools are configured.</Text>
          )}
        </>
      )}

      <Dialog
        open={Boolean(confirmClearToolKey)}
        onOpenChange={(_, data) => {
          if (!data.open) {
            setConfirmClearToolKey(null);
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Clear IMAP index?</DialogTitle>
            <DialogContent>
              This will remove the index and crawl checkpoint data for
              {confirmClearToolKey ? ` "${confirmClearToolKey}"` : " this IMAP tool"}.
              The next crawl will re-ingest messages from scratch.
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setConfirmClearToolKey(null)}
                disabled={Boolean(clearingToolKey)}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => {
                  if (!confirmClearToolKey) return;
                  void handleClearIndex(confirmClearToolKey);
                  setConfirmClearToolKey(null);
                }}
                disabled={Boolean(clearingToolKey)}
              >
                Confirm clear index
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
