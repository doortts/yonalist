import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "apps", "desktop", "dist");
const manifestPath = join(dist, ".vite", "manifest.json");
if (!existsSync(manifestPath)) {
  throw new Error("v2 bundle manifest is missing; run npm run v2:build first");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
if (!entry) throw new Error("v2 bundle has no production entry");

const files = new Set();
function collect(chunk) {
  if (!chunk || files.has(chunk.file)) return;
  files.add(chunk.file);
  for (const imported of chunk.imports ?? []) collect(manifest[imported]);
}
collect(entry);

let raw = 0;
let gzip = 0;
for (const file of files) {
  const bytes = readFileSync(join(dist, file));
  raw += bytes.length;
  gzip += gzipSync(bytes).length;
}

const rawLimit = 300 * 1024;
const gzipLimit = 90 * 1024;
if (raw > rawLimit || gzip > gzipLimit) {
  throw new Error(
    `v2 editable JS ${raw} raw / ${gzip} gzip exceeds ` +
      `${rawLimit} raw / ${gzipLimit} gzip`
  );
}

const assetDirectory = join(dist, "assets");
for (const entryName of readdirSync(assetDirectory)) {
  const path = join(assetDirectory, entryName);
  if (!statSync(path).isFile() || !entryName.endsWith(".js")) continue;
  const source = readFileSync(path, "utf8");
  if (source.includes("yonalist-v2-browser-preview")) {
    throw new Error(`development preview code leaked into production: ${entryName}`);
  }
}

console.log(
  `v2 editable JS PASS (${(raw / 1024).toFixed(1)}KB raw / ` +
    `${(gzip / 1024).toFixed(1)}KB gzip)`
);
