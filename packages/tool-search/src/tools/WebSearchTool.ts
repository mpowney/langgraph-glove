import type { ToolMetadata } from "@langgraph-glove/tool-server";

export const webSearchToolMetadata: ToolMetadata = {
  name: "web_search",
  description:
    "Use {name} to search the web using SearXNG. Returns a list of results with title, URL, and " +
    "content snippet. Supports optional category filtering and pagination.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query string.",
      },
      categories: {
        type: "string",
        description:
          "Comma-separated SearXNG categories to search, e.g. 'general', 'news', " +
          "'images', 'science', 'it'. Defaults to 'general'.",
      },
      language: {
        type: "string",
        description:
          "Search language code, e.g. 'en', 'de', 'fr'. Defaults to 'auto'.",
      },
      pageNo: {
        type: "number",
        description: "Page number for pagination. Defaults to 1.",
      },
    },
    required: ["query"],
  },
};

interface SearxResult {
  title: string;
  url: string;
  content: string;
}

interface SearxResponse {
  results: SearxResult[];
  number_of_results: number;
}

interface ToolReference {
  url: string;
  title: string;
  kind: "web";
  sourceTool: "web_search";
}

/** Create a handler bound to a specific SearXNG base URL. */
export function createWebSearchHandler(searxngUrl: string) {
  return async function handleWebSearch(
    params: Record<string, unknown>,
  ): Promise<{ results: SearxResult[]; numberOfResults: number; references: ToolReference[] }> {
    const query = params["query"] as string;
    const categories = (params["categories"] as string | undefined) ?? "general";
    const language = (params["language"] as string | undefined) ?? "auto";
    const pageNo = (params["pageNo"] as number | undefined) ?? 1;

    if (!query || typeof query !== "string") {
      throw new Error("web_search: 'query' parameter is required and must be a string");
    }

    const url = new URL("/search", searxngUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", categories);
    url.searchParams.set("language", language);
    url.searchParams.set("pageno", String(pageNo));

    const res = await fetch(url.toString(), {
      headers: { "Accept": "application/json" },
    });

    if (!res.ok) {
      throw new Error(`SearXNG request failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as SearxResponse;

    const results = (body.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: r.content ?? "",
    }));

    const references = results
      .filter((result) => result.url.trim().length > 0)
      .map((result) => ({
        url: result.url,
        title: result.title.trim().length > 0 ? result.title : result.url,
        kind: "web" as const,
        sourceTool: "web_search" as const,
      }));

    return {
      results,
      numberOfResults: body.number_of_results ?? results.length,
      references,
    };
  };
}
