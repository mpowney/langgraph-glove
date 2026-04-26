import React from "react";
import {
  makeStyles,
  tokens,
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Text,
} from "@fluentui/react-components";
import type { ChatEntry } from "../../../types";
import { resolveDisplayTimestamp } from "../utils/dataFormatters";
import { InlineContent } from "../content/InlineContent";
import { LinkPill } from "../content/LinkPill";

const useStyles = makeStyles({
  agentWrapper: {
    display: "flex",
    justifyContent: "flex-start",
  },
  subAgentContainer: {
    display: "inline-block",
    width: "fit-content",
    maxWidth: "80vw",
  },
  subAgentAccordion: {
    display: "inline-block",
    width: "fit-content",
    maxWidth: "100%",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    paddingRight: tokens.spacingHorizontalM,
    overflow: "hidden",
  },
  subAgentHeaderRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  subAgentHeaderLabel: {
    fontWeight: tokens.fontWeightSemibold,
  },
  subAgentHeaderAgent: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
  },
  subAgentHeaderTimestamp: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
  },
  subAgentPanel: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM} ${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
  },
  subAgentBubble: {
    width: "fit-content",
    maxWidth: "100%",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusXLarge,
    borderBottomLeftRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    wordBreak: "break-word",
  },
  refsWrapper: {
    marginTop: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalXS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  refsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalXS,
    rowGap: tokens.spacingVerticalXXS,
  },
});

interface SubAgentMessageRendererProps {
  entry: ChatEntry;
  isOpen: boolean;
  accordionValue: string;
  onToggle: (open: boolean) => void;
  sessionLabelNode?: React.ReactNode;
  showCursor?: boolean;
  cursorClassName: string;
}

export function SubAgentMessageRenderer({
  entry,
  isOpen,
  accordionValue,
  onToggle,
  sessionLabelNode,
  showCursor,
  cursorClassName,
}: SubAgentMessageRendererProps) {
  const styles = useStyles();
  const openItems = isOpen ? [accordionValue] : [];

  return (
    <div className={styles.agentWrapper}>
      <div className={styles.subAgentContainer}>
        {sessionLabelNode}
        <Accordion
          collapsible
          openItems={openItems}
          onToggle={(_, data) => {
            const next = Array.isArray(data.openItems)
              ? data.openItems.includes(accordionValue)
              : data.openItems === accordionValue;
            onToggle(next);
          }}
          className={styles.subAgentAccordion}
        >
          <AccordionItem value={accordionValue}>
            <AccordionHeader size="small">
              <span className={styles.subAgentHeaderRow}>
                <span className={styles.subAgentHeaderLabel}>Sub-agent stream</span>
                {entry.streamAgentKey ? (
                  <span className={styles.subAgentHeaderAgent}>{entry.streamAgentKey}</span>
                ) : null}
                <span className={styles.subAgentHeaderTimestamp}>
                  {resolveDisplayTimestamp(entry.checkpoint, entry.receivedAt)}
                </span>
              </span>
            </AccordionHeader>
            <AccordionPanel>
              <div className={styles.subAgentPanel}>
                <div className={styles.subAgentBubble}>
                  <InlineContent content={entry.content} />
                  {showCursor ? <span className={cursorClassName} aria-hidden /> : null}
                  {entry.references && entry.references.length > 0 ? (
                    <div className={styles.refsWrapper}>
                      <Text block size={200}>References</Text>
                      <div className={styles.refsRow}>
                        {entry.references.map((ref) => (
                          <LinkPill key={ref.url} href={ref.url}>
                            {ref.title}
                          </LinkPill>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );
}
