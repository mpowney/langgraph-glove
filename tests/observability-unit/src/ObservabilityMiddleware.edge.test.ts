import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("ObservabilityMiddleware scope edge cases", () => {
  beforeEach(() => {
    for (const instance of mockState.instances) {
      instance.send.mockClear();
      instance.flushDue.mockClear();
      instance.close.mockClear();
    }
  });

  it("does not enable scopes when observability is disabled", () => {
    const middleware = new ObservabilityMiddleware({
      channels: [],
      config: {
        enabled: false,
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

  it("does not create remote delivery service for in-process-only modules", () => {
    const countBefore = mockState.instances.length;

    const middleware = new ObservabilityMiddleware({
      channels: [],
      config: {
        enabled: true,
        modules: {
          "scope-in-process": {
            enabled: true,
            acceptsScopes: true,
            transport: "in-process",
          },
        },
      },
    });

    expect(middleware.areScopesEnabled()).toBe(true);
    expect(mockState.instances.length).toBe(countBefore);

    middleware.emitScope({
      conversationId: "conv-in-process",
      source: "agent",
      scopeType: "InvokeAgent",
      scope: { phase: "start" },
    });
  });

  it("does not route scopes when no module opts in", async () => {
    const middleware = new ObservabilityMiddleware({
      channels: [],
      config: {
        enabled: true,
        modules: {
          "legacy-http": {
            enabled: true,
            transport: "http",
            url: "http://127.0.0.1:9401/events",
          },
        },
      },
    });

    const delivery = mockState.instances[mockState.instances.length - 1];

    middleware.emitScope({
      conversationId: "conv-no-optin",
      source: "agent",
      scopeType: "Inference",
      scope: { phase: "request" },
    });

    await Promise.resolve();

    expect(delivery.send).not.toHaveBeenCalled();
    expect(delivery.flushDue).toHaveBeenCalledTimes(1);
  });
});
