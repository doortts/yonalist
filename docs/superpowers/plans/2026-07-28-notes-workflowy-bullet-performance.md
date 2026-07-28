# Notes Workflowy-Style Bullet Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary bullet editing stay responsive under native held Enter, Backspace, and arrow keys by bounding mounted rows and moving live title text out of React's per-key render path.

**Architecture:** Each pane renders a Workflowy-style leading row prefix plus one tail spacer. Each mounted ordinary text bullet uses one row-local contenteditable whose focused source stays in the DOM and publishes after 500 ms or at a correctness boundary; the existing draft engine, serialized write queue, history, retry, authority recovery, and drain remain authoritative. The current optimistic structural projection is reduced to one local-first record without `flushSync`, pane signatures, layout generations, FLIP, or a custom Backspace timer.

**Tech Stack:** React 19, TypeScript, Vitest and Testing Library, `@dnd-kit`, CSS, `ResizeObserver`, Tauri 2 on macOS.

## Global Constraints

- The source contract is `docs/superpowers/specs/2026-07-28-notes-workflowy-bullet-performance-design.md`.
- The branch starts from `gi/main` commit `502af65cacb699ca5a48d2cbfdcf7b4caad3fdf0`.
- Acceptance uses the approved 5,001-node benchmark workload; the existing
  native seeder keeps its `5000|50|5` database signature.
- Every delivered native Enter, Backspace, and arrow keydown is handled in order.
- Held-key frame p95 must be at most 28 ms, with zero frames over 34 ms.
- The prefix uses a 28 px minimum row height, 48 px scroll rounding, and 24-row chunks.
- Ordinary input publishes on one trailing 500 ms timer.
- Korean IME, UTF-16 selections, markdown, tags, dates, slash commands, paste, accessibility, split panes, drag, attachments, retry, recovery, Undo/Redo, and strict drain must remain correct.
- Page titles, supporting notes, image atoms, plugin rows, archive rows, trash rows, and read-only rows stay on their current specialized editor paths.
- Add no runtime dependency, two-sided virtualizer, floating pane editor, SQLite or file-format migration, IPC payload, Rust behavior, or React Compiler change.
- Keep the existing 300 ms write debounce, 2 s maximum write latency, revision checks, write serialization, and structural barriers.
- Do not add Workflowy's narrow macOS delayed-`insertText` Enter suppression unless the same fault is reproduced in WKWebView.
- Use focused tests during implementation. Run the complete frontend gates once after the diff is frozen.

---

## File Map

### Create

- `src/features/notes/outlinePrefix.ts`: pure prefix limit and tail-height calculation.
- `src/features/notes/outlinePrefix.test.ts`: top, middle, bottom, scroll-up, overscroll, and forced-target cases.
- `src/features/notes/plainTextContenteditable.ts`: source extraction, UTF-16 selection, replacement, and plain-text paste helpers.
- `src/features/notes/plainTextContenteditable.test.ts`: DOM normalization and selection tests.
- `src/features/notes/NotesBulletTitleEditor.tsx`: stable row-local ordinary-title surface.
- `src/features/notes/NotesBulletTitleEditor.test.tsx`: isolated editor, timer, IME, command, paste, and accessibility tests.
- `src/features/notes/notesLocalStructure.ts`: minimal local-first Enter record and pure outline projection after the old insertion module is removed.
- `src/features/notes/notesLocalStructure.test.ts`: chained split/create, exact settlement, mismatch, dependency, and rollback-source tests.

### Modify

- `src/features/notes/notesSplitLatencyProbe.ts`
- `src/features/notes/notesSplitLatencyProbe.test.ts`
- `src/features/notes/NotesOutlinePane.tsx`
- `src/features/notes/OutlineNodeRow.tsx`
- `src/features/notes/outlineDom.ts`
- `src/features/notes/outlineDomFocus.ts`
- `src/features/notes/outlineDomFocus.test.ts`
- `src/features/notes/NotesDatePickerIntegration.tsx`
- `src/features/notes/NotesDatePickerIntegration.test.tsx`
- `src/features/notes/notesImageAtomEditorRegistry.ts`
- `src/features/notes/notesWorkspaceTypes.ts`
- `src/features/notes/notesDraftEngine.ts`
- `src/features/notes/notesDraftEngine.test.ts`
- `src/features/notes/useNotesDraftWorkflow.ts`
- `src/features/notes/useNotesHistoryController.ts`
- `src/features/notes/notesWorkspaceRuntime.ts`
- `src/features/notes/notesWorkspaceReducer.ts`
- `src/features/notes/notesWorkspaceCoordinator.ts`
- `src/features/notes/notesWorkspaceCoordinator.test.ts`
- `src/features/notes/useNotesWorkspacePaneRegistry.ts`
- `src/features/notes/useNotesEditingLease.ts`
- `src/features/notes/useNotesEditingLease.test.tsx`
- `src/features/notes/outlineKeyboard.ts`
- `src/features/notes/outlineKeyboard.test.ts`
- `src/features/notes/NotesPaneScope.tsx`
- `src/features/notes/NotesPaneScope.test.tsx`
- `src/features/notes/NotesDetailSplitHost.tsx`
- `src/features/notes/NotesWorkspace.test.tsx`
- `src/features/notes/notesWorkspaceContextSplit.test.tsx`
- `src/features/notes/NotesAttachmentIngest.test.tsx`
- `src/features/notes/NotesQuickJump.integration.test.tsx`
- `src/features/notes/NotesFeature.test.tsx`
- `src/features/notes/outlineRowMemo.test.tsx`
- `src/features/notes/NotesExportMenu.test.tsx`
- `src/features/notes/notes.css`
- `scripts/checkNotesWorkspaceBudgets.mjs`

### Delete after replacement tests pass

- `src/features/notes/notesHeldBackspaceRepeat.ts`
- `src/features/notes/notesHeldBackspaceRepeat.test.ts`
- `src/features/notes/useNotesHeldBackspaceRepeat.ts`
- `src/features/notes/notesKeyboardInsertion.ts`
- `src/features/notes/notesKeyboardInsertion.test.ts`
- `src/features/notes/outlineIdleBaseline.ts`
- `src/features/notes/outlineIdleBaseline.test.ts`
- `src/features/notes/outlineLayoutMotion.ts`
- `src/features/notes/outlineLayoutMotion.test.ts`
- `src/features/notes/useOutlineLayoutMotion.ts`
- `src/features/notes/useOutlineLayoutMotion.test.tsx`
- `src/features/notes/useNotesFrameReconciler.ts`
- `src/features/notes/useNotesDirectCaretReconciliation.ts`
- `src/features/notes/useNotesClaimBoundCaretReconciliation.ts`
- `src/features/notes/outlineInteractionEpoch.ts`
- `src/features/notes/outlineInteractionEpoch.test.ts`
- `src/features/notes/outlineRowProjection.ts`
- `src/features/notes/outlineRowProjection.test.ts`

`notesWorkspaceSettlementRuntime.ts` is deleted only if its two non-insertion
helpers are first inlined at their current call sites and `rg` finds no
remaining import. `autoGrowTextarea.ts` stays because supporting notes and page
fields still use it.

## Stable Interfaces

These names are fixed for all tasks. If a compiler error forces a signature
change, update this section and every later consumer in the same plan commit.

```ts
export const OUTLINE_MINIMUM_ROW_HEIGHT = 28;

export function projectOutlinePrefix(
  totalRows: number,
  viewportHeight: number,
  scrollTop: number,
  targetExpandedLimit?: number,
): Readonly<{ limit: number; tailHeight: number }>;

export interface PlainTextSnapshot {
  readonly source: string;
  readonly selection: NotesHistoryPrimarySelection;
}

export function readPlainText(root: HTMLElement): string;
export function readPlainTextSelection(
  root: HTMLElement,
): NotesHistoryPrimarySelection | null;
export function restorePlainTextSelection(
  root: HTMLElement,
  selection: NotesHistoryPrimarySelection,
): boolean;
export function replacePlainText(
  root: HTMLElement,
  source: string,
  selection?: NotesHistoryPrimarySelection,
): boolean;
export function insertPlainTextAtSelection(
  root: HTMLElement,
  text: string,
): PlainTextSnapshot | null;

export type NotesEditorFlushResult = "flushed" | "deferred" | "cancelled";

export interface NotesEditorFlushAdapter {
  readonly nodeId: NoteId;
  flush(): Promise<NotesEditorFlushResult>;
}

export interface NotesBulletTitleEditorHandle {
  readonly element: HTMLDivElement | null;
  focus(selection?: NotesHistoryPrimarySelection): boolean;
  snapshot(): PlainTextSnapshot | null;
  replaceSource(
    source: string,
    selection?: NotesHistoryPrimarySelection,
  ): boolean;
  flush(): Promise<NotesEditorFlushResult>;
}

export type LocalStructurePostcondition =
  | {
      readonly kind: "split";
      readonly expectedSourceTitle: string;
      readonly expectedInsertedTitle: string;
    }
  | {
      readonly kind: "first-child";
      readonly expectedParentId: NoteId;
      readonly expectedIndex: 0;
      readonly expectedInsertedTitle: "";
    };

export interface LocalStructureEntry {
  readonly token: number;
  readonly sourceId: NoteId;
  readonly insertedId: NoteId;
  readonly ownerPaneId: NotesPaneId;
  readonly historyContext: NotesHistoryContext;
  readonly postcondition: LocalStructurePostcondition;
  readonly sourceSelection: NotesHistoryPrimarySelection;
  readonly sourceTitle: string;
  readonly insertedTitle: string;
  readonly dependencyId: NoteId | null;
  readonly status: "prepared" | "queued" | "running" | "checking";
}
```

The local structure module owns only temporary presentation and exact
postcondition matching. It never writes to the repository. The existing
coordinator owns command admission, structural ordering, history, settlement,
failure, authority recovery, and cross-pane serialization.

---

### Task 1: Freeze held-key and frame acceptance evidence

**Files:**

- Modify: `src/features/notes/notesSplitLatencyProbe.ts:101-240,424-620,727-840`
- Modify: `src/features/notes/notesSplitLatencyProbe.test.ts`

**Interfaces:**

- Consumes: the current benchmark origin `http://127.0.0.1:1438`, pane profiler, native capture-phase key events, and the ignored 5,000-row native fixture.
- Produces: one held-gesture summary with delivered keydown count, frame intervals, p95, frames over 34 ms, final focus ID, and mounted ordinary-row count.

- [ ] **Step 1: Add failing collector tests**

Add a pure summary helper and test it with deterministic frame data:

```ts
export interface HeldKeyFrameSummary {
  readonly deliveredKeydowns: number;
  readonly frameDurationsMs: readonly number[];
  readonly frameP95Ms: number;
  readonly framesOver34Ms: number;
}

expect(summarizeHeldKeyFrames(5, [16, 18, 24, 27, 35])).toEqual({
  deliveredKeydowns: 5,
  frameDurationsMs: [16, 18, 24, 27, 35],
  frameP95Ms: 35,
  framesOver34Ms: 1,
});
```

Add an installed-collector test that dispatches one initial Enter and four
`repeat: true` keydowns before keyup. Assert that they remain one gesture,
record five delivered keydowns, and do not invalidate one another. Add a
second test proving a different key or pane closes the prior gesture.

- [ ] **Step 2: Run the probe test and confirm failure**

Run:

```bash
npm test -- src/features/notes/notesSplitLatencyProbe.test.ts
```

Expected: FAIL because held-gesture grouping, frame intervals, and the new
editor selector do not exist.

- [ ] **Step 3: Implement the smallest gesture sampler**

Keep one active gesture per `paneId + key`. Start a `requestAnimationFrame`
loop on the first non-repeat keydown, append `now - priorFrameAt` on each
callback, count every keydown, and stop on keyup, blur, visibility change, or
collector reset. Do not sample outside an active gesture.

Use one selector that supports both the baseline and the new editor:

```ts
const TITLE_EDITOR_SELECTOR =
  "textarea.notes-node-title, [data-notes-bullet-title]";
```

Read a contenteditable's source with `readPlainText` after Task 3 lands. Until
then, fall back to `element.textContent ?? ""`; the Task 3 commit replaces the
fallback and its test expectation.

The JSON result for each held gesture must include:

```ts
{
  operation,
  paneId,
  deliveredKeydowns,
  frameDurationsMs,
  frameP95Ms,
  framesOver34Ms,
  finalFocusNodeId,
  mountedOrdinaryRows,
}
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
npm test -- src/features/notes/notesSplitLatencyProbe.test.ts
```

Expected: PASS.

- [ ] **Step 5: Record the pre-change desktop baseline**

Use only the isolated benchmark paths already named by the tracked benchmark
configuration:

```bash
mkdir -p /tmp/yonalist-split-input-bench.sNiKPD/vault
mkdir -p /tmp/yonalist-split-input-bench.sNiKPD/app-data
YONALIST_SPLIT_INPUT_BENCH_VAULT=/tmp/yonalist-split-input-bench.sNiKPD/vault YONALIST_SPLIT_INPUT_BENCH_NOTES_ROOT=/tmp/yonalist-split-input-bench.sNiKPD/app-data cargo test --manifest-path src-tauri/Cargo.toml notes::performance::seed_split_input_benchmark_vault -- --ignored --exact --nocapture
npm run tauri:dev -- --config src-tauri/tauri.split-input-benchmark.conf.json
```

In the fresh benchmark app, open split view and capture primary and secondary
held Enter, held Backspace, and held ArrowDown runs. Save the JSON outside the
repository or in the task log; do not add a permanent benchmark artifact.

- [ ] **Step 6: Commit**

```bash
git add src/features/notes/notesSplitLatencyProbe.ts src/features/notes/notesSplitLatencyProbe.test.ts
git commit -m "test(notes): freeze held-key performance evidence"
```

---

### Task 2: Bound each pane with a leading prefix and tail spacer

**Files:**

- Create: `src/features/notes/outlinePrefix.ts`
- Create: `src/features/notes/outlinePrefix.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx:964-966,1939-2050,2394-2400,4555-4720,4976-5121`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:1196-1403`
- Modify: `src/features/notes/notes.css:1180-1190`

**Interfaces:**

- Consumes: complete `ordinaryBodyRows`, `state.pendingFocusId`, `state.editingNoteId`, `activeDragId`, and `dropSurfaceRef`.
- Produces: `projectOutlinePrefix` and a mounted prefix whose `SortableContext` contains mounted IDs only.

- [ ] **Step 1: Write the pure failing tests**

```ts
expect(projectOutlinePrefix(5_001, 685, 0)).toEqual({
  limit: 25,
  tailHeight: 139_328,
});
expect(projectOutlinePrefix(5_001, 685, 1_000).limit).toBe(73);
expect(projectOutlinePrefix(101, 280, 1_400).limit).toBe(82);
expect(projectOutlinePrefix(101, 280, 700).limit).toBe(58);
expect(projectOutlinePrefix(101, 280, -40).limit).toBe(10);
expect(projectOutlinePrefix(101, 280, 0, 71).limit).toBe(71);
expect(projectOutlinePrefix(10, 685, 99_999)).toEqual({
  limit: 10,
  tailHeight: 0,
});
```

- [ ] **Step 2: Run the pure test and confirm failure**

```bash
npm test -- src/features/notes/outlinePrefix.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the exact formula**

```ts
export const OUTLINE_MINIMUM_ROW_HEIGHT = 28;
const OUTLINE_SCROLL_QUANTUM = 48;
const OUTLINE_CHUNK_SIZE = 24;

export function projectOutlinePrefix(
  totalRows: number,
  viewportHeight: number,
  scrollTop: number,
  targetExpandedLimit = 0,
) {
  const rows = Math.max(0, Math.floor(totalRows));
  const viewportRows = Math.ceil(
    Math.max(0, viewportHeight) / OUTLINE_MINIMUM_ROW_HEIGHT,
  );
  const roundedScroll =
    OUTLINE_SCROLL_QUANTUM *
    Math.ceil(Math.max(0, scrollTop) / OUTLINE_SCROLL_QUANTUM);
  const requestedLimit =
    viewportRows +
    OUTLINE_CHUNK_SIZE *
      Math.ceil(
        roundedScroll /
          (OUTLINE_MINIMUM_ROW_HEIGHT * OUTLINE_CHUNK_SIZE),
      );
  const limit = Math.min(
    rows,
    Math.max(requestedLimit, Math.max(0, targetExpandedLimit)),
  );
  return {
    limit,
    tailHeight: (rows - limit) * OUTLINE_MINIMUM_ROW_HEIGHT,
  } as const;
}
```

- [ ] **Step 4: Add failing pane integration tests**

Build a 101-row workspace and set the primary `.notes-outline-rows`
`clientHeight` to 280.

Assert:

```ts
expect(primary.querySelectorAll("[data-outline-id]")).toHaveLength(10);
expect(primary.querySelector(".notes-outline-tail-spacer")).toHaveStyle({
  height: "2548px",
});
```

Set primary `scrollTop = 1400`, dispatch `scroll`, and expect 82 mounted rows
while the secondary pane remains at 10. Scroll primary back to 700 and expect
58 rows, identical first-row DOM identity, and unchanged `scrollTop`.

Add one repeated ArrowDown case that crosses the current prefix and one pointer
drag case that keeps a deep source mounted until drag termination.

- [ ] **Step 5: Integrate the prefix into the existing pane**

Reuse `dropSurfaceRef`; do not create a scroll hook or another scroll element.
Quantize scroll state before calling `setState` so events within the same 48 px
bucket do not render.

Compute the forced one-based limit from the deepest of:

```ts
state.pendingFocusId
state.editingNoteId
activeDragId
deferredDirectFocusId
dropPreview?.beforeId
imageDropTargetId
```

Keep `structuralVisibleIds`, `bodyVisibleIds`, selection, filters, navigation,
and drag projection complete. Slice only the ordinary rendered rows:

```tsx
const mountedOrdinaryRows = ordinaryBodyRows.slice(0, prefix.limit);

{mountedOrdinaryRows.map(renderOrdinaryRow)}
{prefix.tailHeight > 0 && (
  <li
    className="notes-outline-tail-spacer"
    role="presentation"
    aria-hidden="true"
    style={{ height: prefix.tailHeight }}
  />
)}
```

Build `bodySortableIds` from mounted IDs. If `focusBodyTitle` cannot find a
target, store that ID as `deferredDirectFocusId`; the expanded prefix retries
focus once in a layout effect and then clears the request.

Reset the pane's scroll bucket and prefix measurement when the Vault, library
view, zoom root, or active page changes. Preserve `scrollTop` only while the
same pane remains on the same page.

Make the existing host pane-local:

```css
.notes-outline-rows {
  overflow-x: auto;
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

- [ ] **Step 6: Run focused tests**

```bash
npm test -- src/features/notes/outlinePrefix.test.ts
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "independent prefix"
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "prefix boundary"
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "drag source"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/notes/outlinePrefix.ts src/features/notes/outlinePrefix.test.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "perf(notes): bound outline rows with a prefix"
```

---

### Task 3: Build the row-local plain-text title surface

**Files:**

- Create: `src/features/notes/plainTextContenteditable.ts`
- Create: `src/features/notes/plainTextContenteditable.test.ts`
- Create: `src/features/notes/NotesBulletTitleEditor.tsx`
- Create: `src/features/notes/NotesBulletTitleEditor.test.tsx`
- Modify: `src/features/notes/notesImageAtomEditorRegistry.ts:1-40`

**Interfaces:**

- Consumes: `NoteTokenText`, markdown source mapping, date and slash-command pure helpers, inline-format helpers, and the existing editor flush result contract.
- Produces: the stable interfaces listed above and a `NotesEditorFlushAdapter` shared by title and image editors.

- [ ] **Step 1: Write failing DOM utility tests**

Cover all required normalization:

```ts
root.innerHTML = "a&nbsp;b<br>c\u2028d\u2029e<br>";
expect(readPlainText(root)).toBe("a b\nc\nd\ne");
```

Add a source containing `A😀한글`, restore a backward selection from UTF-16
offset 5 to 1, and assert the anchor/focus direction survives. Add plain paste
tests for a collapsed caret and a range replacement. Assert that a selection
outside the root returns `null`.

- [ ] **Step 2: Run the utility test and confirm failure**

```bash
npm test -- src/features/notes/plainTextContenteditable.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the DOM utilities**

Recursively read text nodes and `<br>` elements. Normalize `\u00a0` to a
regular space and `\u2028`/`\u2029` to `\n`; remove exactly one final newline
only when the root's final child is an empty `<br>`.

Use `Range` from the root start to each selection endpoint to calculate UTF-16
offsets. To restore, walk text nodes until each requested UTF-16 offset is
reached, clamp to the source length, then call
`selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)`.

Plain paste deletes the current range, inserts one text node, collapses after
it, and returns the new snapshot. The component dispatches the resulting input
notification; the utility does not know about React.

- [ ] **Step 4: Write failing editor tests**

Render the editor and assert:

```ts
expect(screen.getByRole("textbox", { name: "Edit node title" })).toHaveAttribute(
  "contenteditable",
  "false",
);
expect(container.querySelector("textarea")).toBeNull();
```

Activate it and assert the same root element now has
`contenteditable="plaintext-only"` and raw source text. Test 499 ms without a
publish and 500 ms with exactly one publish. Assert multiple inputs restart one
timer and do not change a parent render counter.

Add cases for:

- composition start, input, blur, and composition end publishing once;
- immediate `flush()` with selection;
- unmount resolving a waiting composition flush as `"cancelled"`;
- plain-text paste;
- slash command keyboard navigation and marker command;
- inline format shortcut;
- typed and resting date callbacks;
- markdown rendered at rest and source while editing;
- tag keyboard activation at rest;
- `role="textbox"`, `aria-multiline="false"`, name, readonly, disabled,
  spellcheck, and autocorrection attributes.

- [ ] **Step 5: Implement the stable editor**

The outer `div.notes-node-title` is never replaced. At rest it contains
`NoteTokenText` or the supplied specialized resting presentation. When editing,
React renders no children for that root; a layout effect installs one raw text
node and restores the requested selection.

On `input`, only set a ref and restart:

```ts
window.clearTimeout(publishTimerRef.current);
dirtyRef.current = true;
publishTimerRef.current = window.setTimeout(publishNow, 500);
```

`publishNow` reads the DOM, compares with the last published source, calls
`onPublish` only when different, and clears the timer. Before Enter, structural
Backspace, Tab, Undo/Redo, or a focus-transferring arrow, publish synchronously
and pass the captured snapshot to `onEditorKeyDown`.

During composition, do not read or replace DOM children. A registered flush
waits for `compositionend`; unmount resolves it as `"cancelled"`.

Prevent default paste, call `insertPlainTextAtSelection`, and dispatch one
bubbling `InputEvent` with `inputType: "insertFromPaste"`.

- [ ] **Step 6: Run the isolated tests**

```bash
npm test -- src/features/notes/plainTextContenteditable.test.ts
npm test -- src/features/notes/NotesBulletTitleEditor.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/notes/plainTextContenteditable.ts src/features/notes/plainTextContenteditable.test.ts src/features/notes/NotesBulletTitleEditor.tsx src/features/notes/NotesBulletTitleEditor.test.tsx src/features/notes/notesImageAtomEditorRegistry.ts
git commit -m "feat(notes): add a DOM-owned bullet title editor"
```

---

### Task 4: Integrate live titles with focus, commands, and drain

**Files:**

- Modify: `src/features/notes/OutlineNodeRow.tsx:109-181,340-818,971-1661,1950-1961,2449-2593`
- Modify: `src/features/notes/outlineDom.ts`
- Modify: `src/features/notes/outlineDomFocus.ts`
- Modify: `src/features/notes/outlineDomFocus.test.ts`
- Modify: `src/features/notes/NotesDatePickerIntegration.tsx:34-78,335-440`
- Modify: `src/features/notes/NotesDatePickerIntegration.test.tsx`
- Modify: `src/features/notes/notesWorkspaceTypes.ts:258-370`
- Modify: `src/features/notes/notesDraftEngine.ts:115,495-530,797-833,1680-1815`
- Modify: `src/features/notes/notesDraftEngine.test.ts:1750-1845`
- Modify: `src/features/notes/useNotesDraftWorkflow.ts:147-215`
- Modify: `src/features/notes/useNotesHistoryController.ts:1030-1053,1470-1499`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts:900-929,1125-1244`
- Modify: `src/features/notes/NotesOutlinePane.tsx:2121-2130,2730-2752,2959-2977`
- Modify: `src/features/notes/NotesDetailSplitHost.tsx:35-41,169-194`
- Modify: `src/features/notes/notesSplitLatencyProbe.ts:424-503,727-741`
- Modify: `src/features/notes/notes.css:1258-1373,1998-2005,2110-2155,2748-2755`
- Modify: owning integration tests listed in the file map.

**Interfaces:**

- Consumes: `NotesBulletTitleEditor`, `NotesEditorFlushAdapter`, existing
  `updateNodeDraft`, draft barriers, and pane editing lease.
- Produces: ordinary text rows with no title textarea and a generic live-editor
  flush registration used by structural commands and lifecycle drain.

- [ ] **Step 1: Add failing integration and drain tests**

In `NotesWorkspace.test.tsx`, replace the ordinary-title test helper so it finds:

```ts
row.querySelector<HTMLDivElement>("[data-notes-bullet-title]")
```

Add assertions that:

- an ordinary writable text row has one title root and no title textarea;
- page title, supporting note, image atom, plugin-backed stored row,
  archive/trash row, and read-only row retain their current specialized path;
- ordinary input causes no outline render before 500 ms;
- blur publishes before another pane claims the same node;
- ArrowDown across a prefix boundary flushes before focus moves;
- a live dirty title is published before zoom, page navigation, editor
  unmount, `flushAllDrafts`, close, and Vault switch drain the write queue;
- retry and strict drain include the draft created by the live-editor flush.

In `notesDraftEngine.test.ts`, register a title adapter and assert the call
order:

```ts
expect(order).toEqual([
  "title-flush",
  "draft-enqueue",
  "write-queue-flush",
]);
```

Add a composition cancellation case that returns `false` from drain.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
npm test -- src/features/notes/notesDraftEngine.test.ts
npm test -- src/features/notes/outlineDomFocus.test.ts src/features/notes/NotesDatePickerIntegration.test.tsx
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "ordinary title"
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "live dirty title"
```

Expected: FAIL on the old textarea path and missing generic flush registration.

- [ ] **Step 3: Generalize the existing flush adapter**

Rename the shared engine map and registration from image-only wording to
editor wording without adding a second map:

```ts
interface NotesEditorFlushAdapter {
  readonly nodeId: NoteId;
  flush(): Promise<NotesEditorFlushResult>;
}

registerEditorFlushAdapter?(
  adapter: NotesEditorFlushAdapter,
): () => void;
```

Make `NotesImageAtomFlushAdapter` extend this interface. Thread
`registerEditorFlushAdapter` through `useNotesDraftWorkflow`,
`useNotesHistoryController`, `notesWorkspaceRuntime`, and
`NotesWorkspaceActions`. Image editors and ordinary title editors call the same
registration.

Before `flushNodeDraft`, `flushDraftBarrier`, and `flushAllDrafts` capture their
effective cutoff, await matching live editors. A `"cancelled"` result fails
closed and uses the existing composition-interrupted notification. A completed
editor flush may create a newer draft, so extend the cutoff exactly as the
image-atom path does today.

- [ ] **Step 4: Replace only ordinary writable text titles**

Use `NotesBulletTitleEditor` only when all are true:

```ts
node.nodeKind === "text"
node.pluginMeta === undefined
!pluginRoot
!readOnly
!contentProtected
```

Keep `NoteTextField` for every excluded row and for all page titles and
supporting notes.

Remove `useAutoGrowTextarea(titleRef, titleValue)` but keep the note call.
Convert ordinary title selection reads to `PlainTextSnapshot`. On publish, call:

```ts
actions.updateNodeDraft(
  nodeId,
  {
    title: source,
    note: noteValue,
    imageOffsetUtf16,
  },
  "title",
);
```

Adapt `handlePaste` to accept both textarea and contenteditable clipboard
events while retaining image paste first and structural multi-line paste
second.

- [ ] **Step 5: Adapt focus and command bridges**

Rename `outlineTitleTextarea` to `outlineTitleEditor`. It queries
`[data-notes-bullet-title]` first and the specialized title textarea second.

In `focusOutlineEditorDom`, titles use
`restorePlainTextSelection`; supporting notes keep `setSelectionRange`.
`NotesDatePickerIntegration` accepts `HTMLTextAreaElement | HTMLDivElement`,
reads title source with `readPlainText`, and restores title focus through the
same utility.

Add `[data-notes-bullet-title]` to `PRIMARY_EDITOR_SELECTOR`,
selection-surface checks, clipboard ownership, F6 focus restoration, and the
benchmark probe. Do not broaden selectors to arbitrary contenteditables.

- [ ] **Step 6: Replace title overlay CSS**

Remove `.notes-node-title-field > textarea` and transparent stable-presentation
rules for ordinary titles. Apply existing typography, markdown level, wrapping,
completion, focus, and readonly visuals to the stable title root:

```css
.notes-node-title[data-notes-bullet-title] {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  outline: 0;
}
```

Resting nested token controls keep pointer and keyboard behavior. Editing mode
must not move a wrapped line relative to resting mode.

- [ ] **Step 7: Run the owning suites**

```bash
npm test -- src/features/notes/NotesBulletTitleEditor.test.tsx src/features/notes/plainTextContenteditable.test.ts
npm test -- src/features/notes/notesDraftEngine.test.ts src/features/notes/outlineDomFocus.test.ts src/features/notes/NotesDatePickerIntegration.test.tsx
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesQuickJump.integration.test.tsx src/features/notes/NotesFeature.test.tsx src/features/notes/NotesExportMenu.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/features/notes
git commit -m "perf(notes): keep live bullet typing in the DOM"
```

Before committing, inspect `git diff --cached --name-only` and unstage any
unrelated file; this task is limited to the paths listed above.

---

### Task 5: Let native repeat drive local-first structure

**Files:**

- Create: `src/features/notes/notesLocalStructure.ts`
- Create: `src/features/notes/notesLocalStructure.test.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx:13,109-205,667-702,1062-1108,1261-1661`
- Modify: `src/features/notes/NotesOutlinePane.tsx:775-802,2010-2046,3012-3043,3482-3535,4629-4634`
- Modify: `src/features/notes/outlineKeyboard.ts:321-323,444-453,661-690`
- Modify: `src/features/notes/outlineKeyboard.test.ts:1384-1475`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:32-44,452-512,662-1207,2988-3131,3515-3801`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/notesCommands.ts:1570-1731,1857-2017`
- Modify: `src/features/notes/useNotesEditingLease.ts:55-75`
- Modify: `src/features/notes/useNotesEditingLease.test.tsx:45-85`
- Modify: `src/features/notes/NotesWorkspace.test.tsx:6657-7250,11922-12592`
- Modify: `src/features/notes/notesWorkspaceContextSplit.test.tsx`

**Interfaces:**

- Consumes: the live title snapshot, existing pure outline rows, coordinator
  history reservation, command queue, draft barrier, repository commands, and
  authority recovery.
- Produces: one minimal `LocalStructureEntry` per delivered Enter and native
  Backspace repeats with one gesture history transaction.

- [ ] **Step 1: Add failing local-structure tests**

Create a three-row fixture and assert that a split:

```ts
const projected = projectLocalStructures(rows, nodesById, [
  localSplit({
    sourceId: "a",
    insertedId: "new",
    sourceTitle: "pre",
    insertedTitle: "post",
  }),
]);

expect(projected.rows.map(({ id }) => id)).toEqual(["a", "new", "b", "c"]);
expect(projected.nodeOverrides.get("a")?.title).toBe("pre");
expect(projected.nodeOverrides.get("new")?.title).toBe("post");
```

Add a chained held-Enter case whose second entry depends on the first inserted
ID. Add exact settlement removal, mismatched settlement retention until
reconciliation, known failure rollback, and dependent/unknown failure recovery
classification.

- [ ] **Step 2: Add failing user-contract tests**

Replace timer-driven Backspace tests with one initial keydown and four native
`repeat: true` keydowns. Assert five immediate removals, focus moving before
each removal, one queued batch on keyup, and one Undo restoring the exact
fixture.

Dispatch five Enter keydowns, four with `repeat: true`, before repository
promises resolve. Assert five inserted rows, exact prefix/suffix order, no
duplicate IDs, and the final editor focused.

Dispatch 50 repeated ArrowDown events across a prefix boundary in each pane and
assert the exact final focus ID with no later refocus.

Reverse the editing-lease test so even the same node moving from primary to
secondary flushes the primary live editor before the secondary claim.

- [ ] **Step 3: Run the focused tests and confirm failure**

```bash
npm test -- src/features/notes/notesLocalStructure.test.ts
npm test -- src/features/notes/outlineKeyboard.test.ts
npm test -- src/features/notes/useNotesEditingLease.test.tsx
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "held Enter"
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "held Backspace"
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "repeated caret"
```

Expected: FAIL because Enter still uses the old prepared insertion and
Backspace still has a local repeat timer.

- [ ] **Step 4: Replace prepared insertion with one local entry**

Delete `flushSync` and call the new preparation action directly from the
discrete keydown. The preparation:

1. verifies current owner and writable state;
2. closes the source text burst after the editor has published;
3. reserves the structural history entry;
4. registers one `LocalStructureEntry`;
5. publishes the local projection synchronously through the existing drafts
   external store.

Do not capture a source node/row checkpoint, visible-row JSON signature, pane
layout generation, geometry generation, drag generation, or focus
acknowledgement registry. The reserved history location is the rollback
source.

Keep `dependencyId` so a later held-Enter row prevents destructive rollback of
an earlier failed command.

- [ ] **Step 5: Keep repository ordering unchanged**

`splitNodeCommand` and `createChildCommand` continue to run behind
`enqueueStructural`. Their source draft barrier must finish before the
repository split/create call. Pass the reserved `historyContext` and local
entry token rather than the old preparation object.

Settlement rules:

```ts
if (postconditionMatches(authoritative, entry)) {
  removeLocalEntry(entry.token);
} else if (outcome === "authoritative") {
  reconcileFromAuthoritativeWorkspace();
} else if (canRollbackWithoutErasingDependents(entry)) {
  replayReservedHistoryBefore();
} else {
  requestAuthorityRecovery();
}
```

An equivalent authoritative delta removes only the local entry and does not
publish a second intermediate outline. A normalized or different delta follows
the existing reducer settlement.

- [ ] **Step 6: Remove the Backspace timer**

Delete the hook call and `onBackspaceGestureKeyDown` prop. On every delivered
plain Backspace keydown:

- begin or reuse the current gesture token;
- let the connected contenteditable perform a native text deletion when the
  resolution is non-structural;
- for an eligible empty row, focus the logical target first and call
  `removeEmptyNodeInBackspaceGesture`;
- keep the gesture open until existing keyup, blur, hidden, or drain
  termination.

Before `finishBackspaceGesture`, flush the active title adapter so native text
deletions join the same gesture history entry.

Keep repeat guards for Undo/Redo, completion, duplicate, explicit move,
confirmed delete, and Tab. Do not reject repeats for plain Enter, eligible
Backspace, or unmodified arrows.

- [ ] **Step 7: Make cross-pane focus synchronous**

`useNotesEditingLease` flushes whenever ownership moves between panes,
including the same node. Directly focus the mounted title and update navigation
state; if it is outside the prefix, set pending focus so Task 2 expands once.
Remove frame-delayed claim reconciliation only after the synchronous
split-pane tests pass.

- [ ] **Step 8: Run the keyboard, history, and recovery suites**

```bash
npm test -- src/features/notes/notesLocalStructure.test.ts src/features/notes/outlineKeyboard.test.ts
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts
npm test -- src/features/notes/notesHistory.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/notesAuthorityRecovery.test.ts
npm test -- src/features/notes/useNotesEditingLease.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/features/notes
git commit -m "perf(notes): drive outline structure from native repeat"
```

Inspect the staged path list before committing and keep unrelated files out.

---

### Task 6: Delete superseded performance systems

**Files:**

- Delete: the files listed under “Delete after replacement tests pass”.
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPaneScope.tsx`
- Modify: `src/features/notes/NotesPaneScope.test.tsx`
- Modify: `src/features/notes/NotesDetailSplitHost.tsx`
- Modify: `src/features/notes/useNotesWorkspacePaneRegistry.ts`
- Modify: `src/features/notes/notesWorkspaceRuntime.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.ts`
- Modify: `src/features/notes/notesWorkspaceTypes.ts`
- Modify: `src/features/notes/notesWorkspaceContextSplit.test.tsx`
- Modify: `src/features/notes/outlineRowMemo.test.tsx`
- Modify: `src/features/notes/notes.css`
- Modify: `scripts/checkNotesWorkspaceBudgets.mjs`

**Interfaces:**

- Consumes: passing Task 2-5 behavior tests.
- Produces: the same behavior without child-list observers, FLIP, idle
  baseline, frame caret reconciliation, inactive-pane deferral, full-list row
  retention, or implementation-detail tests.

- [ ] **Step 1: Add or retain black-box replacement assertions**

Before deleting files, ensure tests cover:

- pointer drag and keyboard drag still return the correct drop result;
- reduced-motion users see no keyboard structural animation;
- exact row focus and UTF-16 range restore are synchronous;
- inactive split pane receives current state and drafts;
- mounted prefix rows render correct selection membership;
- matching persistence settlement does not add an intermediate pane render.

Run those tests once and confirm they pass before deletion.

- [ ] **Step 2: Remove motion and per-child observation**

Remove `useOutlineLayoutMotion`, idle-baseline refs/callbacks,
`data-outline-motion-id`, and `.notes-outline-item--motion-lift`. Pointer drag
continues to use dnd-kit transforms.

Delete the `ResizeObserver` loop that observes every `motionListRef` child.
Keep the single scroll-host/container observation from Task 2 and image-width
observation. Publish drag state from existing drag start/end events rather than
row resize generations.

- [ ] **Step 3: Remove inactive-pane deferral**

`NotesPaneSliceScope` provides current slices directly:

```tsx
<NotesStateContext.Provider value={pane.stateSlice}>
  <NotesDraftsContext.Provider value={pane.draftsSlice}>
    {children}
  </NotesDraftsContext.Provider>
</NotesStateContext.Provider>
```

Remove `useDeferredValue`, `activePaneId`, and `deferWhenInactive` props and
their call-site plumbing from `NotesDetailSplitHost`. Replace deferral tests
with synchronous two-pane publication tests.

- [ ] **Step 4: Remove row-retention and caret-frame bridges**

Use `flattenVisibleOutlineRows` and `deriveOutlineBodyRows` directly. With a
bounded prefix and DOM-owned input, delete `retainOutlineRowProjection` and
memo tests that assert full-list identity or zero commits from the old path.

Remove `notifyCaretMovedByDom`, direct-claim tokens, frame reconcilers, and
their reducer/runtime/pane-registry plumbing. Keep editing lease, pending focus,
`acknowledgeFocus`, exact DOM focus, and history focus snapshots.

Inline `OutlineNodeEditorComponent` if the memo wrapper and action proxy have
no remaining behavior test that needs them. Keep the wrapper if removing it
increases mounted-prefix renders in the Task 1 probe; do not invent a new memo
layer.

- [ ] **Step 5: Delete old insertion and timer modules**

Move the authority-recovery postcondition type to
`notesLocalStructure.ts`, then delete `notesKeyboardInsertion.ts`.
`notesBackspaceGesture.ts`, `notesBackspaceRuntime.ts`, coordinator gesture
transaction, history, recovery, and drain stay.

Delete the custom held-Backspace controller and hook. Remove stale entries from
`scripts/checkNotesWorkspaceBudgets.mjs`; the architecture check must describe
the remaining boundaries rather than require deleted filenames.

- [ ] **Step 6: Prove there are no dead imports or old selectors**

Run:

```bash
rg -n "flushSync|useNotesHeldBackspaceRepeat|createNotesHeldBackspaceRepeatController|useOutlineLayoutMotion|retainOutlineRowProjection|useDeferredValue|notifyCaretMovedByDom|textarea\\.notes-node-title" src scripts
```

Expected: no ordinary-title or deleted-performance-path matches. A specialized
plugin/read-only textarea selector may remain only where its owning test proves
that path.

- [ ] **Step 7: Run focused cleanup gates**

```bash
npm test -- src/features/notes/NotesPaneScope.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/outlineDomFocus.test.ts
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/outlineDrag.test.ts src/features/notes/notesCrossPaneDrag.test.ts src/features/notes/outlineSelectionDragSession.test.ts
npm run test:architecture
git diff --check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/features/notes scripts/checkNotesWorkspaceBudgets.mjs
git commit -m "refactor(notes): delete superseded outline tuning"
```

Inspect the staged deletions before committing.

---

### Task 7: Verify the complete contract

**Files:**

- No planned tracked changes.

**Interfaces:**

- Consumes: the frozen diff and isolated 5,001-node benchmark.
- Produces: final automated and fresh desktop evidence.

- [ ] **Step 1: Run focused semantic suites**

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesBulletTitleEditor.test.tsx src/features/notes/NotesWorkspace.test.tsx
npm test -- src/features/notes/notesHistory.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/notesVaultDrain.test.ts src/features/notes/useFlushDraftsOnWindowClose.test.tsx src/App.test.tsx
npm test -- src/features/notes/notesPaneSession.test.ts src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/outlineDrag.test.ts src/features/notes/notesCrossPaneDrag.test.ts src/features/notes/NotesAttachmentIngest.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run the final frontend gates once**

```bash
npm test
npm run test:architecture
npm run lint
npm run build
git diff --check
```

Expected: all commands pass. Cargo tests, Rust formatting, and Clippy are not
final gates because production Rust, IPC payloads, schemas, persistence
formats, and native configuration did not change.

- [ ] **Step 3: Start a fresh benchmark process**

Quit any prior benchmark process, reseed only the isolated benchmark Vault with
the Task 1 commands, and run:

```bash
npm run tauri:dev -- --config src-tauri/tauri.split-input-benchmark.conf.json
```

Confirm the process loaded the freshly built bundle before measuring.

- [ ] **Step 4: Exercise the device acceptance rows**

In both panes:

1. verify initial mounted ordinary rows equal the viewport formula;
2. hold Enter near the lower viewport edge;
3. hold Backspace across text and empty rows, then release and Undo once;
4. hold ArrowDown across more than one prefix expansion;
5. compose Korean text, blur during composition, and finish composition;
6. scroll rapidly down and back up;
7. drag while autoscroll expands the prefix;
8. trigger a known write failure and retry;
9. switch Vaults with a dirty live title;
10. close normally with a dirty live title.

Required JSON and visual results:

```text
delivered keydowns == represented edits
frame p95 <= 28 ms
frames over 34 ms == 0
no focus loss
no scroll reversal, blank strip, or anchor jump
no duplicate or missing row
no text or IME loss
one held-Backspace Undo restores the exact fixture
drain leaves no live dirty title or queued write
```

- [ ] **Step 5: Review the final diff**

```bash
git status --short --branch
git diff gi/main...HEAD --stat
git log --oneline gi/main..HEAD
```

Confirm the branch contains the design, this plan, six implementation commits,
no benchmark data, and no unrelated user change. If verification found no
defect, do not create an empty commit.
