import type { MemoryToolHealth } from "../types";

interface RpcResponse<T> {
  id: string;
  result?: T;
  error?: string;
}

interface ToolMetadata {
  name: string;
  description: string;
}

const REQUIRED_MEMORY_TOOLS = ["memory_list", "memory_get", "memory_update", "memory_search"];

export async function callMemoryTool<T>(
  memoryToolUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  if (!memoryToolUrl) {
    throw new Error("VITE_MEMORY_TOOL_URL is not configured");
  }

  const res = await fetch(`${memoryToolUrl}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const payload = (await res.json()) as RpcResponse<T>;
  if (payload.error !== undefined) {
    throw new Error(payload.error);
  }
  if (payload.result === undefined) {
    throw new Error("RPC response missing result");
  }

  return payload.result;
}

export async function checkMemoryToolAvailability(memoryToolUrl: string): Promise<MemoryToolHealth> {
  if (!memoryToolUrl) {
    return {
      available: false,
      reason: "VITE_MEMORY_TOOL_URL is not configured",
    };
  }

  try {
    const tools = await callMemoryTool<ToolMetadata[]>(memoryToolUrl, "__introspect__", {});
    const names = tools.map((tool) => tool.name);
    const missing = REQUIRED_MEMORY_TOOLS.filter((name) => !names.includes(name));

    if (missing.length > 0) {
      return {
        available: false,
        reason: `Missing required memory tools: ${missing.join(", ")}`,
        tools: names,
      };
    }

    return {
      available: true,
      tools: names,
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
