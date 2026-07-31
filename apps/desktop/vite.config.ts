import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const runtimeProbeModuleId =
  "virtual:yonalist-monaco-runtime-probe";
const resolvedRuntimeProbeModuleId = `\0${runtimeProbeModuleId}`;

export default defineConfig(({ command }) => ({
  base: "./",
  root: __dirname,
  plugins: [
    {
      name: "yonalist-monaco-runtime-probe",
      resolveId(id) {
        return id === runtimeProbeModuleId
          ? resolvedRuntimeProbeModuleId
          : null;
      },
      load(id) {
        if (id !== resolvedRuntimeProbeModuleId) return null;
        if (command !== "serve") {
          return "export function attachDevelopmentRuntimeProbe() { return null; }";
        }
        return `
          import { attachRuntimeProbe } from "/src/monaco-outline/runtimeProbe.ts";
          export function attachDevelopmentRuntimeProbe(editor, session) {
            if (new URLSearchParams(location.search).get("probe") !== "monaco") {
              return null;
            }
            return attachRuntimeProbe(editor, session);
          }
        `;
      }
    },
    react()
  ],
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
    setupFiles: ["src/test/setup.ts"]
  }
}));
