import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Two pages: the game (index.html) and the in-match HUD's own document
 * (hud.html), loaded by the game in a sandboxed iframe (src/hud/host/HudHost.ts).
 * Both share their chunks (three.js…). Everything else: Vite's defaults.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        hud: resolve(root, "hud.html"),
      },
    },
  },
});
