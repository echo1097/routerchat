import { defineConfig } from "vite";

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
});
