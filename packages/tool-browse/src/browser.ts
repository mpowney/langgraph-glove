import { chromium, type Browser } from "playwright";

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
