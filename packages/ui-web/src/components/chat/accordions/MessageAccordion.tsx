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
import type { CheckpointMetadata } from "../../../types";
import {
  getAccordionImagePayload,
  payloadToDataUri,
} from "../utils/imageUtils";
import { resolveDisplayTimestamp, toDisplayJson } from "../utils/dataFormatters";

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
  accordionHeaderField: {
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

export interface MessageAccordionProps {
  className: string;
  itemValue: string;
  headerText: string;
  headerPreTimestampText?: string;
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
  headerPreTimestampText,
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
            {headerPreTimestampText ? (
              <span className={styles.accordionHeaderField}>{headerPreTimestampText}</span>
            ) : null}
            <span className={styles.accordionTimestamp}>
              {resolveDisplayTimestamp(checkpoint, receivedAt)}
            </span>
          </span>
        </AccordionHeader>
        <AccordionPanel>
          <div className={panelClassName}>
            {children}
            {imagePayload && (
              <>
                <img
                  className={styles.imagePreview}
                  src={payloadToDataUri(imagePayload)}
                  alt=""
                />
                {(imagePayload.width != null || imagePayload.height != null) && (
                  <Text block className={styles.imageMeta}>
                    {imagePayload.width != null ? imagePayload.width : "?"}×{imagePayload.height != null ? imagePayload.height : "?"} · {imagePayload.format}
                  </Text>
                )}
              </>
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