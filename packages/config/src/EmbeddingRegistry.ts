import type { Embeddings } from "@langchain/core/embeddings";
import { OpenAIEmbeddings } from "@langchain/openai";
import { OllamaEmbeddings } from "@langchain/ollama";
import { resolveConfigEntry } from "./ConfigLoader.js";
import type { ModelEntry, ModelProvider, ModelsConfig } from "./schemas.js";

/**
 * Creates LangChain embedding models from the centralised `models.json` config.
 *
 * The registry mirrors ModelRegistry, but only supports providers that expose
 * embedding APIs. Chat-only providers are rejected explicitly.
 */
export class EmbeddingRegistry {
  private readonly cache = new Map<string, Embeddings>();

  constructor(private readonly modelsConfig: ModelsConfig) {}

  get(key: string = "default"): Embeddings {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const entry = resolveConfigEntry(
      this.modelsConfig as Record<string, ModelEntry>,
      key,
    );
    const embeddings = this.createEmbeddings(entry);
    this.cache.set(key, embeddings);
    return embeddings;
  }

  keys(): string[] {
    return Object.keys(this.modelsConfig);
  }

  private createEmbeddings(entry: ModelEntry): Embeddings {
    const { provider, model, apiKey, baseUrl } = entry;

    const factory = EMBEDDING_FACTORIES[provider];
    if (!factory) {
      throw new Error(
        `Unsupported embedding provider: "${provider}". ` +
          `Supported: ${Object.keys(EMBEDDING_FACTORIES).join(", ")}`,
      );
    }
    return factory(model, apiKey, baseUrl);
  }
}

type EmbeddingFactory = (
  model: string,
  apiKey?: string,
  baseUrl?: string,
) => Embeddings;

const EMBEDDING_FACTORIES: Partial<Record<ModelProvider, EmbeddingFactory>> = {
  openai: (model, apiKey, baseUrl) => {
    const opts: Record<string, unknown> = { model };
    if (apiKey) opts.apiKey = apiKey;
    if (baseUrl) opts.configuration = { baseURL: baseUrl };
    return new OpenAIEmbeddings(opts);
  },

  ollama: (model, _apiKey, baseUrl) => {
    return new OllamaEmbeddings({
      model,
      baseUrl: baseUrl ?? "http://localhost:11434",
    });
  },

  "openai-compatible": (model, apiKey, baseUrl) => {
    if (!baseUrl) {
      throw new Error('Embedding provider "openai-compatible" requires a baseUrl');
    }
    const opts: Record<string, unknown> = {
      model,
      configuration: { baseURL: baseUrl },
    };
    if (apiKey) opts.apiKey = apiKey;
    return new OpenAIEmbeddings(opts);
  },
};
