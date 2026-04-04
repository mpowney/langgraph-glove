import fs from "node:fs/promises";
import path from "node:path";
import type { ToolMetadata } from "@langgraph-glove/tool-server";

/** Allowed config file names that may be read or overwritten. */
const ALLOWED_FILES = new Set([
  "agents.json",
  "models.json",
  "tools.json",
  "gateway.json",
  "memories.json",
]);

export const updateConfigToolMetadata: ToolMetadata = {
  name: "admin_update_config",
  description:
    "Use {name} to read or overwrite one of the system JSON config files " +
    "(agents.json, models.json, tools.json, gateway.json, memories.json). " +
    "To read a file omit the `content` parameter. " +
    "To overwrite a file supply valid JSON as the `content` string. " +
    "Changes take effect after the relevant process is restarted.",
  parameters: {
    type: "object",
    properties: {
      file: {
        type: "string",
        enum: Array.from(ALLOWED_FILES),
        description:
          "Name of the config file to read or update, e.g. 'agents.json'.",
      },
      content: {
        type: "string",
        description:
          "New file content as a JSON string. Omit to read the current content.",
      },
    },
    required: ["file"],
  },
};

/** Resolve the config directory at runtime, mirroring the launcher convention. */
function resolveConfigDir(): string {
  return path.resolve(process.env["GLOVE_CONFIG_DIR"] ?? "config");
}

export async function handleUpdateConfig(
  params: Record<string, unknown>,
): Promise<string> {
  const file = params["file"] as string;
  const content = params["content"] as string | undefined;

  if (typeof file !== "string" || !file) {
    throw new Error("admin_update_config: 'file' parameter is required and must be a string");
  }

  // Reject path traversal attempts
  const basename = path.basename(file);
  if (!ALLOWED_FILES.has(basename)) {
    throw new Error(
      `admin_update_config: '${file}' is not an allowed config file. ` +
        `Allowed files: ${Array.from(ALLOWED_FILES).join(", ")}`,
    );
  }

  const configDir = resolveConfigDir();
  const filePath = path.join(configDir, basename);

  if (content === undefined) {
    // Read mode
    const data = await fs.readFile(filePath, "utf8");
    return `Contents of ${basename}:\n${data}`;
  }

  // Write mode — validate JSON before writing
  if (typeof content !== "string") {
    throw new Error("admin_update_config: 'content' must be a JSON string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `admin_update_config: 'content' is not valid JSON — ${(err as Error).message}`,
    );
  }

  const formatted = JSON.stringify(parsed, null, 2);
  await fs.writeFile(filePath, formatted + "\n", "utf8");

  return `Config file '${basename}' updated successfully.`;
}
