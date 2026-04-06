import fs from "node:fs/promises";
import path from "node:path";
import type { ToolMetadata } from "@langgraph-glove/tool-server";
import type { ConfigStore } from "../ConfigStore";
import { validatePrivilegeGrant } from "../validatePrivilegeGrant";

/** Config file names that may be read or written via this tool. */
const ALLOWED_FILES = new Set([
  "agents.json",
  "models.json",
  "tools.json",
  "gateway.json",
  "memories.json",
]);

const PRIVILEGE_PARAMS = {
  conversationId: {
    type: "string",
    description:
      "Conversation thread ID for this privileged execution (auto-injected by runtime context).",
  },
  privilegeGrantId: {
    type: "string",
    description:
      "Short-lived privileged-access grant ID (auto-injected by runtime context).",
  },
} as const;

function resolveConfigDir(): string {
  return path.resolve(process.env["GLOVE_CONFIG_DIR"] ?? "config");
}

function resolveDbPath(): string {
  return path.resolve(process.env["GLOVE_DATA_DIR"] ?? "data", "config-history.sqlite");
}

// ---------------------------------------------------------------------------
// config_list_files
// ---------------------------------------------------------------------------

export const configListFilesMetadata: ToolMetadata = {
  name: "config_list_files",
  description:
    "List all config JSON files available for editing. Returns file names and basic metadata. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation.",
  parameters: {
    type: "object",
    properties: { ...PRIVILEGE_PARAMS },
    required: ["conversationId", "privilegeGrantId"],
  },
};

export async function handleConfigListFiles(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const configDir = resolveConfigDir();
  const files: Array<{ name: string; sizeBytes: number; modifiedAt: string }> = [];

  for (const name of ALLOWED_FILES) {
    const filePath = path.join(configDir, name);
    try {
      const stat = await fs.stat(filePath);
      files.push({
        name,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // File may not exist yet — include it with defaults so the UI can create it.
      files.push({ name, sizeBytes: 0, modifiedAt: "" });
    }
  }

  return JSON.stringify(files);
}

// ---------------------------------------------------------------------------
// config_read_file
// ---------------------------------------------------------------------------

export const configReadFileMetadata: ToolMetadata = {
  name: "config_read_file",
  description:
    "Read the current content of a config JSON file. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation.",
  parameters: {
    type: "object",
    properties: {
      ...PRIVILEGE_PARAMS,
      file: {
        type: "string",
        enum: Array.from(ALLOWED_FILES),
        description: "Name of the config file to read, e.g. 'agents.json'.",
      },
    },
    required: ["conversationId", "privilegeGrantId", "file"],
  },
};

export async function handleConfigReadFile(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const file = params["file"] as string;
  if (typeof file !== "string" || !ALLOWED_FILES.has(path.basename(file))) {
    throw new Error(
      `config_read_file: '${file}' is not an allowed config file. ` +
        `Allowed: ${Array.from(ALLOWED_FILES).join(", ")}`,
    );
  }

  const configDir = resolveConfigDir();
  const filePath = path.join(configDir, path.basename(file));
  const content = await fs.readFile(filePath, "utf8");
  return content;
}

// ---------------------------------------------------------------------------
// config_write_file
// ---------------------------------------------------------------------------

export const configWriteFileMetadata: ToolMetadata = {
  name: "config_write_file",
  description:
    "Write (overwrite) a config JSON file. The previous content is saved to SQLite history automatically. " +
    "Supply valid JSON as the 'content' parameter. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation.",
  parameters: {
    type: "object",
    properties: {
      ...PRIVILEGE_PARAMS,
      file: {
        type: "string",
        enum: Array.from(ALLOWED_FILES),
        description: "Name of the config file to write, e.g. 'agents.json'.",
      },
      content: {
        type: "string",
        description: "New file content as a valid JSON string.",
      },
      description: {
        type: "string",
        description: "Optional description of the change (stored with the version history entry).",
      },
    },
    required: ["conversationId", "privilegeGrantId", "file", "content"],
  },
};

export async function handleConfigWriteFile(
  params: Record<string, unknown>,
  adminApiUrl: string,
  store: ConfigStore,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const file = params["file"] as string;
  const content = params["content"] as string;
  const description = typeof params["description"] === "string"
    ? params["description"]
    : undefined;

  if (typeof file !== "string" || !ALLOWED_FILES.has(path.basename(file))) {
    throw new Error(
      `config_write_file: '${file}' is not an allowed config file. ` +
        `Allowed: ${Array.from(ALLOWED_FILES).join(", ")}`,
    );
  }
  if (typeof content !== "string") {
    throw new Error("config_write_file: 'content' must be a string");
  }

  // Validate JSON before writing
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `config_write_file: 'content' is not valid JSON — ${(err as Error).message}`,
    );
  }

  const configDir = resolveConfigDir();
  const basename = path.basename(file);
  const filePath = path.join(configDir, basename);

  // Save current content to history before overwriting
  try {
    const existing = await fs.readFile(filePath, "utf8");
    store.saveVersion(basename, existing, description ?? `Saved before overwrite`);
  } catch {
    // File may not exist yet — that's fine
  }

  const formatted = JSON.stringify(parsed, null, 2);
  await fs.writeFile(filePath, formatted + "\n", "utf8");

  return JSON.stringify({ success: true, file: basename });
}

// ---------------------------------------------------------------------------
// config_list_history
// ---------------------------------------------------------------------------

export const configListHistoryMetadata: ToolMetadata = {
  name: "config_list_history",
  description:
    "List the saved version history for a config file. Returns version IDs with timestamps. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation.",
  parameters: {
    type: "object",
    properties: {
      ...PRIVILEGE_PARAMS,
      file: {
        type: "string",
        enum: Array.from(ALLOWED_FILES),
        description: "Name of the config file, e.g. 'agents.json'.",
      },
    },
    required: ["conversationId", "privilegeGrantId", "file"],
  },
};

export async function handleConfigListHistory(
  params: Record<string, unknown>,
  adminApiUrl: string,
  store: ConfigStore,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const file = params["file"] as string;
  if (typeof file !== "string" || !ALLOWED_FILES.has(path.basename(file))) {
    throw new Error(`config_list_history: '${file}' is not an allowed config file.`);
  }

  const versions = store.listVersions(path.basename(file));
  return JSON.stringify(versions);
}

// ---------------------------------------------------------------------------
// config_get_version
// ---------------------------------------------------------------------------

export const configGetVersionMetadata: ToolMetadata = {
  name: "config_get_version",
  description:
    "Retrieve the content of a specific historical version of a config file by its version ID. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation.",
  parameters: {
    type: "object",
    properties: {
      ...PRIVILEGE_PARAMS,
      versionId: {
        type: "string",
        description: "Version ID as returned by config_list_history.",
      },
    },
    required: ["conversationId", "privilegeGrantId", "versionId"],
  },
};

export async function handleConfigGetVersion(
  params: Record<string, unknown>,
  adminApiUrl: string,
  store: ConfigStore,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const versionId = params["versionId"] as string;
  if (typeof versionId !== "string" || !versionId) {
    throw new Error("config_get_version: 'versionId' is required");
  }

  const version = store.getVersion(versionId);
  if (!version) {
    throw new Error(`config_get_version: Version '${versionId}' not found`);
  }

  return JSON.stringify(version);
}

// ---------------------------------------------------------------------------
// Export a helper to resolve db path
// ---------------------------------------------------------------------------
export { resolveDbPath };
