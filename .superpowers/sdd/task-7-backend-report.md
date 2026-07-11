# Task 7 Rust And Local Storage Report

## Status

DONE_WITH_CONCERNS

Implementation commit: `77729732e68ab152a07d15ac379c84c7a4798cd7`

## Owned Files

- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock` (required generated dependency resolution)
- `src-tauri/src/notes/attachments.rs`
- `src-tauri/src/notes/mod.rs`
- `src-tauri/src/notes/types.rs`
- `src-tauri/src/notes/repository.rs`
- `src-tauri/src/notes/commands.rs`
- `src-tauri/src/lib.rs`
- `.superpowers/sdd/task-7-backend-report.md`

No frontend TS, TSX, or CSS file was modified, staged, reverted, or committed by
this backend slice.

## Implementation

- Added maintained `image` decoders for PNG, JPEG, WebP, and GIF with only those
  four format features enabled. Version `0.25.6` is pinned because it supports
  Rust 1.70; current `image` 0.25.8+ releases require Rust 1.85+, above this
  crate's declared Rust 1.77.2 floor.
- Source imports are bounded to 20 MiB and 40,000,000 decoded pixels. They require
  a matching supported extension, perform a full decoder pass, reject SVG and
  unsupported signatures, and derive MIME type from decoded bytes.
- Valid bytes are SHA-256 addressed under
  `.yonalist/notes-assets/<hash>.<canonical-extension>`. Publication uses a
  temporary file in that directory, flush plus `sync_all`, atomic persist/rename,
  and directory sync on Unix.
- Asset-root and metadata-relative-path checks reject traversal, absolute paths,
  wrong hash/MIME extensions, non-files, and a symlinked `notes-assets` root.
- Imports are hash-deduplicated. A process-wide storage guard serializes publish,
  metadata commit, failure reconciliation, reads, replay cleanup, Empty Trash,
  and Notes data deletion so one in-flight import cannot be collected by another.
- Metadata mutations use the existing Task 2 history transaction and attachment
  audit triggers. Stale attachment replay continues to use the global expected
  state conflict checks at HEAD.
- Reconciliation computes reachability from every current attachment row (active,
  Trash, and Archive nodes are all retained) and both before/after attachment
  history snapshots. Only files absent from the complete reference set are
  removed.
- Startup history expiry, history clearing, Undo/Redo, attachment mutations, Empty
  Trash, and Notes database deletion run the appropriate attachment cleanup.
- `remove_empty_node` now rejects image-only nodes as non-empty.

## API And Wire Contract

Registered Tauri commands:

- `notes_import_attachment({ vaultPath, input, historyContext })`
- `notes_read_attachment_bytes({ vaultPath, attachmentId })`
- `notes_resize_attachment({ vaultPath, input, historyContext })`
- `notes_remove_attachment({ vaultPath, attachmentId, historyContext })`
- `notes_restore_attachment({ vaultPath, attachmentId, historyContext })`

`ImportAttachmentInput` is `{ id, nodeId, sourcePath, displayWidth? }`.
`ResizeAttachmentInput` is `{ id, displayWidth }`. Import defaults persisted width
to intrinsic width when omitted. Backend width bounds are
`min(160, intrinsicWidth)..=intrinsicWidth`, preventing upscaling; the frontend is
responsible for its narrower live content-width/viewport cap.

Every `NotesWorkspace`, including history replay results and empty scopes, now
contains:

```text
{
  nodes: NoteNode[],
  attachmentsByNodeId: Record<NoteId, NoteAttachment[]>
}
```

Map keys are deterministic (`BTreeMap`). Each attachment vector is ordered by
`sortKey`, then `id`. `NoteAttachment` exposes id/node/order, safe owned relative
path, hash, original name, MIME, byte size, intrinsic dimensions, persisted display
width, and timestamps in camelCase. Raw-byte reads accept only an attachment ID,
resolve its stored canonical owned path, and revalidate bytes against all stored
metadata; callers cannot submit a filesystem path to the read command.

`notes_restore_attachment` restores the latest retained removed-row snapshot for
that attachment ID after validating the still-owned bytes and active parent node.

## Strict TDD Evidence

### Initial Validation RED

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes_attachment
```

Exit 101. Compilation failed on missing `resolve_owned_asset_path`,
`validate_image_bytes`, and `ValidationLimits`, confirming the decoder/path boundary
did not exist.

### Validation GREEN

The same focused command passed 4 tests covering valid PNG/JPEG/WebP/GIF,
extension spoofing, SVG, truncation, byte/pixel ceilings, SHA-256 metadata, and
safe relative paths.

### Lifecycle RED

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-target \
  cargo test --manifest-path src-tauri/Cargo.toml notes_attachment
```

Exit 101. Compilation failed on the missing import/read/resize/remove/restore
commands, typed inputs, and `attachments_by_node_id` workspace field.

### Lifecycle GREEN

The suite progressed to 10 passing tests for dedupe, ordering, validated ID reads,
width bounds, import cleanup, shared-hash reconciliation, startup reconciliation,
Undo/Redo metadata, explicit restore, stale replay conflict, live/Trash/Archive
reachability, Empty Trash, and path/byte tampering.

### Review RED/GREEN

- Symlink root RED: `notes_attachment_reconciliation_rejects_a_symlinked_owned_root`
  failed because startup followed the redirect and returned success. GREEN after
  fail-closed root checks; the external sentinel remained untouched.
- Image-only empty RED: after correcting the fixture to empty title/note,
  `notes_attachment_prevents_image_only_nodes_from_being_removed_as_empty` failed
  because the node moved to Trash. GREEN after the transactional attachment check.
- Storage serialization RED: `notes_attachment_storage_operations_are_serialized`
  failed to compile because the guard was absent. GREEN after adding the guard and
  command critical sections.

Final focused result: 13 passed, 0 failed.

## Final Verification

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Exit 0.

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-target \
  cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Exit 0: 160 Rust tests passed, 0 failed; binary and doc tests also passed.

```bash
CARGO_TARGET_DIR=/tmp/yonalist-task7-target \
  cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- \
  -D warnings -A clippy::ptr-arg -A clippy::too-many-arguments \
  -A clippy::manual-split-once -A clippy::flat-map-identity \
  -A clippy::bool-assert-comparison
```

Exit 0. The five allowed lints are pre-existing in unrelated code; an unqualified
`-D warnings` run reports those existing findings and no Task 7-specific warning.

`git diff --cached --check` passed before the implementation commit, and the staged
name audit contained only the eight backend implementation paths above.

## Review Outcomes

A fresh read-only reviewer identified four findings. Three valid findings were
fixed: symlink-root traversal, in-process import/reconciliation race, and
image-only remove-empty behavior. The proposed schema-version finding was rejected:
`notes_attachments`, its order index, and history audit/replay support were already
part of the schema-v3 HEAD contract before Task 7, as the brief explicitly states;
this task did not add the table to an existing migration.

## Concerns

- The storage guard coordinates concurrent commands inside one Tauri backend
  process. Separate application processes pointed at the same vault are still
  coordinated by SQLite for metadata but do not share this in-memory file guard.
- Animated GIF/WebP validation performs the maintained decoder's normal image
  decode path and enforces logical decoded dimensions; it does not impose a
  separate cumulative pixel budget across every animation frame.
- `Cargo.lock` was not named in the ownership list, but committing the new decoder
  without its generated locked resolution would make `cargo --locked` fail. It is
  included solely as the required consequence of the owned `Cargo.toml` change.
- Concurrent frontend work remains unstaged in the worktree and was intentionally
  not verified or included by this backend slice.
