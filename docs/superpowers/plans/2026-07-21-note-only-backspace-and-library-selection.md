# Note-only Backspace and Library Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm recoverable subtree deletion when Backspace is pressed at the start of a note-only bullet, and render the active Notes library row as a rectangular selection with a straight left accent.

**Architecture:** Extend the pure outline keyboard resolver with a semantic `confirmDelete` result. The ordinary row and page header then open the shared `ConfirmDialog` and call the existing soft-delete command only after confirmation; the visual change stays local to the active Notes library row selector.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Base UI `AlertDialog`, CSS, Tauri

## Global Constraints

- Move the confirmed bullet and all descendants to recoverable Trash through the existing `deleteNode` action.
- Trigger only for a whitespace-empty title, a nonempty supporting note, a collapsed caret at offset zero, and no image attachments.
- Ignore repeated, modified, or IME-composing key events through the existing resolver guards.
- Do not change storage schemas, Trash semantics, Undo/Redo, attachment deletion, or unrelated selection styles.
- Apply square corners only to the active Notes library page row; inactive and hover-only rows retain their current radius.
- Add no dependencies.

---

## File Map

- `src/features/notes/outlineKeyboard.ts`: semantic Backspace decision.
- `src/features/notes/outlineKeyboard.test.ts`: pure keyboard contract tests.
- `src/features/notes/OutlineNodeRow.tsx`: ordinary bullet confirmation dialog.
- `src/features/notes/NotesPageHeader.tsx`: page-title confirmation through the existing page dialog.
- `src/features/notes/NotesWorkspace.test.tsx`: ordinary bullet integration test.
- `src/features/notes/NotesPageHeader.test.tsx`: page-header integration test.
- `src/features/notes/notes.css`: active library row shape.
- `src/features/notes/NotesLibraryPageRow.test.tsx`: CSS contract test.

### Task 1: Add the semantic note-only Backspace result

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts:137-165,505-527`
- Test: `src/features/notes/outlineKeyboard.test.ts:838-960`

**Interfaces:**
- Consumes: `ResolveOutlineKeyInput` and its existing IME/modifier guards.
- Produces: `{ type: "confirmDelete" }` in `OutlineKeyResolution`.

- [ ] **Step 1: Write the failing resolver tests**

```ts
it("requests confirmation for a note-only row at the title start", () => {
  expect(
    resolveOutlineKey(
      input({
        key: "Backspace",
        title: " \t",
        note: "supporting context",
        selectionStart: 0,
        selectionEnd: 0
      })
    )
  ).toEqual({ type: "confirmDelete" });
});

it("keeps note-only Backspace native away from a plain start caret", () => {
  expect(
    resolveOutlineKey(
      input({
        key: "Backspace",
        title: "",
        note: "supporting context",
        selectionStart: 1,
        selectionEnd: 1
      })
    )
  ).toBeNull();
  expect(
    resolveOutlineKey(
      input({
        key: "Backspace",
        title: "",
        note: "supporting context",
        repeat: true
      })
    )
  ).toBeNull();
});
```

Extend the existing attachment fixture so an empty-title node with both a note
and an image attachment also resolves to `null`.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run src/features/notes/outlineKeyboard.test.ts -t "note-only"
```

Expected: FAIL because the resolver currently returns `null` for a nonempty
supporting note.

- [ ] **Step 3: Implement the minimal resolver result**

Add this union member:

```ts
  | { type: "confirmDelete" }
```

Replace only the Backspace branch with:

```ts
if (input.key === "Backspace") {
  if (imageTarget) {
    return null;
  }
  const hasAttachments =
    (input.workspace.attachmentsByNodeId[input.nodeId]?.length ?? 0) > 0;
  if (
    input.repeat ||
    !collapsedSelection ||
    selectionStart! !== 0 ||
    input.title.trim() ||
    visibleIndex < 0
  ) {
    return null;
  }
  if (input.note.trim()) {
    return hasAttachments ? null : { type: "confirmDelete" };
  }
  if (hasAttachments) {
    return null;
  }
  return {
    type: "remove",
    focusNodeId:
      visibleIds[visibleIndex - 1] ??
      input.workspace.childIdsByParent[input.nodeId]?.[0] ??
      visibleIds[visibleIndex + 1] ??
      null
  };
}
```

- [ ] **Step 4: Run the owning resolver module**

```bash
npx vitest run src/features/notes/outlineKeyboard.test.ts
```

Expected: all resolver tests PASS.

- [ ] **Step 5: Review and commit Task 1**

```bash
git add src/features/notes/outlineKeyboard.ts src/features/notes/outlineKeyboard.test.ts
git commit -m "feat(notes): request note-only delete confirmation"
```

### Task 2: Connect confirmation dialogs to the Trash action

**Files:**
- Modify: `src/features/notes/OutlineNodeRow.tsx:1-55,245-275,960-1010,1720-1765`
- Modify: `src/features/notes/NotesPageHeader.tsx:330-485`
- Test: `src/features/notes/NotesWorkspace.test.tsx:8330-8360`
- Test: `src/features/notes/NotesPageHeader.test.tsx:1640-1775`

**Interfaces:**
- Consumes: Task 1's `{ type: "confirmDelete" }` and `actions.deleteNode(nodeId)`.
- Produces: cancel-without-mutation and confirm-once dialog flows.

- [ ] **Step 1: Write the failing ordinary-row dialog test**

Replace the existing native note-only Backspace test with:

```tsx
it("confirms before moving a note-only bullet subtree to Trash", async () => {
  const user = userEvent.setup();
  configureRepository([
    node({ id: "page", title: "Page" }),
    node({
      id: "note-only",
      parentId: "page",
      title: "",
      note: "supporting context"
    }),
    node({ id: "child", parentId: "note-only", title: "Child" })
  ]);
  renderNotesWorkspace();
  const title = await findTitleInput("");
  title.focus();
  title.setSelectionRange(0, 0);

  expect(fireEvent.keyDown(title, { key: "Backspace" })).toBe(false);
  let dialog = screen.getByRole("alertdialog", {
    name: "Move bullet to Trash?"
  });
  await user.keyboard("{Escape}");
  expect(notesStoreMock.softDeleteNode).not.toHaveBeenCalled();
  expect(title).toHaveFocus();

  expect(fireEvent.keyDown(title, { key: "Backspace" })).toBe(false);
  dialog = screen.getByRole("alertdialog", {
    name: "Move bullet to Trash?"
  });
  await user.click(
    within(dialog).getByRole("button", { name: "Move to Trash" })
  );
  await waitFor(() =>
    expect(notesStoreMock.softDeleteNode).toHaveBeenCalledWith(
      "/vault",
      "note-only",
      historyContextMatcher()
    )
  );
});
```

Use the established repository mock assertion name at the existing test site;
do not introduce a duplicate mock layer if it is named differently there.

- [ ] **Step 2: Write the failing page-header dialog test**

```tsx
it("opens the page Trash confirmation for a note-only page title", async () => {
  const user = userEvent.setup();
  const workspace = renderZoomedOutline(
    workspaceValue({ title: "", note: "Project context" })
  );
  const title = editTextareaByName("Edit page title");
  title.setSelectionRange(0, 0);

  expect(fireEvent.keyDown(title, { key: "Backspace" })).toBe(false);
  let dialog = screen.getByRole("alertdialog", {
    name: "Move page to Trash?"
  });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(workspace.actions.deleteNode).not.toHaveBeenCalled();
  expect(title).toHaveFocus();

  expect(fireEvent.keyDown(title, { key: "Backspace" })).toBe(false);
  dialog = screen.getByRole("alertdialog", {
    name: "Move page to Trash?"
  });
  await user.click(
    within(dialog).getByRole("button", { name: "Move to Trash" })
  );
  expect(workspace.actions.deleteNode).toHaveBeenCalledOnce();
  expect(workspace.actions.deleteNode).toHaveBeenCalledWith("project");
});
```

- [ ] **Step 3: Run the focused UI tests and verify RED**

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "note-only bullet subtree"
npx vitest run src/features/notes/NotesPageHeader.test.tsx -t "note-only page title"
```

Expected: both FAIL because the keyboard handlers do not open dialogs.

- [ ] **Step 4: Implement the ordinary-row dialog**

Import `ConfirmDialog`, add `trashConfirmOpen` state, consume the new result,
and render this dialog inside the row root:

```tsx
case "confirmDelete":
  setTrashConfirmOpen(true);
  return;

<ConfirmDialog
  open={trashConfirmOpen}
  onOpenChange={setTrashConfirmOpen}
  title="Move bullet to Trash?"
  description="Move this bullet, its note, and all descendants to Trash?"
  confirmLabel="Move to Trash"
  cancelLabel="Cancel"
  danger
  onConfirm={() =>
    runStructuralCommand(() => actions.deleteNode(nodeId))
  }
/>
```

Do not change the bullet-menu Delete behavior.

- [ ] **Step 5: Reuse the page header's existing dialog**

Allow `confirmDelete` through its resolution filter and add:

```ts
case "confirmDelete":
  setTrashConfirmOpen(true);
  return;
```

Do not add a second page dialog or alter its existing action.

- [ ] **Step 6: Run the focused tests and both owning modules**

```bash
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "note-only bullet subtree"
npx vitest run src/features/notes/NotesPageHeader.test.tsx
```

Expected: confirmation tests and all page-header tests PASS.

- [ ] **Step 7: Review and commit Task 2**

```bash
git add src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx
git commit -m "feat(notes): confirm note-only bullet deletion"
```

### Task 3: Square the active Notes library selection

**Files:**
- Modify: `src/features/notes/notes.css:275-295`
- Test: `src/features/notes/NotesLibraryPageRow.test.tsx:1-10`

**Interfaces:**
- Consumes: `.notes-library-page-row[data-active="true"]` and existing selected tokens.
- Produces: active-only `border-radius: 0` with the existing inset accent.

- [ ] **Step 1: Add the failing CSS contract test**

```ts
import { readFileSync } from "node:fs";

const notesCss = readFileSync("src/features/notes/notes.css", "utf8");

it("uses a square active selection with the existing inset accent", () => {
  expect(notesCss).toMatch(
    /\.notes-library-page-row\[data-active="true"\]\s*\{[^}]*border-radius:\s*0;[^}]*background:\s*var\(--list-selected-bg\);[^}]*box-shadow:\s*var\(--list-selected-shadow\);/s
  );
  expect(notesCss).toMatch(
    /\.notes-library-page-row\s*\{[^}]*border-radius:\s*var\(--radius\);/s
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run src/features/notes/NotesLibraryPageRow.test.tsx -t "square active selection"
```

Expected: FAIL because the active selector does not override the base radius.

- [ ] **Step 3: Add the active-only square override**

```css
.notes-library-page-row[data-active="true"] {
  border-radius: 0;
  background: var(--list-selected-bg);
  box-shadow: var(--list-selected-shadow);
}
```

Do not change the base row radius or global selection tokens.

- [ ] **Step 4: Run the owning row test module**

```bash
npx vitest run src/features/notes/NotesLibraryPageRow.test.tsx
```

Expected: all page-row tests PASS.

- [ ] **Step 5: Review and commit Task 3**

```bash
git add src/features/notes/notes.css src/features/notes/NotesLibraryPageRow.test.tsx
git commit -m "style(notes): square selected library rows"
```

### Task 4: Integrated review and verification

**Files:**
- Review only: files modified in Tasks 1-3

**Interfaces:**
- Consumes: the three committed slices.
- Produces: final verified frontend behavior.

- [ ] **Step 1: Run all owning tests together**

```bash
npx vitest run src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesLibraryPageRow.test.tsx
npx vitest run src/features/notes/NotesWorkspace.test.tsx -t "note-only bullet subtree"
```

Expected: all selected tests PASS.

- [ ] **Step 2: Perform an adversarial diff review**

Verify directly in the diff:

- Note-only Backspace cannot bypass confirmation.
- Empty title plus empty note retains immediate empty-row removal.
- Any image attachment blocks the new confirmation path.
- Cancel and Escape perform no mutation and restore title focus.
- Confirm can enqueue only one structural command per click.
- The page header reuses its existing dialog.
- Only the active library row has square corners.
- No storage, Rust, IPC, or history files changed.

Fix a confirmed defect with a focused RED/GREEN test and commit it separately
as `fix(notes): harden note-only deletion confirmation`.

- [ ] **Step 3: Run the frontend gates once**

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all frontend tests, lint, build, and whitespace checks PASS. Skip
Cargo tests, formatting, and Clippy because no Rust/native boundary changed.

- [ ] **Step 4: Verify the Tauri flow**

1. Start a fresh Tauri bundle/process and create a disposable note-only bullet with one child.
2. Press Backspace at title offset zero, cancel, and verify focus/subtree preservation.
3. Press Backspace again, confirm, and verify the subtree appears in Trash.
4. Restore the disposable subtree so no deleted fixture remains.
5. Select two Notes pages and verify the active row is rectangular with a straight left accent while hover-only rows remain rounded.

- [ ] **Step 5: Record final repository state**

```bash
git status --short
git log -4 --oneline
```

Expected: only pre-existing user-owned untracked files remain, with Tasks 1-3
at the branch tip.
