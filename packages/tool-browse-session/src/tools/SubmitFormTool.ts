import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { sessionManager } from "../SessionManager.js";

export const submitFormToolMetadata: ToolMetadata = {
  name: "browse_submit_form",
  description:
    "Use {name} to fill in form fields and submit a form on an existing browser session by clicking " +
    "the submit button. This triggers any JavaScript validation or processing in the " +
    "browser. Returns the page state after submission (title, URL, and a snippet of the " +
    "page content). Use browse_get_fields first to discover field selectors.",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: ["string", "null"],
        description:
          "Optional session ID returned by browse_open. If null or omitted, the tool reuses the latest active session or creates a new one.",
      },
      fields: {
        type: "array",
        description:
          "Array of fields to fill. Each entry has a 'selector' (CSS selector from " +
          "browse_get_fields) and a 'value' (the value to enter).",
        items: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the field.",
            },
            value: {
              type: "string",
              description: "The value to fill into the field.",
            },
          },
          required: ["selector", "value"],
        },
      },
      submitSelector: {
        type: "string",
        description:
          "Optional CSS selector for the submit button. If omitted, the tool will " +
          "auto-detect the submit button (button[type=submit], input[type=submit], " +
          "or the last button in the form).",
      },
    },
    required: ["fields"],
  },
};

interface FieldEntry {
  selector: string;
  value: string;
}

export async function handleSubmitForm(
  params: Record<string, unknown>,
): Promise<{ sessionId: string; success: boolean; title: string; url: string; content: string }> {
  const sessionId = await sessionManager.resolveSessionId(params["sessionId"]);
  const fields = params["fields"] as FieldEntry[];
  const submitSelector = params["submitSelector"] as string | undefined;

  if (!Array.isArray(fields)) {
    throw new Error("browse_submit_form: 'fields' parameter must be an array");
  }

  const page = sessionManager.getPage(sessionId);

  // Fill each field
  for (const field of fields) {
    const el = await page.$(field.selector);
    if (!el) {
      throw new Error(`browse_submit_form: no element found for selector "${field.selector}"`);
    }
    const tagName = await el.evaluate((e) => e.tagName.toLowerCase());
    if (tagName === "select") {
      await page.selectOption(field.selector, field.value);
    } else {
      await page.fill(field.selector, field.value);
    }
  }

  // Find submit button
  let btnSelector: string | undefined = submitSelector;
  if (!btnSelector) {
    // Auto-detect: button[type=submit], input[type=submit], or last button in form
    btnSelector = (await page.evaluate(() => {
      const btn =
        document.querySelector('button[type="submit"]') ??
        document.querySelector('input[type="submit"]') ??
        document.querySelector("form button:last-of-type") ??
        document.querySelector("button");
      if (!btn) return null;
      if (btn.id) return `#${btn.id}`;
      const name = btn.getAttribute("name");
      if (name) return `${btn.tagName.toLowerCase()}[name="${name}"]`;
      return null;
    })) ?? undefined;
  }

  if (!btnSelector) {
    throw new Error(
      "browse_submit_form: could not find a submit button. Provide 'submitSelector' explicitly.",
    );
  }

  // Click submit and wait for navigation or network idle
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {}),
    page.click(btnSelector),
  ]);

  // Small grace period for SPA-style updates
  await page.waitForTimeout(500);

  const title = await page.title();
  const url = page.url();
  const content = await page.evaluate(() => {
    const body = document.body.innerText;
    return body.length > 2000 ? body.slice(0, 2000) + "…" : body;
  });

  return { sessionId, success: true, title, url, content };
}
