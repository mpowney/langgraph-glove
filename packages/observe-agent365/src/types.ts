import type { ObserveSendPayload } from "@langgraph-glove/observe-server";

export interface Agent365ForwardHttpConfig {
  url: string;
  authToken?: string;
  timeoutMs?: number;
}

export interface Agent365ForwardUnixConfig {
  socketPath: string;
  timeoutMs?: number;
}

export interface Agent365ForwardConfig {
  transport: "none" | "http" | "unix-socket";
  http?: Agent365ForwardHttpConfig;
  unixSocket?: Agent365ForwardUnixConfig;
}

export interface Agent365IngressHttpConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
}

export interface Agent365IngressUnixConfig {
  enabled: boolean;
  socketPath: string;
}

export interface Agent365RelayConfig {
  ingress: {
    http: Agent365IngressHttpConfig;
    unixSocket: Agent365IngressUnixConfig;
  };
  forward: Agent365ForwardConfig;
}

export interface Agent365RelayStats {
  received: number;
  forwarded: number;
  forwardFailures: number;
  sdkIngested: number;
  sdkIngestFailures: number;
}

export type ObservabilityIngressPayload = ObserveSendPayload;

export interface Agent365RelayOptions {
  onIngressPayload?: (payload: ObservabilityIngressPayload) => void | Promise<void>;
}

export interface Agent365SdkConfig {
  enabled?: boolean;
  serviceName?: string;
  serviceVersion?: string;
  tenantId?: string;
  agentId?: string;
  agentName?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  clientId?: string;
  clientSecret?: string;
  maxQueueSize?: number;
}

export interface Agent365ModuleSettings {
  ingress?: {
    http?: Partial<Agent365IngressHttpConfig>;
    unixSocket?: Partial<Agent365IngressUnixConfig>;
  };
  forward?: Agent365ForwardConfig;
  sdk?: Agent365SdkConfig;
}

export interface Agent365ObservabilityModuleEntry {
  enabled?: boolean;
  transport?: "in-process" | "http" | "unix-socket";
  url?: string;
  socketName?: string;
  settings?: unknown;
}

export interface ResolvedAgent365ModuleConfig {
  moduleKey: string;
  entry?: Agent365ObservabilityModuleEntry;
  settings?: Agent365ModuleSettings;
}

export interface ResolvedAgent365RuntimeConfig {
  moduleKey: string;
  relay: Agent365RelayConfig;
  sdk: Required<Pick<Agent365SdkConfig, "enabled" | "serviceName" | "serviceVersion" | "maxQueueSize">>
    & Omit<Agent365SdkConfig, "enabled" | "serviceName" | "serviceVersion" | "maxQueueSize">;
}
