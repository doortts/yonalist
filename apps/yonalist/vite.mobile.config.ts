import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { renameSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The entry is `index.mobile.html` in the source tree so it sits beside the
 * desktop one and says which is which. It has to land as `index.html`: the
 * webview asks for that name, and the name is decided in Rust where the window
 * is built, which is one place for both platforms.
 */
function entryNamedIndex(outDir: string): Plugin {
  return {
    name: "yonalist-mobile-entry",
    closeBundle() {
      renameSync(resolve(outDir, "index.mobile.html"), resolve(outDir, "index.html"));
    }
  };
}

/**
 * The phone build. Separate from the desktop one for two reasons: the bundle
 * budget reads `dist/assets` whole and would otherwise weigh two apps' chunks
 * as one, and the desktop bundle has about a kilobyte of headroom left, which
 * a second shell would spend in its first import.
 */
export default defineConfig({
  base: "./",
  root: __dirname,
  plugins: [react(), entryNamedIndex(resolve(__dirname, "dist-mobile"))],
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
