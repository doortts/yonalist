import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { readMonacoBundleReport } from "./reportMonacoBundle.mjs";

test("attributes shared entry assets once and reports Monaco worker cost", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yonalist-monaco-bundle-"));
  try {
    await mkdir(path.join(root, ".vite"), { recursive: true });
    await mkdir(path.join(root, "assets"), { recursive: true });
    const manifest = {
      "_shared.js": {
        file: "assets/shared.js"
      },
      "index.html": {
        file: "assets/index.js",
        isEntry: true,
        imports: ["_shared.js"],
        dynamicImports: ["src/monaco-outline/runtime.ts"]
      },
      "src/monaco-outline/runtime.ts": {
        file: "assets/runtime-monaco.js",
        isDynamicEntry: true,
        imports: ["_shared.js"],
        css: ["assets/runtime-monaco.css"]
      }
    };
    await writeFile(
      path.join(root, ".vite", "manifest.json"),
      JSON.stringify(manifest)
    );
    await writeFile(path.join(root, "assets", "index.js"), "i".repeat(200));
    await writeFile(path.join(root, "assets", "shared.js"), "s".repeat(100));
    await writeFile(
      path.join(root, "assets", "runtime-monaco.js"),
      "m".repeat(900)
    );
    await writeFile(
      path.join(root, "assets", "runtime-monaco.css"),
      "c".repeat(100)
    );
    await writeFile(
      path.join(root, "assets", "editor.worker-example.js"),
      "w".repeat(200)
    );

    const report = await readMonacoBundleReport({ root });

    expect(report).toEqual({
      initialJavaScript: { raw: 300, gzip: 48 },
      monacoJavaScript: { raw: 900, gzip: 29 },
      monacoCss: { raw: 100, gzip: 24 },
      workers: { raw: 200 },
      largestMonacoAssets: [{ file: "assets/runtime-monaco.js", raw: 900 }]
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
