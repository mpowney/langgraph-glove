import type {
  ObservabilityConfig,
} from "@langgraph-glove/config";
import {
  ObserveDeliveryService,
  type ObservabilityOutboundEvent,
} from "@langgraph-glove/observe-server";
import type {
  Channel,
  OutgoingContentItem,
  OutgoingToolReference,
} from "../channels/Channel.js";
import { Logger } from "../logging/Logger.js";
import type { ToolEventMetadata } from "../rpc/RpcProtocol.js";
import {
  applyObservabilityPayloadExcludes,
  getActiveObservabilityModules,
  shouldEmitObservabilityEvent,
} from "./filtering.js";
import type { ObservabilityEvent } from "./types.js";

const logger = new Logger("ObservabilityMiddleware");

type EventSource = "agent" | "gateway";

export interface EmitObservabilityParams {
  conversationId: string;
  role: ObservabilityEvent["role"];
  text: string;
  source: EventSource;
  toolName?: string;
  toolEventMetadata?: ToolEventMetadata;
  contentItems?: OutgoingContentItem[];
  references?: OutgoingToolReference[];
  payload?: unknown;
  agentKey?: string;
}

export interface ObservabilityMiddlewareOptions {
  channels: Channel[];
  config?: ObservabilityConfig;
}

/**
 * Routes observability events to configured in-process modules/channels.
 *
 * Behavior is default-allow: when no module config exists, events are sent to
 * the provided channels as-is (legacy compatibility).
 */
export class ObservabilityMiddleware {
  private static readonly sharedRemoteServices = new Map<string, ObserveDeliveryService>();
  private readonly channelsByName: Map<string, Channel>;
  private readonly remoteDelivery?: ObserveDeliveryService;

  constructor(private readonly options: ObservabilityMiddlewareOptions) {
    this.channelsByName = new Map(options.channels.map((channel) => [channel.name, channel]));
    this.remoteDelivery = this.resolveSharedRemoteService(options.config);
  }

  emit(params: EmitObservabilityParams): void {
    const eventPayload = this.resolvePayload(params);
    const event: ObservabilityEvent = {
      eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: new Date().toISOString(),
      conversationId: params.conversationId,
      role: params.role,
      source: params.source,
      ...(params.toolName ? { toolName: params.toolName } : {}),
      ...(params.agentKey ? { agentKey: params.agentKey } : {}),
      ...(eventPayload !== undefined ? { payload: eventPayload } : {}),
    };

    const deliveries = this.resolveInProcessDeliveries(event);
    for (const delivery of deliveries) {
      const text = delivery.payload === undefined
        ? params.text
        : serializePayload(delivery.payload, params.text);

      delivery.channel
        .sendMessage({
          conversationId: params.conversationId,
          text,
          role: params.role,
          ...(params.toolName ? { toolName: params.toolName } : {}),
          ...(params.toolEventMetadata ? { toolEventMetadata: params.toolEventMetadata } : {}),
          ...(params.contentItems && params.contentItems.length > 0
            ? { contentItems: params.contentItems }
            : {}),
          ...(params.references && params.references.length > 0
            ? { references: params.references }
            : {}),
        })
        .catch((err: unknown) => {
          logger.error(
            `Failed to send observability message to channel "${delivery.channel.name}"`,
            err,
          );
        });
    }

    this.dispatchRemoteModules(event, params.text);
    void this.remoteDelivery?.flushDue().catch((err: unknown) => {
      logger.error("Failed to flush durable observability queue", err);
    });
  }

  private resolveInProcessDeliveries(event: ObservabilityEvent): Array<{ channel: Channel; payload: unknown }> {
    const config = this.options.config;
    if (config?.enabled === false) return [];

    const moduleKeys = getActiveObservabilityModules(config);
    if (moduleKeys.length === 0) {
      return this.options.channels.map((channel) => ({ channel, payload: event.payload }));
    }

    const deliveries: Array<{ channel: Channel; payload: unknown }> = [];
    const seenChannels = new Set<string>();

    for (const moduleKey of moduleKeys) {
      const moduleEntry = config?.modules?.[moduleKey];
      if (!moduleEntry || moduleEntry.enabled === false) continue;
      if ((moduleEntry.transport ?? "in-process") !== "in-process") continue;

      const channel = this.resolveChannelForModule(moduleKey);
      if (!channel) continue;
      if (seenChannels.has(channel.name)) continue;

      if (!shouldEmitObservabilityEvent(config, moduleKey, event)) continue;

      const payload = applyObservabilityPayloadExcludes(config, moduleKey, event);
      deliveries.push({ channel, payload });
      seenChannels.add(channel.name);
    }

    return deliveries;
  }

  private dispatchRemoteModules(event: ObservabilityEvent, fallbackText: string): void {
    const config = this.options.config;
    if (!config || config.enabled === false) return;

    const moduleKeys = getActiveObservabilityModules(config);
    for (const moduleKey of moduleKeys) {
      const moduleEntry = config.modules?.[moduleKey];
      if (!moduleEntry || moduleEntry.enabled === false) continue;
      if ((moduleEntry.transport ?? "in-process") === "in-process") continue;

      if (!shouldEmitObservabilityEvent(config, moduleKey, event)) continue;

      const payload = applyObservabilityPayloadExcludes(config, moduleKey, event);
      const outboundEvent: ObservabilityOutboundEvent = {
        eventId: event.eventId,
        timestamp: event.timestamp,
        conversationId: event.conversationId,
        role: event.role,
        source: event.source,
        text: payload === undefined ? fallbackText : serializePayload(payload, fallbackText),
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.agentKey ? { agentKey: event.agentKey } : {}),
        ...(payload !== undefined ? { payload } : {}),
      };

      void this.remoteDelivery?.send(moduleKey, outboundEvent).catch((err: unknown) => {
        logger.error(`Failed to send observability message to remote module "${moduleKey}"`, err);
      });
    }
  }

  private resolveChannelForModule(moduleKey: string): Channel | undefined {
    if (moduleKey === "web-channel") {
      return this.channelsByName.get("web");
    }
    if (moduleKey === "ui-observability") {
      return this.channelsByName.get("observability");
    }

    return this.channelsByName.get(moduleKey);
  }

  private resolvePayload(params: EmitObservabilityParams): unknown {
    if (params.payload !== undefined) return params.payload;
    return parseJsonMaybe(params.text);
  }

  private resolveSharedRemoteService(config: ObservabilityConfig | undefined): ObserveDeliveryService | undefined {
    if (!config || config.enabled === false) return undefined;
    const hasRemoteModule = Object.values(config.modules ?? {}).some(
      (module) => (module.transport ?? "in-process") !== "in-process",
    );
    if (!hasRemoteModule) return undefined;

    const serviceKey = config.queue?.dbPath ?? "__observe_no_queue__";
    const existing = ObservabilityMiddleware.sharedRemoteServices.get(serviceKey);
    if (existing) return existing;

    const created = new ObserveDeliveryService(config);
    ObservabilityMiddleware.sharedRemoteServices.set(serviceKey, created);
    return created;
  }
}

function parseJsonMaybe(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function serializePayload(payload: unknown, fallbackText: string): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return fallbackText;
  }
}
