import { Buffer } from "node:buffer";
import type { McpAuthConfig } from "@langgraph-glove/config";

export interface AuthRequestContext {
  headers: Record<string, string>;
  query: Record<string, string>;
}

export interface AuthProvider {
  getRequestContext(): Promise<AuthRequestContext>;
}

class StaticAuthProvider implements AuthProvider {
  constructor(private readonly context: AuthRequestContext) {}

  async getRequestContext(): Promise<AuthRequestContext> {
    return this.context;
  }
}

class OAuthClientCredentialsProvider implements AuthProvider {
  private accessToken = "";
  private expiresAt = 0;

  constructor(
    private readonly tokenUrl: string,
    private readonly params: URLSearchParams,
  ) {}

  async getRequestContext(): Promise<AuthRequestContext> {
    if (!this.accessToken || Date.now() >= this.expiresAt) {
      await this.refreshToken();
    }

    return {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
      query: {},
    };
  }

  private async refreshToken(): Promise<void> {
    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: this.params,
    });

    if (!response.ok) {
      throw new Error(`OAuth token endpoint failed (${response.status})`);
    }

    const body = (await response.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    };

    if (!body.access_token) {
      throw new Error("OAuth token endpoint did not return access_token");
    }

    this.accessToken = body.access_token;
    const expiresInMs = Math.max(30_000, Number(body.expires_in ?? 300) * 1000);
    this.expiresAt = Date.now() + expiresInMs - 10_000;
  }
}

interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
}

class OAuthDeviceCodeProvider implements AuthProvider {
  private accessToken = "";
  private expiresAt = 0;
  private grant: DeviceGrant | null = null;

  constructor(
    private readonly deviceCodeUrl: string,
    private readonly tokenUrl: string,
    private readonly deviceCodeParams: URLSearchParams,
    private readonly tokenParams: URLSearchParams,
    private readonly pollTimeoutMs: number,
  ) {}

  async getRequestContext(): Promise<AuthRequestContext> {
    if (!this.accessToken || Date.now() >= this.expiresAt) {
      await this.ensureToken();
    }

    return {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
      query: {},
    };
  }

  private async ensureToken(): Promise<void> {
    if (!this.grant || Date.now() >= this.grant.expiresAt) {
      this.grant = await this.requestDeviceCode();
      const destination = this.grant.verificationUriComplete ?? this.grant.verificationUri;
      // This log is intentionally explicit so operators can complete device auth.
      console.warn(
        `MCP OAuth device login required. Visit ${destination} and enter code ${this.grant.userCode}`,
      );
    }

    const deadline = Math.min(this.grant.expiresAt, Date.now() + this.pollTimeoutMs);
    let intervalMs = this.grant.intervalMs;

    while (Date.now() < deadline) {
      const result = await this.tryPollToken(this.grant.deviceCode);
      if (result.type === "success") {
        this.accessToken = result.accessToken;
        const expiresInMs = Math.max(30_000, result.expiresIn * 1000);
        this.expiresAt = Date.now() + expiresInMs - 10_000;
        return;
      }

      if (result.type === "slow-down") {
        intervalMs += 5_000;
      } else if (result.type === "fatal") {
        this.grant = null;
        throw new Error(result.message);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    this.grant = null;
    throw new Error("OAuth device authorization timed out");
  }

  private async requestDeviceCode(): Promise<DeviceGrant> {
    const response = await fetch(this.deviceCodeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: this.deviceCodeParams,
    });

    if (!response.ok) {
      throw new Error(`OAuth device code endpoint failed (${response.status})`);
    }

    const body = (await response.json()) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      expires_in?: number;
      interval?: number;
    };

    if (!body.device_code || !body.user_code || !body.verification_uri) {
      throw new Error("OAuth device code response missing required fields");
    }

    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      verificationUriComplete: body.verification_uri_complete,
      expiresAt: Date.now() + Math.max(120, Number(body.expires_in ?? 900)) * 1000,
      intervalMs: Math.max(1, Number(body.interval ?? 5)) * 1000,
    };
  }

  private async tryPollToken(deviceCode: string): Promise<
    | { type: "success"; accessToken: string; expiresIn: number }
    | { type: "pending" }
    | { type: "slow-down" }
    | { type: "fatal"; message: string }
  > {
    const pollBody = new URLSearchParams(this.tokenParams);
    pollBody.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
    pollBody.set("device_code", deviceCode);

    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: pollBody,
    });

    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (response.ok && body.access_token) {
      return {
        type: "success",
        accessToken: body.access_token,
        expiresIn: Number(body.expires_in ?? 300),
      };
    }

    if (body.error === "authorization_pending") {
      return { type: "pending" };
    }
    if (body.error === "slow_down") {
      return { type: "slow-down" };
    }

    return {
      type: "fatal",
      message: body.error_description ?? body.error ?? "OAuth device token polling failed",
    };
  }
}

export function createAuthProvider(auth?: McpAuthConfig): AuthProvider | undefined {
  if (!auth) return undefined;

  if (auth.mode === "bearer-static") {
    return new StaticAuthProvider({
      headers: {
        Authorization: `Bearer ${auth.token}`,
      },
      query: {},
    });
  }

  if (auth.mode === "api-key") {
    const location = auth.location ?? "header";
    const keyName = auth.name ?? (location === "query" ? "api_key" : "x-api-key");
    if (location === "query") {
      return new StaticAuthProvider({
        headers: {},
        query: {
          [keyName]: auth.apiKey,
        },
      });
    }

    return new StaticAuthProvider({
      headers: {
        [keyName]: auth.apiKey,
      },
      query: {},
    });
  }

  if (auth.mode === "basic") {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64");
    return new StaticAuthProvider({
      headers: {
        Authorization: `Basic ${encoded}`,
      },
      query: {},
    });
  }

  if (auth.mode === "oauth-client-credentials") {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
    });

    if (auth.scope) params.set("scope", auth.scope);
    if (auth.audience) params.set("audience", auth.audience);
    for (const [key, value] of Object.entries(auth.extraTokenParams ?? {})) {
      params.set(key, value);
    }

    return new OAuthClientCredentialsProvider(auth.tokenUrl, params);
  }

  const deviceCodeParams = new URLSearchParams({
    client_id: auth.clientId,
  });
  const tokenParams = new URLSearchParams({
    client_id: auth.clientId,
  });

  if (auth.clientSecret) tokenParams.set("client_secret", auth.clientSecret);
  if (auth.scope) deviceCodeParams.set("scope", auth.scope);
  if (auth.audience) deviceCodeParams.set("audience", auth.audience);

  for (const [key, value] of Object.entries(auth.extraDeviceCodeParams ?? {})) {
    deviceCodeParams.set(key, value);
  }
  for (const [key, value] of Object.entries(auth.extraTokenParams ?? {})) {
    tokenParams.set(key, value);
  }

  return new OAuthDeviceCodeProvider(
    auth.deviceCodeUrl,
    auth.tokenUrl,
    deviceCodeParams,
    tokenParams,
    auth.pollTimeoutMs ?? 120_000,
  );
}
