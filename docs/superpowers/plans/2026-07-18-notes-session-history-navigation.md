# Notes Session History and Navigation Implementation Plan

**Date:** 2026-07-18

**Status:** Approved by the user

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Notes content mutations and user navigation one Vault-session-only chronological Undo/Redo timeline, backed by connection-local SQLite TEMP history.

**Architecture:** SQLite remains the authoritative transactional row replay engine, but history entries and audit data move from the main schema to the writable connection's TEMP schema. `CoordinatorEntry.history` becomes the one shared frontend timeline/cursor, which orders backend mutation entry IDs with client-side navigation snapshots. A mandatory navigation preflight/commit guard keeps that cursor synchronized with the connection epoch.

**Tech Stack:** React 19, TypeScript, Vitest, Tauri 2, Rust, rusqlite/SQLite TEMP tables.

## Global Constraints

- History is in memory only: it is discarded on final Vault-session close, connection replacement, or app quit; live Notes rows and attachment files remain persistent.
- Do not add dependencies or a second Rust replay engine; retain the current audited SQLite transaction/replay model in `src-tauri/src/notes/history.rs`.
- Main schema migrates exactly from version `1` to `2`; v2 contains no persistent history entry/change tables. Read-only export connections install no TEMP history.
- TEMP history is limited to 100 mutation entries and 50 MiB total before/after JSON; one entry may not exceed 50 MiB. The frontend exposes at most 100 mixed entries.
- Every history-aware backend response includes `historyEpoch`, `nextUndoEntryId`, `nextRedoEntryId`, and `prunedEntryIds`; a mutation result lists every history ID the backend deleted during redo invalidation or hard-cap enforcement.
- `NotesHistoryContext` includes the expected `historyEpoch`; stale text and structural mutations fail before any persistent row changes.
- Only the Vault coordinator's current presentation-owner token can enqueue navigation, mutations, or history replay. Older overlapping React sessions receive synchronized workspace updates only.
- Navigation must always use the structural draft barrier, history-status preflight, and `notes_prepare_navigation` guard, including when no redo suffix exists.
- Use the existing Notes bottom-bar feedback path; do not introduce Undo/Redo buttons or upper-right history toasts.
- All implementation tasks are TDD: write the focused failing test, run it, add the smallest implementation, run focused regression, commit only that task.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src-tauri/src/notes/schema.rs` | Persistent v2 schema and explicit v1→v2 history-table removal migration. |
| `src-tauri/src/notes/repository.rs` | Schema-version dispatch and `empty_trash` transaction integration. |
| `src-tauri/src/notes/history.rs` | TEMP table installation, epoch/status/pruning, exact-entry replay, navigation preparation, reset/close helpers. |
| `src-tauri/src/notes/types.rs` | Tauri wire structs for history epoch, commands, and discriminated replay/reset results. |
| `src-tauri/src/notes/commands.rs` | Tauri command boundary, attachment reconciliation, controlled final history close. |
| `src-tauri/src/notes/connection.rs` | Cached-connection final-close state transition and safe eviction support. |
| `src-tauri/src/lib.rs` | Tauri command registration. |
| `src-tauri/build.rs` | Tauri app-manifest command allowlist for every new history command. |
| `src/domain/notes.ts` | TypeScript `NotesStore` protocol and strict runtime validators. |
| `src/services/notesStore.ts` | Tauri invokes and response normalization for the new protocol. |
| `src/features/notes/notesHistory.ts` | Shared mixed timeline/cursor, snapshot pooling, floor/truncation and replay preparation. |
| `src/features/notes/notesWorkspaceCoordinator.ts` | Vault-level timeline owner, presentation token, closing/reopen serialization. |
| `src/features/notes/useNotesWorkspace.ts` | Snapshot capture, exact replay dispatcher, one navigation boundary, state-slice availability. |
| `src/features/notes/notesCommands.ts` | Mutation entry completion and `emptyTrash` `historyReset` consumption. |
| `src/features/notes/NotesOutlinePane.tsx` | Scope-level composition-state reporting used by deferred navigation. |

Existing focused tests stay next to their subject: Rust unit tests in `history.rs`, `repository.rs`, `commands.rs`, `attachments.rs`, `connection.rs`; frontend tests in `notesHistory.test.ts`, `notesWorkspaceCoordinator.test.ts`, `useNotesWorkspace.test.tsx`, and the affected Notes pane tests.

---

### Task 1: Install TEMP history and migrate the persistent schema to v2

**Files:**
- Modify: `src-tauri/src/notes/schema.rs:3-173`
- Modify: `src-tauri/src/notes/repository.rs:40,568-615,708-771`
- Modify: `src-tauri/src/notes/history.rs:17-190`
- Test: `src-tauri/src/notes/repository.rs` test module
- Test: `src-tauri/src/notes/history.rs` test module

**Interfaces:**
- Consumes: `schema::create_if_missing`, `initialize_notes_db`, `connect_notes_db`, `HISTORY_MAX_ENTRIES`, and the existing unqualified history SQL.
- Produces:

```rust
pub(crate) const CURRENT_NOTES_SCHEMA_VERSION: i64 = 2;
pub(crate) fn migrate_v1_to_v2(transaction: &Transaction<'_>) -> Result<(), String>;
pub(crate) fn install_session_history(connection: &Connection) -> Result<(), String>;
pub(crate) fn history_epoch(connection: &Connection) -> Result<String, String>;
```

- `install_session_history` must run only after main-schema initialization, execute `PRAGMA temp_store = MEMORY`, and create `temp.notes_history_epoch`, `temp.notes_history_entries`, `temp.notes_history_changes`, plus the existing audit/helper TEMP tables/triggers.

- [ ] **Step 1: Write failing migration and TEMP-schema tests**

```rust
#[test]
fn notes_history_v1_migrates_to_temp_v2_without_losing_live_nodes() {
    let mut connection = seeded_v1_connection();
    initialize_notes_db(&mut connection).expect("migrate v1");
    assert_eq!(schema_version(&connection), 2);
    assert!(table_exists(&connection, "main", "notes_nodes"));
    assert!(!table_exists(&connection, "main", "notes_history_entries"));
    assert!(table_exists(&connection, "temp", "notes_history_entries"));
    assert_ne!(history_epoch(&connection).unwrap(), "");
}

#[test]
fn notes_history_reopening_keeps_live_rows_but_allocates_a_new_temp_epoch() {
    let vault = test_vault();
    let first = connect_notes_db(&vault).unwrap();
    let first_epoch = history_epoch(&first).unwrap();
    create_node_for_test(&first);
    drop(first);
    let second = connect_notes_db(&vault).unwrap();
    assert_ne!(history_epoch(&second).unwrap(), first_epoch);
    assert_eq!(load_workspace(&second, NotesWorkspaceScope::Active).unwrap().nodes.len(), 1);
}

#[test]
fn notes_history_v0_runs_sequential_migrations_and_leaves_no_main_history_tables() {
    let mut connection = seeded_v0_connection();
    initialize_notes_db(&mut connection).expect("migrate v0 through v2");
    assert_eq!(schema_version(&connection), 2);
    assert!(!table_exists(&connection, "main", "notes_history_entries"));
    assert_eq!(load_workspace(&connection, NotesWorkspaceScope::Active).unwrap().nodes.len(), 1);
}
```

Also assert `PRAGMA temp_store` reports `2` (`MEMORY`) on a writable connection, a fresh v2 main schema never contains history tables, and `open_notes_export_db` installs no TEMP history/epoch tables.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- --list | rg 'notes_history_'
cargo test --manifest-path src-tauri/Cargo.toml notes_history_ -- --nocapture
```

Expected: FAIL because schema version remains `1`, main history tables still exist, and `history_epoch`/TEMP tables do not exist.

- [ ] **Step 3: Implement the smallest schema and installer change**

```rust
// schema.rs
pub(crate) fn migrate_v1_to_v2(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction.execute_batch(
        "DROP TABLE IF EXISTS notes_history_changes; \
         DROP INDEX IF EXISTS notes_history_session_sequence; \
         DROP TABLE IF EXISTS notes_history_entries;",
    ).map_err(|error| format!("Could not migrate Notes history to v2: {error}"))
}

// history.rs; include the existing audit tables/triggers in this TEMP batch.
pub(crate) fn install_session_history(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        "PRAGMA temp_store = MEMORY; \
         CREATE TEMP TABLE IF NOT EXISTS notes_history_epoch (value TEXT NOT NULL); \
         CREATE TEMP TABLE IF NOT EXISTS notes_history_entries (\
           id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, \
           is_undone INTEGER NOT NULL DEFAULT 0, estimated_bytes INTEGER NOT NULL DEFAULT 0, \
           command_kind TEXT NOT NULL); \
         CREATE UNIQUE INDEX IF NOT EXISTS temp.notes_history_session_sequence \
           ON notes_history_entries(session_id, sequence); \
         CREATE TEMP TABLE IF NOT EXISTS notes_history_changes (\
           entry_id TEXT NOT NULL REFERENCES notes_history_entries(id) ON DELETE CASCADE, \
           table_name TEXT NOT NULL, row_id TEXT NOT NULL, ordinal INTEGER NOT NULL, \
           before_json TEXT, after_json TEXT, PRIMARY KEY(entry_id, table_name, row_id));",
    ).map_err(|error| format!("Could not install TEMP Notes history: {error}"))?;
    connection.execute(
        "INSERT INTO notes_history_epoch(value) SELECT ?1 \
         WHERE NOT EXISTS (SELECT 1 FROM notes_history_epoch)",
        [Uuid::new_v4().to_string()],
    ).map_err(|error| format!("Could not initialize Notes history epoch: {error}"))?;
    install_audit_infrastructure(connection)
}
```

Dispatch migrations sequentially: an existing version-0 database first runs the current `0 -> 1` work and then `migrate_v1_to_v2`; version 1 runs only `1 -> 2`; a fresh database creates canonical v2 directly. Update `user_version` in the same initialization transaction, then call `install_session_history(connection)` only after that transaction commits. Remove persistent history DDL from `CURRENT_SCHEMA_SQL`; preserve all other DDL byte-for-byte. Read-only export connections must never call the TEMP installer.

- [ ] **Step 4: Run GREEN and regression tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests
```

Expected: PASS; schema tests prove v1 live data survives, main history tables are gone, TEMP tables exist only on writable connections, and a reopen has a different epoch.

- [ ] **Step 5: Commit the isolated backend schema task**

```bash
git add src-tauri/src/notes/schema.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/history.rs
git commit -m "feat(notes): move session history to temp storage"
```

### Task 2: Add epoch-aware exact replay, pruning, reset, and final close commands

**Files:**
- Modify: `src-tauri/src/notes/types.rs:187-205,340-362`
- Modify: `src-tauri/src/notes/history.rs:201-706,1252-1455`
- Modify: `src-tauri/src/notes/commands.rs:621-688,1117-1235,1300-1365`
- Modify: `src-tauri/src/notes/repository.rs:5086-5093`
- Modify: `src-tauri/src/notes/connection.rs:190-220`
- Modify: `src-tauri/src/lib.rs:1566-1590`
- Modify: `src-tauri/build.rs:1-75`
- Test: `src-tauri/src/notes/history.rs`, `src-tauri/src/notes/commands.rs`, `src-tauri/src/notes/attachments.rs`, `src-tauri/src/notes/connection.rs`

**Interfaces:**
- Consumes: Task 1 `history_epoch`/TEMP tables and current `replay`, `enforce_limits`, `reconcile_candidates_after_committed_change`.
- Produces these serde camelCase protocol types (define them in `types.rs` and use them in every command):

```rust
pub struct NotesHistoryState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub history_epoch: String,
    pub next_undo_entry_id: Option<String>,
    pub next_redo_entry_id: Option<String>,
    pub pruned_entry_ids: Vec<String>,
}
pub struct NotesInitializeInput { pub session_id: String }
pub struct NotesHistoryReplayRequest {
    pub session_id: String,
    pub history_epoch: String,
    pub expected_entry_id: String,
    pub scope: NotesWorkspaceScope,
}
pub struct NotesPruneHistoryInput { pub session_id: String, pub history_epoch: String, pub entry_ids: Vec<String> }
pub struct NotesHistoryResetInput { pub session_id: String, pub history_epoch: String }
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum NotesHistoryReplayOutcome {
    Applied { workspace: NotesWorkspace, replayed_entry_id: String, #[serde(flatten)] state: NotesHistoryState },
    EpochMismatch { #[serde(flatten)] state: NotesHistoryState },
    EntryMissing { #[serde(flatten)] state: NotesHistoryState },
    EntryNotNext { #[serde(flatten)] state: NotesHistoryState },
}
pub struct NotesPrepareNavigationInput { pub session_id: String, pub history_epoch: String, pub unreachable_redo_entry_ids: Vec<String> }
pub struct NotesHistoryCloseInput { pub session_id: String, pub history_epoch: String }
```

- Add `history_epoch` to `NotesHistoryContext`. Initialization returns `NotesHistoryState`; mutation/replay/reset results flatten `NotesHistoryState` so existing top-level `canUndo`/`canRedo` consumers remain valid and add `history_reset: bool` only for explicit resets. Both `emptyTrash` and explicit clear-history require `NotesHistoryResetInput`, reject a stale epoch before persistent mutation, and return reset-aware results instead of silently clearing backend rows. Add `notes_prune_history_entries` for frontend capacity/floor cleanup.

- [ ] **Step 1: Write failing protocol and transaction tests**

```rust
#[test]
fn notes_history_replay_rejects_wrong_expected_id_without_changing_rows() {
    let (mut connection, session, entry_a, entry_b) = history_with_two_entries();
    let before = load_workspace(&connection, NotesWorkspaceScope::Active).unwrap();
    let epoch = history_epoch(&connection).unwrap();
    let result = replay_expected(&mut connection, &session, &epoch, &entry_a, NotesWorkspaceScope::Active).unwrap();
    assert!(matches!(result, NotesHistoryReplayOutcome::EntryNotNext { .. }));
    assert_eq!(load_workspace(&connection, NotesWorkspaceScope::Active).unwrap(), before);
    assert_eq!(entry_b, next_undo_entry_id(&connection, &session).unwrap().unwrap());
}

#[test]
fn notes_history_empty_trash_rotates_epoch_and_clears_history_in_the_same_transaction() {
    let vault = vault_with_trashed_image_and_history();
    let before_epoch = notes_history_status_inner(vault.clone(), SESSION_ID.into()).unwrap().history_epoch;
    let result = notes_empty_trash_inner(vault, reset_input(&before_epoch)).unwrap();
    assert!(result.history_reset);
    assert_ne!(result.history_epoch, before_epoch);
    assert!(result.next_undo_entry_id.is_none());
}

#[test]
fn notes_history_empty_trash_rejects_stale_epoch_without_changing_rows_or_history() {
    let vault = vault_with_trashed_node_and_history();
    let before = snapshot_rows_history_and_epoch(&vault);
    let error = notes_empty_trash_inner(vault.clone(), reset_input("stale-epoch")).unwrap_err();
    assert!(error.to_string().contains("epoch"));
    assert_eq!(snapshot_rows_history_and_epoch(&vault), before);
}

#[test]
fn notes_history_stale_epoch_mutation_changes_no_live_rows() {
    let (mut connection, stale_context) = connection_with_rotated_epoch();
    let before = load_workspace(&connection, NotesWorkspaceScope::Active).unwrap();
    let error = update_node_with_context(&mut connection, stale_context).unwrap_err();
    assert!(error.contains("epoch"));
    assert_eq!(load_workspace(&connection, NotesWorkspaceScope::Active).unwrap(), before);
}
```

Add Rust RED cases showing `prepare_navigation` rejects a foreign-session ID, an applied ID, an empty request while backend redo exists, and a partial/extra/reordered redo suffix without changing history rows or attachment files; a new mutation after Undo returns every backend-deleted redo entry in `prunedEntryIds`; initialize returns next IDs for its explicit session ID; reset failure preserves rows/history/epoch; and final-close cleanup/reconciliation failure still evicts the cached connection so an immediate reopen obtains a fresh epoch.
Add a serde boundary assertion that an applied outcome contains `replayedEntryId` and never `replayed_entry_id`; flattened `NotesHistoryState` keys must likewise be camelCase.

- [ ] **Step 2: Run RED tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- --list | rg 'notes_history_'
cargo test --manifest-path src-tauri/Cargo.toml notes_history_ -- --nocapture
```

Expected: FAIL because replay auto-selects the next entry and empty-trash returns only a workspace.

- [ ] **Step 3: Implement exact-entry history helpers and command results**

```rust
enum ReplayGate {
    Apply(String),
    EpochMismatch(NotesHistoryState),
    EntryMissing(NotesHistoryState),
    EntryNotNext(NotesHistoryState),
}

fn expected_replay_entry(
    connection: &Connection, session_id: &str, expected_epoch: &str,
    expected_entry_id: &str, undoing: bool,
) -> Result<ReplayGate, String> {
    let state = history_state(connection, session_id, Vec::new())?;
    if state.history_epoch != expected_epoch {
        return Ok(ReplayGate::EpochMismatch(state));
    }
    let Some(next) = if undoing { state.next_undo_entry_id.clone() } else { state.next_redo_entry_id.clone() } else {
        return Ok(ReplayGate::EntryMissing(state));
    };
    if next != expected_entry_id {
        return Ok(ReplayGate::EntryNotNext(state));
    }
    Ok(ReplayGate::Apply(next))
}

pub(crate) struct HistoryMaintenanceResult {
    pub state: NotesHistoryState,
    pub pruned_attachment_paths: Vec<String>,
}

pub(crate) fn prepare_navigation(
    connection: &mut Connection, input: &NotesPrepareNavigationInput,
) -> Result<HistoryMaintenanceResult, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not prepare Notes navigation: {error}"))?;
    require_epoch(&transaction, &input.history_epoch)?;
    require_exact_redo_mutation_suffix(
        &transaction,
        &input.session_id,
        &input.unreachable_redo_entry_ids,
    )?; // exact ordered set of all undone mutation IDs for this session
    record_pruned_attachment_paths_for_entries(
        &transaction,
        &input.unreachable_redo_entry_ids,
    )?;
    let pruned_entry_ids = prune_entry_ids(&transaction, &input.unreachable_redo_entry_ids)?;
    let state = history_state(&transaction, &input.session_id, pruned_entry_ids)?;
    let pruned_attachment_paths = take_pruned_attachment_paths(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit Notes navigation preparation: {error}"))?;
    Ok(HistoryMaintenanceResult { state, pruned_attachment_paths })
}
```

Use the existing `validate_expected_states`, lifecycle/capacity/namespace validation, and row application in `replay`; only replace its entry-selection gate. Every Tauri-exposed user mutation requires a non-null `NotesHistoryContext`; reject a missing context before entering the mutation closure, while keeping separately named internal initialization/reconciliation helpers for genuinely untracked maintenance. `begin_audit` must call `require_epoch` before the mutation closure can touch persistent rows. Have both mutation-side redo invalidation and `enforce_limits` collect every deleted history ID into the same result `pruned_entry_ids`; this includes undone entries removed by a successful new edit, not only hard-cap victims. `prune_history_entries` validates epoch/session and ownership before deleting requested TEMP entry IDs. `prepare_navigation` compares the request, including order and cardinality, with the complete current redo mutation suffix for `input.session_id`; every member must be undone and no duplicate, missing, foreign-session, applied, extra, or omitted ID is accepted. A non-empty backend redo suffix with an empty request and any partial suffix request reject before recording paths or deleting rows. Both maintenance paths return attachment cleanup candidates plus exact resulting state, and `prepare_navigation` uses the same attachment-storage lease/reconciliation path when it deletes redo entries that reference owned files. `notes_close_history_session_inner` owns the eviction guarantee: it captures cleanup/reconciliation success or failure, releases the DB guard, always attempts cached-connection eviction, and then returns the original cleanup error (or eviction error). The frontend has no separate evict command. `notes_empty_trash` and `notes_clear_history` validate `NotesHistoryResetInput` and invoke a reset helper in their transaction which clears entries/receipts and replaces the single TEMP epoch row; transaction failure preserves live data and the previous epoch.

- [ ] **Step 4: Register and validate the Tauri boundary**

```rust
#[tauri::command(rename_all = "camelCase")]
async fn notes_initialize(vault_path: String, input: NotesInitializeInput)
    -> Result<NotesHistoryState, NotesError> {
    run_blocking(move || notes_initialize_for_session_inner(vault_path, input)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn notes_prepare_navigation(vault_path: String, input: NotesPrepareNavigationInput)
    -> Result<NotesHistoryState, NotesError> {
    run_blocking(move || notes_prepare_navigation_inner(vault_path, input)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn notes_prune_history_entries(vault_path: String, input: NotesPruneHistoryInput)
    -> Result<NotesHistoryState, NotesError> {
    run_blocking(move || notes_prune_history_entries_inner(vault_path, input)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn notes_close_history_session(vault_path: String, input: NotesHistoryCloseInput)
    -> Result<(), NotesError> {
    run_blocking(move || notes_close_history_session_inner(vault_path, input)).await
}
```

Keep the existing one-argument `notes_initialize_inner(vault_path) -> Result<(), String>` as the explicitly untracked internal startup/reconciliation helper used by Rust maintenance tests. Add `notes_initialize_for_session_inner`: it calls that helper, then reads `history_state` for `input.session_id` from the resulting writable cached connection. Only the Tauri-facing `notes_initialize` changes to the request/response shape above, so initialization returns next IDs for the exact frontend coordinator session without forcing unrelated internal callers to invent a session.

Add all three new commands to `tauri::generate_handler!` beside `notes_undo`, `notes_redo`, and `notes_history_status` in `lib.rs`, update the existing `notes_initialize` registration to its new request shape, and add the three new exact names to `APP_COMMANDS` in `src-tauri/build.rs` (the initialize name is already present). Every initialization/mutation/status/replay/prune result must call one `history_state` helper so fields cannot drift. Run the manifest parity test immediately after registration.

- [ ] **Step 5: Run GREEN and attachment regressions**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::commands::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::attachments::tests
cargo test --manifest-path src-tauri/Cargo.toml notes::connection::tests
cargo test --manifest-path src-tauri/Cargo.toml application_manifest_covers_every_registered_command_exactly_once -- --nocapture
```

Expected: PASS; wrong/missing/epoch replay outcomes mutate no rows, pruning reports IDs, final close reconciles only history-held assets, and reset is atomic.

- [ ] **Step 6: Commit the protocol task**

```bash
git add src-tauri/src/notes/types.rs src-tauri/src/notes/history.rs src-tauri/src/notes/commands.rs src-tauri/src/notes/repository.rs src-tauri/src/notes/connection.rs src-tauri/src/lib.rs src-tauri/build.rs
git commit -m "feat(notes): add epoch-aware session history protocol"
```

### Task 3: Expose the Rust protocol through strict TypeScript domain and store contracts

**Files:**
- Modify: `src/domain/notes.ts:61-85,393-422,748-847`
- Modify: `src/services/notesStore.ts:1085-1141,1520-1560`
- Modify: `src/features/notes/notesHistory.ts:34-55,143-239`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:500-535`
- Modify: `src/features/notes/notesCommands.ts`
- Modify: `src/features/notes/notesDraftEngine.ts`
- Modify: `src/features/notes/useNotesWorkspace.ts`
- Test: `src/domain/notes.test.ts`
- Test: `src/services/notesStore.test.ts`
- Test: `src/services/notesStore.tauri.test.ts`
- Test: `src/features/notes/notesHistory.test.ts`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Mechanical test fixture updates: `src/features/notes/notesDraftEngine.test.ts`, `src/features/notes/useNotesWorkspace.test.tsx`, `src/features/notes/notesWorkspaceContextSplit.test.tsx`, `src/features/notes/outlineRowMemo.test.tsx`, `src/features/notes/NotesExportMenu.test.tsx`

**Interfaces:**
- Consumes: Task 2 camelCase Tauri payloads.
- Produces:

```ts
export interface NotesHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  historyEpoch: string;
  nextUndoEntryId: string | null;
  nextRedoEntryId: string | null;
  prunedEntryIds: string[];
}
export type NotesHistoryReplayOutcome =
  | ({ kind: "applied"; workspace: NotesWorkspace; replayedEntryId: string } & NotesHistoryState)
  | ({ kind: "epochMismatch" | "entryMissing" | "entryNotNext" } & NotesHistoryState);
export interface NotesHistoryReplayInput {
  sessionId: string;
  historyEpoch: string;
  expectedEntryId: string;
  scope: NotesWorkspaceScope;
}
export interface NotesInitializeInput {
  sessionId: string;
}
export interface NotesPruneHistoryInput {
  sessionId: string;
  historyEpoch: string;
  entryIds: readonly string[];
}
export interface NotesPrepareNavigationInput {
  sessionId: string; historyEpoch: string; unreachableRedoEntryIds: readonly string[];
}
export interface NotesHistoryCloseInput {
  sessionId: string;
  historyEpoch: string;
}
export interface NotesHistoryResetInput {
  sessionId: string;
  historyEpoch: string;
}
export interface NotesHistoryResetResult extends NotesHistoryState {
  historyReset: true;
}
export interface NotesWorkspaceResetResult extends NotesHistoryResetResult {
  workspace: NotesWorkspace;
}
```

`NotesStore` gains `pruneHistoryEntries`, `prepareNavigation`, `closeHistorySession`, and exact request-shaped `undo`/`redo`; `initialize(vaultPath, { sessionId })` returns the `NotesHistoryState` for that exact coordinator session, `emptyTrash(vaultPath, resetInput)` returns `NotesWorkspaceResetResult`, and `clearHistory(vaultPath, resetInput)` returns `NotesHistoryResetResult`. `NotesHistoryContext` requires `historyEpoch`, and every user mutation method requires a non-null history context instead of an optional/null default. Update internal maintenance call sites to use explicitly named non-user helpers rather than bypassing the Tauri mutation guard.

- [ ] **Step 1: Write failing validators/adapter tests**

```ts
it("rejects an applied replay without an exact history state", async () => {
  mockInvoke.mockResolvedValue({ kind: "applied", workspace: { nodes: [] } });
  await expect(notesUndo("/vault", replayRequest)).rejects.toThrow("invalid result");
});

it("sends navigation preparation as camelCase", async () => {
  mockInvoke.mockResolvedValue(historyState("epoch-a"));
  await notesPrepareNavigation("/vault", { sessionId: ID, historyEpoch: "epoch-a", unreachableRedoEntryIds: [ENTRY] });
  expect(mockInvoke).toHaveBeenCalledWith("notes_prepare_navigation", {
    vaultPath: "/vault", input: { sessionId: ID, historyEpoch: "epoch-a", unreachableRedoEntryIds: [ENTRY] }
  });
});
```

- [ ] **Step 2: Run RED tests**

Run: `npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts src/features/notes/notesHistory.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts`

Expected: FAIL because the current protocol has only `canUndo/canRedo` and `notes_undo` accepts positional session/scope arguments.

- [ ] **Step 3: Implement exact runtime guards and invokes**

```ts
export function notesInitialize(vaultPath: string, input: NotesInitializeInput) {
  return invokeHistoryState("notes_initialize", { vaultPath, input });
}

export function notesUndo(vaultPath: string, input: NotesHistoryReplayInput) {
  return invokeHistoryReplay("notes_undo", { vaultPath, input });
}

export function notesPrepareNavigation(vaultPath: string, input: NotesPrepareNavigationInput) {
  return invokeHistoryState("notes_prepare_navigation", { vaultPath, input });
}

export function notesPruneHistoryEntries(vaultPath: string, input: NotesPruneHistoryInput) {
  return invokeHistoryState("notes_prune_history_entries", { vaultPath, input });
}
```

Keep `isNotesMutationResult` strict: `historyEpoch`, `nextUndoEntryId`, `nextRedoEntryId`, and `prunedEntryIds` are required keys on every mutation result; only incremental delta/result-specific fields remain optional. Add missing-key rejection tests for initialize, status, mutation, replay, prune, and reset validators rather than casting `unknown`. Normalize every workspace exactly as the current `invokeHistoryReplay` does before returning it.

Seed the existing Vault-shared `NotesHistorySession` from the successful `initialize(vaultRoot, { sessionId: history.sessionId })` result before activation resolves. Change the coordinator's initialization promise/result type to `NotesHistoryState`, call `history.bindInitialization(initialState)` and validate the next IDs before admitting commands. The session keeps a private nullable epoch only until binding; its public `historyEpoch` getter and context-producing methods throw before binding rather than returning a dummy empty epoch. Add final `bindInitialization(state)` and `reset(historyEpoch)` methods now and include that epoch in every context returned by `beginTextBurst`/`beginStructuralEntry`; Task 4 reuses them while replacing the snapshot map with the mixed timeline. Update `notesCommands`, the draft engine, workspace actions, and typed `NotesStore` fixtures so every user mutation passes the non-null context and every initialize mock accepts a session input and returns `historyState("epoch-a")`; this task must build without weakening `historyEpoch` to optional.

- [ ] **Step 4: Run GREEN and compile all test doubles**

Run:

```bash
npm test -- src/domain/notes.test.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts src/features/notes/notesHistory.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts
npm run build
```

Expected: PASS; `npm run build` identifies and fixes every `NotesStore` mock that still implements the old signatures.

- [ ] **Step 5: Commit the TypeScript protocol task**

```bash
git add src/domain/notes.ts src/domain/notes.test.ts src/services/notesStore.ts src/services/notesStore.test.ts src/services/notesStore.tauri.test.ts src/features/notes/notesHistory.ts src/features/notes/notesHistory.test.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/notesCommands.ts src/features/notes/notesDraftEngine.ts src/features/notes/notesDraftEngine.test.ts src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/notesWorkspaceContextSplit.test.tsx src/features/notes/outlineRowMemo.test.tsx src/features/notes/NotesExportMenu.test.tsx
git commit -m "feat(notes): expose epoch-aware history store contracts"
```

### Task 4: Turn `NotesHistorySession` into the shared mixed timeline and make coordinator lifecycle safe

**Files:**
- Modify: `src/features/notes/notesHistory.ts:7-239`
- Modify: `src/features/notes/notesWorkspaceCoordinator.ts:120-191,270-289,605-640,642-905`
- Modify: `src/features/notes/useNotesWorkspace.ts:720-760`
- Test: `src/features/notes/notesHistory.test.ts`
- Test: `src/features/notes/notesWorkspaceCoordinator.test.ts`
- Test: `src/features/notes/useNotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: Task 3 `NotesHistoryState`, replay outcome, `prepareNavigation`, `closeHistorySession`.
- Produces:

```ts
export type NotesSessionHistoryEntry =
  | { kind: "mutation"; entryId: string; before: NotesHistorySnapshot; after: NotesHistorySnapshot }
  | { kind: "navigation"; before: NotesHistorySnapshot; after: NotesHistorySnapshot };

interface NotesExpansionRevision {
  revision: number;
  nodeIds: readonly NoteId[];
}

interface NotesExpansionSnapshotPool {
  acquire(nodeIds: readonly NoteId[]): NotesExpansionRevision;
  retain(value: NotesExpansionRevision): void;
  release(value: NotesExpansionRevision): void;
  size(): number;
}

interface NotesHistorySession {
  readonly sessionId: string;
  readonly historyEpoch: string;
  bindInitialization(state: NotesHistoryState): void;
  canUndo(): boolean; canRedo(): boolean;
  beginTextBurst(nodeId: NoteId, before: NotesHistorySnapshot): NotesHistoryContext;
  closeTextBurst(): void;
  beginStructuralEntry(commandKind: string, before: NotesHistorySnapshot): NotesHistoryContext;
  acceptMutationResult(
    entryId: string,
    after: NotesHistorySnapshot,
    state: NotesHistoryState,
  ): { accepted: boolean; unreachableEntryIds: readonly string[] };
  appendNavigation(before: NotesHistorySnapshot, after: NotesHistorySnapshot): readonly string[];
  discard(entryId: string): void;
  next(direction: NotesHistoryReplayDirection): NotesSessionHistoryEntry | null;
  // Local navigation entries only; backend mutation replay uses acceptReplayResult.
  commitReplay(direction: NotesHistoryReplayDirection): void;
  accepts(state: NotesHistoryState): boolean;
  acceptReplayResult(
    state: NotesHistoryState,
    direction: NotesHistoryReplayDirection,
    entryId: string,
  ): boolean;
  acceptPreparedNavigation(state: NotesHistoryState, invalidatedRedoIds: readonly string[]): boolean;
  unreachableRedoMutationIds(): readonly string[];
  reset(historyEpoch: string): void;
}

interface OpenNotesWorkspaceSessionOptions {
  presentation: "writable" | "background";
  captureHistoryLocation?: () => NotesHistorySnapshot;
  applyHistoryLocation?: (
    workspace: NormalizedNotesWorkspace,
    snapshot: NotesHistorySnapshot,
  ) => boolean;
}

interface NotesNavigationPresentationLease {
  setDestination(
    workspace: NormalizedNotesWorkspace,
    after: NotesHistorySnapshot,
  ): void;
  commit(): readonly string[];
  cancel(): void;
}

interface NotesWorkspaceCoordinatorSession {
  ownerToken(): number;
  isCurrentOwner(token: number): boolean;
  reserveAdmittedNavigation(before: NotesHistorySnapshot): NotesNavigationPresentationLease;
  settleAuthoritativePresentation(
    workspace: NormalizedNotesWorkspace,
    snapshot: NotesHistorySnapshot,
  ): void;
  queueHistoryCleanup(entryIds: readonly string[]): void;
  drainHistoryCleanup(): Promise<void>;
  recoverHistoryMismatch(
    state: NotesHistoryState,
    reload: () => Promise<{
      workspace: NormalizedNotesWorkspace;
      snapshot: NotesHistorySnapshot;
    }>,
  ): Promise<{
    workspace: NormalizedNotesWorkspace;
    snapshot: NotesHistorySnapshot;
  } | null>;
  resetHistory(
    historyEpoch: string,
    presentation: { workspace: NormalizedNotesWorkspace; snapshot: NotesHistorySnapshot },
  ): void;
}
```

Keep `NotesHistorySnapshot` as the one shape: add library/tag fields and an immutable expansion revision reference rather than a second incompatible navigation type. `acceptMutationResult` and `appendNavigation` return only mutation IDs made unreachable by redo truncation or the 100-entry cap and not already named in the authoritative backend `prunedEntryIds`/navigation-preparation result; every caller immediately passes that return to `session.queueHistoryCleanup`, a non-throwing insertion into the coordinator's bounded deduplicated cleanup set. Post-operation results never pass through the pre-operation `accepts` check: `acceptMutationResult` and `acceptReplayResult` each project the corresponding append/cursor move first, apply backend pruning to that projection, validate the returned nearest mutation IDs, and commit the projected timeline only when the complete comparison succeeds.

- [ ] **Step 1: Write failing pure timeline and coordinator race tests**

```ts
it("undoes edit, navigation, edit in reverse chronological order", () => {
  const history = createNotesHistorySession({ createId: ids });
  history.bindInitialization(historyState("epoch-a"));
  const firstMutation = history.beginStructuralEntry("edit", location("a"));
  history.acceptMutationResult(firstMutation.entryId, location("a"), stateAfterMutation(firstMutation.entryId));
  history.appendNavigation(location("a"), location("b"));
  const secondMutation = history.beginStructuralEntry("edit", location("b"));
  history.acceptMutationResult(secondMutation.entryId, location("b"), stateAfterMutation(secondMutation.entryId));
  const candidate = history.next("undo");
  expect(candidate?.kind).toBe("mutation");
  history.acceptReplayResult(stateAfterUndo(secondMutation.entryId), "undo", secondMutation.entryId);
  expect(history.next("undo")?.kind).toBe("navigation");
});

it("keeps removed entries hidden and blocks new work while cleanup retry fails", async () => {
  const coordinator = coordinatorAtCapacity();
  coordinator.appendNavigation(location("a"), location("b"));
  repository.pruneHistoryEntries.mockRejectedValueOnce(new Error("busy"));
  await expect(coordinator.enqueueStructural(work)).resolves.toBe("failed");
  expect(work).not.toHaveBeenCalled();
  expect(coordinator.history.canUndo()).toBe(true);
});

it("reuses and releases semantic expansion revisions", () => {
  const expansionPool = createNotesExpansionSnapshotPool();
  const history = createNotesHistorySession({ createId: ids, expansionPool });
  history.bindInitialization(historyState("epoch-a"));
  const first = locationWithExpansion(["b", "a"]);
  const second = locationWithExpansion(["a", "b"]);
  history.appendNavigation(first, second);
  expect(expansionPool.size()).toBe(1);
  history.reset("epoch-b");
  expect(expansionPool.size()).toBe(0);
});

it("waits for final close before allowing an immediate vault reopen", async () => {
  const { first, closeBackend, open } = harness();
  const firstEpoch = first.history.historyEpoch;
  first.close();
  const second = open();
  const third = open();
  expect(second.history).not.toBe(first.history);
  expect(second.history.sessionId).not.toBe(first.history.sessionId);
  expect(third.history).toBe(second.history);
  expect(third.history.sessionId).toBe(second.history.sessionId);
  await expect(Promise.all([second.activation, third.activation])).resolves.toEqual([undefined, undefined]);
  expect(closeBackend).toHaveBeenCalledTimes(1);
  expect(repository.initialize).toHaveBeenCalledTimes(2); // first generation + one coalesced reopen
  expect(repository.initialize).toHaveBeenLastCalledWith(vaultRoot, {
    sessionId: second.history.sessionId,
  });
  expect(second.history.historyEpoch).not.toBe(firstEpoch);
});

it("never transfers presentation ownership to a background recovery session", async () => {
  const background = registry.openSession(options({ presentation: "background" }));
  await background.activation;
  await expect(background.enqueue(work)).resolves.toBe("skipped");
  await expect(background.enqueueStructural(work)).resolves.toBe("skipped");
  const visible = registry.openSession(options({ presentation: "writable" }));
  await visible.activation;
  expect(visible.isCurrentOwner(visible.ownerToken())).toBe(true);
});
```

In the same RED suite, prove one same-node/field text burst occupies one position, `closeTextBurst` ends it, and another edit of that same node/field after navigation receives a different entry ID; entry 101 trims the oldest mixed action; applied-side and redo-side backend pruning both clamp the cursor/floor correctly; reset clears pending cleanup IDs; admitted work settles through owner transfer while queued stale intents are discarded; cleanup failure still completes final close and immediate reopen; and the nearest backend mutation IDs must agree on both sides of the cursor. Add an owner-transfer presentation test proving a reserved whole action commits atomically with `appendNavigation`; the lease retains both expansion revisions while the owner disappears during the guard, then transfers/releases those references exactly once on commit/cancel/reset/close. On commit the timeline takes the lease's before/after refs and canonical presentation acquires its own additional after ref. Test both independent release orders: replacing canonical must not free an after revision still held by the timeline, and trimming/resetting the timeline must not free one still held by canonical presentation; only the final owner release removes it. If the owner is missing or its callback returns false/throws, the committed canonical destination blocks subsequent work; the next attempted mutation never reaches the repository, and only a successful retry or a new writable owner applying the exact snapshot before activation unblocks later actions. Repeated apply failure shows the close/reopen instruction. Every owner transfer reapplies the current canonical location even when `pendingOwnerApply` was previously false. Navigation Undo/Redo and mutation settlement update the canonical workspace/snapshot in the same synchronous turn as cursor/timeline settlement; an owner transfer after replay must receive the replayed location. Add explicit projection tests showing that a successful mutation result whose `nextUndoEntryId` is the newly appended entry and a successful Undo result whose cursor has already moved are accepted, while a mismatching post-operation state leaves the frontend timeline uncommitted. In an Undo-then-edit test, include the entire invalidated redo suffix in backend `prunedEntryIds` and assert `acceptMutationResult` does not return those already-deleted IDs for cleanup. Add recovery tests proving a mismatch blocks new work, calls status/clear-history, rotates the epoch, resets the shared timeline and canonical presentation, reloads, then unblocks; a clear/reload failure keeps the entry blocked and performs no later user mutation.

- [ ] **Step 2: Run RED tests**

Run: `npm test -- src/features/notes/notesHistory.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts`

Expected: FAIL because history stores only entry-ID snapshot pairs and `maybeDeleteEntry` removes a final entry immediately.

- [ ] **Step 3: Implement the bounded timeline and owner/closing state**

```ts
interface CoordinatorEntry {
  // existing fields
  history: NotesHistorySession;
  ownerToken: number;
  owner: SessionState | null;
  closing: Promise<void> | null;
  pendingNext: PendingCoordinatorGeneration | null;
  historyRecovery: Promise<{
    workspace: NormalizedNotesWorkspace;
    snapshot: NotesHistorySnapshot;
  } | null> | null;
  historyBlocked: boolean;
  presentationBlocked: boolean;
  authoritativePresentation: {
    workspace: NormalizedNotesWorkspace;
    snapshot: NotesHistorySnapshot;
    pendingOwnerApply: boolean;
  } | null;
  pendingHistoryCleanupIds: Set<string>;
}

interface PendingCoordinatorGeneration {
  history: NotesHistorySession;
  sessions: Set<SessionState>;
  activation: Promise<void>;
}

function isOwner(entry: CoordinatorEntry, session: SessionState, token: number): boolean {
  return entry.owner === session && entry.ownerToken === token && session.active;
}
```

At append, truncate `entries.slice(cursor)` before adding; cap at 100 and return removed mutation IDs to the coordinator cleanup queue. Before later navigation preflight, mutation, or replay, `drainHistoryCleanup` calls `repository.pruneHistoryEntries` with the exact epoch/IDs; a failure leaves the IDs pending, starts no requested action, and never restores trimmed UI entries. `resetHistory(epoch, presentation)` atomically clears the mixed entries, old canonical/lease expansion references, and pending cleanup IDs; binds the new epoch; and installs the supplied current workspace/snapshot as the new canonical presentation, so stale cleanup/location state cannot survive a reset generation. Final close releases and clears the canonical presentation and all uncommitted leases.

Implement post-operation acceptance as clone/project/validate/commit. `acceptMutationResult` clones the current mixed timeline, truncates redo, appends the new structural mutation or updates the currently coalesced text-burst entry, applies the 100-entry cap and every backend `prunedEntryId`, adjusts the projected cursor, and only then compares the projected nearest mutation IDs with `state.nextUndoEntryId`/`state.nextRedoEntryId`. Its cleanup result subtracts every ID the backend already reported pruned, preventing a later missing-ID cleanup retry. `acceptReplayResult` first verifies that `entryId` is the current exact mutation candidate, moves a cloned cursor one step in `direction`, applies returned pruning and floor adjustment, validates the post-replay nearest IDs, and then commits the clone. Rejection mutates neither timeline nor cursor and forces the caller to reset/reload from the authoritative backend. `acceptPreparedNavigation` likewise excludes caller-supplied redo invalidation from hard-cap floor handling, validates projected post-truncation next IDs, and marks those IDs already cleaned so `appendNavigation` does not enqueue them again.

Intern sorted expansion-ID arrays by monotonically increasing semantic revision, retain them for controller/tag-origin/timeline references, and release them on redo truncation, capacity trim, origin clearing, reset, and close. Replace final `maybeDeleteEntry` removal with a `closing` promise. The frontend attempts pending cleanup and always invokes `repository.closeHistorySession`; the backend close command itself performs cached-connection eviction after releasing its DB guard even when cleanup/reconciliation/epoch validation fails. The frontend absorbs the close error, resolves the closing promise, and removes the registry entry in `finally`; it has no separate eviction call.

`openSession` encountering `closing` uses one `pendingNext` generation stored beside that closing entry. The first reopen allocates its fresh `NotesHistorySession`/`sessionId`; every concurrent reopen joins the same pending generation, shares that history object, and adds its activation waiter. After close settles, install exactly one new coordinator entry and call `initialize(vaultRoot, { sessionId: pendingNext.history.sessionId })` exactly once; resolve all joined activations from that result. Never expose or rebind the closing entry's history object or ID, and bind only the fresh returned epoch.

`recoverHistoryMismatch` is a coordinator-entry single-flight. It sets `historyBlocked = true` before any recovery I/O, so later mutation/navigation/replay work fails before a backend user mutation. It obtains current `historyStatus`, calls `clearHistory({ sessionId, historyEpoch: status.historyEpoch })`, requires `historyReset === true`, awaits the supplied authoritative scope reload, then calls `resetHistory` with the returned new epoch plus that reloaded workspace/current normalized snapshot before unblocking. This deliberately clears backend TEMP entries rather than rebinding an empty frontend timeline to a backend epoch that still has next IDs. If status, clear, or reload fails, keep the generation blocked, return `null`, and show a bottom-bar instruction to close/reopen the Vault; final close/eviction remains the guaranteed fallback and no further user mutation is admitted in the inconsistent generation.

Owner transfer considers only activated sessions opened with `presentation: "writable"`, lets already-admitted work settle into shared state, and drops queued stale-token intents. Before assigning a new owner token—on every transfer, not only when `pendingOwnerApply` is true—the coordinator calls the candidate's `applyHistoryLocation` with the current canonical workspace/snapshot. Only success clears `presentationBlocked` and permits token assignment/activation; false/throw leaves no writable owner, keeps the canonical location pending, and reports through the bottom bar. On the first writable activation, establish the canonical location from the loaded workspace and its `captureHistoryLocation`; later authoritative mutation results update the canonical workspace/snapshot in the same synchronous settlement turn. `isOwner`/token validation is an admission check only: once a queued item starts after passing it, ownership transfer or owner close cannot cancel its backend-result reconciliation, shared timeline settlement, or authoritative broadcast.

`reserveAdmittedNavigation(before)` runs immediately after origin capture and before destination loading, retaining the `before` expansion revision so owner teardown during that first await cannot invalidate it. Once loading succeeds, `lease.setDestination(workspace, after)` stores the normalized destination and retains `after`, still without publishing. Cancel at any pre-commit failure/no-op releases whichever lease refs were acquired exactly once. After `acceptPreparedNavigation` succeeds, parameterless `lease.commit()` is a non-throwing synchronous boundary: it transfers the lease's before/after refs to the new timeline entry, separately acquires an additional canonical retain for `after`, replaces/releases the old canonical retain, installs the destination, and returns cleanup IDs as one coordinator operation. Timeline and canonical presentation therefore own independent refs. `settleAuthoritativePresentation` follows the same acquire-new-before-release-old rule for mutation/replay snapshots. `resetHistory` acquires its replacement canonical ref before releasing old timeline/canonical/lease refs; final close releases every owner exactly once.

Commit then best-effort applies the complete scope/library/tag/zoom/selection/focus/expansion snapshot through the current writable owner's callback. Treat missing owner, `false`, and throw identically: keep `pendingOwnerApply = true`, set `presentationBlocked = true`, and reject every later mutation/navigation/replay before its repository call. The coordinator schedules an immediate retry against a still-current owner; whether that retry or a new writable activation succeeds, consume the triggering user action as `"skipped"` and admit only subsequent actions. Repeated failure keeps the block and instructs the user to close/reopen. Thus there is no failure-capable step between permanent redo deletion and navigation append/presentation authority, and no command can run from a view that has not accepted the canonical location.

Apply the same canonical-replacement and admission-block rule in `settleAuthoritativePresentation` after new mutations and both replay kinds. Queue admission checks both `historyBlocked` and `presentationBlocked`; neither flag is a UI-only hint. Every successful owner application clears only the presentation flag, while history mismatch recovery controls the history flag independently.

A background-only entry has no owner: both `enqueue` and `enqueueStructural` resolve `"skipped"`; background recovery sessions may observe state but never acquire ownership. Update every open-session call site and typed fixture explicitly: visible `useNotesWorkspace` sessions pass `presentation: "writable"` plus ref-backed capture/apply callbacks; recovery/background loaders pass `presentation: "background"` and no presentation callbacks.

- [ ] **Step 4: Run GREEN and focused regressions**

Run:

```bash
npm test -- src/features/notes/notesHistory.test.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.test.tsx
npm run build
```

Expected: PASS; the timeline preserves mixed order/coalescing/floor semantics, stale owners cannot enqueue, and close/reopen cannot share cleared TEMP history.

- [ ] **Step 5: Commit the coordinator/timeline task**

```bash
git add src/features/notes/notesHistory.ts src/features/notes/notesHistory.test.ts src/features/notes/notesWorkspaceCoordinator.ts src/features/notes/notesWorkspaceCoordinator.test.ts src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx
git commit -m "feat(notes): add shared session history timeline"
```

### Task 5: Route mutation completion, exact Undo/Redo, and permanent reset through the shared timeline

**Files:**
- Modify: `src/features/notes/useNotesWorkspace.ts:1721-1763,2351-2661,2881-3029,4899-4921`
- Modify: `src/features/notes/notesCommands.ts:1627-1659`
- Test: `src/features/notes/useNotesWorkspace.test.tsx`

**Interfaces:**
- Consumes: Task 4 timeline methods and owner token; Task 3 store outcomes.
- Produces a `replayHistory(direction)` that asks `session.history.next(direction)`: navigation restores a snapshot without SQLite and advances only through `commitReplay`; mutation calls the exact backend replay request and advances only through the projection-aware `acceptReplayResult`.
- Every replay first validates the current owner, drains pending cleanup, and checks `historyStatus`; even navigation-only replay cannot move the cursor across an epoch/next-entry mismatch.
- Produces `interface ResolvedHistoryLocation { workspace: NormalizedNotesWorkspace; snapshot: NotesHistorySnapshot }` in `useNotesWorkspace.ts` for replay and Task 6 navigation loading.
- `resolveHistoryLocation(snapshot): Promise<ResolvedHistoryLocation | null>` loads and normalizes the requested scope without publishing; failure returns `null` and preserves both the visible page and history cursor. Coordinator settlement performs the actual presentation/cursor commit.
- `resetHistoryAndReload(state)` delegates to coordinator `recoverHistoryMismatch`: clear authoritative backend TEMP history, rotate epoch, reset the shared timeline, reload the current scope, and only then resume commands.

- [ ] **Step 1: Write failing integration tests**

```tsx
it("uses the exact mutation entry requested by the shared timeline", async () => {
  const { result } = renderWorkspace(historyWithMutation("entry-a"));
  await act(() => result.current.actions.undo!());
  expect(repository.undo).toHaveBeenCalledWith(vaultRoot, expect.objectContaining({ expectedEntryId: "entry-a" }));
});

it("clears every frontend history reference only after empty trash reports historyReset", async () => {
  repository.emptyTrash.mockResolvedValue(resetWorkspace("epoch-b"));
  await act(() => result.current.actions.emptyTrash());
  expect(history.canUndo()).toBe(false);
});

it("keeps trash rows and mixed history when reset rejects a stale epoch", async () => {
  repository.emptyTrash.mockRejectedValueOnce(new Error("history epoch mismatch"));
  await act(async () => { await result.current.actions.emptyTrash(); });
  expect(history.canUndo()).toBe(true);
  expect(result.current.state.workspace.nodes).toEqual(beforeNodes);
  expect(bottomBar).toHaveTextContent("history epoch mismatch");
});

it("keeps the page and cursor when navigation replay cannot resolve its scope", async () => {
  loadLibraryScope.mockRejectedValueOnce(new Error("offline"));
  const before = history.next("undo");
  await act(() => result.current.actions.undo!());
  expect(result.current.state.activeScope).toBe("recent");
  expect(history.next("undo")).toBe(before);
});

it("clears backend history and rotates epoch before recovering a same-epoch mismatch", async () => {
  repository.historyStatus.mockResolvedValue(historyState("epoch-a", { nextUndoEntryId: "backend-only" }));
  repository.clearHistory.mockResolvedValue(resetState("epoch-b"));
  await act(() => result.current.actions.undo!());
  expect(repository.clearHistory).toHaveBeenCalledWith(vaultRoot, {
    sessionId: history.sessionId,
    historyEpoch: "epoch-a",
  });
  expect(history.historyEpoch).toBe("epoch-b");
  expect(repository.loadWorkspace).toHaveBeenCalled();
});

it("blocks later mutations when mismatch recovery cannot clear backend history", async () => {
  repository.clearHistory.mockRejectedValueOnce(new Error("busy"));
  await act(() => triggerProjectionMismatch());
  await act(() => result.current.actions.createNode!());
  expect(repository.createNode).not.toHaveBeenCalled();
  expect(bottomBar).toHaveTextContent("close and reopen");
});
```

Also add a navigation-replay owner-transfer RED case: Undo from B to A, activate another writable session, and assert it receives canonical A (including scope/tags/zoom/selection/focus/expansion) before obtaining an owner token. Add the equivalent mutation-replay/new-mutation canonical update assertion, plus false/throwing apply cases that block the next repository mutation until exact canonical retry succeeds.

- [ ] **Step 2: Run RED tests**

Run: `npm test -- src/features/notes/useNotesWorkspace.test.tsx`

Expected: FAIL because `replayHistory` calls the old `undo(vault, sessionId, scope)` and `emptyTrashCommand` only calls `clearSnapshots()`.

- [ ] **Step 3: Implement timeline-owned snapshot/replay plumbing**

```ts
const ownerToken = session.ownerToken();
if (!session.isCurrentOwner(ownerToken)) return;
await session.drainHistoryCleanup();
const status = await repository.historyStatus!(vaultRoot, session.history.sessionId);
if (!session.history.accepts(status)) return resetHistoryAndReload(status);
const entry = session.history.next(direction);
if (!entry) return;
if (entry.kind === "navigation") {
  const resolved = await resolveHistoryLocation(
    direction === "undo" ? entry.before : entry.after,
  );
  if (!resolved) return;
  session.history.commitReplay(direction);
  session.settleAuthoritativePresentation(resolved.workspace, resolved.snapshot);
  return authoritative(resolved.workspace);
}
const outcome = await repository[direction](vaultRoot, {
  sessionId: session.history.sessionId,
  historyEpoch: session.history.historyEpoch,
  expectedEntryId: entry.entryId,
  scope: activeScopeRef.current
});
if (outcome.kind !== "applied") return resetHistoryAndReload(outcome);
if (!session.history.acceptReplayResult(outcome, direction, entry.entryId)) {
  return resetHistoryAndReload(outcome);
}
const replayedSnapshot = direction === "undo" ? entry.before : entry.after;
session.settleAuthoritativePresentation(outcome.workspace, replayedSnapshot);
return authoritative(outcome.workspace);
```

For every successful mutation command, settle the post-operation state in this order:

```ts
const settlement = session.history.acceptMutationResult(
  result.historyEntryId,
  afterSnapshot,
  result,
);
if (!settlement.accepted) return resetHistoryAndReload(result);
session.settleAuthoritativePresentation(result.workspace, afterSnapshot);
session.queueHistoryCleanup(settlement.unreachableEntryIds);
return authoritative(result.workspace);
```

```ts
async function resetHistoryAndReload(
  state: NotesHistoryState,
): Promise<NotesWorkspaceQueueResult> {
  const recovered = await session.recoverHistoryMismatch(state, () =>
    resolveCurrentHistoryLocationWithoutPublishing(),
  );
  if (!recovered) {
    return {
      kind: "failure",
      error: "Undo/Redo history could not be synchronized. Close and reopen this Vault.",
    };
  }
  reportNotesMessage("Undo/Redo history was reset to recover synchronization.");
  return { kind: "authoritative", workspace: recovered.workspace, scopeAgnostic: false };
}
```

Keep `buildHistorySnapshot` and `reconcileUiState`; replace hook-local `historyOwnerByEntryIdRef` ownership with coordinator timeline append calls. `acceptMutationResult` receives the exact non-null `historyEntryId`, after-snapshot, returned epoch, hard-pruned IDs, and post-mutation next IDs. It projects the append/coalesced update before validation; only an accepted result may settle the authoritative workspace/snapshot, and every returned unreachable ID is immediately queued. `settleAuthoritativePresentation` runs synchronously after successful mutation/replay cursor settlement and before returning the queue result; it replaces the coordinator's canonical workspace/snapshot, applies it to the current owner, and activates the same presentation block/retry rules on false/throw. This keeps owner transfer after navigation Undo/Redo, mutation Undo/Redo, or a new edit aligned with the mixed cursor.

A rejected result leaves the local timeline untouched and invokes the concrete backend-clear recovery above. `entryMissing`, `entryNotNext`, epoch/next-ID preflight mismatch, and post-replay projection rejection use the same path. The helper returns an authoritative queue result instead of publishing from a possibly stale hook, so coordinator settlement synchronizes the recovered workspace to the current owner before the next queued action. Discard provisional context on no-op/failure. Never feed a post-operation mutation or replay state through the pre-operation `accepts` method or reset only the frontend while backend next IDs remain.

Derive `canUndo/canRedo` from `session.history`. `emptyTrashCommand` sends `{ sessionId, historyEpoch }`, requires `historyReset === true`, builds the normalized current presentation from the returned workspace, and calls coordinator-level `session.resetHistory(result.historyEpoch, presentation)` only after the authoritative result; clear-history passes its current confirmed workspace/snapshot to the same atomic coordinator reset. A reset failure changes neither frontend data, cursor, pending cleanup, canonical presentation, nor epoch. Route replay, resolution, and reset failures through the existing Notes bottom-bar feedback API. A navigation replay resolution failure returns `null`; the caller must not call `commitReplay` or settle presentation, so page, canonical location, and cursor remain unchanged.

- [ ] **Step 4: Run GREEN and regression tests**

Run: `npm test -- src/features/notes/useNotesWorkspace.test.tsx src/features/notes/notesWorkspaceCoordinator.test.ts`

Expected: PASS; mutation replay uses expected IDs, navigation replay never calls backend replay, epoch/missing outcomes reset/reload, and empty trash resets atomically.

- [ ] **Step 5: Commit the workspace replay/reset task**

```bash
git add src/features/notes/useNotesWorkspace.ts src/features/notes/useNotesWorkspace.test.tsx src/features/notes/notesCommands.ts
git commit -m "feat(notes): replay shared session history"
```

### Task 6: Implement one history-aware navigation boundary and composition deferral

**Files:**
- Modify: `src/features/notes/useNotesWorkspace.ts:3031-3368,3722-3728`
- Modify: `src/features/notes/NotesOutlinePane.tsx:1874-1879,3171-3181`
- Test: `src/features/notes/useNotesWorkspace.test.tsx`
- Test: `src/features/notes/NotesWorkspace.test.tsx`
- Test: `src/features/notes/NotesLibraryPane.test.tsx`
- Test: `src/features/notes/NotesQuickJump.integration.test.tsx`
- Test: `src/features/notes/NotesPageHeader.test.tsx`
- Test: `src/features/notes/outlineKeyboard.test.ts`
- Test: `src/components/AppStatusBar.test.tsx`

**Interfaces:**
- Consumes: `session.enqueueStructural`, owner token, `repository.historyStatus`, `repository.prepareNavigation`, and Task 4/5 history location helpers.
- Produces:

```ts
type ResolvedNavigation = ResolvedHistoryLocation;
type NavigationIntent = () => Promise<ResolvedNavigation | null>;
async function navigateWithHistory(intent: NavigationIntent): Promise<void>;
function setOutlineCompositionActive(active: boolean): void;
```

All current `actions.zoomTo`, `selectLibraryView`, `toggleTagFilter`, and `openSearchResult` call this boundary; button components remain simple callers.

- [ ] **Step 1: Write failing behavior tests across every existing caller**

```tsx
it("records bullet zoom only after status preflight and prepare-navigation guard", async () => {
  const { getByLabelText } = renderOutline();
  await userEvent.click(getByLabelText("Zoom into Child"));
  expect(repository.historyStatus).toHaveBeenCalled();
  expect(repository.prepareNavigation).toHaveBeenCalled();
  expect(sharedHistory.next("undo")?.kind).toBe("navigation");
});

it("defers the latest requested navigation until compositionend", async () => {
  fireEvent.compositionStart(outlineRoot);
  await userEvent.click(zoomA);
  await userEvent.click(zoomB);
  expect(repository.prepareNavigation).not.toHaveBeenCalled();
  fireEvent.compositionEnd(outlineRoot);
  await waitFor(() => expect(state.zoomRootId).toBe("b"));
});
```

Cover every source in the approved contract: bullet, breadcrumb, parent, Home/root, All/Starred/Recent/Archive/Trash, single/multi-tag, search result, and quick jump. Add RED cases for a same destination, failed draft flush, failed destination load, connection replacement during load, stale owner token before admission, automatic fallback, and replay-driven restore; each must leave both current page and cursor unchanged as applicable. An automatic non-user fallback adds no timeline entry but must replace canonical presentation, so a later owner receives the visible fallback rather than the stale page. Add in-flight ownership cases: resolve `prepareNavigation` after a new writable owner activates and after the original owner disappears leaving only a background session. In both, the reserved destination and shared navigation entry commit exactly once; the current/next writable owner receives the complete workspace and scope/library/tag/zoom/selection/focus/expansion location equal to the appended `after` snapshot before its activation settles. Add a capacity case where the 101st mixed entry is navigation, assert its evicted mutation ID enters `queueHistoryCleanup`, and prove the next action drains that ID before status preflight. Verify navigation-only Undo still calls status preflight, all existing Cmd/Ctrl+Z/Shift+Z/Y routes use the mixed cursor, missing zoom restores the scope overview, empty scopes focus their safe container, and errors render in `AppStatusBar` without the old upper-right message.

- [ ] **Step 2: Run RED tests**

Run: `npm test -- src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesQuickJump.integration.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/outlineKeyboard.test.ts src/components/AppStatusBar.test.tsx`

Expected: FAIL because `zoomTo` is only `applyAction({ type: "setZoomRoot" })` and current library/tag/search paths bypass history.

- [ ] **Step 3: Implement the boundary in one place**

```ts
const navigateWithHistory = useCallback(async (intent: NavigationIntent) => {
  const ownerToken = session.ownerToken();
  if (compositionActiveRef.current) {
    pendingNavigationRef.current = { ownerToken, intent };
    return;
  }
  await session.enqueueStructural(async () => {
    if (!session.isCurrentOwner(ownerToken)) return { kind: "skipped" };
    await session.drainHistoryCleanup();
    session.history.closeTextBurst();
    const status = await repository.historyStatus!(vaultRoot, session.history.sessionId);
    if (!session.history.accepts(status)) return resetHistoryAndReload(status);
    const before = captureHistorySnapshot();
    const presentation = session.reserveAdmittedNavigation(before);
    try {
      const resolved = await intent();
      if (!resolved || sameHistoryLocation(before, resolved.snapshot)) {
        presentation.cancel();
        return { kind: "skipped" };
      }
      presentation.setDestination(resolved.workspace, resolved.snapshot);
      const invalidatedRedoIds = session.history.unreachableRedoMutationIds();
      const guard = await repository.prepareNavigation!(vaultRoot, {
        sessionId: session.history.sessionId,
        historyEpoch: session.history.historyEpoch,
        unreachableRedoEntryIds: invalidatedRedoIds
      });
      if (!session.history.acceptPreparedNavigation(guard, invalidatedRedoIds)) {
        presentation.cancel();
        return resetHistoryAndReload(guard);
      }
      session.queueHistoryCleanup(presentation.commit());
      return authoritative(resolved.workspace);
    } catch (cause) {
      presentation.cancel();
      throw cause;
    }
  }, { requireAllBarriers: true });
}, [captureHistorySnapshot, repository, vaultRoot]);
```

`requireAllBarriers: true` flushes drafts from every active coordinator session; once the callback passes its first owner-token check it is admitted, and later ownership transfer cannot cancel backend reconciliation or shared-timeline settlement. The explicit `closeTextBurst()` call closes the current burst before status validation and `before` capture. Reserve `before` before destination loading, then attach/retain `{ workspace, after }` immediately after it resolves and before `prepareNavigation`; an error, no-op, or rejected guard cancels and releases the reservation without changing presentation/timeline. After `acceptPreparedNavigation` succeeds, parameterless `presentation.commit()` cannot fail: it transfers the lease refs to the timeline, acquires a separate canonical `after` retain, installs the coordinator-owned full location, and appends the navigation synchronously. A missing/false/throwing UI application sets the presentation admission block until exact retry succeeds; it never leaves an old-page owner free to mutate. Pass the commit's cap-evicted IDs to `queueHistoryCleanup`.

Use the existing root composition capture in `NotesOutlinePane` to call `actions.setOutlineCompositionActive(true|false)`; on end consume only the last deferred intent when its owner token is still current. Reuse current `loadLibraryScope`, tag canonicalization, `searchNavigation`, `restoredTagFilterNavigation`, and reducer `existingId` normalization to build a `ResolvedNavigation` without publishing either its loaded workspace or UI snapshot. `acceptPreparedNavigation` applies hard-cap pruning, distinguishes caller-requested redo invalidation, and validates exact projected next IDs before the infallible lease commit. For replay, call the same loader with `{ record: false }`; filter expansion IDs, clear missing selected/focus IDs, and set missing zoom root to `null` (scope overview). A load or guard failure leaves no new navigation entry and reports through the bottom bar; ownership loss after admission stores the complete `after` snapshot as authoritative pending presentation rather than losing redo or recording an unseen destination.

Automatic recovery/fallback navigation stays outside the mixed Undo timeline, but its successful reducer/workspace transition must call `settleAuthoritativePresentation` in the same synchronous turn. This changes only the coordinator's canonical visible location, not the cursor, and uses the same presentation-block rule on callback failure.

- [ ] **Step 4: Run GREEN and complete frontend regression suite**

Run:

```bash
npm test -- src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesQuickJump.integration.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/outlineKeyboard.test.ts src/components/AppStatusBar.test.tsx
npm test
```

Expected: PASS; bullet/breadcrumb/home/library/tag/search/quick-jump are one chronological action, no-op/failed/stale/replay navigation adds none, IME defers only the last intent, and scope replay normalizes missing IDs safely.

- [ ] **Step 5: Commit the navigation task**

```bash
git add src/features/notes/useNotesWorkspace.ts src/features/notes/NotesOutlinePane.tsx src/features/notes/useNotesWorkspace.test.tsx src/features/notes/NotesWorkspace.test.tsx src/features/notes/NotesLibraryPane.test.tsx src/features/notes/NotesQuickJump.integration.test.tsx src/features/notes/NotesPageHeader.test.tsx src/features/notes/outlineKeyboard.test.ts src/components/AppStatusBar.test.tsx
git commit -m "feat(notes): make navigation undoable"
```

### Task 7: Full verification and manual Tauri proof

**Files:**
- Modify: only test files needed to fix a concrete regression found by the commands below.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified end-to-end behavior; no new production interface.

- [ ] **Step 1: Run all automated verification**

Run:

```bash
npm test -- --maxWorkers=4
npm run lint
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml --all-targets --locked
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked
npm run tauri:build -- --debug
git diff --check
git status --short
```

Expected: every command exits `0`; no formatting whitespace errors; all current Notes, domain, service, and Rust history regressions pass.

- [ ] **Step 2: Run the manual desktop smoke check**

Run: `npm run tauri:dev`

Expected interaction proof: type in A, bullet-zoom B, type in B; Undo removes B text, Undo returns A, Undo removes A text; redo is exact inverse. Repeat after deleting/restoring an image, after emptying Trash (history disabled/reset), and after closing/reopening the Vault (history empty, live notes preserved).

- [ ] **Step 3: Preserve task boundaries after verification**

Do not create a verification-only commit. If a command exposes a defect, return to the task that owns its file, add a focused RED test there, and create that task's documented commit after its focused and full regressions pass.

## Spec Coverage Self-Review

- TEMP-only history, v1→v2 migration, epoch creation/replacement, limits, attachment reconciliation, and final-close cleanup: Tasks 1–2.
- Exact entry ID replay, discriminated errors, next IDs, pruning/floor, and backend reset: Task 2 plus Task 4 tests.
- Strict frontend wire validation: Task 3.
- Vault-shared timeline, text coalescing, owner token, controller transfer, final-close/reopen race, and expansion pooling: Task 4.
- Content replay snapshots and empty-trash timeline reset: Task 5.
- All listed navigation origins, mandatory preflight/guard, IME deferral, no-op/error behavior, replay normalization, and keyboard dispatcher: Task 6.
- Full test/lint/build/Tauri validation: Task 7.

Type-name consistency checked: Rust `NotesHistoryState` serializes camelCase for TypeScript `NotesHistoryState`; `historyEpoch`, `expectedEntryId`, `nextUndoEntryId`, `nextRedoEntryId`, `prunedEntryIds`, and `historyReset` use those exact names in Tasks 2–6. `NotesSessionHistoryEntry` and `NotesHistorySnapshot` originate in Task 4 and are consumed by Tasks 5–6.
