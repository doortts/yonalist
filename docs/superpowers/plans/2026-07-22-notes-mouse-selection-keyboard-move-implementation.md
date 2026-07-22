# Notes Mouse Selection Keyboard Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a mouse-created Notes selection with the existing platform-specific Workflowy keyboard shortcuts regardless of which outline element owns focus.

**Architecture:** Export one pure selected-move shortcut resolver from `outlineKeyboard.ts`. Let the outline content capture a recognized selected-move chord before the focused child and send it through the existing selection command router; retain row handlers for non-selection commands. Make menu hints consume the same platform contract.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Testing Library

## Global Constraints

- macOS move keys accept both `Ctrl+Shift+↑/↓` and `Cmd+Shift+↑/↓`.
- Windows/Linux move keys remain `Alt+Shift+↑/↓`.
- Existing selection authority, one-batch mutation, and Undo behavior remain unchanged.
- Mouse selection, drag-and-drop, Rust, IPC, SQLite, and file formats do not change.
- IME composition is not intercepted and key repeat is consumed without another move.

---

### Task 1: Route selected movement at the outline boundary

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts`
- Modify: `src/features/notes/outlineKeyboard.test.ts`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesBulletMenu.tsx`
- Modify: `src/features/notes/NotesBulletMenu.test.tsx`

**Interfaces:**
- Produces: `resolveWorkflowySelectionMoveShortcut(input): "moveUp" | "moveDown" | "consume" | null`
- Consumes: `executeGuardedSelectionCommand({ type: "moveUp" | "moveDown" })`

- [x] **Step 1: Write failing interaction and menu tests**

Add a workspace test that focuses `Bravo`, Shift-clicks the `Delta` bullet on
macOS, confirms the bullet button owns focus, presses `Ctrl+Shift+ArrowUp`, and
expects one selection batch move for `b`, `c`, and `d`.

Change the menu tests to expect `⌃⇧↑/↓` with
`Control+Shift+ArrowUp/Down` on macOS and `Alt+Shift+↑/↓` with
`Alt+Shift+ArrowUp/Down` on Windows/Linux.

- [x] **Step 2: Run the tests and verify the expected failures**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesBulletMenu.test.tsx
```

Expected: the bullet-focused move does not call `applyBatch`, and menu hints
still expose the mismatched Meta/Control strings.

- [x] **Step 3: Add the shared pure shortcut resolver**

In `outlineKeyboard.ts`, export a resolver that returns `null` during IME or
for a wrong chord, `consume` for repeat, and `moveUp`/`moveDown` for the exact
platform chord. Use it from `resolveOutlineKey` for a live selection.

- [x] **Step 4: Capture selected movement in the outline pane**

Extend the existing selection keydown capture in `NotesOutlinePane.tsx`. When
a live selection and resolver result exist, prevent default, stop propagation,
and execute `moveUp` or `moveDown` through `executeGuardedSelectionCommand`.
For `consume`, stop without executing. Leave clipboard handling unchanged.

- [x] **Step 5: Correct the menu hints**

Update `buildNotesBulletMenuShortcuts()` so Move up/down shows the actual
Workflowy keys for each platform.

- [x] **Step 6: Run focused and final verification**

Run the focused files, then `npm test`, `npm run lint`, `npm run build`, and
`git diff --check`. Confirm one batch move and unchanged selection after the
move.

---

### Task 2: Add the macOS Command-key move alias

**Files:**
- Modify: `src/features/notes/outlineKeyboard.ts`
- Modify: `src/features/notes/outlineKeyboard.test.ts`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesBulletMenu.tsx`
- Modify: `src/features/notes/NotesBulletMenu.test.tsx`

**Interfaces:**
- Consumes: `resolveWorkflowySelectionMoveShortcut(input)`
- Produces: the same move intent for macOS Ctrl or Meta chords, with neither
  both-modifier chords nor non-macOS behavior changed

- [x] **Step 1: Add failing resolver, integration, and menu tests**

Expect `Meta+Shift+ArrowUp/Down` to resolve on macOS, move a mouse-created
selection while its bullet owns focus, and appear beside the existing Ctrl
shortcut in visible and accessible menu metadata.

- [x] **Step 2: Verify the new expectations fail for the missing alias**

Run:

```bash
npm test -- src/features/notes/outlineKeyboard.test.ts src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesBulletMenu.test.tsx
```

Expected: Cmd move resolution/integration and the two-alternative macOS menu
expectations fail while existing Ctrl and non-macOS cases remain valid.

- [x] **Step 3: Implement the minimal shared alias**

Allow exactly one of Ctrl or Meta as the macOS move modifier in
`workflowyMoveDirection`. Keep Alt excluded. Update the menu to render both
macOS alternatives and expose both space-separated `aria-keyshortcuts` values.

- [x] **Step 4: Run focused and final verification**

Run the three focused files, then the frontend-only final gates: `npm test`,
`npm run lint`, `npm run build`, and `git diff --check`.
