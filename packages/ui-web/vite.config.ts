import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/app",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Forward /api/* to the backend server in dev mode.
      // The backend port is read from VITE_WS_URL (e.g. ws://localhost:8080)
      // and falls back to port 8080.
      "/api": {
        target: process.env["VITE_WS_URL"]
          ? process.env["VITE_WS_URL"].replace(/^wss?/, "http")
          : "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
