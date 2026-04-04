import { useCallback, useEffect, useState } from "react";

const TOKEN_STORAGE_KEY = "glove.auth.token";

interface AuthStatusPayload {
  setupRequired: boolean;
  minPasswordLength?: number;
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
  minPasswordLength: number;
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
      setState({
        loading: false,
        setupRequired: Boolean(payload.setupRequired),
        authenticated: Boolean(token) && !payload.setupRequired,
        token: payload.setupRequired ? null : token,
        minPasswordLength: payload.minPasswordLength ?? 12,
        error: null,
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

  const setup = useCallback(async (setupToken: string, password: string) => {
    if (apiBaseUrl === null) return false;

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const payload = await postJson<AuthSessionPayload>(`${apiBaseUrl}/api/auth/setup`, {
        setupToken,
        password,
      });
      storeToken(payload.token);
      setState((prev) => ({
        ...prev,
        loading: false,
        setupRequired: false,
        authenticated: true,
        token: payload.token,
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
    setup,
    logout,
  };
}
