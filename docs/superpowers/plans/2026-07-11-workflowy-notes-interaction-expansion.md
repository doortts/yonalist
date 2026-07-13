# Workflowy Notes Interaction Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved offline Workflowy-style action rail, child creation,
Archive lifecycle, tag filtering, date picker, image attachments, and unified
Notes Undo/Redo without affecting non-Notes Yonalist behavior.

**Architecture:** Extend the existing Notes-only React context, serialized workspace
coordinator, and SQLite repository. Keep title and supporting-note content as plain
text; derive tag and date indexes transactionally. Store image metadata in SQLite
and owned bytes in `.yonalist/notes-assets`. Record row-level mutation journals for
session Undo/Redo instead of snapshotting the full workspace.

**Tech Stack:** React 18, TypeScript, Base UI, dnd-kit, Vitest/Testing Library,
Tauri 2, Rust, rusqlite, printpdf, SQLite FTS5.

## Global Constraints

- Work only in `/Users/doortts/repos/yonalist/.worktrees/notes-workflowy` on branch
  `codex/notes-workflowy`.
- Use tests first and observe each new test fail for the intended missing behavior.
- Keep implementation inside Notes-owned modules except for Tauri command
  registration and dependency/configuration changes required by Notes.
- Do not implement Turn Into, Board, Table, collaboration, mirrors, templates,
  backlinks, general files, PDF attachments, or Calendar pages.
- Preserve Korean IME composition, text selection, split, indentation, drag/drop,
  draft retries, export conflict behavior, and existing Inbox/Notifications tests.
- Do not expose a non-functional menu item.
- Every task ends with focused tests, full relevant regression tests, a task review,
  fixes for Critical/Important findings, re-review, and a dedicated commit.

---

### Task 1: SQLite v3 contracts, Archive model, and migration

**Files:**
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produce `NoteNode.archivedAt: string | null` and
  `NoteNode.archiveRootId: NoteId | null`.
- Produce `NotesWorkspaceScope` variants `archive` and structured `tags`.
- Produce `archiveNode`, `unarchiveNode`, and `listTagsWithCounts` store commands.
- Preserve all existing store method signatures until each caller is migrated.

- [ ] **Step 1: Add failing frontend contract tests**

Add fixtures that reject nodes missing archive fields and verify Tauri command
payloads for `notes_archive_node`, `notes_unarchive_node`, and counted tags.

Run:

```bash
npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts
```

Expected: FAIL because archive fields, scope, and commands do not exist.

- [ ] **Step 2: Add failing Rust migration and scope tests**

Cover fresh v3 creation, v1-to-v3, v2-to-v3, archived subtree exclusion from Active,
Starred, Recent, Tag, and search, Archive projection, and unarchive ordering.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::repository
```

Expected: FAIL on schema version and missing archive operations.

- [ ] **Step 3: Extend the schema transactionally**

Set `NOTES_SCHEMA_VERSION` to 3 and add the approved columns/tables. The migration
must use the existing immediate transaction and retain `PRAGMA foreign_keys = ON`.
Use indexes on `(archived_at, parent_id, sort_key)`, tag prefix/normalized value,
date ranges, attachment node order, and history session sequence.

- [ ] **Step 4: Implement root-only Archive operations**

Validate that the requested node is a live root. Mark the root and every live
descendant with one `archived_at` and `archive_root_id`. Unarchive only rows owned by
that archive root. Rebuild search/tag/date visibility in the same transaction.

- [ ] **Step 5: Update all workspace queries**

Active queries require `deleted_at IS NULL AND archived_at IS NULL`. Archive queries
return archived roots and descendants. Trash remains disjoint. Search and tag counts
exclude archived and trashed rows.

- [ ] **Step 6: Run focused and full Rust tests**

```bash
npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts
cargo test --manifest-path src-tauri/Cargo.toml notes::
```

Expected: PASS with zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/domain/notes.ts src/services/notesStore.ts \
  src/services/notesStore.tauri.test.ts src-tauri/src/notes/types.rs \
  src-tauri/src/notes/repository.rs src-tauri/src/notes/commands.rs src-tauri/src/lib.rs
git commit -m "feat(notes): add archive persistence contracts"
```

---

### Task 2: Row-level mutation journal and unified Undo/Redo

**Files:**
- Create: `src/features/notes/notesHistory.ts`
- Create: `src/features/notes/notesHistory.test.ts`
- Modify: `src/domain/notes.ts`
- Modify: `src/domain/notes.test.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/services/notesStore.tauri.test.ts`
- Modify: `src/features/notes/outlineKeyboard.ts`
- Modify: `src/features/notes/outlineKeyboard.test.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.ts`
- Modify: `src/features/notes/notesWorkspaceReducer.test.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Create: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produce one authoritative backend history stack. Frontend `notesHistory.ts` owns
  stable text-burst ids and UI snapshots keyed by backend entry id, not a second
  mutation stack.
- Produce Tauri commands `notes_undo`, `notes_redo`, and `notes_clear_history`.
- Produce `NotesHistoryContext { sessionId, entryId, commandKind }` and
  `NotesMutationResult { workspace, historyEntryId, canUndo, canRedo }`.

- [ ] **Step 1: Add failing pure history tests**

Test text-burst id reuse/closure, UI snapshot merging, graceful missing/evicted UI
snapshots, independent vault sessions, and platform shortcut resolution. The backend
tests own stack eviction and payload-size assertions.

```bash
npm test -- src/features/notes/notesHistory.test.ts \
  src/features/notes/outlineKeyboard.test.ts
```

Expected: FAIL because no history module or shortcut resolutions exist.

- [ ] **Step 2: Add failing repository journal tests**

Cover create, update, text-burst row coalescing, 100-entry and 50 MiB eviction, move
with sibling rebalance, split, complete, collapse, star,
duplicate, Trash, restore, Archive, and unarchive. For each operation assert Undo
restores row values and ordering, Redo reapplies them, and derived tag/search rows
match the restored content.

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes_history
```

Expected: FAIL because the journal and commands are absent.

- [ ] **Step 3: Implement row-change capture**

Implement `with_history_transaction` in `history.rs`. Start an IMMEDIATE transaction
and use connection-local temporary audit tables/triggers for `notes_nodes` and
`notes_attachments`. Store one row per `(entry_id, table_name, row_id)`: UPSERT keeps
the first `before_json` and replaces the latest `after_json`. Tags, dates, and FTS
remain derived and are rebuilt for affected node ids during Undo/Redo.

- [ ] **Step 4: Implement bounded session stacks**

Use a generated vault-session id owned by the shared coordinator entry. Clear expired
sessions during initialization. Enforce both entry-count and estimated-byte limits.
File bytes are retained while a history record can redo an attachment addition.

- [ ] **Step 5: Integrate the coordinator**

All Undo/Redo calls are coordinator work items. Close a text burst before any
structural action. Assign a text entry id when the draft starts, not when debounce
flushes. Compound move plus incidental expand share one structural entry id, while a
closed text burst and following split use distinct ids. Store before/after scope,
selection, zoom root, local expansion, and `{ nodeId, field: "title" | "note" }`
focus in the frontend UI map keyed by backend entry id.

- [ ] **Step 6: Add keyboard integration tests**

Test `Cmd+Z`, `Ctrl+Z`, `Cmd/Ctrl+Shift+Z`, Windows `Ctrl+Y`, IME suppression,
pending-write ordering, focus restoration, and Redo invalidation.

```bash
npm test -- src/features/notes/notesHistory.test.ts \
  src/features/notes/outlineKeyboard.test.ts \
  src/features/notes/useNotesWorkspace.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml notes_history
```

Expected: PASS with zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/features/notes/notesHistory.ts \
  src/features/notes/notesHistory.test.ts \
  src/domain/notes.ts src/domain/notes.test.ts \
  src/services/notesStore.ts src/services/notesStore.tauri.test.ts \
  src/features/notes/outlineKeyboard.ts \
  src/features/notes/outlineKeyboard.test.ts \
  src/features/notes/useNotesWorkspace.ts \
  src/features/notes/useNotesWorkspace.test.tsx \
  src/features/notes/notesWorkspaceCoordinator.ts \
  src/features/notes/notesWorkspaceCoordinator.test.ts \
  src/features/notes/notesWorkspaceReducer.ts \
  src/features/notes/notesWorkspaceReducer.test.ts \
  src/features/notes/OutlineNodeRow.tsx \
  src/features/notes/NotesPageHeader.tsx \
  src-tauri/src/notes/history.rs src-tauri/src/notes/mod.rs \
  src-tauri/src/notes/types.rs src-tauri/src/notes/repository.rs \
  src-tauri/src/notes/commands.rs src-tauri/src/lib.rs
git commit -m "feat(notes): add unified undo and redo"
```

---

### Task 3: Left action rail, collapsed halo, and page child composer

**Files:**
- Create: `src/features/notes/NotesChildComposer.tsx`
- Create: `src/features/notes/NotesChildComposer.test.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/NotesBulletMenu.tsx`
- Modify: `src/features/notes/NotesBulletMenu.test.tsx`
- Modify: `src/features/notes/NotesPageHeader.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Produce a stable row geometry ordered menu, arrow, bullet, content.
- `NotesChildComposer` consumes `parentId`, `disabled`, and `hasChildren` and calls
  `actions.createChild(parentId)`.

- [ ] **Step 1: Add failing component tests**

Assert that a leaf zoom root exposes `Add child`, clicking calls
`createChild(rootId)`, non-empty pages expose a trailing composer, and disabled/Trash
states do not create. Assert DOM order places the menu trigger before the arrow and
bullet. Assert the page header no longer reserves a far-right menu column.

```bash
npm test -- src/features/notes/NotesChildComposer.test.tsx \
  src/features/notes/NotesPageHeader.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
```

Expected: FAIL because the composer is absent and menu order is unchanged.

- [ ] **Step 2: Implement the composer through the existing action**

Do not create a second persistence path. Use `actions.createChild(parentId)` so
selection, focus, write serialization, and Undo use the established action.

- [ ] **Step 3: Move action triggers to the left rail**

Use a fixed-width slot before the existing arrow and bullet slots. Show it with
`:hover`, `:focus-within`, selected state, and `[data-popup-open]`. Keep it reachable
on coarse pointers. Position the popup relative to this trigger with start alignment.

- [ ] **Step 4: Strengthen collapsed-parent styling**

Retain `data-collapsed="true"` and expand the pseudo-element halo without changing
the 18x28 bullet hit-target column. Add light/dark computed-style assertions and a
snapshot fixture containing leaf, expanded parent, collapsed parent, and completed
collapsed parent.

- [ ] **Step 5: Verify focused UI tests and build**

```bash
npm test -- src/features/notes/NotesChildComposer.test.tsx \
  src/features/notes/NotesBulletMenu.test.tsx \
  src/features/notes/NotesPageHeader.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
npm run build
```

Expected: PASS and build exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/features/notes/NotesChildComposer.tsx \
  src/features/notes/NotesChildComposer.test.tsx \
  src/features/notes/OutlineNodeRow.tsx \
  src/features/notes/NotesPageHeader.tsx \
  src/features/notes/NotesOutlinePane.tsx \
  src/features/notes/NotesBulletMenu.tsx \
  src/features/notes/NotesBulletMenu.test.tsx \
  src/features/notes/NotesPageHeader.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "feat(notes): move actions beside workflowy bullets"
```

---

### Task 4: Root library actions and Archive workflow

**Files:**
- Create: `src/features/notes/NotesLibraryPageRow.tsx`
- Create: `src/features/notes/NotesLibraryPageRow.test.tsx`
- Modify: `src/features/notes/NotesLibraryPane.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/useNotesWorkspace.test.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Produce `archiveNode(rootId)` and `unarchiveNode(rootId)` workspace actions.
- Add `archive` to `NotesLibraryView`.
- The library row keeps page selection and menu activation as separate controls.

- [ ] **Step 1: Add failing library-row and integration tests**

Cover separate hit targets, root-only actions, confirmation before moving a root
subtree to Trash, Archive view selection, unarchive, fallback navigation after the
current root disappears, and Undo navigation restoration.

```bash
npm test -- src/features/notes/NotesLibraryPageRow.test.tsx \
  src/features/notes/useNotesWorkspace.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
```

Expected: FAIL because Archive view and row actions are missing.

- [ ] **Step 2: Implement Archive actions through the coordinator**

Flush current drafts, enqueue archive/unarchive, publish the authoritative workspace,
refresh tags, and choose the deterministic fallback root. Reject descendant ids in
the frontend before invoking the root-only backend command.

- [ ] **Step 3: Implement library row and Archive view**

Archive rows are read-only in the detail pane. Their menu contains Unarchive and
Move to Trash. Normal rows contain the approved root commands. Show empty-state copy
specific to Archive and Trash.

- [ ] **Step 4: Run focused tests and full Notes UI tests**

```bash
npm test -- src/features/notes/NotesLibraryPageRow.test.tsx \
  src/features/notes/useNotesWorkspace.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
```

Expected: PASS with zero failures.

- [ ] **Step 5: Commit**

```bash
git add src/features/notes/NotesLibraryPageRow.tsx \
  src/features/notes/NotesLibraryPageRow.test.tsx \
  src/features/notes/NotesLibraryPane.tsx \
  src/features/notes/useNotesWorkspace.ts \
  src/features/notes/useNotesWorkspace.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "feat(notes): archive and trash root pages"
```

---

### Task 5: Inline tag presentation and structured tag search

**Files:**
- Create: `src/features/notes/noteTokens.ts`
- Create: `src/features/notes/noteTokens.test.ts`
- Create: `src/features/notes/NoteTokenText.tsx`
- Create: `src/features/notes/NoteTokenText.test.tsx`
- Create: `src/features/notes/NoteTextField.tsx`
- Create: `src/features/notes/NoteTextField.test.tsx`
- Modify: `src/domain/notes.ts`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/NotesLibraryPane.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Produce `tokenizeNoteText(text): readonly NoteTextToken[]` with zero-based,
  field-local, half-open UTF-16 offsets that reconstruct the original source.
- Produce structured tag clauses supporting required, excluded, and OR groups.
- Produce counted tag summaries `{ prefix, normalizedTag, displayTag, count }`.

- [ ] **Step 1: Add failing tokenizer tests**

Cover Korean/ASCII tags, `#` and `@`, `_` and `-`, punctuation boundaries, empty
markers, duplicate case variants, URL fragments, and original UTF-16 offsets used by
textareas.

```bash
npm test -- src/features/notes/noteTokens.test.ts
```

Expected: FAIL because the tokenizer is absent.

- [ ] **Step 2: Implement a pure tokenizer and display component**

Resting mode renders text and interactive tag tokens with identical typography and
white-space rules. `NoteTextField` keeps the existing native textarea mounted across
both modes and only changes its layout visibility. Clicking a token must not first
place the title textarea caret. Composition locks editing mode until
`compositionend`.

- [ ] **Step 3: Add failing repository query tests**

Cover exact tags, AND, excluded tags, OR groups, plain-text plus tags, counts,
archived/trash exclusion, case folding, title/note extraction, split, duplicate,
restore, and Undo/Redo.

- [ ] **Step 4: Implement structured SQL queries**

Use parameters for every tag and text term. Do not assemble user text directly into
SQL. Preserve FTS ranking for plain text and use indexed `notes_tags` existence
clauses for tag logic.

- [ ] **Step 5: Integrate filter chips and location restoration**

Clicking tags adds/removes active filters. The last removal restores the prior
library view and zoom root when still live. Search results show ancestor trails and
navigate to the source node.

- [ ] **Step 6: Verify frontend and Rust tests**

```bash
npm test -- src/features/notes/noteTokens.test.ts \
  src/features/notes/NoteTokenText.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml notes_tag
```

Expected: PASS with zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/features/notes/noteTokens.ts src/features/notes/noteTokens.test.ts \
  src/features/notes/NoteTokenText.tsx \
  src/features/notes/NoteTokenText.test.tsx \
  src/features/notes/NoteTextField.tsx \
  src/features/notes/NoteTextField.test.tsx src/domain/notes.ts \
  src/features/notes/OutlineNodeRow.tsx \
  src/features/notes/NotesPageHeader.tsx \
  src/features/notes/NotesLibraryPane.tsx \
  src/features/notes/useNotesWorkspace.ts \
  src/features/notes/NotesWorkspace.test.tsx \
  src-tauri/src/notes/repository.rs src-tauri/src/notes/commands.rs \
  src/features/notes/notes.css
git commit -m "feat(notes): add workflowy tag filtering"
```

---

### Task 6: Date parser, picker, index, and search

**Files:**
- Create: `src/features/notes/noteDates.ts`
- Create: `src/features/notes/noteDates.test.ts`
- Create: `src/features/notes/NotesDatePicker.tsx`
- Create: `src/features/notes/NotesDatePicker.test.tsx`
- Modify: `src/features/notes/noteTokens.ts`
- Modify: `src/features/notes/NoteTokenText.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/NotesBulletMenu.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/export.rs`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Produce deterministic local-date parsing with injectable `today` for tests.
- Produce a picker commit `{ start: LocalDate, end: LocalDate | null, format }`.
- Derive indexed start/end dates from title and note on every content mutation.

- [ ] **Step 1: Add failing parser tests**

Cover numeric formats, official natural-language terms, leap days, invalid dates,
year boundaries, ranges, tag/date overlap, timezone-independent local dates, and
stable source offsets.

- [ ] **Step 2: Add failing picker interaction tests**

Cover `!!`, menu opening, existing-pill editing, quick choices, keyboard calendar
navigation, range toggle, month navigation, format selection, removal, Escape focus
return, and IME suppression.

```bash
npm test -- src/features/notes/noteDates.test.ts \
  src/features/notes/NotesDatePicker.test.tsx
```

Expected: FAIL because parser and picker are absent.

- [ ] **Step 3: Implement parser and picker**

Keep calendar arithmetic in pure functions. The picker owns no persistence; it
returns one text replacement command so insertion/update/removal is one Undo entry.

- [ ] **Step 4: Add and implement date index tests**

Rust and TypeScript must consume shared JSON fixtures for accepted inputs and
normalized results. Index replacement occurs in the content mutation transaction.

- [ ] **Step 5: Integrate display pills, search, export, and Undo**

Resting display shows pills. Editing mode keeps readable raw text. Search supports
specific dates and normalized ranges. Markdown preserves readable text; PDF uses the
display format without changing canonical dates.

- [ ] **Step 6: Verify**

```bash
npm test -- src/features/notes/noteDates.test.ts \
  src/features/notes/NotesDatePicker.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml notes_date
```

Expected: PASS with zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/features/notes/noteDates.ts src/features/notes/noteDates.test.ts \
  src/features/notes/NotesDatePicker.tsx \
  src/features/notes/NotesDatePicker.test.tsx \
  src/features/notes/noteTokens.ts src/features/notes/NoteTokenText.tsx \
  src/features/notes/OutlineNodeRow.tsx \
  src/features/notes/NotesPageHeader.tsx \
  src/features/notes/NotesBulletMenu.tsx \
  src/features/notes/NotesWorkspace.test.tsx \
  src-tauri/src/notes/repository.rs src-tauri/src/notes/export.rs \
  src/features/notes/notes.css
git commit -m "feat(notes): add workflowy date picker"
```

---

### Task 7: Offline image attachments and aspect-ratio resize

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/notes/attachments.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Create: `src/features/notes/NotesImageAttachment.tsx`
- Create: `src/features/notes/NotesImageAttachment.test.tsx`
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesBulletMenu.tsx`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src/features/notes/notes.css`

**Interfaces:**
- Produce import, read-bytes, resize, remove, and restore attachment commands.
- Produce ordered `attachmentsByNodeId` in the Notes workspace contract.
- `NotesImageAttachment` receives intrinsic dimensions and persisted display width.

- [ ] **Step 1: Add failing Rust validation tests**

Cover valid PNG/JPEG/WebP/GIF, extension/MIME spoofing, unsupported SVG, byte limit,
pixel limit, truncated data, hash deduplication, safe relative paths, import failure
cleanup, and unreferenced-file reconciliation.

- [ ] **Step 2: Implement owned asset import**

Read and validate the source before publication. Copy through a temporary file in
the owned asset directory, fsync, rename atomically, then commit metadata. A failed
metadata commit triggers reconciliation rather than deleting a possibly shared hash.

- [ ] **Step 3: Add failing component tests**

Cover no-upscale default, content-width cap, intrinsic aspect ratio, pointer resize,
keyboard resize, a single persisted update on release, object-URL cleanup, menu
upload, delete/Undo/Redo, and load failure fallback.

- [ ] **Step 4: Implement byte loading and image component**

Return validated raw bytes from Tauri and create revocable Blob URLs in React. Clamp
width between 160px and the current content width. Persist width only at interaction
commit.

- [ ] **Step 5: Integrate history and Empty Trash cleanup**

Attachment row changes use the Task 2 journal. Keep bytes while reachable from live,
Trash, Archive, or history records. Reconciliation removes bytes with no references.

- [ ] **Step 6: Verify**

```bash
npm test -- src/features/notes/NotesImageAttachment.test.tsx \
  src/features/notes/NotesWorkspace.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml notes_attachment
```

Expected: PASS with zero failures.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/notes/attachments.rs \
  src-tauri/src/notes/mod.rs src-tauri/src/notes/types.rs \
  src-tauri/src/notes/repository.rs src-tauri/src/notes/commands.rs \
  src-tauri/src/lib.rs src/domain/notes.ts src/services/notesStore.ts \
  src/features/notes/NotesImageAttachment.tsx \
  src/features/notes/NotesImageAttachment.test.tsx \
  src/features/notes/OutlineNodeRow.tsx \
  src/features/notes/NotesBulletMenu.tsx \
  src/features/notes/NotesWorkspace.test.tsx src/features/notes/notes.css
git commit -m "feat(notes): store and resize offline images"
```

---

### Task 8: Attachment-aware Markdown/PDF export

**Files:**
- Modify: `src-tauri/src/notes/export.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src/domain/notesExport.ts`
- Modify: `src/services/notesExport.ts`
- Modify: `src/services/notesExport.test.ts`

**Interfaces:**
- Markdown export writes `<name>_assets/` next to the selected `.md` and uses
  relative POSIX links.
- PDF export embeds images at persisted display ratio while respecting page margins.

- [ ] **Step 1: Add failing Markdown export tests**

Cover frontmatter stability, ordered image links, safe filename collision handling,
overwrite preflight for both Markdown and asset directory, atomic replacement, and
no source-database mutation.

- [ ] **Step 2: Add failing PDF export tests**

Cover image embedding, aspect ratio, page-width clamp, pagination around images,
missing-byte failure, overwrite behavior, and no source-database mutation.

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes_export
```

Expected: FAIL on missing attachment export behavior.

- [ ] **Step 3: Implement export snapshot attachments**

Load the export database read-only, validate every owned path, and include attachment
metadata in the snapshot. Resolve no external URLs and never follow arbitrary
symlinks.

- [ ] **Step 4: Implement atomic Markdown asset output and PDF embedding**

Write temporary files/directories in the destination parent, then replace final
outputs only after every attachment succeeds. On failure remove temporary output and
leave an existing destination untouched.

- [ ] **Step 5: Verify exports**

```bash
npm test -- src/services/notesExport.test.ts
cargo test --manifest-path src-tauri/Cargo.toml notes_export
```

Expected: PASS with zero failures.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/notes/export.rs src-tauri/src/notes/commands.rs \
  src-tauri/src/notes/repository.rs src/domain/notesExport.ts \
  src/services/notesExport.ts src/services/notesExport.test.ts
git commit -m "feat(notes): export local image attachments"
```

---

### Task 9: Integrated workflows, screenshots, and performance gates

**Files:**
- Create: `src/features/notes/notesExpansion.performance.test.ts`
- Modify: `src/features/notes/NotesWorkspace.test.tsx`
- Modify: `src-tauri/src/notes/repository.rs`
- Create: `.superpowers/sdd/notes-interaction-expansion-report.md`
- Update generated evidence under `.superpowers/sdd/artifacts/`

**Interfaces:**
- Produce reproducible functional and performance evidence from the final commit.

- [ ] **Step 1: Add integrated frontend workflows**

Cover create-child from an empty page, left menu keyboard use, collapsed halo,
Archive/Undo, Trash/restore, tag click and multi-filter, `!!` date insertion and
editing, image upload/resize/Undo, and export initiation.

- [ ] **Step 2: Add native and frontend performance probes**

Measure 1,000 and 10,000 nodes for active load, tag AND/OR/NOT, date range search,
Archive/unarchive, mutation+Undo, tokenization, visible-row derivation, and history
eviction. Record median and p95 with 5 warmups and 31 measured samples.

- [ ] **Step 3: Run full automated verification**

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
NOTES_PERF=1 npm test -- src/features/notes/notesExpansion.performance.test.ts \
  --pool=threads --maxWorkers=1 --minWorkers=1
cargo test --release --manifest-path src-tauri/Cargo.toml \
  notes_interaction_expansion_performance -- --ignored --nocapture --test-threads=1
```

Expected: every command exits 0. Any p95 regression greater than 20% from the recorded
baseline is investigated and either corrected or explicitly justified with evidence.

- [ ] **Step 4: Run visual and accessibility verification**

Use the native Tauri app and in-app browser tooling at desktop and 390px width.
Capture expanded, collapsed, empty zoom, menu-open, Archive, tag-filtered, date picker,
and resized-image states. Verify no overlap, blank canvas, clipped text, or inaccessible
control.

- [ ] **Step 5: Run independent adversarial reviews**

First reviewer attempts to break data integrity, Undo ordering, path validation,
search correctness, keyboard focus, IME, export atomicity, and performance. A second
reviewer evaluates every finding against the specification and evidence. Correct all
validated Critical and Important findings, add regression tests, and repeat both
reviews until neither has an unresolved validated issue.

- [ ] **Step 6: Write final report and commit**

```bash
git add src/features/notes/notesExpansion.performance.test.ts \
  src/features/notes/NotesWorkspace.test.tsx \
  src-tauri/src/notes/repository.rs \
  .superpowers/sdd/notes-interaction-expansion-report.md
git commit -m "test(notes): verify expanded workflowy interactions"
```

## Self-Review Checklist

- Every requirement in the approved 2026-07-11 design maps to a task above.
- Turn Into and collaboration remain absent from production tasks.
- Every production change has a preceding failing test step.
- Frontend and Rust names match the interfaces declared by earlier tasks.
- Archive, Trash, tags, dates, attachments, and history use disjoint states.
- Final verification includes behavior, migration, visual, accessibility, export,
  security, bundle, and performance evidence.
