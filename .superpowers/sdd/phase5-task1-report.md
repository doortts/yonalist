# Phase 5 Task 1 Implementation Report

## Status

Implemented and verified on branch `codex/notes-workflowy` from base commit
`901ebc1`.

This task resolves the stale output wording by delivering only the shared atomic
file helper and immutable Notes export snapshot foundation. It does not add
Markdown or PDF renderers, renderer stubs, Tauri commands, dialog dependencies,
capabilities, resources, fonts, services, or UI.

## Scope Delivered

### Shared atomic file output

- Added byte-oriented `write_atomic_file(path, bytes, overwrite)` in
  `src-tauri/src/file_io.rs`.
- Creates missing parent directories, writes through a sibling `<name>.tmp`
  file, calls `sync_all` before rename, and removes the temp file after any
  write/sync/rename error.
- Returns the stable `Destination already exists.` conflict when the target
  exists and `overwrite` is false.
- Preserves non-UTF-8 path support by constructing the temp name as an
  `OsString`, matching the prior vault writer behavior.
- Moved `ensure_parent` and `write_text_file_inner` into `file_io`; the existing
  text path delegates to `write_atomic_file(..., true)`, preserving parent
  creation and overwrite behavior for current vault commands.
- The helper is filesystem-only and has no Notes imports, SQLite access, or
  document-hash behavior.

### Immutable Notes export snapshot

- Added `NotesExportSnapshot` and recursive `ExportNode` read models in
  `src-tauri/src/notes/types.rs` with the stable fields required by both later
  renderers:
  - snapshot: `root_node_id`, `title`, `exported_at`, `root`
  - node: `id`, `title`, `note`, `completed`, `children`
- Added `load_export_snapshot` as an export-facing function in
  `src-tauri/src/notes/export.rs`, backed by the read implementation in
  `src-tauri/src/notes/repository.rs`.
- Reads the entire active subtree and UTC export timestamp with one recursive
  SQLite statement. It does not call `with_workspace_transaction` or any other
  mutation helper.
- Starts at exactly the requested active node and follows only active child
  edges. Soft-deleted nodes are excluded.
- Ignores `is_collapsed`; descendants of collapsed nodes are included.
- Derives `completed` solely from `completed_at.is_some()`.
- Sorts every sibling list by `(sort_key, id)` before recursive assembly, so
  equal sort keys remain deterministic and no `HashMap` iteration order leaks
  into output.
- Rejects invalid root IDs, missing/deleted roots, detected recursive cycles,
  missing-parent assembly corruption, and incomplete assembly with errors
  rather than returning a partial tree.
- The snapshot load leaves SQLite rows unchanged; the native fixture checks
  `total_changes()` before and after the read.

## TDD Evidence

### Baseline

Before edits:

```text
cargo test --manifest-path src-tauri/Cargo.toml
74 passed; 0 failed
```

### RED

Tests and module declarations were added before production implementations.

```text
cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests
```

Exited `101` with only the intended missing-API failures after correcting one
fixture typo:

```text
unresolved import `super::write_atomic_file`
unresolved import `super::load_export_snapshot`
```

### GREEN and regression checks

```text
cargo test --manifest-path src-tauri/Cargo.toml notes::export::tests
3 passed; 0 failed

cargo test --manifest-path src-tauri/Cargo.toml file_io::tests
4 passed; 0 failed

cargo test --manifest-path src-tauri/Cargo.toml write_text_file
2 passed; 0 failed

cargo test --manifest-path src-tauri/Cargo.toml
81 passed; 0 failed; 0 ignored
```

Snapshot coverage verifies active-only traversal, `(sort_key, id)` order,
title/note content, completion derivation, collapsed descendant inclusion,
no row mutation, missing/deleted root rejection, and cycle rejection.

Atomic-output coverage verifies arbitrary bytes, nested parent creation,
conflict refusal without destination changes, allowed replacement, sibling temp
cleanup after success, and cleanup when rename fails.

## Additional Verification

```text
rustfmt --edition 2021 --check \
  src-tauri/src/file_io.rs \
  src-tauri/src/notes/export.rs \
  src-tauri/src/notes/repository.rs \
  src-tauri/src/notes/types.rs
exit 0

git diff --check
exit 0
```

`cargo fmt --check` was not used to rewrite the whole crate because the base
commit contains unrelated rustfmt drift in `src-tauri/src/lib.rs`; formatting
was checked directly for the owned modules instead.

Strict Clippy was also run:

```text
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The new fixture initially contributed one lint, which was removed. The rerun
reports only three pre-existing findings from `901ebc1`:

- `clippy::ptr_arg` at `src-tauri/src/notes/repository.rs:75`
- `clippy::too_many_arguments` at `src-tauri/src/lib.rs:856`
- `clippy::manual_split_once` at `src-tauri/src/lib.rs:1088`

They were left untouched because they are unrelated to Task 1.

## Changed Paths

- `.superpowers/sdd/phase5-task1-report.md`
- `src-tauri/src/file_io.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/notes/export.rs`
- `src-tauri/src/notes/mod.rs`
- `src-tauri/src/notes/repository.rs`
- `src-tauri/src/notes/types.rs`

No plan or progress-ledger file was edited.

## Concerns and Deferred Work

- A later export command must decide how to open an existing Notes database
  without initialization or migration if the product interprets “export does
  not mutate Notes data” to include schema/storage metadata. This task accepts
  an existing `Connection` and performs a single read statement, so it does not
  make that command-layer decision prematurely.
- The sibling temp name is deterministic (`<destination>.tmp`), matching the
  approved helper shape and the prior vault behavior. Concurrent writes to the
  same destination are therefore serialized only by filesystem outcomes, not
  by an application lock; later command work should avoid overlapping exports
  to an identical path.
- Strict Clippy remains non-zero because of the three baseline findings listed
  above. Native tests, owned-file formatting, and whitespace validation pass.
