import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * The phone build. Separate from the desktop one for two reasons: the bundle
 * budget reads `dist/assets` whole and would otherwise weigh two apps' chunks
 * as one, and the desktop bundle has about a kilobyte of headroom left, which
 * a second shell would spend in its first import.
 */
export default defineConfig({
  base: "./",
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: "dist-mobile",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    rollupOptions: { input: resolve(__dirname, "index.mobile.html") }
  },
  server: {
    host: "127.0.0.1",
    port: 1422,
    strictPort: true
  }
});
