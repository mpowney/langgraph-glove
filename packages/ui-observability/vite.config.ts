import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function resolveApiTarget(): string {
  const apiUrl = process.env["VITE_API_URL"] ?? "http://127.0.0.1:8081";

  try {
    const url = new URL(apiUrl);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    }
    return url.toString();
  } catch {
    return apiUrl.replace("localhost", "127.0.0.1");
  }
}

const apiTarget = resolveApiTarget();

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/app",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5174,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
  },
});
