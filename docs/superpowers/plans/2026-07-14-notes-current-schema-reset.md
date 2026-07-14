# Notes Current-Schema Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every Notes schema-version, migration, and historical-repair path; create only the current schema; reset development Notes data; and reopen the desktop app on the clean schema.

**Architecture:** A new `notes/schema.rs` module owns one authoritative current DDL and reports whether it created a database. `notes/repository.rs` keeps connection configuration and seeds onboarding only after first schema creation. Existing current databases are opened as-is; outdated development data is reset outside production code rather than migrated.

**Tech Stack:** Rust 2024, rusqlite/SQLite FTS5, Tauri 2, Vitest, npm/Vite

## Global Constraints

- Do not retain or introduce v1, v2, v3, v4, `user_version`, migration, or historical schema-repair concepts in Notes production code.
- Keep only tables and columns with a documented current runtime consumer.
- Remove `notes_preferences` and all schema/parser/tokenizer/onboarding version markers.
- Preserve current trash, archive, tag, date, attachment, history, active search, and lifecycle search behavior.
- Seed the editable onboarding note only when the current schema is first created.
- Reset only Notes SQLite data and Notes-owned attachments; do not change Inbox `index.sqlite`, Markdown vault data, cache, or outbox.
- Use test-first red/green cycles and make focused commits.

---

### Task 1: Specify the current-only schema contract

**Files:**
- Modify: `src-tauri/src/notes/repository.rs`
- Test: `src-tauri/src/notes/repository.rs`

**Interfaces:**
- Consumes: existing `connect_notes_db`, `initialize_notes_db`, schema test helpers.
- Produces: failing tests that define the version-free current schema and onboarding lifecycle.

- [ ] **Step 1: Remove the abandoned legacy-trigger compatibility experiment**

Restore the v2-to-v3 trigger drops to their committed form and remove the uncommitted test named `legacy_abbreviated_version_one_search_triggers_migrate_to_version_four`. This discarded experiment must not become part of the current-only implementation.

```sql
DROP TRIGGER notes_nodes_search_insert;
DROP TRIGGER notes_nodes_search_update;
DROP TRIGGER notes_nodes_search_delete;
```

- [ ] **Step 2: Change the fresh-schema test before production code**

Rename `fresh_database_creates_the_complete_version_three_schema` to `fresh_database_creates_only_the_current_schema` and make it assert:

```rust
assert!(!object_exists(&connection, "table", "notes_preferences"));
let user_version: i64 = connection
    .pragma_query_value(None, "user_version", |row| row.get(0))
    .expect("default user version");
assert_eq!(user_version, 0);
assert_eq!(
    table_column_metadata(&connection, "notes_history_entries", "command_kind"),
    Some(("TEXT".to_string(), 1, None))
);
```

The exact persistent application tables must be:

```rust
vec![
    "notes_attachments",
    "notes_dates",
    "notes_history_changes",
    "notes_history_entries",
    "notes_nodes",
    "notes_search",
    "notes_search_lifecycle",
    "notes_tags",
]
```

SQLite FTS shadow tables are implementation-owned and may be filtered from this exact application-table assertion by selecting names that start with `notes_` and excluding names whose `sqlite_schema.sql` is `NULL` or whose name starts with `notes_search_` shadow suffixes.

- [ ] **Step 3: Change onboarding tests before production code**

Remove preference-marker assertions. Keep the first-open test at seven nodes, then prove schema presence is the one-time boundary:

```rust
connection
    .execute("DELETE FROM notes_nodes", [])
    .expect("delete onboarding nodes");
initialize_notes_db(&mut connection).expect("reinitialize notes");
assert_eq!(test_node_count(&connection), 0);
```

Replace `onboarding_marks_but_does_not_modify_an_existing_workspace` with a current-schema reopen test that inserts one node into an already-created schema, reinitializes, and observes exactly that node.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml fresh_database_creates_only_the_current_schema
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml onboarding_
```

Expected: the schema test fails because `notes_preferences`, `user_version = 4`, and the `legacy` default still exist. Onboarding tests that still reference preference helpers fail to compile or assert until the current-only bootstrap is implemented.

---

### Task 2: Create one authoritative current schema

**Files:**
- Create: `src-tauri/src/notes/schema.rs`
- Modify: `src-tauri/src/notes/mod.rs`
- Modify: `src-tauri/src/notes/repository.rs`
- Test: `src-tauri/src/notes/repository.rs`

**Interfaces:**
- Consumes: `rusqlite::Transaction` supplied by repository initialization.
- Produces: `schema::create_if_missing(transaction: &Transaction<'_>) -> Result<bool, String>`; `true` means the complete current schema was created in this transaction.

- [ ] **Step 1: Register the schema module**

Add to `src-tauri/src/notes/mod.rs`:

```rust
pub(crate) mod schema;
```

- [ ] **Step 2: Implement schema absence detection**

Create `src-tauri/src/notes/schema.rs` with:

```rust
use rusqlite::Transaction;

fn notes_schema_exists(transaction: &Transaction<'_>) -> Result<bool, String> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema \
             WHERE type = 'table' AND name = 'notes_nodes')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect Notes storage: {error}"))
}

pub(crate) fn create_if_missing(transaction: &Transaction<'_>) -> Result<bool, String> {
    if notes_schema_exists(transaction)? {
        return Ok(false);
    }
    transaction
        .execute_batch(CURRENT_SCHEMA_SQL)
        .map_err(|error| format!("Could not create Notes storage: {error}"))?;
    Ok(true)
}
```

- [ ] **Step 3: Define the complete current DDL in the schema module**

`CURRENT_SCHEMA_SQL` must create these exact current structures in foreign-key-safe order:

```sql
CREATE TABLE notes_nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES notes_nodes(id),
  sort_key INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  layout_mode TEXT NOT NULL DEFAULT 'bullets',
  is_collapsed INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_batch_id TEXT,
  archived_at TEXT,
  archive_root_id TEXT REFERENCES notes_nodes(id)
);

CREATE TABLE notes_tags (
  node_id TEXT NOT NULL REFERENCES notes_nodes(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL CHECK (prefix IN ('#', '@')),
  tag TEXT NOT NULL,
  normalized_tag TEXT NOT NULL,
  PRIMARY KEY (node_id, prefix, normalized_tag)
);

CREATE TABLE notes_dates (
  node_id TEXT NOT NULL REFERENCES notes_nodes(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('title', 'note')),
  start_utf16 INTEGER NOT NULL,
  end_utf16 INTEGER NOT NULL,
  normalized_start TEXT NOT NULL,
  normalized_end TEXT NOT NULL,
  token_text TEXT NOT NULL,
  PRIMARY KEY (node_id, field, start_utf16, end_utf16)
);

CREATE TABLE notes_attachments (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES notes_nodes(id) ON DELETE CASCADE,
  sort_key INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  intrinsic_width INTEGER NOT NULL,
  intrinsic_height INTEGER NOT NULL,
  display_width INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notes_history_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  is_undone INTEGER NOT NULL DEFAULT 0,
  estimated_bytes INTEGER NOT NULL DEFAULT 0,
  command_kind TEXT NOT NULL
);

CREATE TABLE notes_history_changes (
  entry_id TEXT NOT NULL REFERENCES notes_history_entries(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT,
  PRIMARY KEY (entry_id, table_name, row_id)
);
```

Also create the current indexes:

```sql
CREATE INDEX notes_nodes_active_parent_order
  ON notes_nodes(parent_id, deleted_at, sort_key);
CREATE INDEX notes_nodes_deleted_batch
  ON notes_nodes(deleted_batch_id, parent_id);
CREATE INDEX notes_nodes_archive_parent_order
  ON notes_nodes(archived_at, parent_id, sort_key);
CREATE INDEX notes_nodes_archive_root_order
  ON notes_nodes(archive_root_id, parent_id, sort_key);
CREATE INDEX notes_tags_normalized_tag
  ON notes_tags(normalized_tag);
CREATE INDEX notes_tags_prefix_normalized_tag
  ON notes_tags(prefix, normalized_tag, node_id);
CREATE INDEX notes_dates_range
  ON notes_dates(normalized_start, normalized_end, node_id);
CREATE INDEX notes_attachments_node_order
  ON notes_attachments(node_id, sort_key, id);
CREATE UNIQUE INDEX notes_history_session_sequence
  ON notes_history_entries(session_id, sequence);
```

Create both current FTS projections and their canonical triggers in `CURRENT_SCHEMA_SQL`:

```sql
CREATE VIRTUAL TABLE notes_search USING fts5(
  node_id UNINDEXED,
  title,
  note,
  tokenize = 'unicode61'
);
CREATE TRIGGER notes_nodes_search_insert
AFTER INSERT ON notes_nodes
WHEN NEW.deleted_at IS NULL AND NEW.archived_at IS NULL
BEGIN
  INSERT INTO notes_search (node_id, title, note)
  VALUES (NEW.id, NEW.title, NEW.note);
END;
CREATE TRIGGER notes_nodes_search_update
AFTER UPDATE OF title, note, deleted_at, archived_at ON notes_nodes
BEGIN
  DELETE FROM notes_search WHERE node_id = OLD.id;
  INSERT INTO notes_search (node_id, title, note)
  SELECT NEW.id, NEW.title, NEW.note
  WHERE NEW.deleted_at IS NULL AND NEW.archived_at IS NULL;
END;
CREATE TRIGGER notes_nodes_search_delete
AFTER DELETE ON notes_nodes
BEGIN
  DELETE FROM notes_search WHERE node_id = OLD.id;
END;

CREATE VIRTUAL TABLE notes_search_lifecycle USING fts5(
  node_id UNINDEXED,
  title,
  note,
  tokenize = 'unicode61'
);
CREATE TRIGGER notes_nodes_lifecycle_search_insert
AFTER INSERT ON notes_nodes
BEGIN
  INSERT INTO notes_search_lifecycle (node_id, title, note)
  VALUES (NEW.id, NEW.title, NEW.note);
END;
CREATE TRIGGER notes_nodes_lifecycle_search_update
AFTER UPDATE OF title, note ON notes_nodes
BEGIN
  DELETE FROM notes_search_lifecycle WHERE node_id = OLD.id;
  INSERT INTO notes_search_lifecycle (node_id, title, note)
  VALUES (NEW.id, NEW.title, NEW.note);
END;
CREATE TRIGGER notes_nodes_lifecycle_search_delete
AFTER DELETE ON notes_nodes
BEGIN
  DELETE FROM notes_search_lifecycle WHERE node_id = OLD.id;
END;
```

- [ ] **Step 4: Replace version dispatch with current-schema creation**

In `initialize_notes_db`, retain busy timeout, WAL, foreign keys, test busy observation, and the immediate transaction. Replace every `user_version` branch and every ensure/repair call with:

```rust
let created = crate::notes::schema::create_if_missing(&transaction)?;
if created {
    seed_notes_onboarding(&transaction)?;
    let today = SystemLocalTodayProvider.local_today(&transaction)?;
    let node_ids = transaction
        .prepare("SELECT id FROM notes_nodes ORDER BY id")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<BTreeSet<_>, _>>()
        })
        .map_err(|error| format!("Could not load Notes bootstrap rows: {error}"))?;
    rebuild_derived_for_nodes_at(&transaction, &node_ids, today)?;
}
```

Rename `ensure_notes_onboarding` to `seed_notes_onboarding`. Remove all preference lookup/write and node-count gating from it; it is called only for a newly created schema.

- [ ] **Step 5: Remove schema-version preflights from connection and export open**

Delete `NOTES_SCHEMA_VERSION`, `preflight_existing_notes_schema`, and `preflight_notes_schema_header`. `connect_notes_db` must validate the vault path, create the metadata directory, open SQLite, and call `initialize_notes_db`.

`open_notes_export_db` must still reject an absent database and open the existing file read-only, but must not query or compare `user_version`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml fresh_database_creates_only_the_current_schema
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml onboarding_
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml concurrent_first_initialization_waits_for_locks_and_creates_one_valid_schema
```

Expected: all selected tests pass with `user_version = 0`, no `notes_preferences`, seven onboarding nodes on first creation, and no reseed on reopen.

- [ ] **Step 7: Commit the current-schema creation path**

```bash
git add src-tauri/src/notes/schema.rs src-tauri/src/notes/mod.rs src-tauri/src/notes/repository.rs
git commit -m "refactor(notes): create current schema directly"
```

---

### Task 3: Delete migration and historical-repair machinery

**Files:**
- Modify: `src-tauri/src/notes/repository.rs`
- Modify: `src-tauri/src/notes/history.rs`
- Test: `src-tauri/src/notes/repository.rs`
- Test: `src-tauri/src/notes/history.rs`

**Interfaces:**
- Consumes: `schema::create_if_missing` and the final current tables from Task 2.
- Produces: repository and history code with no version conversion, repair, or migration-only model.

- [ ] **Step 1: Remove migration-only production definitions**

Delete from `repository.rs`:

- tokenizer/date/lifecycle/onboarding version constants and preference keys;
- `HISTORY_*_SQL`, `HistorySchemaObject`, `ensure_history_schema`, schema SQL normalization/comparison, and noncanonical-history errors;
- `HistoricalNodeSnapshot`, `HistoricalAttachmentSnapshot`, historical snapshot/data validators, and `migrate_historical_history_schema`;
- `ensure_lifecycle_search_version`, `ensure_tag_tokenizer_version`, `rebuild_all_note_tags`, and `ensure_date_parser_version`;
- `create_version_one_schema` and every `migrate_version_*` function;
- imports that become unused after deletion.

Keep `AuditNodeRow`, per-node `replace_tags`, per-node `replace_dates`, and `rebuild_derived_for_nodes_at`; they implement current writes and bootstrap derivation.

- [ ] **Step 2: Remove migration-only test fixtures and cases**

Delete helpers such as `seed_version_one_database`, `seed_version_two_database`, historical history schema seeders, preference readers, and schema-repair fixtures.

Delete tests whose names or only purpose cover:

- version-one through version-four migration;
- derived tokenizer/date/lifecycle marker rebuilds;
- missing or malformed historical `command_kind` repair;
- backup/hybrid history conversion;
- future `user_version` preflight and WAL rejection;
- rollback of versioned migrations.

Retain current-schema, malformed-SQLite, concurrency, onboarding, CRUD, search, archive, trash, attachment, history, export, and performance tests.

- [ ] **Step 3: Simplify the current history test**

In `notes_history_trash_persists_command_kind`, remove the conditional schema mutation that adds `command_kind`. The current schema always contains it. The test begins directly with creating the root node and asserts the stored current command kind.

- [ ] **Step 4: Compile and repair only current-behavior fixtures**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --no-run
```

Expected: compilation succeeds. Fix references only by switching fixtures to the current schema; do not reintroduce compatibility helpers.

- [ ] **Step 5: Run repository and history suites**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::repository::tests
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml notes::history::tests
```

Expected: both suites pass with zero failures.

- [ ] **Step 6: Audit forbidden migration artifacts**

Run:

```bash
rg -n "user_version|notes_preferences|migrate_version|ensure_history_schema|Historical(Node|Attachment)Snapshot|migrate_historical_history_schema|derived\.(tagTokenizerVersion|dateParserVersion|lifecycleSearchVersion)|DEFAULT 'legacy'" src-tauri/src/notes
```

Expected: no production-code matches. If a retained test description uses an ordinary non-schema meaning of “legacy,” inspect it manually rather than deleting unrelated compatibility behavior.

- [ ] **Step 7: Commit migration removal**

```bash
git add src-tauri/src/notes/repository.rs src-tauri/src/notes/history.rs
git commit -m "refactor(notes): remove schema migration machinery"
```

---

### Task 4: Verify the complete application codebase

**Files:**
- Modify only if a current-behavior test fixture requires alignment.

**Interfaces:**
- Consumes: current schema and simplified initialization.
- Produces: fresh verification evidence for Rust, frontend tests, lint, and build.

- [ ] **Step 1: Check formatting and repository cleanliness**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 2: Run the complete Rust suite**

Run:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: zero failed tests; explicitly report ignored performance tests.

- [ ] **Step 3: Run frontend tests in stable shards**

Run with the bundled workspace Node runtime:

```bash
export PATH="/Users/doortts/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
npm test -- --shard=1/4
npm test -- --shard=2/4
npm test -- --shard=3/4
npm test -- --shard=4/4
```

Expected: all four shards pass with zero failed tests.

- [ ] **Step 4: Run lint and production build**

Run:

```bash
npm run lint
npm run build
```

Expected: both commands exit 0. The existing Vite chunk-size advisory is non-failing.

- [ ] **Step 5: Commit any fixture-only follow-up**

If Task 4 required source-controlled fixture changes, stage only the known current-behavior fixture locations (unchanged paths are ignored by Git):

```bash
git add src-tauri/src/lib.rs \
  src-tauri/src/notes/attachments.rs \
  src-tauri/src/notes/commands.rs \
  src-tauri/src/notes/performance.rs
git commit -m "test(notes): align fixtures with current schema"
```

If no files changed, do not create an empty commit.

---

### Task 5: Reset Notes development data and run the desktop app

**Files:**
- Reset active data under `/Users/doortts/Yonalist/.yonalist/notes.sqlite*`
- Reset active data under `/Users/doortts/Yonalist/.yonalist/notes-assets`
- Do not modify `/Users/doortts/Yonalist/.yonalist/index.sqlite`, cache, outbox, or Markdown content.

**Interfaces:**
- Consumes: verified current-schema application.
- Produces: a running Yonalist desktop app and a newly created current Notes database.

- [ ] **Step 1: Stop only Yonalist development processes**

Find the `tauri dev` parent rooted at `/Users/doortts/repos/yonalist`, terminate it gracefully, and verify its Vite and `target/debug/yonalist` children exit. Do not terminate unrelated local servers.

- [ ] **Step 2: Move active Notes data to a temporary reset backup**

Create a timestamped directory under `/Users/doortts/Yonalist/.yonalist/`. Move only existing `notes.sqlite`, `notes.sqlite-wal`, `notes.sqlite-shm`, and `notes-assets` into it. Leave `.notes-assets.lock` and `notes.app.lock` files in place because the application owns their identities.

- [ ] **Step 3: Start the latest desktop development build**

Run:

```bash
PATH="/Users/doortts/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$HOME/.cargo/bin:$PATH" npm run tauri:dev
```

Expected: Vite becomes ready on `http://127.0.0.1:1420/`, Rust finishes, and `target/debug/yonalist` remains running.

- [ ] **Step 4: Inspect the newly created database**

Query `/Users/doortts/Yonalist/.yonalist/notes.sqlite` and verify:

```text
PRAGMA user_version = 0
notes_preferences is absent
notes_nodes contains 7 onboarding rows
notes_history_entries.command_kind has no default
canonical active and lifecycle FTS triggers exist
```

Also confirm the original non-Notes `index.sqlite` still exists.

- [ ] **Step 5: Remove the obsolete temporary backup after successful verification**

Only after Step 4 succeeds, remove the timestamped Notes-only reset backup. Keep the desktop development process running for the user.

- [ ] **Step 6: Report final state**

Report the schema simplification, exact verification counts, data reset, running app status, commits, and any intentionally ignored performance tests. Do not claim success without fresh command output from Tasks 4 and 5.
