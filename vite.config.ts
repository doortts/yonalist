import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  clearScreen: false,
  build: {
    rolldownOptions: {
      output: {
        // Split the stable vendor graph out of the App chunk so app-code
        // updates do not invalidate the framework bytes (and the App chunk
        // stays under Rollup's 500 kB warning). One combined chunk on
        // purpose: react/base-ui share hoisted deps, so splitting them apart
        // makes Rollup emit circular-chunk warnings. The markdown renderer
        // stays out of this list — it must remain its own lazy chunk.
        codeSplitting: {
          groups: [
            {
              name: "vendor",
              test: /[\\/]node_modules[\\/](?:@base-ui|@floating-ui|lucide-react|react(?:-dom)?|use-sync-external-store)[\\/]/
            },
            {
              name: "notes-dnd",
              test: /[\\/]node_modules[\\/]@dnd-kit[\\/]/
            }
          ]
        }
      }
    }
  },
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
    setupFiles: ["src/test/browser-polyfills.ts", "src/test/setup.ts"],
    // Keep vitest's default excludes (node_modules, dist, .git, …) and also
    // skip any nested repo copies under `.claude/` or `.worktrees/` so
    // worktree checkouts don't get their test suites scanned and run twice.
    // `apps/**` is excluded because these setupFiles are v1's: apps/desktop
    // ships its own vitest config and setup, and running its suites under this
    // one fails on the polyfills they never asked for.
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "**/.worktrees/**",
      "apps/**"
    ]
  }
});
