import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
  clearStoredAuth,
  dispatchUnauthorizedEvent,
  isApiRequest,
} from "./hooks/authSession";

declare global {
  interface Window {
    __gloveAuthInterceptorInstalled?: boolean;
  }
}

if (!window.__gloveAuthInterceptorInstalled) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await originalFetch(input, init);

    if (response.status === 401 && isApiRequest(input)) {
      const hadToken = clearStoredAuth();
      if (hadToken) {
        dispatchUnauthorizedEvent();
      }
    }

    return response;
  };

  window.__gloveAuthInterceptorInstalled = true;
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
