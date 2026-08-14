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

// `test:v2` runs this check, so these two numbers are a commitment, not a
// note: exceeding them stops the gate for everyone. Raise them only with a
// fresh measurement recorded here, never to get a build through.
// The entry pair measures 331,802 raw / 100,785 gzip, leaving 4,070 raw and
// 1,615 gzip bytes of headroom. Raw binds first, so eagerly importing any of
// the 7 largest lazy chunks (selection bar, export, row menu, drag engine,
// window, image, settings) trips the gate; the other 17 are each under 3.3KB
// raw and slip through. Catching those too needs headroom near 200 bytes,
// which is well below ordinary drift — two weeks of refactoring moved this by
// 573 gzip bytes — and would make the budget a tripwire that gets raised
// reflexively instead of read.
const rawLimit = 328 * 1024;
const gzipLimit = 100 * 1024;
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
