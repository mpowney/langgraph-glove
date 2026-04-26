import React from "react";
import {
  makeStyles,
  tokens,
  Text,
  Switch,
  Button,
  CompoundButton,
  Divider,
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
} from "@fluentui/react-components";
import {
  ArrowReset24Regular,
  Chat24Regular,
  Dismiss24Regular,
  DocumentEdit24Regular,
  Wrench24Regular,
} from "@fluentui/react-icons";
import { Badge } from "@fluentui/react-components";
import { PlugDisconnected24Regular } from "@fluentui/react-icons";
import type { AvailablePanel } from "../types";

const useStyles = makeStyles({
  body: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    padding: `${tokens.spacingVerticalM} 0`,
  },
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
  switchStack: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  panelButtons: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  panelButton: {
    width: "100%",
    justifyContent: "flex-start",
    minHeight: "40px",
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
  },
  toolPanelButton: {
    width: "100%",
    justifyContent: "flex-start",
    minHeight: "40px",
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
  },
  toolPanelButtonError: {
    width: "100%",
    justifyContent: "flex-start",
    minHeight: "40px",
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    opacity: "0.7",
  },
  toolPanelHeader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
  },
  startButton: {
    width: "100%",
    justifyContent: "flex-start",
  },
});

interface ControlPanelProps {
  open: boolean;
  onClose: () => void;
  showAll: boolean;
  onToggleShowAll: (value: boolean) => void;
  showAccordionAndSubAgentMessages: boolean;
  onToggleShowAccordionAndSubAgentMessages: (value: boolean) => void;
  showInlineProcessingMessages: boolean;
  onToggleShowInlineProcessingMessages: (value: boolean) => void;
  showSystemMessages: boolean;
  onToggleShowSystemMessages: (value: boolean) => void;
  onStartNewConversation: () => void;
  onOpenBrowser: () => void;
  onOpenContentBrowser: () => void;
  onOpenToolsPanel: () => void;
  /** Dynamically resolved tool panels from useToolPanels(). */
  toolPanels: AvailablePanel[];
  onOpenToolPanel: (panelKey: string) => void;
}

export function ControlPanel({
  open,
  onClose,
  showAll,
  onToggleShowAll,
  showAccordionAndSubAgentMessages,
  onToggleShowAccordionAndSubAgentMessages,
  showInlineProcessingMessages,
  onToggleShowInlineProcessingMessages,
  showSystemMessages,
  onToggleShowSystemMessages,
  onStartNewConversation,
  onOpenBrowser,
  onOpenContentBrowser,
  onOpenToolsPanel,
  toolPanels,
  onOpenToolPanel,
}: ControlPanelProps) {
  const styles = useStyles();

  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
      position="end"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss24Regular />}
              onClick={onClose}
              aria-label="Close control panel"
            />
          }
        >
          Control Panel
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div className={styles.body}>

          {/* ── View options ── */}
          <div className={styles.section}>
            <Text size={100} weight="semibold" className={styles.sectionLabel}>
              View options
            </Text>
            <div className={styles.switchStack}>
              <Switch
                checked={showAll}
                onChange={(_, data) => onToggleShowAll(data.checked)}
                label="All conversations"
              />
              <Switch
                checked={showAccordionAndSubAgentMessages}
                onChange={(_, data) => onToggleShowAccordionAndSubAgentMessages(data.checked)}
                label="Agent processing details"
              />
              <Switch
                checked={showInlineProcessingMessages}
                onChange={(_, data) => onToggleShowInlineProcessingMessages(data.checked)}
                disabled={!showAccordionAndSubAgentMessages}
                label="Show inline processing messages"
              />
              <Switch
                checked={showSystemMessages}
                onChange={(_, data) => onToggleShowSystemMessages(data.checked)}
                label="System messages"
              />
            </div>
          </div>

          <Divider />

          {/* ── Conversation ── */}
          <div className={styles.section}>
            <Text size={100} weight="semibold" className={styles.sectionLabel}>
              Conversation
            </Text>
            <Button
              appearance="secondary"
              icon={<ArrowReset24Regular />}
              onClick={() => {
                onStartNewConversation();
                onClose();
              }}
              className={styles.startButton}
            >
              Start new conversation
            </Button>
          </div>

          <Divider />

          {/* ── Tool Configuration ── */}
          <div className={styles.section}>
            <Text size={100} weight="semibold" className={styles.sectionLabel}>
              Tool Configuration
            </Text>
            <div className={styles.panelButtons}>
              <CompoundButton
                appearance="subtle"
                icon={<Chat24Regular />}
                secondaryContent="Browse conversation history"
                onClick={() => {
                  onClose();
                  onOpenBrowser();
                }}
                className={styles.panelButton}
              >
                Conversations
              </CompoundButton>
              <CompoundButton
                appearance="subtle"
                icon={<DocumentEdit24Regular />}
                secondaryContent="Browse uploaded content items"
                onClick={() => {
                  onClose();
                  onOpenContentBrowser();
                }}
                className={styles.panelButton}
              >
                Content
              </CompoundButton>
              <CompoundButton
                appearance="subtle"
                icon={<Wrench24Regular />}
                secondaryContent="View available tools and agents"
                onClick={() => {
                  onClose();
                  onOpenToolsPanel();
                }}
                className={styles.panelButton}
              >
                Tools &amp; agents
              </CompoundButton>
              {toolPanels.map((panel) =>
                panel.status === "error" ? (
                  <CompoundButton
                    key={panel.panelKey}
                    appearance="subtle"
                    icon={<PlugDisconnected24Regular />}
                    secondaryContent={
                      <span className={styles.toolPanelHeader}>
                        <Badge appearance="filled" color="warning" size="small">
                          Not connected
                        </Badge>
                      </span>
                    }
                    disabled
                    className={styles.toolPanelButtonError}
                  >
                    {panel.label}
                  </CompoundButton>
                ) : (
                  <CompoundButton
                    key={panel.panelKey}
                    appearance="subtle"
                    icon={<Wrench24Regular />}
                    secondaryContent={panel.description}
                    onClick={() => {
                      onClose();
                      onOpenToolPanel(panel.panelKey);
                    }}
                    className={styles.toolPanelButton}
                  >
                    {panel.label}
                  </CompoundButton>
                )
              )}
            </div>
          </div>

        </div>
      </DrawerBody>
    </OverlayDrawer>
  );
}
