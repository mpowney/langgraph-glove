import type { ModelRegistry } from "./ModelRegistry.js";

/** Outcome of a single model health probe. */
export interface ModelHealthResult {
  key: string;
  ok: boolean;
  /** Latency of the probe call in milliseconds. */
  latencyMs: number;
  /** Human-readable error message when `ok` is false. */
  error?: string;
  /** Context window in tokens when known (best-effort). */
  contextWindowTokens?: number;
  /** Source for detected context window. */
  contextWindowSource?: "config" | "ollama-show";
}

interface ContextWindowInfo {
  contextWindowTokens?: number;
  contextWindowSource?: "config" | "ollama-show";
}

const OLLAMA_SHOW_PROBE_TIMEOUT_MS = 4000;

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
    const entry = this.registry.resolveEntry(key);

    if (entry.provider === "ollama" && isLikelyVisionOrOcrModel(key, entry.model)) {
      return this.checkOllamaOcrModel(key, entry, start);
    }

    const contextWindow = await this.detectContextWindow(entry);
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
        return {
          key,
          ok: false,
          latencyMs,
          error: "Empty response from model",
          ...contextWindow,
        };
      }
      return { key, ok: true, latencyMs, ...contextWindow };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const error =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unknown error";
      return { key, ok: false, latencyMs, error, ...contextWindow };
    }
  }

  private async checkOllamaOcrModel(
    key: string,
    entry: ReturnType<ModelRegistry["resolveEntry"]>,
    start: number,
  ): Promise<ModelHealthResult> {
    const showResult = await probeOllamaShow(entry.model, entry.baseUrl);
    const latencyMs = Date.now() - start;

    if (!showResult.ok) {
      return {
        key,
        ok: false,
        latencyMs,
        error: showResult.error,
      };
    }

    const contextWindow = resolveContextWindowInfo(entry, showResult.payload);
    return {
      key,
      ok: true,
      latencyMs,
      ...contextWindow,
    };
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

  private async detectContextWindow(
    entry: ReturnType<ModelRegistry["resolveEntry"]>,
  ): Promise<ContextWindowInfo> {
    if (entry.contextWindowTokens) {
      return {
        contextWindowTokens: entry.contextWindowTokens,
        contextWindowSource: "config",
      };
    }

    if (entry.provider === "ollama") {
      const inferred = await inferOllamaContextWindow(entry.model, entry.baseUrl);
      if (inferred) {
        return {
          contextWindowTokens: inferred,
          contextWindowSource: "ollama-show",
        };
      }
    }

    return {};
  }
}

function isLikelyVisionOrOcrModel(key: string, model: string): boolean {
  const combined = `${key} ${model}`.toLowerCase();
  return (
    combined.includes("ocr")
    || combined.includes("vision")
    || combined.includes("llava")
  );
}

function resolveContextWindowInfo(
  entry: ReturnType<ModelRegistry["resolveEntry"]>,
  showPayload?: unknown,
): ContextWindowInfo {
  if (entry.contextWindowTokens) {
    return {
      contextWindowTokens: entry.contextWindowTokens,
      contextWindowSource: "config",
    };
  }

  const inferred = parseContextWindowFromShowResponse(showPayload);
  if (inferred) {
    return {
      contextWindowTokens: inferred,
      contextWindowSource: "ollama-show",
    };
  }

  return {};
}

async function probeOllamaShow(
  model: string,
  baseUrl?: string,
): Promise<{ ok: true; payload: unknown } | { ok: false; error: string }> {
  const root = (baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
  const url = `${root}/api/show`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_SHOW_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return {
        ok: false,
        error: `Ollama show probe failed status=${response.status} model=${model}`,
      };
    }

    const payload = (await response.json()) as unknown;
    return { ok: true, payload };
  } catch (err) {
    clearTimeout(timeout);
    const error =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Unknown error";
    return {
      ok: false,
      error: `Ollama show probe failed model=${model}: ${error}`,
    };
  }
}

function parseContextWindowFromShowResponse(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;

  const details = obj["details"];
  if (details && typeof details === "object") {
    const maybeDetails = details as Record<string, unknown>;
    const direct = maybeDetails["context_length"];
    if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
      return Math.floor(direct);
    }
  }

  const modelInfo = obj["model_info"];
  if (modelInfo && typeof modelInfo === "object") {
    const maybeInfo = modelInfo as Record<string, unknown>;
    for (const [key, value] of Object.entries(maybeInfo)) {
      if (!key.toLowerCase().includes("context_length")) continue;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
      if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    }
  }

  return undefined;
}

async function inferOllamaContextWindow(
  model: string,
  baseUrl?: string,
): Promise<number | undefined> {
  const root = (baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
  const url = `${root}/api/show`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as unknown;
    return parseContextWindowFromShowResponse(payload);
  } catch {
    return undefined;
  }
}
