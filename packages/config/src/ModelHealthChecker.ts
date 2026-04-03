import type { ModelRegistry } from "./ModelRegistry.js";

/** Outcome of a single model health probe. */
export interface ModelHealthResult {
  key: string;
  ok: boolean;
  /** Latency of the probe call in milliseconds. */
  latencyMs: number;
  /** Human-readable error message when `ok` is false. */
  error?: string;
}

/**
 * Probes one or more configured models at startup to verify connectivity,
 * authentication, and routing (e.g. correct `api-version`).
 *
 * @example
 * ```ts
 * const checker = new ModelHealthChecker(modelRegistry);
 *
 * // Check a single model:
 * const result = await checker.check("azure-kimi");
 *
 * // Check all registered models (runs concurrently):
 * const results = await checker.checkAll();
 * ```
 */
export class ModelHealthChecker {
  constructor(private readonly registry: ModelRegistry) {}

  /**
   * Probe one model by registry key.
   *
   * Sends a minimal prompt and expects any non-empty response.  A failed
   * network call, authentication error, or non-2xx HTTP response is reported
   * as `ok: false`.
   */
  async check(key: string): Promise<ModelHealthResult> {
    const start = Date.now();
    try {
      const model = this.registry.get(key);
      const response = await model.invoke([
        { role: "user", content: "Reply with the single word pong." },
      ]);
      const latencyMs = Date.now() - start;
      const text =
        typeof response.content === "string"
          ? response.content.trim()
          : Array.isArray(response.content)
            ? response.content
                .flatMap((block) =>
                  typeof block === "string"
                    ? block
                    : typeof (block as Record<string, unknown>).text === "string"
                      ? [(block as Record<string, unknown>).text as string]
                      : [],
                )
                .join("")
                .trim()
            : "";

      if (!text) {
        return { key, ok: false, latencyMs, error: "Empty response from model" };
      }
      return { key, ok: true, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const error =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unknown error";
      return { key, ok: false, latencyMs, error };
    }
  }

  /**
   * Probe every model key in the registry concurrently.
   *
   * Always resolves (never throws), so callers can decide how to handle
   * failures per-model.
   */
  async checkAll(): Promise<ModelHealthResult[]> {
    return Promise.all(this.registry.keys().map((key) => this.check(key)));
  }

  /**
   * Probe a specific subset of model keys concurrently.
   */
  async checkKeys(keys: string[]): Promise<ModelHealthResult[]> {
    return Promise.all(keys.map((key) => this.check(key)));
  }
}
