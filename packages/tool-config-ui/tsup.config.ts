import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx", "src/meta.ts"],
  format: ["esm"],
  dts: true,
  outDir: "dist",
  external: [
    "monaco-editor/esm/vs/editor/editor.worker?worker",
    "monaco-editor/esm/vs/language/json/json.worker?worker",
  ],
});
