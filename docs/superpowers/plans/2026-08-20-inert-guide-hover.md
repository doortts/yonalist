# Inert guide hover: a range with nothing to fold lights dim, under a plain cursor

## Contract

| Field | Content |
| --- | --- |
| Goal | Hovering an indentation guide splits into two flavours: a guide whose range holds something to fold or unfold keeps today's `var(--accent)` line and `pointer` cursor; a guide whose range holds nothing to fold lights `var(--text-3)` under the default cursor — still lit, because the lit-but-dim line is what tells the user there is nothing to fold there. |
| Acceptance | Rows A1–A3 below. |
| Non-goals | No change to what a click folds/restores (`planGuideToggle` untouched); no change to hit geometry — `GUIDE_HIT_TOLERANCE` stays 5 for both flavours; no change to the resting stripe, the band, or the row menu; no new theme token (`--text-3` already exists in all eight themes); no fix for the pre-existing staleness where a keyboard tree edit under a fully stationary pointer leaves the lit paint stale until the next mousemove. |
| Boundaries | Frontend only, confirmed by inspection: the flavour is a pure predicate over the in-memory `OutlineIndex` (`outline/outlineGuideToggle.ts`), the wiring is `outline/useOutlineGuideToggle.ts` (writes `data-guide-hot` and `list.style.cursor` imperatively), the paint is one selector in `notes.css`. No TSX, Rust, IPC, SQLite, or native config. Final gates: `npm test`, `npm run lint`, `npm run test:bundle`, `git diff --check`; Cargo gates explicitly skipped. |
| Manual proof | See "Manual proof" at the end — one path through a fresh Tauri dev app. The browser pane is Chromium and proves nothing about WKWebView; the CSS here (attribute-value selector + `var()` recolour) is engine-boring, but the colour and cursor are still eyeballed in the real app. |

### Verified readings (all re-derived from the current files, not taken on trust)

**The inert predicate.** `guideTargets(tree, ownerId)`
(outlineGuideToggle.ts:83-97) pushes a child and recurses into it only when
that child itself has children; a child without children is skipped and never
recursed into. So `guideTargets(...).length > 0` is decided entirely at the
top level: it is non-empty **iff some direct child of the owner has children
of its own**. An O(direct children) predicate is exactly equivalent to the
O(subtree) walk — the equivalence is structural, and item 1's test pins it on
shared fixtures.

**A click on an empty range provably does nothing.**
`planGuideToggle([], pending)` returns `{changes: [], pending: null}`
(outlineGuideToggle.ts:110), and the hook's `onClick` returns before touching
the store when `changes` is empty (useOutlineGuideToggle.ts:150). The pending
map entry is deleted, which is itself a no-op for an owner that never folded.

**The only other zero-change click, and why hover ignores it.** The restore
branch (outlineGuideToggle.ts:111-120) can produce zero changes only when
every surviving target sits at `pending.applied` *and* every snapshot value
equals the current value. From a single click's own snapshot this is
impossible: `applied = !targets.every(collapsed)`, so at click time at least
one target differed from `applied`, and restoring it is a change. The corner
requires every such differing node to be **deleted from the range between the
two clicks**. That state depends on click history plus a tree edit, not on
tree shape; a hover predicate that consulted `pending` would also flip the
same guide's colour after every toggle click. Decision: **inert is
tree-shape-only** (`guideCanFold`), and the deleted-node corner stays a silent
no-op click on an accent-lit guide. Recorded and accepted.

**Fold does not change flavour.** Folding writes `collapsed`, which
`guideTargets`/`guideCanFold` never read for emptiness — they read
`childrenOf`. So the settle-effect repaint after a fold
(useOutlineGuideToggle.ts:110-118) recomputes the same flavour; the flavour
only flips on a structural edit (outdent, delete, move, first child created).

**The short-circuit is real and must carry the flavour.** `light()`
(useOutlineGuideToggle.ts:95-100) compares only `ownerId` and `band`. A
structural edit via keyboard (pointer stationary on the stripe) flips the
flavour while both stay equal; the next mousemove would then be swallowed and
the guide would keep the wrong colour and cursor until the pointer left the
stripe. The memo key gains `actionable`.

**Paint/cleanup wiring.** `paint()` clears via
`querySelectorAll("[data-guide-hot]")` — an unqualified presence selector, so
any attribute value is found and cleared (useOutlineGuideToggle.ts:80-84).
The CSS lit rule is also unqualified (`.notes-node[data-guide-hot]::before`,
notes.css:1802) and keeps matching both values. Repo-wide, `data-guide-hot` /
`guideHot` appears only in useOutlineGuideToggle.ts, notes.css, and
outlineGuideStyles.test.ts; no selector or test qualifies the value, so
`"true"` for the actionable flavour can stay byte-identical to today.

**`--text-3`.** Defined in all eight theme blocks of styles.css (29, 112,
169, 213, 265, 316, 392, 451) and nowhere else — the dark-theme
`.detail-pane` override block at styles.css:1330 redefines `--bg-detail`,
`--bg-hover`, `--border`, `--border-strong`, but **not** `--text-3`. In every
theme it is clearly distinct from the resting stripe's `--border` (dark
detail pane: `#8c8c8c` vs `#343536`).

**Cursor context.** No `cursor` declaration exists on `.notes-outline-list`
or any of its ancestors (`.notes-outline-content`, `.notes-outline-rows`,
`.detail-scroll`, `.detail-pane`), and no `cursor: text` exists anywhere in
notes.css or styles.css. The stripe's x-range lies over row chrome left of
the text field, where `cursor: auto` renders the arrow. So `""` (no inline
cursor, same as no hit) *is* the default cursor the user asked for; an
explicit `default` would buy nothing and additionally suppress the I-beam
over text the pointer is not on.

**Tests.** No DOM-level test renders the outline and asserts on
`data-guide-hot` or the cursor — the only guide tests are the pure-helper
file (outlineGuideToggle.test.ts) and the stylesheet-string file
(outlineGuideStyles.test.ts). The hook has never been DOM-tested because
`hitFrom` reads `--notes-bullet-center-offset`/`--notes-outline-indent` via
`getComputedStyle`, which jsdom does not cascade — but the repo already
drives hooks through a harness component (`useOutlineDrag.cursor.test.tsx`,
`renderHook` in useTheme.test.ts), and a scoped `getComputedStyle` spy makes
`hitFrom` computable. The flavour behaviour (attribute value, cursor, memo
key) is hook behaviour, so it gets a real DOM test (item 3) rather than a
string test; the CSS colour stays a string test (item 2), matching the
file's idiom. `rule()` in test/cssRules.ts matches the exact selector line,
so the new `.notes-node[data-guide-hot="inert"]::before` rule is invisible to
the existing base-rule assertions.

### Design decisions (the five questions, answered)

1. **Where the flavour is computed:** in `hitFrom`, per mousemove that lands
   on a stripe, via a new predicate `guideCanFold` — O(direct children of one
   node), a handful of Map lookups, equivalent to `guideTargets(...).length >
   0` by the structural argument above. No memoization needed at that cost;
   `light()`'s existing short-circuit still skips the repaint itself.
2. **Wire format:** one attribute, two values — `data-guide-hot="true"`
   (actionable, today's exact write, byte-identical) and
   `data-guide-hot="inert"`. Presence selectors and the cleanup
   `querySelectorAll` match both. `"active"` instead of `"true"` was
   considered and rejected: it would change the actionable path's write for
   no functional gain, and nothing qualifies the value today.
3. **Short-circuit:** `GuideHit` gains `readonly actionable: boolean` and
   `light()` compares it alongside `ownerId`/`band`. Necessary — see the
   verified reading above. The `armed`/click comparison stays on
   `ownerId`/`band`: if the flavour flips between mousedown and click,
   `planGuideToggle` recomputes targets fresh and does the right thing anyway.
4. **Cursor:** inert sets `""` (remove the inline cursor), not an explicit
   `default` — verified equivalent here, and it keeps "inert" and "no hit"
   the same cursor state.
5. **No new custom property.** The `--notes-band-paint` idiom exists because
   many state rules feed one paint slot; here one writer produces two static
   flavours, so a value-qualified override selector (recolour only, geometry
   stays in the base rule) is the smaller and clearer shape.

### Acceptance rows

| # | Observable pass/fail | Item |
| --- | --- | --- |
| A1 | `guideCanFold(tree, ownerId)` is false exactly when `guideTargets(tree, ownerId)` is empty and true otherwise, pinned on the shared fixture tree (owner `a` true, owner `d` false) plus an explicit equivalence sweep over every fixture owner. | 1 |
| A2 | notes.css contains `.notes-node[data-guide-hot="inert"]::before` setting `background: var(--text-3);` and nothing else — the base `[data-guide-hot]` rule keeps `var(--accent)` and all geometry. | 2 |
| A3 | In a rendered harness: a mousemove over a stripe whose range can fold writes `data-guide-hot="true"` on the spanned rows and `cursor: pointer` on the list; over a stripe whose range cannot fold it writes `data-guide-hot="inert"` and no list cursor; and when the same `{ownerId, band}` flips flavour after a tree change, the next mousemove repaints instead of being swallowed. | 3 |

## Touched files

- `apps/desktop/src/outline/outlineGuideToggle.ts` — item 1 (one exported predicate).
- `apps/desktop/src/outline/outlineGuideToggle.test.ts` — item 1 (added describe only).
- `apps/desktop/src/notes.css` — item 2 (one rule after the base lit rule).
- `apps/desktop/src/outline/outlineGuideStyles.test.ts` — item 2 (added test only).
- `apps/desktop/src/outline/useOutlineGuideToggle.ts` — item 3 (`GuideHit.actionable`, `hitFrom`, `light`, `paint`).
- `apps/desktop/src/outline/useOutlineGuideToggle.test.tsx` — item 3 (new file).

Existing tests that must stay green untouched: every current row of
`outlineGuideToggle.test.ts` and `outlineGuideStyles.test.ts` (items only add;
`rule()`'s exact-line matching keeps the base-rule assertions blind to the new
inert rule), `useOutlineDrag.cursor.test.tsx` (body-class cursor, unrelated),
`outlineShiftSelect.test.tsx`, `outlineSelectionStyles.test.ts`,
`outlineWindowPerformance.test.tsx` (renders the outline but never moves the
mouse over a stripe).

## Items

Order 1 → 2 → 3. Item 2 lands before item 3 deliberately: the inert CSS rule
is dead (unmatched) until the hook writes the value, so no intermediate commit
ships a visibly wrong state — the reverse order would ship an accent-lit inert
guide under a default-promising design. Items 1 and 3 share
outlineGuideToggle.ts's export surface, so they run sequentially in one agent.

### Item 1 — `guideCanFold`, the O(children) inert predicate (A1)

**Failing test:** new describe in `outlineGuideToggle.test.ts`:

```ts
describe("guideCanFold", () => {
  // The hover flavour must agree with what a click would find, so the cheap
  // predicate is pinned to guideTargets' emptiness on every fixture owner.
  it("says whether the range holds anything a click could fold", () => {
    expect(guideCanFold(tree, "a")).toBe(true);
    expect(guideCanFold(tree, "d")).toBe(false); // one child, a leaf
    for (const id of ["a", "b", "c", "d", "e", "leaf"]) {
      expect(guideCanFold(tree, id)).toBe(guideTargets(tree, id).length > 0);
    }
  });
});
```

Red today: `guideCanFold` is not exported, so the import fails and the whole
file goes red — record the exact import error as the red evidence.

**Mechanism.** In `outlineGuideToggle.ts`, next to `guideTargets`:

```ts
/**
 * Whether the guide's range holds anything a click could fold -- the hover
 * flavour. Equivalent to `guideTargets(tree, ownerId).length > 0`: that walk
 * pushes a child and recurses only when the child has children, so emptiness
 * is decided entirely among the owner's direct children. O(direct children),
 * cheap enough to run on every mousemove that lands on a stripe.
 */
export function guideCanFold(tree: GuideTree, ownerId: string): boolean {
  return tree
    .childrenOf(ownerId)
    .some((child) => tree.childrenOf(child.id).length > 0);
}
```

**Recorded decisions.**
- Not `guideTargets(...).length > 0` inline in the hook: that walk is
  O(subtree) and allocates the full targets array per mousemove; the predicate
  is three lines, early-exits, and gives the flavour a name the hook and CSS
  comments can reference. Not a method on `OutlineIndex` either — the
  `GuideTree` slice is the file's existing seam and keeps the predicate
  testable with the fixture already there.
- The equivalence sweep in the test is the drift guard: if `guideTargets`'
  skip rule ever changes, the sweep goes red before the hover colour lies.

### Item 2 — the inert paint (A2)

**Failing test:** in `outlineGuideStyles.test.ts`, after "keeps the lit guide
a square-ended hairline":

```ts
// A range with nothing to fold still lights -- the dim line is the answer,
// where silence would read as a dead hit test -- but in the muted text
// colour instead of the accent. Recolour only: geometry stays in the base
// rule, which matches any data-guide-hot value.
it("dims the lit line where the range has nothing to fold", () => {
  const inert = rule(notesStyles, '.notes-node[data-guide-hot="inert"]::before');
  expect(inert).toContain("background: var(--text-3);");
  expect(inert).not.toContain("inset");
  expect(inert).not.toContain("width");
});
```

Red today: no such rule exists, so `rule()` throws `missing rule: …`.

**Mechanism.** In `notes.css`, immediately after the base lit rule
(after line 1815):

```css
/* A range with nothing to fold still lights -- the tolerance is unchanged,
   and the lit-but-dim line is what says "seen, nothing here" -- but in the
   muted text colour and, via the hook, under the default cursor instead of
   the pointer. Recolour only: position, width, and stacking stay in the rule
   above, which matches any data-guide-hot value. `--text-3` is set in all
   eight theme blocks and no pane override redefines it; `--border-strong`
   was rejected as too close to the resting `--border` hairline at 1px. */
.notes-node[data-guide-hot="inert"]::before {
  background: var(--text-3);
}
```

**Recorded decisions.**
- Value-qualified override beats a `--notes-guide-lit` custom property — one
  writer, two static flavours; the property idiom earns its keep only when
  several rules feed one slot (see design decision 5).
- **Correction (item 1/2 review).** Both rules are (0,2,1) -- qualifying an
  attribute's value adds no specificity -- so the recolour wins on **source
  order alone**, not "in both orders". The doc's original claim was wrong.
  Reordering them would paint every inert guide accent, so the order is pinned
  by a test ("keeps the recolour after the rule it overrides").
- Dead until item 3 writes the value; harmless by design (see item order).

### Item 3 — the hook carries the flavour (A3)

**Failing test:** new file `useOutlineGuideToggle.test.tsx`. Shape (the
implementer owns the exact harness, these constraints bind):

- A harness component renders `<ol className="notes-outline-list" {...useOutlineGuideToggle(store, index, "page")}>`
  with `.notes-node[data-outline-id]` children (a `li`/`div` per row is
  enough; the hook queries by class and attribute, not by the real row DOM).
- `getComputedStyle` is spied (`vi.spyOn(window, "getComputedStyle")`) to
  answer `61` / `36` for `--notes-bullet-center-offset` /
  `--notes-outline-indent` on the rows, delegating everything else to the
  original; the spy is restored after each test — jsdom does not cascade
  custom properties, which is why no DOM test for this hook existed before.
- The index is a hand-rolled object cast to `OutlineIndex` implementing the
  four members the hook reads: `node`, `childrenOf`, `depthOf`,
  `isDescendant`. Store is a dummy (no test clicks).
- Fixture: page → `top` (has child `kid` which has child `grandkid`, so
  `top`'s guide is actionable) and page → `flat` (children are leaves, so
  `flat`'s guide is inert). Rows rendered for the child rows; a mousemove at
  `clientX: 61` on a depth-1 row hits band 0 (row rect left is 0 in jsdom).

Three `it` blocks, each red today:

1. mousemove over `kid` at x=61 → every spanned row has
   `data-guide-hot="true"` and `list.style.cursor === "pointer"`.
   (Red: passes today? No — it passes today. See note below.)
2. mousemove over a child of `flat` at x=61 → spanned rows have
   `data-guide-hot="inert"` and `list.style.cursor === ""`.
   (Red today: the hook writes `"true"` and `"pointer"` unconditionally.)
3. mousemove over `kid` (actionable, lit `"true"`), then rerender the hook
   with an index where `kid` lost `grandkid`, then a second mousemove at the
   same coordinates → rows now read `"inert"` and the cursor is cleared.
   (Red today: `light()`'s memo sees the same `{ownerId, band}` and swallows
   the repaint — this block is the one that pins the memo-key design.)

Block 1 is a regression pin, not red evidence — the red for this item is
blocks 2 and 3, and both must be shown failing verbatim before the
implementation lands. If block 1 cannot be made to pass against today's code
(harness bug), fix the harness before writing any production code: it is the
proof the harness measures the real thing.

**Mechanism.** In `useOutlineGuideToggle.ts`:

- `GuideHit` gains `readonly actionable: boolean`.
- `hitFrom` computes it once the owner is known:
  `{ ownerId, band, actionable: guideCanFold(indexRef.current, ownerId) }`
  (import `guideCanFold` alongside the existing helpers).
- `light()` adds the third comparison:
  `if (lit?.ownerId === hit?.ownerId && lit?.band === hit?.band && lit?.actionable === hit?.actionable) return;`
  with a one-line comment: the flavour flips under a stationary pointer when
  the tree is edited, so it is part of what "unchanged" means.
- `paint()` writes the flavour:
  `list.style.cursor = hit?.actionable ? "pointer" : "";` and
  `row.dataset.guideHot = hit.actionable ? "true" : "inert";`
  Comment on the value pair: `"true"` is the historical actionable value —
  nothing qualifies it, and keeping it makes the actionable path byte-
  identical to before the inert flavour existed.
- Nothing else changes: `onClick`/`armedRef` keep comparing
  `ownerId`/`band` (a mid-click flavour flip is handled by `planGuideToggle`
  recomputing targets), and the settle effect already routes through
  `hitFrom` → fresh flavour after every fold.

**Recorded decisions.**
- Flavour recomputed per mousemove rather than per `light()` transition: the
  predicate is O(direct children), and computing it in `hitFrom` is the only
  shape in which the memo key can carry it honestly — computing it inside the
  transition would rebuild the swallowed-flip bug it exists to fix.
- The keyboard-edit-with-frozen-pointer staleness (no mousemove at all, so
  even a flavour-carrying memo never runs) is the same staleness class the
  lit guide already has for band existence today; out of scope, listed as a
  non-goal.
- The deleted-node restore corner stays accent-lit (tree-shape-only
  predicate); see the verified reading — consulting `pending` would flicker
  the colour with click history.

## Known risks

| Risk | Regression it would cause | Containment |
| --- | --- | --- |
| `getComputedStyle` spy leaking across tests | Unrelated jsdom tests read fake geometry | Spy per-test with `mockRestore` in `afterEach`; the spy delegates to the original for everything but the two custom properties |
| WKWebView rendering the value-qualified selector or `--text-3` differently | Inert guide paints accent or nothing in the shipped app | Manual proof steps 4–6 in the real Tauri app; the selector and `var()` recolour are baseline CSS, far below the calc-shape risk the band work carried |
| `guideCanFold` drifting from `guideTargets` in a later edit | Hover colour promises a fold the click will not deliver (or vice versa) | The equivalence sweep in item 1's test goes red on any drift |
| A future selector qualifying `[data-guide-hot="true"]` | Inert rows silently drop the lit geometry | The base rule's comment gains one sentence in item 2 noting it must stay value-unqualified; string tests pin the base rule's contents |

## Manual proof (shortest real user path, fresh Tauri app)

1. Launch the dev desktop app fresh (fresh bundle and process per the
   delivery skill); the browser pane proves nothing here.
2. Build `top → kid → grandkid`, and a sibling `flat` with two leaf children.
3. Hover `top`'s guide (the stripe left of `kid`'s rows): accent-coloured
   line, pointer cursor; click folds, click restores — unchanged.
4. Hover `flat`'s guide (the stripe left of its leaf children): the line
   lights in the muted grey text colour, the cursor stays the plain arrow,
   and a click changes nothing.
5. Outdent `grandkid` so `top`'s range becomes leaf-only, then nudge the
   mouse across `top`'s guide: it now lights dim under the arrow — the
   flavour followed the edit.
6. Switch to a dark theme and repeat step 4: the dim line is clearly
   brighter than the resting hairline and clearly not the accent.
7. Switch to the `yonal-light` theme and repeat steps 3-4. Its accent is
   itself a grey (`#5d6674` against `--text-3` `#8b94a3`), so the two flavours
   sit about 1.9:1 apart at a 1px hairline and the cursor carries most of the
   distinction. Judge whether that reads well enough; the alternative costs a
   new per-theme token, which this design's non-goals rule out.

## Gates

Frontend-only: `npm test`, `npm run lint`, `npm run test:bundle`,
`git diff --check`. Cargo tests/formatting/Clippy explicitly skipped — no
Rust, IPC contract, persistence, or native configuration is touched.
