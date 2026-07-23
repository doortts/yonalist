# Notes RemoveTopic Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent metadata-absent roots from scheduling file removal and make existing orphan `RemoveTopic` work items complete idempotently.

**Architecture:** The producer in `repository.rs` schedules removal only for a former root with durable `sync_topics` ownership. The consumer in `exporter.rs` represents missing removal metadata as an already-absent source, verifies the destination dependency first, and atomically clears the dirty marker without touching the filesystem.

**Tech Stack:** Rust, rusqlite, tempfile-based Notes sync tests

## Global Constraints

- Keep the 3-second idle and 30-second maximum export debounce unchanged.
- Do not change the Notes Markdown format or SQLite schema.
- Never clear a removal marker before the current parent topic or trash dependency is durably exported.
- Preserve the existing hash and quarantine checks for metadata-backed removal.

---

### Task 1: Prevent metadata-absent removal scheduling

**Files:**
- Modify: `src-tauri/src/notes/repository.rs:5874-5918`
- Test: `src-tauri/src/notes/sync/exporter.rs`

**Interfaces:**
- Consumes: `crate::notes::sync::topic_metadata_exists(&Connection, &str) -> rusqlite::Result<bool>`
- Produces: `mark_former_topic_dirty_for_move` that omits `__yonalist_remove_topic__:<id>` when the former root has no `sync_topics` row.

- [ ] **Step 1: Write the failing regression test**

Add an exporter integration test that inserts two unexported roots, moves the first below the second, and asserts that pending exports contain the destination topic but no `RemoveTopic` target.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml sync::exporter::tests::moving_an_unexported_root_does_not_schedule_file_removal -- --exact
```

Expected: FAIL because the current local move path schedules `RemoveTopic` unconditionally.

- [ ] **Step 3: Implement the producer guard**

When `former_topic == node_id`, query `topic_metadata_exists` inside the move transaction. If no metadata exists, do not insert the virtual removal marker; retain ordinary trigger dirtiness so the destination topic is exported.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same exact test and expect one passing test.

### Task 2: Recover existing orphan removal work

**Files:**
- Modify: `src-tauri/src/notes/sync/exporter.rs:889-1034`
- Test: `src-tauri/src/notes/sync/exporter.rs`

**Interfaces:**
- Consumes: the existing destination/trash durability verification in `prepare_topic_removal`.
- Produces: a prepared removal state that distinguishes an owned file from an already-absent source.

- [ ] **Step 1: Write the failing orphan-marker test**

Add a test that exports the destination topic, inserts a metadata-absent removal marker for its live child, publishes the removal, and expects no filesystem removal plus an empty dirty table.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml sync::exporter::tests::metadata_absent_topic_removal_completes_after_destination_is_durable -- --exact
```

Expected: FAIL with `Could not load removed Notes topic metadata: Query returned no rows`.

- [ ] **Step 3: Implement idempotent completion**

Load removal metadata with `OptionalExtension`. After dependency verification, return an already-absent state when no row exists. Publication must clear only the captured dirty markers in a transaction and return `false` without invoking a filesystem remover.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same exact test and expect one passing test.

- [ ] **Step 5: Re-run metadata-backed removal coverage**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml sync::exporter::tests::cross_topic_moves_rewrite_the_former_topic_or_retire_a_moved_root_file -- --exact
```

Expected: PASS with the former exported topic file removed.

### Task 3: Final verification

**Files:**
- Review: `src-tauri/src/notes/repository.rs`
- Review: `src-tauri/src/notes/sync/exporter.rs`

**Interfaces:**
- Consumes: completed Tasks 1-2.
- Produces: verified Rust persistence behavior with no unrelated changes.

- [ ] **Step 1: Run owning-module tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notes::sync::exporter::tests
```

- [ ] **Step 2: Run the Rust gate once**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

- [ ] **Step 3: Check patch integrity**

```bash
git diff --check
git status --short
```

- [ ] **Step 4: Review acceptance rows**

Confirm the unexported-root case, existing orphan case, and metadata-backed deletion case are all represented by passing tests. Do not modify the user's live Notes database.
