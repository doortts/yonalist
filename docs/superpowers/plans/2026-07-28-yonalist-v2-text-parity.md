# Yonalist v2 Text Keyboard Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the current application's Workflowy-style Enter, indentation,
arrow navigation, empty-row Backspace, and single-row shortcut contracts on the
v2 modular architecture.

**Architecture:** A pure React-side resolver converts keyboard facts into
semantic intents. Atomic structural gestures are new `notes-core` commands
executed through the existing application service and SQLite Unit of Work.
Focus/caret placement remains pane-local and never enters IPC.

**Tech Stack:** React 19, TypeScript 6, Vitest, Rust, `ts-rs`, rusqlite/SQLite,
Tauri 2.

## Global Constraints

- Preserve the exact current DOM structure, CSS classes, geometry, colors, and
  typography.
- Do not import any legacy production module into `apps/desktop`.
- Vault synchronization and GitHub Notifications remain excluded.
- Change the development schema and contracts in place; add no migrations.
- Every production behavior is preceded by a focused failing test.
- Plain key behavior is ignored during IME composition or `Process` events.
- Every structural gesture commits atomically and occupies one Undo entry.
- Repeated Enter is accepted; repeated Tab, boundary Left/Right, and destructive
  shortcuts are consumed without repeating a structural mutation.
- Do not stage or commit unless the user explicitly requests it.

---

## File map

### New files

- `apps/desktop/src/outlineKeyboard.ts`: pure keyboard facts-to-intent resolver.
- `apps/desktop/src/outlineKeyboard.test.ts`: resolver characterization tests.
- `apps/desktop/src/outlineFocus.ts`: pane-scoped editor lookup and caret placement.
- `apps/desktop/src/outlineFocus.test.ts`: focus and caret boundary tests.

### Modified files

- `crates/notes-core/src/command.rs`: atomic split and empty-row removal commands.
- `crates/notes-core/src/tree.rs`: reversible planning for both commands.
- `crates/notes-core/tests/tree_commands.rs`: domain invariants and inverse patches.
- `crates/notes-application/src/contracts.rs`: generated IPC variants.
- `crates/notes-application/tests/session_service.rs`: one-entry Undo/Redo proof.
- `crates/notes-sqlite/src/queries.rs`: bounded command-tree loading for new commands.
- `crates/notes-sqlite/tests/vertical_slice.rs`: SQLite atomicity/restart proof.
- `apps/desktop/src/notesStore.ts`: semantic store methods for atomic gestures.
- `apps/desktop/src/notesStore.test.ts`: receipt ordering and failure behavior.
- `apps/desktop/src/outlineSupport.tsx`: execute resolved intents.
- `apps/desktop/src/OutlineRow.tsx`: supply caret, pane root, and focus scope.
- `apps/desktop/src/OutlineHeader.tsx`: page-title boundary navigation and Enter.
- `apps/desktop/src/App.tsx`: pane-scoped identifiers and selection callbacks.
- `apps/desktop/src/App.test.tsx`: integrated keyboard behavior.
- `docs/v2/feature-parity-matrix.md`: status updates after final proof.

## Task 1: Pure keyboard intent resolver

**Interfaces:**

- Consumes:

```ts
export interface OutlineKeyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  nodeId: string;
  pageId: string;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  visibleNodes: readonly NoteView[];
  target: "page" | "row";
  platform: "mac" | "other";
}
```

- Produces:

```ts
export type OutlineKeyIntent =
  | { kind: "split"; prefix: string; suffix: string; parentId: string; beforeId: string | null }
  | { kind: "createFirstChild"; parentId: string }
  | { kind: "indent"; previousSiblingId: string }
  | { kind: "outdent"; parentId: string; beforeId: string | null }
  | { kind: "focus"; nodeId: string; edge: "start" | "end" | "preserve" }
  | { kind: "removeEmpty"; focusId: string | null }
  | { kind: "toggleComplete" }
  | { kind: "duplicate" }
  | { kind: "trash" }
  | { kind: "move"; direction: "up" | "down" }
  | { kind: "consume" };
```

- [ ] **Step 1: Write failing resolver tests**

Create table-driven cases in `outlineKeyboard.test.ts` for:

```ts
expect(resolveOutlineKey(input({
  key: "Enter",
  value: "alphaXYZomega",
  selectionStart: 5,
  selectionEnd: 8
}))).toEqual({
  kind: "split",
  prefix: "alpha",
  suffix: "omega",
  parentId: "page-1",
  beforeId: "next"
});
```

Add distinct cases for terminal Enter with/without children, repeated Enter,
Tab/Shift+Tab boundaries, Up/Down visible order, Left/Right text boundaries,
page-header Down, first-row Up, whitespace-empty Backspace, modifiers, repeat,
and IME.

- [ ] **Step 2: Run the resolver test and verify RED**

Run:

```powershell
npm --workspace @yonalist/desktop test -- outlineKeyboard.test.ts
```

Expected: FAIL because `outlineKeyboard.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure resolver**

The resolver must not access DOM, store state, timers, or IPC. It derives
preorder navigation from the already visible `NoteView[]` and returns `null`
for native text editing that remains inside the current value.

- [ ] **Step 4: Run the resolver test and verify GREEN**

Run the command from Step 2. Expected: all resolver cases pass.

- [ ] **Step 5: Review the task boundary**

Run `git diff --check` and inspect only the two resolver files. Do not stage or
commit without an explicit user request.

## Task 2: Atomic domain gestures

**Interfaces:**

- Add to `NotesCommand`:

```rust
SplitNode {
    id: NodeId,
    new_id: NodeId,
    parent_id: NodeId,
    position: Position,
    prefix: String,
    suffix: String,
}
RemoveEmptyNode {
    id: NodeId,
}
```

- `SplitNode` updates the source text and inserts the new node in one
  `DomainPatch`.
- `RemoveEmptyNode` rejects non-bullets and non-whitespace text, reparents direct
  children into the removed row's sibling slot in order, physically removes the
  empty row, and produces a complete inverse patch.

- [ ] **Step 1: Write failing domain tests**

Add cases to `tree_commands.rs` proving:

```rust
let patch = tree.plan(NotesCommand::SplitNode {
    id: id("current"),
    new_id: id("new"),
    parent_id: id("page"),
    position: Position::before(id("next")),
    prefix: "alpha".into(),
    suffix: "omega".into(),
})?;
```

Assertions cover source/new text, sibling position, duplicate-ID rejection,
rollback by applying `patch.inverse`, child lifting order, first/last sibling
removal, whitespace acceptance, nonempty rejection, and page rejection.

- [ ] **Step 2: Run the domain tests and verify RED**

Run:

```powershell
cargo test -p notes-core --test tree_commands split_node
cargo test -p notes-core --test tree_commands remove_empty_node
```

Expected: compile failure because the variants do not exist.

- [ ] **Step 3: Implement `SplitNode`**

Implement one candidate-tree operation that validates the source and parent,
updates source text, creates the new bullet, and calls `place_child`.

- [ ] **Step 4: Run the split tests and verify GREEN**

Run the first command from Step 2. Expected: all split cases pass.

- [ ] **Step 5: Implement `RemoveEmptyNode`**

Capture the removed node's parent and ordered direct children, move the children
to the parent at the removed node's position, delete the row from the candidate,
and normalize only affected sibling keys.

- [ ] **Step 6: Run all notes-core tests**

Run:

```powershell
cargo test -p notes-core
```

Expected: all domain unit and integration tests pass.

- [ ] **Step 7: Review the task boundary**

Run `cargo fmt --all -- --check` and `git diff --check`. Do not stage or commit
without an explicit user request.

## Task 3: IPC, session history, and SQLite vertical slice

**Interfaces:**

- Add matching camelCase `IpcNotesCommand::SplitNode` and
  `IpcNotesCommand::RemoveEmptyNode` variants.
- Regenerate `packages/contracts/generated/IpcNotesCommand.ts` through the
  existing contract script.
- `StoragePort::load_command_tree` loads the affected page subtree and direct
  ordering context without loading another page.

- [ ] **Step 1: Write failing IPC/history tests**

Add a `session_service.rs` test that executes one `SplitNode`, calls Undo once,
and observes both the old source text and absence of the new node. Redo restores
both. Add the same one-entry test for `RemoveEmptyNode`.

- [ ] **Step 2: Run the application tests and verify RED**

Run:

```powershell
cargo test -p notes-application --test session_service atomic_editor_gesture
```

Expected: compile failure because IPC variants are missing.

- [ ] **Step 3: Add IPC conversion and generated contract**

Map the two IPC variants directly to their domain variants. Run:

```powershell
cargo test -p notes-application export_bindings --quiet
node scripts/checkV2Contracts.mjs
```

The first command writes bindings to `packages/contracts/generated` through
`.cargo/config.toml`. The second command regenerates into an isolated temporary
directory and compares the complete file set and content. Expected: 17
generated contracts with exact content parity.

- [ ] **Step 4: Write failing SQLite vertical tests**

Add tests that execute split/removal, reopen the database, verify persisted
order/content, and inject an invalid patch to prove the revision and all rows
roll back together.

- [ ] **Step 5: Run SQLite tests and verify RED**

Run:

```powershell
cargo test -p notes-sqlite --test vertical_slice atomic_editor
```

Expected: FAIL until command-tree loading handles both commands.

- [ ] **Step 6: Implement bounded loaders and commit path**

Extend the command dispatch in `queries.rs` so both commands receive the page
tree and ordering context needed by the domain planner. Reuse the unchanged
`mutations::commit` Unit of Work.

- [ ] **Step 7: Verify the Rust vertical slice**

Run:

```powershell
cargo test --workspace
cargo fmt --all -- --check
node scripts/checkV2Contracts.mjs
```

Expected: all commands exit 0.

- [ ] **Step 8: Review the task boundary**

Inspect the generated TypeScript diff and Rust wire-shape tests. Do not stage or
commit without an explicit user request.

## Task 4: Store semantics and pane-scoped focus

**Interfaces:**

- Add:

```ts
NotesStore.splitNode(input: {
  id: string;
  newId: string;
  parentId: string;
  beforeId: string | null;
  prefix: string;
  suffix: string;
}): Promise<string>

NotesStore.removeEmptyNode(id: string): Promise<void>
```

- Add:

```ts
focusOutlineEditor(scope: HTMLElement, nodeId: string, edge: "start" | "end" | "preserve"): boolean
```

- [ ] **Step 1: Write failing store tests**

Prove that `splitNode` cancels the source debounce, sends one command with one
revision, applies both changed nodes, preserves a newer draft typed after
dispatch, and reports failure without deleting the draft. Prove removal applies
lifted children and the deleted ID from one receipt.

- [ ] **Step 2: Run store tests and verify RED**

Run:

```powershell
npm --workspace @yonalist/desktop test -- notesStore.test.ts
```

Expected: FAIL because the methods are absent.

- [ ] **Step 3: Implement the store methods**

Use the existing serialized command queue. `splitNode` sends the semantic IPC
command directly rather than calling `updateText` followed by `createNode`.
`removeEmptyNode` never calls `deleteSubtree`.

- [ ] **Step 4: Run store tests and verify GREEN**

Run the command from Step 2. Expected: all store tests pass.

- [ ] **Step 5: Write failing pane-focus tests**

Render two scopes containing duplicate `data-node-id` values. Assert that
`focusOutlineEditor(secondScope, "node", "end")` focuses only the second
textarea and places both UTF-16 selection offsets at its value length.

- [ ] **Step 6: Implement and verify `outlineFocus`**

Use `CSS.escape` when available and a filtered `querySelectorAll` fallback.
Clamp preserved offsets to the destination value. Run:

```powershell
npm --workspace @yonalist/desktop test -- outlineFocus.test.ts
```

Expected: all focus tests pass.

- [ ] **Step 7: Review the task boundary**

Run `npm run lint:v2` and `git diff --check`. Do not stage or commit without an
explicit user request.

## Task 5: React integration

**Interfaces:**

- `OutlineRow` receives a pane scope ref and optional keyboard-selection
  callback.
- `OutlineHeader` receives the same visible-node context and routes page-title
  Enter/Down through the resolver.
- `outlineSupport.handleOutlineKeyDown` becomes an intent executor; key
  semantics stay in `outlineKeyboard.ts`.

- [ ] **Step 1: Write failing App characterization tests**

Add separate tests for:

1. splitting `"alpha|omega"` into `"alpha"` and `"omega"`;
2. terminal Enter on a parent creating the first child;
3. empty terminal Enter creating and focusing the next sibling;
4. Tab and Shift+Tab preserving focus after the patch;
5. Up/Down and boundary Left/Right moving within the current pane;
6. page-title Down focusing the first visible row;
7. empty Backspace lifting children and focusing previous, lifted, then next;
8. IME events remaining native;
9. repeated Enter chaining in order;
10. platform-correct complete, duplicate, trash, and move shortcuts.

- [ ] **Step 2: Run App tests and verify RED**

Run:

```powershell
npm --workspace @yonalist/desktop test -- App.test.tsx
```

Expected: the new cases fail on missing resolver/store integration.

- [ ] **Step 3: Wire resolver intents into row editing**

Read `selectionStart`, `selectionEnd`, `nativeEvent.isComposing`, modifiers,
repeat, current draft value, and visible nodes synchronously. Prevent default
only for a non-null intent. Apply focus in `requestAnimationFrame` after the
store promise resolves or the optimistic row exists.

- [ ] **Step 4: Wire page-header boundary behavior**

Page title Enter creates the first page child using the atomic split gesture
with unchanged title and empty suffix. ArrowDown focuses the first visible row;
ArrowUp from that first row returns to the page title.

- [ ] **Step 5: Verify integrated React behavior**

Run:

```powershell
npm --workspace @yonalist/desktop test -- App.test.tsx outlineKeyboard.test.ts outlineFocus.test.ts notesStore.test.ts
```

Expected: all focused frontend tests pass.

- [ ] **Step 6: Review the task boundary**

Inspect focus behavior in both split panes and verify no CSS or layout file
changed. Run `git diff --check`.

## Task 6: Fresh desktop proof and final gates

**Interfaces:**

- Uses the existing isolated `YONALIST_V2_DATA_DIR` packaged-process path.
- Updates only parity status and verification evidence after the runtime proof.

- [ ] **Step 1: Build a fresh desktop bundle**

Run:

```powershell
npm run v2:tauri:build
```

Expected: release executable and Windows bundles are rebuilt from the current
source state.

- [ ] **Step 2: Exercise the real user path**

With an isolated data directory:

1. create a page and first bullet;
2. type `alphaomega`, place the caret between the words, press Enter;
3. press Enter again, Tab, Shift+Tab, Up, Down, boundary Left, boundary Right;
4. create a parent with a child and press Enter at the parent's end;
5. remove an empty parent and verify its child is lifted;
6. Undo and Redo each structural gesture;
7. close, restart, and verify content/order while session history is reset.

- [ ] **Step 3: Run final changed-boundary gates**

Run once after the diff is frozen:

```powershell
npm run test:v2
npm run test:v2:bundle
npm audit
cargo fmt --all -- --check
cargo check --workspace --all-targets
git diff --check
```

Expected: every command exits 0; the editable bundle remains within
300KB raw / 90KB gzip.

- [ ] **Step 4: Update the parity matrix**

Set Enter, indentation, arrow navigation, empty Backspace, and single-row
shortcut rows to `complete` only when both automated and desktop evidence
exists. Record any platform-only verification gap as `partial`.

- [ ] **Step 5: Final review**

Review all changes against
`docs/superpowers/specs/2026-07-28-yonalist-v2-feature-parity-design.md`.
Report exact test counts, bundle measurements, desktop steps, and remaining
matrix rows. Do not stage or commit without an explicit user request.
