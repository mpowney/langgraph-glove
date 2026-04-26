import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { getBrowser } from "../browser";

interface ToolReference {
  url: string;
  title: string;
  kind: "web";
  sourceTool: "web_get_content";
}

interface WebGetContentResult {
  url: string;
  selector?: string;
  content: string;
  references: ToolReference[];
}

export const getContentToolMetadata: ToolMetadata = {
  name: "web_get_content",
  description:
    "Use {name} to fetch a web page and return its text content plus normalized references. By default returns the text of the " +
    "entire page body. If a CSS selector is provided, returns the text of the first " +
    "matching element only.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The full URL of the page to fetch, e.g. 'https://example.com'.",
      },
      selector: {
        type: "string",
        description:
          "Optional CSS selector to scope the extracted text to a specific element, " +
          "e.g. 'article' or '#main-content'.",
      },
    },
    required: ["url"],
  },
};

export async function handleGetContent(params: Record<string, unknown>): Promise<WebGetContentResult> {
  const url = params["url"] as string;
  const selector = params["selector"] as string | undefined;

  if (!url || typeof url !== "string") {
    throw new Error("web_get_content: 'url' parameter is required and must be a string");
  }

  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    const title = await page.title();

    let content: string;

    if (selector) {
      const element = await page.$(selector);
      if (!element) {
        throw new Error(`web_get_content: no element found matching selector "${selector}"`);
      }
      content = (await element.innerText()).trim();
    } else {
      content = (await page.innerText("body")).trim();
    }

    return {
      url,
      ...(selector ? { selector } : {}),
      content,
      references: [
        {
          url,
          title: title?.trim().length ? title : url,
          kind: "web",
          sourceTool: "web_get_content",
        },
      ],
    };
  } finally {
    await context.close();
  }
}
