import { defineConfig } from "vitest/config";

// The build and CI scripts in `scripts/` are the only thing left at the root
// that has tests of its own — the app's own suite lives in `apps/yonalist`. They
// read files and shell out, so they need no browser environment.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["scripts/**/*.test.ts"]
  }
});
