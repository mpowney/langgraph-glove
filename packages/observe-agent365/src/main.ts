import { Agent365Relay } from "./Agent365Relay.js";
import { loadAgent365RuntimeConfig } from "./runtimeConfig.js";
import { startAgent365Sdk } from "./sdkBootstrap.js";

async function main(): Promise<void> {
  const runtimeConfig = loadAgent365RuntimeConfig();
  const sdkHandle = runtimeConfig.sdk.enabled
    ? await startAgent365Sdk({
        serviceName: runtimeConfig.sdk.serviceName,
        serviceVersion: runtimeConfig.sdk.serviceVersion,
        tenantId: runtimeConfig.sdk.tenantId ?? "",
        agentId: runtimeConfig.sdk.agentId ?? "",
        agentName: runtimeConfig.sdk.agentName,
        userId: runtimeConfig.sdk.userId,
        userName: runtimeConfig.sdk.userName,
        userEmail: runtimeConfig.sdk.userEmail,
        clientId: runtimeConfig.sdk.clientId ?? "",
        clientSecret: runtimeConfig.sdk.clientSecret ?? "",
        maxQueueSize: runtimeConfig.sdk.maxQueueSize,
      })
    : undefined;

  const relay = new Agent365Relay(runtimeConfig.relay, {
    onIngressPayload: sdkHandle
      ? (payload) => {
          sdkHandle.ingest(payload);
        }
      : undefined,
  });
  await relay.start();

  console.log(`[observe-agent365] Relay started for module ${runtimeConfig.moduleKey}`);

  const shutdown = async () => {
    console.log("[observe-agent365] Shutting down...");
    await relay.stop();
    await sdkHandle?.shutdown();
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
