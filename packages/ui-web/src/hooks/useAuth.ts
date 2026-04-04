import { useCallback, useEffect, useState } from "react";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";

const TOKEN_STORAGE_KEY = "glove.auth.token";
const PASSKEY_PERSONAL_TOKEN_KEY = "glove.auth.passkey.personal_token";

interface AuthStatusPayload {
  setupRequired: boolean;
  minPasswordLength?: number;
  passkeyRegistered?: boolean;
}

interface AuthSessionPayload {
  token: string;
  expiresAt: string;
}

function generatePersonalMemoryToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

interface AuthState {
  loading: boolean;
  setupRequired: boolean;
  authenticated: boolean;
  token: string | null;
  minPasswordLength: number;
  passkeyRegistered: boolean;
  promptPasskeySetup: boolean;
  error: string | null;
}

function parseError(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as Record<string, unknown>)["error"];
  if (typeof error !== "string" || !error.trim()) return fallback;
  return error;
}

function readStoredToken(): string | null {
  const token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  return token?.trim() ? token : null;
}

function storeToken(token: string | null): void {
  if (token) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    return;
  }
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

function readPasskeyPersonalToken(): string | null {
  const token = sessionStorage.getItem(PASSKEY_PERSONAL_TOKEN_KEY);
  return token?.trim() ? token : null;
}

function storePasskeyPersonalToken(token: string | null): void {
  if (token) {
    sessionStorage.setItem(PASSKEY_PERSONAL_TOKEN_KEY, token);
    return;
  }
  sessionStorage.removeItem(PASSKEY_PERSONAL_TOKEN_KEY);
}

async function postJson<T>(url: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      // no-op
    }
    throw new Error(parseError(payload, `HTTP ${res.status}`));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export function useAuth(apiBaseUrl: string | null) {
  const [state, setState] = useState<AuthState>(() => {
    const token = readStoredToken();
    return {
      loading: true,
      setupRequired: false,
      authenticated: Boolean(token),
      token,
      minPasswordLength: 12,
      passkeyRegistered: false,
      promptPasskeySetup: false,
      error: null,
    };
  });

  const refreshStatus = useCallback(async () => {
    if (apiBaseUrl === null) return;

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/status`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await res.json() as AuthStatusPayload;
      const token = readStoredToken();
      setState((prev) => {
        const setupRequired = Boolean(payload.setupRequired);
        const passkeyRegistered = Boolean(payload.passkeyRegistered);
        return {
          loading: false,
          setupRequired,
          authenticated: Boolean(token) && !setupRequired,
          token: setupRequired ? null : token,
          minPasswordLength: payload.minPasswordLength ?? 12,
          passkeyRegistered,
          // Keep prompting only while setup is complete and no passkey exists.
          promptPasskeySetup: !setupRequired && !passkeyRegistered && prev.promptPasskeySetup,
          error: null,
        };
      });

      if (payload.setupRequired && token) {
        storeToken(null);
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const login = useCallback(async (password: string) => {
    if (apiBaseUrl === null) return false;

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const payload = await postJson<AuthSessionPayload>(`${apiBaseUrl}/api/auth/login`, { password });
      storeToken(payload.token);
      setState((prev) => ({
        ...prev,
        loading: false,
        setupRequired: false,
        authenticated: true,
        token: payload.token,
        promptPasskeySetup: false,
        error: null,
      }));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({
        ...prev,
        loading: false,
        authenticated: false,
        token: null,
        error: message,
      }));

      // If auth was reset elsewhere, force a status refresh so the UI returns
      // to the setup flow instead of staying on the password login view.
      if (message.toLowerCase().includes("setup is not complete")) {
        void refreshStatus();
      }

      return false;
    }
  }, [apiBaseUrl, refreshStatus]);

  const setup = useCallback(async (setupToken: string, password?: string) => {
    if (apiBaseUrl === null) return false;

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const payload = await postJson<AuthSessionPayload>(`${apiBaseUrl}/api/auth/setup`, {
        setupToken,
        ...(password?.trim() ? { password } : {}),
      });
      storeToken(payload.token);
      setState((prev) => ({
        ...prev,
        loading: false,
        setupRequired: false,
        authenticated: true,
        token: payload.token,
        promptPasskeySetup: true,
        error: null,
      }));
      return true;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        authenticated: false,
        token: null,
        error: err instanceof Error ? err.message : String(err),
      }));
      return false;
    }
  }, [apiBaseUrl]);

  const logout = useCallback(async () => {
    if (apiBaseUrl === null) return;

    const token = readStoredToken();
    if (token) {
      try {
        await postJson<void>(`${apiBaseUrl}/api/auth/logout`, {}, token);
      } catch {
        // Best effort token revocation.
      }
    }

    storeToken(null);
    storePasskeyPersonalToken(null);
    setState((prev) => ({
      ...prev,
      authenticated: false,
      token: null,
      promptPasskeySetup: false,
      error: null,
    }));
  }, [apiBaseUrl]);

  const registerPasskey = useCallback(async () => {
    if (apiBaseUrl === null) return false;
    const token = readStoredToken();
    if (!token) return false;

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const optionsRes = await fetch(`${apiBaseUrl}/api/auth/passkey/register/begin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      if (!optionsRes.ok) {
        const payload = await optionsRes.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(parseError(payload, `HTTP ${optionsRes.status}`));
      }
      const options = await optionsRes.json();

      const registrationResponse = await startRegistration({ optionsJSON: options });

      await postJson<{ credentialId: string }>(
        `${apiBaseUrl}/api/auth/passkey/register/complete`,
        registrationResponse as unknown as Record<string, unknown>,
        token,
      );

      setState((prev) => ({
        ...prev,
        loading: false,
        passkeyRegistered: true,
        promptPasskeySetup: false,
        error: null,
      }));
      return true;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      return false;
    }
  }, [apiBaseUrl]);

  const completePasskeyAuthenticationFlow = useCallback(async () => {
    if (apiBaseUrl === null) {
      throw new Error("Auth API is unavailable");
    }

    const optionsRes = await fetch(`${apiBaseUrl}/api/auth/passkey/authenticate/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!optionsRes.ok) {
      const payload = await optionsRes.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(parseError(payload, `HTTP ${optionsRes.status}`));
    }
    const options = await optionsRes.json();

    const authResponse = await startAuthentication({ optionsJSON: options });

    return postJson<AuthSessionPayload>(
      `${apiBaseUrl}/api/auth/passkey/authenticate/complete`,
      authResponse as unknown as Record<string, unknown>,
    );
  }, [apiBaseUrl]);

  const loginWithPasskey = useCallback(async () => {
    if (apiBaseUrl === null) return false;

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const session = await completePasskeyAuthenticationFlow();

      storeToken(session.token);
      setState((prev) => ({
        ...prev,
        loading: false,
        setupRequired: false,
        authenticated: true,
        token: session.token,
        promptPasskeySetup: false,
        error: null,
      }));
      return true;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        authenticated: false,
        token: null,
        error: err instanceof Error ? err.message : String(err),
      }));
      return false;
    }
  }, [apiBaseUrl, completePasskeyAuthenticationFlow]);

  const generatePersonalTokenWithPasskey = useCallback(async () => {
    try {
      const session = await completePasskeyAuthenticationFlow();
      storeToken(session.token);

      let personalToken = readPasskeyPersonalToken();
      if (!personalToken) {
        personalToken = generatePersonalMemoryToken();
        storePasskeyPersonalToken(personalToken);
      }

      setState((prev) => ({
        ...prev,
        authenticated: true,
        token: session.token,
        setupRequired: false,
        promptPasskeySetup: false,
        error: null,
      }));
      return personalToken;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  }, [completePasskeyAuthenticationFlow]);

  const dismissPasskeySetupPrompt = useCallback(() => {
    setState((prev) => ({ ...prev, promptPasskeySetup: false }));
  }, []);

  return {
    ...state,
    refreshStatus,
    login,
    setup,
    logout,
    registerPasskey,
    loginWithPasskey,
    generatePersonalTokenWithPasskey,
    dismissPasskeySetupPrompt,
  };
}
