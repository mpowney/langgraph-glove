import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgent365RuntimeConfig } from "../../../packages/observe-agent365/src/runtimeConfig.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadAgent365RuntimeConfig", () => {
  it("loads launched module settings from observability config and resolves secrets", () => {
    const root = createTempWorkspace();
    const configDir = path.join(root, "config");
    const secretsDir = path.join(root, "secrets");

    writeJson(path.join(configDir, "observability.json"), {
      enabled: true,
      modules: {
        "agent365-http": {
          enabled: true,
          transport: "http",
          url: "http://127.0.0.1:9401/events",
          settings: {
            forward: {
              transport: "http",
              http: {
                url: "http://127.0.0.1:9501/agent365/telemetry",
                authToken: "{SECRET:agent365ForwardToken}",
                timeoutMs: 7000,
              },
            },
            sdk: {
              enabled: true,
              tenantId: "{SECRET:agent365TenantId}",
              agentId: "{SECRET:agent365AgentId}",
              userEmail: "{SECRET:agent365UserEmail}",
              clientId: "{SECRET:agent365ClientId}",
              clientSecret: "{SECRET:agent365ClientSecret}",
            },
          },
        },
      },
    });

    writeJson(path.join(secretsDir, "agent365.json"), {
      agent365ForwardToken: "forward-token",
      agent365TenantId: "tenant-1",
      agent365AgentId: "agent-1",
      agent365UserEmail: "user@example.com",
      agent365ClientId: "client-1",
      agent365ClientSecret: "secret-1",
    });

    const resolved = loadAgent365RuntimeConfig({
      OBSERVE_MODULE: "agent365-http",
      GLOVE_CONFIG_DIR: configDir,
      GLOVE_SECRETS_DIR: secretsDir,
    });

    expect(resolved.moduleKey).toBe("agent365-http");
    expect(resolved.relay.ingress.http).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 9401,
      path: "/events",
    });
    expect(resolved.relay.ingress.unixSocket.enabled).toBe(false);
    expect(resolved.relay.forward).toMatchObject({
      transport: "http",
      http: {
        url: "http://127.0.0.1:9501/agent365/telemetry",
        authToken: "forward-token",
        timeoutMs: 7000,
      },
    });
    expect(resolved.sdk).toMatchObject({
      enabled: true,
      tenantId: "tenant-1",
      agentId: "agent-1",
      userEmail: "user@example.com",
      clientId: "client-1",
      clientSecret: "secret-1",
    });
  });

  it("supports package-local config files with env overrides", () => {
    const root = createTempWorkspace();
    const secretsDir = path.join(root, "secrets");
    const configFile = path.join(root, "agent365.config.json");

    writeJson(configFile, {
      moduleKey: "agent365-local",
      ingress: {
        http: {
          enabled: false,
          host: "127.0.0.1",
          port: 9402,
          path: "/ingress",
        },
        unixSocket: {
          enabled: true,
          socketPath: "agent365-local",
        },
      },
      sdk: {
        enabled: true,
        tenantId: "{SECRET:tenant}",
        agentId: "agent-local",
        clientId: "client-local",
        clientSecret: "{SECRET:clientSecret}",
      },
    });

    writeJson(path.join(secretsDir, "local.json"), {
      tenant: "tenant-local",
      clientSecret: "secret-local",
    });

    const resolved = loadAgent365RuntimeConfig({
      AGENT365_CONFIG_FILE: configFile,
      GLOVE_SECRETS_DIR: secretsDir,
      AGENT365_FORWARD_TRANSPORT: "http",
      AGENT365_FORWARD_HTTP_URL: "http://127.0.0.1:9600/forward",
      AGENT365_INGRESS_HTTP_ENABLED: "true",
      A365_USER_NAME: "Configured User",
    });

    expect(resolved.moduleKey).toBe("agent365-local");
    expect(resolved.relay.ingress.http.enabled).toBe(true);
    expect(resolved.relay.ingress.http.port).toBe(9402);
    expect(resolved.relay.ingress.unixSocket.socketPath).toContain("agent365-local");
    expect(resolved.relay.forward).toMatchObject({
      transport: "http",
      http: {
        url: "http://127.0.0.1:9600/forward",
      },
    });
    expect(resolved.sdk).toMatchObject({
      enabled: true,
      tenantId: "tenant-local",
      agentId: "agent-local",
      clientId: "client-local",
      clientSecret: "secret-local",
      userName: "Configured User",
    });
  });
});

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent365-runtime-config-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}