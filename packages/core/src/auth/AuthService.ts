import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

interface UserRow {
  id: string;
  password_hash: string;
}

interface SessionRow {
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
}

interface SetupTokenRow {
  expires_at: string;
  used_at: string | null;
}

interface AuthConfig {
  setupTokenTtlMinutes: number;
  sessionTtlMinutes: number;
  minPasswordLength: number;
}

export interface AuthenticatedUser {
  userId: string;
}

export interface SetupTokenDetails {
  token: string;
  expiresAt: string;
}

export interface SessionDetails {
  token: string;
  expiresAt: string;
}

export class AuthService {
  private readonly db: Database.Database;
  private readonly config: AuthConfig;

  constructor(options: {
    dbPath: string;
    config?: {
      setupTokenTtlMinutes?: number;
      sessionTtlMinutes?: number;
      minPasswordLength?: number;
    };
  }) {
    const dbPath = path.resolve(options.dbPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.config = {
      setupTokenTtlMinutes: options.config?.setupTokenTtlMinutes ?? 30,
      sessionTtlMinutes: options.config?.sessionTtlMinutes ?? 12 * 60,
      minPasswordLength: options.config?.minPasswordLength ?? 12,
    };

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  getStatus(): { setupRequired: boolean; minPasswordLength: number } {
    return {
      setupRequired: !this.hasUsers(),
      minPasswordLength: this.config.minPasswordLength,
    };
  }

  ensureBootstrapToken(): SetupTokenDetails | null {
    if (this.hasUsers()) return null;
    this.pruneExpiredSetupTokens();

    const activeTokenCount = this.db
      .prepare<[string], { count: number }>(`
        SELECT COUNT(*) AS count
        FROM auth_setup_tokens
        WHERE used_at IS NULL AND expires_at > ?
      `)
      .get(new Date().toISOString())?.count ?? 0;

    if (activeTokenCount > 0) return null;
    return this.generateBootstrapToken();
  }

  regenerateBootstrapToken(): SetupTokenDetails {
    if (this.hasUsers()) {
      throw new Error("Bootstrap token regeneration is only allowed before initial setup is complete");
    }

    this.db.prepare(`
      UPDATE auth_setup_tokens
      SET used_at = ?
      WHERE used_at IS NULL
    `).run(new Date().toISOString());

    return this.generateBootstrapToken();
  }

  completeSetup(input: { setupToken: string; password: string }): { userId: string } {
    if (!input.setupToken.trim()) {
      throw new Error("setupToken is required");
    }
    this.validatePassword(input.password);

    if (this.hasUsers()) {
      throw new Error("Setup has already been completed");
    }

    const tokenHash = hashToken(input.setupToken);
    const tokenRow = this.db
      .prepare<[string], SetupTokenRow>(`
        SELECT expires_at, used_at
        FROM auth_setup_tokens
        WHERE token_hash = ?
      `)
      .get(tokenHash);

    if (!tokenRow) {
      throw new Error("Invalid setup token");
    }
    if (tokenRow.used_at !== null) {
      throw new Error("Setup token has already been used");
    }
    if (Date.parse(tokenRow.expires_at) <= Date.now()) {
      throw new Error("Setup token has expired");
    }

    const userId = randomUUID();
    const now = new Date().toISOString();
    const passwordHash = hashPassword(input.password);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO auth_users (id, password_hash, created_at)
          VALUES (?, ?, ?)
        `)
        .run(userId, passwordHash, now);

      this.db
        .prepare(`
          UPDATE auth_setup_tokens
          SET used_at = ?
          WHERE token_hash = ?
        `)
        .run(now, tokenHash);
    });

    tx();
    return { userId };
  }

  login(password: string): SessionDetails {
    const user = this.getSingleUser();
    if (!user) {
      throw new Error("Setup is not complete");
    }

    if (!verifyPassword(password, user.password_hash)) {
      throw new Error("Invalid credentials");
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMinutes * 60 * 1000).toISOString();

    this.db
      .prepare(`
        INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(randomUUID(), user.id, tokenHash, now.toISOString(), expiresAt);

    return { token, expiresAt };
  }

  authenticateSession(token: string): AuthenticatedUser | null {
    if (!token.trim()) return null;

    const row = this.db
      .prepare<[string], SessionRow>(`
        SELECT user_id, expires_at, revoked_at
        FROM auth_sessions
        WHERE token_hash = ?
      `)
      .get(hashToken(token));

    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (Date.parse(row.expires_at) <= Date.now()) return null;

    return { userId: row.user_id };
  }

  revokeSession(token: string): void {
    if (!token.trim()) return;

    this.db
      .prepare(`
        UPDATE auth_sessions
        SET revoked_at = ?
        WHERE token_hash = ?
      `)
      .run(new Date().toISOString(), hashToken(token));
  }

  close(): void {
    this.db.close();
  }

  private generateBootstrapToken(): SetupTokenDetails {
    const token = generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.setupTokenTtlMinutes * 60 * 1000).toISOString();

    this.db
      .prepare(`
        INSERT INTO auth_setup_tokens (token_hash, created_at, expires_at)
        VALUES (?, ?, ?)
      `)
      .run(hashToken(token), now.toISOString(), expiresAt);

    return { token, expiresAt };
  }

  private hasUsers(): boolean {
    const count = this.db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM auth_users")
      .get()?.count ?? 0;
    return count > 0;
  }

  private getSingleUser(): UserRow | null {
    const row = this.db
      .prepare<[], UserRow>(`
        SELECT id, password_hash
        FROM auth_users
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get();
    return row ?? null;
  }

  private validatePassword(password: string): void {
    if (password.length < this.config.minPasswordLength) {
      throw new Error(`Password must be at least ${this.config.minPasswordLength} characters`);
    }
  }

  private pruneExpiredSetupTokens(): void {
    this.db
      .prepare(`
        DELETE FROM auth_setup_tokens
        WHERE expires_at <= ? OR used_at IS NOT NULL
      `)
      .run(new Date().toISOString());
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_setup_tokens (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
      ON auth_sessions (expires_at);
    `);
  }
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derivedKey = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(password, salt, expected.length);

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
