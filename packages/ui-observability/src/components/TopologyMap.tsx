import React, { useCallback, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Button,
  Card,
  Checkbox,
  makeStyles,
  Text,
  tokens,
} from "@fluentui/react-components";
import type { TopologyPayload, TopologyNodeType } from "../types";

const TYPE_ORDER: TopologyNodeType[] = ["graph", "subgraph", "agent", "model", "tool"];

const TYPE_COLORS: Record<TopologyNodeType, { bg: string; border: string }> = {
  graph: { bg: "#F7E7D2", border: "#C96B00" },
  subgraph: { bg: "#FFE6DF", border: "#E04E39" },
  agent: { bg: "#DFF4F0", border: "#117A65" },
  model: { bg: "#EAF1FF", border: "#2457C5" },
  tool: { bg: "#F2EAFE", border: "#6D3FC7" },
};

const TYPE_LABELS: Record<TopologyNodeType, string> = {
  graph: "Graphs",
  subgraph: "Subgraphs",
  agent: "Agents",
  model: "Models",
  tool: "Tools",
};

const RELATION_LABELS: Record<TopologyPayload["edges"][number]["relation"], string> = {
  "graph-orchestrator": "Graph -> Orchestrator",
  "graph-sub-agent": "Graph -> Sub-agent",
  "graph-memory-subgraph": "Graph -> Memory Subgraph",
  "graph-compression-subgraph": "Graph -> Compression Subgraph",
  "subgraph-agent": "Subgraph -> Agent",
  "agent-model": "Agent -> Model",
  "agent-tool": "Agent -> Tool",
};

const useStyles = makeStyles({
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 300px",
    gap: tokens.spacingHorizontalM,
    minHeight: 0,
    flex: 1,
    padding: tokens.spacingHorizontalM,
    "@media (max-width: 900px)": {
      gridTemplateColumns: "1fr",
      gridTemplateRows: "minmax(420px, 1fr) auto",
    },
  },
  canvas: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: "hidden",
    background:
      "radial-gradient(circle at 25% 20%, rgba(255, 120, 0, 0.06), transparent 35%), radial-gradient(circle at 80% 65%, rgba(0, 166, 161, 0.07), transparent 30%)",
  },
  side: {
    display: "grid",
    alignContent: "start",
    gap: tokens.spacingVerticalM,
    minWidth: 0,
  },
  legend: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
  },
  legendRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  filters: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    marginTop: tokens.spacingVerticalS,
  },
  sectionTitle: {
    marginTop: tokens.spacingVerticalS,
  },
  filterActions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalXS,
    flexWrap: "wrap",
  },
  swatch: {
    width: "14px",
    height: "14px",
    borderRadius: "4px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

function shapeStyle(type: TopologyNodeType): React.CSSProperties {
  switch (type) {
    case "graph":
      return { borderRadius: 999 };
    case "subgraph":
      return { borderRadius: 10, borderStyle: "dashed" };
    case "agent":
      return { borderRadius: 8 };
    case "model":
      return { borderRadius: 18 };
    case "tool":
      return { borderRadius: 2 };
    default:
      return {};
  }
}

function buildNodes(payload: TopologyPayload): Node[] {
  const positions = new Map<string, { x: number; y: number }>();
  const centerX = 0;
  const centerY = 0;
  const graphSpacing = 1500;
  const baseRadiusByType: Record<TopologyNodeType, number> = {
    graph: 0,
    subgraph: 260,
    agent: 500,
    model: 740,
    tool: 980,
  };
  const minArcGap = 190;

  const graphNodes = payload.nodes.filter((node) => node.type === "graph");
  const graphIds = graphNodes.map((node) => node.id);
  const graphCenterById = new Map<string, { x: number; y: number }>();

  graphIds.forEach((graphId, index) => {
    const totalWidth = (graphIds.length - 1) * graphSpacing;
    const x = centerX - totalWidth / 2 + index * graphSpacing;
    const y = centerY;
    graphCenterById.set(graphId, { x, y });
    positions.set(graphId, { x, y });
  });

  const outgoing = new Map<string, string[]>();
  for (const edge of payload.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }

  const ownerByNodeId = new Map<string, string>();
  const queue: Array<{ graphId: string; nodeId: string }> = [];
  for (const graphId of graphIds) {
    ownerByNodeId.set(graphId, graphId);
    queue.push({ graphId, nodeId: graphId });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const targets = outgoing.get(current.nodeId) ?? [];
    for (const targetId of targets) {
      if (ownerByNodeId.has(targetId)) continue;
      ownerByNodeId.set(targetId, current.graphId);
      queue.push({ graphId: current.graphId, nodeId: targetId });
    }
  }

  const fallbackGraphId = graphIds[0];
  const clusterByGraphAndType = new Map<string, Record<Exclude<TopologyNodeType, "graph">, string[]>>();
  for (const graphId of graphIds) {
    clusterByGraphAndType.set(graphId, {
      subgraph: [],
      agent: [],
      model: [],
      tool: [],
    });
  }

  for (const node of payload.nodes) {
    if (node.type === "graph") continue;

    const ownerGraphId = ownerByNodeId.get(node.id) ?? fallbackGraphId;
    if (!ownerGraphId) continue;

    const clusters = clusterByGraphAndType.get(ownerGraphId);
    if (!clusters) continue;

    clusters[node.type].push(node.id);
  }

  for (const [graphId, clusters] of clusterByGraphAndType.entries()) {
    const graphCenter = graphCenterById.get(graphId);
    if (!graphCenter) continue;

    (["subgraph", "agent", "model", "tool"] as const).forEach((type, typeIndex) => {
      const ids = clusters[type].sort((a, b) => a.localeCompare(b));
      if (ids.length === 0) return;

      const minRadiusForDensity = ids.length <= 1
        ? 0
        : (ids.length * minArcGap) / (Math.PI * 2);
      const ringRadius = Math.max(baseRadiusByType[type], minRadiusForDensity);

      const angleOffsetByType = [-Math.PI / 2, -Math.PI / 6, Math.PI / 8, Math.PI / 3];
      const angleOffset = angleOffsetByType[typeIndex];
      const angleStep = ids.length === 1 ? 0 : (Math.PI * 2) / ids.length;

      ids.forEach((id, index) => {
        const angle = angleOffset + angleStep * index;
        positions.set(id, {
          x: graphCenter.x + Math.cos(angle) * ringRadius,
          y: graphCenter.y + Math.sin(angle) * ringRadius,
        });
      });
    });
  }

  // Any node not reached by clustering gets a deterministic fallback near center.
  let fallbackIndex = 0;
  for (const node of payload.nodes) {
    if (positions.has(node.id)) continue;
    positions.set(node.id, {
      x: centerX + 120 * fallbackIndex,
      y: centerY + 120 * fallbackIndex,
    });
    fallbackIndex += 1;
  }

  return payload.nodes.map((node) => {
    const colors = TYPE_COLORS[node.type];
    return {
      id: node.id,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { label: `${node.label}\n${node.type}` },
      style: {
        width: 180,
        border: `2px solid ${colors.border}`,
        background: colors.bg,
        color: "#1D1D1D",
        fontWeight: 600,
        whiteSpace: "pre-line",
        textAlign: "center",
        ...shapeStyle(node.type),
      },
    } satisfies Node;
  });
}

function buildEdges(payload: TopologyPayload): Edge[] {
  return payload.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "straight",
    animated: edge.relation === "graph-sub-agent" || edge.relation === "agent-tool",
  }));
}

interface TopologyMapProps {
  payload: TopologyPayload;
}

export function TopologyMap(props: TopologyMapProps) {
  const styles = useStyles();

  const allRelations = useMemo(
    () => [...new Set(props.payload.edges.map((edge) => edge.relation))],
    [props.payload.edges],
  );

  const [visibleNodeTypes, setVisibleNodeTypes] = useState<Record<TopologyNodeType, boolean>>({
    graph: true,
    subgraph: true,
    agent: true,
    model: true,
    tool: true,
  });
  const [visibleRelations, setVisibleRelations] = useState<Record<TopologyPayload["edges"][number]["relation"], boolean>>({
    "graph-orchestrator": true,
    "graph-sub-agent": true,
    "graph-memory-subgraph": true,
    "graph-compression-subgraph": true,
    "subgraph-agent": true,
    "agent-model": true,
    "agent-tool": true,
  });

  const showAllNodeTypes = useCallback(() => {
    setVisibleNodeTypes({
      graph: true,
      subgraph: true,
      agent: true,
      model: true,
      tool: true,
    });
  }, []);

  const hideAllNodeTypes = useCallback(() => {
    setVisibleNodeTypes({
      graph: false,
      subgraph: false,
      agent: false,
      model: false,
      tool: false,
    });
  }, []);

  const showAllRelations = useCallback(() => {
    setVisibleRelations({
      "graph-orchestrator": true,
      "graph-sub-agent": true,
      "graph-memory-subgraph": true,
      "graph-compression-subgraph": true,
      "subgraph-agent": true,
      "agent-model": true,
      "agent-tool": true,
    });
  }, []);

  const hideAllRelations = useCallback(() => {
    setVisibleRelations({
      "graph-orchestrator": false,
      "graph-sub-agent": false,
      "graph-memory-subgraph": false,
      "graph-compression-subgraph": false,
      "subgraph-agent": false,
      "agent-model": false,
      "agent-tool": false,
    });
  }, []);

  const nodes = useMemo(() => {
    const filtered = {
      ...props.payload,
      nodes: props.payload.nodes.filter((node) => visibleNodeTypes[node.type]),
    };
    return buildNodes(filtered);
  }, [props.payload, visibleNodeTypes]);

  const edges = useMemo(() => {
    const visibleNodeIds = new Set(nodes.map((node) => node.id));
    const filtered = {
      ...props.payload,
      edges: props.payload.edges.filter((edge) => {
        return visibleRelations[edge.relation]
          && visibleNodeIds.has(edge.source)
          && visibleNodeIds.has(edge.target);
      }),
    };
    return buildEdges(filtered);
  }, [nodes, props.payload, visibleRelations]);

  return (
    <section className={styles.root}>
      <div className={styles.canvas}>
        <ReactFlow
          fitView
          fitViewOptions={{ padding: 0.25, duration: 300 }}
          nodes={nodes}
          edges={edges}
        >
          <Background />
          <MiniMap zoomable pannable />
          <Controls />
        </ReactFlow>
      </div>

      <div className={styles.side}>
        <Card>
          <Text weight="semibold">Map Summary</Text>
          <Text>Graphs: {props.payload.counts.graphs}</Text>
          <Text>Subgraphs: {props.payload.counts.subgraphs}</Text>
          <Text>Agents: {props.payload.counts.agents}</Text>
          <Text>Models: {props.payload.counts.models}</Text>
          <Text>Tools: {props.payload.counts.tools}</Text>
        </Card>

        <Card>
          <Text weight="semibold">Legend</Text>
          <div className={styles.legend}>
            {TYPE_ORDER.map((type) => (
              <div className={styles.legendRow} key={type}>
                <span
                  className={styles.swatch}
                  style={{
                    backgroundColor: TYPE_COLORS[type].bg,
                    borderColor: TYPE_COLORS[type].border,
                  }}
                />
                <Text>{TYPE_LABELS[type]}</Text>
              </div>
            ))}
          </div>

          <Text weight="semibold" className={styles.sectionTitle}>Node Types</Text>
          <div className={styles.filterActions}>
            <Button size="small" onClick={showAllNodeTypes}>Show All</Button>
            <Button size="small" onClick={hideAllNodeTypes}>Hide All</Button>
          </div>
          <div className={styles.filters}>
            {TYPE_ORDER.map((type) => (
              <Checkbox
                key={type}
                label={TYPE_LABELS[type]}
                checked={visibleNodeTypes[type]}
                onChange={(_, data) => {
                  setVisibleNodeTypes((prev) => ({
                    ...prev,
                    [type]: data.checked === true,
                  }));
                }}
              />
            ))}
          </div>

          <Text weight="semibold" className={styles.sectionTitle}>Relations</Text>
          <div className={styles.filterActions}>
            <Button size="small" onClick={showAllRelations}>Show All</Button>
            <Button size="small" onClick={hideAllRelations}>Hide All</Button>
          </div>
          <div className={styles.filters}>
            {allRelations.map((relation) => (
              <Checkbox
                key={relation}
                label={RELATION_LABELS[relation] ?? relation}
                checked={visibleRelations[relation]}
                onChange={(_, data) => {
                  setVisibleRelations((prev) => ({
                    ...prev,
                    [relation]: data.checked === true,
                  }));
                }}
              />
            ))}
          </div>
        </Card>
      </div>
    </section>
  );
}
