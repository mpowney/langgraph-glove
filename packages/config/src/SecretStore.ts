import fs from "node:fs";
import path from "node:path";

/**
 * Loads secrets from JSON files in a directory.
 *
 * Each `.json` file in the secrets directory is read and its key-value pairs
 * are merged into a single flat map.  Duplicate keys across files cause an
 * error.
 *
 * ## Directory layout
 * ```
 * secrets/
 *   api-keys.json     →  { "openai-key": "sk-...", "anthropic-key": "sk-ant-..." }
 *   tokens.json       →  { "telegram-token": "123:ABC" }
 * ```
 *
 * References of the form `{SECRET:openai-key}` in config values are resolved
 * by {@link resolveSecrets}.
 */
export class SecretStore {
  private readonly secrets = new Map<string, string>();

  /** All known secret values (used by log redaction). */
  get values(): ReadonlySet<string> {
    return new Set(this.secrets.values());
  }

  /**
   * Load all `.json` files from `dir`.  Throws if the directory contains
   * duplicate secret names or if any value is not a string.
   */
  load(dir: string): void {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) return;

    const files = fs.readdirSync(resolved).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(resolved, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Invalid JSON in secret file: ${filePath}`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Secret file must contain a JSON object: ${filePath}`);
      }
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== "string") {
          throw new Error(`Secret "${key}" in ${file} must be a string`);
        }
        if (this.secrets.has(key)) {
          throw new Error(`Duplicate secret name "${key}" (found in ${file})`);
        }
        this.secrets.set(key, value);
      }
    }
  }

  /** Get a secret value by name. Throws if not found. */
  get(name: string): string {
    const value = this.secrets.get(name);
    if (value === undefined) {
      throw new Error(`Secret "${name}" not found. Available: ${[...this.secrets.keys()].join(", ") || "(none)"}`);
    }
    return value;
  }

  /** Check whether a secret exists. */
  has(name: string): boolean {
    return this.secrets.has(name);
  }

  /**
   * Replace all `{SECRET:name}` placeholders in a string with actual values.
   */
  resolveString(input: string): string {
    return input.replace(/\{SECRET:([a-zA-Z0-9_-]+)\}/g, (_match, name: string) => {
      return this.get(name);
    });
  }

  /**
   * Deep-walk a plain object/array and resolve `{SECRET:...}` references in
   * every string value.  Mutates and returns the input for convenience.
   */
  resolveSecrets<T>(obj: T): T {
    if (typeof obj === "string") {
      return this.resolveString(obj) as T;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        obj[i] = this.resolveSecrets(obj[i]);
      }
      return obj;
    }
    if (typeof obj === "object" && obj !== null) {
      for (const key of Object.keys(obj)) {
        (obj as Record<string, unknown>)[key] = this.resolveSecrets(
          (obj as Record<string, unknown>)[key],
        );
      }
    }
    return obj;
  }
}
