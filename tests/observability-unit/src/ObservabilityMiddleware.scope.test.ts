import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObservabilityConfig } from "@langgraph-glove/config";

const mockState = vi.hoisted(() => ({
  instances: [] as Array<{
    send: ReturnType<typeof vi.fn>;
    flushDue: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    config: unknown;
  }>,
}));

vi.mock("@langgraph-glove/observe-server", () => {
  class ObserveDeliveryService {
    public readonly send = vi.fn(async () => undefined);
    public readonly flushDue = vi.fn(async () => undefined);
    public readonly close = vi.fn();

    constructor(public readonly config: unknown) {
      mockState.instances.push(this);
    }
  }

  return { ObserveDeliveryService };
});

import { ObservabilityMiddleware } from "../../../packages/core/src/observability/ObservabilityMiddleware.js";

function buildConfig(modules: NonNullable<ObservabilityConfig["modules"]>): ObservabilityConfig {
  return {
    enabled: true,
    modules,
  };
}

describe("ObservabilityMiddleware scope routing", () => {
  beforeEach(() => {
    for (const instance of mockState.instances) {
      instance.send.mockClear();
      instance.flushDue.mockClear();
      instance.close.mockClear();
    }
  });

  it("detects scope support only when an active module opts in", () => {
    const middleware = new ObservabilityMiddleware({
      channels: [],
      config: buildConfig({
        "no-scope": {
          enabled: true,
          transport: "http",
          url: "http://127.0.0.1:9401/events",
        },
      }),
    });

    expect(middleware.areScopesEnabled()).toBe(false);

    const middlewareWithScope = new ObservabilityMiddleware({
      channels: [],
      config: buildConfig({
        "scope-http": {
          enabled: true,
          acceptsScopes: true,
          transport: "http",
          url: "http://127.0.0.1:9401/events",
        },
      }),
    });

    expect(middlewareWithScope.areScopesEnabled()).toBe(true);
  });

  it("ignores excluded scope-opted modules when checking areScopesEnabled", () => {
    const middleware = new ObservabilityMiddleware({
      channels: [],
      config: {
        enabled: true,
        exclude: {
          modules: ["scope-http"],
        },
        modules: {
          "scope-http": {
            enabled: true,
            acceptsScopes: true,
            transport: "http",
            url: "http://127.0.0.1:9401/events",
          },
        },
      },
    });

    expect(middleware.areScopesEnabled()).toBe(false);
  });

  it("routes emitScope only to remote modules that opt in with acceptsScopes", async () => {
    const middleware = new ObservabilityMiddleware({
      channels: [],
      config: buildConfig({
        "scope-http": {
          enabled: true,
          acceptsScopes: true,
          transport: "http",
          url: "http://127.0.0.1:9401/events",
        },
        "scope-unix": {
          enabled: true,
          acceptsScopes: true,
          transport: "unix-socket",
          socketName: "scope-socket",
        },
        "legacy-http": {
          enabled: true,
          transport: "http",
          url: "http://127.0.0.1:9500/events",
        },
        "scope-in-process": {
          enabled: true,
          acceptsScopes: true,
          transport: "in-process",
        },
      }),
    });

    expect(mockState.instances.length).toBeGreaterThan(0);

    const delivery = mockState.instances[mockState.instances.length - 1];

    middleware.emitScope({
      conversationId: "conv-1",
      source: "agent",
      scopeType: "InvokeAgent",
      toolName: "search",
      agentKey: "orchestrator",
      scope: {
        phase: "start",
      },
    });

    await Promise.resolve();

    expect(delivery.send).toHaveBeenCalledTimes(2);

    const moduleKeys = delivery.send.mock.calls.map((call) => call[0]);
    expect(moduleKeys).toEqual(["scope-http", "scope-unix"]);

    const outboundEvents = delivery.send.mock.calls.map((call) => call[1]);
    for (const event of outboundEvents) {
      expect(event.scopeType).toBe("InvokeAgent");
      expect(event.scope).toEqual({ phase: "start" });
      expect(event.role).toBe("system-event");
      expect(event.conversationId).toBe("conv-1");
      expect(event.toolName).toBe("search");
      expect(event.agentKey).toBe("orchestrator");
    }

    expect(delivery.flushDue).toHaveBeenCalledTimes(1);
  });
});
