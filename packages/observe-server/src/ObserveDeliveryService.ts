import type { ObservabilityConfig, ObservabilityModuleEntry } from "@langgraph-glove/config";
import { DurableObserveQueue } from "./DurableObserveQueue.js";
import { HttpObserveClient } from "./HttpObserveClient.js";
import { UnixSocketObserveClient } from "./UnixSocketObserveClient.js";
import type { ObserveSendPayload, ObserveTransportClient, ObservabilityOutboundEvent } from "./types.js";

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 10_000;
const DUE_BATCH_SIZE = 20;

export class ObserveDeliveryService {
  private readonly httpClient = new HttpObserveClient();
  private readonly unixClient = new UnixSocketObserveClient();
  private readonly queue?: DurableObserveQueue;
  private flushInFlight = false;

  constructor(private readonly config: ObservabilityConfig | undefined) {
    const dbPath = config?.queue?.dbPath;
    if (dbPath) {
      this.queue = new DurableObserveQueue(dbPath);
    }
  }

  close(): void {
    this.queue?.close();
  }

  async send(moduleKey: string, event: ObservabilityOutboundEvent): Promise<void> {
    const module = this.config?.modules?.[moduleKey];
    if (!module || module.enabled === false) return;

    const payload: ObserveSendPayload = { moduleKey, event };
    const client = this.resolveClient(module);

    if (!client) return;

    try {
      await client.send(moduleKey, module, payload);
    } catch (error) {
      if (module.delivery?.durableRetry === true && this.queue) {
        const firstAttempt = 1;
        const maxAttempts = this.getMaxAttempts(module);
        if (firstAttempt <= maxAttempts) {
          const nextAttemptAt = Date.now() + this.getBackoffMs(firstAttempt);
          this.queue.enqueue(
            moduleKey,
            JSON.stringify(payload),
            firstAttempt,
            nextAttemptAt,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      throw error;
    }

    void this.flushDue();
  }

  async flushDue(): Promise<void> {
    if (!this.queue || this.flushInFlight) return;
    this.flushInFlight = true;

    try {
      const rows = this.queue.listDue(Date.now(), DUE_BATCH_SIZE);
      for (const row of rows) {
        const module = this.config?.modules?.[row.moduleKey];
        if (!module || module.enabled === false) {
          this.queue.delete(row.id);
          continue;
        }

        const client = this.resolveClient(module);
        if (!client) {
          this.queue.delete(row.id);
          continue;
        }

        const maxAttempts = this.getMaxAttempts(module);
        try {
          const payload = JSON.parse(row.eventJson) as ObserveSendPayload;
          await client.send(row.moduleKey, module, payload);
          this.queue.delete(row.id);
        } catch (error) {
          const nextAttempt = row.attemptCount + 1;
          if (nextAttempt > maxAttempts) {
            this.queue.delete(row.id);
            continue;
          }

          const nextAttemptAt = Date.now() + this.getBackoffMs(nextAttempt);
          this.queue.markFailure(
            row.id,
            nextAttempt,
            nextAttemptAt,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      this.flushInFlight = false;
    }
  }

  private resolveClient(module: ObservabilityModuleEntry): ObserveTransportClient | undefined {
    const transport = module.transport ?? "in-process";
    if (transport === "http") return this.httpClient;
    if (transport === "unix-socket") return this.unixClient;
    return undefined;
  }

  private getMaxAttempts(module: ObservabilityModuleEntry): number {
    return module.delivery?.maxAttempts
      ?? this.config?.queue?.maxAttempts
      ?? DEFAULT_MAX_ATTEMPTS;
  }

  private getBackoffMs(attemptCount: number): number {
    const base = this.config?.queue?.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    const max = this.config?.queue?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const exponent = Math.max(0, attemptCount - 1);
    return Math.min(max, base * (2 ** exponent));
  }
}
