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
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /[\\/]node_modules[\\/](?:react|react-dom)[\\/]/
            },
            {
              name: "icons",
              test: /[\\/]node_modules[\\/]lucide-react[\\/]/
            }
          ]
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"]
  }
});
