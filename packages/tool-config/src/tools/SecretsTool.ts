import fs from "node:fs/promises";
import path from "node:path";
import type { ToolMetadata } from "@langgraph-glove/tool-server";
import { validatePrivilegeGrant } from "@langgraph-glove/tool-server";

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

function resolveSecretsDir(): string {
  return path.resolve(process.env["GLOVE_SECRETS_DIR"] ?? "secrets");
}

// ---------------------------------------------------------------------------
// secrets_list_files
// ---------------------------------------------------------------------------

export const secretsListFilesMetadata: ToolMetadata = {
  name: "secrets_list_files",
  description:
    "List all secret JSON files available in the secrets directory. Returns file names. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation.",
  parameters: {
    type: "object",
    properties: { ...PRIVILEGE_PARAMS },
    required: ["conversationId", "privilegeGrantId"],
  },
};

export async function handleSecretsListFiles(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const secretsDir = resolveSecretsDir();
  const files: Array<{ name: string }> = [];

  try {
    const entries = await fs.readdir(secretsDir);
    for (const entry of entries) {
      if (entry.endsWith(".json")) {
        files.push({ name: entry });
      }
    }
  } catch {
    // Secrets directory may not exist yet
  }

  return JSON.stringify(files);
}

// ---------------------------------------------------------------------------
// secrets_list
// ---------------------------------------------------------------------------

export const secretsListMetadata: ToolMetadata = {
  name: "secrets_list",
  description:
    "List all secret names (not values) across all secrets files. Returns names and the file each belongs to. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation.",
  parameters: {
    type: "object",
    properties: { ...PRIVILEGE_PARAMS },
    required: ["conversationId", "privilegeGrantId"],
  },
};

export async function handleSecretsList(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const secretsDir = resolveSecretsDir();
  const secrets: Array<{ name: string; file: string }> = [];

  try {
    const entries = await fs.readdir(secretsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(secretsDir, entry);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const key of Object.keys(parsed)) {
          secrets.push({ name: key, file: entry });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Secrets directory may not exist
  }

  return JSON.stringify(secrets);
}

// ---------------------------------------------------------------------------
// secrets_get
// ---------------------------------------------------------------------------

export const secretsGetMetadata: ToolMetadata = {
  name: "secrets_get",
  description:
    "Get the value of a specific secret by name. Requires privileged access. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation.",
  parameters: {
    type: "object",
    properties: {
      ...PRIVILEGE_PARAMS,
      name: {
        type: "string",
        description: "Name of the secret to retrieve.",
      },
    },
    required: ["conversationId", "privilegeGrantId", "name"],
  },
};

export async function handleSecretsGet(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const secretName = params["name"];
  if (typeof secretName !== "string" || !secretName) {
    throw new Error("secrets_get: 'name' is required");
  }

  const secretsDir = resolveSecretsDir();

  try {
    const entries = await fs.readdir(secretsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(secretsDir, entry);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (secretName in parsed) {
          const value = parsed[secretName];
          if (typeof value !== "string") {
            throw new Error(`Secret "${secretName}" is not a string value`);
          }
          return JSON.stringify({ name: secretName, value, file: entry });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  } catch {
    // Secrets directory may not exist
  }

  throw new Error(`Secret "${secretName}" not found`);
}

// ---------------------------------------------------------------------------
// secrets_upsert
// ---------------------------------------------------------------------------

export const secretsUpsertMetadata: ToolMetadata = {
  name: "secrets_upsert",
  description:
    "Add or update a secret in a secrets JSON file. If the file does not exist it will be created. " +
    "IMPORTANT: conversationId and privilegeGrantId are required by backend validation.",
  parameters: {
    type: "object",
    properties: {
      ...PRIVILEGE_PARAMS,
      file: {
        type: "string",
        description: "Name of the secrets JSON file, e.g. 'secrets.json'.",
      },
      name: {
        type: "string",
        description: "Name (key) of the secret to add or update.",
      },
      value: {
        type: "string",
        description: "Value of the secret.",
      },
    },
    required: ["conversationId", "privilegeGrantId", "file", "name", "value"],
  },
};

export async function handleSecretsUpsert(
  params: Record<string, unknown>,
  adminApiUrl: string,
): Promise<string> {
  await validatePrivilegeGrant(params, adminApiUrl);

  const file = params["file"];
  const name = params["name"];
  const value = params["value"];

  if (typeof file !== "string" || !file.endsWith(".json")) {
    throw new Error("secrets_upsert: 'file' must be a .json filename");
  }
  if (typeof name !== "string" || !name) {
    throw new Error("secrets_upsert: 'name' is required");
  }
  if (typeof value !== "string") {
    throw new Error("secrets_upsert: 'value' must be a string");
  }

  // Prevent path traversal
  const basename = path.basename(file);
  if (basename !== file) {
    throw new Error("secrets_upsert: 'file' must not contain path separators");
  }

  const secretsDir = resolveSecretsDir();

  // Ensure secrets directory exists
  await fs.mkdir(secretsDir, { recursive: true });

  const filePath = path.join(secretsDir, basename);

  let existing: Record<string, string> = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    existing = JSON.parse(raw) as Record<string, string>;
  } catch {
    // File doesn't exist yet — start fresh
  }

  existing[name] = value;

  await fs.writeFile(filePath, JSON.stringify(existing, null, 2) + "\n", "utf8");

  return JSON.stringify({ success: true, file: basename, name });
}
