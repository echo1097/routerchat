import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "frontend",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  test: {
    dir: resolve(configDir, "tests/frontend"),
  },
});
