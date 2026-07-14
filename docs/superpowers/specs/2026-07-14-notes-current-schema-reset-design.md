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

## Derived data and onboarding

Because a current-schema database starts empty, no startup-wide migration rebuild is required.

The onboarding root and six child nodes are inserted immediately after the schema is created. Active and lifecycle search triggers populate both FTS tables. The seed path explicitly derives tag and date rows for the new nodes through the current Rust indexing helpers.

On later opens, the presence of `notes_nodes` means initialization performs no seed. Therefore a user can edit or delete the onboarding note and it will not return. No preference marker is necessary.

## Export and preflight behavior

Notes export still requires an existing SQLite database and opens it read-only. It no longer accepts or rejects databases by `user_version` because the application has no schema-version concept.

SQLite remains responsible for reporting malformed or unreadable database files. Development databases with outdated shapes are reset rather than inspected or repaired by application code.

## Development data reset

Stop the running desktop app before resetting storage. Move the current Notes database and any SQLite companions out of their active names, and move `notes-assets` out of its active name as a reversible backup. Do not alter the Inbox index, Markdown vault contents, cache, or outbox.

Restarting the app creates the current schema and onboarding content from scratch. After successful verification, the inactive backup can be removed separately if desired.

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
- A fresh database contains the exact current tables, indexes, triggers, and onboarding tree.
- Reopening a current database is idempotent and does not recreate deleted onboarding content.
- The active development Notes data is reset without changing non-Notes vault data.
- The desktop app opens Notes without the version-three trigger error.
- Relevant frontend checks and the complete Rust test suite pass.
