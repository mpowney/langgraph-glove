import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { getBrowser } from "../browser";

export const screenshotToolMetadata: ToolMetadata = {
  name: "web_screenshot",
  description:
    "Use {name} to take a screenshot of a web page at the given URL. Returns the screenshot as a " +
    "base64-encoded image string. Useful for visually inspecting a page or capturing its " +
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
      maxWidth: {
        type: "integer",
        description:
          "Maximum viewport width for the capture. Defaults to 1600.",
      },
      maxHeight: {
        type: "integer",
        description:
          "Maximum viewport height for the capture. Defaults to 1600.",
      },
      format: {
        type: "string",
        enum: ["jpeg", "png"],
        description:
          "Image format to encode. Defaults to jpeg for smaller payloads.",
      },
      quality: {
        type: "integer",
        description:
          "JPEG quality from 1 to 100 (used only when format=jpeg). Defaults to 88.",
      },
    },
    required: ["url"],
  },
};

export async function handleScreenshot(params: Record<string, unknown>): Promise<string> {
  const url = params["url"] as string;
  const fullPage = (params["fullPage"] as boolean | undefined) ?? false;
  const maxWidth = readBoundedInt(params["maxWidth"], 1600, "maxWidth");
  const maxHeight = readBoundedInt(params["maxHeight"], 1600, "maxHeight");
  const format = readFormat(params["format"]);
  const quality = readBoundedInt(params["quality"], 88, "quality", 1, 100);

  if (!url || typeof url !== "string") {
    throw new Error("web_screenshot: 'url' parameter is required and must be a string");
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: {
      width: maxWidth,
      height: maxHeight,
    },
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const buffer = await page.screenshot({
      fullPage,
      type: format,
      quality: format === "jpeg" ? quality : undefined,
      scale: "css",
    });
    return buffer.toString("base64");
  } finally {
    await context.close();
  }
}

function readBoundedInt(
  value: unknown,
  fallback: number,
  name: string,
  min: number = 1,
  max: number = 10_000,
): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`web_screenshot: '${name}' must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readFormat(value: unknown): "jpeg" | "png" {
  if (value == null) return "jpeg";
  if (value === "jpeg" || value === "png") return value;
  throw new Error("web_screenshot: 'format' must be 'jpeg' or 'png'");
}
