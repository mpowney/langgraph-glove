import type { ObservabilityModuleEntry } from "@langgraph-glove/config";
import type { ObserveSendPayload, ObserveTransportClient } from "./types.js";

export class HttpObserveClient implements ObserveTransportClient {
  async send(
    _moduleKey: string,
    module: ObservabilityModuleEntry,
    payload: ObserveSendPayload,
  ): Promise<void> {
    if (!module.url) {
      throw new Error("HTTP observability module is missing url");
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(module.headers ?? {}),
    };
    if (module.authToken) {
      headers.authorization = `Bearer ${module.authToken}`;
    }

    const timeoutMs = module.delivery?.timeoutMs ?? 5000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(module.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
