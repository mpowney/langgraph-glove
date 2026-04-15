export interface AppInfo {
  name?: string;
  description?: string;
  apiUrl?: string;
}

export type TopologyNodeType = "graph" | "agent" | "subgraph" | "model" | "tool";

export interface TopologyNode {
  id: string;
  type: TopologyNodeType;
  key: string;
  label: string;
  meta?: Record<string, unknown>;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  relation:
    | "graph-orchestrator"
    | "graph-sub-agent"
    | "graph-memory-subgraph"
    | "graph-compression-subgraph"
    | "subgraph-agent"
    | "agent-model"
    | "agent-tool";
  meta?: Record<string, unknown>;
}

export interface TopologyPayload {
  generatedAt: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  counts: {
    graphs: number;
    agents: number;
    subgraphs: number;
    models: number;
    tools: number;
  };
}
