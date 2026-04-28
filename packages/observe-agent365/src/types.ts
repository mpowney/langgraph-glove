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
}

export type ObservabilityIngressPayload = ObserveSendPayload;
