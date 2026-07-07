import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"]
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    // Keep vitest's default excludes (node_modules, dist, .git, …) and also
    // skip any nested repo copies under `.claude/worktrees/` so worktree
    // checkouts don't get their test suites scanned and run twice.
    exclude: [...configDefaults.exclude, "**/.claude/**"]
  }
});
