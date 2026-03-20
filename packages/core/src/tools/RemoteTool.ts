import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { RpcClient } from "../rpc/RpcClient";

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
}

/**
 * A LangGraph / LangChain `StructuredTool` that forwards invocations to a
 * remote tool server via an {@link RpcClient}.
 *
 * The RPC transport (Unix socket or HTTP) can be swapped at runtime by
 * providing a different `RpcClient` implementation — the tool itself is
 * transport-agnostic.
 *
 * @example
 * ```ts
 * const client = new HttpRpcClient("http://localhost:3001");
 * await client.connect();
 *
 * const weatherTool = new RemoteTool(client, {
 *   name: "weather",
 *   description: "Get the current weather for a location",
 *   schema: z.object({
 *     location: z.string().describe("City name or coordinates"),
 *     unit: z.enum(["celsius", "fahrenheit"]).optional(),
 *   }),
 * });
 * ```
 */
export class RemoteTool extends StructuredTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;

  constructor(
    private readonly rpcClient: RpcClient,
    config: RemoteToolConfig,
  ) {
    super();
    this.name = config.name;
    this.description = config.description;
    this.schema = config.schema;
  }

  protected async _call(input: Record<string, unknown>): Promise<string> {
    const result = await this.rpcClient.call(this.name, input);
    if (typeof result === "string") return result;
    return JSON.stringify(result);
  }
}
