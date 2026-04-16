/**
 * SecretsRoutes — registers the secrets management REST endpoints on the AdminApi.
 *
 * Endpoints exposed (all require a valid bearer-token session **and** an active
 * privilege grant):
 *
 *   GET  /api/secrets/files          — list all `.json` files in the secrets dir
 *   GET  /api/secrets                — list all secret names (not values) + file
 *   GET  /api/secrets/:name          — retrieve a specific secret's value
 *   POST /api/secrets                — add or update a secret
 *
 * Privilege-grant validation is performed inline using the injected AuthService
 * so secrets never pass through any agent-accessible tool path.
 */

import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { AuthService } from "../auth/AuthService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry returned by `GET /api/secrets`. */
export interface SecretSummary {
  name: string;
  file: string;
}

/** The body shape for `GET /api/secrets/:name`. */
export interface SecretDetail {
  name: string;
  file: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Privilege grant helper
// ---------------------------------------------------------------------------

/**
 * Reads the `X-Privilege-Grant-Id` and `X-Conversation-Id` headers from the
 * request and validates them against the authService.  Writes a 401 response
 * and returns `false` on failure.
 *
 * Credentials are intentionally read from headers only (not query params) to
 * avoid the grant IDs being captured in server access logs, browser history,
 * or referrer headers.
 */
function requirePrivilegeGrant(
  req: express.Request,
  res: express.Response,
  authService: AuthService,
): boolean {
  const grantId = String(req.headers["x-privilege-grant-id"] ?? "").trim();
  const conversationId = String(req.headers["x-conversation-id"] ?? "").trim();

  if (!grantId || !conversationId) {
    res.status(401).json({ error: "Privilege grant is required (provide X-Privilege-Grant-Id and X-Conversation-Id headers)" });
    return false;
  }

  if (!authService.validatePrivilegeGrant(grantId, conversationId)) {
    res.status(401).json({ error: "Invalid or expired privilege grant" });
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveSecretsDir(override?: string): string {
  return path.resolve(override ?? process.env["GLOVE_SECRETS_DIR"] ?? "secrets");
}

function isSafeFilename(name: string): boolean {
  return (
    name.endsWith(".json") &&
    path.basename(name) === name &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface SecretsRoutesOptions {
  /** Path to the secrets directory. Defaults to `GLOVE_SECRETS_DIR` env var or `./secrets`. */
  secretsDir?: string;
  /** AuthService used to validate bearer-token sessions and privilege grants. */
  authService: AuthService;
}

export function registerSecretsRoutes(
  app: express.Express,
  options: SecretsRoutesOptions,
): void {
  const { authService } = options;
  const getSecretsDir = () => resolveSecretsDir(options.secretsDir);

  // Helper: validate session token from Authorization header
  const requireAuthUser = (req: express.Request, res: express.Response) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      res.status(401).json({ error: "Missing bearer token" });
      return false;
    }
    const user = authService.authenticateSession(token);
    if (!user) {
      res.status(401).json({ error: "Invalid or expired session" });
      return false;
    }
    return true;
  };

  // -------------------------------------------------------------------------
  // GET /api/secrets/files — list all secret JSON files
  // -------------------------------------------------------------------------
  app.get("/api/secrets/files", (req, res) => {
    if (!requireAuthUser(req, res)) return;
    if (!requirePrivilegeGrant(req, res, authService)) return;

    void (async () => {
      const secretsDir = getSecretsDir();
      const files: Array<{ name: string }> = [];

      try {
        const entries = await fs.readdir(secretsDir);
        for (const entry of entries) {
          if (entry.endsWith(".json")) {
            files.push({ name: entry });
          }
        }
      } catch {
        // Directory may not exist yet — return empty list
      }

      res.json(files);
    })();
  });

  // -------------------------------------------------------------------------
  // GET /api/secrets — list all secret names (not values) with file info
  // -------------------------------------------------------------------------
  app.get("/api/secrets", (req, res) => {
    if (!requireAuthUser(req, res)) return;
    if (!requirePrivilegeGrant(req, res, authService)) return;

    void (async () => {
      const secretsDir = getSecretsDir();
      const secrets: SecretSummary[] = [];

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
            // Skip files that can't be read or parsed
          }
        }
      } catch {
        // Directory may not exist — return empty list
      }

      res.json(secrets);
    })();
  });

  // -------------------------------------------------------------------------
  // GET /api/secrets/:name — retrieve a specific secret's value
  // -------------------------------------------------------------------------
  app.get("/api/secrets/:name", (req, res) => {
    if (!requireAuthUser(req, res)) return;
    if (!requirePrivilegeGrant(req, res, authService)) return;

    const secretName = req.params["name"];
    if (!secretName) {
      res.status(400).json({ error: "Secret name is required" });
      return;
    }

    void (async () => {
      const secretsDir = getSecretsDir();

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
                res.status(500).json({ error: `Secret "${secretName}" is not a string value` });
                return;
              }
              const detail: SecretDetail = { name: secretName, file: entry, value };
              res.json(detail);
              return;
            }
          } catch {
            // Skip unreadable files
          }
        }
      } catch {
        // Directory may not exist
      }

      res.status(404).json({ error: `Secret "${secretName}" not found` });
    })();
  });

  // -------------------------------------------------------------------------
  // POST /api/secrets — add or update a secret
  //
  // Privilege grant must be provided as X-Privilege-Grant-Id and
  // X-Conversation-Id headers (same as the GET endpoints).
  // Body: { file, name, value }
  // -------------------------------------------------------------------------
  app.post("/api/secrets", (req, res) => {
    if (!requireAuthUser(req, res)) return;
    if (!requirePrivilegeGrant(req, res, authService)) return;

    const body = req.body as Record<string, unknown> | undefined;
    const file = typeof body?.["file"] === "string" ? body["file"] : "";
    const name = typeof body?.["name"] === "string" ? body["name"] : "";
    const value = typeof body?.["value"] === "string" ? body["value"] : undefined;

    if (!file || !isSafeFilename(file)) {
      res.status(400).json({ error: "'file' must be a safe .json filename (no path separators)" });
      return;
    }
    if (!name) {
      res.status(400).json({ error: "'name' is required" });
      return;
    }
    if (value === undefined) {
      res.status(400).json({ error: "'value' is required and must be a string" });
      return;
    }

    void (async () => {
      const secretsDir = getSecretsDir();

      // Ensure secrets directory exists
      await fs.mkdir(secretsDir, { recursive: true });

      // Use basename explicitly to prevent any path traversal despite earlier validation
      const safeBasename = path.basename(file);
      const filePath = path.join(secretsDir, safeBasename);

      let existing: Record<string, string> = {};
      try {
        const raw = await fs.readFile(filePath, "utf8");
        existing = JSON.parse(raw) as Record<string, string>;
      } catch {
        // File doesn't exist yet — start fresh
      }

      existing[name] = value;

      await fs.writeFile(filePath, JSON.stringify(existing, null, 2) + "\n", "utf8");

      res.json({ success: true, file: safeBasename, name });
    })();
  });
}
