import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveApiTarget(): string {
  const wsUrl = process.env["VITE_WS_URL"];
  if (!wsUrl) return "http://127.0.0.1:8080";

  try {
    const url = new URL(wsUrl);
    // Use http(s) for the Vite proxy target and prefer IPv4 loopback over ::1.
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    }
    return url.toString();
  } catch {
    // Fallback for malformed values while keeping backward compatibility.
    return wsUrl.replace(/^wss?/, "http").replace("localhost", "127.0.0.1");
  }
}

function resolveToolsTarget(): string | null {
  const adminApiUrl = process.env["VITE_API_URL"] ?? "http://127.0.0.1:8081";

  try {
    const url = new URL(adminApiUrl);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    }
    return url.toString();
  } catch {
    return adminApiUrl.replace("localhost", "127.0.0.1");
  }
}

const toolsTarget = resolveToolsTarget();

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@langgraph-glove/ui-shared": path.resolve(__dirname, "../ui-shared/src/index.ts"),
      "@langgraph-glove/tool-imap-ui": path.resolve(__dirname, "../tool-imap-ui/src/index.tsx"),
      "@langgraph-glove/tool-memory-ui": path.resolve(__dirname, "../tool-memory-ui/src/index.tsx"),
      "@langgraph-glove/tool-config-ui": path.resolve(__dirname, "../tool-config-ui/src/index.tsx"),
    },
  },
  build: {
    outDir: "dist/app",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      ...(toolsTarget
        ? {
            // AdminApi routes exposed on port 8081.
            // Example: /api/tools/_memory/rpc -> http://127.0.0.1:8081/api/tools/_memory/rpc
            "/api/tools": {
              target: toolsTarget,
              changeOrigin: true,
            },
            "/api/agents": {
              target: toolsTarget,
              changeOrigin: true,
            },
            "/api/auth": {
              target: toolsTarget,
              changeOrigin: true,
            },
            "/api/conversations": {
              target: toolsTarget,
              changeOrigin: true,
            },
            "/api/content": {
              target: toolsTarget,
              changeOrigin: true,
            },
            "/api/topology": {
              target: toolsTarget,
              changeOrigin: true,
            },
            "/api/feedback": {
              target: toolsTarget,
              changeOrigin: true,
            },
            "/api/imap": {
              target: toolsTarget,
              changeOrigin: true,
            },
            "/api/internal": {
              target: toolsTarget,
              changeOrigin: true,
            },
            "/api/secrets": {
              target: toolsTarget,
              changeOrigin: true,
            },
          }
        : {}),
      // Forward remaining /api/* routes to the backend server in dev mode.
      // The backend port is read from VITE_WS_URL (e.g. ws://localhost:8080)
      // and falls back to port 8080.
      "/api": {
        target: resolveApiTarget(),
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
  },
});
