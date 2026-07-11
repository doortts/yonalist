# Task 7 Backend Second Re-review Report

## Status

DONE_WITH_CONCERNS

Fix commit: the commit containing this report (exact SHA is returned in the task
response).

## Changed Files

- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/src/notes/attachments.rs`
- `src-tauri/src/notes/commands.rs`
- `src-tauri/src/notes/repository.rs`
- `.superpowers/sdd/task-7-backend-report.md`

No frontend TypeScript, TSX, or CSS file was modified, staged, reverted, or
committed by this backend fix. Concurrent frontend work remains untouched.

## Review Fixes

- Post-commit attachment cleanup is best effort for ordinary mutations, import,
  Undo/Redo, history clear, Empty Trash, startup expiry, restore, and database
  deletion. Reconcile/remove/directory-sync failures no longer turn a committed
  operation into an API error. They create and fsync
  `.yonalist/.notes-assets-reconcile-needed`; startup performs full reachability
  repair and clears the marker. If the marker itself cannot be persisted, the
  successful command emits an explicit cleanup warning.
- PNG, GIF, and WebP containers are inspected with bounded, allocation-free
  header/chunk walks before image decoding. APNG `acTL`, a second GIF image
  descriptor, and WebP animation flags/chunks are rejected. Valid static
  PNG/JPEG/GIF/WebP continue through bounded maintained `image` decoding. Tests
  use real static files plus real/structured animated, truncated, and
  container-work-limit fixtures for all three animation-capable formats.
- Every attachment mutation takes the per-vault interprocess storage lease before
  opening SQLite work. Import then starts `BEGIN IMMEDIATE` before publication,
  retains both locks through metadata/history commit, and revalidates the held
  `.yonalist`, lock, asset-directory, and database identities immediately before
  rename and before commit. Identity capture is also bound to the actual SQLite
  connection path. Independent lock handles and connections prove reconciliation
  cannot enter between publication and metadata commit.
- Asset operations use held `cap-std` directory handles opened without following
  the final symlink. Publication, read, enumeration, and removal stay relative to
  those handles. Database deletion enumerates only canonical owned names, opens
  each entry no-follow, verifies it is a regular file, removes it relative to the
  held handle, syncs, and removes only the now-empty directory. There is no
  recursive deletion API in the attachment/database-delete path.
- The process-global import budget guard is stored inside `PreparedAttachment`,
  so the source byte allocation remains serialized across vaults through
  publication and database completion. The per-vault file lease provides the
  cooperating cross-process budget. Both guards release by RAII on every error.
- Source import opens the parent capability and then opens the source basename
  no-follow. Unix adds `O_NONBLOCK`; only after open does `fstat` verify regular
  file type and the 1..=20 MiB size bound. This closes the pathname metadata/FIFO
  race while preserving bounded reads and the 40M decoded-pixel limit.

Prior contracts remain intact: hash dedupe, atomic owned-directory temp publish
with file and directory fsync, metadata-failure reconciliation without deleting a
potentially shared hash, live/Trash/Archive/history retention, targeted cleanup
after global history eviction, and full byte validation before Undo/Redo restores
attachment metadata.

## API And Wire Contract

The command surface is unchanged:

- `notes_import_attachment`
- `notes_read_attachment_bytes`
- `notes_resize_attachment`
- `notes_remove_attachment`
- `notes_restore_attachment`

Reads remain attachment-ID-only; no command accepts an arbitrary read path.
`attachmentsByNodeId` remains deterministic and each vector is ordered by
`sortKey`, then `id`. Display width remains bounded to
`min(160, intrinsicWidth)..=intrinsicWidth`, so metadata cannot upscale an image.
Cleanup warnings are backend diagnostics and do not change the wire schema.

## Strict TDD Evidence

### RED

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-rereview-target \
  cargo test --manifest-path src-tauri/Cargo.toml notes_attachment -- --nocapture
```

Exit 101: 16 passed, 2 failed. Animated GIF bytes were accepted and source
import followed a symlink.

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-rereview-target \
  cargo test --manifest-path src-tauri/Cargo.toml \
  notes_attachment_import_budget_lives_until_prepared_bytes_are_released -- --nocapture
```

Exit 101: 0 passed, 1 failed. A second vault multiplied the live prepared-byte
allocation.

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-rereview-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml notes_attachment --no-run
```

Exit 101 at compile time before implementation: the cleanup failpoints,
coordinated attachment transaction, bounded container limit, storage/database
identity APIs, and reconciliation marker APIs required by the tests were absent.

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-rereview-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
  notes_attachment_storage_detects_replaced_database_and_lock_identities -- --nocapture
```

Exit 101: 0 passed, 1 failed. Identity capture accepted an unrelated SQLite
connection.

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-rereview-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
  notes_attachment_import_and_empty_trash_cleanup_failures_do_not_mask_commits -- --nocapture
```

Exit 101: 0 passed, 1 failed. Injected sync failure was consumed during
publication and masked the import instead of exercising post-commit cleanup.
A later RED extension of the same test also exited 101 because startup cleared
the repair marker without retrying a previously failed asset-directory fsync.

### GREEN

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-rereview-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml notes_attachment -- --nocapture
```

Exit 0: 24 passed, 0 failed.

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-rereview-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml notes_history -- --nocapture
```

Exit 0: 17 passed, 0 failed.

Coverage includes reconcile/remove/sync failure recovery after committed import,
history clear, Empty Trash, and ordinary history eviction; independently opened
storage/SQLite contenders; directory/database/lock identity replacement; static,
animated, truncated, and container-limit image fixtures; no-follow symlink/FIFO
source handling; held import-budget lifetime; missing/corrupt replay bytes; and
nonrecursive database deletion around nested directories and symlinks.

## Verification

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-rereview-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Exit 0: 171 passed, 0 failed; binary and doc tests also passed.

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Exit 0.

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-rereview-target \
  cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- \
  -D warnings -A clippy::ptr-arg -A clippy::too-many-arguments \
  -A clippy::manual-split-once -A clippy::flat-map-identity \
  -A clippy::bool-assert-comparison
```

Exit 0. Ordinary Clippy also exits 0 and reports only those five established
repository-wide lint classes; no new attachment lint was reported.

```bash
test -z "$(rg -n 'remove_(open_dir_all|dir_all)|remove_dir_all' \
  src-tauri/src/notes/attachments.rs src-tauri/src/notes/commands.rs)"
```

Exit 0: no recursive removal API is present in the cross-platform deletion path.

## Threat Model And Concerns

- Cooperating Yonalist processes are serialized by the same per-vault file lease
  and SQLite `BEGIN IMMEDIATE` protocol, including publish-before-metadata and
  reconciliation. This is the supported multi-process threat model.
- An actively malicious local process that replaces an already-open vault root or
  lock inode is outside the local application threat model. Stable-path identity
  replacement is detected before publication and commit, but the backend does not
  claim containment against an attacker continuously renaming those roots between
  checks.
- Capability, file-lock, no-follow, and FIFO behavior was executed on macOS. No
  Windows runner was available. Windows safety is covered structurally by the
  held-directory enumeration/removal design and the no-recursive-API check, not by
  a Windows runtime test.
- Tests use independent OS lock handles and SQLite connections in separate
  threads, exercising the same kernel/interprocess primitives without spawning a
  second test executable.
