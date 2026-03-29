import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { v4 as uuidv4 } from "uuid";

const SESSION_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

interface Session {
  context: BrowserContext;
  page: Page;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manages persistent browser sessions keyed by UUID.
 * Each session has a BrowserContext + Page and auto-expires after 5 minutes of inactivity.
 */
export class SessionManager {
  private browser: Browser | null = null;
  private readonly sessions = new Map<string, Session>();

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  private resetTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      this.close(sessionId).catch(() => {});
    }, SESSION_TIMEOUT_MS);
  }

  /** Create a new session by navigating to the given URL. */
  async open(url: string): Promise<{ sessionId: string; title: string; url: string }> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    const sessionId = uuidv4();
    const timer = setTimeout(() => {
      this.close(sessionId).catch(() => {});
    }, SESSION_TIMEOUT_MS);

    this.sessions.set(sessionId, { context, page, timer });

    return {
      sessionId,
      title: await page.title(),
      url: page.url(),
    };
  }

  /** Get the page for an existing session (refreshes timeout). */
  getPage(sessionId: string): Page {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No session found with id "${sessionId}". It may have expired.`);
    }
    this.resetTimer(sessionId);
    return session.page;
  }

  /** Close a specific session. */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.timer);
    this.sessions.delete(sessionId);
    await session.context.close().catch(() => {});
  }

  /** Shut down all sessions and the browser. */
  async closeAll(): Promise<void> {
    for (const [id] of this.sessions) {
      await this.close(id);
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

/** Singleton session manager shared across all tools. */
export const sessionManager = new SessionManager();
