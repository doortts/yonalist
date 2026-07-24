# Contextual Enter Child Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plain `Enter` at the end of a text bullet with existing children create and focus a new empty first child while preserving all other Enter behavior.

**Architecture:** Add one `createFirstChild` result to the pure keyboard resolver and route it through the existing `createChild(nodeId, "first")` workspace action in `OutlineNodeRow`. Persistence, IPC, history, and synchronization remain unchanged because the existing child-creation command already owns those boundaries.

**Tech Stack:** React 19, TypeScript 6, Vitest, Testing Library

## Global Constraints

- Apply only to a text title with a collapsed caret at the logical title end and at least one existing child.
- Preserve sibling splitting for childless rows and non-terminal selections.
- Preserve image Enter, IME, repeat, modifier, read-only, structural-command, marker, Undo, and Redo behavior.
- Do not modify Rust, IPC payloads, SQLite, history representation, or synchronization.
- Preserve unrelated workspace changes in `outlineLayoutMotion*`.

---

### Task 1: Resolve and execute contextual first-child Enter

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts:140-145,472-480`
- Modify: `src/features/notes/outlineKeyboard.test.ts:530-550`
- Modify: `src/features/notes/OutlineNodeRow.tsx:934-956`
- Test: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: `NormalizedNotesWorkspace.childIdsByParent`, current title selection, and `NotesWorkspaceActions.createChild(nodeId, placement)`.
- Produces: `OutlineKeyResolution` variant `{ type: "createFirstChild" }`.

- [ ] **Step 1: Add failing resolver tests**

Add focused cases to `outlineKeyboard.test.ts`:

```ts
it("creates a first child from terminal Enter when the row already has children", () => {
  expect(
    resolveOutlineKey(
      input({
        nodeId: "root-a",
        title: "Root alpha",
        selectionStart: 10,
        selectionEnd: 10
      })
    )
  ).toEqual({ type: "createFirstChild" });
});

it("keeps terminal Enter as a sibling split when the row has no children", () => {
  expect(
    resolveOutlineKey(
      input({
        nodeId: "root-b",
        title: "root-b",
        selectionStart: 6,
        selectionEnd: 6
      })
    )
  ).toEqual({ type: "split", prefix: "root-b", suffix: "" });
});
```

Retain the existing selected-range split test to prove a row with children
still uses `split` away from the terminal collapsed-caret case.

- [ ] **Step 2: Run the resolver test and verify RED**

Run:

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts
```

Expected: the first new case fails because the resolver returns
`{ type: "split", prefix: "Root alpha", suffix: "" }`.

- [ ] **Step 3: Add a failing integration test**

In `NotesWorkspace.test.tsx`, configure a parent and existing child, put the
parent title caret at the end, press Enter, and assert:

```ts
expect(notesStoreMock.createNode).toHaveBeenCalledWith(
  "/vault",
  expect.objectContaining({
    parentId: "parent",
    afterId: null,
    beforeId: "existing-child",
    title: "",
    note: ""
  }),
  historyContextMatcher()
);
expect(notesStoreMock.splitNode).not.toHaveBeenCalled();
expect(await findTitleInput("")).toHaveFocus();
```

- [ ] **Step 4: Run the integration test and verify RED**

Run the owning test file with its existing Vitest selector syntax:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx
```

Expected: the new integration case fails because `splitNode` is called instead
of `createNode`.

- [ ] **Step 5: Implement the minimal resolver and row routing**

Extend the result union:

```ts
export type OutlineKeyResolution =
  | { type: "split"; prefix: string; suffix: string }
  | { type: "createFirstChild" }
  | { type: "createNextTextSibling" }
```

Before returning `split` for a text title:

```ts
const terminalCollapsedCaret =
  selectionStart === selectionEnd && selectionEnd === input.title.length;
const hasChildren =
  (input.workspace.childIdsByParent[input.nodeId]?.length ?? 0) > 0;
if (terminalCollapsedCaret && hasChildren) {
  return { type: "createFirstChild" };
}
```

Route it in the title-key switch:

```ts
case "createFirstChild":
  runStructuralCommand(() => actions.createChild(nodeId, "first"));
  return;
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx
```

Expected: both files pass with no new warnings.

- [ ] **Step 7: Review the frozen diff**

Run:

```bash
git diff -- src/features/notes/outlineKeyboard.ts src/features/notes/outlineKeyboard.test.ts src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesWorkspace.test.tsx
git diff --check
```

Expected: only the contextual Enter contract and its tests changed; unrelated
motion edits remain untouched.

### Task 2: Verify the frontend boundary

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Consumes: the completed frontend diff.
- Produces: fresh automated and desktop evidence for the user-visible behavior.

- [ ] **Step 1: Run the final frontend gates once**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all commands exit successfully. Cargo tests, Rust formatting, and
Clippy are explicitly skipped because Rust, IPC contracts, persistence, and
native configuration do not change.

- [ ] **Step 2: Perform a fresh desktop smoke test**

Launch a freshly built/restarted development app with an isolated temporary
Vault and verify:

1. Enter at the end of a parent with children creates a blank first child and
   focuses it.
2. Enter at the end of a leaf creates a sibling.
3. Enter in the middle of a parent title still splits into a sibling.

- [ ] **Step 3: Report evidence and remaining risk**

Report the root-cause commits, focused RED/GREEN evidence, full gate results,
desktop scenarios, preserved unrelated files, and any pre-existing warnings or
failures. Do not commit implementation unless the user requests it.
