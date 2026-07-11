# Task 2 Atomic Mutation Result Report

## Status

Complete on base `7752f55`. The implementation commit is the commit containing this
report; its final hash is recorded in the task closeout.

## Contract

All journalable note and attachment Tauri commands now return the exact camel-case
wire shape:

```text
NotesMutationResult { workspace, historyEntryId, canUndo, canRedo }
```

- `historyEntryId` is the input entry ID only when that entry still has a journal row
  after compaction and pruning.
- `canUndo` and `canRedo` are captured after redo invalidation and bounded-stack
  pruning, inside the same SQLite transaction that finalizes the journal entry.
- A mutation without history context returns `historyEntryId: null` and
  `canUndo: false, canRedo: false`, even if another session exists in the database.

## Implementation

- Added the serializable Rust and TypeScript `NotesMutationResult` contracts.
- Captured mutation metadata in a connection-local temporary result row from
  `finalize_transaction`, before the repository transaction commits. Command cleanup
  reads the captured values; it does not issue a later history-status query.
- Wrapped create, update, split, move, complete, collapse, star, duplicate, remove,
  Trash, restore, Archive, unarchive, and import/resize/remove/restore attachment
  commands. Attachment publication, validation, reconciliation, and retained-byte
  ordering are unchanged.
- Made the desktop adapter strict: malformed wrappers and a non-null entry ID that
  differs from the supplied history context are rejected.
- Preserved custom/non-history `NotesStore` implementations with a
  `NotesWorkspace | NotesMutationResult` compatibility response. The production Tauri
  adapter returns only `NotesMutationResult`.
- Unwrapped atomic results in `useNotesWorkspace`. Successful direct and compound
  mutations publish the atomic status to the finalized coordinator, avoiding its
  fallback status query. Activation and legacy/recovery paths retain `historyStatus`.
- Compound operations retain the last committed workspace, atomic status, and actual
  backend entry IDs when a later step fails. Null journal entries discard pending UI
  snapshots instead of creating frontend-only history.

## TDD Evidence

### Rust RED

`cargo test --manifest-path src-tauri/Cargo.toml mutation_commands_return_the_committed_history_result_atomically`
exited 101. Compilation failed because `NotesMutationResult` did not exist and note
commands still returned `NotesWorkspace` without `historyEntryId/canUndo/canRedo`.

### Rust GREEN

- Atomic command test: 1 passed.
- Attachment import/resize/remove/restore atomic result test: 1 passed.
- Focused history: 17 passed.
- Focused commands: 20 passed.
- All Rust Notes: 148 passed.

### TypeScript RED

`npm test -- src/domain/notes.test.ts src/services/notesStore.tauri.test.ts src/features/notes/useNotesWorkspace.test.tsx`
exited 1 with 3 expected failures among 118 tests: the domain guard was absent, a
compound treated its first wrapper as a workspace and skipped the second step, and a
direct mutation failed to install the wrapped workspace/status.

### TypeScript GREEN

- Focused domain/store/coordinator/hook run: 4 files, 132 passed.
- All Notes plus domain/store adapter final run: 24 files, 588 passed.
- Final focused adapter run: 20 passed, including malformed-wrapper and mismatched-ID
  rejection.

## Verification

- `npm run build`: passed; TypeScript and Vite completed with 2,288 modules.
- Full Rust suite: 187 passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- Strict all-target Clippy was run and stopped on five unchanged baseline warnings:
  `ptr_arg`, `too_many_arguments`, `manual_split_once`, `flat_map_identity`, and
  `bool_assert_comparison` in pre-existing repository/export/history/crate-root lines.
- All-target Clippy with only those five baseline lint classes allowed passed under
  `-D warnings`, demonstrating no warning introduced by this task.
- `git diff --check`: passed.

## Scope And Compatibility

- Structured-tag contracts and coordinator cutoff semantics from current HEAD are
  integrated, not reverted.
- `historyStatus` remains available for activation, recovery, and legacy stores; an
  atomic mutation result takes precedence when present.
- Non-history Rust repository helpers still return `NotesWorkspace`.
- Empty Trash remains a permanent, non-journalable workspace command and is not
  wrapped.
- Tag, date, image UI behavior and attachment storage safety behavior were not
  changed.

## Final Review Closure

### Findings Fixed

- Text bursts are keyed by `(nodeId, field)`. A history-enabled title-to-note or
  note-to-title transition closes and flushes the prior burst before allocating the
  next entry, including when the prior blur flush is still pending. Legacy stores
  without history support retain their existing combined draft-save behavior.
- A direct atomic mutation remains authoritative if a selected-scope projection
  reload fails. The hook retains the atomic workspace, actual entry ID, and status,
  completes the committed snapshot, reports the projection error, and broadcasts a
  scope-agnostic invalidation. It does not issue a post-mutation status query.
- Compound split, move, and remove settlement uses only actual committed entry IDs
  returned by atomic steps. An inline result with a null or pruned entry ID discards
  its pending UI snapshot and owner instead of completing frontend-only history.

### Review TDD Evidence

- Field identity RED: 2 expected failures among 106 tests; the pure history session
  and fast title-to-note hook both reused the title entry for the note.
- Projection authority RED: 5 expected failures among 116 tests; update, complete,
  duplicate, and restore lost atomic status, and the coordinator broadcast the
  failure as selected-scope data.
- Null inline RED: 3 expected failures among 104 hook tests; split and move restored
  stale source focus, while remove restored an invalid deleted-source snapshot.
- Combined GREEN: history, coordinator, and hook focused run passed 128 tests.
- Legacy compatibility GREEN: the pre-existing stale-response UI test and 15 focused
  field/projection/null tests passed after limiting immediate field flushes to stores
  with an actual history context.

### Final Verification

- All Notes frontend/domain/adapter tests: 24 files, 637 passed.
- Production build: passed; TypeScript and Vite completed with 2,290 modules.
- Rust history: 17 passed; Rust commands: 21 passed; all Rust Notes: 157 passed.
- Rust formatting: passed.
- Strict all-target Clippy stopped only on the five documented baseline lint classes.
  The all-target `-D warnings` run allowing only those classes passed.
- Task-owned diff whitespace validation passed. Unrelated in-progress date/export
  changes in the shared worktree were preserved and excluded from the Task 2 commit.
