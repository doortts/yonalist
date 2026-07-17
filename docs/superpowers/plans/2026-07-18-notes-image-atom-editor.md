# Notes Image-Atom Bullet Editor Implementation Plan

**Date:** 2026-07-18

**Status:** Approved by the user

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the one owned image in an image bullet behave as a selectable logical character between editable primary text segments, with atomic backend edits, cross-application clipboard interoperability, exact Undo/Redo selection restoration, search/export parity, and the existing supporting note and child hierarchy preserved.

**Architecture:** Persist one raw `title` plus a UTF-16 `imageOffsetUtf16`; project it as before-text, one logical atom, and after-text. Rust owns every structural edit and byte publication as one audited transaction. A single React `contenteditable` editor owns DOM/logical selection mapping, while the existing textarea remains unchanged for text nodes. Connection-local TEMP receipts extend the prerequisite session-history epoch so a lost response can be reconciled without duplicate rows or files.

**Tech Stack:** React 19, TypeScript 6, Vitest/JSDOM, Tauri 2, Rust, rusqlite/SQLite FTS5 and TEMP tables, DOMPurify, Web Clipboard API.

## File Responsibility Map

- `schema.rs`, `repository.rs`, `types.rs`: current persistence, UTF-16 validation, derived/search rows, authoritative workspace/export shapes.
- `history.rs`, new `image_atom.rs`, `commands.rs`: TEMP receipts, protected history pruning, atomic edit/paste/import transactions, and Tauri boundaries.
- `attachment_ingest.rs`, `attachments.rs`, `notesAttachmentRawIpc.ts`: bounded raw-byte framing, validation, file publication, and reconciliation.
- New `imageAtomModel.ts` and `imageAtomDomSelection.ts`: pure logical coordinates and the only DOM/logical mapping boundary.
- New `ImageAtomEditor.tsx` and `notesImageAtomEditorRegistry.ts`: composition-safe editor ownership, draft flushing, focus, and paste claiming.
- `notesImageAtomClipboard.ts`, clipboard helpers, and `NotesImageResidencyContext.tsx`: serialization, sanitization, exact byte binding, and shared ephemeral prewarm.
- `notesCommands.ts`, `useNotesWorkspace.ts`, `notesWorkspaceCoordinator.ts`: command delegation, queue ownership, receipt settlement, and history projection.
- Row/header/image presentation components: reuse the editor while preserving existing image controls and ordinary row deletion.
- `export.rs` and new `markdown_import.rs`: canonical Markdown/PDF interchange and bounded round-trip parsing.

## Global Constraints

- Treat the image-atom DDL as the pre-release current schema: do not increment `CURRENT_NOTES_SCHEMA_VERSION`, add a migration, or preserve old development databases. The existing version guard remains untouched.
- An image node has exactly one owned primary attachment during ordinary writable operation. Removing the atom converts the node to `text`; generic attachment removal remains forbidden for image nodes.
- Persist `title = beforeText + afterText`; never persist U+FFFC or caret-aid characters. Text nodes always store offset zero.
- Validate offsets in UTF-16 units on both sides of IPC. Reject negative, out-of-range, unsafe-integer, and surrogate-splitting offsets before mutation.
- Structural image edits and byte paste are explicit backend commands, not compositions of `updateNode`, `splitNode`, attachment removal, and image import calls.
- The history entry ID is the operation ID. A matching receipt makes a retry idempotent; a conflicting fingerprint rejects before mutation.
- No image bytes, Blob, base64 string, workspace snapshot, Vault path, or reusable database ID may enter frontend history snapshots or receipt rows.
- Keep ordinary text rows on `NoteTextField`; create image-specific DOM listeners and mapping only for rendered/focused image editors.
- Preserve the existing `NotesImageNodeContent` loading, resizing, menu, lightbox, download, original-view, drag presentation, and damaged-image recovery behavior.
- Clipboard HTML parsing never fetches remote URLs. Internal metadata is accepted only when an actual byte carrier matches SHA-256, byte length, and sniffed MIME.
- Every new Tauri command is added to both `tauri::generate_handler!` and `src-tauri/build.rs::APP_COMMANDS` in the same task, then checked with the manifest parity test.
- Every task follows RED/GREEN: write the focused test first, observe the documented failure, implement the smallest behavior, run focused regressions, then make the task commit. Do not combine task commits.

---

### Task 0: Land and verify the session-history/navigation prerequisite

**Files:**
- Read/execute: `docs/superpowers/plans/2026-07-18-notes-session-history-navigation.md`
- Verify only: `src-tauri/src/notes/schema.rs`
- Verify only: `src-tauri/src/notes/repository.rs`
- Verify only: `src-tauri/src/notes/history.rs`
- Verify only: `src-tauri/src/notes/types.rs`
- Verify only: `src/domain/notes.ts`
- Verify only: `src/features/notes/notesHistory.ts`
- Verify only: `src/features/notes/notesWorkspaceCoordinator.ts`

**Interfaces required by Task 1:**

```text
main.notes_history_entries and main.notes_history_changes do not exist
temp.notes_history_epoch, temp.notes_history_entries, temp.notes_history_changes exist
NotesHistoryContext includes historyEpoch
status/mutation/replay results include historyEpoch, nextUndoEntryId,
nextRedoEntryId, and prunedEntryIds where limits can prune
CoordinatorEntry owns the mixed mutation/navigation timeline and epoch
```

- [ ] **Step 1: Complete the prerequisite plan exactly as written**

Implement and commit every task in `2026-07-18-notes-session-history-navigation.md`. Do not fold any image-atom changes into those commits.

- [ ] **Step 2: Run the prerequisite verification gate**

Run:

```bash
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/features/notes/notesHistory.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests
```

Expected: PASS. Inspect a writable test connection and prove the schema/epoch assertions above. The prerequisite must leave the existing schema-version marker unchanged and install TEMP history after fresh current-schema initialization.

- [ ] **Step 3: Preserve the prerequisite commit boundary**

No new commit is created for this gate. The prerequisite plan's task commits are the Task 0 evidence; begin image work from their completed head.

### Task 1: Define the current image-atom schema and thread the offset DTO

**Files:**
- Modify: `src-tauri/src/notes/schema.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Test: `src-tauri/src/notes/repository.rs` test module
- Test: `src-tauri/src/notes/history.rs` test module
- Test: `src-tauri/src/notes/types.rs` test module
- Test: `src-tauri/src/notes/commands.rs` test module
- Test: `src/domain/notes.test.ts`
- Test: `src/services/notesStore.test.ts`
- Test: `src/services/notesStore.tauri.test.ts`
- Modify test fixtures: `src/App.test.tsx`
- Modify: `src/features/notes/outlineTree.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify test fixtures: `src/features/notes/NotesAttachmentIngest.test.tsx`
- Modify test fixtures: `src/features/notes/NotesBulletMenu.test.tsx`
- Modify test fixtures: `src/features/notes/NotesChildComposer.test.tsx`
- Modify test fixtures: `src/features/notes/NotesExportMenu.test.tsx`
- Modify test fixtures: `src/features/notes/NotesLibraryPageRow.test.tsx`
- Modify test fixtures: `src/features/notes/NotesLibraryPane.test.tsx`
- Modify test fixtures: `src/features/notes/NotesMoveChooser.test.tsx`
- Modify test fixtures: `src/features/notes/NotesPageHeader.test.tsx`
- Modify test fixtures: `src/features/notes/NotesQuickJump.integration.test.tsx`
- Modify test fixtures: `src/features/notes/NotesWorkspace.test.tsx`
- Modify test fixtures: `src/features/notes/imageNodeInsertion.test.ts`
- Modify test fixtures: `src/features/notes/notesDraftEngine.test.ts`
- Modify test fixtures: `src/features/notes/notesExpansion.performance.test.ts`
- Modify test fixtures: `src/features/notes/notesMoveTargets.test.ts`
- Modify test fixtures: `src/features/notes/notesPresentation.test.ts`
- Modify test fixtures: `src/features/notes/notesSelectionActions.test.ts`
- Modify test fixtures: `src/features/notes/notesWorkspaceContextSplit.test.tsx`
- Modify test fixtures: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Modify test fixtures: `src/features/notes/notesWorkspaceReducer.test.ts`
- Modify test fixtures: `src/features/notes/outlineDrag.test.ts`
- Modify test fixtures: `src/features/notes/outlineKeyboard.test.ts`
- Modify test fixtures: `src/features/notes/outlineRowMemo.test.tsx`
- Modify test fixtures: `src/features/notes/outlineSelectionDragSession.test.ts`
- Modify test fixtures: `src/features/notes/outlineTree.test.ts`
- Modify test fixtures: `src/features/notes/useNotesSelectionCommandRouter.test.tsx`
- Modify test fixtures: `src/features/notes/useNotesWorkspace.test.tsx`

**Interfaces:**

```rust
pub(crate) fn validate_image_offset_utf16(
    title: &str,
    node_kind: NoteNodeKind,
    image_offset_utf16: i64,
) -> Result<usize, String>;

pub(crate) fn install_notes_sql_functions(connection: &Connection) -> Result<(), String>;
// SQL name: notes_image_search_title(title, node_kind, image_offset_utf16)

pub struct NoteNode {
    // existing fields
    pub image_offset_utf16: i64,
}

pub struct UpdateNodeInput {
    pub id: NoteId,
    pub title: String,
    pub note: String,
    pub image_offset_utf16: i64,
}
```

```ts
export interface NoteNode {
  // existing fields
  imageOffsetUtf16: number;
}

export interface UpdateNoteNodeInput {
  id: NoteId;
  title: string;
  note: string;
  imageOffsetUtf16: number;
}
```

The canonical current-schema column is:

```sql
image_offset_utf16 INTEGER NOT NULL DEFAULT 0
  CHECK (image_offset_utf16 >= 0)
```

- [ ] **Step 1: Write failing fresh-schema, validation, replay, import, and DTO tests**

Add focused tests covering:

```rust
#[test]
fn fresh_current_schema_defines_image_offset_and_attachment_search() {
    let db = test_connection();
    assert!(table_columns(&db, "notes_nodes").contains(&"image_offset_utf16".to_string()));
    assert_eq!(fts_columns(&db, "notes_search"), ["node_id", "title", "note", "attachment_name"]);
    assert_eq!(notes_image_search_title(&db, "A😀B", "image", 3), "A😀 B");
}

#[test]
fn image_offset_rejects_a_split_surrogate() {
    assert!(validate_image_offset_utf16("A😀B", NoteNodeKind::Image, 2).is_err());
    assert!(validate_image_offset_utf16("A😀B", NoteNodeKind::Image, 3).is_ok());
}
```

Also assert audit JSON round-trips the offset; Undo/Redo restores it; new path/raw image imports create empty title, empty note, and zero offset; and strict TS validators reject missing, fractional, negative, or unsafe offsets. Prove the fresh current FTS schemas have `attachment_name` and the registered `notes_image_search_title("A😀B", "image", 3)` scalar returns `"A😀 B"` without using SQLite code-point offsets. Keep malformed zero/multiple-attachment recovery tests, but construct the malformed state directly as corruption evidence rather than as migration fixtures.

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::fresh_current_schema_defines_image_offset_and_attachment_search -- --exact
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests::notes_history_replays_image_offset -- --exact
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
```

Expected: FAIL because the current schema, `NoteNode`/audit JSON/update inputs, FTS definitions, and image import do not yet implement the field and filename separation.

- [ ] **Step 3: Implement the fresh current schema and SQL scalar**

Enable rusqlite's existing `functions` feature and register the deterministic `notes_image_search_title` scalar on every writable connection before current-schema creation. Implement it with `validate_image_offset_utf16`; never use SQLite `substr`/`length`, whose code-point units disagree with the persisted UTF-16 offset.

Modify only the authoritative fresh `CURRENT_SCHEMA_SQL`: add the non-negative offset column, define both FTS tables with `node_id/title/note/attachment_name`, and install node/attachment triggers that call the registered scalar. Keep `CURRENT_NOTES_SCHEMA_VERSION`, `user_version` dispatch, and all version guards unchanged; do not add `ALTER TABLE`, legacy-row conversion, migration failure hooks, or runtime database deletion. Existing development databases are deleted outside the app before testing.

- [ ] **Step 4: Thread the field through every authoritative row shape**

Update `StoredNode`, workspace SELECTs, audit `NODE_JSON_NEW/OLD`, `AuditNodeRow`, replay deserialization, duplicate/copy queries, search rows, equality/stale-authority checks, and TypeScript runtime guards. `notesStore.ts:sameNoteNode` and `useNotesWorkspace.ts:samePreparedMoveNode` must compare the offset when those files compile in later tasks. Do not add the field to the derived `ExportNode` snapshot in this task; Task 13 changes its SELECTs, struct literals, and renderers together so Task 1 remains buildable.

The validator must walk Rust `char_indices`, accumulating `char.len_utf16()`, and accept only an exact scalar boundary. Do not convert the offset with byte indexes or SQLite character counts.

Change `NewImageNode` import creation to `title = ""`, `note = ""`, `image_offset_utf16 = 0`; remove `node.title == attachment.original_name` from `validate_image_node_batch_preflight`. Keep the filename only in `notes_attachments.original_name`.

- [ ] **Step 5: Run GREEN and compile fixture fallout**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
npm run build
```

Expected: PASS. Add `imageOffsetUtf16: 0` to existing TS `NoteNode` fixture factories exposed by the build; do not make the production field optional to avoid fixture edits.

- [ ] **Step 6: Commit the schema/model task**

```bash
git add src-tauri/Cargo.toml src-tauri/src/notes/schema.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/history.rs src-tauri/src/notes/types.rs src-tauri/src/notes/commands.rs src/domain/notes.ts src/services/notesStore.ts src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
git add src/features/notes/outlineTree.ts src/features/notes/useNotesWorkspace.ts
git add src/App.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesBulletMenu.test.tsx src/features/notes/NotesChildComposer.test.tsx src/features/notes/NotesExportMenu.test.tsx src/features/notes/NotesLibraryPageRow.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesMoveChooser.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesQuickJump.integration.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/imageNodeInsertion.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/notesExpansion.performance.test.ts src/features/notes/notesMoveTargets.test.ts src/features/notes/notesPresentation.test.ts src/features/notes/notesSelectionActions.test.ts src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesWorkspaceReducer.test.ts src/features/notes/outlineDrag.test.ts src/features/notes/outlineKeyboard.test.ts src/features/notes/outlineRowMemo.test.tsx src/features/notes/outlineSelectionDragSession.test.ts src/features/notes/outlineTree.test.ts src/features/notes/useNotesSelectionCommandRouter.test.tsx src/features/notes/useNotesWorkspace.test.tsx
git commit -m "feat(notes): add image atom position to schema"
```

Before committing, inspect `git diff --cached --name-only`; only the explicitly listed schema/model files and mechanical `NoteNode` fixture defaults belong in this commit.

### Task 2: Complete search classification, derived-content boundaries, and shared labels

**Files:**
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Modify: `src/features/notes/notesPresentation.ts`
- Modify: `src/features/notes/NotesQuickJump.tsx`
- Modify: `src/features/notes/NotesLibraryPageRow.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Test: `src-tauri/src/notes/repository.rs` test module
- Test: `src-tauri/src/notes/types.rs` test module
- Test: `src/domain/notes.test.ts`
- Test: `src/services/notesStore.test.ts`
- Test: `src/features/notes/notesPresentation.test.ts`
- Test: `src/features/notes/NotesQuickJump.test.tsx`
- Test: `src/features/notes/NotesQuickJump.integration.test.tsx`
- Test: `src/features/notes/NotesLibraryPageRow.test.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`

**Interfaces:**

Consume Task 1's registered deterministic scalar and canonical four-column FTS schema:

```rust
fn install_notes_sql_functions(connection: &Connection) -> Result<(), String>;

// SQL name: notes_image_search_title(title, node_kind, image_offset_utf16)
fn image_search_title(title: &str, kind: &str, offset: i64) -> Result<String, String>;
```

The current FTS5 columns are:

```sql
node_id UNINDEXED,
title,
note,
attachment_name
```

Node and attachment triggers populate `title` with `before + ' ' + after` for image nodes, raw title for text nodes, and `attachment_name` only for a valid exactly-one-attachment image node.

```rust
pub enum NoteSearchMatchedField { Title, Note, Attachment, Date }

pub struct NoteSearchResult {
    // existing fields
    pub image_offset_utf16: i64,
    pub attachment_name: Option<String>,
    pub display_label: String,
}
```

- [ ] **Step 1: Write failing FTS and derived-content tests**

Add tests proving:

- filename search returns `matchedField = attachment` and optional secondary context;
- match priority is title, then note, then attachment;
- result `title` remains raw persisted title;
- empty primary text falls back to `original_name` in result, parent trail, quick jump, breadcrumb, and library row;
- non-empty before/after segments join with one display space;
- filename tags/dates are ignored;
- `#left[atom]right` and date text split across the atom never form a token;
- after-segment date rows retain raw-title UTF-16 offsets.

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests::image_atom_search_returns_attachment_match_and_shared_label -- --exact
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/features/notes/notesPresentation.test.ts src/features/notes/NotesQuickJump.test.tsx src/features/notes/NotesLibraryPageRow.test.tsx
```

Expected: FAIL because search result DTOs omit attachment classification/filename/label fields and presentation hard-codes `Image`.

- [ ] **Step 3: Preserve the UTF-16 scalar boundary while extending queries**

Keep Task 1's scalar registered with `FunctionFlags::SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS` where supported. Query and rebuild through the canonical trigger/function path; do not duplicate the split in SQL or create a second title derivation.

Do not write this incorrect trigger expression:

```sql
substr(title, 1, image_offset_utf16) || ' ' ||
substr(title, image_offset_utf16 + 1)
```

It breaks when astral characters occur before the atom.

- [ ] **Step 4: Implement trigger maintenance and query classification**

Add node insert/update/delete triggers plus attachment insert/update/delete triggers for both active and lifecycle FTS tables. Query raw `notes_nodes.title`, offset, one owned attachment name, and server-computed `display_label`; use four-column `highlight`/`bm25` weights and explicit title/note/attachment booleans to enforce priority.

Change `search_parent_trails` to collect the same server label, not raw image title. Keep `parentTrail` as strings and `parentTrailKinds` for compatibility.

- [ ] **Step 5: Split derived parsing at the atom boundary**

Refactor `replace_tags` and `replace_dates` to accept node kind and offset. Tokenize before and after separately; add `image_offset_utf16` to after-segment raw date ranges, but do not add the logical atom unit to stored DB ranges. Supporting note remains a third independent source. Update batch add/remove-tag helpers so appending/removing image primary tags never concatenates across the atom.

- [ ] **Step 6: Use the server label in every consumer**

Update strict TS guards. Make `noteSearchPresentation` use `displayLabel` and labeled parent trails. For live workspace nodes, make `noteNodeNavigationLabel` split by offset and accept the exactly-one attachment's `originalName` as fallback; update library rows and breadcrumbs accordingly.

- [ ] **Step 7: Run GREEN and regressions**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/features/notes/notesPresentation.test.ts src/features/notes/NotesQuickJump.test.tsx src/features/notes/NotesQuickJump.integration.test.tsx src/features/notes/NotesLibraryPageRow.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: PASS with UTF-16-correct boundary indexing and one label rule everywhere.

- [ ] **Step 8: Commit the search/label task**

```bash
git add src-tauri/src/notes/repository.rs src-tauri/src/notes/types.rs src/domain/notes.ts src/services/notesStore.ts src/features/notes/notesPresentation.ts src/features/notes/NotesQuickJump.tsx src/features/notes/NotesLibraryPageRow.tsx src/features/notes/NotesOutlinePane.tsx src/domain/notes.test.ts src/services/notesStore.test.ts src/features/notes/notesPresentation.test.ts src/features/notes/NotesQuickJump.test.tsx src/features/notes/NotesQuickJump.integration.test.tsx src/features/notes/NotesLibraryPageRow.test.tsx src/features/notes/NotesWorkspace.test.tsx
git commit -m "feat(notes): index and label image atom content"
```

### Task 3: Install fingerprinted TEMP operation receipts and protected pruning

**Files:**
- Create: `src-tauri/src/notes/image_atom.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs`
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Test: `src-tauri/src/notes/image_atom.rs` test module
- Test: `src-tauri/src/notes/history.rs` test module
- Test: `src-tauri/src/notes/commands.rs` test module
- Test: `src/domain/notes.test.ts`
- Test: `src/services/notesStore.test.ts`
- Test: `src/services/notesStore.tauri.test.ts`

**Interfaces:**

```sql
CREATE TEMP TABLE notes_image_atom_operations (
  operation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  history_epoch TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  postcondition_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(operation_id) REFERENCES notes_history_entries(id) ON DELETE CASCADE
);
```

`result_json` is compact focus/affected-ID metadata only. It must not contain a workspace or bytes.

```rust
pub struct ImageAtomOperationReceiptResult {
    pub operation_id: String,
    pub history_epoch: String,
    pub postcondition_digest: String,
    pub affected_root_ids: Vec<NoteId>,
    pub focus: ImageAtomFocusResult,
}

#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImageAtomOperationLookup {
    Found { receipt: ImageAtomOperationReceiptResult },
    Missing { history_epoch: String },
    EpochMismatch { history_epoch: String },
}
```

Commands:

```text
notes_lookup_image_atom_operation(vaultPath, sessionId, historyEpoch, operationId)
notes_ack_image_atom_operation(vaultPath, sessionId, historyEpoch, operationId)
```

- [ ] **Step 1: Write failing receipt/pruning/reset tests**

Test identical lookup, conflicting fingerprint rejection, idempotent acknowledgement, epoch mismatch, reset/close deletion, and history pruning. Prove the serialized Vault queue permits at most one unacknowledged receipt, acknowledged receipts remain bounded by the same 100 retained mutation entries, and a hard-limit case with every evictable entry pinned rolls the proposed mutation back with its live rows.

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::image_atom::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests::unacknowledged_image_operation_pins_history -- --exact
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
```

Expected: FAIL because no receipt table, lookup/ack commands, or protected eviction path exists.

- [ ] **Step 3: Install receipts with the Task 0 TEMP generation**

Create the table from the same writable-connection installer that creates TEMP history. Reset, final close, explicit clear, and destructive history reset delete receipts before rotating/closing the epoch. Acknowledgement updates one row and succeeds when repeated with the same authority.

- [ ] **Step 4: Protect unresolved entries and the current entry from pruning**

Change:

```rust
fn enforce_limits(
    transaction: &Transaction<'_>,
    protected_entry_id: Option<&str>,
) -> Result<Vec<String>, String>;
```

The eviction query must exclude unacknowledged receipt IDs and `protected_entry_id`. If limits remain exceeded and no candidate exists, return an error so the caller's live mutation, history entry, and receipt all roll back. This current-entry exclusion is mandatory: otherwise a large new entry can prune itself and commit an untracked live edit.

- [ ] **Step 5: Add strict lookup/ack adapters**

Validate all IDs/epoch/session fields, register commands in `lib.rs`, add `NotesStore.lookupImageAtomOperation` and `ackImageAtomOperation`, and reject malformed discriminants/result metadata in TS validators.

- [ ] **Step 6: Run GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::image_atom::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests
cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once -- --nocapture
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
```

Expected: PASS; unresolved receipts survive ordinary capacity enforcement, acknowledged receipts prune with their history entry, and reset/close clears them.

- [ ] **Step 7: Commit the receipt task**

```bash
git add src-tauri/src/notes/image_atom.rs src-tauri/src/notes/mod.rs src-tauri/src/notes/history.rs src-tauri/src/notes/types.rs src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src-tauri/build.rs src/domain/notes.ts src/services/notesStore.ts src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
git commit -m "feat(notes): add image atom operation receipts"
```

### Task 4: Implement the byte-free image-atom edit command

**Files:**
- Modify: `src-tauri/src/notes/image_atom.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs`
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Test: `src-tauri/src/notes/image_atom.rs` test module
- Test: `src-tauri/src/notes/commands.rs` test module
- Test: `src-tauri/src/notes/history.rs` test module
- Test: `src/domain/notes.test.ts`
- Test: `src/services/notesStore.test.ts`
- Test: `src/services/notesStore.tauri.test.ts`

**Interfaces:**

```rust
pub struct LogicalSelection {
    pub anchor_utf16: i64,
    pub focus_utf16: i64,
}

pub struct ImageTargetAuthority {
    pub node_id: NoteId,
    pub expected_updated_at: String,
    pub expected_title: String,
    pub expected_image_offset_utf16: i64,
    pub expected_primary_attachment_id: String,
}

#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImageAtomEdit {
    Remove { replacement_text: String },
    Enter { sibling_id: NoteId },
}

pub struct ApplyImageAtomEditInput {
    pub target: ImageTargetAuthority,
    pub selection: LogicalSelection,
    pub edit: ImageAtomEdit,
}

pub struct ImageAtomMutationResult {
    #[serde(flatten)]
    pub mutation: NotesMutationResult,
    pub operation: ImageAtomOperationReceiptResult,
}
```

The command is `notes_apply_image_atom_edit`; the required `NotesHistoryContext.entryId` is its operation ID.

- [ ] **Step 1: Write failing edit matrix tests**

Cover atom deletion from both adjacent carets, atom-only and mixed selections, replacement plain text, before/after Enter, atom-only Enter, mixed-selection Enter, note/children/flags retention, sibling defaults/order, attachment history retention, one-step Undo/Redo, stale target rejection, invalid/mismatched attachment authority, identical retry, and conflicting operation ID reuse.

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::image_atom::tests::remove_atom_converts_image_to_text_in_one_history_entry -- --exact
cargo test --manifest-path src-tauri/Cargo.toml notes::image_atom::tests::enter_obeys_every_image_atom_split_rule -- --exact
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts
```

Expected: FAIL because image nodes still reject generic split/title mutation and no explicit command exists.

- [ ] **Step 3: Implement pure logical transformation helpers**

Normalize selection direction, clamp only after validating target logical length, and split title at the validated UTF-16 offset. Compute the post-state entirely before opening the transaction. For mixed Enter, delete the range logically first; if that removes the atom, apply the ordinary text split within this command's transaction.

Reuse `next_sort_key`, `next_sort_key_excluding`, `rebalance_siblings`, active-node requirements, derived rebuilds, and existing attachment audit triggers. Do not call the public generic split or attachment-removal commands.

- [ ] **Step 4: Own receipt and history finalization in the same transaction**

The command's mutation helper must open one IMMEDIATE transaction and perform:

```text
revalidate complete target authority
apply node/attachment/sibling rows
rebuild derived rows
load authoritative workspace
history::finalize_transaction(protected operation ID)
insert receipt using the canonical normalized fingerprint
commit
```

Do not insert the receipt after `with_history_transaction_and_prunes` returns; that would violate same-transaction idempotence. On a pre-existing identical receipt, load current authoritative workspace and return the stored compact result without changing rows. A different fingerprint for the same operation ID fails.

- [ ] **Step 5: Expose strict TS inputs/results**

Add `applyImageAtomEdit` to `NotesStore`, normalize selections and required nullable fields without casts, invoke with camelCase, and validate that the operation ID equals the history entry ID.

- [ ] **Step 6: Run GREEN and history regressions**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::image_atom::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests
cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once -- --nocapture
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
```

Expected: PASS; every gesture is one mutation/history entry and retry creates nothing twice.

- [ ] **Step 7: Commit the byte-free backend task**

```bash
git add src-tauri/src/notes/image_atom.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/types.rs src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src-tauri/build.rs src/domain/notes.ts src/services/notesStore.ts src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
git commit -m "feat(notes): apply atomic image atom edits"
```

### Task 5: Add the raw byte-paste envelope and coordinated backend paste command

**Files:**
- Modify: `src-tauri/src/notes/attachment_ingest.rs`
- Modify: `src-tauri/src/notes/attachments.rs`
- Modify: `src-tauri/src/notes/image_atom.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs`
- Modify: `src/services/notesAttachmentRawIpc.ts`
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Test: `src-tauri/src/notes/attachment_ingest.rs` test module
- Test: `src-tauri/src/notes/attachments.rs` test module
- Test: `src-tauri/src/notes/image_atom.rs` test module
- Test: `src-tauri/src/notes/commands.rs` test module
- Test: `src/services/notesAttachmentRawIpc.test.ts`
- Test: `src/domain/notes.test.ts`
- Test: `src/services/notesStore.test.ts`
- Test: `src/services/notesStore.tauri.test.ts`

**Interfaces:**

Extend the existing nine-byte raw framing with a distinct magic/version; do not JSON-encode Blob data:

```text
magic: YNAP
version: 1
u32 little-endian metadata length
strict camelCase JSON metadata
contiguous blobs in declared ordinal order
```

```ts
export type ImageAtomFragmentItem =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image";
      readonly nodeId: NoteId;
      readonly attachmentId: string;
      readonly originalName: string;
      readonly mimeType: NoteAttachment["mimeType"];
      readonly blob: Blob;
    };

export interface ApplyImageAtomPasteInput {
  readonly target: {
    readonly nodeId: NoteId;
    readonly expectedUpdatedAt: string;
    readonly expectedNodeKind: NoteNodeKind;
    readonly expectedTitle: string;
    readonly expectedImageOffsetUtf16: number;
    readonly expectedPrimaryAttachmentId: string | null;
  };
  readonly selection: LogicalSelection;
  readonly version: 1;
  readonly fragment: readonly ImageAtomFragmentItem[];
  readonly initialMaxDisplayWidth: number;
}
```

The raw metadata replaces each Blob with `ordinal` and `byteLength`. It includes the complete `NotesHistoryContext`; its entry ID is the operation ID. Command: `notes_apply_image_atom_paste`.

- [ ] **Step 1: Write failing envelope and placement tests**

Test strict keys, magic/version, explicit nullable attachment authority, source order, duplicate/cross-namespace IDs, lengths, trailing bytes, 20-MiB item/64-MiB batch/128-item limits, invalid later image atomicity, and owned-copy admission.

Backend placement cases must cover:

- one image converts a clean text target in place;
- a text target with legacy attachments remains text and receives following image siblings;
- selected image atom is replaced in place and old attachment remains history-reachable;
- an image target without atom selection remains unchanged and gets following siblings;
- multiple images produce contiguous nodes in source order;
- leading/interstitial/trailing text is distributed exactly once;
- first affected node retains ID/note/children/flags, later siblings use defaults;
- every byte is validated before row mutation;
- response-loss retry reuses all stable IDs and publishes no duplicate file.

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- src/services/notesAttachmentRawIpc.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
cargo test --manifest-path src-tauri/Cargo.toml notes::attachment_ingest::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::image_atom::tests::image_atom_paste_distributes_ordered_fragment_atomically -- --exact
```

Expected: FAIL because only `YNAB` attachment and `YNIB` independent-image envelopes exist, and current image import always creates filename-titled siblings.

- [ ] **Step 3: Decode and validate before acquiring the write transaction**

Reuse `decode_raw_body_with`, import-budget admission, `PreparedAttachmentBatch::from_bytes_with_import_permit`, and each `ValidatedImage`'s actual `content_hash`, `byte_size`, and sniffed `mime_type`. The operation fingerprint uses those backend-validated descriptors; never include a caller-supplied digest.

Make only the smallest visibility changes needed in `attachments.rs`; reuse `PreparedAttachment`, `ValidatedImage`, `AttachmentStorageLease`, and publication APIs instead of duplicating image decoding.

- [ ] **Step 4: Refactor publication primitives without calling the old command**

Extract the useful pieces from `commands.rs:import_prepared_image_node_batch` and `repository.rs:create_image_nodes_coordinated`: preflight capacity/ID/sort allocation, database identity capture, marker creation, file publication, before-commit identity check, committed reconciliation, and failed-candidate reconciliation.

The new paste path must own its IMMEDIATE transaction so row changes, history finalization, and receipt insertion share one commit. Publication remains file-before-commit:

```text
prepare/validate all blobs
capture storage/database identity
mark reconciliation needed
publish content-addressed files
open immediate transaction
revalidate target and IDs
apply complete ordered paste
finalize protected history + insert receipt
validate identity and commit
reconcile marker/candidates
```

On rollback, delete newly unreferenced candidates best effort; retain the marker if cleanup fails. Never report success for a rolled-back DB edit.

- [ ] **Step 5: Encode and invoke the raw body from the store**

Add `encodeNotesImageAtomPasteRawEnvelope`, with the same dense-array, UUID, MIME, size, metadata, and Blob-size-stability checks as the existing encoders. `notesStore.applyImageAtomPaste` invokes Tauri with the returned `Uint8Array`, then strictly validates `ImageAtomMutationResult`.

- [ ] **Step 6: Run GREEN and publication regressions**

Run:

```bash
npm test -- src/services/notesAttachmentRawIpc.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
cargo test --manifest-path src-tauri/Cargo.toml notes::attachment_ingest::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::attachments::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::image_atom::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests
cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once -- --nocapture
```

Expected: PASS; malformed or partially invalid batches leave no live rows/files, and identical retries return one receipt/result.

- [ ] **Step 7: Commit the raw paste task**

```bash
git add src-tauri/src/notes/attachment_ingest.rs src-tauri/src/notes/attachments.rs src-tauri/src/notes/image_atom.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/types.rs src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src-tauri/build.rs src/services/notesAttachmentRawIpc.ts src/domain/notes.ts src/services/notesStore.ts src/services/notesAttachmentRawIpc.test.ts src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
git commit -m "feat(notes): paste image atom bytes atomically"
```

### Task 6: Build the pure logical image-atom model

**Files:**
- Create: `src/features/notes/imageAtomModel.ts`
- Create: `src/features/notes/imageAtomModel.test.ts`

**Interfaces:**

```ts
export interface LogicalSelection {
  readonly anchorUtf16: number;
  readonly focusUtf16: number;
}

export interface ImagePrimaryValue {
  readonly title: string;
  readonly imageOffsetUtf16: number;
}

export interface ImagePrimarySegments {
  readonly beforeText: string;
  readonly afterText: string;
}

export function validateImagePrimary(value: ImagePrimaryValue): ImagePrimarySegments;
export function joinImagePrimary(segments: ImagePrimarySegments): ImagePrimaryValue;
export function imageLogicalLength(value: ImagePrimaryValue): number;
export function normalizeLogicalSelection(value: ImagePrimaryValue, selection: LogicalSelection): LogicalSelection;
export function logicalToRawOffset(value: ImagePrimaryValue, logicalOffset: number, affinity: "before" | "after"): number;
export function applyImageLogicalTextEdit(value: ImagePrimaryValue, selection: LogicalSelection, replacement: string): { value: ImagePrimaryValue; selection: LogicalSelection; removesAtom: boolean };
```

- [ ] **Step 1: Write the complete failing model table**

Cover empty/non-empty sides, forward/backward ranges, both adjacent atom carets, atom-only/mixed containment, insertion before/after, deletion entirely on each side, replacement across atom, emoji/surrogate boundaries, combining marks, and selection clamping. Combining marks may have interior caret positions because the contract is UTF-16, while surrogate pairs may not.

- [ ] **Step 2: Run RED**

Run: `npm test -- src/features/notes/imageAtomModel.test.ts`

Expected: FAIL because the new module does not exist.

- [ ] **Step 3: Implement with string slices only after boundary validation**

Use JavaScript string indices as UTF-16 offsets, but explicitly reject an offset between a high and low surrogate before calling `slice`. Treat the atom as logical interval `[imageOffsetUtf16, imageOffsetUtf16 + 1]`; raw after-text offsets subtract one logical unit.

Keep the module DOM-free, React-free, and side-effect-free. It is the shared semantics for the mapper, clipboard controller, optimistic selection, and frontend prevalidation—not a second backend authority.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- src/features/notes/imageAtomModel.test.ts`

Expected: PASS for every table row and reverse selection.

- [ ] **Step 5: Commit the logical model**

```bash
git add src/features/notes/imageAtomModel.ts src/features/notes/imageAtomModel.test.ts
git commit -m "feat(notes): model image atom selections"
```

### Task 7: Map DOM ranges to logical offsets and extend history focus snapshots

**Files:**
- Create: `src/features/notes/imageAtomDomSelection.ts`
- Create: `src/features/notes/imageAtomDomSelection.test.ts`
- Modify: `src/features/notes/notesHistory.ts`
- Test: `src/features/notes/notesHistory.test.ts`

**Interfaces:**

```ts
export interface ImageAtomDomRegions {
  readonly host: HTMLElement;
  readonly before: HTMLElement;
  readonly atom: HTMLElement;
  readonly after: HTMLElement;
}

export function readImageAtomDomSelection(
  regions: ImageAtomDomRegions,
  selection: Selection
): LogicalSelection | null;

export function writeImageAtomDomSelection(
  regions: ImageAtomDomRegions,
  logical: LogicalSelection,
  selection: Selection
): void;
```

```ts
export interface NotesHistoryPrimarySelection {
  readonly anchorUtf16: number;
  readonly focusUtf16: number;
}

export interface NotesHistoryFocus {
  nodeId: NoteId;
  field: NotesHistoryFocusField;
  primarySelection?: NotesHistoryPrimarySelection;
}
```

- [ ] **Step 1: Write failing DOM and clone tests**

Use real JSDOM `Range`/`Selection` fixtures for empty regions, nested text nodes, before/after endpoints, image descendants, reverse ranges, rerendered text nodes, emoji, caret aids, and invalid external DOM positions. Assert invalid positions normalize to the nearest legal logical boundary and never produce DOM text as data.

In `notesHistory.test.ts`, mutate a caller-owned selection after snapshot capture and prove replay retained a deep clone.

- [ ] **Step 2: Run RED**

Run: `npm test -- src/features/notes/imageAtomDomSelection.test.ts src/features/notes/notesHistory.test.ts`

Expected: FAIL because no mapper exists and `cloneLocation` currently shallow-copies focus.

- [ ] **Step 3: Implement region-marker-based mapping**

The mapper may inspect only the three provided stable region roots and known caret-aid markers. Compute text length by walking text descendants of the relevant editable region; map anything in the non-editable atom to its before/after boundary based on endpoint affinity. Ignore `NoteTokenText` overlays and image descendants.

Writing a range creates fresh DOM points from logical offsets after React commits. Preserve anchor/focus direction with `Selection.setBaseAndExtent` when available and a Range fallback otherwise.

- [ ] **Step 4: Deep-clone optional history selection**

Keep `field` as `title | note`; add selection only for structural image operations. Update `cloneLocation`/`cloneSnapshot` to copy the nested object. Do not add ranges to ordinary text-burst snapshots.

- [ ] **Step 5: Run GREEN**

Run: `npm test -- src/features/notes/imageAtomDomSelection.test.ts src/features/notes/notesHistory.test.ts`

Expected: PASS with stable forward/backward mapping and immutable snapshots.

- [ ] **Step 6: Commit mapper/history shape**

```bash
git add src/features/notes/imageAtomDomSelection.ts src/features/notes/imageAtomDomSelection.test.ts src/features/notes/notesHistory.ts src/features/notes/notesHistory.test.ts
git commit -m "feat(notes): map image atom DOM selections"
```

### Task 8: Create the composition-safe `ImageAtomEditor` and draft flush adapter

**Files:**
- Create: `src/features/notes/ImageAtomEditor.tsx`
- Create: `src/features/notes/ImageAtomEditor.test.tsx`
- Create: `src/features/notes/notesImageAtomEditorRegistry.ts`
- Create: `src/features/notes/notesImageAtomEditorRegistry.test.ts`
- Modify: `src/features/notes/notesDraftEngine.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/notes.css`
- Test: `src/features/notes/notesDraftEngine.test.ts`
- Test: `src/features/notes/useNotesWorkspace.test.tsx`

**Interfaces:**

```ts
export interface ImageAtomEditorHandle {
  focus(selection?: LogicalSelection): void;
  restoreSelection(selection: LogicalSelection): void;
  flush(): Promise<"flushed" | "deferred" | "cancelled">;
  containsAtomSelection(): boolean;
}

export interface NotesImageAtomFlushAdapter {
  readonly nodeId: NoteId;
  flush(): Promise<"flushed" | "deferred" | "cancelled">;
}

export interface NotesImageAtomEditorRegistry {
  register(editor: ActiveImageAtomEditor): () => void;
  active(): ActiveImageAtomEditor | null;
  flushAll(): Promise<boolean>;
  claimPaste(event: ClipboardEvent): boolean;
}
```

`ImageAtomEditor` receives the complete draft triple, exactly one attachment, `today`/tag/date presentation callbacks, structural edit callbacks, clipboard callbacks, and `readOnly`/`disabled`. It composes `NotesImageNodeContent` inside the atom region.

- [ ] **Step 1: Write failing render/input/IME tests**

Test one `role=textbox` host with stable before/atom/after region nodes, vertical layout, legal empty carets, type-before/type-after offset updates, Left/Right atom crossing, Shift+Arrow atom selection, Shift+Up/Down range preservation, click/drag selection, `insertReplacementText`, blocked paragraph/linebreak/HTML, Notes Undo routing, drop ownership, and unexpected MutationObserver reset.

IME tests must render `ㅎ -> 하 -> 한`, assert no controlled rerender/draft write during composition, map exactly once on `compositionend`, defer blur flush, and cancel an unmount/OS-interrupted structural action instead of scraping partial DOM.

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- src/features/notes/ImageAtomEditor.test.tsx src/features/notes/notesImageAtomEditorRegistry.test.ts src/features/notes/notesDraftEngine.test.ts
```

Expected: FAIL because the files/flush registry do not exist and drafts contain only `title`/`note`.

- [ ] **Step 3: Expand drafts to the complete triple**

Change every draft/attempt/failure patch type from `Pick<NoteNode, "title" | "note">` to `Pick<NoteNode, "title" | "note" | "imageOffsetUtf16">`. Text-node callers always pass zero. `persistDraftMutation` sends the full triple.

Add registration methods to `NotesDraftEngine`; at the start of `flushNodeDraft`/`flushAllDrafts`, flush matching active DOM adapters before reserving DB attempts. A `deferred` composition waits for `compositionend`; a `cancelled` adapter returns `false` so `runStructuralCommand` reports through the existing bottom bar.

- [ ] **Step 4: Implement controlled DOM ownership**

Use one contenteditable host with stable keyed children:

```tsx
<div role="textbox" aria-multiline="true" contentEditable={!readOnly}>
  <span data-image-atom-region="before">{beforeText}</span>
  <span data-image-atom-region="atom" contentEditable={false}>
    <NotesImageNodeContent
      nodeId={nodeId}
      attachment={attachment}
      contentRef={atomContentRef}
      readOnly={readOnly}
      disabled={disabled}
    />
  </span>
  <span data-image-atom-region="after">{afterText}</span>
</div>
```

Empty-region caret aids are `aria-hidden`/marked and excluded by the mapper. Suspend controlled projection and MutationObserver enforcement during composition; on end, read once, update draft once, restore mapped selection, then re-enable validation.

Handle supported `beforeinput` types explicitly and `preventDefault`; reset any unsupported mutation to the latest authoritative draft. Route Enter/atom deletion through callbacks rather than editing DOM structurally.

- [ ] **Step 5: Reuse presentation parsing separately per segment**

Use `NoteTokenText` independently for before and after resting overlays and `resolveInlineFormatShortcut`/`toggleInlineFormat` only within one text segment. Never pass merged title through a tokenizer/Markdown formatter. Translate after-segment date selection to raw title offsets before opening the existing picker.

- [ ] **Step 6: Run GREEN and focused regressions**

Run:

```bash
npm test -- src/features/notes/ImageAtomEditor.test.tsx src/features/notes/notesImageAtomEditorRegistry.test.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NoteTextField.test.tsx src/features/notes/NoteTokenText.test.tsx src/features/notes/inlineFormat.test.ts
```

Expected: PASS; text-node textarea behavior is unchanged and IME never persists intermediate jamo.

- [ ] **Step 7: Commit the editor core**

```bash
git add src/features/notes/ImageAtomEditor.tsx src/features/notes/ImageAtomEditor.test.tsx src/features/notes/notesImageAtomEditorRegistry.ts src/features/notes/notesImageAtomEditorRegistry.test.ts src/features/notes/notesDraftEngine.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/notesCommands.ts src/features/notes/notes.css
git commit -m "feat(notes): add composition-safe image atom editor"
```

### Task 9: Build bounded image-atom clipboard serialization and shared byte prewarm

**Files:**
- Create: `src/features/notes/notesImageAtomClipboard.ts`
- Create: `src/features/notes/notesImageAtomClipboard.test.ts`
- Modify: `src/features/notes/notesClipboard.ts`
- Modify: `src/features/notes/notesClipboardImages.ts`
- Modify: `src/features/notes/NotesImageResidencyContext.tsx`
- Modify: `src/features/notes/NotesImageAttachment.tsx`
- Test: `src/features/notes/notesClipboard.test.ts`
- Test: `src/features/notes/notesClipboardImages.test.ts`
- Test: `src/features/notes/NotesImageResidencyContext.test.tsx`
- Test: `src/features/notes/NotesImageAttachment.test.tsx`

**Interfaces:**

```ts
export interface NotesImageAtomClipboardV1 {
  readonly version: 1;
  readonly kind: "notes-image-atom";
  readonly beforeText: string;
  readonly afterText: string;
  readonly image: {
    readonly originalName: string;
    readonly mimeType: NoteAttachment["mimeType"];
    readonly byteSize: number;
    readonly contentHash: string;
  };
}

export interface ParsedImageAtomPaste {
  readonly version: 1;
  readonly fragment: readonly (
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "image"; readonly source: ClipboardImageDescriptor }
  )[];
}
```

Use one versioned custom flavor constant and one versioned escaped `text/html` data attribute. The HTML image data-URL representation is capped at 32 MiB.

Extend image residency with attachment-ID-keyed ephemeral bytes:

```ts
interface NotesImageByteLease {
  prewarm(attachmentId: string, load: () => Promise<Uint8Array>): Promise<Uint8Array>;
  read(attachmentId: string): Uint8Array | null;
  release(attachmentId: string): void;
}
```

- [ ] **Step 1: Write failing clipboard format and sanitizer tests**

Cover text-only/image-only/mixed serialization, custom flavor support detection, one `ClipboardItem`, plain fallback text, HTML escaping, data URL, native image MIME, async write rejection, synchronous byte-carrying HTML fallback, metadata-only fallback, 32-MiB omission, and memory release.

Paste tests cover valid custom marker, valid HTML marker, OS-transcoded native flavor ignored in favor of matching HTML bytes, mismatched hash/length/MIME rejection without loose fallback, external File/Blob, sanitized mixed HTML, multiple ordered images, remote URL rejection, script/style/event removal, unsupported MIME, and whole-batch limit rejection.

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- src/features/notes/notesImageAtomClipboard.test.ts src/features/notes/NotesImageResidencyContext.test.tsx src/features/notes/NotesImageAttachment.test.tsx
```

Expected: FAIL because no atom payload/controller exists and the current residency context tracks only eight opaque active entries, not shared bytes.

- [ ] **Step 3: Add byte sharing to the existing residency owner**

Refactor `NotesImageAttachment` to obtain validated loaded bytes through the context lease before creating its local object URL. The editor's atom-selection prewarm calls the same keyed loader, so a visible image is not read twice. Deduplicate concurrent loads, bound entries by the existing active-residency policy, and clear all raw references on lease release/scope disposal.

Do not retain base64 or Blob values in React state. `NotesImageAttachment` may retain only its object URL as today; clipboard settlement owns and releases its temporary Blob/data URL.

- [ ] **Step 4: Implement exact byte binding and HTML sanitation**

Use `crypto.subtle.digest("SHA-256", bytes)` and supported-format magic sniffing for PNG/JPEG/GIF/WebP before accepting an internal carrier. Check declared MIME, length, and lowercase hash together. Use DOMPurify for untrusted HTML, then walk the sanitized DOM in source order; accept only `data:` image sources, never HTTP(S), file, blob, or relative fetches.

An invalid internal marker is an atomic rejection and must not be reinterpreted as an external image. External unmarked HTML may produce ordered text/image fragment items.

- [ ] **Step 5: Implement copy/cut settlement primitives**

Freeze attachment identity, epoch, node authority, draft generation, and logical selection before async write. Return a structured settlement indicating whether bytes were actually carried. Cut callers may delete only after `kind = success` and `carriesImageBytes = true`; metadata-only fallback is copy-only.

- [ ] **Step 6: Run GREEN**

Run:

```bash
npm test -- src/features/notes/notesImageAtomClipboard.test.ts src/features/notes/notesClipboard.test.ts src/features/notes/notesClipboardImages.test.ts src/features/notes/NotesImageResidencyContext.test.tsx src/features/notes/NotesImageAttachment.test.tsx
```

Expected: PASS; exact bytes round-trip internally and externally, while failed/stale writes leave source content untouched and release memory.

- [ ] **Step 7: Commit clipboard primitives and byte prewarm**

```bash
git add src/features/notes/notesImageAtomClipboard.ts src/features/notes/notesImageAtomClipboard.test.ts src/features/notes/notesClipboard.ts src/features/notes/notesClipboard.test.ts src/features/notes/notesClipboardImages.ts src/features/notes/notesClipboardImages.test.ts src/features/notes/NotesImageResidencyContext.tsx src/features/notes/NotesImageResidencyContext.test.tsx src/features/notes/NotesImageAttachment.tsx src/features/notes/NotesImageAttachment.test.tsx
git commit -m "feat(notes): serialize image atom clipboard data"
```

### Task 10: Delegate image commands through `notesCommands` and settle unknown receipts in the coordinator turn

**Files:**
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts`
- Modify: `src/features/notes/notesImageAtomEditorRegistry.ts`
- Modify: `src/features/notes/ImageAtomEditor.tsx`
- Test: `src/features/notes/useNotesWorkspace.test.tsx`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Test: `src/features/notes/notesImageAtomEditorRegistry.test.ts`
- Test: `src/features/notes/ImageAtomEditor.test.tsx`

**Interfaces:**

Add to `NotesWorkspaceActions`:

```ts
applyImageAtomEdit(
  nodeId: NoteId,
  selection: LogicalSelection,
  edit: ImageAtomEdit
): Promise<NotesWorkspaceCommandOutcome>;

applyImageAtomPaste(
  nodeId: NoteId,
  selection: LogicalSelection,
  fragment: ParsedImageAtomPaste
): Promise<NotesWorkspaceCommandOutcome>;
```

Create `applyImageAtomEditCommand` and `applyImageAtomPasteCommand` in `notesCommands.ts`. They consume the current confirmed row/attachment authority, stable IDs generated before the first invoke, the current epoch-bound history context, and the active editor selection.

- [ ] **Step 1: Write failing delegation and unknown-outcome tests**

Assert the hook delegates through `notesCommands.ts` and `runStructuralCommand`, not direct repository calls. Test:

1. response lost after commit -> lookup found -> apply result -> ack;
2. lookup missing in same epoch -> resend exact operation/IDs -> ack;
3. lookup fingerprint/result mismatch -> failure, no automatic retry;
4. epoch changed -> reload live rows and clear mixed history;
5. exact post-state -> committed but Undo lost;
6. exact pre-state -> uncommitted, eligible only for a newly offered operation ID;
7. other state -> ambiguous conflict;
8. later mutation/navigation/replay waits until settlement;
9. final close performs one lookup/reconciliation pass.

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- src/features/notes/useNotesWorkspace.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesImageAtomEditorRegistry.test.ts src/features/notes/ImageAtomEditor.test.tsx
```

Expected: FAIL because current structural commands have no receipt settlement and unknown repository rejection releases the queue as failure.

- [ ] **Step 3: Add one receipt-settlement helper inside a structural queue work item**

The helper runs inside the promise passed to `session.enqueueStructural`; it must not create a second queue. Pseudocode:

```ts
try {
  result = await sendExactOperation();
} catch (cause) {
  const lookup = await repository.lookupImageAtomOperation(vault, authority);
  if (lookup.kind === "found") result = await materializeReceiptResult(lookup);
  else if (lookup.kind === "missing" && lookup.historyEpoch === expectedEpoch) {
    result = await sendExactOperation();
  } else {
    return reconcileGenerationLossOrAmbiguity(lookup, authority);
  }
}
const projected = await projectNotesMutation(context, result.mutation, scope);
rememberHistoryAfter(historyContext, projected.workspace, focusFrom(result));
await repository.ackImageAtomOperation(vault, receiptAuthority(result));
return directMutationResult(result.mutation, projected, focusUiUpdate(result));
```

Do not acknowledge before the authoritative workspace and mixed timeline entry are applied. Do not release the queue between lookup and resend.

- [ ] **Step 4: Capture deterministic pre/post authority**

Store only IDs, hashes, expected target fields, and postcondition digest in the in-flight command object. On epoch loss, reload authoritative active rows and compare exact expected pre-state/post-state. Never infer commitment from only node existence or `updatedAt`.

- [ ] **Step 5: Wire the editor registry to action callbacks**

The active editor supplies its latest normalized selection only after its flush adapter succeeds. Generate sibling/node/attachment UUIDs once before entering `runStructuralCommand`; every resend reuses them. Plain text over an atom uses byte-free edit; any fragment containing image bytes uses raw paste.

- [ ] **Step 6: Run GREEN and queue regressions**

Run:

```bash
npm test -- src/features/notes/useNotesWorkspace.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesImageAtomEditorRegistry.test.ts src/features/notes/ImageAtomEditor.test.tsx
```

Expected: PASS; one structural turn covers send/lookup/retry/apply/ack and no later action overtakes it.

- [ ] **Step 7: Commit command delegation and receipt settlement**

```bash
git add src/features/notes/notesCommands.ts src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesImageAtomEditorRegistry.ts src/features/notes/notesImageAtomEditorRegistry.test.ts src/features/notes/ImageAtomEditor.tsx src/features/notes/ImageAtomEditor.test.tsx
git commit -m "feat(notes): settle image atom operations safely"
```

### Task 11: Integrate the editor into rows, headers, pointer selection, and clipboard precedence

**Files:**
- Modify: `src/features/notes/OutlineNodeRow.tsx`
- Modify: `src/features/notes/NotesPageHeader.tsx`
- Modify: `src/features/notes/NotesOutlinePane.tsx`
- Modify: `src/features/notes/NotesImageAttachment.tsx`
- Modify: `src/features/notes/NotesImageMenu.tsx`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/notes.css`
- Test: `src/features/notes/NotesWorkspace.test.tsx`
- Test: `src/features/notes/NotesPageHeader.test.tsx`
- Test: `src/features/notes/NotesAttachmentIngest.test.tsx`
- Test: `src/features/notes/NotesImageAttachment.test.tsx`
- Test: `src/features/notes/NotesImageMenu.test.tsx`
- Test: `src/features/notes/outlineRowMemo.test.tsx`

**Interfaces:**

Add exactly one native-selection exception marker:

```html
data-notes-native-selection-surface="true"
```

Editable before/after regions and the non-control image body carry it. Menu buttons, resize handles, links, lightbox gestures, and the bullet drag activator do not.

Clipboard precedence is enforced by the active editor registry:

```text
atom-containing editor selection
native text-only editor selection
existing whole-row/multi-row controller
pane targetless image ingest
```

- [ ] **Step 1: Write failing row/header/pane integration tests**

Test before/image/after vertical order in both contexts, same keyboard/paste behavior, lazy loading/resize/menu/lightbox/download/view-original preservation, damaged image recovery without primary editor, and text-row memoization.

Pointer tests cover atom click, Shift-click, drag anchoring at nearest boundary, native selection across the atom, promotion to the existing node-ID row range on entering another row, clearing native range once, and nested controls remaining interactive.

Paste tests prove the pane capture asks `registry.claimPaste(event)` before inspecting image files; editor-owned paste never reaches `importClipboardImages`, while targetless paste still uses the existing fallback.

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/NotesImageMenu.test.tsx src/features/notes/outlineRowMemo.test.tsx
```

Expected: FAIL because row/header render only `NotesImageNodeContent`, `.notes-image-node-content` is broadly interactive, and pane capture owns image-file paste first.

- [ ] **Step 3: Replace only the valid image-node primary renderer**

In `OutlineNodeRow` and `NotesPageHeader`, render `ImageAtomEditor` when the node is image and exactly one primary attachment exists. Pass the draft triple and existing tag/date/image actions. Keep the current `NotesImageNodeContent` recovery presentation for zero/multiple/missing/corrupt attachment state, with no editable host.

Do not replace `NoteTextField` for text nodes or supporting notes.

- [ ] **Step 4: Narrow pointer handoff semantics**

Update `isOutlineSelectionInteractiveTarget` to return false for the closest marked native surface unless the target is inside a nested real control. Extend `isOutlineSelectionTextSurface` to accept image editor surfaces. Pane pointer promotion maps anchor/head row IDs, includes crossed rows, clears the native range once, and never invokes the dnd-kit row mover except through the bullet activator.

- [ ] **Step 5: Change the image content menu from row deletion to atom removal**

`NotesImageNodeContent` currently binds its Delete menu to `actions.deleteNode` and confirms whole-row trash. Replace that content action with `actions.applyImageAtomEdit(...Remove...)`, label it **Remove image**, and keep the ordinary row menu's **Move to Trash** unchanged. Damaged recovery rows do not offer unsafe atom removal.

- [ ] **Step 6: Run GREEN and integration regressions**

Run:

```bash
npm test -- src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/NotesImageMenu.test.tsx src/features/notes/outlineRowMemo.test.tsx
```

Expected: PASS; both image presentations use one editor contract, controls still work, and global ingest never races editor replacement.

- [ ] **Step 7: Commit UI integration**

```bash
git add src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/NotesOutlinePane.tsx src/features/notes/NotesImageAttachment.tsx src/features/notes/NotesImageMenu.tsx src/features/notes/useNotesWorkspace.ts src/features/notes/notes.css src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/NotesAttachmentIngest.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/NotesImageMenu.test.tsx src/features/notes/outlineRowMemo.test.tsx
git commit -m "feat(notes): integrate image atom editing surfaces"
```

### Task 12: Restore logical selections through Undo/Redo and structural conversion

**Files:**
- Modify: `src/features/notes/notesHistory.ts`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Modify: `src/features/notes/NoteTextField.tsx`
- Modify: `src/features/notes/ImageAtomEditor.tsx`
- Test: `src/features/notes/notesHistory.test.ts`
- Test: `src/features/notes/useNotesWorkspace.test.tsx`
- Test: `src/features/notes/NoteTextField.test.tsx`
- Test: `src/features/notes/ImageAtomEditor.test.tsx`

**Interfaces:**

Image structural commands capture `primarySelection` in both before and after `NotesHistorySnapshot.focus`. Text-node values are raw title UTF-16 positions; image-node values are logical offsets including the one-unit atom.

- [ ] **Step 1: Write failing replay-selection tests**

Cover:

- atom deletion Undo restores atom-only selection, Redo restores text caret;
- mixed deletion restores reverse selection direction;
- before/after Enter restores source/result carets;
- text-to-image paste captures the textarea range before conversion and atom-only selection after conversion;
- image replacement Undo/Redo restores old/new atom selection;
- a missing node and stale offset normalize to nearest collapsed caret;
- ordinary text bursts still omit `primarySelection`;
- focus restoration occurs after textarea/contenteditable DOM commit.

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- src/features/notes/notesHistory.test.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NoteTextField.test.tsx src/features/notes/ImageAtomEditor.test.tsx
```

Expected: FAIL because snapshots know only node/field and replay focuses controls without restoring ranges.

- [ ] **Step 3: Capture selections only at structural boundaries**

Before command admission, query the registered active editor or current title textarea and write a cloned selection into the before snapshot. Use the backend result focus selection for the after snapshot. Do not mutate the existing text-burst creation path.

- [ ] **Step 4: Restore after render commit**

Extend the pending focus state with an optional primary selection. `NoteTextField` restores raw offsets through its existing ref after reveal/layout; `ImageAtomEditor` calls the DOM mapper after its region refs contain the authoritative draft. Clamp missing/stale values with the pure model and clear the pending request exactly once.

- [ ] **Step 5: Run GREEN**

Run:

```bash
npm test -- src/features/notes/notesHistory.test.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NoteTextField.test.tsx src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesWorkspace.test.tsx
```

Expected: PASS; one Undo/Redo changes both content and its exact logical selection.

- [ ] **Step 6: Commit selection-aware replay**

```bash
git add src/features/notes/notesHistory.ts src/features/notes/notesHistory.test.ts src/features/notes/notesCommands.ts src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NoteTextField.tsx src/features/notes/NoteTextField.test.tsx src/features/notes/ImageAtomEditor.tsx src/features/notes/ImageAtomEditor.test.tsx
git commit -m "feat(notes): restore image atom selections on replay"
```

### Task 13: Export before/image/after order to Markdown and PDF

**Files:**
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/export.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Test: `src-tauri/src/notes/export.rs` test module
- Test: `src-tauri/src/notes/commands.rs` test module

**Interfaces:**

`ExportNode` carries `image_offset_utf16`. `load_export_snapshot` returns raw title/offset and exactly one image attachment for valid image nodes.

Canonical Markdown for non-empty before and after text is:

```markdown
- [ ] Above <!-- yonalist-node-id: NODE_ID -->
  ![Image](assets/0001.png) <!-- yonalist-attachment-original-name: photo.png -->
  Below
  > Source
```

When before text is empty, keep the current image-on-checkbox-line representation with the node ID marker. When after text is empty, omit its continuation line.

- [ ] **Step 1: Write failing Markdown/PDF order tests**

Add cases for all four empty/non-empty segment combinations, multiline escaping, supporting-note newlines, children indentation, original-name percent encoding, deduplicated attachment assets, emoji before offset, and root image nodes.

PDF tests extract text/placed image order and assert before text precedes the image, after text follows it, supporting note follows after text, child content follows the parent block, and image alt text remains the attachment filename.

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests::markdown_image_atom_preserves_before_after_note_and_children -- --exact
cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests::pdf_image_atom_places_primary_segments_around_image -- --exact
```

Expected: FAIL because `render_node_with_assets` emits only the image checkbox line and note, while `prepare_pdf_blocks` emits only image plus note.

- [ ] **Step 3: Split export title with the shared Rust UTF-16 helper**

Validate `ExportNode` ownership and offset before rendering. Reuse current `escape_inline`, `escape_markdown`, `escape_markdown_alt`, `percent_encode_markdown_comment_metadata`, and asset-link allocation. Do not insert U+FFFC into export text.

For Markdown, keep one list item/checkbox/node ID; continuation image/after lines use `depth + 1` indentation but are not child bullets. Supporting quote lines remain after primary content.

- [ ] **Step 4: Refactor PDF prepared blocks to preserve semantic order**

Prepare image-node blocks as before-text row lines, image block, after-text row lines, and note lines. Reuse date-display formatting separately for each raw title segment; translate spans into segment-local ranges before rendering. Keep existing pagination, image memory budget, alt properties, sizing, and deduplicated XObjects.

- [ ] **Step 5: Run GREEN and export command regressions**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests
```

Expected: PASS; one exported outline item preserves before/image/after/note/children in Markdown and PDF.

- [ ] **Step 6: Commit export support**

```bash
git add src-tauri/src/notes/types.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/export.rs src-tauri/src/notes/commands.rs
git commit -m "feat(notes): export image atom primary content"
```

### Task 14: Create the missing Notes Markdown import parser and typed command

**Current-code gap and scope decision:** There is no Notes Markdown import implementation on main. `src-tauri/src/notes/export.rs` only writes Markdown; `notes_import_subtree` imports a plain text-only forest; `vaultStore`'s Markdown parser belongs to a different Vault-file feature. This task therefore creates a parser and callable Notes store command rather than claiming to modify an existing parser. The approved image-atom design does not define a new visible file-picker location, so this plan exposes the typed backend/store import boundary and proves round trips; it does not add an unrelated toolbar UX.

**Files:**
- Create: `src-tauri/src/notes/markdown_import.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/notes/types.rs`
- Modify: `src-tauri/src/notes/attachments.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs`
- Modify: `src/domain/notes.ts`
- Modify: `src/services/notesStore.ts`
- Test: `src-tauri/src/notes/markdown_import.rs` test module
- Test: `src-tauri/src/notes/commands.rs` test module
- Test: `src/domain/notes.test.ts`
- Test: `src/services/notesStore.test.ts`
- Test: `src/services/notesStore.tauri.test.ts`

**Interfaces:**

```rust
pub struct ImportNotesMarkdownInput {
    pub source_path: String,
    pub parent_id: Option<NoteId>,
    pub after_id: Option<NoteId>,
}

pub struct ParsedMarkdownNode {
    pub title: String,
    pub image_offset_utf16: i64,
    pub note: String,
    pub completed: bool,
    pub image: Option<ParsedMarkdownImage>,
    pub children: Vec<ParsedMarkdownNode>,
}

pub(crate) fn parse_notes_markdown(
    source: &str,
) -> Result<Vec<ParsedMarkdownNode>, String>;
```

Command: `notes_import_markdown(vaultPath, input, historyContext) -> NotesMutationResult`. `importedRootIds` returns fresh backend-generated root IDs in source order. The source file path and asset directory never enter persisted node/receipt data.

- [ ] **Step 1: Write failing pure parser round-trip tests**

Feed exact output from Task 13 into the parser. Cover:

- current image-on-checkbox-marker form;
- before/image/after continuation form;
- empty before/after text;
- quoted multiline supporting note;
- nested child bullets after the continuation block;
- completed checkbox;
- percent-decoded original filename;
- escaped primary text;
- malformed duplicate image lines, missing node marker, unsupported frontmatter version, and continuation indentation rejection.

Assert one parsed image node, exact title, exact UTF-16 offset, note, completion, image link/name, and child hierarchy.

- [ ] **Step 2: Run parser RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::markdown_import::tests`

Expected: FAIL because `markdown_import.rs` does not exist.

- [ ] **Step 3: Implement a bounded line parser for the canonical Notes format**

Parse only `kind: yonalist-notes-export`, `format_version: 1` documents and the two canonical image forms. Use indentation/checkbox/node-marker grammar, not a general Markdown renderer DOM. Bound file bytes, node count, depth, field bytes, and attachment count with existing Notes constants.

Node-ID comments identify list-item boundaries but are not reused as database IDs. Generate fresh node and attachment UUIDs during import so cross-Vault and same-Vault imports cannot collide.

- [ ] **Step 4: Resolve and validate assets safely**

Resolve relative links beneath the Markdown file's parent directory only. Reject absolute paths, `..`, symlinks that escape the held parent, remote URLs, unsupported extensions/MIME, missing/corrupt bytes, and metadata/decoded MIME mismatches. Reuse `PreparedAttachmentBatch`, decoded-image limits, content hashes, and `AttachmentStorageLease` publication rather than the export decoder.

Read and validate every referenced asset before beginning row mutation. One bad asset rejects the whole import.

- [ ] **Step 5: Import the complete forest as one history entry**

Add a repository helper that inserts text/image nodes in parsed order with fresh IDs, title/offset/note/completion, default collapse/star state, and child hierarchy. Publish files file-before-commit and use the same reconciliation marker/identity discipline as Task 5. In one IMMEDIATE transaction insert all rows/attachments, rebuild derived content, finalize history, load workspace, and commit.

- [ ] **Step 6: Expose and validate the typed store command**

Add `ImportNotesMarkdownInput` and `NotesStore.importMarkdown`; implement camelCase invoke/strict result validation in `notesStore.ts`, register the command in `lib.rs`, and assert malformed inputs/results reject. This is the concrete import entry point for the approved round-trip contract; no new visible UI is implied.

- [ ] **Step 7: Run GREEN and round-trip integration**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::markdown_import::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests
cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once -- --nocapture
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
```

Expected: PASS; both old and new exported image forms import as one image bullet with exact offset/note/children, fresh IDs, validated owned bytes, and one Undo entry.

- [ ] **Step 8: Commit Markdown import support**

```bash
git add src-tauri/src/notes/markdown_import.rs src-tauri/src/notes/mod.rs src-tauri/src/notes/types.rs src-tauri/src/notes/attachments.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/commands.rs src-tauri/src/lib.rs src-tauri/build.rs src/domain/notes.ts src/services/notesStore.ts src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts
git commit -m "feat(notes): import image atom markdown"
```

### Task 15: Finish accessibility, full verification, and desktop proof

**Files:**
- Modify only if a focused RED test exposes a defect: `src/features/notes/ImageAtomEditor.tsx`
- Modify only if a focused RED test exposes a defect: `src/features/notes/NotesImageAttachment.tsx`
- Modify only if a focused RED test exposes a defect: `src/features/notes/NotesImageMenu.tsx`
- Modify only if a focused RED test exposes a defect: `src/features/notes/OutlineNodeRow.tsx`
- Modify only if a focused RED test exposes a defect: `src/features/notes/NotesPageHeader.tsx`
- Modify only if a focused RED test exposes a defect: `src/features/notes/notes.css`
- Test: `src/features/notes/ImageAtomEditor.test.tsx`
- Test: `src/features/notes/NotesImageAttachment.test.tsx`
- Test: `src/features/notes/NotesImageMenu.test.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`
- Test: `src/features/notes/NotesPageHeader.test.tsx`

**Accessibility interface:**

- The editor exposes a named `role="textbox"`, `aria-multiline="true"`, and the correct read-only state.
- The image atom exposes a named group using `originalName`; its `img` alt text is the filename and resize/menu/lightbox controls remain nested, named controls.
- Atom selection has a visible non-color-only distinction from an ordinary text caret or range.
- When the atom alone is selected, `F6` enters the image group, `Tab` follows the existing control order, and `Escape` returns the exact logical atom selection to the editor.
- `Shift+F10` and the `ContextMenu` key open the image menu for the selected atom.
- Row selection, atom selection, and focused nested controls remain visibly and semantically distinct in both outline rows and the page header.

- [ ] **Step 1: Complete focused accessibility RED coverage**

Add or finish tests for every interface bullet above in the five existing test files. Include keyboard-only operation, restored focus after menu close, disabled/read-only behavior, and the header/row parity case.

- [ ] **Step 2: Run the focused tests and record RED honestly**

Run:

```bash
npm test -- src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/NotesImageMenu.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx
```

Expected: new assertions fail only where the implemented contract is incomplete. If every new assertion is already green, make no production edit and proceed to Step 4.

- [ ] **Step 3: Make the smallest accessibility correction and run GREEN**

Fix only observed failures. Prefer the editor imperative handle and its `contentRef` for focus restoration. Before `F6`, retain the current logical `ImageSelection`; on `Escape`, focus the textbox and restore that selection through the Task 7 mapper. Do not introduce a second selection state or special header-only behavior.

Re-run the focused command from Step 2. Expected: PASS.

- [ ] **Step 4: Run the full automated verification gate**

Run exactly:

```bash
npm test -- --maxWorkers=4
npm run lint
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml --all-targets --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked
npm run tauri:build -- --debug
git diff --check
git status --short
```

Expected: every command exits zero. Fix any regression in the task that introduced it, then rerun the focused test and this full gate; do not weaken an assertion or lint rule.

- [ ] **Step 5: Prove the desktop interaction matrix**

Run `npm run tauri:dev` against a disposable Vault and manually verify:

1. Korean IME composition before and after the atom, emoji boundaries, mouse caret placement, range selection across the atom, atom-only selection, Backspace/Delete, Enter, Shift+Enter, and exact Undo/Redo selection restoration.
2. External clipboard image-only, text+image HTML, internal copy/cut/paste, multiple pasted images as one Undo unit, missing/corrupt metadata rejection, and no remote URL fetch.
3. F6/Tab/Escape, context-menu keys, resize, menu, lightbox, download, original view, drag presentation, damaged-image recovery, read-only state, and screen-reader names.
4. The same behavior in an outline row and the page header; row Move to Trash still deletes the row, while image-menu Delete removes only the atom and converts the row to text.
5. Search, tags, dates, Markdown export/import round trip, PDF order/alt text, close/reopen persistence, receipt retry after an induced lost response, and history-budget pruning with an unacknowledged receipt pinned.

Record the OS, WebView version, Vault path class, and pass/fail result in the implementation handoff. Do not add repository files solely for this transient record.

- [ ] **Step 6: Commit only an actual accessibility fix**

If Step 3 changed production or test files, run the full gate again and commit exactly those files:

```bash
git add src/features/notes/ImageAtomEditor.tsx src/features/notes/NotesImageAttachment.tsx src/features/notes/NotesImageMenu.tsx src/features/notes/OutlineNodeRow.tsx src/features/notes/NotesPageHeader.tsx src/features/notes/notes.css src/features/notes/ImageAtomEditor.test.tsx src/features/notes/NotesImageAttachment.test.tsx src/features/notes/NotesImageMenu.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesPageHeader.test.tsx
git commit -m "fix(notes): complete image atom accessibility"
```

If no file changed in Step 3, skip this commit. Verification alone is not a commit.

---

## Dependency and Interface Order

```text
Task 0: current schema + TEMP history epoch/mixed timeline
  -> Task 1: current imageOffsetUtf16 + UTF-16 FTS scalar/schema
       -> Task 2: search classification, derived boundaries, labels
       -> Task 3: TEMP receipts + protected pruning
       -> Task 4: byte-free structural edit
       -> Task 5: raw byte paste

Task 6: pure logical model
  -> Task 7: DOM/logical mapping + focus snapshots
       -> Task 8: ImageAtomEditor + draft flush (also requires Task 1)
            -> Task 9: clipboard + attachment-ID byte residency prewarm
            -> Task 10: notesCommands delegation + receipt settlement (also requires Tasks 3-5)
            -> Task 11: row/header/pointer/paste integration
                 -> Task 12: Undo/Redo logical selection restoration

Tasks 1-5 + 8-12 -> Task 13: Markdown/PDF export
Task 13 -> Task 14: bounded Markdown import round trip
Tasks 0-14 -> Task 15: accessibility and complete verification
```

Execute the numbered tasks in order. Within Task 1, register the deterministic UTF-16 scalar before fresh current-schema creation calls it. Task 8 cannot start before Task 1 supplies the domain field, and Task 10 cannot start before Tasks 3-5 supply edit/paste/receipt Store APIs. Land receipts before wiring frontend retries. Within the frontend branch, keep Task 6 pure and DOM-free, then establish the Task 7 mapper before constructing the editor. Do not integrate row/header handlers before the editor, clipboard, coordinator, and byte-residency interfaces exist.

## Spec Coverage Self-Review

- **Current persistence:** Task 0 establishes the required TEMP history generation; Task 1 directly defines the fresh current image schema, threads `imageOffsetUtf16`, validates malformed ownership as corruption, and adds no migration or version increment.
- **UTF-16 search correctness:** Task 1 registers the deterministic rusqlite scalar before schema work, enables rusqlite's `functions` feature, and creates the four-column FTS storage; Task 2 keeps query/classification and tag/date-derived content aligned with the before/after boundary.
- **Atomicity and retry:** Tasks 3-5 write history and fingerprinted TEMP receipts in the same transaction. History pruning excludes the current operation entry and every unacknowledged receipt entry; acknowledgement releases the pin. Raw IPC carries bounded bytes only for paste and never stores them in history or receipts.
- **Editor semantics:** Tasks 6-8 define one atom in logical coordinates, composition-safe edits, selection mapping, draft flushing, Enter/Delete conversions, and supporting-note delegation without persisting U+FFFC.
- **Clipboard and memory:** Task 9 validates internal metadata against an actual byte carrier, never fetches remote URLs, caps decode/HTML/data-URL work, and extends residency from opaque active entries to attachment-ID-keyed byte prewarm shared by paste and rendering.
- **Command ownership:** Task 10 routes structural commands through `notesCommands`, keeps ordinary text commands unchanged, and settles unknown receipts in the coordinator turn before retrying or surfacing failure.
- **Integration precedence:** Task 11 lets an active editor claim paste before `NotesOutlinePane`, changes image-menu Delete from whole-row `actions.deleteNode` to atom removal, and preserves ordinary row Move to Trash. Row and header reuse the same editor contract.
- **History navigation:** Task 12 stores only logical focus/selection IDs and offsets, restores them after Undo/Redo and conversion, and never snapshots bytes, paths, DOM nodes, or workspaces.
- **Interchange:** Task 13 preserves before/image/after/note/children order and accessibility in Markdown/PDF. Task 14 explicitly fills the existing Notes Markdown import gap with a bounded canonical parser, fresh IDs, safe asset resolution, one transaction, and a typed store command without inventing unspecified UI.
- **Accessibility and proof:** Task 15 covers named roles/groups/controls, non-color-only selection, F6/Tab/Escape, keyboard context menu, row/header parity, full automated gates, and desktop verification.

Final type consistency rule: `imageOffsetUtf16` is the only persisted atom boundary; operation IDs are history entry IDs; `historyEpoch` guards the session timeline; receipt payloads contain normalized scalar metadata and fingerprints only. Persistent rows, history, and receipts contain no U+FFFC, image bytes, Blob/base64 payloads, Vault paths, DOM state, or reusable imported database IDs.
