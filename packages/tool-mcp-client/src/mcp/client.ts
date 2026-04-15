import { randomUUID } from "node:crypto";
import type { AuthProvider } from "./auth.js";

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: string | number;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface McpTextContent {
  type: string;
  text?: string;
}

interface McpListToolsResult {
  tools?: Array<{
    name?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

interface McpCallToolResult {
  content?: McpTextContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpClientOptions {
  endpoint: string;
  requestTimeoutMs?: number;
  customHeaders?: Record<string, string>;
  authProvider?: AuthProvider;
}

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_TIMEOUT_MS = 20_000;

export class McpClient {
  private initialized = false;

  constructor(private readonly options: McpClientOptions) {}

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    await this.ensureInitialized();
    const response = await this.callRpc<McpListToolsResult>("tools/list", {});
    const tools = response.tools ?? [];

    return tools
      .filter((tool) => typeof tool.name === "string" && tool.name.length > 0)
      .map((tool) => ({
        name: tool.name as string,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : {
              type: "object",
              properties: {},
            },
      }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const result = await this.callRpc<McpCallToolResult>("tools/call", {
      name,
      arguments: args,
    });

    if (result.isError) {
      throw new Error(this.extractText(result.content) || `MCP tool call failed: ${name}`);
    }

    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }

    const text = this.extractText(result.content);
    if (text) return text;

    return result;
  }

  private extractText(content?: McpTextContent[]): string {
    if (!Array.isArray(content)) return "";
    const lines: string[] = [];
    for (const item of content) {
      if (item?.type === "text" && typeof item.text === "string") {
        lines.push(item.text);
      }
    }
    return lines.join("\n").trim();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await this.callRpc("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "langgraph-glove-tool-mcp-client",
        version: "0.1.0",
      },
    });

    await this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.postJson({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private async callRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = randomUUID();
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const response = await this.postJson(payload);
    const parsed = response as JsonRpcResponse<T>;
    if (parsed.error) {
      throw new Error(`MCP error (${method}): ${parsed.error.message ?? "unknown error"}`);
    }
    if (parsed.result === undefined) {
      throw new Error(`MCP error (${method}): missing result`);
    }
    return parsed.result;
  }

  private async postJson(payload: Record<string, unknown>): Promise<unknown> {
    const { url, headers } = await this.buildRequestContext();
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`MCP HTTP ${response.status}: ${bodyText || response.statusText}`);
      }

      if (!bodyText) return {};

      try {
        return JSON.parse(bodyText) as unknown;
      } catch (error) {
        throw new Error(`MCP response was not valid JSON: ${(error as Error).message}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async buildRequestContext(): Promise<{ url: string; headers: Record<string, string> }> {
    const url = new URL(this.options.endpoint);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "langgraph-glove/1.0",
      ...(this.options.customHeaders ?? {}),
    };

    if (this.options.authProvider) {
      const authContext = await this.options.authProvider.getRequestContext();
      Object.assign(headers, authContext.headers);
      for (const [key, value] of Object.entries(authContext.query)) {
        url.searchParams.set(key, value);
      }
    }

    return { url: url.toString(), headers };
  }
}
