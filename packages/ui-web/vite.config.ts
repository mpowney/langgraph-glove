import { monitorEventLoopDelay } from "node:perf_hooks";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDiagnosticsEnabled = process.env["VITE_DEV_DIAGNOSTICS"] !== "0";
const requestSlowMs = Number(process.env["VITE_DEV_REQUEST_SLOW_MS"] ?? "1500");
const eventLoopLagWarnMs = Number(process.env["VITE_DEV_EVENT_LOOP_WARN_MS"] ?? "200");

function createProxyOptions(target: string, label: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    timeout: 15_000,
    proxyTimeout: 15_000,
    configure(proxy) {
      proxy.on("error", (err, req) => {
        const method = req.method ?? "UNKNOWN";
        const url = req.url ?? "(unknown url)";
        console.error(`[vite:proxy:${label}] ${method} ${url} failed: ${err.message}`);
      });

      proxy.on("proxyReq", (_proxyReq, req) => {
        if (!isDiagnosticsEnabled) return;
        const method = req.method ?? "UNKNOWN";
        const url = req.url ?? "(unknown url)";
        console.log(`[vite:proxy:${label}] -> ${method} ${url}`);
      });

      proxy.on("proxyRes", (proxyRes, req) => {
        if (!isDiagnosticsEnabled) return;
        const method = req.method ?? "UNKNOWN";
        const url = req.url ?? "(unknown url)";
        console.log(`[vite:proxy:${label}] <- ${proxyRes.statusCode ?? "?"} ${method} ${url}`);
      });
    },
  };
}

function devDiagnosticsPlugin(): Plugin {
  return {
    name: "dev-diagnostics",
    configureServer(server) {
      if (!isDiagnosticsEnabled) return;

      const loopMonitor = monitorEventLoopDelay({ resolution: 20 });
      loopMonitor.enable();

      const pending = new Map<number, { startedAtMs: number; method: string; url: string }>();
      let requestId = 0;

      server.middlewares.use((req, res, next) => {
        const id = ++requestId;
        const method = req.method ?? "UNKNOWN";
        const url = req.url ?? "(unknown url)";
        const startedAtMs = Date.now();
        pending.set(id, { startedAtMs, method, url });

        let settled = false;
        const finalize = (event: "finish" | "close") => {
          if (settled) return;
          settled = true;
          const tracked = pending.get(id);
          pending.delete(id);
          if (!tracked) return;

          const elapsedMs = Date.now() - tracked.startedAtMs;
          const status = res.statusCode;
          const base = `[vite:req] ${tracked.method} ${tracked.url} -> ${status} in ${elapsedMs}ms (pending=${pending.size})`;
          if (elapsedMs >= requestSlowMs) {
            console.warn(`${base} [slow:${event}]`);
          } else {
            console.log(base);
          }
        };

        res.once("finish", () => finalize("finish"));
        res.once("close", () => finalize("close"));
        next();
      });

      const loopInterval = setInterval(() => {
        const maxLagMs = Math.round(loopMonitor.max / 1e6);
        if (maxLagMs >= eventLoopLagWarnMs) {
          console.warn(
            `[vite:event-loop] max lag ${maxLagMs}ms over last 5s (pending=${pending.size})`,
          );
        }
        loopMonitor.reset();
      }, 5000);

      server.httpServer?.once("close", () => {
        clearInterval(loopInterval);
        loopMonitor.disable();
      });

      server.httpServer?.on("clientError", (err, socket) => {
        console.error(`[vite:http] clientError: ${err.message}`);
        if (!socket.destroyed) {
          socket.destroy();
        }
      });

      console.log(
        `[vite:diagnostics] enabled (slowRequest>=${requestSlowMs}ms, eventLoopWarn>=${eventLoopLagWarnMs}ms)`,
      );
    },
  };
}

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
  plugins: [react(), devDiagnosticsPlugin()],
  resolve: {
    alias: {
      "@langgraph-glove/ui-shared": path.resolve(__dirname, "../ui-shared/src/index.ts"),
      "@langgraph-glove/tool-imap-ui/meta": path.resolve(__dirname, "../tool-imap-ui/src/meta.ts"),
      "@langgraph-glove/tool-memory-ui/meta": path.resolve(__dirname, "../tool-memory-ui/src/meta.ts"),
      "@langgraph-glove/tool-config-ui/meta": path.resolve(__dirname, "../tool-config-ui/src/meta.ts"),
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
              ...createProxyOptions(toolsTarget, "tools"),
            },
            "/api/agents": {
              ...createProxyOptions(toolsTarget, "agents"),
            },
            "/api/auth": {
              ...createProxyOptions(toolsTarget, "auth"),
            },
            "/api/conversations": {
              ...createProxyOptions(toolsTarget, "conversations"),
            },
            "/api/content": {
              ...createProxyOptions(toolsTarget, "content"),
            },
            "/api/topology": {
              ...createProxyOptions(toolsTarget, "topology"),
            },
            "/api/feedback": {
              ...createProxyOptions(toolsTarget, "feedback"),
            },
            "/api/imap": {
              ...createProxyOptions(toolsTarget, "imap"),
            },
            "/api/internal": {
              ...createProxyOptions(toolsTarget, "internal"),
            },
            "/api/secrets": {
              ...createProxyOptions(toolsTarget, "secrets"),
            },
          }
        : {}),
      // Forward remaining /api/* routes to the backend server in dev mode.
      // The backend port is read from VITE_WS_URL (e.g. ws://localhost:8080)
      // and falls back to port 8080.
      "/api": {
        ...createProxyOptions(resolveApiTarget(), "default"),
      },
    },
  },
  preview: {
    host: "0.0.0.0",
  },
});
