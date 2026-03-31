import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the compiled Vite SPA assets (`dist/app/`).
 * Use with `express.static(distPath)` in WebChannel.
 */
export const distPath = join(__dirname, "..", "app");
