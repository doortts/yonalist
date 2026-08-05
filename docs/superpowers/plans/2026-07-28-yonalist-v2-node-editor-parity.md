# Yonalist v2 Node Editor Parity Implementation Plan

**Goal:** Restore collapsed trees, supporting notes, Todo markers/progress,
Markdown presentation, slash commands, and date affordances on the v2 modular
architecture while preserving the current UI exactly.

**Architecture:** Node content fields are authoritative in `notes-core` and
persisted by `notes-sqlite`. Each user gesture maps to one semantic command and
one reversible patch. Presentation-only parsing remains in small pure
TypeScript modules. Pane-local visibility and focus never enter IPC.

**Scope constraints:**

- Keep the existing DOM classes, CSS tokens, geometry, colors, and typography.
- Do not import legacy production React or Rust modules.
- Do not add schema migrations; v2 still owns a new schema v1 database.
- Vault synchronization and GitHub Notifications remain excluded.
- Keep media and export outside the initial editable graph.
- Add a failing focused test before each production behavior.

## Task 1: Extend the node contract

- Add `NodeMarkerKind::{Bullet, Todo}`, supporting-note text, and collapsed
  state to `NoteNode`.
- Add reversible `UpdateNote`, `SetCollapsed`, and `SetMarker` commands.
- Preserve these fields through split, duplicate, delete/restore, Undo/Redo,
  and inverse patches.
- Make empty-row removal reject a node whose supporting note is nonempty.
- Prove domain behavior in `crates/notes-core/tests/tree_commands.rs`.

## Task 2: Persist and expose the new fields

- Add `note`, `marker`, and `collapsed` columns to the new schema-v1
  `notes_nodes` table.
- Extend all bounded node readers/writers and generated `NoteView`.
- Index both title and supporting note in FTS5 and derive tags/dates from both.
- Add React-to-SQLite restart tests and generated-contract checks.
- Update the browser preview adapter with the same command semantics.

## Task 3: Restore collapse/expand

- Compute visible outline rows by suppressing descendants of collapsed nodes.
- Render the current arrow-slot contract: empty for leaves; collapse/expand
  button for parents; collapsed halo on the existing bullet.
- Persist toggles through `SetCollapsed`; keep a zoom root effectively expanded.
- Expand a collapsed previous sibling before indenting beneath it.
- Verify arrow navigation skips hidden descendants and each split pane remains
  independent in focus while sharing confirmed collapse state.

## Task 4: Restore supporting notes

- Add a distinct debounced supporting-note draft buffer to `NotesStore`.
- Render the existing supporting-note field only for nonempty notes or after
  the current menu action opens it.
- Shift+Enter opens/focuses the current note, then moves to the next visible
  row's note, creating a sibling only at the end.
- Preserve Korean IME, blur/close flush, and empty-note normalization.

## Task 5: Restore Todo markers and progress

- Add menu/slash actions to switch between bullet and Todo.
- Render the current Todo checkbox column and reuse completion authority.
- Derive direct-child Todo progress in one pure pass over the visible query
  model.
- Preserve marker/progress behavior through duplicate, Undo/Redo, and restart.

## Task 6: Restore Markdown, slash, tags, and dates

- Keep the textarea as the editing authority and render the existing stable
  presentation layer only when unfocused.
- Implement bounded pure tokenization for inline Markdown, Unicode tags, and
  ISO dates without adding a runtime parser to the initial critical path.
- Lazy-load the slash menu and date picker; implement `/today` and `/todo`
  first, then the remaining characterized commands.
- Query tags and dates from SQLite-derived indexes and keep search bounded.

## Verification

After each task:

```powershell
cargo test --workspace
npm run test:v2:frontend
npm run lint:v2
node scripts/checkV2Contracts.mjs
```

After the slice:

```powershell
npm run test:v2
npm run test:v2:bundle
cargo fmt --all -- --check
cargo check --workspace --all-targets
git diff --check
```

Rebuild the Tauri release and verify collapse, note navigation, Todo progress,
slash/date actions, Undo/Redo, restart persistence, and unchanged visuals with
an isolated v2 data directory. Do not stage or commit without an explicit user
request.
