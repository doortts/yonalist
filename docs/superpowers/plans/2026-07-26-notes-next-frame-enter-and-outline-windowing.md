# Notes Next-Frame Enter and Outline Windowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plain Enter show the newly inserted title caret by the next paint opportunity at p95 <= 16 ms in either split pane, including held Enter, while preserving editor behavior and windowing off-screen ordinary outline rows.

**Architecture:** Each pane owns one persistent ordinary-title textarea and a pane-local view overlay. Plain Enter synchronously changes only the overlay, the editor session, and a lightweight provisional row; the existing coordinator remains authoritative for persistence, history, settlement, and recovery. A variable-height window model, explicit scroll controller, and model-derived drag geometry remove full-list DOM and browser focus scrolling from the critical path.

**Tech Stack:** React 19, TypeScript, `useSyncExternalStore`, Vitest/Testing Library, `@dnd-kit`, Tauri 2 on macOS, CSS Grid, `ResizeObserver`, `requestAnimationFrame`.

## Global Constraints

- The source contract is `docs/superpowers/specs/2026-07-26-notes-next-frame-enter-and-outline-windowing-design.md`.
- Clean and dirty Enter first-paint-opportunity p95 must be <= 16 ms in both panes.
- The absolute primary/secondary p95 difference must be <= 2 ms.
- One held-Enter gesture must deliver the initial keydown and every repeat; no held-Enter paint-opportunity sample may exceed 32 ms.
- The same connected and focused ordinary-title textarea must survive a complete Enter chain.
- A blank ordinary title row starts at exactly 28 px and performs no pre-paint layout read.
- The ordinary outline window uses eight rows of overscan on each side.
- Inactive-pane presentation performs zero commits before the active pane's first-paint-opportunity mark.
- The pane-local overlay is view-only. The existing coordinator remains the sole owner of persistence ordering, command admission, optimistic tokens, Undo/Redo, settlement, rollback, authority recovery, and strict close/Vault drain.
- Page-title, supporting-note, image-atom, plugin, archive/trash, and read-only editing remain on their current specialized paths.
- Add no runtime dependency and do not change Rust, IPC payloads, SQLite, native configuration, write-queue semantics, or Backspace history semantics.
- Refer to the animation-frame mark as a “paint opportunity,” never proof that pixels were presented. Event Timing presentation data is optional diagnostic evidence.
- Every task ends with a focused test and commit. Do not continue to the next optimization if its desktop correctness or latency checkpoint fails.
- Run the full frontend gates only once after the production diff is frozen: `npm test`, `npm run lint`, `npm run build`, and `git diff --check`.

---

## Contract and file map

### Existing files to modify

- `src/features/notes/notesSplitLatencyProbe.ts`: freeze reproducible phase names, logical pane snapshots, held-Enter identity, and paint-opportunity markers before production changes.
- `src/features/notes/notesSplitLatencyProbe.test.ts`: prove collector origin isolation, phase ordering, held-repeat accounting, and persistent-editor DOM lookup.
- `src/features/notes/NoteTextField.tsx`: support a controlled always-editing mode without changing page-title or supporting-note defaults.
- `src/features/notes/NoteTextField.test.tsx`: prove controlled mode keeps one textarea, slash/formatting behavior, and composition ownership.
- `src/features/notes/OutlineNodeRow.tsx`: remove ordinary-title ownership, `flushSync`, ordinary-title auto-grow, row-local title focus effects, and title-specific handlers after their pane-owned replacements pass.
- `src/features/notes/NotesOutlinePane.tsx`: own the title editor, pane overlay, window, scroll controller, height publication, pins, hydration, and inactive-pane handoff.
- `src/features/notes/OutlineSortableShell.tsx`: expose windowed row metadata and avoid mounting sortable runtime for fast provisional rows.
- `src/features/notes/outlineDom.ts`: resolve the pane editor by `data-editor-node-id` instead of assuming a title textarea inside every row.
- `src/features/notes/outlineDomFocus.ts`: route title focus through a pane editor bridge while leaving supporting-note DOM focus row-local.
- `src/features/notes/outlineDomFocus.test.ts`: cover title-session claims and row-local supporting-note focus separately.
- `src/features/notes/useOutlineLayoutMotion.ts`: ignore window-range churn, limit motion work to mounted structural rows, and reset the baseline after a window change.
- `src/features/notes/useOutlineLayoutMotion.test.tsx`: prove scrolling/window changes do not create FLIP animation.
- `src/features/notes/NotesPaneScope.tsx`: publish inactive presentation after the active paint opportunity while keeping actions and authority current.
- `src/features/notes/NotesPaneScope.test.tsx`: prove active-first ordering and synchronous promotion on pane activation.
- `src/features/notes/NotesDetailSplitHost.tsx`: apply symmetric fractional tracks and teach focus restoration about the pane editor.
- `src/features/notes/notes.css`: add presentation slots, overlay positioning, spacers, window styles, and symmetric split styling.
- `src/features/notes/NotesWorkspace.test.tsx`: replace row-textarea assumptions and preserve the current keyboard, clipboard, date, selection, drag, failure, and drain contracts.
- `src/features/notes/outlineRowMemo.test.tsx`: cover title-controller extraction, held Backspace focus transfer, and no ordinary-title textarea inside a resting row.
- `src/features/notes/OutlineSortableShell.test.tsx`: cover fast-row runtime omission and mounted-window metadata.
- `package.json`: expose benchmark summarization and controller commands only; do not change application dependencies.

### New focused modules

- `src/features/notes/outlineTitleEditorStore.ts`: framework-free pane-local session and view overlay with exact-token reconciliation.
- `src/features/notes/outlineTitleEditorStore.test.ts`: session, splice, rollback, settlement, and release invariants.
- `src/features/notes/useOutlineTitleEditorController.tsx`: pane-owned ordinary-title event controller and explicit session release.
- `src/features/notes/useOutlineTitleEditorController.test.tsx`: normal edit, pointer/arrow/F6 transfer, blur-equivalent release, IME, paste, formatting, date, and recovery tests.
- `src/features/notes/NotesPaneTitleEditor.tsx`: the one persistent `NoteTextField` overlay per pane.
- `src/features/notes/NotesPaneTitleEditor.test.tsx`: DOM identity, focus continuity, selection, and geometry tests.
- `src/features/notes/OutlineTitlePresentation.tsx`: textarea-free resting title presentation and pointer-to-source caret mapping.
- `src/features/notes/OutlineTitlePresentation.test.tsx`: tags, dates, Markdown, remote images, accessibility, and pointer caret tests.
- `src/features/notes/FastProvisionalOutlineRow.tsx`: fixed-geometry provisional shell with no heavy integrations.
- `src/features/notes/FastProvisionalOutlineRow.test.tsx`: exact critical-path omissions and hydration geometry.
- `src/features/notes/outlineWindowModel.ts`: ordered variable-height index, range calculation, pins, anchoring, and logical row rectangles.
- `src/features/notes/outlineWindowModel.test.ts`: range, overscan, insertion, removal, height correction, fallback, and 5,001-row bounds.
- `src/features/notes/outlineInteractionPins.ts`: reason-counted pins for editor, focus, note, menus, composition, attachments, selection head, and drag interactions.
- `src/features/notes/outlineInteractionPins.test.ts`: overlapping pin reasons, release, Vault reset, and large-selection bounds.
- `src/features/notes/outlineScrollController.ts`: newest-target, one-write-per-frame explicit scrolling.
- `src/features/notes/outlineScrollController.test.ts`: safe margins, coalescing, known-height insertion, and read-before-write ordering.
- `src/features/notes/outlineVirtualDragGeometry.ts`: synthesize drag boundaries from the logical height index, with mounted rects overriding cached geometry.
- `src/features/notes/outlineVirtualDragGeometry.test.ts`: off-screen targets, autoscroll, dragged-forest exclusion, and mounted-rect precedence.
- `src/features/notes/notesPanePresentationGate.ts`: operation-scoped active-paint gate for inactive presentation publication.
- `src/features/notes/notesPanePresentationGate.test.ts`: related held repeats, coalescing, activation promotion, and disposal.

### Benchmark tooling to create

- `scripts/notes-split-input-benchmark/summarize.mjs`: schema validation, nearest-rank p50/p95, paired-pane deltas, repeat counts, commit counts, and strict gate verdicts.
- `scripts/notes-split-input-benchmark/summarize.test.ts`: deterministic percentile and gate tests.
- `scripts/notes-split-input-benchmark/make-config.mjs`: create a temporary Tauri override from the tracked benchmark config without editing tracked native configuration.
- `scripts/notes-split-input-benchmark/emit-held-key.swift`: post one initial macOS key event and a fixed number of native-style repeat events to the benchmark process.
- `scripts/notes-split-input-benchmark/run-paired.applescript`: alternate primary/secondary clean, dirty, Arrow, and held-Enter samples in one fresh process.
- `scripts/notes-split-input-benchmark/README.md`: exact fixture, build, permission, run, restoration, and result-export commands.

## Stable interfaces shared by later tasks

These names are fixed for the plan. If implementation discovers a type error, update this section and every consuming task in the same commit.

```ts
export interface OutlineTitleSelection {
  readonly anchorUtf16: number;
  readonly focusUtf16: number;
}

export interface OutlineTitleEditorSession {
  readonly nodeId: NoteId;
  readonly value: string;
  readonly selection: OutlineTitleSelection;
  readonly interactionEpoch: number;
  readonly optimisticToken: number | null;
  readonly depth: number;
  readonly top: number;
  readonly rowHeight: number;
  readonly titleHeight: number;
}

export type OutlineTitleSessionReleaseReason =
  | "pointer-transfer"
  | "keyboard-transfer"
  | "supporting-note"
  | "page-title"
  | "pane-deactivate"
  | "vault-switch"
  | "window-blur"
  | "document-hidden"
  | "unmount";

export interface OutlineProvisionalRow {
  readonly id: NoteId;
  readonly sourceId: NoteId;
  readonly token: number;
  readonly dependencyId: NoteId | undefined;
  readonly row: FlattenedOutlineRow;
  readonly value: string;
  readonly status: "fast" | "hydrating" | "hydrated" | "recovering";
}

export interface OutlineTitleOverride {
  readonly token: number;
  readonly value: string;
}

export interface OutlineTitleOverlaySnapshot {
  readonly revision: number;
  readonly baseGeneration: number;
  readonly session: OutlineTitleEditorSession | null;
  readonly order: readonly NoteId[];
  readonly provisionalRows: ReadonlyMap<NoteId, OutlineProvisionalRow>;
  readonly titleOverrides: ReadonlyMap<NoteId, OutlineTitleOverride>;
}

export type OutlineTitleEditorSnapshot = Pick<
  OutlineTitleOverlaySnapshot,
  "revision" | "session"
>;

export type OutlineTitleStructureSnapshot = Pick<
  OutlineTitleOverlaySnapshot,
  | "revision"
  | "baseGeneration"
  | "order"
  | "provisionalRows"
  | "titleOverrides"
>;

export interface OutlineTitleEditorStore {
  getSnapshot(): OutlineTitleOverlaySnapshot;
  getEditorSnapshot(): OutlineTitleEditorSnapshot;
  getStructureSnapshot(): OutlineTitleStructureSnapshot;
  subscribeEditor(listener: () => void): () => void;
  subscribeStructure(listener: () => void): () => void;
  installBase(input: {
    readonly generation: number;
    readonly order: readonly NoteId[];
  }): void;
  claim(session: OutlineTitleEditorSession): void;
  updateValue(value: string, selection: OutlineTitleSelection): void;
  updateGeometry(input: {
    readonly top: number;
    readonly rowHeight: number;
    readonly titleHeight: number;
  }): void;
  applyInsertion(input: {
    readonly sourceId: NoteId;
    readonly inserted: OutlineProvisionalRow;
    readonly sourceValue: string;
    readonly insertedValue: string;
    readonly insertedSelection: OutlineTitleSelection;
  }): void;
  markHydrating(nodeIds: readonly NoteId[]): void;
  reconcile(input: {
    readonly baseGeneration: number;
    readonly token: number;
    readonly acceptedNodeId: NoteId;
  }): void;
  rollback(input: {
    readonly token: number;
    readonly sourceSession: OutlineTitleEditorSession;
  }): void;
  release(): OutlineTitleEditorSession | null;
}

export interface OutlineTitleFocusBridge {
  claim(nodeId: NoteId, edge: OutlineCaretEdge | null): boolean;
  currentTextarea(): HTMLTextAreaElement | null;
  currentNodeId(): NoteId | null;
}

export interface OutlineWindowRange {
  readonly start: number;
  readonly endExclusive: number;
  readonly topSpacer: number;
  readonly bottomSpacer: number;
  readonly totalHeight: number;
  readonly renderedIds: readonly NoteId[];
}

export interface OutlineRowRect {
  readonly id: NoteId;
  readonly index: number;
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

export interface OutlineAriaPosition {
  readonly level: number;
  readonly positionInSet: number;
  readonly setSize: number;
}

export interface OutlineWindowModel {
  reset(ids: readonly NoteId[], defaultHeight?: number): void;
  splice(index: number, deleteCount: number, inserted: readonly NoteId[]): void;
  updateHeight(id: NoteId, height: number): number;
  indexOf(id: NoteId): number;
  offsetOf(index: number): number;
  rowAtOffset(offset: number): OutlineRowRect | null;
  rectFor(id: NoteId): OutlineRowRect | null;
  totalHeight(): number;
  range(input: {
    readonly scrollTop: number;
    readonly viewportHeight: number;
    readonly overscan: number;
    readonly pinnedIds: ReadonlySet<NoteId>;
  }): OutlineWindowRange;
}

export type OutlineInteractionPinReason =
  | "title-editor"
  | "pending-focus"
  | "composition"
  | "selection-anchor"
  | "selection-head"
  | "supporting-note"
  | "menu"
  | "date-picker"
  | "slash-menu"
  | "attachment"
  | "drag-source"
  | "drop-target"
  | "recovery";

export interface OutlineInteractionPinRegistry {
  pin(nodeId: NoteId, reason: OutlineInteractionPinReason): () => void;
  ids(): ReadonlySet<NoteId>;
  reset(): void;
}

export interface OutlineScrollController {
  requestVisible(nodeId: NoteId): void;
  correctAnchor(delta: number): void;
  dispose(): void;
}

export interface NotesPanePresentationGate {
  begin(input: {
    readonly operationId: string;
    readonly paneId: NotesPaneId;
    readonly relatedGestureId: string | null;
  }): void;
  markActivePaintOpportunity(operationId: string): void;
  queueInactivePublication(revision: number, publish: () => void): void;
  promoteNow(): void;
  dispose(): void;
}
```

The editor store never calls a repository action.
`useOutlineTitleEditorController` calls the current workspace actions, captures
drafts, and then changes the view overlay. Normal typing notifies only editor
subscribers; it cannot re-render `NotesOutlinePane` or its window. Insert,
rollback, hydration, and reconciliation notify structure subscribers. Exact
optimistic-token reconciliation is the only path that removes an accepted
provisional overlay.

The title overlay carries both the inserted row and the split source-title
override. When the coordinator's ordinary optimistic projection later contains
the same inserted ID, `installBase` deduplicates it but keeps the fast-row and
editor ownership until exact-token settlement. Unrelated base publication
rebases the overlay by stable IDs; it never creates a second copy of an
optimistic row.

---

### Task 0: Freeze the paired benchmark and record the pre-change baseline

**Files:**
- Create: `scripts/notes-split-input-benchmark/summarize.mjs`
- Create: `scripts/notes-split-input-benchmark/summarize.test.ts`
- Create: `scripts/notes-split-input-benchmark/make-config.mjs`
- Create: `scripts/notes-split-input-benchmark/emit-held-key.swift`
- Create: `scripts/notes-split-input-benchmark/run-paired.applescript`
- Create: `scripts/notes-split-input-benchmark/README.md`
- Modify: `src/features/notes/notesSplitLatencyProbe.ts:101-147,327-352,424-503,565-713`
- Modify: `src/features/notes/notesSplitLatencyProbe.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx:1540-1610`
- Modify: `package.json`
- Create: `docs/superpowers/reports/2026-07-26-notes-next-frame-enter-baseline.md`

**Interfaces:**
- Consumes: existing `markSplitPhase`, pane profiler commit marks, the ignored 5,001-node fixture seeder, and benchmark origin `http://127.0.0.1:1438`.
- Produces: `SplitInputBenchmarkPhase` values `editor-session`, `caret-ready`, `paint-opportunity`, `authoritative-settled`, `keyup-stop`, and `undo-restored`; `registerNotesSplitInputBenchmarkPaneSnapshot`; strict JSON summaries used unchanged in Task 9.

- [ ] **Step 1: Write collector RED tests for the new clocks and persistent-editor lookup**

Add tests with this behavior:

```ts
expect(sample.elapsedMs.map(({ phase }) => phase)).toEqual([
  "editor-session",
  "caret-ready",
  "paint-opportunity",
  "authoritative-settled",
]);
expect(sample.editorNodeIds).toEqual(["source", "inserted"]);
expect(sample.editorDomIds).toEqual(["pane-editor", "pane-editor"]);
expect(sample.missedRepeats).toBe(0);
```

Construct one fixture with a row-local textarea and one with:

```html
<textarea
  class="notes-node-title"
  data-pane-title-editor="true"
  data-editor-node-id="inserted"
  data-benchmark-dom-id="pane-editor"
></textarea>
```

Assert that both resolve the owning pane and logical node, and that one initial Enter plus four `repeat: true` events creates five operation records under one held gesture.

The five related records may overlap while their queued commands settle. They
must not invalidate one another. Add a separate test proving that a second,
unrelated physical gesture still invalidates an unfinished prior gesture.
Every record has `gestureId` and `repeatIndex`; the gesture has `expectedCount`,
`observedCount`, and `missedRepeats`.

- [ ] **Step 2: Run the collector tests and confirm RED**

Run:

```bash
npm test -- src/features/notes/notesSplitLatencyProbe.test.ts
```

Expected: FAIL because the new phases, persistent-editor node lookup, logical snapshot registration, and repeat counts do not exist.

- [ ] **Step 3: Add phase data without claiming actual paint**

Change the sample shape to retain elapsed values in `snapshot()`:

```ts
export type SplitInputBenchmarkPhase =
  | "editor-session"
  | "caret-ready"
  | "paint-opportunity"
  | "authoritative-settled"
  | "keyup-stop"
  | "undo-restored";

export type SplitInputBenchmarkElapsed = {
  readonly phase: SplitInputBenchmarkPhase;
  readonly elapsedMs: number;
};
```

When `provisional-caret` arrives on the frozen baseline, mark `editor-session`
and `caret-ready`, then schedule exactly one `requestAnimationFrame` callback
that marks `paint-opportunity`. Keep generation, operation ID, logical editor
node ID, and editor DOM ID guards so a later Enter cannot finish an earlier
record. The callback name and report text must say “paint opportunity.”

Replace the collector's singular `activeOperationId` attribution with:

```ts
openOperations: Map<string, {
  readonly paneId: BenchmarkPaneId;
  readonly gestureId: string | null;
  paintOpportunitySeen: boolean;
}>;
```

A pane commit increments every still-open operation from the same physical
gesture only until that operation reaches `paint-opportunity`; gesture-level
post-paint work is counted once on the gesture record. This makes
`inactiveCommitsBeforePaint` exact even while held-Enter settlements overlap.
Related repeats are valid overlap; operations from different gesture IDs are
invalid overlap.

- [ ] **Step 4: Replace DOM-only fixture snapshots with a registered logical getter**

Add:

```ts
export function registerNotesSplitInputBenchmarkPaneSnapshot(
  paneId: BenchmarkPaneId,
  getSnapshot: () => string,
): () => void;
```

`NotesOutlinePane` stores `bodyRows`, current projected title/note values, and the pane focus identity in refs, then registers one stable getter only when the benchmark collector is installed. The serialized shape is:

```ts
{
  rows: bodyRows.map(({ id }) => ({
    id,
    title: projectedTitle(id),
    note: projectedNote(id),
  })),
  focus: {
    id: logicalFocusedNodeId,
    selectionStart,
    selectionEnd,
  },
}
```

Use the getter for held-Backspace pre-state and Undo restoration. Retain the DOM fallback only for isolated collector tests.

- [ ] **Step 5: Add the strict summary script and tests**

The script must:

1. reject unknown schema or missing phases;
2. discard warmups and `invalidOverlap` samples;
3. use nearest-rank `Math.ceil(count * percentile) - 1`;
4. print p50/p95/max for every phase;
5. print active/inactive commits and missed repeats;
6. fail with nonzero exit when any acceptance gate fails;
7. compare primary and secondary p95;
8. report position-swap samples separately.

The core test fixture is:

```ts
expect(nearestRank([1, 2, 3, 4, 100], 0.95)).toBe(100);
expect(evaluateGates({
  primaryP95: 15,
  secondaryP95: 16,
  heldMax: 31,
  inactiveBeforePaint: 0,
  missedRepeats: 0,
  backlog: 0,
}).ok).toBe(true);
```

- [ ] **Step 6: Add reproducible macOS controllers**

`emit-held-key.swift` accepts:

```text
<pid> <keyCode> <initialDelayMs> <repeatIntervalMs> <repeatCount>
```

It posts one key-down with `keyboardEventAutorepeat = false`, then `repeatCount`
key-downs with `keyboardEventAutorepeat = true`, followed by key-up.
`run-paired.applescript` alternates primary and secondary for each pair,
performs 10 warmups and 50 measured samples, verifies focus before every key,
and invokes the result shortcut only after settlement.

Add a benchmark-only collector shortcut that swaps physical columns by setting
inline `gridColumn` on the primary pane, divider, and secondary pane. The
shortcut sets `data-benchmark-pane-order="swapped"` for the result schema and
restores all inline styles on reset/dispose. It must not change `layout`,
`localStorage`, text direction, pane identity, or production CSS.

- [ ] **Step 7: Generate a temporary config instead of editing native configuration**

`make-config.mjs` reads `src-tauri/tauri.split-input-benchmark.conf.json`, replaces only `build.beforeDevCommand` with the supplied temporary Vault path, and writes the result below the benchmark root. It must not modify the tracked config.

Document these commands:

```bash
BENCH_ROOT="$(mktemp -d /tmp/yonalist-split-input-bench.XXXXXX)"
YONALIST_SPLIT_INPUT_BENCH_VAULT="$BENCH_ROOT/vault" \
YONALIST_SPLIT_INPUT_BENCH_NOTES_ROOT="$BENCH_ROOT/app-support" \
cargo test --manifest-path src-tauri/Cargo.toml \
  notes::performance::seed_split_input_benchmark_vault \
  -- --ignored --exact --nocapture
node scripts/notes-split-input-benchmark/make-config.mjs \
  "$BENCH_ROOT/vault" "$BENCH_ROOT/tauri.conf.json"
npm run tauri:dev -- --config "$BENCH_ROOT/tauri.conf.json"
```

- [ ] **Step 8: Run focused benchmark-tool tests**

Run:

```bash
npm test -- src/features/notes/notesSplitLatencyProbe.test.ts scripts/notes-split-input-benchmark/summarize.test.ts
```

Expected: PASS with no collector state leaking between tests.

- [ ] **Step 9: Commit the frozen harness before touching production behavior**

```bash
git add package.json src/features/notes/notesSplitLatencyProbe.ts src/features/notes/notesSplitLatencyProbe.test.ts src/features/notes/NotesOutlinePane.tsx scripts/notes-split-input-benchmark
git commit -m "test(notes): freeze next-frame split benchmark"
```

- [ ] **Step 10: Run and record the baseline**

Use one fresh process and the exact paired protocol. Record:

- source commit;
- 5,001 nodes, 51 roots, five consecutive empty roots;
- 10 warmups and 50 valid samples per pane/workload;
- clean, dirty, Arrow, and held Enter;
- editor-session, caret-ready, paint-opportunity, settlement, scroll writes, active/inactive commits, missed repeats, invalid overlap, and backlog;
- primary/secondary position-swap result.

Write `docs/superpowers/reports/2026-07-26-notes-next-frame-enter-baseline.md` and commit it:

```bash
git add docs/superpowers/reports/2026-07-26-notes-next-frame-enter-baseline.md
git commit -m "docs(notes): record next-frame Enter baseline"
```

Expected checkpoint: reproduce the current approximately 27-38 ms Enter p95 and held-Enter hitching. If the new clock does not reproduce the visible problem, stop and fix the harness before Task 1.

---

### Task 1: Extract pane-owned title behavior and explicit session release

**Files:**
- Create: `src/features/notes/outlineTitleEditorStore.ts`
- Create: `src/features/notes/outlineTitleEditorStore.test.ts`
- Create: `src/features/notes/useOutlineTitleEditorController.tsx`
- Create: `src/features/notes/useOutlineTitleEditorController.test.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx:253-818,977-1636,2380-2600`
- Modify: `src/features/notes/NotesOutlinePane.tsx:700-910,4520-4675`
- Modify: `src/features/notes/outlineRowMemo.test.tsx`

**Interfaces:**
- Consumes: stable interfaces above, `resolveOutlineKey`, existing workspace getters/actions, `useNotesDatePickerIntegration`, `parsePastedOutline`, Backspace gesture callbacks, and existing optimistic insertion preparation.
- Produces: `createOutlineTitleEditorStore`, `useOutlineTitleEditorController`, `OutlineTitleFocusBridge`, and `releaseTitleSession(reason)`.

- [ ] **Step 1: Write store RED tests**

Cover:

```ts
store.installBase({ generation: 7, order: ["a", "b"] });
store.claim(session("a", "alpha", { anchorUtf16: 5, focusUtf16: 5 }));
store.applyInsertion({
  sourceId: "a",
  inserted: provisional("c", 11),
  sourceValue: "al",
  insertedValue: "pha",
  insertedSelection: { anchorUtf16: 0, focusUtf16: 0 },
});
expect(store.getSnapshot().order).toEqual(["a", "c", "b"]);
expect(store.getSnapshot().session?.nodeId).toBe("c");
```

Also assert:

- a settlement for token 10 cannot clear token 11;
- exact token 11 adopts generation 8 and removes only row `c`'s provisional metadata;
- the source title override is `al` while the inserted override is `pha`;
- a base publication that already contains `c` produces exactly one `c` but
  retains its fast status until token 11 settles;
- an unrelated reorder while token 11 is pending rebases `a`/`c` by ID without
  duplicating or dropping either;
- rollback restores the exact source value and selection;
- installing a newer base does not discard an unresolved overlay;
- release returns the last session and sets `session` to null;
- editor subscribers are called once for normal typing while structure
  subscribers are not called;
- both subscriber groups are called once for an atomic insertion, and every
  getter returns a cached object until its own slice changes.

- [ ] **Step 2: Run store tests and confirm RED**

```bash
npm test -- src/features/notes/outlineTitleEditorStore.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the view-only store**

Use cached immutable editor and structure snapshots with separate listener
sets. Clone only the changed order segment, provisional map, and
title-override map. `applyInsertion` installs
token-keyed overrides for the source prefix and inserted suffix in the same
snapshot that moves the editor session. Store no `NoteNode`, draft object,
repository callback, promise, or history identifier other than the optimistic
token.

When a newer base contains a pending provisional ID, deduplicate that ID in the
derived order while preserving its overlay metadata. Clear the source and
inserted overrides only on exact-token settlement or rollback. Reject invalid
base generations and duplicate authoritative IDs by returning to the
authoritative base order and emitting:

```ts
if (import.meta.env.DEV) {
  console.warn("outline title overlay invariant failed", diagnostic);
}
```

The fallback is correctness-first full logical order, not data loss.

- [ ] **Step 4: Write controller RED tests for release without native blur**

Mount a harness with two row-local textareas temporarily bound to the shared controller. Exercise:

1. edit `a`, ArrowDown to `b`;
2. edit `b`, pointer-claim `a`;
3. edit `a`, F6 to the split divider;
4. edit `a`, move to its supporting note;
5. edit `a`, simulate Vault switch/unmount;
6. hold an IME composition and attempt Enter.

Assert each transfer captures the live value and selection, calls the current `updateNodeDraft`/`flushNodeDraft` path exactly once as appropriate, and never relies on a native `blur` event. Enter passes the current `draftToSave()` into the structural command instead of separately flushing the source title first.

- [ ] **Step 5: Implement `useOutlineTitleEditorController` as a behavior-preserving extraction**

Move ordinary-title ownership from `OutlineNodeRow` into the hook in this order:

1. title draft/value lookup;
2. focus and selection acknowledgement;
3. history shortcuts;
4. Backspace gesture admission;
5. `resolveOutlineKey` dispatch;
6. Enter/create-first-child preparation;
7. title change/composition/select/blur-equivalent release;
8. image and subtree paste;
9. tag/date/slash/inline-format callbacks;
10. failure focus restoration.

Do not turn the existing row-local `structuralCommandInFlightRef` into one
pane-global Boolean. The controller owns:

```ts
inFlightBySourceId: Map<NoteId, number>;
```

It rejects a second structural command from the same source ID/token, but plain
Enter on the newly projected provisional source remains eligible and carries
the prior insertion as `dependencyId`. Non-Enter structural commands retain
their existing serialization rule. Add a controller test where the first split
promise stays unresolved while four repeat events advance through four new
source IDs.

The public return shape is:

```ts
export interface OutlineTitleEditorController {
  readonly focusBridge: OutlineTitleFocusBridge;
  readonly datePickerHost: ReactNode;
  claim(input: {
    readonly nodeId: NoteId;
    readonly selection: OutlineTitleSelection;
    readonly source: "pointer" | "keyboard" | "focus-request";
  }): boolean;
  releaseTitleSession(reason: OutlineTitleSessionReleaseReason): void;
  textareaProps(session: OutlineTitleEditorSession):
    Pick<
      NoteTextFieldProps,
      | "value"
      | "onChange"
      | "onBlur"
      | "onKeyDown"
      | "onSelect"
      | "onPaste"
      | "onCompositionStart"
      | "onCompositionEnd"
      | "onTagClick"
      | "onDateClick"
      | "onDateTrigger"
      | "onSlashMarkerCommand"
    >;
}
```

Read the current node, draft, selection, state, and actions at event time. Do not capture a rendered row object in a long-lived callback.

- [ ] **Step 6: Bind current row-local titles to the shared controller**

This is the vertical slice: `NotesOutlinePane` creates one store and one
controller per pane and passes stable bindings into the rows. UI structure is
still one textarea per row, but the title handlers now come from the pane
controller. Supporting notes, images, menus, and sortable shells remain in
`OutlineNodeRow`.

Add an assertion that an ordinary title row no longer creates its own `useNotesDatePickerIntegration` instance. Page and note integrations remain unchanged.

- [ ] **Step 7: Run the owning tests**

```bash
npm test -- src/features/notes/outlineTitleEditorStore.test.ts src/features/notes/useOutlineTitleEditorController.test.tsx src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: all existing title behavior and the new explicit-release cases pass.

- [ ] **Step 8: Commit the behavior-preserving extraction**

```bash
git add src/features/notes/outlineTitleEditorStore.ts src/features/notes/outlineTitleEditorStore.test.ts src/features/notes/useOutlineTitleEditorController.tsx src/features/notes/useOutlineTitleEditorController.test.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "refactor(notes): centralize pane title editing"
```

---

### Task 2: Replace resting ordinary-title textareas with one persistent pane editor

**Files:**
- Create: `src/features/notes/NotesPaneTitleEditor.tsx`
- Create: `src/features/notes/NotesPaneTitleEditor.test.tsx`
- Create: `src/features/notes/OutlineTitlePresentation.tsx`
- Create: `src/features/notes/OutlineTitlePresentation.test.tsx`
- Create: `src/features/notes/outlineWindowModel.ts`
- Create: `src/features/notes/outlineWindowModel.test.ts`
- Modify: `src/features/notes/NoteTextField.tsx:43-71,183-276,531-709`
- Modify: `src/features/notes/NoteTextField.test.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx:2440-2600`
- Modify: `src/features/notes/NotesOutlinePane.tsx:4520-4675,4975-5138`
- Modify: `src/features/notes/outlineDom.ts`
- Modify: `src/features/notes/outlineDomFocus.ts`
- Modify: `src/features/notes/outlineDomFocus.test.ts`
- Modify: `src/features/notes/notes.css:1236-1351,1537-1546`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:3753-3803,6648-7163`

**Interfaces:**
- Consumes: Task 1 store/controller and `OutlineTitleFocusBridge`.
- Produces: one `textarea.notes-node-title[data-pane-title-editor="true"]` per
  active editable ordinary-title session, textarea-free
  `OutlineTitlePresentation` rows, and the basic
  `OutlineWindowModel` offset/splice index used by the Task 3 Enter path.

- [ ] **Step 1: Write persistent-editor RED tests**

Mount two panes with three ordinary rows each. Assert:

```ts
expect(primary.querySelectorAll("textarea.notes-node-title")).toHaveLength(1);
expect(secondary.querySelectorAll("textarea.notes-node-title")).toHaveLength(1);
expect(primary.querySelectorAll("[data-outline-title-presentation]")).toHaveLength(3);
```

Claim `a`, retain the textarea reference, then claim `b` and assert:

```ts
expect(currentTextarea).toBe(originalTextarea);
expect(currentTextarea).toHaveAttribute("data-editor-node-id", "b");
expect(currentTextarea).toHaveFocus();
```

Also assert there is no ordinary-title textarea while no editable session is claimed, and specialized page/note/image fields are unchanged.

- [ ] **Step 2: Write geometry and presentation RED tests**

For plain, Markdown heading, quote, tag/date token, wrapped text, empty text, and remote Markdown image:

- resting and focused font size, weight, line height, padding, inline start, wrapping width, and first-line baseline match;
- pointer coordinates map through `sourceOffsetFromPresentation`;
- tags and dates remain buttons while resting;
- the presentation has `role="group"`, accessible name `Edit node title`, and `tabIndex=0`;
- the active presentation is `aria-hidden`, while the pane textarea owns the accessible textbox.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
npm test -- src/features/notes/NotesPaneTitleEditor.test.tsx src/features/notes/OutlineTitlePresentation.test.tsx src/features/notes/NoteTextField.test.tsx src/features/notes/outlineDomFocus.test.ts
```

Expected: FAIL because the components and focus bridge behavior do not exist.

- [ ] **Step 4: Add the full-render geometry slice of `OutlineWindowModel`**

Before positioning the overlay, write RED tests for `reset`, `updateHeight`,
`offsetOf`, `rectFor`, and `splice`. Mount the current full list, seed every row
at 28 px, and feed the existing row `ResizeObserver` measurements into the
model. A normal pointer/keyboard claim may measure its target row once if its
initial observer entry has not arrived, then updates the model before showing
the editor.

The claimed `OutlineTitleEditorSession` stores `top`, `rowHeight`, and
`titleHeight`. Geometry corrections call `store.updateGeometry`, which notifies
only editor subscribers. Plain Enter in Task 3 will call `model.splice` and
`rectFor(insertedId)` without a DOM/layout read. Task 4 extends this same model
with window ranges, estimates, and pins; it does not replace the index.

Run:

```bash
npm test -- src/features/notes/outlineWindowModel.test.ts
```

- [ ] **Step 5: Add controlled always-editing mode to `NoteTextField`**

Add:

```ts
editingMode?: "internal" | "always";
```

Default to `"internal"`. In `"always"` mode:

- render the textarea and no resting presentation;
- do not keep an independent `editing` source of truth;
- keep slash menu, formatting, composition, date trigger, and selection behavior;
- never schedule reveal/focus work;
- let `NotesPaneTitleEditor` own focus.

Do not change page-title or supporting-note call sites.

- [ ] **Step 6: Implement textarea-free title presentation**

Reuse `NoteTokenText`, `parseNoteMarkdown`, `sourceOffsetFromPresentation`, `NotesRemoteMarkdownImage`, and current CSS variables. The activation callback is:

```ts
onEditRequest(input: {
  readonly nodeId: NoteId;
  readonly selection: OutlineTitleSelection;
  readonly source: "pointer" | "keyboard";
}): void;
```

Extract pointer-to-source offset logic from `NoteTextField` into a shared exported helper rather than duplicating it.

- [ ] **Step 7: Implement the persistent overlay**

`NotesPaneTitleEditor` renders once inside the outline list and outside
`ordinaryBodyRows.map`. It subscribes only to
`store.getEditorSnapshot`/`subscribeEditor`; normal typing must not notify the
pane's structure subscription:

```tsx
<NoteTextField
  editingMode="always"
  data-pane-title-editor="true"
  data-editor-node-id={session.nodeId}
  data-benchmark-dom-id={`${paneId}-title-editor`}
  {...controller.textareaProps(session)}
/>
```

Position with logical `top`, current `depth`, and title width CSS variables. On first claim after external focus, call:

```ts
textarea.focus({ preventScroll: true });
```

Across session-to-session title moves, update value/selection and do not call `focus()` again.

Wrap the overlay in one persistent, absolutely positioned
`<li role="presentation">` under the `<ol>`. This keeps valid list markup and
makes its `top` relative to the logical list rather than the changing page
header. The active logical row sets `aria-owns` to the editor ID; its title
presentation is hidden from accessibility while the focused textbox remains
exposed.

- [ ] **Step 8: Replace only editable ordinary-text title fields**

`OutlineNodeRow` renders `OutlineTitlePresentation` plus a `.notes-node-title-slot`. Keep current specialized title editors for:

- image nodes and image atoms;
- remote image editing mode;
- plugin rows;
- content-protected/read-only rows;
- archive/trash;
- page headers.

Supporting notes remain row-local `NoteTextField` instances.

- [ ] **Step 9: Route focus helpers**

Change `focusOutlineEditorDom`:

```ts
export function focusOutlineEditor(
  paneRoot: HTMLElement,
  titleBridge: OutlineTitleFocusBridge,
  nodeId: NoteId,
  field: "title" | "note",
  edge: OutlineCaretEdge | null,
): boolean {
  return field === "title"
    ? titleBridge.claim(nodeId, edge)
    : focusOutlineSupportingNoteDom(paneRoot, nodeId, edge);
}
```

`outlineTitleTextarea` returns the pane editor only when its `data-editor-node-id` equals the requested ID. Replace direct row-title `.focus()` calls in `NotesOutlinePane` and `OutlineNodeRow` with the bridge.

- [ ] **Step 10: Replace row-ancestor assumptions with logical editor ownership**

Add:

```ts
export function outlineNodeIdFromEventTarget(
  target: EventTarget | null,
): NoteId | null;
```

For the pane title editor it reads `data-editor-node-id`; otherwise it reads
the nearest `[data-outline-id]`. Use it in title key handling, active selection
row lookup, pane copy/cut/paste capture, pointer selection, focus
acknowledgement, attachment paste targeting, benchmark field context, and
failure restoration. The overlay must not pretend to be a row by setting
`data-outline-id`, because that would create a duplicate row identity in DOM
queries and motion/DnD code.

Add tests that fire keyboard, pointer, copy, paste, and focus events from the
overlay and assert they resolve the current logical node.

- [ ] **Step 11: Replace test helpers, not assertions, in the large workspace suite**

Change `findTitleInput(value)`/`getTitleInput(value)` to:

1. find the row presentation or row `data-outline-title-value`;
2. claim that row through pointer/focus when a textbox is needed;
3. return the pane editor and assert `data-editor-node-id`.

Replace the old “native row textareas stay mounted” test with:

- no textarea in resting ordinary rows;
- page and supporting-note textareas remain mounted;
- tag/date buttons remain visible;
- claiming a row reuses the pane textarea.

- [ ] **Step 12: Run the owning tests**

```bash
npm test -- src/features/notes/outlineWindowModel.test.ts src/features/notes/NoteTextField.test.tsx src/features/notes/NotesPaneTitleEditor.test.tsx src/features/notes/OutlineTitlePresentation.test.tsx src/features/notes/outlineDomFocus.test.ts src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: all editor behavior passes; ordinary rows contain no resting title textarea.

- [ ] **Step 13: Perform an early fresh desktop correctness check**

In a freshly built normal app, verify:

- click and pointer caret placement;
- ArrowUp/Down and cross-row Left/Right;
- F6 and supporting-note transfer save the current draft;
- IME composition blocks Enter;
- slash commands, inline formatting, tags, dates, image paste, subtree paste;
- source text does not shift when focus enters or leaves.

Stop here if geometry or any editor feature differs.

- [ ] **Step 14: Commit**

```bash
git add src/features/notes/outlineWindowModel.ts src/features/notes/outlineWindowModel.test.ts src/features/notes/NoteTextField.tsx src/features/notes/NoteTextField.test.tsx src/features/notes/NotesPaneTitleEditor.tsx src/features/notes/NotesPaneTitleEditor.test.tsx src/features/notes/OutlineTitlePresentation.tsx src/features/notes/OutlineTitlePresentation.test.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/outlineDom.ts src/features/notes/outlineDomFocus.ts src/features/notes/outlineDomFocus.test.ts src/features/notes/notes.css src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineRowMemo.test.tsx
git commit -m "feat(notes): add persistent pane title editor"
```

---

### Task 3: Move Enter onto the pane-local fast path

**Files:**
- Create: `src/features/notes/FastProvisionalOutlineRow.tsx`
- Create: `src/features/notes/FastProvisionalOutlineRow.test.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx:13,195-204,607,631-818,1395-1554`
- Modify: `src/features/notes/NotesOutlinePane.tsx:1540-1610,3440-3535,4520-4675,5020-5135`
- Modify: `src/features/notes/notesKeyboardInsertion.test.ts`
- Modify: `src/features/notes/notesSplitLatencyProbe.ts`
- Modify: `src/features/notes/notesSplitLatencyProbe.test.ts`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:6648-7193`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: Task 1 store, Task 2 persistent editor and geometry index,
  existing `prepareKeyboardInsertion`, `runStructuralCommand`, and optimistic
  settlement.
- Produces: same-editor Enter chain, `FastProvisionalOutlineRow`, post-paint hydration queue, and no full-outline `flushSync`.

- [ ] **Step 1: Write RED tests for critical-path omissions**

For one Enter on an ordinary title:

```ts
expect(editorAfter).toBe(editorBefore);
expect(editorAfter).toHaveFocus();
expect(editorAfter.dataset.editorNodeId).toBe(insertedId);
expect(flushSyncSpy).not.toHaveBeenCalled();
expect(focusSpy).not.toHaveBeenCalled();
expect(scrollHeightReads).toBe(0);
expect(sortableMountsFor(insertedId)).toBe(0);
expect(rowObserverTargetsFor(insertedId)).toBe(0);
```

For one initial Enter plus four repeats:

```ts
expect(logicalOrder).toEqual(["source", id1, id2, id3, id4, id5]);
expect(editorDomIds).toEqual(Array(6).fill(editorDomIds[0]));
expect(commandTokens).toHaveLength(5);
expect(new Set(commandTokens).size).toBe(5);
```

- [ ] **Step 2: Write hydration RED tests**

Assert:

- blank fast row height is 28 px;
- no `OutlineSortableRuntime`, menu, note, attachment, date picker, slash menu, or row observer is mounted;
- `keyup`, non-empty input, pointer interaction, non-Enter structural key, or failure forces the affected row to hydrate;
- hydration preserves slot height, editor DOM identity, caret, scroll anchor, history count, and persistence call count;
- window blur and `document.hidden` end held-Enter ownership and schedule bounded hydration.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
npm test -- src/features/notes/FastProvisionalOutlineRow.test.tsx src/features/notes/notesKeyboardInsertion.test.ts src/features/notes/notesSplitLatencyProbe.test.ts src/features/notes/NotesWorkspace.test.tsx
```

- [ ] **Step 4: Bind the physical operation before applying the local overlay**

The keydown order is:

```ts
markSplitPhase(newNodeId, "keydown");
const preparation = actions.prepareKeyboardInsertion?.(request);
if (!preparation) return;
windowModel.splice(insertIndex, 0, [newNodeId]);
titleStore.applyInsertion(localInsertionFrom(preparation, resolution));
markSplitPhase(newNodeId, "editor-session");
runStructuralCommand(() => actions.splitNode(/* existing payload */));
```

The benchmark capture listener has already opened the physical operation.
`keydown` binds that operation to `newNodeId` before any editor-session mark can
fire. If UUID allocation or preparation fails, the existing zero-delay
cancellation closes the unbound/unfinished record.

Extend `SplitLatencyPhase` with the benchmark-only `editor-session`,
`caret-ready`, and `paint-opportunity` bridge marks, or add a dedicated typed
mark function; do not pass an undeclared phase string.

Delete `prepareKeyboardInsertionSynchronously` and the `react-dom` `flushSync`
import. Do not change coordinator admission or payload shape. The store overlay
is view-only and keyed by `preparation.pending.intent.token`.

- [ ] **Step 5: Move the same editor session**

In the atomic store update:

- source title becomes the prefix;
- new row title becomes the suffix;
- editor `nodeId` becomes the inserted ID;
- selection becomes `{ anchorUtf16: 0, focusUtf16: 0 }`;
- optimistic token and depth are updated;
- `top`, `rowHeight`, and `titleHeight` come from the already-updated logical
  geometry index;
- no focus call occurs.

Mark `editor-session` when the store mutation returns, `caret-ready` in the
pane editor layout effect after DOM value/selection match, and
`paint-opportunity` in the next guarded animation-frame callback. Every mark
must verify operation ID, optimistic token, logical editor node ID, and the
unchanged benchmark DOM ID.

- [ ] **Step 6: Render fast rows and hydrate outside the key event**

Use a pane queue:

```ts
interface ProvisionalHydrationQueue {
  enqueue(nodeId: NoteId): void;
  flush(maxRows: number): void;
  force(nodeId: NoteId): void;
  cancel(): void;
}
```

While Enter is held, flush at most two non-active rows per idle callback. On keyup flush up to eight per idle callback until empty. If `requestIdleCallback` is absent, use a zero-delay task and stop after 4 ms of work.

- [ ] **Step 7: Reconcile only exact tokens**

Accepted settlement:

- install the new authoritative base generation;
- clear only matching provisional metadata;
- keep the pane editor session on the accepted node;
- never resubmit a draft or command.

Failure:

- remove the matching local splice;
- restore the source session and exact selection;
- preserve the same textarea;
- surface the existing recovery message.

Ambiguous settlement marks the row `recovering` and prevents edits until the existing authority recovery resolves.

- [ ] **Step 8: Run the owning tests**

```bash
npm test -- src/features/notes/FastProvisionalOutlineRow.test.tsx src/features/notes/outlineTitleEditorStore.test.ts src/features/notes/useOutlineTitleEditorController.test.tsx src/features/notes/notesKeyboardInsertion.test.ts src/features/notes/notesSplitLatencyProbe.test.ts src/features/notes/NotesWorkspace.test.tsx
```

- [ ] **Step 9: Run the first latency checkpoint**

Use the frozen paired harness on the same 50-visible-root fixture. Record clean, dirty, and held Enter before adding windowing.

Pass to continue:

- same editor DOM for all held repeats;
- zero missed repeats;
- zero full-row provisional mounts before paint;
- no correctness failure;
- both pane p95 values improve materially from baseline.

The final 16 ms gate is not required at this intermediate checkpoint. If p95 does not improve, profile the local store/editor commit and do not add windowing on top of an unproven fast path.

- [ ] **Step 10: Commit**

```bash
git add src/features/notes/FastProvisionalOutlineRow.tsx src/features/notes/FastProvisionalOutlineRow.test.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/notesKeyboardInsertion.test.ts src/features/notes/notesSplitLatencyProbe.ts src/features/notes/notesSplitLatencyProbe.test.ts src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "perf(notes): move Enter to pane-local fast path"
```

---

### Task 4: Complete the variable-height window model

**Files:**
- Modify: `src/features/notes/outlineWindowModel.ts`
- Modify: `src/features/notes/outlineWindowModel.test.ts`
- Create: `src/features/notes/outlineRowHeightEstimate.ts`
- Create: `src/features/notes/outlineRowHeightEstimate.test.ts`

**Interfaces:**
- Consumes: `OutlineWindowModel`, `OutlineWindowRange`, and `OutlineRowRect` defined above.
- Produces: pure ordered height index used by scroll, rendering, drag, and editor positioning.

- [ ] **Step 1: Write range and overscan RED tests**

For 100 rows at 28 px, `scrollTop=280`, `viewportHeight=280`, and `overscan=8`, assert the visible core is indexes 10-19 and the returned mounted range includes indexes 2-27. Verify top/bottom spacers sum with rendered heights to `totalHeight`.

- [ ] **Step 2: Write variable-height and anchoring RED tests**

Set heights for rows above, inside, and below the viewport. Assert:

```ts
expect(model.offsetOf(3)).toBe(28 + 56 + 28);
expect(model.rowAtOffset(84)?.id).toBe("c");
expect(model.updateHeight("a", 56)).toBe(28);
```

The returned delta is applied to `scrollTop` only when the changed row is strictly above the anchor row.

- [ ] **Step 3: Write splice, pin, and invariant RED tests**

Cover:

- insert five IDs after one source;
- remove them in reverse;
- preserve cached heights of unchanged IDs;
- render a pinned active editor outside the window without filling the gap;
- pin only selection anchor/head, not every selected row;
- compute `positionInSet`/`setSize` among rows with the same `parentId`, not
  against the flat outline index;
- reset every cached height and index on Vault identity replacement, even if a
  new Vault happens to reuse a node ID;
- keep observed heights by pane-width bucket so a measurement from a wider
  primary pane is not reused after a ratio change or in a narrower secondary
  pane;
- reject duplicate IDs, non-finite heights, negative viewport values, and mismatched spacers;
- fall back to the full logical range with a development diagnostic.

- [ ] **Step 4: Run and confirm RED**

```bash
npm test -- src/features/notes/outlineWindowModel.test.ts
```

- [ ] **Step 5: Implement the height index**

Use:

- `ids: NoteId[]`;
- `indexById: Map<NoteId, number>`;
- numeric heights with default 28;
- a Fenwick tree for `offsetOf`, `rowAtOffset`, and `updateHeight`;
- an O(n) rebuild only for order reset/splice.

Export:

```ts
export function deriveOutlineAriaPositions(
  rows: readonly Pick<FlattenedOutlineRow, "id" | "parentId" | "depth">[],
): ReadonlyMap<NoteId, OutlineAriaPosition>;
```

Group rows by `parentId` in logical order. `level` is `depth + 1`,
`positionInSet` is one-based inside the sibling group, and `setSize` is the
group length.

At 5,001 rows, the benchmark probe around `splice()` must remain below 1 ms p95. If it does not, replace the order storage with 128-entry chunks before integration; do not weaken the gate.

- [ ] **Step 6: Add deterministic initial row estimates**

Export:

```ts
export function estimateOutlineRowHeight(input: {
  readonly node: NoteNode;
  readonly noteValue: string;
  readonly attachments: readonly NoteAttachment[];
  readonly availableWidth: number;
}): number;
```

Use 28 px for a plain one-line row, add the current minimum supporting-note
line/gap when note text is non-empty, and derive image height from
`displayWidth * intrinsicHeight / intrinsicWidth` capped to available width.
The estimate does not read DOM or computed style. Observed heights override it
inside the current pane-width bucket. Width-bucket changes replace unknown
rows with fresh estimates and preserve the logical anchor while rendered rows
are remeasured.

- [ ] **Step 7: Implement disjoint pinned rendering**

`range()` returns one sorted `renderedIds` union. It may contain disjoint pins outside `[start,endExclusive)`, but spacers still describe only the contiguous window. The React integration renders off-window pins in an absolute pinned layer at `rectFor(id).top`, so it does not expand the contiguous DOM range.

- [ ] **Step 8: Run tests**

```bash
npm test -- src/features/notes/outlineWindowModel.test.ts src/features/notes/outlineRowHeightEstimate.test.ts
```

Expected: PASS for 1, 100, and 5,001-row fixtures, nested sibling metadata,
and a Vault replacement with reused IDs.

- [ ] **Step 9: Commit**

```bash
git add src/features/notes/outlineWindowModel.ts src/features/notes/outlineWindowModel.test.ts src/features/notes/outlineRowHeightEstimate.ts src/features/notes/outlineRowHeightEstimate.test.ts
git commit -m "feat(notes): add outline window model"
```

---

### Task 5: Add explicit scroll ownership and batched height publication

**Files:**
- Create: `src/features/notes/outlineScrollController.ts`
- Create: `src/features/notes/outlineScrollController.test.ts`
- Modify: `src/features/notes/NotesPaneTitleEditor.tsx`
- Modify: `src/features/notes/NotesPaneTitleEditor.test.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx:1460-1505,1665-1690,4975-5138`
- Modify: `src/features/notes/NotesDetailSplitHost.tsx:281-350`
- Modify: `src/features/notes/autoGrowTextarea.ts`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Consumes: Task 4 logical offsets and Task 2 persistent editor.
- Produces: `OutlineScrollController.requestVisible(nodeId)` and one frame-batched row-height publisher.

- [ ] **Step 1: Write scroll-controller RED tests**

With a 280 px viewport and 24 px top/bottom margins:

- target entirely inside safe bounds writes nothing;
- target below safe bounds writes the minimal positive delta;
- five requests in one frame produce one `scrollTop` write for the newest target;
- a known 28 px held-Enter chain advances monotonically;
- a newer upward request replaces an older downward request without a reversal tail;
- dispose cancels the pending frame.

Record call order and assert every `scrollTop`, `clientHeight`, and model read precedes the sole write in a frame.

Add a split-host test that scrolls primary and secondary independently. A
primary scroll must not change secondary `scrollTop`, and vice versa.

- [ ] **Step 2: Run and confirm RED**

```bash
npm test -- src/features/notes/outlineScrollController.test.ts
```

- [ ] **Step 3: Implement the controller**

The constructor receives functions so it stays testable:

```ts
createOutlineScrollController({
  readViewport: () => ({ scrollTop, height }),
  rectFor: (id) => windowModel.rectFor(id),
  writeScrollTop: (next) => { scrollHost.scrollTop = next; },
  requestFrame: requestAnimationFrame,
  cancelFrame: cancelAnimationFrame,
  marginTop: 24,
  marginBottom: 24,
});
```

Use direct scrolling only. Do not call `scrollIntoView` or use smooth behavior.

- [ ] **Step 4: Give each split pane an independent scroll host**

The current Notes detail is inside one outer `.detail-scroll`; do not use that
shared element as the controller target. Make each `.notes-detail-pane` a
pane-local vertical scroll host with `position: relative`, `min-height: 0`,
`overflow-y: auto`, and the same stable scrollbar gutter. Keep
`.notes-detail-split` height-bounded so the outer `.detail-scroll` does not
become a competing scroll owner.

Restore responsive single-pane overflow behavior below the existing 720 px
breakpoint. On each pane scroll, persist the first logical anchor ID and offset
through the existing pane `setScroll` action; restore that pair after Vault
hydration or pane activation.

- [ ] **Step 5: Remove ordinary-title auto-grow from rows**

Keep supporting-note and page-title auto-grow. The pane editor:

- uses 28 px for blank/single-line initial geometry;
- schedules a read phase only after non-empty input or width change;
- reads editor `scrollHeight` and rendered variable-row heights;
- keeps a title-height cache separate from the window model's total-row-height
  cache;
- computes the new total row height as `oldTotal + (newTitle - oldTitle)`
  before the row observer confirms it;
- schedules one write phase to update editor height, title slot, total row
  height, and scroll anchor;
- never reads layout after a write in the same task.

- [ ] **Step 6: Replace per-child observation with one rendered-row observer**

Use one `ResizeObserver` owned by the pane. Observe:

- the active editor;
- mounted variable-height ordinary rows only;
- the outline viewport.

Collect all entries, update the total-row-height cache, then publish one
geometry generation in one animation frame. An editor measurement updates only
the title-height cache plus the calculated row delta; it must not overwrite a
row total that also contains a supporting note or attachment. Delete the
current loop over every list child.

- [ ] **Step 7: Run focused tests**

```bash
npm test -- src/features/notes/outlineScrollController.test.ts src/features/notes/NotesPaneTitleEditor.test.tsx src/features/notes/autoGrowTextarea.test.ts src/features/notes/NotesWorkspace.test.tsx
```

- [ ] **Step 8: Desktop scroll checkpoint**

Near the lower viewport edge, hold Enter for at least five rows in each pane. Confirm:

- one-directional scrolling;
- no browser pull before the controller write;
- no focus call after the first claim;
- no blank-row `scrollHeight` read;
- wrapped input grows without moving the first-line baseline;
- scroll stays still while the caret remains inside margins.
- primary and secondary retain independent scroll positions through pane
  activation and app layout persistence.

- [ ] **Step 9: Commit**

```bash
git add src/features/notes/outlineScrollController.ts src/features/notes/outlineScrollController.test.ts src/features/notes/NotesPaneTitleEditor.tsx src/features/notes/NotesPaneTitleEditor.test.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesDetailSplitHost.tsx src/features/notes/autoGrowTextarea.ts src/features/notes/notes.css
git commit -m "perf(notes): own outline scroll and height updates"
```

---

### Task 6: Integrate ordinary-row windowing, navigation, motion, and accessibility

**Files:**
- Create: `src/features/notes/outlineInteractionPins.ts`
- Create: `src/features/notes/outlineInteractionPins.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx:1540-1710,1940-2050,3440-3535,4520-4775,5020-5138`
- Modify: `src/features/notes/OutlineSortableShell.tsx:130-347`
- Modify: `src/features/notes/OutlineSortableShell.test.tsx`
- Modify: `src/features/notes/useOutlineLayoutMotion.ts:23-93,149-245,393-end`
- Modify: `src/features/notes/useOutlineLayoutMotion.test.tsx`
- Modify: `src/features/notes/notes.css:1158-1174,1537-1573`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: Task 4 window model, Task 5 height/scroll controller, existing complete logical `bodyRows`, and current keyboard selection/focus actions.
- Produces: windowed ordinary DOM, eight-row overscan, exact keyboard reveal, pinned interactive rows, and no scroll-induced FLIP animation.

- [ ] **Step 1: Write integration RED tests**

For 200 rows with a mocked 280 px viewport:

- fewer than 40 ordinary rows mount;
- first and last mounted ordinary IDs match the eight-row overscan calculation;
- top and bottom spacers sum to total logical height;
- ArrowDown from the last mounted row reveals and focuses the next logical row by the next frame;
- an off-window pending focus target is pinned until its editor session is claimed;
- changing scroll range does not change logical selection.

- [ ] **Step 2: Write accessibility RED tests**

Every mounted ordinary list item has:

```ts
aria-posinset={ariaPosition.positionInSet}
aria-setsize={ariaPosition.setSize}
aria-level={ariaPosition.level}
```

The position and size are among logical siblings with the same parent, not the
flat list. Off-screen rows are absent from the accessibility tree and Tab
order. A selected row that later enters the window immediately renders
`data-range-selected="true"` from model state.

- [ ] **Step 3: Write motion RED tests**

Change only the window start/end and assert:

```ts
expect(animateOutlineMotion).not.toHaveBeenCalled();
expect(captureOutlineMotionRects).not.toHaveBeenCalledForUnmountedRows();
```

For a real structural move inside the mounted window, existing FLIP behavior still runs. A window-range change resets the idle baseline after the range commit.

- [ ] **Step 4: Run and confirm RED**

```bash
npm test -- src/features/notes/OutlineSortableShell.test.tsx src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

- [ ] **Step 5: Implement a reason-counted interaction pin registry**

`pin(nodeId, reason)` returns an idempotent release callback. A row remains
pinned until every active reason releases it. Reset on Vault replacement and
pane disposal.

`OutlineNodeRow`, the pane editor, date picker, menus, attachments, selection
controller, and drag controller report pin transitions to the pane. This is
required because row-local `noteOpen` or menu state would otherwise disappear
when a window boundary unmounts the row.

Add a test with one row simultaneously pinned by supporting note and date
picker: releasing either one alone must keep the row mounted.

- [ ] **Step 6: Render the window and spacers**

Keep complete `bodyRows`, `getVisibleNodeIds`, navigation, selection, command resolution, and optimistic projection in logical memory. Render only:

- the contiguous window;
- absolute off-window pins;
- the active fast provisional row;
- specialized external/plugin content under its existing rules.

Use presentation-only spacer list items with `aria-hidden="true"` and `role="presentation"`. Never place one giant transformed wrapper around the list; it would disturb sticky menus and DnD coordinates.

- [ ] **Step 7: Treat external/plugin content as a composite row**

`GITHUB_NOTIFICATIONS_ROOT_ID` and its expanded external projection are not
ordinary window rows. The root occupies one logical composite block whose
measured total includes its external children. Render the external projection
only while that root block is in the window or pinned by an external editor,
menu, focus, or drag interaction. `githubZoomed` keeps its current specialized
page path outside ordinary windowing.

Do not assign the persistent ordinary-title editor to plugin, external,
read-only, archive, or trash rows.

- [ ] **Step 8: Define pins narrowly**

Pin:

- active title editor;
- pending focus/navigation target;
- selection anchor and head only;
- optimistic failure source/target;
- open supporting note, menu, date picker, slash menu, attachment interaction;
- active drag source and current drop target.

Do not pin every ID in a large selection. Selection membership remains logical and is applied when a row enters the window.

- [ ] **Step 9: Reveal before focus**

When a keyboard target is outside the window:

1. calculate its logical rect;
2. request explicit scroll;
3. add a temporary focus pin;
4. publish the window range;
5. claim the persistent editor in the layout effect;
6. remove the temporary pin after the caret-ready mark.

Do not wait for authoritative workspace publication.

- [ ] **Step 10: Make layout motion window-aware**

Pass `windowRevision` and only mounted structural rows into
`useOutlineLayoutMotion`. If only `windowRevision` changes, cancel animations,
capture a fresh mounted baseline after commit, and do not classify
entering/unmounted window rows as structural motion. A composite external block
contributes one motion rectangle; its internal projection manages its own
presentation.

- [ ] **Step 11: Run owning tests**

```bash
npm test -- src/features/notes/outlineWindowModel.test.ts src/features/notes/outlineInteractionPins.test.ts src/features/notes/OutlineSortableShell.test.tsx src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

- [ ] **Step 12: Desktop windowing checkpoint**

On the 5,001-node fixture:

- scroll rapidly through a fully expanded outline;
- navigate with held ArrowDown through window boundaries;
- edit a wrapped title;
- open a supporting note, menu, date picker, and attachment interaction near a boundary;
- expand and interact with the GitHub Notifications composite block;
- verify no blank flash, focus loss, selection loss, or scroll-induced animation.

- [ ] **Step 13: Commit**

```bash
git add src/features/notes/outlineInteractionPins.ts src/features/notes/outlineInteractionPins.test.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/OutlineSortableShell.tsx src/features/notes/OutlineSortableShell.test.tsx src/features/notes/useOutlineLayoutMotion.ts src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/notes.css src/features/notes/NotesWorkspace.test.tsx
git commit -m "perf(notes): window ordinary outline rows"
```

---

### Task 7: Preserve drag, pointer selection, and attachments across window boundaries

**Files:**
- Create: `src/features/notes/outlineVirtualDragGeometry.ts`
- Create: `src/features/notes/outlineVirtualDragGeometry.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx:1164-1259,2336-2430,3458-3478,3535-4300`
- Modify: `src/features/notes/outlinePointerDrop.ts`
- Modify: `src/features/notes/outlinePointerDrop.test.ts`
- Modify: `src/features/notes/outlineDrag.test.ts`
- Modify: `src/features/notes/outlineSelectionDragSession.test.ts`
- Modify: `src/features/notes/NotesAttachmentIngest.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:7195-8000`

**Interfaces:**
- Consumes: Task 4 logical rects, current `droppableRects`, logical `structuralRows`, prepared selection drag, and current pointer-boundary projection.
- Produces: model-derived drag boundaries for every logical ordinary row, with mounted DOM rects as higher-fidelity overrides.

- [ ] **Step 1: Write virtual drag geometry RED tests**

Given 200 logical rows and only rows 20-40 mounted:

- pointer over logical row 80 resolves row 80 after drag autoscroll;
- mounted row 25 uses its measured top/bottom instead of the cached estimate;
- active row and all descendants/selected forest nodes are excluded;
- the tail boundary remains valid after the final logical row;
- stale height generation returns `kind: "retry-after-measure"` rather than a wrong target.
- keyboard sorting from row 40 to logical row 41 reveals/pins row 41 and
  projects the same destination as the pointer path.

- [ ] **Step 2: Run and confirm RED**

```bash
npm test -- src/features/notes/outlineVirtualDragGeometry.test.ts src/features/notes/outlinePointerDrop.test.ts src/features/notes/outlineDrag.test.ts
```

- [ ] **Step 3: Implement model-derived row rectangles**

Expose:

```ts
export function virtualOutlinePointerRows(input: {
  readonly rows: readonly FlattenedOutlineRow[];
  readonly windowModel: OutlineWindowModel;
  readonly scrollHostRect: Pick<DOMRect, "top">;
  readonly scrollTop: number;
  readonly mountedRects: ReadonlyMap<NoteId, { top: number; bottom: number }>;
  readonly excludedIds: ReadonlySet<NoteId>;
}): readonly OutlinePointerRowRect[];
```

Convert logical content offsets to viewport coordinates with:

```ts
viewportTop = scrollHostRect.top + logicalTop - scrollTop;
```

Use mounted rects when present. Do not create hidden droppable DOM nodes for off-screen rows.

- [ ] **Step 4: Replace `droppableRects`-only collision input**

Keep dnd-kit containers for mounted rows and overlay/announcements. Pass only
mounted sortable IDs plus the pinned drag source/target to `SortableContext`;
do not ask `verticalListSortingStrategy` to calculate transforms from missing
rects.

Resolve the logical boundary from virtual geometry first. If the target is
off-screen, do not call `closestCenter` with an absent container. Return a
custom `Collision` entry:

```ts
{
  id: notesPaneDndId(paneId, targetId, "row"),
}
```

The pane consumes `pointerDropBoundaryRef` as the authoritative logical
boundary, pins the target, and lets the next frame mount its real sortable
shell. The command projection always uses complete logical rows.

- [ ] **Step 5: Preserve pointer selection without pinning the range**

During cross-row pointer selection:

- map pointer Y to logical row through the window model;
- update logical selection anchor/head;
- pin only the head until pointerup;
- autoscroll through the explicit scroll controller;
- render selected state for rows as they enter.

Same-row native text selection continues to target the persistent textarea.

- [ ] **Step 6: Preserve keyboard drag across a window boundary**

Provide a window-aware keyboard coordinate resolver to the pane DnD adapter.
Arrow movement chooses the preceding/following logical non-dragged row, asks
the scroll controller to reveal it, pins it, and returns its model-derived
center. Space/Escape/drop semantics and screen-reader announcements remain
owned by dnd-kit. Add tests for single-row and selected-forest keyboard drag at
both window edges.

- [ ] **Step 7: Preserve attachment and image-drop targeting**

Map native image drop position to logical row rectangles. Pin only the active image-drop target and its preview dependency. Keep the current Tauri file-path import boundary and existing target authorization checks.

- [ ] **Step 8: Run owning tests**

```bash
npm test -- src/features/notes/outlineVirtualDragGeometry.test.ts src/features/notes/outlinePointerDrop.test.ts src/features/notes/outlineDrag.test.ts src/features/notes/outlineSelectionDragSession.test.ts src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

- [ ] **Step 9: Desktop interaction checkpoint**

Verify pointer and keyboard single-row drag, multi-selection drag, pointer
selection, autoscroll, off-screen drop, image drop, drag preview, and one-step
Undo on the 5,001-node fixture. Stop if any target changes when the same
gesture is repeated without windowing near the top of the list.

- [ ] **Step 10: Commit**

```bash
git add src/features/notes/outlineVirtualDragGeometry.ts src/features/notes/outlineVirtualDragGeometry.test.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/outlinePointerDrop.ts src/features/notes/outlinePointerDrop.test.ts src/features/notes/outlineDrag.test.ts src/features/notes/outlineSelectionDragSession.test.ts src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): preserve drag across outline windows"
```

---

### Task 8: Defer inactive presentation and make split geometry symmetric

**Files:**
- Create: `src/features/notes/notesPanePresentationGate.ts`
- Create: `src/features/notes/notesPanePresentationGate.test.ts`
- Modify: `src/features/notes/NotesPaneScope.tsx`
- Modify: `src/features/notes/NotesPaneScope.test.tsx`
- Modify: `src/features/notes/NotesDetailSplitHost.tsx:34-41,169-209,281-330`
- Modify: `src/features/notes/notes.css:440-456`
- Modify: `src/features/notes/notesSplitLatencyProbe.ts`
- Modify: `src/features/notes/notesSplitLatencyProbe.test.ts`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `NotesPanePresentationGate`, active pane paint-opportunity
  notification, pane registry activation, and pane-local window/editor stores.
- Produces: `createNotesPanePresentationGate`, no inactive presentation commit
  before active paint, synchronous promotion on activation, and exact
  `${ratio}fr 6px ${1-ratio}fr` tracks.

- [ ] **Step 1: Write active-first RED tests**

Use a controllable animation-frame scheduler:

1. press Enter in primary;
2. commit primary editor/session;
3. before running the frame, assert secondary presentation revision unchanged;
4. run the paint-opportunity callback;
5. run the queued task and assert one secondary revision;
6. activate secondary before the queued task and assert it promotes the latest projection synchronously.

Actions, write authority, error state, and settlement callbacks must remain current throughout.
Add one held-Enter case with five related operation IDs: the gate may publish
the newest inactive revision once after the first eligible active paint, but
must not publish an intermediate stale revision for each repeat.

- [ ] **Step 2: Write symmetric geometry RED tests**

At ratio 0.5 and host width 1006 px:

```ts
expect(primaryWidth).toBe(500);
expect(dividerWidth).toBe(6);
expect(secondaryWidth).toBe(500);
```

At ratios 0.25 and 0.75, assert the divider is excluded before distributing the remaining width. Verify wrapped title line counts are equal after swapping equal content between panes.

- [ ] **Step 3: Run and confirm RED**

```bash
npm test -- src/features/notes/NotesPaneScope.test.tsx src/features/notes/notesSplitLatencyProbe.test.ts src/features/notes/NotesWorkspace.test.tsx
```

- [ ] **Step 4: Implement the operation-scoped presentation gate**

`NotesDetailSplitHost` creates one gate and exposes stable callbacks to both
pane scopes. `NotesOutlinePane` calls `begin` when its local Enter overlay
starts and `markActivePaintOpportunity` from the guarded editor frame mark.
The gate coalesces inactive revisions and schedules them in a zero-delay task
only after the matching active paint.

Related held-repeat operation IDs share a gesture ID. A paint for an earlier
repeat may release only revisions no newer than the active editor revision
observed at that frame. Pane activation calls `promoteNow()` before the
activating pointer/keyboard command.

- [ ] **Step 5: Split current state from presentation state**

Keep action/authority slices immediate. Queue only inactive `stateSlice`/`draftsSlice` presentation publication after the active pane's guarded paint-opportunity callback. Coalesce multiple shared settlements to the newest revision.

On pointerdown, focus, keyboard pane switch, or split activation, cancel the pending inactive publication and install the newest revision synchronously before dispatching the user command.

- [ ] **Step 6: Apply symmetric tracks**

Replace the percentage variable with:

```tsx
style={{
  gridTemplateColumns: layout.splitOpen
    ? `${layout.splitRatio}fr 6px ${1 - layout.splitRatio}fr`
    : "minmax(0, 1fr)",
}}
```

Remove the split-open CSS track formula. Keep persisted ratio semantics and divider keyboard resizing.

- [ ] **Step 7: Update focus restoration**

`PRIMARY_EDITOR_SELECTOR` includes `[data-pane-title-editor="true"]`. Remember logical `data-editor-node-id` as well as DOM. On split close, await `flushAllDrafts()`, release the secondary title session, promote primary state, then restore primary focus with `preventScroll`.

- [ ] **Step 8: Run owning tests**

```bash
npm test -- src/features/notes/notesPanePresentationGate.test.ts src/features/notes/NotesPaneScope.test.tsx src/features/notes/notesSplitLatencyProbe.test.ts src/features/notes/NotesWorkspace.test.tsx
```

- [ ] **Step 9: Run paired position diagnostics**

Use the frozen harness:

- default physical order;
- benchmark-only swapped physical order;
- identical pane identity, content, width, scroll, and workload.

If a remaining latency difference follows physical position, inspect width, scrollbar, and overlay geometry. If it follows pane identity, inspect pane registry/deferred publication. Do not accept unexplained >2 ms p95 difference.

- [ ] **Step 10: Commit**

```bash
git add src/features/notes/notesPanePresentationGate.ts src/features/notes/notesPanePresentationGate.test.ts src/features/notes/NotesPaneScope.tsx src/features/notes/NotesPaneScope.test.tsx src/features/notes/NotesDetailSplitHost.tsx src/features/notes/notes.css src/features/notes/notesSplitLatencyProbe.ts src/features/notes/notesSplitLatencyProbe.test.ts src/features/notes/NotesWorkspace.test.tsx
git commit -m "perf(notes): publish active split pane first"
```

---

### Task 9: Freeze the diff, run correctness gates, rerun the benchmark, and write the final report

**Files:**
- Modify: `docs/superpowers/reports/2026-07-26-notes-next-frame-enter-baseline.md`
- Create: `docs/superpowers/reports/2026-07-26-notes-next-frame-enter-and-outline-windowing.md`
- Modify only if a verified gap remains: focused files from Tasks 1-8

**Interfaces:**
- Consumes: frozen Task 0 harness and every acceptance row.
- Produces: reproducible before/after evidence, final gate results, remaining risks, and a frozen production diff.

- [ ] **Step 1: Run focused regression groups once more**

```bash
npm test -- src/features/notes/outlineTitleEditorStore.test.ts src/features/notes/useOutlineTitleEditorController.test.tsx src/features/notes/NotesPaneTitleEditor.test.tsx src/features/notes/OutlineTitlePresentation.test.tsx src/features/notes/FastProvisionalOutlineRow.test.tsx src/features/notes/outlineWindowModel.test.ts src/features/notes/outlineRowHeightEstimate.test.ts src/features/notes/outlineInteractionPins.test.ts src/features/notes/outlineScrollController.test.ts src/features/notes/outlineVirtualDragGeometry.test.ts src/features/notes/notesPanePresentationGate.test.ts src/features/notes/notesSplitLatencyProbe.test.ts src/features/notes/NotesPaneScope.test.tsx src/features/notes/useOutlineLayoutMotion.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: PASS. Fix failures at their owning module; do not rerun unrelated full gates yet.

- [ ] **Step 2: Run the complete keyboard-repeat audit**

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/notesHeldBackspaceRepeat.test.ts src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Verify:

- plain Enter and eligible empty-row Backspace repeat;
- Arrow navigation repeats;
- Shift+Enter, completion, Tab, move, duplicate, delete, zoom, Undo/Redo, F6, and image Alt+Arrow retain their documented one-shot/consume behavior;
- one held Backspace still restores all removed empty bullets with one Undo.

- [ ] **Step 3: Perform fresh desktop correctness proof**

Use a fresh bundle and process. Confirm the process points at the isolated benchmark Vault. Exercise:

1. clean and dirty Enter near the lower viewport edge in both panes;
2. at least five held Enter insertions in both panes;
3. wrapped title, IME composition, slash command, inline format, date, tag, paste;
4. supporting note, image atom, remote image, read-only/plugin row;
5. rapid scroll, held Arrow navigation, selection, drag, image drop;
6. insertion failure rollback and exact selection restoration;
7. one-step held-Backspace Undo;
8. Vault switch and normal close while writes are pending.

Record observable results, not screenshots unless they diagnose a failure.

- [ ] **Step 4: Freeze the production diff and run final frontend gates once**

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all pass. Explicitly skip Cargo tests, Rust formatting, and Clippy because no Rust, IPC payload, persistence, or native configuration changed.

- [ ] **Step 5: Run the frozen post-change benchmark**

Reuse the exact fixture, process setup, controllers, sample counts, intervals, widths, scroll positions, and summary script from Task 0. Require:

| Gate | Required result |
| --- | --- |
| Clean Enter paint opportunity | p95 <= 16 ms in each pane |
| Dirty Enter paint opportunity | p95 <= 16 ms in each pane |
| Primary/secondary difference | absolute p95 difference <= 2 ms |
| Held Enter | 5/5 events per gesture, no sample > 32 ms |
| Editor continuity | one connected DOM ID and uninterrupted focus |
| Pre-paint inactive work | zero inactive-pane commits |
| Windowing | off-screen ordinary rows absent; mounted count bounded |
| Scroll | no reversal and at most one write per frame |
| Backlog | zero incomplete or late operations at two seconds |
| Undo | exact logical fixture restoration |

If a gate fails, preserve the raw summary, return to the owning task, add a focused RED test, and rerun only that focused test and benchmark row. Do not average a failed run into a pass.

- [ ] **Step 6: Write the final report**

The report must include:

- environment and source commits;
- baseline and after tables for every pane/workload;
- p50/p95/max and percentage change;
- paired pane delta and position-swap diagnosis;
- editor DOM identity and missed-repeat counts;
- scroll writes, active/inactive commits, mounted row counts, and backlog;
- correctness matrix;
- exact commands;
- final frontend gates;
- skipped native gates and why;
- remaining risks.

- [ ] **Step 7: Review the final diff**

Run:

```bash
git status --short
git diff --stat
git diff -- src/features/notes scripts/notes-split-input-benchmark package.json
git diff --check
```

Confirm no temporary Vault path, process ID, raw benchmark dump, generated Tauri config, app-support data, or unrelated user change is staged.

- [ ] **Step 8: Commit the report and any final verified test-only adjustment**

```bash
git add docs/superpowers/reports/2026-07-26-notes-next-frame-enter-and-outline-windowing.md docs/superpowers/reports/2026-07-26-notes-next-frame-enter-baseline.md
git commit -m "docs(notes): report next-frame Enter performance"
```

Do not merge until the report shows every acceptance gate passing or explicitly records the unresolved failure and user-approved scope change.

---

## Self-review

### Spec coverage

- Persistent pane editor and DOM continuity: Tasks 1-3.
- Fast provisional row and held-Enter hydration: Task 3.
- Removal of full-outline `flushSync`: Task 3.
- Fixed 28 px blank geometry and grouped reads/writes: Task 5.
- Explicit scroll ownership: Task 5.
- Geometry index, variable-height window, overscan, pins, anchoring, keyboard
  reveal, and ARIA metadata: Tasks 2, 4, and 6.
- Window-aware selection, drag, drop, and attachments: Task 7.
- Inactive-pane post-paint publication and activation promotion: Task 8.
- Symmetric split geometry and position swap: Task 8.
- IME, formatting, slash, dates, tags, paste, notes, images, selection, history, recovery, and drain: Tasks 1-3 and Task 9.
- Frozen before/after benchmark, 10 warmups, 50 samples, held repeats, and first-paint-opportunity wording: Tasks 0 and 9.
- Frontend-only final gates and native-gate skip: Task 9.

### Placeholder scan

The plan contains no `TBD`, `TODO`, “implement later,” “add appropriate handling,” or undefined “similar to” step. Every new shared type and function used by later tasks is declared in the stable interface section or its producing task.

### Type consistency

- `OutlineTitleEditorSession`, `OutlineTitleSelection`, and `OutlineTitleFocusBridge` keep the same names and fields in Tasks 1-9.
- The store accepts exact optimistic tokens and never accepts a history entry or repository action.
- `OutlineWindowModel.rectFor` returns content-coordinate `OutlineRowRect`; Task 7 performs the only content-to-viewport conversion.
- Title focus goes through `OutlineTitleFocusBridge`; supporting-note focus remains DOM-based.
- “Paint opportunity” is the only required animation-frame acceptance term.

## Execution handoff

Plan complete. Implementation should run task-by-task with a review checkpoint after every commit. Inline execution is the default in the current session. Subagent-driven execution is available only if the user explicitly authorizes delegation.
