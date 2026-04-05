import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import { resolveConfigEntry } from "./ConfigLoader";
import type { ModelsConfig, ModelEntry, ModelProvider } from "./schemas";

/**
 * Creates LangChain chat models from the centralised `models.json` config.
 *
 * The registry holds the parsed models config and instantiates models on
 * demand, keyed by their config name (e.g. `"default"`, `"fast"`, `"local"`).
 *
 * Each config entry is deep-merged over the `default` entry, so you only need
 * to specify the fields that differ.
 *
 * @example
 * ```ts
 * const registry = new ModelRegistry(config.models);
 * const main   = registry.get();           // uses "default"
 * const fast   = registry.get("fast");     // merges "fast" over "default"
 * const local  = registry.get("local");    // merges "local" over "default"
 * ```
 */
export class ModelRegistry {
  private readonly cache = new Map<string, BaseChatModel>();

  constructor(private readonly modelsConfig: ModelsConfig) {}

  /**
   * Get (or create) a chat model for the given config key.
   * Results are cached — the same key always returns the same instance.
   */
  get(key: string = "default"): BaseChatModel {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const entry = resolveConfigEntry(
      this.modelsConfig as Record<string, ModelEntry>,
      key,
    );
    const model = this.createModel(entry);
    this.cache.set(key, model);
    return model;
  }

  /** List all available model config keys. */
  keys(): string[] {
    return Object.keys(this.modelsConfig);
  }

  /** Resolve and return the effective model entry for a key. */
  resolveEntry(key: string = "default"): ModelEntry {
    return resolveConfigEntry(
      this.modelsConfig as Record<string, ModelEntry>,
      key,
    );
  }

  private createModel(entry: ModelEntry): BaseChatModel {
    const { provider, model, apiKey, baseUrl, temperature, apiVersion, think, keepAlive } = entry;
    const temp = temperature ?? 0;

    const factory = MODEL_FACTORIES[provider];
    if (!factory) {
      throw new Error(
        `Unsupported model provider: "${provider}". ` +
          `Supported: ${Object.keys(MODEL_FACTORIES).join(", ")}`,
      );
    }
    return factory(model, temp, apiKey, baseUrl, apiVersion, think, keepAlive);
  }
}

// ---------------------------------------------------------------------------
// Per-provider factory functions
// ---------------------------------------------------------------------------

type ModelFactory = (
  model: string,
  temperature: number,
  apiKey?: string,
  baseUrl?: string,
  apiVersion?: string,
  think?: boolean,
  keepAlive?: string | number,
) => BaseChatModel;

const MODEL_FACTORIES: Record<ModelProvider, ModelFactory> = {
  openai: (model, temperature, apiKey, baseUrl) => {
    const opts: Record<string, unknown> = { model, temperature };
    if (apiKey) opts.apiKey = apiKey;
    if (baseUrl) opts.configuration = { baseURL: baseUrl };
    return new ChatOpenAI(opts);
  },

  anthropic: (model, temperature, apiKey, baseUrl) => {
    const opts: Record<string, unknown> = { model, temperature };
    if (apiKey) opts.anthropicApiKey = apiKey;
    if (baseUrl) opts.anthropicApiUrl = baseUrl;
    return new ChatAnthropic(opts);
  },

  google: (model, temperature, apiKey, baseUrl) => {
    const opts: ConstructorParameters<typeof ChatGoogleGenerativeAI>[0] = { model, temperature };
    if (apiKey) opts.apiKey = apiKey;
    if (baseUrl) opts.baseUrl = baseUrl;
    return new ChatGoogleGenerativeAI(opts);
  },

  ollama: (model, temperature, _apiKey, baseUrl, _apiVersion, think, keepAlive) => {
    const opts: ConstructorParameters<typeof ChatOllama>[0] = {
      model,
      temperature,
      baseUrl: baseUrl ?? "http://localhost:11434",
    };
    if (think !== undefined) opts.think = think;
    if (keepAlive !== undefined) opts.keepAlive = keepAlive;
    return new ChatOllama(opts);
  },

  "openai-compatible": (model, temperature, apiKey, baseUrl, apiVersion) => {
    if (!baseUrl) {
      throw new Error('Provider "openai-compatible" requires a baseUrl');
    }
    const configuration: Record<string, unknown> = { baseURL: baseUrl };
    if (apiVersion) configuration.defaultQuery = { "api-version": apiVersion };
    const opts: Record<string, unknown> = { model, temperature, configuration };
    if (apiKey) opts.apiKey = apiKey;
    return new ChatOpenAI(opts);
  },
};
