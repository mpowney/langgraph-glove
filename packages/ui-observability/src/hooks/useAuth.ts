import { useCallback, useEffect, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { AUTH_TOKEN_STORAGE_KEY, AUTH_UNAUTHORIZED_EVENT } from "./authSession";

interface AuthStatusPayload {
  setupRequired: boolean;
}

interface AuthSessionPayload {
  token: string;
  expiresAt: string;
}

interface AuthState {
  loading: boolean;
  setupRequired: boolean;
  authenticated: boolean;
  token: string | null;
  error: string | null;
}

function parseError(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as Record<string, unknown>)["error"];
  if (typeof error !== "string" || !error.trim()) return fallback;
  return error;
}

function readStoredToken(): string | null {
  const token = sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  return token?.trim() ? token : null;
}

function storeToken(token: string | null): void {
  if (token) {
    sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    return;
  }
  sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

async function postJson<T>(url: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
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
      const payload = (await res.json()) as AuthStatusPayload;
      const token = readStoredToken();
      const setupRequired = Boolean(payload.setupRequired);
      setState({
        loading: false,
        setupRequired,
        authenticated: Boolean(token) && !setupRequired,
        token: setupRequired ? null : token,
        error: null,
      });
      if (setupRequired && token) {
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

  useEffect(() => {
    const handleUnauthorized = () => {
      setState((prev) => ({
        ...prev,
        loading: false,
        authenticated: false,
        token: null,
        error: null,
      }));
    };

    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => {
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    };
  }, []);

  const login = useCallback(async (password: string) => {
    if (apiBaseUrl === null) return false;

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const payload = await postJson<AuthSessionPayload>(`${apiBaseUrl}/api/auth/login`, { password });
      storeToken(payload.token);
      setState({
        loading: false,
        setupRequired: false,
        authenticated: true,
        token: payload.token,
        error: null,
      });
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

  const loginWithPasskey = useCallback(async () => {
    if (apiBaseUrl === null) return false;

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const beginRes = await fetch(`${apiBaseUrl}/api/auth/passkey/authenticate/begin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!beginRes.ok) {
        const payload = (await beginRes.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(parseError(payload, `HTTP ${beginRes.status}`));
      }

      const options = await beginRes.json();
      const assertionResponse = await startAuthentication({ optionsJSON: options });
      const session = await postJson<AuthSessionPayload>(
        `${apiBaseUrl}/api/auth/passkey/authenticate/complete`,
        assertionResponse as unknown as Record<string, unknown>,
      );

      storeToken(session.token);
      setState((prev) => ({
        ...prev,
        loading: false,
        setupRequired: false,
        authenticated: true,
        token: session.token,
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
        // Best effort token revoke.
      }
    }

    storeToken(null);
    setState((prev) => ({
      ...prev,
      authenticated: false,
      token: null,
      error: null,
    }));
  }, [apiBaseUrl]);

  return {
    ...state,
    refreshStatus,
    login,
    loginWithPasskey,
    logout,
  };
}
