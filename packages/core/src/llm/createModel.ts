import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";

/**
 * The LLM backend to use.
 * Controlled by the `LLM_PROVIDER` environment variable.
 * - `"openai"` (default) — OpenAI ChatCompletion API
 * - `"ollama"` — locally-hosted Ollama instance
 */
export type LlmProvider = "openai" | "ollama";

export interface CreateModelOptions {
  /**
   * Override the provider.  Defaults to the `LLM_PROVIDER` env var,
   * falling back to `"openai"` if that is not set.
   */
  provider?: LlmProvider;

  // ── OpenAI options ────────────────────────────────────────────────────────

  /**
   * OpenAI model name.
   * Defaults to the `OPENAI_MODEL` env var, then `"gpt-4o-mini"`.
   */
  openaiModel?: string;

  /**
   * OpenAI API key.
   * Defaults to the `OPENAI_API_KEY` env var.
   */
  openaiApiKey?: string;

  // ── Ollama options ────────────────────────────────────────────────────────

  /**
   * Ollama model name (e.g. `"llama3.2"`, `"qwen2.5:7b"`, `"mistral"`).
   * Defaults to the `OLLAMA_MODEL` env var, then `"llama3.2"`.
   */
  ollamaModel?: string;

  /**
   * Base URL of the Ollama server.
   * Defaults to the `OLLAMA_URL` env var, then `"http://localhost:11434"`.
   */
  ollamaBaseUrl?: string;

  // ── Shared options ────────────────────────────────────────────────────────

  /**
   * Sampling temperature (0 = deterministic, 1 = creative).
   * Defaults to `0`.
   */
  temperature?: number;
}

/**
 * Factory that creates a LangChain chat model from environment variables
 * or explicit options.
 *
 * ## Environment variables
 *
 * | Variable          | Description                                    | Default              |
 * |---|---|---|
 * | `LLM_PROVIDER`    | `openai` or `ollama`                           | `openai`             |
 * | `OPENAI_API_KEY`  | OpenAI secret key                              | *(required)*         |
 * | `OPENAI_MODEL`    | OpenAI model name                              | `gpt-4o-mini`        |
 * | `OLLAMA_URL`      | Ollama server base URL                         | `http://localhost:11434` |
 * | `OLLAMA_MODEL`    | Ollama model name                              | `llama3.2`           |
 *
 * @example Using OpenAI (default)
 * ```ts
 * // OPENAI_API_KEY=sk-... in environment
 * const model = createModel();
 * ```
 *
 * @example Using Ollama
 * ```ts
 * // OLLAMA_URL=http://192.168.1.50:11434  OLLAMA_MODEL=qwen2.5:7b
 * const model = createModel({ provider: "ollama" });
 * ```
 *
 * @example Explicit options (override env)
 * ```ts
 * const model = createModel({
 *   provider: "ollama",
 *   ollamaBaseUrl: "http://my-server:11434",
 *   ollamaModel: "mistral",
 *   temperature: 0.2,
 * });
 * ```
 */
export function createModel(options: CreateModelOptions = {}): BaseChatModel {
  const provider: LlmProvider =
    options.provider ??
    ((process.env["LLM_PROVIDER"] ?? "openai").toLowerCase() as LlmProvider);

  const temperature = options.temperature ?? 0;

  if (provider === "ollama") {
    const baseUrl =
      options.ollamaBaseUrl ??
      process.env["OLLAMA_URL"] ??
      "http://localhost:11434";

    const model =
      options.ollamaModel ??
      process.env["OLLAMA_MODEL"] ??
      "llama3.2";

    return new ChatOllama({ baseUrl, model, temperature });
  }

  // Default: OpenAI
  const model =
    options.openaiModel ??
    process.env["OPENAI_MODEL"] ??
    "gpt-4o-mini";

  const apiKey =
    options.openaiApiKey ??
    process.env["OPENAI_API_KEY"];

  return new ChatOpenAI({ model, temperature, apiKey });
}
