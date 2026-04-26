import { chromium, type Browser } from "playwright";
import type { ToolHealthResult } from "@langgraph-glove/tool-server";

let browser: Browser | null = null;

/** Launch (or return existing) shared headless Chromium instance. */
export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

/** Close the shared browser instance. */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export async function checkBrowserHealth(): Promise<Omit<ToolHealthResult, "latencyMs">> {
  let probeBrowser: Browser | null = null;
  try {
    probeBrowser = await chromium.launch({ headless: true });
    return {
      ok: true,
      summary: `Chromium is available (${probeBrowser.version()})`,
      dependencies: [
        {
          name: "chromium",
          ok: true,
          detail: probeBrowser.version(),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      summary: "Chromium is not available",
      dependencies: [
        {
          name: "chromium",
          ok: false,
          detail: message,
        },
      ],
    };
  } finally {
    if (probeBrowser) {
      await probeBrowser.close().catch(() => undefined);
    }
  }
}
