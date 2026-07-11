# Task 7 Backend Review Fix Report

## Status

DONE_WITH_CONCERNS

Fix commit: this commit (exact SHA reported in the task response).

## Owned Files

- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/src/notes/attachments.rs`
- `src-tauri/src/notes/commands.rs`
- `src-tauri/src/notes/history.rs`
- `.superpowers/sdd/task-7-backend-report.md`

No frontend TypeScript, TSX, or CSS file was modified, staged, reverted, or
committed by this backend fix.

## Review Fixes

- Replaced the process-local storage mutex with an exclusive per-vault file lock
  at `.yonalist/.notes-assets.lock`. Every backend mutation now takes the storage
  lease before opening its database transaction, preserving one lock order across
  import publication, metadata history, replay, reconciliation, and cleanup.
- Added a process-global import budget mutex inside the per-vault lease. Source
  inspection, the bounded 20 MiB read, format validation, hashing, and all decoded
  frame work occur while both limits are held.
- Replaced ambient asset operations with `cap-std`/`cap-fs-ext` directory-handle
  operations. `notes-assets` is opened without following its final symlink and the
  verified directory identity is retained for create-new temporary files, fsync,
  rename, read, enumeration, targeted removal, and recursive deletion.
- Kept hash deduplication and publish durability: temporary files are created in
  the held asset directory, flushed and fsynced, atomically renamed relative to
  that same handle, and cleaned after failure. Metadata failure still runs full
  reachability reconciliation instead of deleting a possibly shared hash.
- Fully iterates GIF, animated WebP, and APNG frames through the maintained
  `image` decoders. Validation enforces 256 frames and 40,000,000 cumulative
  decoded pixels in addition to the existing per-image 40,000,000-pixel and
  20 MiB limits. Static PNG/JPEG/WebP/GIF remain accepted.
- Undo/Redo now decodes each target attachment snapshot and validates that its
  owned bytes still exist and match hash, MIME type, byte size, and intrinsic
  dimensions before any replay row is applied. Validation errors roll back both
  metadata and history position atomically.
- History pruning records attachment paths from globally evicted entries and
  invalidated redo entries in a connection-local temporary table. Ordinary note
  mutations reconcile only those candidates after commit and recheck complete
  live/history reachability, avoiding a directory scan for every edit.
- Full reconciliation remains on attachment lifecycle, startup expiry, history
  clear, Empty Trash, and database deletion, preserving live/Trash/Archive/history
  retention and prompt cleanup.

## API And Wire Contract

The command surface is unchanged:

- `notes_import_attachment`
- `notes_read_attachment_bytes`
- `notes_resize_attachment`
- `notes_remove_attachment`
- `notes_restore_attachment`

Reads remain attachment-ID-only; no command accepts an arbitrary read path.
`attachmentsByNodeId` remains a deterministic map whose vectors are ordered by
`sortKey`, then `id`. Width validation remains
`min(160, intrinsicWidth)..=intrinsicWidth`, so persisted widths cannot upscale.
The attachment audit JSON and global expected-state replay checks are unchanged.

## Strict TDD Evidence

### Behavioral RED

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-review-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
  notes_attachment -- --nocapture
```

Exit 101: 12 passed and 3 failed. The failures proved that a corrupt later GIF
frame was accepted, Redo resurrected metadata with missing bytes, and an ordinary
history-limit eviction left attachment bytes unreachable.

### Storage Boundary RED

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-review-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml notes_attachment
```

Exit 101 at compile time: `AttachmentStorageLease` was absent and
`ValidationLimits` had no frame-count or cumulative-pixel fields. This was observed
after adding the independent lock-handle, directory-identity, and frame-budget
tests and before implementing the new boundary.

### Focused GREEN

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-review-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml notes_attachment
```

Exit 0: 16 passed, 0 failed.

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-review-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml notes_history
```

Exit 0: 17 passed, 0 failed.

Coverage includes two independently opened lock handles/connections, a published
but not yet committed file, pathname replacement after directory acquisition,
post-replacement publish/read/list/remove, static and valid animated decoding,
later-frame corruption, frame and cumulative-pixel budgets, missing/corrupt replay
bytes, atomic replay state, and non-attachment eviction cleanup without a full
scan.

## Verification

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-review-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Exit 0: 163 Rust tests passed, 0 failed; binary and doc tests also passed.

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Exit 0.

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-review-target \
  cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- \
  -D warnings -A clippy::ptr-arg -A clippy::too-many-arguments \
  -A clippy::manual-split-once -A clippy::flat-map-identity \
  -A clippy::bool-assert-comparison
```

Exit 0. An unqualified `-D warnings` run reports only the existing repository,
lib, export, and history lint classes listed in the allowances; the one new test
assertion warning found during that run was fixed.

## Concerns

- The lock/identity race uses independent OS file handles and SQLite connections
  in separate threads, which exercises the same kernel lock primitive but does not
  spawn a second test executable.
- Capability and lock behavior was executed on macOS. The selected crates provide
  cross-platform Unix/Windows implementations, but no Windows target was available
  for this run.
- The crate declares Rust 1.77.2. `fs4` declares Rust 1.75 and the relevant
  capability transitive crates declare Rust 1.70, while `cap-std`/`cap-fs-ext` do
  not publish an explicit `rust-version`. This machine has Rust 1.96.1 and no
  `rustup`, so an actual 1.77.2 compiler run could not be performed.
