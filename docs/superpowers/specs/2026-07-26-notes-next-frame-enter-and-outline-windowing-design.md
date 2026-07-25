# Notes Next-Frame Enter and Outline Windowing Design

## Status

This design extends the accepted split-view input work in
`2026-07-25-notes-split-view-queued-input-performance-design.md`.
It supersedes that document's virtualization non-goal and tightens the Enter
gate from a pre-paint provisional-caret marker to the first paint opportunity.
Persistence ordering, held-Backspace batching, one-gesture Undo, Vault drain,
and authority recovery remain unchanged.

## Contract

| Field | Decision |
| --- | --- |
| Goal | In either split pane, plain Enter presents the newly inserted title caret by the next paint opportunity at p95 <= 16 ms, including while Enter is held, without browser-driven scroll pulling. |
| Acceptance | Clean and dirty Enter meet the 16 ms gate in both panes; a held-Enter gesture delivers every native repeat and advances smoothly; primary/secondary p95 differs by at most 2 ms; the focused title editor DOM survives an Enter chain; off-screen rows are windowed; inactive-pane work does not run before the active pane's first paint; existing IME, formatting, selection, drag, attachment, Undo/Redo, failure recovery, and drain behavior passes. |
| Non-goals | Changing SQLite schemas, IPC payloads, persistence ordering, write-queue semantics, Backspace history semantics, page-title editing, supporting-note editing, image-atom editing, or crash recovery; matching a private Workflowy or Tana implementation detail that is not publicly documented. |
| Boundaries | React title editing, optimistic outline projection, pane-local focus state, scroll ownership, variable-height outline windowing, row geometry observation, inactive-pane publication, development benchmark instrumentation, and macOS Tauri desktop verification. |
| Manual proof | A fresh isolated Tauri process on the existing 5,001-node benchmark Vault, split view open with 50 visible roots, paired primary/secondary runs, and held Enter near the lower viewport boundary. |

## Baseline evidence

The frozen final-source benchmark at `65a3edb` recorded:

| Workload | Primary visible p50 / p95 | Secondary visible p50 / p95 |
| --- | ---: | ---: |
| Clean Enter | 26 / 36 ms | 28 / 38 ms |
| Dirty Enter | 23 / 27 ms | 25 / 29 ms |
| Arrow navigation | 3 / 3 ms | 5 / 6 ms |

A 650 ms held-Enter smoke delivered five operations with 30-75 ms visible
latency. The bounded phase probe placed preparation and queue admission at
0-3 ms, first focus at 34-46 ms, and the draft barrier at 69-79 ms.
Persistence therefore occurs after the visible bottleneck.

The current Enter path synchronously commits a complete provisional
`OutlineNodeRow`, mounts title editing, drag-and-drop and row integrations,
runs pre-paint layout effects, focuses a new textarea with browser scrolling
enabled, auto-grows that textarea by writing `height` and reading
`scrollHeight`, and observes every list child for geometry publication.
The inactive pane is deferred but still performs 7-10 commits around an Enter
operation.

The current benchmark marks `provisional-caret` inside `useLayoutEffect`.
That marker proves DOM focus but occurs before the browser can paint. The new
gate must measure the first animation-frame callback after the caret-ready DOM
change. Where the runtime exposes Event Timing presentation data, record it as
an additional diagnostic; it is not the portable acceptance clock.

## Approaches considered

### 1. Continue memoization and keep one textarea per row

This has the smallest behavioral change, but the frozen experiments already
showed that memo bridges, stable drag items, and prop splitting did not bring
clean Enter below the old 35 ms gate. Keeping every hidden native editor also
keeps the DOM and layout surface proportional to visible row count. Rejected.

### 2. Add only a lightweight provisional row

A title-only provisional row removes most first-frame work and is a useful
vertical slice. It still mounts and focuses a different textarea for every
repeat, leaving browser focus scrolling and repeated editor setup in the
critical path. Retained as an intermediate milestone, not the final
architecture.

### 3. One persistent title editor per pane over windowed static rows

Each pane owns one title textarea. Ordinary rows render presentation and a
geometry slot; the textarea is positioned over the active slot using cached
window metrics. Enter changes the logical editor session and its transform
without replacing or refocusing the DOM node. The list renders only the
viewport, overscan, and pinned interaction rows. Accepted.

## Accepted architecture

### 1. Give each pane one persistent title editor

Add a pane-owned `NotesPaneTitleEditor` outside the row map but inside the
outline scroll coordinate space. It owns the single editable title
`NoteTextField` for ordinary text nodes in that pane.

The pane editor session contains:

```ts
export interface OutlineTitleEditorSession {
  readonly nodeId: NoteId;
  readonly value: string;
  readonly selection: {
    readonly anchorUtf16: number;
    readonly focusUtf16: number;
  };
  readonly interactionEpoch: number;
  readonly optimisticToken: number | null;
  readonly depth: number;
  readonly top: number;
  readonly rowHeight: number;
  readonly titleHeight: number;
}
```

Only the pane editor renders an ordinary title textarea. Resting rows render
`NoteTokenText` and an editor slot with the same font, line height, padding,
indent, and wrapping width. Clicking or keyboard-activating a resting title
claims the pane editor session, places the editor over that row, and restores
the mapped selection. Page titles, supporting notes, image atoms, external
plugin rows, archive/trash rows, and read-only rows retain their specialized
editors.

The same textarea element must remain connected and focused across a plain
Enter chain. Enter updates `session.nodeId`, value, selection, depth, and
cached vertical offset. It must not call `focus()` for each inserted row.
IME composition blocks structural Enter exactly as it does now. Slash
commands, inline formatting, typed dates, tags, clipboard behavior, draft
updates, and selection reporting move with the pane editor session rather
than staying in an individual row component.

Introducing the persistent editor also installs the basic logical geometry
index needed to position it. Claiming an ordinary resting row may measure and
cache its top, total-row height, and title height. Plain Enter must splice the
new row into that index and read the inserted row's cached rectangle; it must
not introduce a DOM or layout read before the first paint opportunity. The
later windowing work extends this same index with variable-height estimation,
range lookup, and anchor correction rather than replacing it.

Changing the logical editor session does not necessarily blur the persistent
textarea. Before pointer, Arrow, F6, supporting-note, pane, Vault, visibility,
or unmount transfer, `releaseTitleSession(reason)` synchronously captures the
current value and selection and invokes the existing draft/commit path. Plain
Enter is the exception: it passes the current draft directly to the prepared
insertion and moves the session atomically, avoiding a second write.

The former row-local structural in-flight flag becomes a map keyed by source
row ID. A second structural command from the same source is rejected, while a
held-Enter repeat on the newly projected row remains eligible and carries the
prior insertion dependency. A single pane-global Boolean would reintroduce the
held-repeat failure.

The resting and focused states must keep identical visible text geometry.
Component tests compare their line box, wrapping width, padding, indent, and
first-line baseline. A focused row may not move when the presentation layer is
replaced by the editor overlay.

The editor overlay remains one persistent list child and does not duplicate
`data-outline-id`. Event routing resolves its logical row from
`data-editor-node-id`; row-local fields continue to resolve their nearest
outline row. The active list item uses `aria-owns` to associate the focused
textbox with its logical row.

### 2. Keep provisional insertion structurally light

An optimistic inserted row initially renders `FastProvisionalOutlineRow`:

- list item and stable row ID;
- depth guides, bullet or todo marker;
- one fixed-height title slot;
- selected/range-selected attributes required by current selection behavior;
- no sortable runtime, menu, supporting-note subtree, attachment subtree,
  date picker, slash menu, auto-grow observer, row geometry observer, or
  per-row focus effect.

The pane title editor supplies the visible textarea over the latest provisional
row. Earlier blank rows created by a held-Enter chain remain static fast rows.

After the first paint opportunity and outside the current key event, schedule
normal row hydration. While Enter remains physically held, hydration may keep
the active provisional chain light and hydrate settled rows in bounded batches.
Keyup, input of non-empty text, blur, pointer interaction, a structural command
other than plain Enter, or an authoritative failure forces the affected row to
hydrate before that interaction continues.

Hydration changes capabilities, not geometry. It must not replace the pane
textarea, move the caret, alter the scroll anchor, create another history
entry, or resubmit persistence.

### 3. Remove `flushSync` from the full outline

The pane editor session and optimistic visible-order patch live in a narrow
pane-local external store consumed with `useSyncExternalStore`. Plain Enter
applies one bounded optimistic splice and editor-session update to that store
without rebuilding the normalized workspace or full outline projection. An
array shift is acceptable at the 5,001-node scale only if the isolated store
update remains below 1 ms p95; otherwise use a chunked visible-order index.
The full Notes workspace, inactive pane, sortable registry, and authoritative
projection do not participate in the synchronous publication.

If a React synchronous boundary remains necessary for the first vertical
slice, it may update only the fast provisional layer and pane editor. The
final architecture must remove the current `flushSync` around
`prepareKeyboardInsertion`.

The existing coordinator still admits the structural command immediately
after the visible patch and publishes settlement later. Failure rolls back the
optimistic splice and restores the pre-insertion editor session and selection.

The external store is a view overlay, not a second workspace authority. It
holds the inserted row plus token-keyed title overrides for both the source
prefix and inserted suffix. If the coordinator's normal optimistic projection
later contains the same inserted ID, the store deduplicates that ID and keeps
fast-row/editor ownership until exact-token settlement. Unrelated
authoritative publication rebases the overlay by stable IDs. Only an exact
token clears its provisional row and title overrides.

Editor and structure subscriptions are separate. Normal typing updates only
the editor snapshot; it must not re-render `NotesOutlinePane` or its window.
Insertion, rollback, hydration, and reconciliation publish the structure
snapshot.

### 4. Use fixed geometry for new blank rows

A blank ordinary title row has a known 28 px initial height. Creating or moving
the pane editor to such a row must not read `scrollHeight`,
`getBoundingClientRect`, `offset*`, or computed style before the first paint.

Auto-growth begins only after the title contains content that may wrap.
Geometry reads are grouped before writes in one animation-frame task. The
result updates the height cache and scroll anchor once. A shared observer may
observe the active editor width, but it must not synchronously resize every
resting row.

### 5. Own scroll explicitly

The pane editor stays focused and uses `focus({ preventScroll: true })` only
when focus is first claimed or restored after an external interaction. Plain
Enter does not focus again.

Each split pane owns an independent vertical scroll host. The outer
`.detail-scroll` must not be the controller target because it is shared by
both panes. Each pane persists and restores its own logical anchor ID and
offset through the existing pane-session scroll state.

`OutlineScrollController` consumes logical row offsets from the window model.
It keeps a top and bottom caret margin and records the newest requested
visibility target. At most once per animation frame it adjusts the pane's
`scrollTop`. It never reads geometry after a style or DOM write in the same
task.

For a repeated blank insertion, the controller advances by the known row
height and updates only when the editor would leave the safe viewport. This
replaces browser focus scrolling and prevents multiple competing scroll
motions. No smooth-scroll animation is used for keyboard insertion.

### 6. Window ordinary outline rows

Add a framework-free variable-height window model with:

- a stable ordered row-ID array;
- a height cache keyed by row ID;
- prefix-sum lookup for offset-to-index and index-to-offset;
- the visible range plus eight rows of overscan on each side;
- scroll anchoring when measured heights change above the viewport;
- O(log n) height and prefix updates, or a measured simpler implementation
  that remains below 1 ms p95 at 5,001 nodes.

Unmeasured rows use deterministic estimates from known row content and
attachment aspect ratios. Observed heights are cached by pane-width bucket so
a wider-pane measurement is not reused after a ratio change or in the other
pane. Width and Vault replacement preserve the logical anchor while resetting
incompatible measurements.

The rendered set is the union of the window range and pinned IDs:

- active title editor;
- page navigation target and pending focus target;
- selected range anchor and head;
- optimistic insertion and failure-recovery rows;
- active drag source, drop target, and drag preview dependencies;
- an open supporting note, menu, date picker, slash menu, or attachment
  interaction.

Selection membership remains logical; pinning thousands of selected rows would
defeat windowing. Rows acquire selected presentation when they enter the
window. Pins are reason-counted so releasing a menu cannot recycle a row that
still owns a supporting note or composition session.

Keyboard navigation always uses the complete logical visible order. If a
target row is outside the current window, update the window and editor session
from the pane-local store before the next paint. Windowing must preserve
ARIA list position metadata and must not make off-screen rows reachable by
Tab until they enter the window.

The ordinary list uses one viewport `ResizeObserver`. Only rendered
variable-height rows are observed. Observer callbacks update the height cache
and publish one geometry generation per animation frame. The existing loop
that observes every list child is removed.

Title height and total row height are separate caches. An active editor height
change adjusts total row height by the title-height delta; it cannot overwrite
space owned by a supporting note or attachment.

Windowing does not make DOM rectangles available for off-screen drag targets.
Pointer and keyboard drag therefore synthesize logical row rectangles from the
height index, with mounted `droppableRects` overriding cached estimates. The
complete logical outline remains the input to drop projection. The drag source
and current target are pinned; off-screen rows do not get hidden droppable DOM.

`GITHUB_NOTIFICATIONS_ROOT_ID` and its external children form one measured
composite block. The external projection renders only while that block is
windowed or pinned, while the zoomed external page retains its specialized
path.

ARIA `posinset` and `setsize` are calculated among logical siblings with the
same parent, not from the flat outline index. Window scrolling resets the FLIP
baseline and does not animate rows merely because they entered the window.

### 7. Keep inactive-pane work after the active paint

Optimistic visible-order and editor-session updates are owned by the active
pane. The inactive pane receives the resulting structural change after the
active pane's first paint opportunity in a queued task. Actions and authority
state remain current; only presentation projection is delayed.

Authoritative settlement may update shared normalized data immediately, but
inactive rows subscribe by visible node ID and window range rather than to the
complete workspace object. An Enter operation may cause at most one
inactive-pane commit before authoritative settlement and none before the
active first-paint marker.

Activating the other pane promotes its latest projection synchronously before
the pointer or keyboard command runs.

### 8. Make the split geometry symmetric

The divider width is excluded before applying `splitRatio`. The host computes
the two fractional tracks from the persisted ratio:

```ts
const primaryTrack = layout.splitRatio;
const secondaryTrack = 1 - layout.splitRatio;
const gridTemplateColumns =
  `${primaryTrack}fr 6px ${secondaryTrack}fr`;
```

At the default ratio, both content panes must have the same width. This removes
the current six-pixel secondary-pane disadvantage and keeps wrapping tests
deterministic.

## Data and event flow

```text
keydown Enter
  -> resolve contextual insertion from the live pane editor session
  -> pane-local optimistic visible-order splice
  -> move the same editor session to the new row
  -> request one explicit scroll adjustment
  -> first animation-frame callback records the paint opportunity
  -> admit the existing queued structural command
  -> hydrate fast rows after paint / outside the held gesture
  -> publish inactive projection after active paint
  -> authoritative settlement reconciles or rolls back
```

No database or IPC behavior changes. Command IDs, optimistic tokens, history
entries, settlement ordering, Undo/Redo, and strict close/Vault drain continue
to use the existing coordinator.

## Failure and interruption behavior

- A rejected insertion removes its fast row, restores the source node and
  exact selection, and keeps the persistent editor connected.
- An ambiguous result enters the existing authority-recovery state. The fast
  row remains visible but read-only until authority is known.
- Composition start cancels pending structural repeat and leaves native IME
  ownership with the pane editor.
- Window blur, document hiding, pane deactivation, Vault switch, and normal
  close stop held-Enter input ownership and trigger the existing drain rules.
- A row pinned by focus, composition, selection, drag, menu, date picker,
  slash menu, or attachment work cannot be recycled.
- A window-range calculation failure falls back to rendering the current
  logical rows for correctness and records a development diagnostic. It does
  not lose the editor session or command.

## Verification

### Focused tests

Add RED tests before each production slice for:

1. at most one ordinary title textarea per open pane, exactly one while an
   editable ordinary title session is active, and no resting-row textareas;
2. identical resting/focused title geometry, including wrapped text;
3. the same textarea DOM identity and focus across single and repeated Enter;
4. no `flushSync`, repeated `focus`, auto-grow read, sortable mount, or row
   observer in the pre-paint provisional path;
5. fixed blank-row height and grouped read-before-write auto-growth;
6. one explicit scroll write per animation frame and no movement while the
   caret remains inside the safe viewport;
7. variable-height range, overscan, pinning, height correction, scroll
   anchoring, keyboard reveal, and ARIA position calculations;
8. no inactive-pane commit before the active first-paint marker;
9. symmetric default pane widths and equivalent wrapping;
10. current IME, inline formatting, slash commands, dates, tags, paste,
    attachments, selection, drag, note editing, Undo/Redo, optimistic failure,
    authority recovery, and Vault drain behavior.

### Benchmark protocol

Freeze a benchmark-only harness before production changes and run it against
`65a3edb`. Reuse the same harness after the diff is frozen.

Use the existing isolated 5,001-node runtime with 50 visible roots per pane.
Keep pane content, width, zoom, expansion, scroll position, and run interval
identical. Alternate primary and secondary samples in the same fresh process
to reduce thermal and run-order bias. Add a position-swap diagnostic that keeps
pane identity while swapping visual columns; report whether any remaining
difference follows pane identity or physical position.

Held-Enter records share a physical gesture ID and repeat index. Related
commands may overlap while they settle without invalidating one another.
Pre-paint commit accounting remains operation-scoped; post-paint work is
counted once per gesture. Benchmark fixture restoration reads a registered
logical pane snapshot rather than assuming every row has a mounted textarea.

For each pane and workload, run 10 warmups and 50 valid samples:

- clean Enter;
- dirty Enter after one title edit;
- Arrow navigation;
- a held-Enter controller with one initial keydown and four native-style
  repeats, restoring the fixture after each gesture.

Record:

- keydown to editor-session publication;
- keydown to caret-ready DOM;
- keydown to first animation-frame paint opportunity;
- handler, React commit, style, layout, paint-opportunity, scroll, active-pane
  commit, inactive-pane commit, authoritative settlement, late-work, and
  backlog durations or counts;
- invalid overlap and missed-repeat counts.

Acceptance gates:

| Gate | Required result |
| --- | --- |
| Clean Enter first paint opportunity | p95 <= 16 ms in each pane |
| Dirty Enter first paint opportunity | p95 <= 16 ms in each pane |
| Primary/secondary difference | absolute p95 difference <= 2 ms |
| Held Enter | every initial/repeat event produces one row; no paint-opportunity sample > 32 ms; no scroll reversal or smooth-scroll tail |
| Editor continuity | one connected textarea and uninterrupted focus for the full Enter chain |
| Pre-paint inactive work | zero inactive-pane commits |
| Backlog | zero incomplete operations or work after the two-second observation point |
| Correctness | exact fixture restoration by the existing Undo sequence |

The 16 ms gate means the app must be ready for the next 60 Hz paint in at least
95 percent of samples. The benchmark reports Event Timing presentation data
when supported but does not fail a WebKit build solely because that optional
API is absent.

### Desktop proof

In a freshly built and restarted benchmark app:

1. place the caret near the lower viewport edge in the primary pane;
2. hold Enter through at least five insertions and confirm continuous,
   one-directional scroll with the caret on the final row;
3. repeat in the secondary pane;
4. repeat with a dirty title, a wrapped title, an IME composition attempt,
   an open supporting note, and a selected range;
5. scroll quickly through a large expanded outline and confirm no blank flash,
   focus loss, selection loss, or drag failure;
6. Undo the inserted rows and verify the exact database and visible fixture;
7. switch Vaults and close normally while writes are pending to confirm the
   existing strict drain still waits.

## Delivery order

1. Freeze and run the new paired baseline harness.
2. Introduce the pane-local editor session and presentation-only resting rows.
3. Keep the editor DOM stable across Enter and add the fast provisional row.
4. Remove full-outline `flushSync`, blank-row auto-grow, and repeated focus.
5. Add explicit scroll ownership and grouped geometry updates.
6. Add variable-height windowing and interaction pinning.
7. Move inactive-pane presentation after active paint and make split widths
   symmetric.
8. Run focused, owning, fresh desktop, frontend, and frozen post-change gates.

Each step keeps a separately testable rollback point. A step that fails its
desktop latency or correctness gate is reverted before the next optimization
is attempted.

## Final gates

Production changes are frontend-only. After the diff is frozen, run once:

- `npm test`
- `npm run lint`
- `npm run build`
- `git diff --check`

Skip Cargo tests, Rust formatting, and Clippy because the design does not
change Rust, IPC payload contracts, persistence, or native configuration.
