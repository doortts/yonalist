import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false
  },
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    // Stays above asyncUtilTimeout so a starved wait reports as itself, with its
    // DOM dump, instead of being killed as an opaque test timeout.
    testTimeout: 30_000
  }
});
