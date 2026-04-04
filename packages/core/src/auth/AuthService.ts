import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

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

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  created_at: string;
}

interface PasskeyChallengeRow {
  challenge: string;
  user_id: string | null;
  purpose: string;
  expires_at: string;
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

  getStatus(): { setupRequired: boolean; minPasswordLength: number; passkeyRegistered: boolean } {
    return {
      setupRequired: !this.hasUsers(),
      minPasswordLength: this.config.minPasswordLength,
      passkeyRegistered: this.hasPasskeys(),
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

  /**
   * Wipe all users, sessions, passkeys, and setup tokens, then generate a
   * fresh bootstrap token — equivalent to a factory reset of auth state.
   */
  resetAuth(): SetupTokenDetails {
    this.db.transaction(() => {
      // Cascade deletes on sessions and passkeys via FK constraints.
      this.db.prepare("DELETE FROM auth_users").run();
      this.db.prepare("DELETE FROM auth_setup_tokens").run();
      this.db.prepare("DELETE FROM auth_passkey_challenges").run();
    })();

    return this.generateBootstrapToken();
  }

  completeSetup(input: { setupToken: string; password?: string }): { userId: string } {
    if (!input.setupToken.trim()) {
      throw new Error("setupToken is required");
    }

    const password = input.password?.trim() ?? "";
    if (password) {
      this.validatePassword(password);
    }

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
    // When no password is supplied (passkey-only setup), store a disabled
    // password marker so password login is effectively unavailable.
    const passwordHash = password ? hashPassword(password) : "disabled";

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

    return this.createSession(user.id);
  }

  createSessionForUser(userId: string): SessionDetails {
    return this.createSession(userId);
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

  // ---------------------------------------------------------------------------
  // Passkey (WebAuthn) — registration
  // ---------------------------------------------------------------------------

  async beginPasskeyRegistration(
    userId: string,
    rpId: string,
    rpName: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    this.pruneExpiredPasskeyChallenges();

    const existingPasskeys = this.db
      .prepare<[string], Pick<PasskeyRow, "id" | "transports">>(`
        SELECT id, transports FROM auth_passkeys WHERE user_id = ?
      `)
      .all(userId);

    const options = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: userId,
      attestationType: "none",
      authenticatorSelection: {
        userVerification: "preferred",
        residentKey: "required",
      },
      excludeCredentials: existingPasskeys.map((p) => ({
        id: p.id,
        transports: p.transports
          ? (JSON.parse(p.transports) as AuthenticatorTransportFuture[])
          : [],
      })),
    });

    const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    this.db
      .prepare(`
        INSERT OR REPLACE INTO auth_passkey_challenges (challenge, user_id, purpose, created_at, expires_at)
        VALUES (?, ?, 'register', ?, ?)
      `)
      .run(options.challenge, userId, new Date().toISOString(), expiresAt);

    return options;
  }

  async completePasskeyRegistration(
    userId: string,
    response: RegistrationResponseJSON,
    rpId: string,
    expectedOrigin: string,
  ): Promise<{ credentialId: string }> {
    this.pruneExpiredPasskeyChallenges();

    // Decode the challenge from the response to look up the exact ceremony row,
    // preventing race conditions when multiple tabs start registration concurrently.
    const rawClientData = Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8");
    const clientChallenge = (JSON.parse(rawClientData) as { challenge: string }).challenge;

    const row = this.db
      .prepare<[string, string], PasskeyChallengeRow>(`
        SELECT challenge, user_id, purpose, expires_at
        FROM auth_passkey_challenges
        WHERE challenge = ? AND user_id = ? AND purpose = 'register'
      `)
      .get(clientChallenge, userId);

    if (!row) throw new Error("No pending registration challenge");
    if (Date.parse(row.expires_at) <= Date.now()) throw new Error("Registration challenge has expired");

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin,
      expectedRPID: rpId,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Passkey registration verification failed");
    }

    const { credential } = verification.registrationInfo;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT OR REPLACE INTO auth_passkeys (id, user_id, public_key, counter, transports, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          credential.id,
          userId,
          Buffer.from(credential.publicKey).toString("base64url"),
          credential.counter,
          credential.transports ? JSON.stringify(credential.transports) : null,
          now,
        );

      this.db
        .prepare(`DELETE FROM auth_passkey_challenges WHERE user_id = ? AND purpose = 'register'`)
        .run(userId);
    })();

    return { credentialId: credential.id };
  }

  // ---------------------------------------------------------------------------
  // Passkey (WebAuthn) — authentication
  // ---------------------------------------------------------------------------

  async beginPasskeyAuthentication(
    rpId: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    this.pruneExpiredPasskeyChallenges();

    const passkeys = this.db
      .prepare<[], Pick<PasskeyRow, "id" | "transports">>(`
        SELECT id, transports FROM auth_passkeys
      `)
      .all();

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: "preferred",
      allowCredentials: passkeys.map((p) => ({
        id: p.id,
        transports: p.transports
          ? (JSON.parse(p.transports) as AuthenticatorTransportFuture[])
          : [],
      })),
    });

    const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    this.db
      .prepare(`
        INSERT OR REPLACE INTO auth_passkey_challenges (challenge, user_id, purpose, created_at, expires_at)
        VALUES (?, NULL, 'authenticate', ?, ?)
      `)
      .run(options.challenge, new Date().toISOString(), expiresAt);

    return options;
  }

  async completePasskeyAuthentication(
    response: AuthenticationResponseJSON,
    rpId: string,
    expectedOrigin: string,
  ): Promise<SessionDetails> {
    this.pruneExpiredPasskeyChallenges();

    // Decode the challenge from the response to look up the exact ceremony row,
    // preventing race conditions when multiple tabs start authentication concurrently.
    const rawClientData = Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8");
    const clientChallenge = (JSON.parse(rawClientData) as { challenge: string }).challenge;

    const row = this.db
      .prepare<[string], PasskeyChallengeRow>(`
        SELECT challenge, user_id, purpose, expires_at
        FROM auth_passkey_challenges
        WHERE challenge = ? AND user_id IS NULL AND purpose = 'authenticate'
      `)
      .get(clientChallenge);

    if (!row) throw new Error("No pending authentication challenge");
    if (Date.parse(row.expires_at) <= Date.now()) throw new Error("Authentication challenge has expired");

    const passkey = this.db
      .prepare<[string], PasskeyRow>(`
        SELECT id, user_id, public_key, counter, transports, created_at
        FROM auth_passkeys
        WHERE id = ?
      `)
      .get(response.id);

    if (!passkey) throw new Error("Passkey not found");

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin,
      expectedRPID: rpId,
      credential: {
        id: passkey.id,
        publicKey: Buffer.from(passkey.public_key, "base64url"),
        counter: passkey.counter,
        transports: passkey.transports
          ? (JSON.parse(passkey.transports) as AuthenticatorTransportFuture[])
          : [],
      },
      requireUserVerification: false,
    });

    if (!verification.verified) {
      throw new Error("Passkey authentication failed");
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE auth_passkeys SET counter = ?, last_used_at = ? WHERE id = ?`)
        .run(verification.authenticationInfo.newCounter, now, passkey.id);

      this.db
        .prepare(`DELETE FROM auth_passkey_challenges WHERE user_id IS NULL AND purpose = 'authenticate'`)
        .run();
    })();

    return this.createSession(passkey.user_id);
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

  private hasPasskeys(): boolean {
    const count = this.db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM auth_passkeys")
      .get()?.count ?? 0;
    return count > 0;
  }

  private pruneExpiredPasskeyChallenges(): void {
    this.db
      .prepare("DELETE FROM auth_passkey_challenges WHERE expires_at <= ?")
      .run(new Date().toISOString());
  }

  private createSession(userId: string): SessionDetails {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMinutes * 60 * 1000).toISOString();

    this.db
      .prepare(`
        INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(randomUUID(), userId, tokenHash, now.toISOString(), expiresAt);

    return { token, expiresAt };
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

      CREATE TABLE IF NOT EXISTS auth_passkeys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_passkey_challenges (
        challenge TEXT PRIMARY KEY,
        user_id TEXT REFERENCES auth_users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_passkey_challenges_expires_at
      ON auth_passkey_challenges (expires_at);
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
