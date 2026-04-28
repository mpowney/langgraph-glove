import {
  Agent365ExporterOptions,
  ObservabilityManager,
} from "@microsoft/agents-a365-observability";
import type { ObserveSendPayload } from "@langgraph-glove/observe-server";
import { createMsalTokenResolver } from "./msalTokenResolver.js";
import {
  Agent365SdkIngressTranslator,
  type Agent365SdkIdentityConfig,
} from "./sdkIngressTranslator.js";

export interface Agent365SdkBootstrapConfig {
  serviceName: string;
  serviceVersion: string;
  tenantId: string;
  agentId: string;
  agentName?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  clientId: string;
  clientSecret: string;
  maxQueueSize?: number;
}

export interface Agent365SdkHandle {
  shutdown: () => Promise<void>;
  ingest: (payload: ObserveSendPayload) => void;
}

/**
 * Starts official Agent365 Observability SDK with MSAL token resolver.
 *
 * This bootstrap is opt-in and can run alongside existing relay ingestion while
 * integration is migrated in phases.
 */
export async function startAgent365Sdk(
  config: Agent365SdkBootstrapConfig,
): Promise<Agent365SdkHandle> {
  if (!config.tenantId.trim()) {
    throw new Error("AGENT365 SDK bootstrap requires tenantId (set A365_TENANT_ID)");
  }
  if (!config.clientId.trim()) {
    throw new Error("AGENT365 SDK bootstrap requires clientId (set A365_CLIENT_ID)");
  }
  if (!config.agentId.trim()) {
    throw new Error("AGENT365 SDK bootstrap requires agentId (set A365_AGENT_ID)");
  }
  if (!config.clientSecret.trim()) {
    throw new Error("AGENT365 SDK bootstrap requires clientSecret (set A365_CLIENT_SECRET)");
  }

  const tokenResolver = createMsalTokenResolver({
    tenantId: config.tenantId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });

  const exporterOptions = new Agent365ExporterOptions();
  if (typeof config.maxQueueSize === "number" && Number.isFinite(config.maxQueueSize)) {
    exporterOptions.maxQueueSize = config.maxQueueSize;
  }

  const manager = ObservabilityManager.configure((builder) => builder
    .withService(config.serviceName, config.serviceVersion)
    .withExporterOptions(exporterOptions)
    .withTokenResolver(tokenResolver));

  const translator = new Agent365SdkIngressTranslator(toIdentity(config));

  manager.start();

  return {
    ingest: (payload: ObserveSendPayload) => {
      translator.ingest(payload);
    },
    shutdown: async () => {
      await manager.shutdown();
    },
  };
}

function toIdentity(config: Agent365SdkBootstrapConfig): Agent365SdkIdentityConfig {
  return {
    tenantId: config.tenantId,
    agentId: config.agentId,
    agentName: config.agentName,
    userId: config.userId,
    userName: config.userName,
    userEmail: config.userEmail,
  };
}
