# App chrome user-select rules answer to the shipped engine

## Goal

The three app-chrome rules that suppress text selection — pane-resize state,
titlebar, content drag strip — actually suppress it in the WKWebView the app
ships in.

## Background

a71cb8a2 established (Swift+WKWebView probe, 2026-08-20): the shipped engine
(AppleWebKit/605) does not parse bare `user-select` at all —
`CSS.supports('user-select','none')` is false, the declaration is dropped
whole. Three pre-existing rules in `apps/desktop/src/styles.css` still declare
only the bare property, so they are silent at runtime: text can be
drag-selected through the titlebar drag regions and while resizing panes.

- `body.is-resizing-pane` (~line 675)
- `.app-titlebar` (~line 787)
- `.app-content-drag-strip` (~line 798)

Every other `user-select` in `styles.css` and `notes.css` is already paired
prefixed-before-bare (verified by grep on this baseline).

## Acceptance

| # | Observable pass/fail |
| --- | --- |
| 1 | `body.is-resizing-pane` declares `-webkit-user-select: none;` on the line above `user-select: none;` |
| 2 | `.app-titlebar` declares the same pair, same order |
| 3 | `.app-content-drag-strip` declares the same pair, same order |
| 4 | All three pairs are pinned by a vitest test using the `expectsSelection` contract (prefixed present + bare present as its own anchored line), and the helper is shared with `outlineSelectionStyles.test.ts`, not duplicated |

## Non-goals

- No change to any already-paired rule.
- No new runtime/Swift probe — a71cb8a2's probe already proved the prefixed
  form does the work in this engine; this change only applies the proven pair
  to three more rules.
- No JS-side selection suppression changes.

## Boundaries

React/CSS only. No IPC, Rust, SQLite, filesystem, or native config.
Final gates: `npm test`, `npm run lint`, `npm run build`, `git diff --check`.
Cargo gates explicitly skipped.

## Item list

One item (acceptance rows 1–4 all map to it):

**Item 1 — pair the three app-chrome rules and pin them.**

1. Move `expectsSelection` from
   `apps/desktop/src/outline/outlineSelectionStyles.test.ts` into
   `apps/desktop/src/test/cssRules.ts` (exported; keep its comment).
   `outlineSelectionStyles.test.ts` imports it from there.
2. New test `apps/desktop/src/appChromeSelectionStyles.test.ts`: reads
   `src/styles.css`, asserts `expectsSelection(rule(css, sel), "none")` for
   `body.is-resizing-pane`, `.app-titlebar`, `.app-content-drag-strip`.
3. Run the new test first — it must fail red on all three rules (missing
   prefixed line). Record the red output verbatim.
4. Add `-webkit-user-select: none;` immediately above each of the three bare
   `user-select: none;` declarations in `apps/desktop/src/styles.css`.
5. Run the new test green, plus `outlineSelectionStyles.test.ts` green
   (helper move must not break it).

Failing test proving the item: `appChromeSelectionStyles.test.ts` (red before
step 4, green after).

## Manual proof

N/A beyond the existing probe: the runtime question ("does the prefixed pair
work in this WKWebView") was answered by a71cb8a2's probe on 2026-08-20; the
delta is the same declaration pair on three more selectors, pinned statically.
