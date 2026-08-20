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
// Measured 2026-08-21 at the Cmd/Ctrl +/- page zoom: the entry pair is 355,051
// raw / 107,524 gzip. Most of that arrived before this change — the same pair
// without it is 354,168 raw / 107,166 gzip, so the drift since the 2026-08-20
// raise had already eaten all but 136 raw of the headroom that raise recorded.
// The page-zoom module itself is 883 raw / 358 gzip: the chord test, the 5%
// step with its clamp, and the remembered size that has to be put back before
// the first paint. The webview API it calls is not in that number — it loads
// through the lazy chunk the native drag-drop listener already pulls, so a
// press pays for the module and nothing else.
// Measured 2026-08-21 at the status bar zoom stepper (Option D): the entry
// pair is 357,327 raw / 108,063 gzip. The status bar holds the permanent
// stepper control ([-], reset label, [+]), its subscription to the page zoom
// store, and the reset logic.
// Headroom: 1,073 raw — about 320 gzip at these chunks' ratio, inside the 1,505
// gzip headroom, so raw still binds first — and still well below the 8th largest
// lazy chunk (webview, 3,361 bytes), so eagerly importing any of the big eight
// trips the gate the way it did before.
// Measured 2026-08-21 at the journal feature: the entry pair is 365,432 raw /
// 110,454 gzip, against 357,478 raw / 108,254 gzip for the same tree without it
// (main at 07d265f6's merge base, built the same way). So the day pages, the
// feed, the calendar, the linked references, the carry-over and the date-token
// menu cost 7,954 raw eager bytes between them.
// Five of those six surfaces are lazy chunks and none of them is in this pair
// (JournalFeed 3,360; JournalCalendar, JournalDayBar, JournalReferences and
// JournalDateMenu smaller still). What stays eager is what has to be on screen
// or in the hands of the first keystroke: the sidebar's Journals rows and the
// Suspense that holds the month's place, the date-token handler threaded down
// to the row and note fields, and the date helpers that decide whether a page
// is a day at all -- the outline's own token parser reads the last of those, so
// it cannot wait for a chunk either.
// Headroom: 1,160 raw -- about 350 gzip at these chunks' ratio, inside the
// 1,162 gzip headroom, so raw still binds first -- and still below the 8th
// largest lazy chunk (webview, 3,361 bytes), so eagerly importing any of the
// big eight trips the gate the way it has since 2026-08-16.
const rawLimit = 358 * 1024;
const gzipLimit = 109 * 1024;
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
