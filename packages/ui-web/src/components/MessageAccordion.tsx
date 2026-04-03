import React from "react";
import {
  makeStyles,
  tokens,
  Text,
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
} from "@fluentui/react-components";
import type { CheckpointMetadata } from "../types";

const useStyles = makeStyles({
  accordionHeaderRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  accordionTimestamp: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
  },
  metadataSection: {
    marginTop: tokens.spacingVerticalM,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: tokens.spacingVerticalS,
  },
  metadataLabel: {
    marginBottom: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  metadataBody: {
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
});

function toDisplayJson(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? fallback;
  } catch {
    return fallback;
  }
}

function formatReceivedAt(receivedAt?: string): string {
  if (!receivedAt) return "unknown time";
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) return receivedAt;
  return date.toLocaleString();
}

function resolveDisplayTimestamp(checkpoint?: CheckpointMetadata, receivedAt?: string): string {
  if (checkpoint?.timestamp) {
    const date = new Date(checkpoint.timestamp);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
    return checkpoint.timestamp;
  }
  return formatReceivedAt(receivedAt);
}

export interface MessageAccordionProps {
  className: string;
  itemValue: string;
  headerText: string;
  panelClassName: string;
  rawPayload: unknown;
  receivedAt?: string;
  checkpoint?: CheckpointMetadata;
  children?: React.ReactNode;
}

export function MessageAccordion({
  className,
  itemValue,
  headerText,
  panelClassName,
  rawPayload,
  receivedAt,
  checkpoint,
  children,
}: MessageAccordionProps) {
  const styles = useStyles();
  const metadata = {
    checkpoint: checkpoint ?? null,
    receivedAt: receivedAt ?? null,
    rawPayload,
  };

  return (
    <Accordion className={className} collapsible>
      <AccordionItem value={itemValue}>
        <AccordionHeader size="small">
          <span className={styles.accordionHeaderRow}>
            <span>{headerText}</span>
            <span className={styles.accordionTimestamp}>
              {resolveDisplayTimestamp(checkpoint, receivedAt)}
            </span>
          </span>
        </AccordionHeader>
        <AccordionPanel>
          <div className={panelClassName}>
            {children}
            <div className={styles.metadataSection}>
              <Text block className={styles.metadataLabel}>Underlying data</Text>
              <div className={styles.metadataBody}>{toDisplayJson(metadata, "")}</div>
            </div>
          </div>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}