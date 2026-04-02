import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { sessionManager } from "../SessionManager.js";

export const getFieldsToolMetadata: ToolMetadata = {
  name: "browse_get_fields",
  description:
    "Use {name} to return all form fields on the current page of an existing browser session. " +
    "For each field, returns its CSS selector, type, name, label, current value, " +
    "and options (for select elements). Use the selectors with browse_submit_form " +
    "to fill and submit the form.",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "The session ID returned by browse_open.",
      },
    },
    required: ["sessionId"],
  },
};

interface FieldInfo {
  selector: string;
  type: string;
  name: string;
  label: string;
  value: string;
  options?: string[];
}

export async function handleGetFields(
  params: Record<string, unknown>,
): Promise<FieldInfo[]> {
  const sessionId = params["sessionId"] as string;
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("browse_get_fields: 'sessionId' parameter is required");
  }

  const page = sessionManager.getPage(sessionId);

  return page.evaluate(() => {
    const fields: {
      selector: string;
      type: string;
      name: string;
      label: string;
      value: string;
      options?: string[];
    }[] = [];

    const elements = document.querySelectorAll("input, textarea, select");

    function buildSelector(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const name = el.getAttribute("name");
      if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      const parent = el.parentElement;
      if (!parent) return el.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === el.tagName,
      );
      const idx = siblings.indexOf(el) + 1;
      return `${buildSelector(parent)} > ${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
    }

    function findLabel(el: Element): string {
      // 1. <label for="id">
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label?.textContent) return label.textContent.trim();
      }
      // 2. Ancestor <label>
      const ancestor = el.closest("label");
      if (ancestor?.textContent) return ancestor.textContent.trim();
      // 3. aria-label
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      // 4. placeholder
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder;
      // 5. name fallback
      return el.getAttribute("name") ?? "";
    }

    for (const el of elements) {
      const tagName = el.tagName.toLowerCase();
      const inputType =
        tagName === "select"
          ? "select"
          : tagName === "textarea"
            ? "textarea"
            : (el as HTMLInputElement).type || "text";

      // Skip hidden and submit-type inputs
      if (inputType === "hidden" || inputType === "submit" || inputType === "button") continue;

      const field: {
        selector: string;
        type: string;
        name: string;
        label: string;
        value: string;
        options?: string[];
      } = {
        selector: buildSelector(el),
        type: inputType,
        name: el.getAttribute("name") ?? "",
        label: findLabel(el),
        value: (el as HTMLInputElement).value ?? "",
      };

      if (tagName === "select") {
        field.options = Array.from((el as HTMLSelectElement).options).map(
          (o) => `${o.value}|${o.text.trim()}`,
        );
      }

      fields.push(field);
    }

    return fields;
  });
}
