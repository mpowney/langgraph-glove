import React, { useState, useMemo } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Spinner,
  Input,
  Badge,
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Divider,
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  TabList,
  Tab,
  type SelectTabData,
} from "@fluentui/react-components";
import { Dismiss24Regular, ArrowClockwise24Regular } from "@fluentui/react-icons";
import type { ToolDefinition, AgentCapabilityEntry, AgentCapabilityRegistry } from "../types";
import { ParameterTable } from "./ParameterTable";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerActions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} 0`,
    overflowY: "auto",
  },
  searchRow: {
    padding: `0 ${tokens.spacingHorizontalM}`,
  },
  tabRow: {
    padding: `0 ${tokens.spacingHorizontalM}`,
    flexShrink: 0,
  },
  toolAccordion: {
    margin: `0 ${tokens.spacingHorizontalS}`,
  },
  toolHeader: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    width: "100%",
  },
  toolName: {
    fontFamily: tokens.fontFamilyMonospace,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  toolDescription: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase300,
    marginBottom: tokens.spacingVerticalS,
  },
  agentCard: {
    margin: `0 ${tokens.spacingHorizontalS}`,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  agentKey: {
    fontFamily: tokens.fontFamilyMonospace,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorBrandForeground1,
  },
  agentDesc: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  agentMeta: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
  },
  toolChipList: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
    marginTop: tokens.spacingVerticalXXS,
  },
  toolChip: {
    display: "inline-block",
    padding: `1px ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground4,
    fontSize: tokens.fontSizeBase100,
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground2,
  },
  noTools: {
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
    fontSize: tokens.fontSizeBase200,
  },
  allTools: {
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
    fontSize: tokens.fontSizeBase200,
  },
  empty: {
    padding: tokens.spacingVerticalL,
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
  },
});

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolCatalog({
  tools,
  filter,
}: {
  tools: ToolDefinition[];
  filter: string;
}) {
  const styles = useStyles();
  const lc = filter.toLowerCase();
  const filtered = filter
    ? tools.filter(
        (t) =>
          t.name.toLowerCase().includes(lc) ||
          t.description.toLowerCase().includes(lc),
      )
    : tools;

  if (filtered.length === 0) {
    return <Text className={styles.empty}>No tools match the filter.</Text>;
  }

  return (
    <Accordion multiple collapsible>
      {filtered.map((tool) => (
        <AccordionItem key={tool.name} value={tool.name} className={styles.toolAccordion}>
          <AccordionHeader size="small">
            <span className={styles.toolName}>{tool.name}</span>
          </AccordionHeader>
          <AccordionPanel>
            <Text className={styles.toolDescription}>{tool.description}</Text>
            <ParameterTable parameters={tool.parameters} />
          </AccordionPanel>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

function AgentCapabilityView({
  registry,
  filter,
}: {
  registry: AgentCapabilityRegistry;
  filter: string;
}) {
  const styles = useStyles();
  const lc = filter.toLowerCase();
  const filtered = filter
    ? registry.agents.filter(
        (a) =>
          a.key.toLowerCase().includes(lc) ||
          a.description.toLowerCase().includes(lc) ||
          (a.tools ?? []).some((t) => t.toLowerCase().includes(lc)),
      )
    : registry.agents;

  if (filtered.length === 0) {
    return <Text className={styles.empty}>No agents match the filter.</Text>;
  }

  return (
    <>
      {filtered.map((agent, i) => (
        <React.Fragment key={agent.key}>
          {i > 0 && <Divider />}
          <AgentCard agent={agent} registry={registry} />
        </React.Fragment>
      ))}
    </>
  );
}

function AgentCard({
  agent,
  registry,
}: {
  agent: AgentCapabilityEntry;
  registry: AgentCapabilityRegistry;
}) {
  const styles = useStyles();
  const toolNames = agent.tools;

  return (
    <div className={styles.agentCard}>
      <Text className={styles.agentKey}>{agent.key}</Text>
      {agent.description && agent.description !== agent.key && (
        <Text className={styles.agentDesc}>{agent.description}</Text>
      )}
      <div className={styles.agentMeta}>
        <Badge appearance="tint" color="informative" size="small">
          model: {agent.modelKey}
        </Badge>
        <Badge appearance="tint" color="subtle" size="small">
          {toolNames === null
            ? "all tools"
            : `${toolNames.length} tool${toolNames.length !== 1 ? "s" : ""}`}
        </Badge>
      </div>
      {toolNames === null ? (
        <Text className={styles.allTools}>Access to all discovered tools</Text>
      ) : toolNames.length === 0 ? (
        <Text className={styles.noTools}>No tools configured</Text>
      ) : (
        <div className={styles.toolChipList}>
          {toolNames.map((name) => {
            const def = registry.tools[name];
            return (
              <span key={name} title={def?.description ?? name} className={styles.toolChip}>
                {name}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolsPanel props
// ---------------------------------------------------------------------------

export interface ToolsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Base URL of the AdminApi server. Default: same origin. */
  apiBaseUrl?: string;
  /** Optional bearer token. */
  authToken?: string;
}

// ---------------------------------------------------------------------------
// ToolsPanel
// ---------------------------------------------------------------------------

export function ToolsPanel({ open, onClose, apiBaseUrl = "", authToken }: ToolsPanelProps) {
  const styles = useStyles();
  const [activeTab, setActiveTab] = useState<"catalog" | "agents">("catalog");
  const [filter, setFilter] = useState("");

  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [registry, setRegistry] = useState<AgentCapabilityRegistry | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    const headers: Record<string, string> = authToken
      ? { Authorization: `Bearer ${authToken}` }
      : {};
    try {
      const [toolsRes, capRes] = await Promise.all([
        fetch(`${apiBaseUrl}/api/tools/registry`, { headers }),
        fetch(`${apiBaseUrl}/api/agents/capabilities`, { headers }),
      ]);
      if (!toolsRes.ok) throw new Error(`Tools registry: HTTP ${toolsRes.status}`);
      if (!capRes.ok) throw new Error(`Capabilities: HTTP ${capRes.status}`);
      const toolData = (await toolsRes.json()) as ToolDefinition[];
      const capData = (await capRes.json()) as AgentCapabilityRegistry;
      setTools(toolData);
      setRegistry(capData);
      setLoadState("idle");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setLoadState("error");
    }
  }, [apiBaseUrl, authToken]);

  // Auto-fetch on open
  React.useEffect(() => {
    if (open) {
      setFilter("");
      void load();
    }
  }, [open, load]);

  const toolCount = useMemo(() => tools.length, [tools]);
  const agentCount = useMemo(() => registry?.agents.length ?? 0, [registry]);

  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, { open: o }) => { if (!o) onClose(); }}
      position="end"
      size="medium"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <div className={styles.headerActions}>
              <Button
                appearance="subtle"
                icon={<ArrowClockwise24Regular />}
                onClick={() => void load()}
                disabled={loadState === "loading"}
                aria-label="Refresh"
              />
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                onClick={onClose}
                aria-label="Close"
              />
            </div>
          }
        >
          Tools &amp; Agents
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div className={styles.body}>
          {/* Tab bar */}
          <div className={styles.tabRow}>
            <TabList
              selectedValue={activeTab}
              onTabSelect={(_: unknown, data: SelectTabData) =>
                setActiveTab(data.value as "catalog" | "agents")
              }
              size="small"
            >
              <Tab value="catalog">
                Tools
                {toolCount > 0 && (
                  <Badge appearance="tint" color="informative" size="small" style={{ marginLeft: 4 }}>
                    {toolCount}
                  </Badge>
                )}
              </Tab>
              <Tab value="agents">
                Agents
                {agentCount > 0 && (
                  <Badge appearance="tint" color="informative" size="small" style={{ marginLeft: 4 }}>
                    {agentCount}
                  </Badge>
                )}
              </Tab>
            </TabList>
          </div>

          {/* Search */}
          <div className={styles.searchRow}>
            <Input
              size="small"
              placeholder={activeTab === "catalog" ? "Filter tools…" : "Filter agents…"}
              value={filter}
              onChange={(_, d) => setFilter(d.value)}
              style={{ width: "100%" }}
            />
          </div>

          {/* Content */}
          {loadState === "loading" && (
            <Spinner label="Loading…" size="small" style={{ alignSelf: "center" }} />
          )}
          {loadState === "error" && (
            <Text className={styles.errorText}>{loadError}</Text>
          )}
          {loadState === "idle" && activeTab === "catalog" && (
            <ToolCatalog tools={tools} filter={filter} />
          )}
          {loadState === "idle" && activeTab === "agents" && registry && (
            <AgentCapabilityView registry={registry} filter={filter} />
          )}
          {loadState === "idle" && activeTab === "agents" && !registry && (
            <Text className={styles.empty}>No capability data available.</Text>
          )}
        </div>
      </DrawerBody>
    </OverlayDrawer>
  );
}
