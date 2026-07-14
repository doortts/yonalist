# Notes Editor Alignment and Page-Title Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep all Notes text stationary when editing starts and make the zoomed page title move focus to the first visible child with the existing arrow-key navigation rules.

**Architecture:** Preserve `NoteTextField`'s token-overlay architecture and correct the native textarea at the shared CSS boundary with a non-layout `translateY(-1px)`. Preserve `resolveOutlineKey` as the sole navigation resolver; extend `NotesPageHeader` to accept its existing `focus` result, flush the page draft, and delegate focus through the existing Notes actions.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library, CSS, Tauri WebKit desktop runtime

## Global Constraints

- Apply the alignment correction to every textarea directly owned by `.notes-text-field`: page title, page note, row title, and row note.
- Do not change textarea padding, height, line height, auto-grow measurement, wrapping, hit areas, or the token-overlay architecture.
- Reuse `resolveOutlineKey`; do not create a second outline traversal algorithm.
- Flush any pending page-title draft before delegating focus to another node.
- Keep existing completion, duplication, deletion, supporting-note, and structural keyboard shortcuts unchanged.

---

## File Structure

- Modify `src/features/notes/notes.css` to define the one shared textarea baseline correction.
- Modify `src/features/notes/NotesPageHeader.tsx` to accept and execute the resolver's `focus` action.
- Modify `src/features/notes/NotesWorkspace.test.tsx` to cover the CSS contract and zoomed page-title focus integration.

No new production file is needed: the behavior belongs at two existing shared boundaries and the regression coverage belongs in the established Notes workspace test suite.

### Task 1: Stabilize Every Notes Editing Baseline

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:4083-4151`
- Modify: `src/features/notes/notes.css:681-701`

**Interfaces:**
- Consumes: `NoteTextField`'s existing `.notes-text-field > textarea` DOM structure.
- Produces: a shared `transform: translateY(-1px)` visual correction for every Notes editing textarea.

- [ ] **Step 1: Add the failing shared-style contract**

Add this assertion near the beginning of the existing `uses stable Workflowy row geometry without action overlap` test, before the field-specific title and note assertions:

```ts
expect(notesStyles).toMatch(
  /\.notes-text-field\s*>\s*textarea\s*{[^}]*transform:\s*translateY\(-1px\);/s
);
```

This selector intentionally targets the common `NoteTextField` wrapper instead of one field variant, so page titles, page notes, row titles, and row notes cannot drift independently.

- [ ] **Step 2: Run the focused test and verify the regression is exposed**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable Workflowy row geometry without action overlap"
```

Expected: FAIL because `notes.css` does not yet contain `transform: translateY(-1px)` on `.notes-text-field > textarea`.

- [ ] **Step 3: Add the minimal shared CSS correction**

In `src/features/notes/notes.css`, immediately after the existing `.notes-text-field > .notes-token-text` rule, add:

```css
.notes-text-field > textarea {
  transform: translateY(-1px);
}
```

Do not add field-specific overrides or box-model changes.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable Workflowy row geometry without action overlap"
```

Expected: PASS with one matching Notes workspace test and no CSS-contract failure.

- [ ] **Step 5: Commit the baseline fix**

```bash
git add src/features/notes/notes.css src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): stabilize editing text alignment"
```

### Task 2: Navigate From the Zoomed Page Title

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:2742-2775`
- Modify: `src/features/notes/NotesPageHeader.tsx:197-262`

**Interfaces:**
- Consumes: `resolveOutlineKey(...)` returning `{ type: "focus"; nodeId: NoteId }`, `actions.flushNodeDraft(nodeId)`, and `actions.focusNode(nodeId)`.
- Produces: ArrowDown from the zoomed page title saves its draft and focuses the first visible child; other `focus` resolutions, including boundary ArrowRight, use the same execution path.

- [ ] **Step 1: Add the failing zoomed-page navigation test**

Add this integration test immediately after `saves before moving focus through visible rows without a native focus command`:

```ts
it("saves the zoomed page title before moving focus to its first child", async () => {
  const user = userEvent.setup();
  renderNotesWorkspace();
  await findTitleInput("Project");
  await user.click(
    screen.getByRole("button", { name: "Zoom into Project" })
  );
  const pageTitle = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Edit page title"
  });
  fireEvent.focus(pageTitle);
  fireEvent.change(pageTitle, { target: { value: "Project edited" } });

  expect(fireEvent.keyDown(pageTitle, { key: "ArrowDown" })).toBe(false);
  await waitFor(() => expect(queryTitleInput("Plan")).toHaveFocus());
  expect(notesStoreMock.updateNode).toHaveBeenCalledWith("/vault", {
    id: "project",
    title: "Project edited",
    note: "Project note"
  });
  expect(notesStoreMock.updateNode).toHaveBeenCalledOnce();
  expect(notesStoreMock.moveNode).not.toHaveBeenCalled();
});
```

The focus assertion uses `queryTitleInput` so the helper does not focus the child as a side effect.

- [ ] **Step 2: Run the focused test and verify the navigation bug**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "saves the zoomed page title before moving focus to its first child"
```

Expected: FAIL because `NotesPageHeader` filters out the resolver's `focus` result, leaving the page title focused and returning the native event result.

- [ ] **Step 3: Accept and execute the existing focus resolution**

In `NotesPageHeader.handleTitleKeyDown`, add `"focus"` to the accepted resolution types:

```ts
if (
  ![
    "focus",
    "focusNote",
    "toggleComplete",
    "duplicate",
    "delete"
  ].includes(resolution.type)
) {
```

Then add the following branch at the start of the existing switch:

```ts
switch (resolution.type) {
  case "focus":
    void actions.flushNodeDraft(nodeId);
    void actions.focusNode(resolution.nodeId);
    return;
  case "focusNote":
    openAndFocusNote();
    return;
```

Keep `event.preventDefault()` before the switch so the native textarea does not also move its caret. Do not inspect the key again in this branch: the resolver already selected the correct visible node.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "saves the zoomed page title before moving focus to its first child"
```

Expected: PASS; the edited page title is persisted once, `Plan` receives focus, and no structural move command runs.

- [ ] **Step 5: Run all Notes workspace regressions**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx
```

Expected: PASS for the complete `NotesWorkspace.test.tsx` file with no changed shortcut, focus, token, auto-grow, or layout regression.

- [ ] **Step 6: Commit the navigation fix**

```bash
git add src/features/notes/NotesPageHeader.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "fix(notes): navigate from zoomed page title"
```

### Task 3: Verify the Complete Fix

**Files:**
- Verify: `src/features/notes/notes.css`
- Verify: `src/features/notes/NotesPageHeader.tsx`
- Verify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: both committed fixes from Tasks 1 and 2.
- Produces: test, lint, build, and desktop-runtime evidence that the requested behavior is complete.

- [ ] **Step 1: Run the full automated test suite**

Run:

```bash
npm test
```

Expected: PASS for every Vitest file with zero failed tests.

- [ ] **Step 2: Run static analysis**

Run:

```bash
npm run lint
```

Expected: exit code 0 with no ESLint errors.

- [ ] **Step 3: Build the production frontend**

Run:

```bash
npm run build
```

Expected: exit code 0; TypeScript compilation and the Vite production build complete successfully.

- [ ] **Step 4: Inspect the final diff and repository state**

Run:

```bash
git diff --check HEAD~2..HEAD
git status --short --branch
```

Expected: `git diff --check` prints nothing, and `git status` shows no uncommitted implementation changes.

- [ ] **Step 5: Verify all four editing surfaces in the running Tauri app**

In the zoomed Notes page, compare each field before and after activation:

1. Page title.
2. Page supporting note.
3. Outline row title.
4. Outline row supporting note.

Expected: text glyphs remain on the same vertical baseline when the token presentation changes to the native textarea; surrounding rows do not reflow, and multi-line wrapping and caret placement remain intact.

- [ ] **Step 6: Verify page-title arrow navigation in the running Tauri app**

Focus the zoomed page title, make a temporary edit, and press ArrowDown. Then place the caret at the end of the page title and press ArrowRight.

Expected: both keys focus the first visible child according to the existing resolver rules, the title edit remains saved, and returning to the page shows the edited value. ArrowUp and ArrowLeft remain native/no-op when there is no visible destination.
