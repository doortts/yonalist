# Notes current-schema reset design

**Date:** 2026-07-14  
**Status:** Approved

## Goal

Treat the Notes database as development-only storage with one authoritative current schema. Remove database versioning, migrations, legacy repairs, and migration-only metadata instead of maintaining compatibility with earlier development databases.

Reset the active development Notes data and let the application create a fresh database containing the editable onboarding note.

## Scope

This change includes:

- replacing the version-one schema plus incremental migrations with one current-schema creation path;
- removing `PRAGMA user_version` reads, writes, compatibility checks, and future-version preflight logic;
- removing version-to-version migrations and historical history-schema repair code;
- removing migration-only derived-index rebuild gates and their version markers;
- removing the `notes_preferences` table, which is used only for version and onboarding markers;
- removing the legacy default from `notes_history_entries.command_kind`;
- seeding onboarding content only when the current schema is first created;
- resetting the active development Notes database and attachment storage;
- updating automated tests to describe only current-schema behavior.

This change does not migrate or preserve active data from an older Notes schema. The one-time development reset is intentional.

## Initialization architecture

`initialize_notes_db` remains responsible for SQLite runtime configuration and one atomic schema transaction:

1. Configure the busy timeout, WAL mode, and foreign keys.
2. Start an immediate transaction.
3. Check whether the authoritative root table, `notes_nodes`, exists.
4. If it does not exist, create the complete current schema and seed the onboarding tree in the same transaction.
5. If it exists, assume the database already uses the current development schema and leave it unchanged.
6. Commit.

There is no version number, upgrade dispatch, repair pass, or compatibility fallback. A stale development database is handled by resetting the database, not by production code.

Concurrent first initialization remains safe because the immediate transaction serializes schema creation. A second initializer observes `notes_nodes` after the first transaction commits and does not create or seed again.

## Current schema

The single creation statement defines the final forms of:

- `notes_nodes`, including deletion and archive ownership fields;
- `notes_tags` with tag prefixes and normalized values;
- `notes_dates`;
- `notes_attachments`;
- `notes_history_entries` and `notes_history_changes`;
- active and lifecycle FTS tables;
- all current indexes and FTS-maintenance triggers.

`notes_history_entries.command_kind` is `TEXT NOT NULL` without the migration-era `legacy` default because every current history write supplies an explicit validated command kind.

`notes_preferences` is not created. The derived tokenizer, date parser, lifecycle index, and onboarding version constants and rows are removed with it.

### Retained-schema usage audit

Keep only persistent structures with a current runtime consumer:

| Structure | Current responsibility |
| --- | --- |
| `notes_nodes` | Outline hierarchy, text, layout, collapse, star, completion, trash, and archive state |
| `notes_tags` | Structured `#` and `@` tag filtering and counts |
| `notes_dates` | Parsed date-range search results |
| `notes_attachments` | Image metadata, ordering, sizing, and owned-file reconciliation |
| `notes_history_entries` | Undo/redo cursor, session ordering, command identity, and history-size accounting |
| `notes_history_changes` | Before/after audit rows used to replay undo and redo |
| `notes_search` | Active-workspace full-text search |
| `notes_search_lifecycle` | Archive and trash full-text search |
| temporary `notes_history_context` | Per-transaction context consumed by current audit triggers; it is not persistent schema or migration state |

Columns introduced during earlier development migrations are retained only when current code uses them:

- `deleted_batch_id` identifies one trash operation so restore and undo affect the correct subtree;
- `archived_at` and `archive_root_id` represent current archive membership and ownership;
- `sequence`, `is_undone`, `estimated_bytes`, and `command_kind` implement current history ordering, replay state, capacity limits, and mutation deltas;
- normalized tag and date-token columns support current indexed searches;
- attachment hash, dimensions, and path columns support current validation, deduplication, rendering, and cleanup.

Remove all structures that exist only for compatibility or conversion:

- `notes_preferences` and every schema/parser/tokenizer/onboarding version row;
- `PRAGMA user_version` and all v1, v2, v3, or v4 concepts;
- historical history-table shapes, `_legacy` temporary tables, snapshot conversion structs, schema-normalization helpers, and repair branches;
- migration-only column defaults such as `command_kind DEFAULT 'legacy'`;
- future-version header inspection and migration rollback tests that have no current-schema behavior to protect.

No currently consumed table or column is removed merely because it was originally introduced by a migration.

## Code structure

Move the authoritative DDL out of the large repository implementation into a small `notes/schema.rs` module. That module has one responsibility: detect the absence of `notes_nodes` and atomically create the current tables, indexes, and triggers. It returns whether creation occurred.

`notes/repository.rs` keeps database path handling, connection configuration, onboarding seed data, and runtime CRUD/query behavior. Its initialization flow calls the schema module and seeds onboarding plus derived rows only when schema creation reports a new database.

Delete migration dispatch, historical schema models, repair validators, normalized-SQL comparison machinery, derived-version gates, and whole-database rebuild helpers that exist only to upgrade old data. Do not replace them with a generic migration abstraction or a schema-version enum.

Keep reusable runtime helpers such as per-node tag/date derivation and SQLite busy handling because normal writes and concurrent startup still use them.

## Derived data and onboarding

Because a current-schema database starts empty, no startup-wide migration rebuild is required.

The onboarding root and six child nodes are inserted immediately after the schema is created. Active and lifecycle search triggers populate both FTS tables. The seed path explicitly derives tag and date rows for the new nodes through the current Rust indexing helpers.

On later opens, the presence of `notes_nodes` means initialization performs no seed. Therefore a user can edit or delete the onboarding note and it will not return. No preference marker is necessary.

## Export and preflight behavior

Notes export still requires an existing SQLite database and opens it read-only. It no longer accepts or rejects databases by `user_version` because the application has no schema-version concept.

SQLite remains responsible for reporting malformed or unreadable database files. Development databases with outdated shapes are reset rather than inspected or repaired by application code.

## Development data reset

Stop the running desktop app before resetting storage. Move the current Notes database, SQLite companions, and `notes-assets` out of their active names as a temporary reversible backup. Do not alter the Inbox index, Markdown vault contents, cache, or outbox.

Restarting the app creates the current schema and onboarding content from scratch. After the new schema and app behavior are verified, remove the temporary Notes-only backup so no obsolete development database remains.

## Testing

Retain and adapt tests for current behavior:

- a fresh database creates every current table, index, and trigger;
- current history columns have the exact final shape and no legacy default;
- onboarding is created once as ordinary editable data;
- deleting onboarding content does not reseed while the schema remains;
- concurrent first initialization creates one valid schema and one onboarding tree;
- initialization failures roll back schema and seed together;
- malformed SQLite files still return SQLite diagnostics;
- current repository, history, attachment, command, export, and performance suites pass.

Remove tests whose only purpose is version-one through version-four migration, derived-version marker upgrades, future `user_version` rejection, or historical history-schema repair.

## Acceptance criteria

- No Notes production code reads or writes `PRAGMA user_version`.
- No versioned schema, migration, historical repair, or migration-marker code remains.
- `notes_preferences` is absent from the current schema.
- Every retained persistent table and column has a current runtime consumer documented by the schema audit.
- Current DDL is isolated in a small schema module rather than mixed with repository CRUD and migration code.
- A fresh database contains the exact current tables, indexes, triggers, and onboarding tree.
- Reopening a current database is idempotent and does not recreate deleted onboarding content.
- The active development Notes data is reset without changing non-Notes vault data.
- The desktop app opens Notes without the version-three trigger error.
- Relevant frontend checks and the complete Rust test suite pass.
