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
import { createUuid } from "../uuid";

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
  statusCard: {
    margin: `0 ${tokens.spacingHorizontalM}`,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  statusHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  statusMeta: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  statusGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
  },
  statusLabel: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  statusValue: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
  },
  statusError: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  taskListHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  taskList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  taskItem: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  taskTitleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  taskTitle: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
  },
  taskPrompt: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  taskMetaGrid: {
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    gap: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
  },
});

interface ScheduleStatus {
  paused: boolean;
  minuteSweepRunning: boolean;
  lastSweepMinute?: string;
  totalTasks: number;
  enabledTasks: number;
  cronTasks: number;
  onceTasks: number;
  enabledCronTasks: number;
  enabledOnceTasks: number;
  lastExecutionAt?: string;
  lastExecutionTaskId?: string;
  lastExecutionResult?: "success" | "failed";
  lastExecutionError?: string;
}

interface ScheduleStatusRpcResult {
  success: boolean;
  status: ScheduleStatus;
}

interface ScheduledTaskSummary {
  id: string;
  name: string;
  type: "user" | "agent" | "system";
  scheduleType?: "cron" | "once";
  cron?: string;
  runAt?: string;
  prompt: string;
  enabled: boolean;
  lastRunAt?: string;
}

interface ScheduleTaskListRpcResult {
  paused: boolean;
  count: number;
  tasks: ScheduledTaskSummary[];
}

interface RpcResponse<T> {
  id: string;
  result?: T;
  error?: string;
}

function formatDateTime(value?: string): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatScheduledWhen(task: ScheduledTaskSummary): string {
  if (task.scheduleType === "once") {
    return task.runAt ? formatDateTime(task.runAt) : "Not set";
  }
  return task.cron ?? "Not set";
}

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
  const [activeTab, setActiveTab] = useState<"catalog" | "agents" | "schedule">("catalog");
  const [filter, setFilter] = useState("");

  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [registry, setRegistry] = useState<AgentCapabilityRegistry | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState<ScheduleStatus | null>(null);
  const [scheduleTasks, setScheduleTasks] = useState<ScheduledTaskSummary[]>([]);
  const [scheduleStatusLoading, setScheduleStatusLoading] = useState(false);
  const [scheduleStatusError, setScheduleStatusError] = useState<string | null>(null);

  const loadScheduleStatus = React.useCallback(async () => {
    setScheduleStatusLoading(true);
    setScheduleStatusError(null);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    };

    try {
      const [statusResponse, tasksResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/api/tools/_schedule/rpc`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: createUuid(),
            method: "schedule_get_status",
            params: {},
          }),
        }),
        fetch(`${apiBaseUrl}/api/tools/_schedule/rpc`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: createUuid(),
            method: "schedule_list_tasks",
            params: {},
          }),
        }),
      ]);

      if (!statusResponse.ok) throw new Error(`Schedule status: HTTP ${statusResponse.status}`);
      if (!tasksResponse.ok) throw new Error(`Schedule tasks: HTTP ${tasksResponse.status}`);

      const statusPayload = (await statusResponse.json()) as RpcResponse<ScheduleStatusRpcResult>;
      if (statusPayload.error) throw new Error(statusPayload.error);
      if (!statusPayload.result?.status) throw new Error("Schedule status result missing payload");

      const tasksPayload = (await tasksResponse.json()) as RpcResponse<ScheduleTaskListRpcResult>;
      if (tasksPayload.error) throw new Error(tasksPayload.error);
      if (!Array.isArray(tasksPayload.result?.tasks)) {
        throw new Error("Schedule tasks result missing payload");
      }

      setScheduleStatus(statusPayload.result.status);
      setScheduleTasks(tasksPayload.result.tasks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const recommendedMessage =
        message.includes("HTTP 400")
        || /not configured for HTTP RPC/i.test(message)
          ? "Schedule status is unavailable because the schedule tool is not configured for HTTP transport. Update tools.json to use transport: \"http\" for the schedule tool to enable this status check."
          : message;
      setScheduleStatus(null);
      setScheduleTasks([]);
      setScheduleStatusError(recommendedMessage);
    } finally {
      setScheduleStatusLoading(false);
    }
  }, [apiBaseUrl, authToken]);

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
      void loadScheduleStatus();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setLoadState("error");
    }
  }, [apiBaseUrl, authToken, loadScheduleStatus]);

  // Auto-fetch on open
  React.useEffect(() => {
    if (open) {
      setFilter("");
      void load();
    }
  }, [open, load]);

  React.useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      void loadScheduleStatus();
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [open, loadScheduleStatus]);

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
          Tools, Agents, and Schedule
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div className={styles.body}>
          {/* Tab bar */}
          <div className={styles.tabRow}>
            <TabList
              selectedValue={activeTab}
              onTabSelect={(_: unknown, data: SelectTabData) =>
                setActiveTab(data.value as "catalog" | "agents" | "schedule")
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
              <Tab value="schedule">Schedule</Tab>
            </TabList>
          </div>

          {/* Search */}
          {activeTab !== "schedule" && (
            <div className={styles.searchRow}>
              <Input
                size="small"
                placeholder={activeTab === "catalog" ? "Filter tools…" : "Filter agents…"}
                value={filter}
                onChange={(_, d) => setFilter(d.value)}
                style={{ width: "100%" }}
              />
            </div>
          )}

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
          {loadState === "idle" && activeTab === "schedule" && (
            <>
              <div className={styles.statusCard}>
                <div className={styles.statusHeader}>
                  <Text weight="semibold">Schedule status</Text>
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<ArrowClockwise24Regular />}
                    onClick={() => void loadScheduleStatus()}
                    disabled={scheduleStatusLoading}
                    aria-label="Refresh schedule status"
                  />
                </div>
                {scheduleStatus && (
                  <>
                    <div className={styles.statusMeta}>
                      <Badge appearance="tint" color={scheduleStatus.paused ? "warning" : "success"} size="small">
                        {scheduleStatus.paused ? "paused" : "running"}
                      </Badge>
                      <Badge appearance="tint" color="informative" size="small">
                        minute sweep {scheduleStatus.minuteSweepRunning ? "active" : "idle"}
                      </Badge>
                    </div>
                    <div className={styles.statusGrid}>
                      <Text className={styles.statusLabel}>tasks</Text>
                      <Text className={styles.statusValue}>{scheduleStatus.enabledTasks}/{scheduleStatus.totalTasks}</Text>
                      <Text className={styles.statusLabel}>cron enabled</Text>
                      <Text className={styles.statusValue}>{scheduleStatus.enabledCronTasks}</Text>
                      <Text className={styles.statusLabel}>once enabled</Text>
                      <Text className={styles.statusValue}>{scheduleStatus.enabledOnceTasks}</Text>
                      <Text className={styles.statusLabel}>last result</Text>
                      <Text className={styles.statusValue}>{scheduleStatus.lastExecutionResult ?? "none"}</Text>
                    </div>
                    {scheduleStatus.lastExecutionError && (
                      <Text className={styles.statusError}>{scheduleStatus.lastExecutionError}</Text>
                    )}
                  </>
                )}
                {!scheduleStatus && scheduleStatusLoading && <Spinner size="tiny" label="Loading schedule status…" />}
                {scheduleStatusError && <Text className={styles.statusError}>{scheduleStatusError}</Text>}
              </div>

              <div className={styles.statusCard}>
                <div className={styles.taskListHeader}>
                  <Text weight="semibold">Scheduled tasks</Text>
                  <Badge appearance="tint" color="informative" size="small">{scheduleTasks.length}</Badge>
                </div>
                {scheduleTasks.length === 0 && !scheduleStatusLoading && (
                  <Text className={styles.empty}>No scheduled tasks found.</Text>
                )}
                {scheduleTasks.length > 0 && (
                  <div className={styles.taskList}>
                    {scheduleTasks.map((task) => (
                      <div key={task.id} className={styles.taskItem}>
                        <div className={styles.taskTitleRow}>
                          <Text className={styles.taskTitle}>{task.name}</Text>
                          <Badge appearance="outline" color={task.enabled ? "success" : "warning"} size="small">
                            {task.enabled ? "enabled" : "disabled"}
                          </Badge>
                        </div>
                        <Text className={styles.taskPrompt}>{task.prompt}</Text>
                        <div className={styles.taskMetaGrid}>
                          <Text className={styles.statusLabel}>task type</Text>
                          <Text className={styles.statusValue}>{task.type}</Text>
                          <Text className={styles.statusLabel}>schedule type</Text>
                          <Text className={styles.statusValue}>{task.scheduleType ?? "cron"}</Text>
                          <Text className={styles.statusLabel}>scheduled</Text>
                          <Text className={styles.statusValue}>{formatScheduledWhen(task)}</Text>
                          <Text className={styles.statusLabel}>last executed</Text>
                          <Text className={styles.statusValue}>{formatDateTime(task.lastRunAt)}</Text>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </DrawerBody>
    </OverlayDrawer>
  );
}
