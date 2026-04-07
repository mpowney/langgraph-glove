export const AUTH_TOKEN_STORAGE_KEY = "glove.auth.token";
export const PASSKEY_PERSONAL_TOKEN_STORAGE_KEY = "glove.auth.passkey.personal_token";
export const AUTH_UNAUTHORIZED_EVENT = "glove.auth.unauthorized";

function extractRequestUrl(input: RequestInfo | URL): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return null;
}

export function isApiRequest(input: RequestInfo | URL): boolean {
  const rawUrl = extractRequestUrl(input);
  if (!rawUrl) return false;

  try {
    const url = new URL(rawUrl, window.location.origin);
    return url.pathname === "/api" || url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

export function clearStoredAuth(): boolean {
  const hadToken = Boolean(sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY));
  sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  sessionStorage.removeItem(PASSKEY_PERSONAL_TOKEN_STORAGE_KEY);
  return hadToken;
}

export function dispatchUnauthorizedEvent(): void {
  window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
}