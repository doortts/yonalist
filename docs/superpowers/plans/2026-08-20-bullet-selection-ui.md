# Multi-bullet selection: count in the status bar, floating action pill, aligned band

## Contract

| Field | Content |
| --- | --- |
| Goal | A multi-bullet selection reads as one thing: its count sits in the app status bar, its actions float in a pill that never hides the breadcrumb, and its highlight is one continuous block whose left edge is the shallowest selected bullet's indent. |
| Acceptance | Rows A1–A9 below. |
| Non-goals | No change to which actions exist or what they do; no change to selection semantics (anchor/head/forest); no rounded corners on the selection band's run boundaries (`:has()` run-edge rules are a possible follow-up, see risks); no focused-pane tracking for the split-view count (sum is shown); no Rust/IPC/persistence change. |
| Boundaries | React + CSS only (`apps/desktop/src`). No IPC payloads, no Rust, no SQLite, no native config. Final gates: `npm test`, `npm run lint`, `npm run build`, `git diff --check`; Cargo gates explicitly skipped. |
| Manual proof | See "Manual proof" at the end — one path through a fresh Tauri dev app. WKWebView is the only paint authority for item 3 (the browser pane is Chromium and proves nothing about the shipped engine). |

### Acceptance rows

| # | Observable pass/fail | Item |
| --- | --- | --- |
| A1 | With N rows selected, the status bar shows `N selected` in the accent color at its right end, immediately before `Online`. | 1 |
| A2 | The count claims no part of the left message slot: that slot keeps its own error > `Saving...` order, and a live band shows its count beside `Online` at the same time as either message. | 1 |
| A3 | The selection action bar no longer renders a visible count (its toolbar `aria-label` keeps the number). | 1 |
| A4 | In split view the status bar shows the sum of both panes' selected rows; closing the secondary pane (or leaving Notes for Settings) drops its contribution. | 1 |
| A5 | While a selection is active the breadcrumb toolbar still renders, and the selection actions render in a pill floating over the outline body's top-right that adds no layout height (rows do not shift when it appears). | 2 |
| A6 | The pill keeps the existing action set and the compact/`⋯` collapse, and the collapse still keys on the pane's width, not the pill's own width. | 2 |
| A7 | Clear selection ✕ is the last control in the pill; the export menu (`trailingAction`) renders inside the pill, before the ✕. | 2 |
| A8 | The outline `<section>` carries `--notes-band-depth` equal to the minimum depth among selected roots, and every selected row's highlight starts at `--notes-band-depth * --notes-outline-indent` from the row's left edge. | 3 |
| A9 | Consecutive selected rows paint as one continuous block (no per-row radius seams, no unpainted strip after a row with an open note); the right edge stays the row end; a solo selected image row still paints no band. | 3 |

## Touched boundaries and files

React/CSS only. Files:

- `apps/desktop/src/App.tsx` — status bar slot, per-pane count state.
- `apps/desktop/src/NotesDetailPanes.tsx` — pass-through prop.
- `apps/desktop/src/NotesOutline.tsx` — count reporting effect; `--notes-band-depth` on the section.
- `apps/desktop/src/SelectionActionBar.tsx` — count span removed, ✕ moved last, compact observer re-anchored.
- `apps/desktop/src/outline/OutlineHeader.tsx` — toolbar always renders; pill wrapper.
- `apps/desktop/src/styles.css` — accent count kind.
- `apps/desktop/src/notes.css` — pill styles; band as a `.notes-node` background layer.
- Tests: `App.test.tsx`, `splitPaneIntegration.test.tsx`, `SelectionActionBar.test.tsx`, `outline/outlineShiftSelect.test.tsx`, `outline/outlineGuideStyles.test.ts`, `image/imageNodeStyles.test.ts`.

Existing tests that must stay green untouched: `appChromeSelectionStyles.test.ts`, `outlineSelectionStyles.test.ts` (both pin only `user-select` rules — no overlap), `outlineSelectionForest.test.tsx`, `outlineMarkerStyles.test.tsx`, and `App.test.tsx`'s "keeps the export target pane-local across ordinary and selection toolbars" (the export menu keeps its current single-instance switch, so exactly one Export button exists at a time).

## Items

Each item is independently committable; order 1 → 2 → 3 (all three touch disjoint acceptance rows; items 1 and 2 both edit `SelectionActionBar.tsx`, so they run sequentially in one agent). No item leaves the tree broken.

### Item 1 — selection count moves to the status bar (A1, A2, A3, A4)

**Failing test:** new test in `apps/desktop/src/App.test.tsx` — after
ctrl-pointerDown on "First thought" and "Second thought" (the fixture's two
top-level rows), `within(screen.getByRole("contentinfo", { name: "Status bar" }))
.getByText("2 selected")` exists and carries `data-kind="selection"`; and with
a store error present the same slot shows only the error. Red today because
`App.tsx:879-882` renders only `state.error` and `Saving...` in
`.statusbar-feedback` — the count query throws. A4's failing test: new test in
`apps/desktop/src/splitPaneIntegration.test.tsx` — open the split
(shift-click "Zoom to item"), ctrl-select one row in each pane, status bar
shows `2 selected`; close the split, it shows `1 selected`. Red for the same
reason.

**Mechanism.** One owner for the displayed state: App.

- `NotesOutline.tsx`: new optional prop
  `onSelectionCountChange?: (paneId: "primary" | "secondary", count: number) => void`.
  One effect, placed with the existing selection effects:
  ```tsx
  const selectedCount = selection.selectedIds.length;
  useEffect(() => {
    onSelectionCountChange?.(paneId, selectedCount);
    return () => onSelectionCountChange?.(paneId, 0);
  }, [onSelectionCountChange, paneId, selectedCount]);
  ```
  The cleanup is what zeroes a pane's contribution when the pane unmounts
  (split closed, Settings opened) — no separate unmount path.
- `NotesDetailPanes.tsx`: add the prop to `NotesDetailPanesProps`, pass it to
  both `<NotesOutline>` instances. The component is `memo`ed, so the callback
  identity must be stable (next bullet).
- `App.tsx`: pane counts state and a stable reducer-style callback:
  ```tsx
  const [paneSelections, setPaneSelections] = useState({ primary: 0, secondary: 0 });
  const onSelectionCountChange = useCallback(
    (paneId: "primary" | "secondary", count: number) =>
      setPaneSelections((current) =>
        current[paneId] === count ? current : { ...current, [paneId]: count }),
    []);
  const selectedCount = paneSelections.primary + paneSelections.secondary;
  ```
  The count renders in the status bar's own actions group, before `Online`,
  leaving the left message slot's existing two-way branch untouched:
  ```tsx
  <div className="statusbar-actions">
    {selectedCount > 0 &&
      <span className="statusbar-selection">{selectedCount} selected</span>}
    <span className="statusbar-state">Online</span>
  </div>
  ```
- `styles.css`: a `.statusbar-selection` beside `.statusbar-state`, accent
  coloured at weight 600 with `tabular-nums` — the count span this replaces
  carried weight 650, and the bar's ambient `--text-3` state weight would not
  read as the band's own readout. Not a `.statusbar-message` variant: that class
  is the left slot's ellipsis behaviour, which a right-aligned count does not
  want.
- `SelectionActionBar.tsx`: delete the `.notes-selection-count` span
  (lines 186-188). Keep the `count` prop — the toolbar `aria-label`
  (`Actions for ${count} selected notes`) still uses it. `notes.css`: delete
  the `.notes-selection-count` block (842-850).
- `SelectionActionBar.test.tsx:43`: replace the
  `getByLabelText("3 notes selected")` assertion with
  `expect(screen.queryByText("3 selected")).toBeNull()` — the count's absence
  from the bar is now the contract.

**Recorded decisions.**
- The status bar is located in tests by `getByLabelText("Status bar")`, not the
  doc's `getByRole("contentinfo")`: the footer sits inside `<main>`, which
  strips `footer`'s implicit `contentinfo` role per HTML-AAM. The accessible
  name is still what the query keys on.
- The count sits at the right rather than in the left message slot. Sharing the
  slot forced a precedence, and every ordering lost something real: behind the
  error the band went unreported exactly when a failed band operation is what
  the reader is looking at, and ahead of `Saving...` it hid the write the band
  itself had just started. At the right the two never compete, and the count
  reads as state — which is what `Online` beside it already is — rather than as
  one more transient message.
- Split view shows the **sum** of both panes. Both panes can hold live
  selections at once (each has its own `useOutlineSelection`, and neither
  clears on pane blur), so any single-pane display would lie about one of
  them; a focused-pane display would need focus tracking that does not exist.

### Item 2 — selection actions become a floating pill; breadcrumb never disappears (A5, A6, A7)

**Failing test:** new test in `apps/desktop/src/App.test.tsx` — after
ctrl-pointerDown on "First thought", both
`screen.getByRole("navigation", { name: "Breadcrumb" })` (helper already at
App.test.tsx:1637) and `screen.getByRole("toolbar", { name: "Actions for 1
selected notes" })` are in the document. Red today because
`OutlineHeader.tsx:117` renders `selectionToolbar ?? <toolbar>` — the
selection bar replaces the toolbar and the breadcrumb query throws. Second red
in the same item: `SelectionActionBar.test.tsx` asserts the ✕ is last —
`const buttons = screen.getAllByRole("button");
expect(buttons.at(-1)).toHaveAccessibleName("Clear selection")` — red today
because Clear is the first child.

**Mechanism.**

- `OutlineHeader.tsx`: the toolbar `<div className="notes-outline-toolbar">`
  renders unconditionally (drop the `selectionToolbar ??` alternative); after
  it, `{selectionToolbar && <div className="notes-selection-float">{selectionToolbar}</div>}`.
  The `exportMenu` prop wiring in `NotesOutline.tsx` stays exactly as is
  (toolbar slot when no selection, pill `trailingAction` when selected) — one
  export menu instance at a time, which is what keeps App.test's pane-local
  export test green. The toolbar's Check/✕ buttons shift left while a
  selection is live (its export slot empties); accepted.
- The pill cannot be literally `position: absolute` against `.notes-outline`:
  it needs a containing block that does not move, and it must add no layout
  height. Both come from a zero-height sticky wrapper with the pill absolute
  inside it (a sticky box is a containing block for absolute children):
  ```css
  .notes-selection-float {
    position: sticky;
    top: 54px;          /* toolbar's 48px + 6px gap */
    z-index: 3;         /* the old bar's layer, above the sticky toolbar's 1 */
    height: 0;          /* floats: contributes no layout height */
  }
  .notes-selection-action-bar {
    position: absolute;
    top: 0;
    inset-inline-end: 16px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-card);
    box-shadow: var(--shadow-modal);
    color: var(--text-2);
  }
  ```
  This replaces the current `.notes-selection-action-bar` block
  (notes.css 827-840: sticky/full-width/border-bottom go). The
  `@media (max-width: 720px)` tweak for the bar (3079-3082) keeps only what
  still applies (tighter gap); `.notes-selection-wide-actions { display: none }`
  stays. The pill's own dropdown (`.notes-selection-action-menu`, z-index 40,
  anchored `top: calc(100% + 4px)`) needs no change — its containing block is
  `.notes-selection-action-menu-root` inside the pill.
- `SelectionActionBar.tsx`: move the `action("Clear selection", …)` call from
  before the count to after `{trailingAction}` — final order: Complete,
  wide structural actions, ⋯, Delete, export, ✕.
- `SelectionActionBar.tsx` `useCompactActions`: the old bar spanned the pane,
  so observing itself measured the pane; the pill is shrink-wrapped, so its
  own width is meaningless. Observe the wrapper instead:
  `observer.observe(target.current.parentElement ?? target.current)` — the
  sticky wrapper is a block child of the pane's flex column and spans its
  width. Comment states the constraint (the pill cannot self-measure the
  pane). The `matchMedia` fallback path is unchanged, so the existing compact
  test (jsdom has no ResizeObserver) stays green as written.

### Item 3 — band left edge aligns to the shallowest selected bullet (A8, A9)

**Failing test:** new test in
`apps/desktop/src/outline/outlineShiftSelect.test.tsx` (its fixture already
builds arbitrary trees and drives Shift+Arrow bands): with `parent` (depth 0)
and `child` (depth 1), select the child alone → the section
(`container.querySelector("section.notes-outline")`) has
`style.getPropertyValue("--notes-band-depth") === "1"`; extend the band to the
parent → `"0"`; clear → property empty. Red today because `NotesOutline.tsx`
never sets the property. Second red in the same item:
`outlineGuideStyles.test.ts` gains assertions that `rule(notesStyles,
".notes-node")` paints the band layer from `var(--notes-band-indent)` and that
`rule(notesStyles, '.notes-node[data-range-selected="true"]')` sets
`--notes-band-paint: var(--accent-soft);` — red today because the band rule
still targets `> .notes-node-main`.

**Mechanism.** The shallowest depth is selection-wide state, so it lives where
the selection is consumed and travels down as an inherited custom property;
each row already knows its own depth, and CSS does the subtraction.

- `NotesOutline.tsx`: selected roots are the shallowest nodes of their
  subtrees by construction (`normalizeSelectedRoots` absorbs descendants), so
  the minimum over roots is the minimum over the whole selection:
  ```tsx
  const bandDepth = useMemo(
    () => selection.selectedRootIds.length === 0
      ? null
      : Math.min(...selection.selectedRootIds.map(
          (id) => index.depthOf(id, outlineRootId))),
    [index, outlineRootId, selection.selectedRootIds]);
  ```
  On the section (next to the existing `data-band`):
  `style={bandDepth === null ? undefined : { "--notes-band-depth": bandDepth } as CSSProperties}`.
- `notes.css` `.notes-node` base rule (1743-1768) gains the band as a first
  background layer over the existing guide layer — transparent until a rule
  colors it, so unselected rows pay nothing visible:
  ```css
  --notes-band-paint: transparent;
  --notes-band-indent: calc(
    var(--notes-band-depth, var(--notes-depth)) * var(--notes-outline-indent));
  background-image:
    linear-gradient(var(--notes-band-paint), var(--notes-band-paint)),
    repeating-linear-gradient(to right,
      var(--border) 0 1px, transparent 1px var(--notes-outline-indent));
  background-repeat: no-repeat;
  background-position:
    var(--notes-band-indent) 0,
    var(--notes-bullet-center-offset) 0;
  background-size:
    calc(100% - var(--notes-band-indent)) 100%,
    var(--notes-indent) 100%;
  ```
  The `--notes-band-depth` fallback to the row's own depth means a missing
  section value degrades to today's per-row edge, never to a broken paint.
  Band first = band tints over the guide hairlines (`--accent-soft` is
  translucent, so they stay legible), and as the row's own background it sits
  under all row content with no pseudo-elements and no stacking-context games
  (a `::before` band would collide with the lit guide's
  `[data-guide-hot]::before`, and a negative z-index needs an isolation that
  would trap the row's popup menus under later siblings).
- Rule 1911 (`.notes-node[data-range-selected="true"] > .notes-node-main`,
  background + radius) is replaced by
  `.notes-node[data-range-selected="true"] { --notes-band-paint: var(--accent-soft); }`.
  Rule 3285 (`[data-solo-image-selection="true"] > .notes-node-main`) is
  replaced by
  `.notes-node[data-solo-image-selection="true"] { --notes-band-paint: transparent; }`
  — equal specificity, so it must stay after the range-selected rule in file
  order, as it already does; keep both rules' comments.
- Geometry facts making A8/A9 hold: `background-position` on `.notes-node`
  measures from the same left edge `--notes-indent` margins `_main` from
  (the node has no padding/border), so `band-indent == indent` reproduces
  today's left edge exactly on the shallowest row; `.notes-node-main` has no
  right margin, so the right edge is unchanged; `.notes-outline-item` has no
  vertical margins and `.notes-node` is `flow-root`, so adjacent bands touch —
  including the trailing 8px note margin that today leaves an unpainted strip
  after a noted selected row (the band grows by that strip; deliberate).
- Test edits, same item: `outlineGuideStyles.test.ts:25,27` — the guide's
  position/size assertions become the two-layer strings (the guide layer's
  values are unchanged, only now second in the list);
  `imageNodeStyles.test.ts:85-89` — the solo-image pin moves to the new
  selector and asserts `--notes-band-paint: transparent;`.

**Recorded visual deltas (approved treatment allows, reviewer should not
"fix"):** the band loses its per-row 4px radius — square corners are what
makes consecutive rows one block; rounding only a run's outer corners needs
`:has()` run-boundary rules on both edges and is deliberately skipped. The
band on a noted row now also covers the note's trailing 8px margin.

## Runtime evidence (WKWebView, AppleWebKit/605.1.15)

The browser pane is Chromium and proves nothing about the shipped engine, so
both CSS-bearing items were measured with a Swift + WKWebView probe loading the
app's own `styles.css` and `notes.css` over the app's pane nesting.

Item 3 — the two-layer background parses and computes: `CSS.supports` true for
both a two-layer `background-size` and `calc(100% - var(--x))`; with
`--notes-band-depth: 0`, selected rows at depth 0, 1 and 2 all resolved to
`background-position: 0px 0px` and `background-size: 100% 100%` on the band
layer, with the guide layer keeping its own `76px 0px` / `68px 100%`. Unselected
and solo-image rows resolved to no tint.

Item 2 — measured identically in split and non-split: toolbar 48px tall, pill
6px below it, wrapper height 0, first row at 113px against a pill occupying
63-103px (no overlap), and both toolbar and pill unmoved after scrolling the
rows to 400px.

That last measurement corrected a wrong premise in this doc: the vertical
scroller is `.notes-outline-rows`, which sits *below* the wrapper, so the
wrapper's sticky offset never engages against a scroll. The 6px gap comes from
the sticky offset resolving against `.notes-detail-pane` instead:
`gap = 54px - toolbar height`. It degrades safely -- a toolbar taller than 54px
clamps the offset to 0 and the pill rests flush at the toolbar's bottom edge
rather than overlapping it -- but `top: calc(48px + 6px)` does duplicate the
toolbar's own `min-height`, and that coupling is the thing to revisit if the
toolbar's height ever changes.

## Known risks

| Risk | Regression it would cause | Containment |
| --- | --- | --- |
| Multi-layer `background-size` with `calc(100% - var(...))` misparsing in the shipped WKWebView | No band at all, or a full-width band, on every selected row | Manual proof step 4 in the Tauri app; the browser pane (Chromium) is explicitly not evidence (see memory note on WKWebView CSS verification) |
| Sticky zero-height wrapper pinning against the wrong scroller | Pill scrolls away with content, or overlaps the toolbar — split and non-split scroll on different ancestors (`.notes-detail-pane` vs `.detail-scroll`) | The wrapper uses the exact mechanism the toolbar's `sticky top: 0` already proves on both ancestors; manual proof checks both modes |
| Compact observer left on the pill itself | Structural actions permanently collapse into `⋯` (pill width is always < 720), and no jsdom test can catch it (ResizeObserver is absent there) | Item 2 re-anchors the observer to the wrapper; manual proof step 5 narrows the window |
| Count reporting loop (unstable callback identity re-running the report effect) | Render loop or `memo(NotesDetailPanes)` thrashing | `useCallback([])` in App + equality guard in the state setter; effect deps are exactly `[callback, paneId, count]` |
| `Math.min(...roots)` over a very wide selection | Stack overflow on a selection with ~100k+ sibling roots | Selection is bounded far below that today (2,000-node clipboard bound); note the ceiling in a comment only if the reviewer asks |
| Toolbar export slot emptying while a selection is live | Check/✕ buttons shift horizontally when a selection starts | Accepted and recorded; reserving the slot is speculative layout work |
| `--notes-band-depth` read via jsdom `style.getPropertyValue` | Item 3's DOM test silently green/false | React sets custom properties via `setProperty`; jsdom supports reading them — the test must be run red first (property absent ⇒ `""` ≠ `"1"`), which proves the read path too |

## Manual proof (shortest real user path, fresh Tauri app)

1. Launch the dev desktop app fresh (fresh bundle and process per the delivery
   skill).
2. On a page, create: parent bullet → indented child → another top-level
   sibling; give the child a note line.
3. Click the child, Shift+ArrowDown twice to band it with the sibling; then
   extend to the parent with Shift+ArrowUp.
4. Verify at once: breadcrumb still visible; pill floats top-right ~6px below
   the toolbar and the rows did not shift; ✕ is the pill's last control and
   Export sits before it; all three highlights share the parent's left edge and
   read as one block through the note line; right edges unchanged; status bar
   bottom-left shows `3 selected` in accent, `Online` on the right.
5. Narrow the window under 720px: structural actions fold into `⋯` and stay
   reachable; widen, they return.
6. Scroll the outline: pill stays pinned below the toolbar.
7. Shift-click a bullet's zoom control to open the split; band one row in the
   second pane too — status bar shows the sum; close the split — it drops.
8. Press ✕: selection clears, the count leaves the status bar, and a quick
   edit shows `Saving...` again. Trigger any error path if convenient to see
   error > count.

## Gates

Frontend-only: `npm test`, `npm run lint`, `npm run build`, `git diff --check`.
Cargo tests/formatting/Clippy explicitly skipped — no Rust, IPC contract,
persistence, or native configuration is touched.
