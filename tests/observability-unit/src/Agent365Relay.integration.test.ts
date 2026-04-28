import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ObserveSendPayload } from "@langgraph-glove/observe-server";
import { Agent365Relay } from "../../../packages/observe-agent365/src/Agent365Relay.js";

const resourcesToClose: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resourcesToClose.length > 0) {
    const close = resourcesToClose.pop();
    if (!close) continue;
    await close();
  }
});

describe("Agent365Relay integration", () => {
  it("continues forwarding when SDK ingest fails", async () => {
    const receivedByForwardTarget: ObserveSendPayload[] = [];
    const target = await startCaptureServer(async (payload) => {
      receivedByForwardTarget.push(payload);
    });
    resourcesToClose.push(target.close);

    const relayIngressPath = "/events";
    const relayIngressPort = await getAvailablePort();

    const relay = new Agent365Relay(
      {
        ingress: {
          http: {
            enabled: true,
            host: "127.0.0.1",
            port: relayIngressPort,
            path: relayIngressPath,
          },
          unixSocket: {
            enabled: false,
            socketPath: "/tmp/unused-agent365-relay.sock",
          },
        },
        forward: {
          transport: "http",
          http: {
            url: target.url,
            timeoutMs: 2000,
          },
        },
      },
      {
        onIngressPayload: async () => {
          throw new Error("synthetic sdk ingest failure");
        },
      },
    );
    resourcesToClose.push(async () => {
      await relay.stop();
    });

    await relay.start();

    const payload: ObserveSendPayload = {
      moduleKey: "agent365-http",
      event: {
        eventId: "evt-1",
        timestamp: new Date().toISOString(),
        conversationId: "conv-1",
        role: "system-event",
        source: "agent",
        text: "scope",
        scopeType: "InvokeAgent",
        scope: {
          phase: "start",
          scopeId: "invoke-1",
          input: "hello",
        },
      },
    };

    const ingressResponse = await fetch(
      `http://127.0.0.1:${relayIngressPort}${relayIngressPath}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    expect(ingressResponse.status).toBe(202);
    expect(receivedByForwardTarget).toEqual([payload]);

    const stats = relay.getStats();
    expect(stats.received).toBe(1);
    expect(stats.forwarded).toBe(1);
    expect(stats.forwardFailures).toBe(0);
    expect(stats.sdkIngested).toBe(0);
    expect(stats.sdkIngestFailures).toBe(1);
  });
});

async function startCaptureServer(
  onPayload: (payload: ObserveSendPayload) => Promise<void> | void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ObserveSendPayload;
    await onPayload(payload);
    res.statusCode = 202;
    res.end("accepted");
  });

  const port = await listenOnRandomPort(server);
  return {
    url: `http://127.0.0.1:${port}/forward`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function getAvailablePort(): Promise<number> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });

  const port = await listenOnRandomPort(server);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

async function listenOnRandomPort(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve ephemeral port");
  }
  return address.port;
}