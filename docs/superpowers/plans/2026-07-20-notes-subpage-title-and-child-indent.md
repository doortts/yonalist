# Notes Subpage Title and Child Indent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a zoomed Notes page title at one stable size and indent its complete child region by 24px.

**Architecture:** Keep the shared token renderer unchanged and make the page-title field the common typography boundary for its resting and editing layers. Mark the existing outline content when a valid zoom root is active, then apply one scoped CSS offset to the direct outline list and Add child composer so nested depth and drag geometry remain relative to the same shifted baseline.

**Tech Stack:** React 19, TypeScript 6, CSS, Vitest 4, Testing Library, Tauri 2

## Global Constraints

- Page-title typography remains exactly `27px`, weight `700`, line height `34px` in both resting and editing states.
- The zoomed page-child offset is exactly `24px` for the child list and Add child composer.
- Existing desktop/narrow per-depth indentation remains `36px`/`28px`.
- Ordinary unzoomed outline alignment, row hierarchy, `aria-level`, keyboard behavior, Undo/Redo, and the shared token renderer remain unchanged.
- Do not change Rust, IPC, persistence, or drag projection semantics.
- Write and observe each focused regression test failing before its production change.
- Verify the user-visible result in a freshly built and restarted Tauri process with disposable Vault data.

---

## File map

- Modify `src/features/notes/notes.css`: own page-title typography at the field boundary and define the scoped 24px zoomed child-region offset.
- Modify `src/features/notes/NotesOutlinePane.tsx`: expose whether the existing content column represents a valid zoomed page.
- Modify `src/features/notes/NotesWorkspace.test.tsx`: lock the title metrics, zoom marker, and scoped list/composer offset while retaining current geometry contracts.

### Task 1: Stable page-title typography

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:9493`
- Modify: `src/features/notes/notes.css:829-841`

**Interfaces:**
- Consumes: `NoteTextField`'s existing `.notes-page-title-field` container and `.notes-page-title` resting/editing children.
- Produces: one inherited typography boundary with `font-size: 27px`, `font-weight: 700`, and `line-height: 34px`.

- [ ] **Step 1: Add the failing field-typography contract**

In the existing `uses stable Workflowy row geometry without action overlap` test, add this assertion immediately before the current `.notes-page-title` assertion:

```ts
expect(notesStyles).toMatch(
  /\.notes-page-title-field\s*{[^}]*font-size:\s*27px;[^}]*font-weight:\s*700;[^}]*line-height:\s*34px;/s
);
```

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable Workflowy row geometry without action overlap"
```

Expected: FAIL because no standalone `.notes-page-title-field` rule owns those three font metrics.

- [ ] **Step 3: Put the title metrics on the common field boundary**

In `src/features/notes/notes.css`, add this rule after the existing title-field alignment rule:

```css
.notes-page-title-field {
  font-size: 27px;
  font-weight: 700;
  line-height: 34px;
}
```

Do not remove the same values from `.notes-page-title`; they remain the concrete textarea/control contract while the field makes the resting `NoteTokenText` inheritance resolve identically.

- [ ] **Step 4: Run the focused test and observe GREEN**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "uses stable Workflowy row geometry without action overlap"
```

Expected: PASS with the existing row, title, guide, drop-preview, and responsive geometry assertions still green.

- [ ] **Step 5: Commit the isolated title fix**

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): keep subpage title size stable"
```

### Task 2: Zoomed 24px child-region offset

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:3079-3103,9434-9456`
- Modify: `src/features/notes/NotesOutlinePane.tsx:3233-3240`
- Modify: `src/features/notes/notes.css:408-421,792-804`

**Interfaces:**
- Consumes: `state.zoomRootId`, `state.nodesById`, `.notes-outline-content`, `.notes-outline-list`, and `.notes-child-composer`.
- Produces: `data-zoomed-page="true"` only for a valid zoom root and `--notes-page-child-offset: 24px` applied to the list/composer direct children.

- [ ] **Step 1: Add the failing zoom-state DOM contract**

Extend `shares one centered content column between the page header and outline` so it proves the marker is absent before zoom and present after zoom:

```ts
const outline = screen.getByLabelText("Notes outline");
const allNotesContent = within(outline)
  .getByRole("list")
  .closest<HTMLElement>(".notes-outline-content");

expect(allNotesContent).not.toHaveAttribute("data-zoomed-page");

await user.click(screen.getByRole("button", { name: "Project" }));

const heading = await screen.findByRole("heading", {
  name: "Project",
  level: 1
});
const content = heading.closest<HTMLElement>(".notes-outline-content");

expect(content).not.toBeNull();
expect(content).toHaveAttribute("data-zoomed-page", "true");
expect(within(content!).getByRole("list")).toBeInTheDocument();
expect(content?.querySelector(".notes-child-composer")).not.toBeNull();
```

Replace the test's current click/heading/content assertion block with the complete block above so the click runs only once.

- [ ] **Step 2: Add the failing scoped-CSS contract**

In `uses stable Workflowy row geometry without action overlap`, extend the `.notes-outline` variable assertion and add the scoped offset assertion:

```ts
expect(notesStyles).toMatch(
  /\.notes-outline\s*{[^}]*--notes-outline-indent:\s*36px;[^}]*--notes-menu-width:\s*24px;[^}]*--notes-bullet-center-offset:\s*61px;[^}]*--notes-content-offset:\s*74px;[^}]*--notes-page-child-offset:\s*24px;/s
);
expect(notesStyles).toMatch(
  /\.notes-outline-content\[data-zoomed-page="true"\]\s*>\s*\.notes-outline-list,\s*\.notes-outline-content\[data-zoomed-page="true"\]\s*>\s*\.notes-child-composer\s*{[^}]*margin-inline-start:\s*var\(--notes-page-child-offset\);/s
);
```

Replace the existing `.notes-outline` variable assertion with the first assertion, then place the second assertion after the `.notes-outline-content` width contract.

- [ ] **Step 3: Run both focused tests and observe RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "shares one centered content column|uses stable Workflowy row geometry"
```

Expected: two FAIL results: the rendered content has no `data-zoomed-page`, and the stylesheet has neither the 24px token nor its scoped selector.

- [ ] **Step 4: Expose only a valid zoomed page on the content column**

Change the existing `.notes-outline-content` opening element in `NotesOutlinePane.tsx` to:

```tsx
<div
  className="notes-outline-content"
  data-zoomed-page={
    state.zoomRootId !== null && state.nodesById[state.zoomRootId]
      ? "true"
      : undefined
  }
  ref={contentRef}
  onCompositionEndCapture={handleSelectionCompositionEndCapture}
  onCompositionStartCapture={handleSelectionCompositionStartCapture}
  onCopyCapture={handleSelectionCopyCapture}
  onCutCapture={handleSelectionCutCapture}
  onKeyDownCapture={handleSelectionClipboardKeyDownCapture}
  onKeyUpCapture={handleSelectionClipboardKeyUpCapture}
  onPasteCapture={handlePasteCapture}
>
```

Keep every existing capture handler exactly once.

- [ ] **Step 5: Add the one scoped page-child offset**

Add the token after `--notes-content-offset` in `.notes-outline`:

```css
--notes-page-child-offset: 24px;
```

Add this rule after `.notes-outline-content`:

```css
.notes-outline-content[data-zoomed-page="true"] > .notes-outline-list,
.notes-outline-content[data-zoomed-page="true"] > .notes-child-composer {
  margin-inline-start: var(--notes-page-child-offset);
}
```

Do not alter `--notes-depth`, `--notes-outline-indent`, row grid columns, guide offsets, drop-preview offsets, or `aria-level`.

- [ ] **Step 6: Run both focused tests and observe GREEN**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "shares one centered content column|uses stable Workflowy row geometry"
```

Expected: PASS. The unzoomed content lacks the marker, the zoomed content owns it, and the list/composer share the 24px token without changing existing geometry assertions.

- [ ] **Step 7: Run the owning Notes workspace test file**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx
```

Expected: PASS with no new warnings or failures.

- [ ] **Step 8: Commit the isolated child-region fix**

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/notes.css
git commit -m "fix(notes): indent zoomed page children"
```

### Task 3: Fresh desktop proof and final frontend gates

**Files:**
- Verify only: `src/features/notes/notes.css`
- Verify only: `src/features/notes/NotesOutlinePane.tsx`
- Verify only: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: the Task 1 title metrics and Task 2 zoom marker/offset.
- Produces: fresh user-visible evidence plus complete frontend gate results; no additional source interface.

- [ ] **Step 1: Build before trusting a desktop process**

Run:

```bash
npm run build
```

Expected: TypeScript and Vite production build PASS.

- [ ] **Step 2: Start a fresh Tauri process with disposable Vault content**

Create a disposable directory with `mktemp -d`, stop only the prior Yonalist development process if one is running, and start:

```bash
npm run tauri:dev
```

In the fresh native window, select the disposable directory as the Vault folder before creating the proof outline. Record the explicit temporary path so it can be removed after the process closes.

- [ ] **Step 3: Exercise the approved visual and drag scenarios**

In the native Notes pane:

1. Create or use a page with one child and one grandchild.
2. Zoom into the page and compare the title with its caret visible and after focus moves away; size and line height must not change.
3. Confirm the first-level child region and Add child control are shifted 24px inward while the grandchild keeps its additional existing depth.
4. Drag a child across sibling and nested positions; the drop preview and resulting hierarchy must stay aligned.
5. Return to All notes; top-level alignment must remain unchanged.

Expected: every scenario passes in the restarted app. Close the development process and remove only the recorded disposable Vault directory afterward.

- [ ] **Step 4: Run the complete frontend gates once**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all frontend tests PASS, lint PASS, production build PASS, and `git diff --check` has no output. Skip Cargo tests and Rust formatting because no Rust, IPC, native command, or persistence file changed.

- [ ] **Step 5: Review final scope and report evidence**

Run:

```bash
git status --short --branch
git diff HEAD~2 -- src/features/notes/notes.css src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: only the approved title metrics, zoom marker, scoped 24px offset, and their tests appear in the implementation commits. Report focused RED/GREEN evidence, owning-test and full-gate results, fresh Tauri observations, the explicit Cargo skip rationale, and commit hashes.
