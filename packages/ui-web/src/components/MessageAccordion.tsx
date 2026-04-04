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

interface StructuredImagePayload {
  width?: number;
  height?: number;
  data: string;
  format: string;
  encoding?: string;
}

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
  imagePreview: {
    display: "block",
    maxWidth: "100%",
    height: "auto",
    borderRadius: tokens.borderRadiusMedium,
    marginTop: tokens.spacingVerticalXS,
    boxShadow: tokens.shadow2,
  },
  imageMeta: {
    marginTop: tokens.spacingVerticalXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeImageFormat(format: string): string | null {
  const normalized = format.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "jpg") return "jpeg";
  if (normalized === "svg") return "svg+xml";
  const supportedFormats = new Set(["png", "jpeg", "gif", "webp", "bmp", "svg+xml"]);
  return supportedFormats.has(normalized) ? normalized : null;
}

function toImagePayload(value: unknown): StructuredImagePayload | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      return toImagePayload(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  if (!isRecord(value)) return null;
  if (typeof value.data !== "string" || typeof value.format !== "string") return null;
  if (value.encoding != null && value.encoding !== "base64") return null;
  if (value.width != null && typeof value.width !== "number") return null;
  if (value.height != null && typeof value.height !== "number") return null;

  const format = normalizeImageFormat(value.format);
  if (!format) return null;

  return {
    data: value.data.replace(/\s+/g, ""),
    format,
    encoding: typeof value.encoding === "string" ? value.encoding : "base64",
    width: typeof value.width === "number" ? value.width : undefined,
    height: typeof value.height === "number" ? value.height : undefined,
  };
}

function getAccordionImagePayload(rawPayload: unknown, children: React.ReactNode): StructuredImagePayload | null {
  if (typeof children === "string") {
    const fromChildren = toImagePayload(children);
    if (fromChildren) return fromChildren;
  }

  const fromRawPayload = toImagePayload(rawPayload);
  if (fromRawPayload) return fromRawPayload;

  if (typeof rawPayload === "string") {
    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      if (isRecord(parsed) && "content" in parsed) {
        return toImagePayload(parsed.content);
      }
    } catch {
      return null;
    }
  }

  return null;
}

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
  const imagePayload = getAccordionImagePayload(rawPayload, children);
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
            {imagePayload ? (
              <>
                <img
                  className={styles.imagePreview}
                  src={`data:image/${imagePayload.format};base64,${imagePayload.data}`}
                  alt={headerText}
                  width={imagePayload.width}
                  height={imagePayload.height}
                />
                <Text block className={styles.imageMeta}>
                  {`${imagePayload.width ?? "?"}x${imagePayload.height ?? "?"} ${imagePayload.format}`}
                </Text>
              </>
            ) : (
              children
            )}
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