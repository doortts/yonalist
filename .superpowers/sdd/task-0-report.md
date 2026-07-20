# Task 0 Report — Phase 0 HLC, schema v2, triggers, and app-local database

## Status

DONE. Phase 0 is implemented on `codex/notes-file-ssot-sync`; watcher, parser,
merger, exporter, and frontend sync work remain deliberately out of scope.

## Contract delivered

- Added a fixed-width, lexically sortable HLC wire format:
  `9 base36 millis-2 base36 counter-4 lowercase hex device` (17 bytes).
- Added a process-global monotonic clock with remote observation, counter carry,
  SQLite scalar-function registration, startup restoration, and persistence.
- Advanced the notes schema to v2 and added the Phase 0 sync metadata, topic,
  dirty-node, conflict, purged-tombstone, and asset-trash tables.
- Added node and attachment triggers that stamp local changes and upsert dirty
  markers while preserving explicitly supplied remote HLC values.
- Seeded stable `device_id` and `vault_uuid` values exactly once per database.
- Moved production notes storage under the app-local notes root, keyed by the
  first 16 lowercase hex characters of SHA-256 over the lexically normalized
  absolute vault path. Tests retain `.yonalist/notes.sqlite` as an explicitly
  documented fallback.
- Created the app-local `asset-trash` directory and used held-directory,
  capability-relative operations with root/key identity revalidation. Symlinked
  notes roots and vault-key directories are rejected.
- Rejected development schema v1 with the exact cleanup guidance:
  `개발 단계 DB — .yonalist/notes.sqlite 삭제 후 재실행`.
- Routed notes-database deletion through the same storage resolver so deletion
  follows the relocated production database.

## Files changed

- `src-tauri/src/notes/hlc.rs` — HLC codec, clock, SQLite integration, restore /
  persist behavior, and focused unit tests.
- `src-tauri/src/notes/schema.rs` — schema v2 tables and node/attachment sync
  triggers.
- `src-tauri/src/notes/repository.rs` — identity initialization, v1 rejection,
  app-local keyed storage, capability-safe directory handling, and integration
  tests.
- `src-tauri/src/notes/commands.rs` — relocated database deletion boundary.
- `src-tauri/src/notes/attachments.rs` — HLC-function setup for independent raw
  SQLite racer connections used by existing reconciliation tests.
- `src-tauri/src/lib.rs`, `src-tauri/src/notes/mod.rs` — app data-root and module
  wiring.
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` — enabled UUID v5 support and
  resolved lockfile updates.

No notify dependency, file watcher, parser, merger, exporter, or frontend sync
surface was introduced.

## TDD evidence

Each contract started with a failing focused test before its implementation:

1. HLC codec/clock tests failed to compile before `Hlc` and `HlcClock` existed;
   the final module has 8 passing tests covering round-trip, canonical rejection,
   monotonicity, counter overflow, remote observation, process-global observation,
   restoration/persistence, and lexical ordering.
2. `fresh_schema_v2_defines_sync_storage_and_stable_identity_metadata` first saw
   schema version 1, then passed with version 2, the Phase 0 tables, and stable
   seeded identity.
3. `repository_mutation_restamps_hlc_and_marks_the_node_dirty` first observed an
   empty HLC, then passed with trigger stamping and a dirty marker.
4. `node_triggers_stamp_local_inserts_but_preserve_explicit_remote_hlc` was run
   with the triggers absent and failed on an unstamped local insert; it passed
   after the trigger contract was restored.
5. `attachment_insert_update_and_delete_restamp_and_dirty_the_owner` first failed
   because attachment mutation did not advance the owner HLC, then passed for all
   three attachment operations.
6. `deleting_a_node_keeps_a_dirty_marker_for_export` first observed no marker,
   then passed with the delete trigger.
7. The global observation and persistence tests first failed on missing APIs,
   then passed after `observe` and `persist_clock` were implemented.
8. `notes_connection_rejects_development_schema_v1_with_cleanup_guidance` first
   opened v1 successfully, then passed with the exact required rejection string.
9. The app-local path, key-directory symlink, asset-trash, and root-symlink tests
   each failed before their storage behavior existed and passed after the
   capability-relative implementation.

Focused ownership verification reached 150/150 repository tests before the final
root-symlink test, then that new test also passed. The HLC cases, 2 deletion-command
tests, and all storage-path tests passed independently.

## Full-gate diagnosis and correction

The first full Rust gate exposed two compatibility issues in existing tests:

- History replay and attachment reconciliation hit `UNIQUE constraint failed:
  sync_dirty_nodes.node_id`. SQLite propagates an outer UPSERT conflict policy
  into trigger statements, so trigger-level `INSERT OR REPLACE` was not reliable
  under replay. The dirty-marker statements now use explicit
  `ON CONFLICT(node_id) DO UPDATE`, preserving the required replace/upsert
  semantics without conflict-policy leakage.
- Two existing attachment racer tests create independent raw SQLite connections.
  Because scalar functions are connection-local, those connections lacked
  `yona_hlc`. They now register the placeholder function before installing the
  schema, matching all other schema-only connections.

After correction, the representative history replay, attachment history replay,
reconciliation (8/8), targeted cleanup (2/2), collapse (1/1), image atom removal
(1/1), and command batch (14/14) suites passed.

## Final verification

- `npm run lint` — pass.
- `npx tsc --noEmit` — pass.
- `npm test` — pass.
- `npm run test:architecture` — pass. The command printed the existing tracked
  counters `useNotesHistoryController.ts actual=1502 budget=1500` and
  `all-test-order-observations actual=286 budget=283`, but exited 0; this backend
  phase adds no frontend architecture surface.
- `cargo test --manifest-path src-tauri/Cargo.toml` — pass:
  **741 passed, 0 failed, 3 ignored**; main and doc-test targets also pass.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — pass.
- `git diff --check` — pass.

## Self-review

- The HLC encoding is fixed-width and canonical, and tuple order agrees with
  lexical order throughout the representable domain exercised by the property
  test.
- Startup restores from the greatest of persisted sync metadata and node HLC;
  database initialization persists the resulting clock state.
- Explicit remote HLC survives insert/update paths; ordinary local mutations are
  stamped, attachment mutations restamp their owner, and deletes leave exportable
  dirty markers.
- Production database paths cannot escape through symlinked roots or key
  directories, and held-directory identity checks remain in place.
- Schema v1 never runs v2 SQL accidentally; the mandated development cleanup
  message is used by connect, read-only, initialize, and export entry points.
- The implementation stays inside the Phase 0 boundary.

## Concerns / follow-up

- No user-visible manual proof was applicable to this backend storage foundation.
- The architecture command's two pre-existing over-budget counters should remain
  visible to the parent task, although its enforced gate passes.
