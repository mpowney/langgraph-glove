import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface ContentUploadTokenClaims {
  conversationId: string;
  toolName: string;
  issuedAt: string;
  expiresAt: string;
}

export interface IssuedContentUploadToken {
  token: string;
  expiresAt: string;
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Buffer {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function safeParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Stateless short-lived token service used for tool content uploads.
 *
 * Tokens are signed with HMAC-SHA256 and include issuance/expiry timestamps
 * so the gateway can validate them without storing per-token server state.
 */
export class ContentUploadTokenService {
  private readonly secret: Buffer;

  constructor(secret?: Buffer) {
    this.secret = secret ?? randomBytes(32);
  }

  issue(
    claims: Omit<ContentUploadTokenClaims, "issuedAt" | "expiresAt">,
    ttlSeconds = 300,
  ): IssuedContentUploadToken {
    const now = new Date();
    const expiresAtDate = new Date(now.getTime() + ttlSeconds * 1000);
    const payload: ContentUploadTokenClaims = {
      conversationId: claims.conversationId,
      toolName: claims.toolName,
      issuedAt: now.toISOString(),
      expiresAt: expiresAtDate.toISOString(),
    };

    const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
    const signatureEncoded = this.sign(payloadEncoded);
    return {
      token: `${payloadEncoded}.${signatureEncoded}`,
      expiresAt: payload.expiresAt,
    };
  }

  validate(token: string): ContentUploadTokenClaims | null {
    const [payloadEncoded, signatureEncoded] = token.split(".");
    if (!payloadEncoded || !signatureEncoded) return null;

    const expected = this.sign(payloadEncoded);
    const expectedBuffer = Buffer.from(expected, "utf8");
    const actualBuffer = Buffer.from(signatureEncoded, "utf8");
    if (expectedBuffer.length !== actualBuffer.length) return null;
    if (!timingSafeEqual(expectedBuffer, actualBuffer)) return null;

    const payloadRaw = base64UrlDecode(payloadEncoded).toString("utf8");
    const payload = safeParseJson(payloadRaw);
    if (!payload) return null;

    if (typeof payload.conversationId !== "string") return null;
    if (typeof payload.toolName !== "string") return null;
    if (typeof payload.issuedAt !== "string") return null;
    if (typeof payload.expiresAt !== "string") return null;

    const expiresAtMs = Date.parse(payload.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return null;
    if (Date.now() > expiresAtMs) return null;

    return {
      conversationId: payload.conversationId,
      toolName: payload.toolName,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    };
  }

  private sign(payloadEncoded: string): string {
    return base64UrlEncode(
      createHmac("sha256", this.secret)
        .update(payloadEncoded, "utf8")
        .digest(),
    );
  }
}
