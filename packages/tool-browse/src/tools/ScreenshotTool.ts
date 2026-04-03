import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { getBrowser } from "../browser";

export const screenshotToolMetadata: ToolMetadata = {
  name: "web_screenshot",
  description:
    "Use {name} to take a screenshot of a web page at the given URL. Returns the screenshot as a " +
    "base64-encoded PNG string. Useful for visually inspecting a page or capturing its " +
    "current state.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The full URL of the page to screenshot, e.g. 'https://example.com'.",
      },
      fullPage: {
        type: "boolean",
        description:
          "Whether to capture the full scrollable page instead of just the viewport. Defaults to false.",
      },
    },
    required: ["url"],
  },
};

export async function handleScreenshot(params: Record<string, unknown>): Promise<string> {
  const url = params["url"] as string;
  const fullPage = (params["fullPage"] as boolean | undefined) ?? false;

  if (!url || typeof url !== "string") {
    throw new Error("web_screenshot: 'url' parameter is required and must be a string");
  }

  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const buffer = await page.screenshot({ fullPage, type: "png" });
    return buffer.toString("base64");
  } finally {
    await context.close();
  }
}
