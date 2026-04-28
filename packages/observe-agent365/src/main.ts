import path from "node:path";
import { Agent365Relay } from "./Agent365Relay.js";
import type { Agent365RelayConfig } from "./types.js";

function boolFromEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function numberFromEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function stringFromEnv(name: string, defaultValue: string): string {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}

function resolveSocketPath(raw: string): string {
  if (raw.includes("/")) return raw;
  return path.resolve(`/tmp/${raw}.sock`);
}

function loadConfigFromEnv(): Agent365RelayConfig {
  const ingressHttpEnabled = boolFromEnv("AGENT365_INGRESS_HTTP_ENABLED", true);
  const ingressUnixEnabled = boolFromEnv("AGENT365_INGRESS_UNIX_ENABLED", true);

  const forwardTransport = stringFromEnv("AGENT365_FORWARD_TRANSPORT", "none");
  const normalizedTransport = ((): "none" | "http" | "unix-socket" => {
    if (forwardTransport === "http" || forwardTransport === "unix-socket") {
      return forwardTransport;
    }
    return "none";
  })();

  return {
    ingress: {
      http: {
        enabled: ingressHttpEnabled,
        host: stringFromEnv("AGENT365_INGRESS_HTTP_HOST", "127.0.0.1"),
        port: numberFromEnv("AGENT365_INGRESS_HTTP_PORT", 9401),
        path: stringFromEnv("AGENT365_INGRESS_HTTP_PATH", "/events"),
      },
      unixSocket: {
        enabled: ingressUnixEnabled,
        socketPath: resolveSocketPath(stringFromEnv("AGENT365_INGRESS_UNIX_SOCKET", "agent365-ingress")),
      },
    },
    forward: {
      transport: normalizedTransport,
      http: {
        url: stringFromEnv("AGENT365_FORWARD_HTTP_URL", "http://127.0.0.1:9501/agent365/telemetry"),
        authToken: process.env["AGENT365_FORWARD_HTTP_AUTH_TOKEN"],
        timeoutMs: numberFromEnv("AGENT365_FORWARD_HTTP_TIMEOUT_MS", 5000),
      },
      unixSocket: {
        socketPath: resolveSocketPath(stringFromEnv("AGENT365_FORWARD_UNIX_SOCKET", "agent365-target")),
        timeoutMs: numberFromEnv("AGENT365_FORWARD_UNIX_TIMEOUT_MS", 5000),
      },
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const relay = new Agent365Relay(config);
  await relay.start();

  console.log("[observe-agent365] Relay started");

  const shutdown = async () => {
    console.log("[observe-agent365] Shutting down...");
    await relay.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error) => {
  console.error("[observe-agent365] Failed to start", error);
  process.exit(1);
});
