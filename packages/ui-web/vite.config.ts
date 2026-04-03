import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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

function resolveMemoryToolTarget(): string | null {
  const memoryToolUrl = process.env["VITE_MEMORY_TOOL_URL"];
  if (!memoryToolUrl) return null;

  try {
    const url = new URL(memoryToolUrl);
    return url.toString();
  } catch {
    return memoryToolUrl.replace("localhost", "127.0.0.1");
  }
}

const memoryToolTarget = resolveMemoryToolTarget();

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/app",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Forward all /api/* routes to the backend server in dev mode.
      // The backend port is read from VITE_WS_URL (e.g. ws://localhost:8080)
      // and falls back to port 8080.
      "/api": {
        target: resolveApiTarget(),
        changeOrigin: true,
      },
      ...(memoryToolTarget
        ? {
            "/_memory_tool": {
              target: memoryToolTarget,
              changeOrigin: true,
              rewrite: (path: string) => path.replace(/^\/_memory_tool/, ""),
            },
          }
        : {}),
    },
  },
});
