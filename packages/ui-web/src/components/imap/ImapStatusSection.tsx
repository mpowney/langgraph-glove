import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Divider,
  makeStyles,
  Spinner,
  Text,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwise24Regular } from "@fluentui/react-icons";
import {
  getImapCrawlStatus,
  listImapTools,
  type ImapCrawlStatusResult,
  type ImapListToolsResult,
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<ImapListToolsResult | null>(null);
  const [status, setStatus] = useState<ImapCrawlStatusResult | null>(null);

  const privilegedReady = privilegedGrantId.trim().length > 0 && conversationId.trim().length > 0;

  const load = useCallback(async () => {
    if (!privilegedReady) return;
    setLoading(true);
    setError(null);
    try {
      const [toolsResult, statusResult] = await Promise.all([
        listImapTools(apiBaseUrl, authToken, privilegedGrantId, conversationId),
        getImapCrawlStatus(apiBaseUrl, authToken, privilegedGrantId, conversationId),
      ]);
      setTools(toolsResult);
      setStatus(statusResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, authToken, privilegedGrantId, conversationId, privilegedReady]);

  useEffect(() => {
    if (!open || !privilegedReady) return;
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [open, privilegedReady, load]);

  const statusesByKey = useMemo(() => {
    const map = new Map<string, NonNullable<ImapCrawlStatusResult["tools"][number]>>();
    for (const entry of status?.tools ?? []) {
      map.set(entry.toolKey, entry);
    }
    return map;
  }, [status]);

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
          onClick={() => { void load(); }}
          disabled={!privilegedReady || loading}
        >
          Refresh
        </Button>
      </div>

      {!privilegedReady && (
        <Text className={styles.hint}>Enable privileged access to query IMAP indexing status.</Text>
      )}

      {privilegedReady && loading && !status && (
        <Spinner size="tiny" label="Loading IMAP status..." />
      )}

      {error && <Text className={styles.error}>{error}</Text>}

      {status && (
        <>
          <div className={styles.summary}>
            <Text className={styles.summaryKey}>Configured tools</Text>
            <Text className={styles.summaryValue}>{formatNumber(status.summary.totalTools)}</Text>
            <Text className={styles.summaryKey}>Active crawls</Text>
            <Text className={styles.summaryValue}>{formatNumber(status.summary.activeCrawls)}</Text>
            <Text className={styles.summaryKey}>Estimated emails remaining</Text>
            <Text className={styles.summaryValue}>{formatNumber(status.summary.estimatedRemainingEmails)}</Text>
            <Text className={styles.summaryKey}>Tools with status errors</Text>
            <Text className={styles.summaryValue}>{formatNumber(status.summary.failedTools)}</Text>
          </div>

          <Divider />

          {(tools?.tools ?? []).map((tool) => {
            const toolStatus = statusesByKey.get(tool.toolKey);
            const runtime = toolStatus?.status?.crawlRuntime;
            const estimate = toolStatus?.status?.estimate;
            const totals = toolStatus?.status?.totals;

            return (
              <div key={tool.toolKey} className={styles.card}>
                <div className={styles.cardHeader}>
                  <Text className={styles.cardTitle}>{tool.toolKey}</Text>
                  <Badge appearance="filled" color={runtime?.active ? "success" : "informative"}>
                    {runtime?.active ? "crawling" : "idle"}
                  </Badge>
                </div>

                {toolStatus?.error && <Text className={styles.error}>{toolStatus.error}</Text>}

                <div className={styles.cardGrid}>
                  <Text className={styles.summaryKey}>Mode</Text>
                  <Text className={styles.summaryValue}>{tool.crawlMode}</Text>
                  <Text className={styles.summaryKey}>Indexing</Text>
                  <Text className={styles.summaryValue}>{tool.indexingStrategy}</Text>
                  <Text className={styles.summaryKey}>Emails indexed</Text>
                  <Text className={styles.summaryValue}>{formatNumber(totals?.emails)}</Text>
                  <Text className={styles.summaryKey}>Chunks indexed</Text>
                  <Text className={styles.summaryValue}>{formatNumber(totals?.chunks)}</Text>
                  <Text className={styles.summaryKey}>Remaining emails (est.)</Text>
                  <Text className={styles.summaryValue}>{formatNumber(estimate?.remainingEmails)}</Text>
                  <Text className={styles.summaryKey}>Folder progress</Text>
                  <Text className={styles.summaryValue}>
                    {formatNumber(runtime?.completedFolders)}/{formatNumber(runtime?.totalFolders)}
                  </Text>
                  <Text className={styles.summaryKey}>Elapsed</Text>
                  <Text className={styles.summaryValue}>{formatElapsed(runtime?.elapsedMs)}</Text>
                </div>
              </div>
            );
          })}

          {tools && tools.tools.length === 0 && (
            <Text className={styles.hint}>No enabled IMAP tools are configured.</Text>
          )}
        </>
      )}
    </div>
  );
}
