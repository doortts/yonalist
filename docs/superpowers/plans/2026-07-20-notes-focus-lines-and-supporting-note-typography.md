# Notes Focus Lines and Supporting-Note Typography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove zoomed-page title and description focus lines while keeping row supporting-note typography stable across edit and resting states.

**Architecture:** Keep the change at the CSS field-ownership boundary. Focused CSS contract tests in `NotesWorkspace.test.tsx` define the visual behavior; `notes.css` supplies explicit page-field focus styling and parent-owned row-note typography without changing React, persistence, or history code.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, CSS, Tauri desktop runtime

## Global Constraints

- Page title and page description editor and presentation states must not draw an underline, border, inset focus line, or replacement outline.
- Row supporting notes must use 14px font size and 20px line height while editing and after blur.
- Keep the existing row supporting-note focus underline.
- Do not change Enter, Shift+Enter, persistence, Undo/Redo, React component structure, IPC, Rust, SQLite, or filesystem behavior.
- Use a freshly built and restarted Tauri app for manual proof.

---

### Task 1: Remove Zoomed-Page Field Focus Lines

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:9628`
- Modify: `src/features/notes/notes.css:1021`

**Interfaces:**
- Consumes: the `notesStyles` CSS source string already loaded by `NotesWorkspace.test.tsx`.
- Produces: page title and description focus rules whose editor and token-text presentation declarations contain `outline: 0` and `box-shadow: none`.

- [ ] **Step 1: Write the failing CSS contract test**

Add this test beside the existing title and supporting-note focus-style tests:

```tsx
it("keeps zoomed page title and description focus free of bottom lines", () => {
  const editorRule = notesStyles.match(
    /\.notes-page-title:focus-visible,\s*\.notes-page-note:focus-visible\s*{([^}]*)}/s
  )?.[1];
  const presentationRule = notesStyles.match(
    /\.notes-page-title-field > \.notes-token-text:focus-visible,\s*\.notes-page-note-field > \.notes-token-text:focus-visible\s*{([^}]*)}/s
  )?.[1];

  for (const rule of [editorRule, presentationRule]) {
    expect(rule).toBeDefined();
    expect(rule).toMatch(/outline:\s*0;/);
    expect(rule).toMatch(/box-shadow:\s*none;/);
    expect(rule).not.toMatch(
      /border-bottom|text-decoration|inset\s+0\s+-\d+px/
    );
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "keeps zoomed page title and description focus free of bottom lines"
```

Expected: FAIL because both current rules contain `box-shadow: inset 0 -2px 0 var(--accent)` and the editor rule does not declare `outline: 0`.

- [ ] **Step 3: Implement the minimal CSS change**

Replace the two page-field focus blocks with:

```css
.notes-page-title:focus-visible,
.notes-page-note:focus-visible {
  outline: 0;
  box-shadow: none;
}

.notes-page-title-field > .notes-token-text:focus-visible,
.notes-page-note-field > .notes-token-text:focus-visible {
  outline: 0;
  box-shadow: none;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "keeps zoomed page title and description focus free of bottom lines"
```

Expected: PASS with one test passed and all unrelated tests skipped.

- [ ] **Step 5: Commit the focus-style slice**

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): remove page field focus lines"
```

### Task 2: Stabilize Row Supporting-Note Typography

**Files:**
- Modify: `src/features/notes/NotesWorkspace.test.tsx:9500`
- Modify: `src/features/notes/notes.css:1715`

**Interfaces:**
- Consumes: `NoteTokenText` inline `font-size: inherit` and `line-height: inherit`, plus the existing `.notes-node-note` textarea metrics.
- Produces: `.notes-node-note-field` as the shared 14px/20px typography owner for both editing and resting surfaces.

- [ ] **Step 1: Write the failing typography contract test**

Add this test beside the existing Notes CSS layout contract tests:

```tsx
it("keeps row supporting-note typography stable after blur", () => {
  expect(notesStyles).toMatch(
    /\.notes-node-note-field\s*{[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;/s
  );
  expect(notesStyles).toMatch(
    /\.notes-node-note\s*{[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;/s
  );
  expect(notesStyles).toMatch(
    /\.notes-node-note-field > \.notes-token-text:focus-visible\s*{[^}]*box-shadow:\s*inset 0 -2px 0 var\(--accent\);[^}]*outline:\s*0;/s
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "keeps row supporting-note typography stable after blur"
```

Expected: FAIL because `.notes-node-note-field` does not own `font-size` or `line-height`.

- [ ] **Step 3: Implement the minimal parent typography rule**

Extend the existing field block without changing its layout:

```css
.notes-node-note-field {
  width: calc(100% - var(--notes-indent) - var(--notes-content-offset));
  margin: 2px 0 8px calc(var(--notes-indent) + var(--notes-content-offset));
  font-size: 14px;
  line-height: 20px;
}
```

- [ ] **Step 4: Run the focused and owning tests and verify GREEN**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx -t "keeps row supporting-note typography stable after blur"
npm test -- src/features/notes/NoteTextField.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: the focused test passes, then both owning test files pass with zero failures.

- [ ] **Step 5: Commit the typography slice**

```bash
git add src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "fix(notes): stabilize supporting note typography"
```

### Task 3: Verify the Integrated Desktop Behavior

**Files:**
- Verify: `src/features/notes/notes.css`
- Verify: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: the frozen Task 1 and Task 2 commits.
- Produces: fresh desktop and full frontend evidence for the combined visual behavior.

- [ ] **Step 1: Start a fresh Tauri development app**

Run `npm run tauri:dev` after stopping any stale Yonalist development process. Use a disposable Vault if changing or creating test content would affect the user's normal Vault.

Expected: a freshly compiled app window opens with the current bundle.

- [ ] **Step 2: Exercise the manual acceptance path**

Open a zoomed page and verify:

1. the title caret is visible with no bottom line;
2. the page-description caret is visible with no bottom line;
3. Shift+Enter opens a row supporting note;
4. the row note reports 14px font size and 20px line height while editing and after blur;
5. the row supporting-note focus underline remains visible;
6. title, description, and row-note keyboard editing still work.

- [ ] **Step 3: Run the frontend final gates once**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected:

- all frontend tests pass with only the repository's intentional skips;
- ESLint exits 0;
- TypeScript and Vite production build exit 0;
- `git diff --check` exits 0.

Explicitly skip Cargo tests, Rust formatting, and Clippy because no Rust, IPC payload, persistence, or native configuration file changes.

- [ ] **Step 4: Review repository state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -5
```

Expected: only the intended commits are present, there are no temporary Vault or screenshot artifacts in the repository, and the worktree is clean.
