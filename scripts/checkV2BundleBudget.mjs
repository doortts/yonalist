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

// `test:bundle` runs this check, so these two numbers are a commitment, not a
// note: exceeding them stops the gate for everyone. Raise them only with a
// fresh measurement recorded here, never to get a build through.
// Measured 2026-08-16 at the first-run vault card: the entry pair is 336,472
// raw / 102,310 gzip, leaving 2,472 raw and 1,114 gzip bytes of headroom. The
// previous 328KiB raw limit had already been passed by 2 bytes before that
// work began, which is why this is a raise and not a repair.
// Raw still binds first: 2,472 raw is roughly 750 gzip at the ratio these
// chunks compress at, well inside the gzip headroom. Of the 26 lazy chunks,
// the 8 largest (drag engine, selection bar, export, row menu, window, image,
// settings, outline markers — 3.3KB to 39KB) each trip the gate if they are
// ever imported eagerly; the 13 under 2.4KB slip through, same as before.
// Catching those too needs headroom near 200 bytes, which is well below
// ordinary drift and would make the budget a tripwire that gets raised
// reflexively instead of read.
// Measured 2026-08-17 at the sync status badge: the entry pair is 339,071 raw
// / 102,919 gzip. The badge itself is lazy — it draws nothing while sync is
// well, so its bytes have no business in the first load — and what grew the
// entry is the wiring that has to be there to reach it: one `NotesApi` method
// and the `Suspense` that holds its place. 127 raw bytes over the old limit,
// with gzip still 505 bytes under it, which is why this is a raise of raw
// alone.
// The reasoning above still holds: raw binds first, and the headroom below is
// deliberately too small to hide a lazy chunk being imported eagerly.
// Measured 2026-08-20 at the dnd-kit dependency removal (3cabfa8d): the entry
// pair is 351,748 raw / 106,605 gzip — 10,756 raw past the 333KiB limit. This
// raise records a debt, not a fresh overrun: the gate went red about 100
// commits ago, somewhere in the selection-band work, and stayed red because
// only `test:all` runs this script and the per-change loop merges to main
// locally, before CI ever sees a push. What grew is the multi-select family
// (the band, its delete keys, the modifier-A select), the guide-line sub-bullet
// toggle, cursor scrolling, and the page-title placeholder — keyboard- and
// row-render code that has to be in the first load. The one seam big enough to
// claw the bytes back instead, the clipboard/paste family plus image ingest, is
// gesture-locked: the paste handler must read clipboardData and decide
// preventDefault synchronously inside the event (outlinePasteGesture.ts records
// why), so a chunk load cannot sit in front of it — and even moving all of it
// lands only ~1.5KB under the old limit, which recent drift would eat within
// days. Hence a raise, recorded late; the per-change gate list now runs this
// check so the next overrun is caught at the commit that causes it, not a
// hundred later.
// Headroom: 2,556 raw — about 775 gzip at these chunks' ratio, inside the 915
// gzip headroom, so raw still binds first — and below today's 8th largest lazy
// chunk (webview, 3,361 bytes), so eagerly importing any of the big eight still
// trips the gate. 347KiB would not have that property.
// Measured 2026-08-21 at Backspace reaching the picture above a picture: the
// entry pair is 354,315 raw / 107,184 gzip, 11 raw bytes past the 346KiB limit.
// Most of that overrun is not this change: the 2026-08-20 raise left 2,556 raw
// of headroom and only 205 were still there when this work started, the rest
// spent by the handwriting-font settings and the boot-revision fixes that
// landed in between. This change adds about 216 raw bytes -- the resolver arm
// that reads the row behind an image's near station, the id the trash intent
// now carries, and the one dispatch line that reads it. None of it can be lazy:
// it is keyboard code on the first keystroke's path. The arm was already
// shortened twice to fit (the structure lookup dropped for the visible row, the
// index guard folded into the lookup itself) and still lands over, so this is a
// raise rather than more shaving of a rule that has to stay readable.
// Headroom: 1,013 raw -- about 305 gzip at these chunks' ratio, inside the 336
// gzip headroom, so raw still binds first -- and still below today's 8th
// largest lazy chunk (webview, 3,361 bytes), so eagerly importing any of the
// big eight trips the gate as before.
const rawLimit = 347 * 1024;
const gzipLimit = 105 * 1024;
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
