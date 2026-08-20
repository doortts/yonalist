# Selection band starts at the bullet; row menu clears the guide channel

## Contract

| Field | Content |
| --- | --- |
| Goal | The multi-row selection band starts just before the bullet dot (Workflowy-style) instead of at the row's indent origin, and the indentation guide and the row's `⋯` menu button stop sitting on top of each other — in space (wide layout) and in paint (narrow layout). |
| Acceptance | Rows A1–A4 below. |
| Non-goals | No change to the band's right edge, paint colours, shallowest-row derivation, or run continuity; no change to guide-toggle semantics (what a click folds/restores); no repositioning of the narrow-layout button (no channel exists there — pitch 28px equals button width 28px); no change to the drag-source tint or the page-title-row menu; no new theme tokens. |
| Boundaries | CSS + one TS constant, all in `apps/desktop/src`. No TSX change, no Rust, no IPC, no SQLite, no native config. Confirmed by inspection: the band, the slot column, the nudge, and the plate are pure `notes.css`; the tolerance is `outline/outlineGuideToggle.ts:8` and its only consumer is `guideBandAt` in the same file. Final gates: `npm test`, `npm run lint`, `npm run build`, `git diff --check`; Cargo gates explicitly skipped. |
| Manual proof | See "Manual proof" at the end — one path through a fresh Tauri dev app. The browser pane is Chromium and proves nothing about the shipped WKWebView (see the memory note on WKWebView CSS verification); the calc arithmetic and the two-layer background were already WKWebView-proven by the band work in `2026-08-20-bullet-selection-ui.md`, and this change only adds plain terms to the same calc, but the paint is still verified in the real app. |

### Verified geometry (all numbers re-derived from the current file, not taken on trust)

Wide (`.notes-outline`, notes.css:515-519): indent 36, menu width 24,
bullet-center-offset 61, content-offset 74. `.notes-node-main` grid
`24px 20px 18px 1fr`, gap 4, `margin-inline-start: var(--notes-indent)`
(notes.css:1939-1948). Relative to a row's indent origin: menu [0,24],
arrow [28,48], bullet [52,70]. Guides are stripes at
`bullet-center-offset + k*indent`, k = 0..depth−1, painted as the second
background layer of `.notes-node` (1773-1786); relative to a depth-d row's
main origin the parent stripe sits at +25 and the grandparent at −11.

Leaf rows in the wide layout move the menu slot to grid-column 2
(notes.css:2364-2367); the 24px slot overflows the 20px arrow track to
[28,52], 3px right of the parent stripe at 25 — the direction of the collision
is opposite to parent rows' (slot [0,24], 1px left of that stripe). Narrow
(3089-3149): indent 28, menu width 28, offset 70, columns `28 28 28 1fr` gap 0,
leaf slot already column 1; stripes land at +14 and +42 relative to main, so
the +14 stripe passes through the middle of the 28px button — no nudge can
help there.

Hit test: `GUIDE_HIT_TOLERANCE = 9` (outlineGuideToggle.ts:8), consumed only
by `guideBandAt`; `useOutlineGuideToggle.ts:53` already rejects hits whose
target closest-matches a button, so clicks are safe — the defect is the ±9px
lit band overlapping the button's hover plate near the boundary.

Bullet marker sizes (outlineMarkers.ts:143-149): dot 7×7, square 5×5,
dash 10×2, hyphen/custom auto-width glyphs at 13px font inside the 18px
bullet button. Hover plate `::before` 18×18, collapsed plate 20×20
(notes.css:2013-2033) — both centred on the bullet centre in both layouts.

### Acceptance rows

| # | Observable pass/fail | Item |
| --- | --- | --- |
| A1 | A selected row's band starts at `band-depth * indent + bullet-center-offset − 10px` from the row's left edge — wide: bullet centre −10 = 10px clear of the 18px hover plate's centre, i.e. the plate's left edge minus 1px, ~6.5px clear of the default dot; the menu and chevron columns are unpainted. Both layouts follow from the one formula (wide edge `36·D+51`, narrow `28·D+60`); the fallback to the row's own depth, the right edge, and the paint colours are unchanged. | 1 |
| A2 | Wide layout: leaf rows and parent rows show the `⋯` in the same place — grid-column 1, nudged 5px left, so the button spans [indent−5, indent+19] and sits centred in the 36px channel with 6px clearance to the grandparent stripe (indent−11) and 6px to the parent stripe (indent+25). Narrow layout's button is unmoved. | 2 |
| A3 | A pointer 5px or closer to a stripe centre lights and toggles it; 6px or farther does not (`guideBandAt(67, 61, 36)` is null, `(66, …)` is band 0). With A2's geometry, no point over the wide-layout button box is within tolerance of any stripe. | 3 |
| A4 | Narrow layout: a hovered or open `⋯` button's plate is opaque — the theme's hover wash composited over `--bg-detail` — so the stripe under it does not show through. Wide layout keeps the translucent plate. | 4 |

## Touched files

- `apps/desktop/src/notes.css` — items 1, 2, 4.
- `apps/desktop/src/outline/outlineGuideToggle.ts` — item 3 (one constant + comment).
- `apps/desktop/src/outline/outlineGuideStyles.test.ts` — items 1, 2, 4.
- `apps/desktop/src/outline/outlineGuideToggle.test.ts` — item 3.

Existing tests that must stay green untouched: `outlineShiftSelect.test.tsx`
(band-depth property only — React side untouched), `imageNodeStyles.test.ts`
(band-paint only), `outlineMarkerStyles.test.tsx`, `outlineGuideToggle.test.ts`'s
current `guideBandAt` rows (all its misses are ≥18px off a stripe, so they pass
at tolerance 5 unchanged).

## Items

Each independently committable, order 1 → 2 → 3 → 4 (2 and 3 together produce
the 6px-vs-5px clearance, but each is observable alone; 1 and 4 are
independent of both). Items 1, 2, 4 all edit `notes.css` and
`outlineGuideStyles.test.ts`, so they run sequentially in one agent.

### Item 1 — band left edge moves to the bullet (A1)

**Failing test:** in `outlineGuideStyles.test.ts`, the existing
"paints the band as the row's first layer" test gains
`expect(row).toContain("var(--notes-bullet-center-offset) - 10px")`.
Red today: the calc at notes.css:1752-1754 is
`band-depth * outline-indent` alone — the string is absent.

**Mechanism.** notes.css:1752-1754 becomes

```css
--notes-band-indent: calc(
  var(--notes-band-depth, var(--notes-depth)) * var(--notes-outline-indent) +
    var(--notes-bullet-center-offset) - 10px
);
```

keeping `var(--notes-band-depth, var(--notes-depth)) * var(--notes-outline-indent)`
intact on one line — the existing assertion at outlineGuideStyles.test.ts:40
pins that exact substring (the `rule()` helper compares trimmed lines, so a
wrap that splits the fragment would go red for the wrong reason). Extend the
comment above it: the band starts just before the bullet, not at the indent
origin, so the menu and chevron columns stay unpainted.

Nothing else moves: `background-position`/`background-size` already consume
`--notes-band-indent` (1782, 1785); the paint-side rules
(`[data-range-selected]` 1935, `[data-drag-source]` 1813,
`[data-solo-image-selection]` 3307) only set `--notes-band-paint` and are
untouched; the `[data-marker-kind="todo"]` grid adds a column *after* the
bullet, so the checkbox variant follows for free.

**Recorded decisions.**
- **−10px, derived from `--notes-bullet-center-offset`.** One number serves
  both layouts because a depth-d bullet centre is
  `offset + d*indent` in each. −10 exactly contains the 20px collapsed
  plate and over-contains the 18px hover plate by 1px, so no bullet plate
  ever pokes left of the band; clearance to the default 7px dot is 6.5px
  ("roughly 6px" per the approved treatment), to the widest box marker
  (dash, 10px) 5px. Glyph markers (hyphen/custom, auto width at 13px font)
  can in principle out-grow that, which is accepted — they already overhang
  the 18px button box today.
- The band edge never lands exactly on a guide hairline: edge ≡ offset−10
  (mod indent) vs stripes ≡ offset (mod indent), in both layouts.
- Nothing asserts the old edge: repo-wide, `--notes-band-indent` appears only
  in notes.css, and no DOM test pins the band's x-origin.

### Item 2 — one menu column, nudged into the guide channel (A2)

**Failing test:** new describe in `outlineGuideStyles.test.ts`
("row menu button sits in the guide channel"):

```ts
// Leaf rows used to park the slot in the chevron's column, 3px right of the
// parent stripe; parent rows sat 1px left of it. One column for both.
expect(notesStyles).not.toContain(".notes-node-arrow-slot:empty");
expect(rule(notesStyles, ".notes-node-menu-slot"))
  .toContain("margin-inline-start: -5px;");
expect(rule(atRule(notesStyles, "@media (max-width: 720px)"), ".notes-node-menu-slot"))
  .toContain("margin-inline-start: 0;");
```

All three red today: the `:empty` selector exists twice (2364, 3146), the base
slot rule has no margin, and the narrow block has no `.notes-node-menu-slot`
rule at all (`rule()` throws "missing rule", which is the red).

**Mechanism.**

- Delete the wide-layout leaf override (notes.css:2364-2367) *and* the narrow
  block's now-dead re-override (3146-3149). The base rule at 2348 already says
  `grid-column: 1`, so leaf and parent rows converge on it in both layouts.
- Fold the load-bearing part of the comment at 2359-2363 into the base
  `.notes-node-menu-slot` rule's comment: the slot must never gain a
  `z-index`, `transform`, or `position` — the row menu opens *inside* the slot
  (OutlineRow.tsx:225-273), and any of those would trap the menu's z-index in
  a slot-level stacking context (the bug 7b562d07 fixed) or re-parent its
  absolute positioning. That constraint is exactly why the nudge below is a
  margin.
- Add `margin-inline-start: -5px;` to the base slot rule. Arithmetic (comment
  it in the CSS): the wide channel between the grandparent stripe (indent−11)
  and the parent stripe (indent+25) is 36px; a 24px button centred in it spans
  [indent−5, indent+19] — 6px clear on each side, against ±5px hit tolerance
  after item 3. A negative start margin on a fixed-width grid item just slides
  the border box left past the 24px track's start edge; no other column moves.
  Depth-0 rows poke 5px into `.notes-outline-rows`' 28px inline padding
  (1188), so nothing clips and no horizontal scroll appears.
- In the `@media (max-width: 720px)` block, add
  `.notes-node-menu-slot { margin-inline-start: 0; }` — narrow's pitch equals
  its button width, a nudge buys nothing, and the numbers differ anyway.

**Recorded decisions.**
- Column-2 placement had no functional dependency: `git log -L` shows it
  shipped in the original build (c7b17cce) and was only ever touched to remove
  a `z-index` (7b562d07); no TSX and no test references the placement
  (repo-wide grep for `arrow-slot:empty` / `grid-column` in tests: none).
- Visible change accepted and intended: a leaf row's `⋯` moves 28px+5px left
  to where every other row's already is — uniform position is the point.
- Not `transform: translateX(-5px)` (stacking context — traps the popup, per
  the comment above) and not `position: relative` + inset (containing block
  for the menu). Margin has neither side effect.
- The button now overlaps the selection band on rows ≥1 deeper than the band
  depth (e.g. depth D+1: button [36D+31, 36D+55] vs band edge 36D+51); the
  wide plate stays translucent, so it composites over the tint as today.

### Item 3 — hit tolerance 9 → 5 (A3)

**Failing test:** in `outlineGuideToggle.test.ts`'s `guideBandAt` describe,
new case:

```ts
it("stops 6px short of a stripe, so the band never reaches the menu button", () => {
  expect(guideBandAt(66, 61, 36)).toBe(0);   // 5px off: still a hit
  expect(guideBandAt(67, 61, 36)).toBeNull(); // 6px off: miss
  // Depth-2 row, parent stripe at 97; the nudged button's right edge is 91.
  expect(guideBandAt(91, 61, 36)).toBeNull();
});
```

Red today: at tolerance 9 the second returns 0 and the third returns 1.
The existing miss cases (79, 40) are ≥18px off a stripe and stay green.

**Mechanism.** `outlineGuideToggle.ts:8` becomes `GUIDE_HIT_TOLERANCE = 5`,
and its doc comment records the cross-file invariant: the wide layout's menu
button clears each neighbouring stripe by 6px (`.notes-node-menu-slot`'s
−5px nudge in notes.css), so the tolerance must stay strictly under that
clearance — a matching sentence goes on the nudge's CSS comment in item 2.
No other change: `guideBandAt` is the constant's only consumer, and the
button-rejection guard in `useOutlineGuideToggle.ts` already handles clicks —
this narrows only where the *lit line* can appear, so line and button plate
no longer light together at the boundary.

**Recorded decisions.**
- CSS/JS drift risk, addressed as far as it can be without over-building: the
  stripe *positions* keep one source of truth (the JS reads
  `--notes-bullet-center-offset` / `--notes-outline-indent` live via
  `getComputedStyle`, useOutlineGuideToggle.ts:57-62). The
  tolerance↔clearance pairing (5 < 6) necessarily spans two files; mirrored
  comments name each other, and A3's third test case pins the composed
  geometry (button edge at 91 vs stripe at 97) so a regression on either side
  goes red.
- Narrow layout's usable hover target shrinks from 18px to 10px per stripe;
  accepted — the stripe there runs under the button, so a wide target was
  lighting the guide from on top of the button plate, which is the defect.

### Item 4 — narrow layout: opaque plate under the menu button (A4)

**Failing test:** in the new describe from item 2:

```ts
const narrow = atRule(notesStyles, "@media (max-width: 720px)");
const plate = rule(narrow, '.notes-bullet-menu-trigger[data-popup-open]');
expect(plate).toContain("background-color: var(--bg-detail);");
expect(plate).toContain(
  "background-image: linear-gradient(var(--bg-hover), var(--bg-hover));"
);
```

Red today: no such rule exists in the narrow block, so `rule()` throws.
(`rule()` matches the selector's own line, so the two-line selector below is
matched by its second line — the same way the test file already matches
attribute selectors.)

**Mechanism.** In the `@media (max-width: 720px)` block:

```css
/* The stripe channel is as wide as the button here, so a stripe always runs
   under the plate; the translucent wash would show it through. The plate
   composites the theme's own hover wash over the pane background itself --
   the same colour the eye sees on plain ground, now opaque. */
.notes-bullet-menu-trigger:hover,
.notes-bullet-menu-trigger[data-popup-open] {
  background-color: var(--bg-detail);
  background-image: linear-gradient(var(--bg-hover), var(--bg-hover));
}
```

Same specificity as the base rule at 2425-2430 (`background: var(--bg-hover)`),
later in the file, so it wins inside the media query; the base shorthand
resets `background-image`, which is why the override sets both longhands.

**Recorded decisions.**
- **Narrow only.** After items 2–3 the wide layout never has a stripe under
  the button, and its translucent plate still composites over the selection
  band tint when a deep row's button sits on the band; going opaque there
  would punch a hover-shaped hole in the tint for no gain.
- **No new token.** Every theme block defines `--bg-hover` as a translucent
  wash (styles.css 15, 101, 158, 202, 254, 305, 381, 440) and the outline's
  ground is `--bg-detail` (notes.css:525); compositing the two reproduces the
  exact rendered hover colour per theme with zero per-theme work. The existing
  `--comment-header` token is the same idea over `--bg-card` — wrong ground
  here.
- In narrow, an opaque plate over a selected deep row does cover the band tint
  under the button while hovered/open; accepted — hover feedback legibility
  wins over a 28×28px tint patch, and only in the narrow layout.

## Known risks

| Risk | Regression it would cause | Containment |
| --- | --- | --- |
| WKWebView computing the extended `--notes-band-indent` calc differently from Chromium | Band edge lands somewhere unexpected on every selected row | The same calc shape (multiply + var terms) was WKWebView-measured by the prior band work; manual proof step 3 re-verifies in the real Tauri app |
| Negative margin on the menu slot interacting with the grid differently in WKWebView | Button misplaced or first column widened | Manual proof step 4; the fallback is harmless (button 5px right of centred, still 1px/11px clear as today's parent rows) |
| Tolerance and clearance drifting apart in a later edit | Lit guide and button plate overlap again | Mirrored comments in outlineGuideToggle.ts and notes.css; `guideBandAt(91, 61, 36)` pins the composed number |
| Deleting the leaf `:has` rule surprising some untraced consumer | Leaf-row layout breaks | Traced: no TSX, no test, and git history shows no functional reason for column 2; the popup anchors to the trigger ref, not the column |
| `stylelint`/prettier re-wrapping the calc line | outlineGuideStyles.test.ts:40's substring assertion goes red for a formatting reason | Item 1 keeps the multiplied term on its own line; lint gate runs before commit |

## Manual proof (shortest real user path, fresh Tauri app)

1. Launch the dev desktop app fresh (fresh bundle and process per the delivery
   skill). The browser pane proves nothing here — WKWebView only.
2. Build parent → child → grandchild, plus a leaf sibling under the parent.
3. Select child + grandchild (Shift+ArrowDown): the band's left edge sits just
   left of the child's bullet plate — the `⋯` column and chevron column are
   unpainted; extend to the parent: the edge moves to just before the parent's
   bullet.
4. Hover a leaf row and a parent row: both show `⋯` in the same left column,
   visibly between the two guide lines, touching neither.
5. Sweep the pointer slowly from a `⋯` button toward the parent guide line:
   the button plate and the lit line never show at the same time; the line
   lights only within a slim band around the hairline, and clicking it still
   folds/restores the range.
6. Narrow the window under 720px: hover a deep row's `⋯` — the plate is solid
   and no guide line shows through it; open the menu, same.
7. Switch to a dark theme (Settings) and repeat step 6 — the plate colour
   matches the theme's hover colour, opaque.

## Gates

Frontend-only: `npm test`, `npm run lint`, `npm run build`, `git diff --check`.
Cargo tests/formatting/Clippy explicitly skipped — no Rust, IPC contract,
persistence, or native configuration is touched.
