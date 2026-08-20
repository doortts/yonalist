# v2 bundle budget: record the overrun, close the gap that hid it

## Problem

`npm run test:bundle` fails on main at 3cabfa8d:

```
Error: v2 editable JS 351748 raw / 106605 gzip exceeds 340992 raw / 103424 gzip
```

The entry pair (`assets/index-*.js` 343,213 + `assets/jsx-runtime-*.js`
8,535) is 10,756 raw / 3,181 gzip over the 333KiB / 101KiB limits in
`scripts/checkV2BundleBudget.mjs`. Bisecting main's first-parent history puts
the crossing between 5073aa6b (340,187 raw, under) and 36a07b5a (342,913 raw,
over) — roughly 100 commits ago. No lazy chunk leaked into the entry: all 24
dynamic imports still emit their own chunks. The growth is diffuse feature
code — the multi-select selection band and its delete keys, modifier-A
select, the guide-line sub-bullet toggle, cursor scrolling, the page-title
placeholder — landed across the selection-band commit family and its
follow-ups.

Why nobody saw it: CI (`.github/workflows/ci.yml`) runs `npm run test:all`,
which includes `test:bundle`, on every push and PR — but this repo's loop
merges to main locally and pushes only on instruction, so CI never saw these
commits. The only enforcement that actually runs per change is the frontend
gate row in `delivering-yonalist-changes` (`npm test`, `npm run lint`,
`npm run build`, `git diff --check`), and that row does not include the
budget check. The gate existed; nothing in the live loop consulted it.

## Contract

| Field | Content |
| --- | --- |
| Goal | `npm run test:bundle` passes on main with the growth recorded as a dated, argued decision in the budget comment, and the budget check joins the per-change frontend gate list so the next overrun is caught at the commit that causes it. |
| Acceptance | Rows 1–4 below. |
| Non-goals | No code-splitting of the clipboard/paste/image-ingest family; no `vite.config.ts` chunk changes; no CI workflow change (CI already runs the gate); no unit test for the budget script; no attempt to shrink react-dom (468KB of the 770KB unminified entry, irreducible); no change to the script's manifest traversal or the preview-leak check; no push. |
| Boundaries | One Node build script (`scripts/checkV2BundleBudget.mjs`) and one repo skill markdown (`.agents/skills/delivering-yonalist-changes/SKILL.md`). No React, IPC, Rust, SQLite, or runtime surface. |
| Manual proof | N/A — the gate is build-time with no runtime behavior; its own `PASS` line against a fresh `npm run build` is the complete observable. |

### Acceptance rows

| # | Row | Proof | Item |
| --- | --- | --- | --- |
| 1 | Red first: `npm run test:bundle` fails at the pre-change HEAD with exactly `v2 editable JS 351748 raw / 106605 gzip exceeds 340992 raw / 103424 gzip` | Run it before editing; record the output verbatim. If the fresh measurement differs from 351,748 / 106,605 by more than byte jitter, stop and re-derive the limits — the comment must record what was actually measured. | 1 |
| 2 | Green after: `npm run test:bundle` prints `v2 editable JS PASS (343.5KB raw / 104.1KB gzip)` and exits 0 | Same command after the edit. | 1 |
| 3 | Tripwire preserved: raw headroom (354,304 − 351,748 = 2,556) is smaller than the smallest of the 8 largest lazy chunks in the fresh build (`webview`, 3,361 bytes) | Read chunk sizes from `apps/desktop/dist/.vite/manifest.json` files after the build; confirm the 8th-largest lazy chunk is still ≥ 2,557 bytes and the comment's arithmetic matches. | 1 |
| 4 | The frontend gate row in `delivering-yonalist-changes` runs `npm run test:bundle` in place of bare `npm run build` | Read the row. | 2 |

## Decision: option 2 — raise the budget, and fix the enforcement gap that made the raise retroactive

Option 1 (cut back under budget) fails on arithmetic before it fails on
risk, and it also fails on risk.

**Arithmetic.** Recovering 10,756 minified raw bytes at the entry's ~0.446
minify ratio means moving ~24KB of unminified app source. The only family
that big with any lazy plausibility is clipboard/paste + image ingest:
`outlineClipboard.ts` (6,683) + `outlinePaste.ts` (6,483) +
`outlineClipboardActions.ts` (2,915) + `outlinePasteGesture.ts` (2,331) +
`image/imageClipboard.ts` (2,209) + `image/useImageIngest.ts` (7,001) =
27,622 unminified ≈ 12.3KB minified. Taking all of it lands ~1.5KB under the
raw limit and ~0.5KB under gzip. Recent organic drift was 1,607 raw bytes
over the last dozen commits — the gate would be red again within days, with
the only cheap seam already spent and the same decision back on the table
minus one option. Everything else in the entry is hot-path keyboard and
row-render code (`outlineKeyboard.ts`, `OutlineRow.tsx`, `App.tsx`,
`useOutlineSelection.ts`) that must be in the first load; keyboard handlers
cannot be lazy.

**Risk.** The seam is gesture-locked, and the code says so itself.
`outlinePasteGesture.ts:87` — "Before the import leaves: WebKit disowns a
gesture that waits on anything." The paste handler must, synchronously
inside the event dispatch: read `event.clipboardData` (invalid after the
handler returns in WKWebView) and decide `preventDefault()` from the parse
result — when `parsePastedOutline` returns null the handler returns without
preventing, so the native text paste proceeds. `preventDefault()` after an
`await import(...)` is a no-op, so a lazy chunk in front of this handler
either double-pastes on cold load or forces always-prevent + manual text
insertion, which changes native undo and IME behavior. The copy/cut path has
the same shape: `useOutlineSelection.ts` writes `clipboardData`
synchronously inside copy/cut events. `outlineClipboard.ts` has four eager
importers (`useOutlineSelection`, `outlineSlash`, `outlineMenuCommands`,
`outlinePaste`), so it cannot leave the entry alone. `useImageIngest` is a
React hook called unconditionally in `NotesOutline.tsx` render — a hook
cannot be awaited. There is no version of option 1 that is both sufficient
and behavior-preserving.

**What makes this growth accepted rather than tolerated.** Every byte of it
is shipped, user-facing editing behavior that went through this repo's
design/review loop (the plan docs for the selection-band family sit in this
directory), lives in the hot editing path, cannot be lazy, and is not going
to be reverted. Accepting it means what the budget comment's own convention
says: record the fresh measurement, what grew, and the headroom reasoning,
dated. The failure here was doing that 100 commits late, and the honest
response is to say so in the comment — the file already has precedent for
admitting a retroactive raise (2026-08-16: "had already been passed by 2
bytes before that work began"). This one is retroactive by 10.7KB, which is
worse, and the comment says that too.

**The obvious objection — a budget raised whenever it is exceeded is not a
budget.** Three answers. First, what failed was enforcement, not the
threshold: the number did its job the moment anything consulted it; nothing
in the live per-change loop did. Item 2 closes that — with `test:bundle` in
the frontend gate row, the next feature that grows the entry pays for its
bytes in its own review, where "raise deliberately or cut" is a real
per-change decision instead of an archaeology project. A raise without item
2 would make the objection true; item 2 is what makes this a raise instead
of a surrender. Second, the budget's level-independent function — tripping
when a lazy chunk is accidentally imported eagerly — survives at the new
level by the headroom arithmetic below. Third, the growth is argued on its
merits above, feature by feature, with the alternative shown insufficient;
"we measured, we looked for a seam, there isn't one" is what accepted means.

## Exact new limits

Measured at 3cabfa8d: 351,748 raw / 106,605 gzip (entry gzip/raw ratio
0.303).

| Limit | Value | Headroom | Why this multiple |
| --- | --- | --- | --- |
| `rawLimit` | `346 * 1024` = 354,304 | 2,556 raw | 344KiB leaves 508 bytes — a couple of commits of ordinary drift, the "raised reflexively instead of read" failure the comment already warns against. 347KiB leaves 3,580, which exceeds `webview` (3,361 bytes, today's 8th-largest lazy chunk) and breaks the tripwire: eagerly importing it would fit inside headroom. 346KiB matches the 2026-08-16 precedent (2,472) and keeps every one of the big eight tripping the gate. |
| `gzipLimit` | `105 * 1024` = 107,520 | 915 gzip | Smallest KiB multiple above the measurement. 2,556 raw ≈ 775 gzip at the 0.303 ratio, inside the 915 gzip headroom, so raw still binds first — the property the existing comment claims and reasons from. |

Note the top-8 membership drifted since the 2026-08-16 comment (outline
markers has left the set; today's eight are SettingsView 46,721,
ImageNodeContent 16,114, window 13,897, OutlineRowMenu 6,700,
outlineDragEngine 6,369, NotesExportMenu 4,674, OutlineSelectionActionBar
4,151, webview 3,361). The new comment names today's floor rather than
inheriting the stale list.

## Comment text

Appended to the existing comment block in `scripts/checkV2BundleBudget.mjs`,
directly above the limits, replacing nothing:

```
// Measured 2026-08-20 at the dnd-kit dependency removal (3cabfa8d): the entry
// pair is 351,748 raw / 106,605 gzip — 10,756 raw past the 333KiB limit. This
// raise records a debt, not a fresh overrun: the gate went red about 100
// commits ago, somewhere in the selection-band work, and stayed red because
// only `test:all` runs this script and the per-change loop merges to main
// locally, before CI ever sees a push. What grew is the multi-select family
// (the band, its delete keys, the modifier-A select), the guide-line
// sub-bullet toggle, cursor scrolling, and the page-title placeholder —
// keyboard- and row-render code that has to be in the first load. The one
// seam big enough to claw the bytes back instead, the clipboard/paste family
// plus image ingest, is gesture-locked: the paste handler must read
// clipboardData and decide preventDefault synchronously inside the event
// (outlinePasteGesture.ts records why), so a chunk load cannot sit in front
// of it — and even moving all of it lands only ~1.5KB under the old limit,
// which recent drift would eat within days. Hence a raise, recorded late;
// the per-change gate list now runs this check so the next overrun is caught
// at the commit that causes it, not a hundred later.
// Headroom: 2,556 raw — about 775 gzip at these chunks' ratio, inside the
// 915 gzip headroom, so raw still binds first — and below today's 8th
// largest lazy chunk (webview, 3,361 bytes), so eagerly importing any of the
// big eight still trips the gate. 347KiB would not have that property.
```

One repair inside the existing block: the first paragraph says "`test:v2`
runs this check"; the script has been `test:bundle` since the rename. Fix
the name in place — it is a pointer, not a dated measurement.

## Items

**Item 1 — raise the limits and record why, in
`scripts/checkV2BundleBudget.mjs`.** Set `rawLimit = 346 * 1024` and
`gzipLimit = 105 * 1024`, append the comment above, fix the stale `test:v2`
pointer. Failing test: `npm run test:bundle` itself — it is red right now at
HEAD with the exact error in acceptance row 1; record that output verbatim
as the red evidence, then confirm the green PASS line after the edit. No
vitest unit test: the root `vitest.config.ts` covers `scripts/**/*.test.ts`,
and the two existing suites there (`checkHistoricalPlanReconciliation.test.ts`,
`ciWorkflow.test.ts`) do not touch this script. A unit test asserting
`346 * 1024` would restate the constant and break on every legitimate future
raise; a test of the manifest traversal would test logic this change does
not touch. The gate command is the test.

**Item 2 — put the gate in the per-change path, in
`.agents/skills/delivering-yonalist-changes/SKILL.md`.** In the final-gates
table, change the frontend-only row's `npm run build` to
`npm run test:bundle` (`test:bundle` is `npm run build && node
scripts/checkV2BundleBudget.mjs`, so this is the same build plus a
sub-second size check — no gate got cheaper or was dropped, and the
Rust-boundary row inherits it via "the frontend gates that apply"). Failing
test: none exists and none is warranted — this is workflow prose; a vitest
grepping the markdown for the string would be the same constant-restating
test rejected above. The check is acceptance row 4, read directly. Red/green
discipline does not apply; say so in the review rather than manufacturing a
red.

One commit per item. Close-out gates after the diff freezes, once:
`npm test`, `npm run lint`, `npm run test:bundle`, `git diff --check`.

## Where the request's framing was off

- "`test:bundle` appears only in the `test:all` npm script, not in the
  routine per-change gate list, which is how it stayed red unnoticed" —
  incomplete. CI runs `test:all` on every push and PR, so the gate *is*
  wired to CI; it stayed red because merges to main happen locally and
  pushes wait for instruction, so CI never saw these commits. The gap is
  purely in the local gate row, which is why item 2 is the whole fix and no
  CI change is needed.
- The framing presents option 1 as viable-but-risky. The files say it is
  insufficient-and-regressive: even the maximal move lands ~1.5KB under a
  limit drifting ~130 bytes per commit, and getting there requires breaking
  a synchronous-gesture contract the code documents at
  `apps/desktop/src/outline/outlinePasteGesture.ts:87`. It is not a close
  call.
- The existing comment's "8 largest lazy chunks" list is stale (outline
  markers has dropped out; webview is now the 8th at 3,361). The framing
  used the right number but the new comment must restate today's set, not
  cite the old one.
- The script's own header comment names `test:v2`, a script that no longer
  exists. Trivial, fixed in item 1.
