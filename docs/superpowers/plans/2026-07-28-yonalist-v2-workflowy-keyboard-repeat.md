# Yonalist v2 Workflowy Keyboard Repeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plain Enter, Backspace, and cursor-key behavior match the
observed Workflowy editor while preserving the current UI exactly.

**Architecture:** A pane-local input gesture uses native key repeat as its
clock and publishes structural changes optimistically. A generated
`MergeNodeBackward` command preserves the current node while atomically
removing its eligible previous sibling. One reusable outline index and
resting-row containment keep keyboard work linear or constant-time.

**Tech Stack:** React 19, TypeScript 6, Vitest/jsdom, Rust 2024,
notes-core/notes-application/notes-sqlite, ts-rs, SQLite, Tauri 2.

## Global Constraints

- Keep DOM classes, CSS tokens, layout, colors, typography, and interactions
  outside this contract unchanged.
- Vault synchronization and GitHub Notifications remain excluded.
- Keep the v2 schema-v1 development database; add no migrations or compatibility
  readers.
- Add a focused failing test before each production behavior.
- Do not edit generated TypeScript contracts manually.
- Do not stage or commit without an explicit user request.

---

### Task 1: Freeze the Workflowy keyboard resolver contract

**Files:**
- Create: `apps/desktop/src/textareaCaretLines.ts`
- Create: `apps/desktop/src/textareaCaretLines.test.ts`
- Modify: `apps/desktop/src/outlineKeyboard.ts`
- Modify: `apps/desktop/src/outlineKeyboard.test.ts`
- Modify: `apps/desktop/src/outlineSupport.tsx`
- Modify: `apps/desktop/src/outlineFocus.ts`

**Interfaces:**
- Produces:

```ts
export interface TextareaCaretLines {
  readonly first: boolean;
  readonly last: boolean;
}

export function measureTextareaCaretLines(
  textarea: HTMLTextAreaElement
): TextareaCaretLines;
```

- Adds `firstVisualLine` and `lastVisualLine` to `OutlineKeyInput`.
- Adds `{ kind: "mergeBackward"; previousId: string; joinOffset: number }`
  to `OutlineKeyIntent`.

- [ ] **Step 1: Write failing resolver tests**

Add cases proving:

```ts
expect(resolveOutlineKey(input({
  key: "ArrowRight",
  repeat: true,
  selectionStart: 10,
  selectionEnd: 10,
  value: "0123456789"
}))).toEqual({ kind: "focus", nodeId: "next", edge: "start" });

expect(resolveOutlineKey(input({
  key: "ArrowDown",
  firstVisualLine: false,
  lastVisualLine: false
}))).toBeNull();

expect(resolveOutlineKey(input({
  nodeId: "second",
  key: "Backspace",
  value: "beta",
  selectionStart: 0,
  selectionEnd: 0
}))).toEqual({
  kind: "mergeBackward",
  previousId: "first",
  joinOffset: 5
});
```

Also cover first sibling, previous note, previous children, different parent,
selection ranges, modifiers, and IME as merge no-ops.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm run test --prefix apps/desktop -- outlineKeyboard.test.ts
```

Expected: failures for missing visual-line fields, repeated boundary movement,
and `mergeBackward`.

- [ ] **Step 3: Add visual-line mirror tests**

Prove a one-line textarea is both first/last, the first of three wrapped lines
is first only, the middle is neither, and the final line is last only. Keep the
mirror outside layout and reuse one mirror per document.

- [ ] **Step 4: Implement minimal resolver and direct-focus behavior**

Remove the repeated Left/Right consume path. Up/Down return no intent while
the caret has a native visual line and return cross-row focus at the applicable
boundary. Change cross-row Up/Down focus to `"start"`.

Make `focusOutlineEditor` synchronous for already mounted targets and add:

```ts
export function focusOutlineEditorAt(
  scope: HTMLElement,
  nodeId: string,
  offset: number
): boolean;
```

Do not await draft flush before moving focus.

- [ ] **Step 5: Run owning tests and verify GREEN**

```powershell
npm run test --prefix apps/desktop -- outlineKeyboard.test.ts textareaCaretLines.test.ts
```

### Task 2: Add atomic backward merge across Rust, IPC, and preview

**Files:**
- Modify: `crates/notes-core/src/command.rs`
- Modify: `crates/notes-core/src/tree/command_execution.rs`
- Modify: `crates/notes-core/tests/tree_commands.rs`
- Modify: `crates/notes-application/src/contracts.rs`
- Modify: `crates/notes-application/src/command_conversion.rs`
- Modify: `crates/notes-application/tests/session_service.rs`
- Modify: `crates/notes-sqlite/src/repository.rs`
- Modify: `crates/notes-sqlite/tests/vertical_slice.rs`
- Modify: `apps/desktop/src/previewApi.ts`
- Modify: `apps/desktop/src/previewApi.test.ts`
- Regenerate: `packages/contracts/generated/IpcNotesCommand.ts`

**Interfaces:**
- Produces:

```rust
NotesCommand::MergeNodeBackward {
    id: NodeId,
    previous_id: NodeId,
    previous_text: String,
    current_text: String,
}
```

- [ ] **Step 1: Write failing notes-core merge tests**

Build adjacent `alpha`/`beta` siblings and assert:

```rust
tree.plan(NotesCommand::MergeNodeBackward {
    id: id("beta"),
    previous_id: id("alpha"),
    previous_text: "alpha".into(),
    current_text: "beta".into(),
})
```

deletes `alpha`, keeps ID `beta`, sets text `alphabeta`, moves `beta` to
`alpha`'s sort position, keeps `beta`'s note/children/marker state, and restores
the exact tree through the inverse patch.

Add rejection tests for page nodes, nonadjacent/different-parent nodes,
previous children, and previous note.

- [ ] **Step 2: Run notes-core tests and verify RED**

```powershell
cargo test -p notes-core --test tree_commands merge_node_backward -- --nocapture
```

Expected: compile failure because the command variant does not exist.

- [ ] **Step 3: Implement the minimal domain operation**

Validate structural eligibility before mutation. Set the current text and sort
key, then remove only the previous node. Do not copy previous metadata and do
not touch current descendants.

- [ ] **Step 4: Run notes-core tests and verify GREEN**

```powershell
cargo test -p notes-core --test tree_commands merge_node_backward -- --nocapture
```

- [ ] **Step 5: Add failing application and SQLite boundary tests**

Assert the generated IPC command converts exactly, the receipt contains changed
current/deleted previous IDs, Undo restores both nodes, Redo remerges them, and
restart reads the merged current node.

- [ ] **Step 6: Wire application, repository, preview, and generation**

Map the generated camelCase TypeScript shape:

```ts
{
  kind: "mergeNodeBackward",
  id,
  previous_id: previousId,
  previous_text: previousText,
  current_text: currentText
}
```

Run the existing contract generator/check command rather than editing generated
files.

- [ ] **Step 7: Run boundary tests**

```powershell
cargo test -p notes-application merge_node_backward -- --nocapture
cargo test -p notes-sqlite merge_node_backward -- --nocapture
npm run test --prefix apps/desktop -- previewApi.test.ts
npm run test:v2:contracts
```

### Task 3: Publish repeatable structural edits optimistically

**Files:**
- Create: `apps/desktop/src/storeOptimisticStructure.ts`
- Create: `apps/desktop/src/storeOptimisticStructure.test.ts`
- Modify: `apps/desktop/src/notesStore.ts`
- Modify: `apps/desktop/src/notesStore.test.ts`
- Modify: `apps/desktop/src/outlineSupport.tsx`
- Modify: `apps/desktop/src/OutlineRow.tsx`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/outlineClipboardIntegration.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface OptimisticStructuralEdit {
  readonly focusId: string;
  readonly focusOffset: number;
  readonly settled: Promise<void>;
}

NotesStore.beginSplitNode(input): OptimisticStructuralEdit | null;
NotesStore.beginCreateNode(parentId, beforeId): OptimisticStructuralEdit | null;
NotesStore.beginMergeBackward(input): OptimisticStructuralEdit | null;
NotesStore.beginRemoveEmpty(id): OptimisticStructuralEdit | null;
```

- [ ] **Step 1: Write failing pure projection tests**

Prove provisional split creates one correctly ordered empty node, merge keeps
the current ID and join offset, empty removal preserves the deterministic focus
fallback, authoritative receipt replaces provisional sort keys, and failure
restores the captured state.

- [ ] **Step 2: Verify projection RED**

```powershell
npm run test --prefix apps/desktop -- storeOptimisticStructure.test.ts
```

- [ ] **Step 3: Implement minimal projections**

Use immutable node/draft patches. Maintain one in-flight source-ID set so a
repeat event hitting an old textarea cannot issue the same structural command
twice. Clear the source ID after settlement or rollback.

- [ ] **Step 4: Add failing integration tests**

Prove five repeated plain Enter events create five provisional bullets in
order, focus advances on every event, and the commands later settle in the
same order. Prove Backspace merges `alpha`+`beta`, places the caret at offset
five, then native repeated deletion continues from that offset.

- [ ] **Step 5: Replace delayed row intent paths**

Call begin-style store methods, then request focus immediately. Attach keyup
and cancellation hooks required by Task 4. Keep Shift+Enter, completion,
duplicate, move, delete, zoom, Undo, and Redo one-shot.

- [ ] **Step 6: Run owning frontend tests**

```powershell
npm run test --prefix apps/desktop -- storeOptimisticStructure.test.ts notesStore.test.ts App.test.tsx outlineClipboardIntegration.test.tsx
```

### Task 4: Group a held Backspace and remove the empty placeholder

**Files:**
- Create: `apps/desktop/src/outlineBackspaceGesture.ts`
- Create: `apps/desktop/src/outlineBackspaceGesture.test.ts`
- Modify: `apps/desktop/src/notesStore.ts`
- Modify: `apps/desktop/src/OutlineRow.tsx`
- Modify: `apps/desktop/src/NotesOutline.tsx`
- Modify: `apps/desktop/src/outlineKeyboard.test.ts`
- Modify: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface BackspaceGesture {
  readonly group: string;
  readonly touchedIds: ReadonlySet<string>;
  readonly accepting: boolean;
}

NotesStore.beginBackspaceGesture(paneId: string): string;
NotesStore.touchBackspaceGesture(group: string, nodeId: string): void;
NotesStore.endBackspaceGesture(group: string): Promise<void>;
```

- [ ] **Step 1: Write failing gesture lifecycle tests**

Cover initial keydown, repeated keydown, keyup, window blur, hidden document,
pane disposal, no optimistic changes after closure, shared history group, and
one Undo restoring all touched text/nodes.

- [ ] **Step 2: Verify lifecycle RED**

```powershell
npm run test --prefix apps/desktop -- outlineBackspaceGesture.test.ts
```

- [ ] **Step 3: Implement the gesture**

Use the physical key as the clock; add no timer-driven repeat. Store touched
drafts under the gesture's history group, cancel their ordinary debounce, and
flush them before closing the group. Persistence may finish after keyup, but
visible deletion may not continue after keyup.

- [ ] **Step 4: Remove the bullet placeholder**

Omit `placeholder` for the ordinary title `OutlineTextField`. Keep page-title,
supporting-note, Search, and other placeholders unchanged.

- [ ] **Step 5: Add and pass integration tests**

Assert an empty bullet's presentation text is empty, the textarea has no
placeholder, a held gesture crosses at least three empty bullets, and one Undo
restores the starting structure/focus.

```powershell
npm run test --prefix apps/desktop -- outlineBackspaceGesture.test.ts App.test.tsx outlineClipboardIntegration.test.tsx
```

### Task 5: Make outline lookup work linear and contain resting rows

**Files:**
- Modify: `apps/desktop/src/outlineModel.ts`
- Modify: `apps/desktop/src/outlineModel.test.ts`
- Modify: `apps/desktop/src/NotesOutline.tsx`
- Modify: `apps/desktop/src/OutlineRow.tsx`
- Modify: `apps/desktop/src/outlineSupport.tsx`
- Modify: `apps/desktop/src/notes.css`
- Modify: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface OutlineIndex {
  readonly byId: ReadonlyMap<string, NoteView>;
  readonly depthById: ReadonlyMap<string, number>;
  readonly childrenByParent: ReadonlyMap<string, readonly NoteView[]>;
  readonly visibleIndexById: ReadonlyMap<string, number>;
}

export function buildOutlineIndex(
  nodes: readonly NoteView[],
  visibleNodes: readonly NoteView[],
  rootId: string
): OutlineIndex;
```

- [ ] **Step 1: Write failing index tests**

Cover 5,000 flat rows, a 100-level tree, missing parents, cycle defense,
collapsed subtrees, and exact previous/next sibling relations.

- [ ] **Step 2: Verify index RED**

```powershell
npm run test --prefix apps/desktop -- outlineModel.test.ts
```

- [ ] **Step 3: Build and reuse one index per stable node array**

Memoize the index in `NotesOutline`, pass exact depth/child/navigation facts to
rows, and remove per-row `new Map`, `filter`, and `some` scans from the keyboard
hot path.

- [ ] **Step 4: Add resting-row containment**

Apply `content-visibility: auto` and a measured intrinsic block size to resting
`.notes-outline-item` rows. Force focused, selected, dragged, and popup-owning
rows visible. Do not change any visual metric.

- [ ] **Step 5: Run behavior and architecture tests**

```powershell
npm run test --prefix apps/desktop -- outlineModel.test.ts App.test.tsx
npm run test:v2:architecture
```

### Task 6: Fresh runtime proof and final gates

**Files:**
- Modify: `docs/v2/feature-parity-matrix.md`

- [ ] **Step 1: Run focused cross-boundary gates**

```powershell
cargo test -p notes-core --test tree_commands merge_node_backward -- --nocapture
cargo test -p notes-application merge_node_backward -- --nocapture
cargo test -p notes-sqlite merge_node_backward -- --nocapture
npm run test --prefix apps/desktop -- outlineKeyboard.test.ts textareaCaretLines.test.ts outlineBackspaceGesture.test.ts storeOptimisticStructure.test.ts App.test.tsx
```

- [ ] **Step 2: Start a fresh preview/Tauri process**

Rebuild before testing. Verify five held-Enter insertions, held Backspace over
text and three empty bullets, left/right boundary repeat, wrapped Up/Down,
placeholder absence, Undo/Redo, and Korean IME.

- [ ] **Step 3: Freeze the diff and run final gates once**

```powershell
npm run test:v2
npm run test:v2:bundle
cargo fmt --all -- --check
cargo check --workspace --all-targets
git diff --check
```

- [ ] **Step 4: Update parity evidence**

Record the observed Workflowy rules, owning automated tests, fresh runtime
path, bundle result, and any remaining limitations. Do not claim real physical
hold latency from protocol-driven browser automation.
