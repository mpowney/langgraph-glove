import { StructuredTool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";
import { z } from "zod";
import type { RpcClient } from "../rpc/RpcClient";
import type { ToolMetadata } from "../rpc/RpcProtocol";

const DEFAULT_MAX_INLINE_TOOL_RESULT_BYTES = 2_000_000;

function maxInlineToolResultBytes(): number {
  const raw = process.env["GLOVE_MAX_INLINE_TOOL_RESULT_BYTES"];
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_INLINE_TOOL_RESULT_BYTES;
}

function utf8Size(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function maybeCompactLargePayload(result: unknown, maxBytes: number): string | null {
  if (typeof result === "string") {
    const size = utf8Size(result);
    if (size <= maxBytes) return null;
    return JSON.stringify({
      truncated: true,
      reason: "tool_result_exceeded_max_inline_bytes",
      maxInlineBytes: maxBytes,
      originalSizeBytes: size,
      preview: result.slice(0, 800),
    });
  }

  if (!result || typeof result !== "object") return null;
  const objectResult = result as Record<string, unknown>;
  if (typeof objectResult["data"] !== "string") return null;

  const data = objectResult["data"] as string;
  const payloadSize = utf8Size(data);
  if (payloadSize <= maxBytes) return null;

  const compact = {
    ...objectResult,
    data: "[omitted: oversized base64 payload]",
    omittedData: true,
    dataSizeBytes: payloadSize,
    maxInlineBytes: maxBytes,
  };
  return JSON.stringify(compact);
}

/** Configuration passed when constructing a {@link RemoteTool}. */
export interface RemoteToolConfig {
  /** Unique name for the tool — must match the name registered on the server. */
  name: string;
  /** Human-readable description given to the LLM to describe when to use the tool. */
  description: string;
  /**
   * Zod schema describing the tool's input parameters.
   * Used by LangGraph for structured function-calling.
   */
  schema: z.ZodObject<z.ZodRawShape>;
  /**
   * When true, privileged context (conversationId / privilegeGrantId) is
   * injected from LangGraph configurable at execution time.
   */
  requiresPrivilegedAccess?: boolean;
}

// ---------------------------------------------------------------------------
// JSON Schema → Zod helpers
// ---------------------------------------------------------------------------

function jsonSchemaPropToZod(prop: Record<string, unknown>, isRequired: boolean): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  if (Array.isArray(prop["enum"])) {
    const values = prop["enum"] as [string, ...string[]];
    schema = z.enum(values);
  } else if (prop["type"] === "string") {
    schema = z.string();
  } else if (prop["type"] === "number" || prop["type"] === "integer") {
    schema = z.number();
  } else if (prop["type"] === "boolean") {
    schema = z.boolean();
  } else if (prop["type"] === "array") {
    const items = (prop["items"] as Record<string, unknown> | undefined) ?? {};
    schema = z.array(jsonSchemaPropToZod(items, true));
  } else if (prop["type"] === "object") {
    schema = jsonSchemaToZodObject(prop);
  } else {
    schema = z.unknown();
  }

  if (typeof prop["description"] === "string") {
    schema = (schema as z.ZodTypeAny & { describe(s: string): z.ZodTypeAny }).describe(
      prop["description"],
    );
  }

  return isRequired ? schema : schema.optional();
}

/**
 * Convert a JSON Schema object (as returned by `ToolMetadata.parameters`)
 * to a Zod object schema suitable for use in a {@link RemoteTool}.
 *
 * Supports: `string`, `number`, `integer`, `boolean`, `object`, `array`, `enum`.
 */
export function jsonSchemaToZodObject(schema: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  const properties = (schema["properties"] as Record<string, Record<string, unknown>>) ?? {};
  const required = (schema["required"] as string[]) ?? [];

  const shape: z.ZodRawShape = {};
  for (const [key, prop] of Object.entries(properties)) {
    shape[key] = jsonSchemaPropToZod(prop, required.includes(key));
  }

  return z.object(shape);
}

/**
 * A LangGraph / LangChain `StructuredTool` that forwards invocations to a
 * remote tool server via an {@link RpcClient}.
 *
 * The RPC transport (Unix socket or HTTP) can be swapped at runtime by
 * providing a different `RpcClient` implementation — the tool itself is
 * transport-agnostic.
 *
 * ## Manual construction
 * ```ts
 * const client = new HttpRpcClient("http://localhost:3001");
 * await client.connect();
 *
 * const weatherTool = new RemoteTool(client, {
 *   name: "weather_au",
 *   description: "Get the current weather for an Australian location",
 *   schema: z.object({
 *     location: z.string().describe("City name"),
 *     unit: z.enum(["celsius", "fahrenheit"]).optional(),
 *   }),
 * });
 * ```
 *
 * ## Auto-discovery from the server
 * ```ts
 * const tools = await RemoteTool.fromServer(client);
 * // Returns one RemoteTool per tool registered on the server,
 * // with name, description and schema derived from server metadata.
 * ```
 */
export class RemoteTool extends StructuredTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly requiresPrivilegedAccess: boolean;

  constructor(
    private readonly rpcClient: RpcClient,
    config: RemoteToolConfig,
  ) {
    super();
    this.name = config.name;
    this.description = config.description;
    this.schema = config.schema;
    this.requiresPrivilegedAccess = config.requiresPrivilegedAccess ?? false;
  }

  protected async _call(
    input: Record<string, unknown>,
    _runManager?: CallbackManagerForToolRun,
    config?: RunnableConfig,
  ): Promise<string> {
    const args = { ...input };

    // If this tool's schema declares a `personalToken` parameter and one was
    // not supplied by the LLM, inject it from the LangGraph configurable so
    // the browser-side personal token flows through automatically.
    if (
      "personalToken" in this.schema.shape &&
      typeof config?.configurable === "object" &&
      config.configurable !== null &&
      typeof (config.configurable as Record<string, unknown>).personalToken === "string"
    ) {
      args.personalToken = (config.configurable as Record<string, unknown>).personalToken;
    }

    if (
      this.requiresPrivilegedAccess &&
      typeof config?.configurable === "object" &&
      config.configurable !== null &&
      typeof (config.configurable as Record<string, unknown>).privilegeGrantId === "string"
    ) {
      args.privilegeGrantId = (config.configurable as Record<string, unknown>).privilegeGrantId;
    }

    if (
      this.requiresPrivilegedAccess &&
      typeof config?.configurable === "object" &&
      config.configurable !== null
    ) {
      const typed = config.configurable as Record<string, unknown>;
      const explicitConversationId =
        typeof typed.conversationId === "string" ? typed.conversationId : undefined;
      const threadId = typeof typed.thread_id === "string" ? typed.thread_id : undefined;
      const resolvedConversationId =
        explicitConversationId ?? (threadId === "runtime" ? undefined : threadId);

      if (resolvedConversationId) {
        args.conversationId = resolvedConversationId;
      }
    }

    const result = await this.rpcClient.call(this.name, args);

    const maxBytes = maxInlineToolResultBytes();
    const compact = maybeCompactLargePayload(result, maxBytes);
    if (compact) return compact;

    if (typeof result === "string") return result;
    const serialized = JSON.stringify(result);
    if (utf8Size(serialized) <= maxBytes) return serialized;
    return JSON.stringify({
      truncated: true,
      reason: "serialized_tool_result_exceeded_max_inline_bytes",
      maxInlineBytes: maxBytes,
      originalSizeBytes: utf8Size(serialized),
    });
  }

  /**
   * Discover all tools registered on the remote server and return a
   * `RemoteTool` for each one.
   *
   * Calls the `__introspect__` RPC method (via {@link RpcClient.listTools})
   * and converts each tool's JSON Schema `parameters` to a Zod schema
   * using {@link jsonSchemaToZodObject}.
   *
   * @param client - An already-connected {@link RpcClient}.
   * @returns One `RemoteTool` per tool registered on the server.
   */
  static async fromServer(client: RpcClient): Promise<RemoteTool[]> {
    const tools: ToolMetadata[] = await client.listTools();
    return tools.map(
      (meta) =>
        new RemoteTool(client, {
          name: meta.name,
          description: meta.description,
          schema: jsonSchemaToZodObject(meta.parameters),
          requiresPrivilegedAccess: meta.requiresPrivilegedAccess,
        }),
    );
  }
}

