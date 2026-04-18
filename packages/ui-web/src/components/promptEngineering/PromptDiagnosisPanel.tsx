import React, { useEffect, useMemo, useState } from "react";
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
import {
  ArrowClockwise24Regular,
  ChevronDown24Regular,
  ChevronUp24Regular,
  Dismiss24Regular,
} from "@fluentui/react-icons";
import type { PromptDiagnosisItem } from "../../types";
import { PromptImproveDialog } from "./PromptImproveDialog";
import { usePromptDiagnosis } from "./usePromptDiagnosis";

const useStyles = makeStyles({
  body: {
    padding: `${tokens.spacingVerticalM} 0`,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    height: "100%",
    overflowY: "auto",
  },
  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  sections: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: tokens.spacingHorizontalM,
    minHeight: 0,
    "@media (max-width: 1100px)": {
      gridTemplateColumns: "1fr",
    },
  },
  section: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalM,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    minHeight: 0,
  },
  sectionTitleRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rows: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  row: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  rowHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  counters: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  promptSingleLine: {
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflow: "hidden",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  promptExpanded: {
    whiteSpace: "pre-wrap",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  rowActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    padding: `${tokens.spacingVerticalM} 0`,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

interface PromptDiagnosisPanelProps {
  open: boolean;
  onClose: () => void;
  apiBaseUrl?: string;
  authToken?: string;
  conversationId?: string;
}

export function PromptDiagnosisPanel({
  open,
  onClose,
  apiBaseUrl = "",
  authToken,
  conversationId,
}: PromptDiagnosisPanelProps) {
  const styles = useStyles();
  const {
    summary,
    summaryState,
    summaryError,
    improveState,
    improveError,
    loadSummary,
    improvePrompt,
  } = usePromptDiagnosis(apiBaseUrl, authToken);

  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<PromptDiagnosisItem | null>(null);

  useEffect(() => {
    if (!open) return;
    void loadSummary(10);
  }, [open, loadSummary]);

  const toggleExpanded = (key: string): void => {
    setExpandedRows((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const sections = useMemo(
    () => [
      {
        title: "Most disliked prompts",
        rows: summary.mostDisliked,
      },
      {
        title: "Most liked prompts",
        rows: summary.mostLiked,
      },
    ],
    [summary],
  );

  return (
    <>
      <OverlayDrawer
        open={open}
        onOpenChange={(_, data) => {
          if (!data.open) onClose();
        }}
        position="end"
        size="full"
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                onClick={onClose}
                aria-label="Close prompt diagnosis"
              />
            }
          >
            Prompt Diagnosis
          </DrawerHeaderTitle>
        </DrawerHeader>

        <DrawerBody>
          <div className={styles.body}>
            <div className={styles.topBar}>
              <Text size={300} weight="semibold">
                Diagnose liked and disliked prompt outcomes
              </Text>
              <Button
                appearance="secondary"
                icon={summaryState === "loading" ? <Spinner size="tiny" /> : <ArrowClockwise24Regular />}
                onClick={() => { void loadSummary(10); }}
                disabled={summaryState === "loading"}
              >
                Refresh
              </Button>
            </div>

            {summaryError ? <Text className={styles.error}>{summaryError}</Text> : null}
            <Divider />

            <div className={styles.sections}>
              {sections.map((section) => (
                <div key={section.title} className={styles.section}>
                  <div className={styles.sectionTitleRow}>
                    <Text weight="semibold">{section.title}</Text>
                    <Badge appearance="filled">{section.rows.length}</Badge>
                  </div>

                  {summaryState === "loading" ? <Spinner size="small" /> : null}
                  {summaryState !== "loading" && section.rows.length === 0 ? (
                    <Text className={styles.empty}>No prompts available yet.</Text>
                  ) : null}

                  <div className={styles.rows}>
                    {section.rows.map((item, index) => {
                      const rowKey = `${section.title}:${item.promptResolvedHash}`;
                      const expanded = expandedRows.has(rowKey);
                      return (
                        <div key={rowKey} className={styles.row}>
                          <div className={styles.rowHeader}>
                            <Text weight="semibold">#{index + 1}</Text>
                            <div className={styles.counters}>
                              <Badge appearance="tint">likes {item.likeCount}</Badge>
                              <Badge appearance="tint">dislikes {item.dislikeCount}</Badge>
                            </div>
                          </div>

                          <Text className={expanded ? styles.promptExpanded : styles.promptSingleLine}>
                            {item.promptText}
                          </Text>

                          <div className={styles.rowActions}>
                            <Button
                              appearance="subtle"
                              icon={expanded ? <ChevronUp24Regular /> : <ChevronDown24Regular />}
                              onClick={() => toggleExpanded(rowKey)}
                            >
                              {expanded ? "Collapse" : "Expand"}
                            </Button>
                            <Button
                              appearance="primary"
                              disabled={!item.latestDislikedMessage}
                              onClick={() => {
                                setSelectedItem(item);
                                setDialogOpen(true);
                              }}
                            >
                              Improve prompt
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </DrawerBody>
      </OverlayDrawer>

      <PromptImproveDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        selectedItem={selectedItem}
        conversationId={conversationId}
        improveState={improveState}
        improveError={improveError}
        onImprove={improvePrompt}
      />
    </>
  );
}
