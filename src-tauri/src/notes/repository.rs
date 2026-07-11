use crate::notes::date_index::{
    find_note_date_matches, parse_note_date_expression, LocalDate, LocalTodayProvider,
    SystemLocalTodayProvider, WeekStartsOn,
};
use crate::notes::history;
use crate::notes::tags::{extract_note_tags, is_canonical_tag_body, tokenize_note_text};
use crate::notes::types::{
    validate_note_id, CreateNodeInput, ExportAttachment, ExportDateSpan, ExportNode, MoveNodeInput,
    NoteAttachment, NoteLayoutMode, NoteNode, NoteSearchMatchedField, NoteSearchResult,
    NoteSearchScope, NoteSearchTag, NoteStructuredSearchQuery, NoteTagFilter, NoteTagPrefix,
    NoteTagSummary, NotesExportSnapshot, NotesWorkspace, NotesWorkspaceScope, SplitNodeInput,
    UpdateNodeInput,
};
use rusqlite::{
    params, params_from_iter, Connection, Error, ErrorCode, OpenFlags, OptionalExtension, Params,
    Row, Transaction, TransactionBehavior,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[cfg(test)]
use std::cell::RefCell;
#[cfg(test)]
use std::sync::mpsc::Sender;

const NOTES_SCHEMA_VERSION: i64 = 3;
const NOTE_TAG_TOKENIZER_VERSION: i64 = 1;
const NOTE_TAG_TOKENIZER_VERSION_KEY: &str = "derived.tagTokenizerVersion";
const NOTE_DATE_PARSER_VERSION: i64 = 2;
const NOTE_DATE_PARSER_VERSION_KEY: &str = "derived.dateParserVersion";
const NOTE_LIFECYCLE_SEARCH_VERSION: i64 = 1;
const NOTE_LIFECYCLE_SEARCH_VERSION_KEY: &str = "derived.lifecycleSearchVersion";
const NOTE_SEARCH_MAX_TEXT_UTF8_BYTES: usize = 4096;
const NOTE_SEARCH_MAX_UNIQUE_TAG_ALTERNATIVES: usize = 64;
const NOTE_SEARCH_MAX_OR_GROUPS: usize = 16;
const NOTE_SEARCH_MAX_ALTERNATIVES_PER_OR_GROUP: usize = 16;
const SQLITE_HEADER_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const SORT_KEY_STEP: i64 = 1024;
pub(crate) const MIN_ATTACHMENT_DISPLAY_WIDTH: i64 = 160;
const NOTES_BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);
const NOTES_BUSY_RETRY_DELAY: Duration = Duration::from_millis(10);

#[cfg(test)]
struct MigrationBusyObservation {
    sender: Sender<usize>,
    worker_id: usize,
}

#[cfg(test)]
thread_local! {
    static NEXT_MIGRATION_BUSY_OBSERVATION: RefCell<Option<MigrationBusyObservation>> =
        const { RefCell::new(None) };
}

#[cfg(test)]
fn observe_next_migration_busy(sender: Sender<usize>, worker_id: usize) {
    NEXT_MIGRATION_BUSY_OBSERVATION.with(|observation| {
        let previous = observation.replace(Some(MigrationBusyObservation { sender, worker_id }));
        assert!(
            previous.is_none(),
            "migration busy observer already installed"
        );
    });
}

#[cfg(test)]
fn migration_busy_observer(_attempt: i32) -> bool {
    NEXT_MIGRATION_BUSY_OBSERVATION.with(|observation| {
        if let Some(observation) = observation.take() {
            let _ = observation.sender.send(observation.worker_id);
        }
    });
    true
}

#[cfg(test)]
fn install_migration_busy_observer(connection: &Connection) -> Result<(), String> {
    let observation_is_pending =
        NEXT_MIGRATION_BUSY_OBSERVATION.with(|observation| observation.borrow().is_some());
    if observation_is_pending {
        connection
            .busy_handler(Some(migration_busy_observer))
            .map_err(|error| format!("Could not observe the Notes migration lock: {error}"))?;
    }
    Ok(())
}

pub(crate) fn notes_db_path(vault_path: &str) -> PathBuf {
    crate::metadata_dir(vault_path).join("notes.sqlite")
}

fn sqlite_companion_path(database_path: &PathBuf, suffix: &str) -> PathBuf {
    let mut path = database_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

pub(crate) fn delete_database(vault_path: &str) -> Result<(), String> {
    if vault_path.trim().is_empty() {
        return Err("Vault path must not be empty.".to_string());
    }

    let database_path = notes_db_path(vault_path);
    let owned_paths = [
        database_path.clone(),
        sqlite_companion_path(&database_path, "-wal"),
        sqlite_companion_path(&database_path, "-shm"),
    ];
    let mut failures = Vec::new();
    for path in owned_paths {
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != ErrorKind::NotFound {
                failures.push(format!("{}: {error}", path.display()));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Could not delete Notes storage: {}",
            failures.join("; ")
        ))
    }
}

pub(crate) fn connect_notes_db(vault_path: &str) -> Result<Connection, String> {
    if vault_path.trim().is_empty() {
        return Err("Vault path must not be empty.".to_string());
    }

    let database_path = notes_db_path(vault_path);
    preflight_existing_notes_schema(&database_path)?;
    let metadata = crate::metadata_dir(vault_path);
    fs::create_dir_all(&metadata)
        .map_err(|error| format!("Could not prepare Notes storage: {error}"))?;
    let mut connection = Connection::open(database_path)
        .map_err(|error| format!("Could not open Notes storage: {error}"))?;
    initialize_notes_db(&mut connection)?;
    Ok(connection)
}

fn preflight_existing_notes_schema(database_path: &PathBuf) -> Result<(), String> {
    match fs::symlink_metadata(database_path) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect Notes storage: {error}")),
    }

    preflight_notes_schema_header(database_path)?;

    let connection =
        Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Could not open Notes storage for inspection: {error}"))?;
    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Could not read the Notes schema version: {error}"))?;
    if user_version > NOTES_SCHEMA_VERSION {
        return Err(format!(
            "This Notes database uses unsupported schema version {user_version}."
        ));
    }

    Ok(())
}

fn preflight_notes_schema_header(database_path: &PathBuf) -> Result<(), String> {
    let mut file = fs::File::open(database_path)
        .map_err(|error| format!("Could not inspect Notes storage: {error}"))?;
    let mut header = [0_u8; 64];
    match file.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(()),
        Err(error) => return Err(format!("Could not inspect Notes storage: {error}")),
    }
    if &header[..SQLITE_HEADER_MAGIC.len()] != SQLITE_HEADER_MAGIC {
        return Ok(());
    }

    let user_version = u32::from_be_bytes([header[60], header[61], header[62], header[63]]);
    if i64::from(user_version) > NOTES_SCHEMA_VERSION {
        return Err(format!(
            "This Notes database uses unsupported schema version {user_version}."
        ));
    }

    Ok(())
}

pub(crate) fn open_notes_export_db(vault_path: &str) -> Result<Connection, String> {
    if vault_path.trim().is_empty() {
        return Err("Vault path must not be empty.".to_string());
    }

    let database_path = notes_db_path(vault_path);
    match fs::symlink_metadata(&database_path) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err("Notes database does not exist.".to_string());
        }
        Err(error) => return Err(format!("Could not inspect Notes storage: {error}")),
    }

    let connection = Connection::open_with_flags(&database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Could not open Notes storage for export: {error}"))?;
    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Could not read the Notes schema version: {error}"))?;
    if user_version != NOTES_SCHEMA_VERSION {
        return Err(format!(
            "This Notes database uses unsupported schema version {user_version}."
        ));
    }

    Ok(connection)
}

fn initialize_notes_db(connection: &mut Connection) -> Result<(), String> {
    let preflight_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Could not read the Notes schema version: {error}"))?;
    if !(0..=NOTES_SCHEMA_VERSION).contains(&preflight_version) {
        return Err(format!(
            "This Notes database uses unsupported schema version {preflight_version}."
        ));
    }

    connection
        .busy_timeout(NOTES_BUSY_TIMEOUT)
        .map_err(|error| format!("Could not configure the Notes busy timeout: {error}"))?;
    enable_wal_with_busy_retry(connection)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("Could not configure Notes storage: {error}"))?;
    #[cfg(test)]
    install_migration_busy_observer(connection)?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes database migration: {error}"))?;
    let user_version: i64 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Could not read the Notes schema version: {error}"))?;

    match user_version {
        0 => {
            create_version_one_schema(&transaction)?;
            transaction
                .pragma_update(None, "user_version", 1)
                .map_err(|error| format!("Could not record the Notes schema version: {error}"))?;
            migrate_version_one_to_two(&transaction)?;
            transaction
                .pragma_update(None, "user_version", 2)
                .map_err(|error| format!("Could not record the Notes schema version: {error}"))?;
            migrate_version_two_to_three(&transaction)?;
            transaction
                .pragma_update(None, "user_version", NOTES_SCHEMA_VERSION)
                .map_err(|error| format!("Could not record the Notes schema version: {error}"))?;
        }
        1 => {
            migrate_version_one_to_two(&transaction)?;
            transaction
                .pragma_update(None, "user_version", 2)
                .map_err(|error| format!("Could not record the Notes schema version: {error}"))?;
            migrate_version_two_to_three(&transaction)?;
            transaction
                .pragma_update(None, "user_version", NOTES_SCHEMA_VERSION)
                .map_err(|error| format!("Could not record the Notes schema version: {error}"))?;
        }
        2 => {
            migrate_version_two_to_three(&transaction)?;
            transaction
                .pragma_update(None, "user_version", NOTES_SCHEMA_VERSION)
                .map_err(|error| format!("Could not record the Notes schema version: {error}"))?;
        }
        NOTES_SCHEMA_VERSION => {}
        version => {
            return Err(format!(
                "This Notes database uses unsupported schema version {version}."
            ));
        }
    }

    transaction
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS notes_nodes_archive_root_order \
             ON notes_nodes(archive_root_id, parent_id, sort_key);",
        )
        .map_err(|error| format!("Could not ensure Notes version three indexes: {error}"))?;
    ensure_lifecycle_search_version(&transaction)?;
    ensure_tag_tokenizer_version(&transaction)?;
    let today = SystemLocalTodayProvider.local_today(&transaction)?;
    ensure_date_parser_version(&transaction, today)?;

    transaction
        .commit()
        .map_err(|error| format!("Could not finish the Notes database migration: {error}"))
}

fn ensure_lifecycle_search_version(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
            CREATE VIRTUAL TABLE IF NOT EXISTS notes_search_lifecycle USING fts5(
              node_id UNINDEXED,
              title,
              note,
              tokenize = 'unicode61'
            );

            CREATE TRIGGER IF NOT EXISTS notes_nodes_lifecycle_search_insert
            AFTER INSERT ON notes_nodes
            BEGIN
              INSERT INTO notes_search_lifecycle (node_id, title, note)
              VALUES (NEW.id, NEW.title, NEW.note);
            END;

            CREATE TRIGGER IF NOT EXISTS notes_nodes_lifecycle_search_update
            AFTER UPDATE OF title, note ON notes_nodes
            BEGIN
              DELETE FROM notes_search_lifecycle WHERE node_id = OLD.id;
              INSERT INTO notes_search_lifecycle (node_id, title, note)
              VALUES (NEW.id, NEW.title, NEW.note);
            END;

            CREATE TRIGGER IF NOT EXISTS notes_nodes_lifecycle_search_delete
            AFTER DELETE ON notes_nodes
            BEGIN
              DELETE FROM notes_search_lifecycle WHERE node_id = OLD.id;
            END;
            "#,
        )
        .map_err(|error| format!("Could not ensure the lifecycle Notes search index: {error}"))?;

    let stored_version = transaction
        .query_row(
            "SELECT value_json FROM notes_preferences WHERE key = ?1",
            [NOTE_LIFECYCLE_SEARCH_VERSION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the lifecycle Notes search version: {error}"))?
        .and_then(|value| serde_json::from_str::<i64>(&value).ok());
    if stored_version.is_some_and(|version| version >= NOTE_LIFECYCLE_SEARCH_VERSION) {
        return Ok(());
    }

    transaction
        .execute_batch(
            "DELETE FROM notes_search_lifecycle; \
             INSERT INTO notes_search_lifecycle (node_id, title, note) \
             SELECT id, title, note FROM notes_nodes;",
        )
        .map_err(|error| format!("Could not rebuild the lifecycle Notes search index: {error}"))?;
    transaction
        .execute(
            "INSERT INTO notes_preferences (key, value_json) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![
                NOTE_LIFECYCLE_SEARCH_VERSION_KEY,
                NOTE_LIFECYCLE_SEARCH_VERSION.to_string()
            ],
        )
        .map_err(|error| format!("Could not record the lifecycle Notes search version: {error}"))?;
    Ok(())
}

fn ensure_tag_tokenizer_version(transaction: &Transaction<'_>) -> Result<(), String> {
    let stored_version = transaction
        .query_row(
            "SELECT value_json FROM notes_preferences WHERE key = ?1",
            [NOTE_TAG_TOKENIZER_VERSION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the Notes tag tokenizer version: {error}"))?
        .and_then(|value| serde_json::from_str::<i64>(&value).ok());
    if stored_version.is_some_and(|version| version >= NOTE_TAG_TOKENIZER_VERSION) {
        return Ok(());
    }

    let nodes = transaction
        .prepare("SELECT id, title, note FROM notes_nodes ORDER BY id")
        .map_err(|error| format!("Could not prepare the Notes tag index rebuild: {error}"))?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("Could not load Notes for the tag index rebuild: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes for the tag index rebuild: {error}"))?;
    for (node_id, title, note) in nodes {
        replace_tags(transaction, &node_id, &title, &note)?;
    }
    transaction
        .execute(
            "INSERT INTO notes_preferences (key, value_json) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![
                NOTE_TAG_TOKENIZER_VERSION_KEY,
                NOTE_TAG_TOKENIZER_VERSION.to_string()
            ],
        )
        .map_err(|error| format!("Could not record the Notes tag tokenizer version: {error}"))?;
    Ok(())
}

fn ensure_date_parser_version(
    transaction: &Transaction<'_>,
    today: LocalDate,
) -> Result<(), String> {
    let stored_version = transaction
        .query_row(
            "SELECT value_json FROM notes_preferences WHERE key = ?1",
            [NOTE_DATE_PARSER_VERSION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the Notes date parser version: {error}"))?
        .and_then(|value| serde_json::from_str::<i64>(&value).ok());
    if stored_version.is_some_and(|version| version >= NOTE_DATE_PARSER_VERSION) {
        return Ok(());
    }

    let nodes = transaction
        .prepare("SELECT id, title, note FROM notes_nodes ORDER BY id")
        .map_err(|error| format!("Could not prepare the Notes date index rebuild: {error}"))?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("Could not load Notes for the date index rebuild: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes for the date index rebuild: {error}"))?;
    for (node_id, title, note) in nodes {
        replace_dates(transaction, &node_id, &title, &note, today)?;
    }
    transaction
        .execute(
            "INSERT INTO notes_preferences (key, value_json) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![
                NOTE_DATE_PARSER_VERSION_KEY,
                NOTE_DATE_PARSER_VERSION.to_string()
            ],
        )
        .map_err(|error| format!("Could not record the Notes date parser version: {error}"))?;
    Ok(())
}

fn enable_wal_with_busy_retry(connection: &Connection) -> Result<(), String> {
    let deadline = Instant::now() + NOTES_BUSY_TIMEOUT;
    loop {
        match connection.execute_batch("PRAGMA journal_mode = WAL;") {
            Ok(()) => return Ok(()),
            Err(error) if is_database_busy(&error) && Instant::now() < deadline => {
                // Journal-mode changes can bypass SQLite's configured busy handler.
                std::thread::sleep(NOTES_BUSY_RETRY_DELAY);
            }
            Err(error) => {
                return Err(format!("Could not configure Notes storage: {error}"));
            }
        }
    }
}

fn is_database_busy(error: &Error) -> bool {
    matches!(
        error,
        Error::SqliteFailure(details, _)
            if matches!(details.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn create_version_one_schema(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
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
              deleted_at TEXT
            );

            CREATE INDEX notes_nodes_active_parent_order
              ON notes_nodes(parent_id, deleted_at, sort_key);

            CREATE TABLE notes_tags (
              node_id TEXT NOT NULL REFERENCES notes_nodes(id) ON DELETE CASCADE,
              tag TEXT NOT NULL,
              normalized_tag TEXT NOT NULL,
              PRIMARY KEY (node_id, normalized_tag)
            );

            CREATE INDEX notes_tags_normalized_tag ON notes_tags(normalized_tag);

            CREATE TABLE notes_preferences (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE notes_search USING fts5(
              node_id UNINDEXED,
              title,
              note,
              tokenize = 'unicode61'
            );

            CREATE TRIGGER notes_nodes_search_insert
            AFTER INSERT ON notes_nodes
            WHEN NEW.deleted_at IS NULL
            BEGIN
              INSERT INTO notes_search (node_id, title, note)
              VALUES (NEW.id, NEW.title, NEW.note);
            END;

            CREATE TRIGGER notes_nodes_search_update
            AFTER UPDATE OF title, note, deleted_at ON notes_nodes
            BEGIN
              DELETE FROM notes_search WHERE node_id = OLD.id;
              INSERT INTO notes_search (node_id, title, note)
              SELECT NEW.id, NEW.title, NEW.note
              WHERE NEW.deleted_at IS NULL;
            END;

            CREATE TRIGGER notes_nodes_search_delete
            AFTER DELETE ON notes_nodes
            BEGIN
              DELETE FROM notes_search WHERE node_id = OLD.id;
            END;
            "#,
        )
        .map_err(|error| format!("Could not migrate Notes storage to version one: {error}"))
}

fn migrate_version_one_to_two(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
            ALTER TABLE notes_nodes ADD COLUMN deleted_batch_id TEXT;

            UPDATE notes_nodes
            SET deleted_batch_id = 'legacy:' || deleted_at
            WHERE deleted_at IS NOT NULL;

            CREATE INDEX notes_nodes_deleted_batch
              ON notes_nodes(deleted_batch_id, parent_id);
            "#,
        )
        .map_err(|error| format!("Could not migrate Notes storage to version two: {error}"))
}

fn migrate_version_two_to_three(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
            ALTER TABLE notes_nodes ADD COLUMN archived_at TEXT;
            ALTER TABLE notes_nodes ADD COLUMN archive_root_id TEXT REFERENCES notes_nodes(id);

            CREATE INDEX notes_nodes_archive_parent_order
              ON notes_nodes(archived_at, parent_id, sort_key);

            DROP TRIGGER notes_nodes_search_insert;
            DROP TRIGGER notes_nodes_search_update;
            DROP TRIGGER notes_nodes_search_delete;

            DROP INDEX notes_tags_normalized_tag;
            ALTER TABLE notes_tags RENAME TO notes_tags_v2;
            CREATE TABLE notes_tags (
              node_id TEXT NOT NULL REFERENCES notes_nodes(id) ON DELETE CASCADE,
              prefix TEXT NOT NULL CHECK (prefix IN ('#', '@')),
              tag TEXT NOT NULL,
              normalized_tag TEXT NOT NULL,
              PRIMARY KEY (node_id, prefix, normalized_tag)
            );
            INSERT INTO notes_tags (node_id, prefix, tag, normalized_tag)
              SELECT node_id, '#', tag, normalized_tag FROM notes_tags_v2;
            DROP TABLE notes_tags_v2;

            CREATE INDEX notes_tags_normalized_tag ON notes_tags(normalized_tag);
            CREATE INDEX notes_tags_prefix_normalized_tag
              ON notes_tags(prefix, normalized_tag, node_id);

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
            CREATE INDEX notes_dates_range
              ON notes_dates(normalized_start, normalized_end, node_id);

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
            CREATE INDEX notes_attachments_node_order
              ON notes_attachments(node_id, sort_key, id);

            CREATE TABLE notes_history_entries (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              is_undone INTEGER NOT NULL DEFAULT 0,
              estimated_bytes INTEGER NOT NULL DEFAULT 0
            );
            CREATE UNIQUE INDEX notes_history_session_sequence
              ON notes_history_entries(session_id, sequence);

            CREATE TABLE notes_history_changes (
              entry_id TEXT NOT NULL REFERENCES notes_history_entries(id) ON DELETE CASCADE,
              table_name TEXT NOT NULL,
              row_id TEXT NOT NULL,
              ordinal INTEGER NOT NULL,
              before_json TEXT,
              after_json TEXT,
              PRIMARY KEY (entry_id, table_name, row_id)
            );

            DELETE FROM notes_search;
            INSERT INTO notes_search (node_id, title, note)
              SELECT id, title, note FROM notes_nodes
              WHERE deleted_at IS NULL AND archived_at IS NULL;

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
            "#,
        )
        .map_err(|error| format!("Could not migrate Notes storage to version three: {error}"))
}

#[derive(Clone)]
struct StoredNode {
    id: String,
    parent_id: Option<String>,
    sort_key: i64,
    title: String,
    note: String,
    layout_mode: String,
    is_collapsed: bool,
    is_starred: bool,
    completed_at: Option<String>,
    deleted_at: Option<String>,
    deleted_batch_id: Option<String>,
    archived_at: Option<String>,
    archive_root_id: Option<String>,
}

fn stored_node_from_row(row: &Row<'_>) -> rusqlite::Result<StoredNode> {
    Ok(StoredNode {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        sort_key: row.get(2)?,
        title: row.get(3)?,
        note: row.get(4)?,
        layout_mode: row.get(5)?,
        is_collapsed: row.get::<_, i64>(6)? != 0,
        is_starred: row.get::<_, i64>(7)? != 0,
        completed_at: row.get(8)?,
        deleted_at: row.get(9)?,
        deleted_batch_id: row.get(10)?,
        archived_at: row.get(11)?,
        archive_root_id: row.get(12)?,
    })
}

fn note_node_from_row(row: &Row<'_>) -> rusqlite::Result<NoteNode> {
    let layout_mode: String = row.get(5)?;
    let layout_mode = match layout_mode.as_str() {
        "bullets" => NoteLayoutMode::Bullets,
        value => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Unsupported Notes layout mode: {value}"),
                )),
            ))
        }
    };

    Ok(NoteNode {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        sort_key: row.get(2)?,
        title: row.get(3)?,
        note: row.get(4)?,
        layout_mode,
        is_collapsed: row.get::<_, i64>(6)? != 0,
        is_starred: row.get::<_, i64>(7)? != 0,
        completed_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        deleted_at: row.get(11)?,
        archived_at: row.get(12)?,
        archive_root_id: row.get(13)?,
    })
}

fn note_attachment_from_row(row: &Row<'_>) -> rusqlite::Result<NoteAttachment> {
    Ok(NoteAttachment {
        id: row.get(0)?,
        node_id: row.get(1)?,
        sort_key: row.get(2)?,
        relative_path: row.get(3)?,
        content_hash: row.get(4)?,
        original_name: row.get(5)?,
        mime_type: row.get(6)?,
        byte_size: row.get(7)?,
        intrinsic_width: row.get(8)?,
        intrinsic_height: row.get(9)?,
        display_width: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn attachments_for_nodes(
    connection: &Connection,
    nodes: &[NoteNode],
) -> Result<BTreeMap<String, Vec<NoteAttachment>>, String> {
    if nodes.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut by_node_id = BTreeMap::<String, Vec<NoteAttachment>>::new();
    for chunk in nodes.chunks(500) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let mut statement = connection
            .prepare(&format!(
                "SELECT id, node_id, sort_key, relative_path, content_hash, original_name, \
                        mime_type, byte_size, intrinsic_width, intrinsic_height, display_width, \
                        created_at, updated_at \
                 FROM notes_attachments WHERE node_id IN ({placeholders}) \
                 ORDER BY node_id, sort_key, id"
            ))
            .map_err(|error| format!("Could not prepare Notes attachments: {error}"))?;
        let attachments = statement
            .query_map(
                params_from_iter(chunk.iter().map(|node| node.id.as_str())),
                note_attachment_from_row,
            )
            .map_err(|error| format!("Could not load Notes attachments: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not read Notes attachments: {error}"))?;
        for attachment in attachments {
            by_node_id
                .entry(attachment.node_id.clone())
                .or_default()
                .push(attachment);
        }
    }
    Ok(by_node_id)
}

fn query_workspace<P: Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> Result<NotesWorkspace, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Could not prepare the Notes workspace: {error}"))?;
    let nodes = statement
        .query_map(params, note_node_from_row)
        .map_err(|error| format!("Could not load the Notes workspace: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Notes workspace: {error}"))?;
    let attachments_by_node_id = attachments_for_nodes(connection, &nodes)?;
    Ok(NotesWorkspace {
        nodes,
        attachments_by_node_id,
    })
}

struct StoredExportNode {
    id: String,
    parent_id: Option<String>,
    sort_key: i64,
    title: String,
    note: String,
    title_date_spans: Vec<ExportDateSpan>,
    note_date_spans: Vec<ExportDateSpan>,
    completed_at: Option<String>,
}

struct StoredExportDate {
    field: String,
    start_utf16: i64,
    end_utf16: i64,
    normalized_start: String,
    normalized_end: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExportSnapshotRowCounts {
    pub(crate) node_rows: usize,
    pub(crate) date_rows: usize,
}

pub(crate) fn load_export_snapshot(
    connection: &Connection,
    root_node_id: &str,
) -> Result<NotesExportSnapshot, String> {
    load_export_snapshot_inner(connection, root_node_id).map(|(snapshot, _)| snapshot)
}

#[cfg(test)]
pub(crate) fn load_export_snapshot_with_row_counts(
    connection: &Connection,
    root_node_id: &str,
) -> Result<(NotesExportSnapshot, ExportSnapshotRowCounts), String> {
    load_export_snapshot_inner(connection, root_node_id)
}

fn load_export_snapshot_inner(
    connection: &Connection,
    root_node_id: &str,
) -> Result<(NotesExportSnapshot, ExportSnapshotRowCounts), String> {
    validate_note_id(root_node_id)?;
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE \
             export_context(exported_at) AS (\
               SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
             ), \
             subtree(id, path, cycle) AS (\
               SELECT id, '|' || id || '|', 0 FROM notes_nodes \
               WHERE id = ?1 AND deleted_at IS NULL \
               UNION ALL \
               SELECT child.id, subtree.path || child.id || '|', \
                      instr(subtree.path, '|' || child.id || '|') > 0 \
               FROM notes_nodes child \
               JOIN subtree ON child.parent_id = subtree.id \
               WHERE child.deleted_at IS NULL AND subtree.cycle = 0\
             ) \
             SELECT node.id, node.parent_id, node.sort_key, node.title, node.note, \
                    node.completed_at, subtree.cycle, export_context.exported_at \
             FROM subtree \
             JOIN notes_nodes node ON node.id = subtree.id \
             CROSS JOIN export_context \
             ORDER BY node.id",
        )
        .map_err(|error| format!("Could not prepare the Notes export snapshot: {error}"))?;
    let rows = statement
        .query_map([root_node_id], |row| {
            Ok((
                StoredExportNode {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    sort_key: row.get(2)?,
                    title: row.get(3)?,
                    note: row.get(4)?,
                    title_date_spans: Vec::new(),
                    note_date_spans: Vec::new(),
                    completed_at: row.get(5)?,
                },
                row.get::<_, i64>(6)? != 0,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| format!("Could not load the Notes export snapshot: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Notes export snapshot: {error}"))?;

    if rows.is_empty() {
        return Err(format!(
            "Note node {root_node_id} is missing or deleted and cannot be exported."
        ));
    }
    if rows.iter().any(|(_, cycle, _)| *cycle) {
        return Err("The Notes tree contains a cycle and cannot be exported.".to_string());
    }

    let node_rows = rows.len();
    let exported_at = rows[0].2.clone();
    let mut by_id = HashMap::new();
    for (node, _, _) in rows {
        if by_id.insert(node.id.clone(), node).is_some() {
            return Err("The Notes export subtree contains duplicate nodes.".to_string());
        }
    }

    let mut date_statement = connection
        .prepare(
            "WITH RECURSIVE subtree(id, path, cycle) AS (\
               SELECT id, '|' || id || '|', 0 FROM notes_nodes \
               WHERE id = ?1 AND deleted_at IS NULL \
               UNION ALL \
               SELECT child.id, subtree.path || child.id || '|', \
                      instr(subtree.path, '|' || child.id || '|') > 0 \
               FROM notes_nodes child \
               JOIN subtree ON child.parent_id = subtree.id \
               WHERE child.deleted_at IS NULL AND subtree.cycle = 0\
             ) \
             SELECT date.node_id, date.field, date.start_utf16, date.end_utf16, \
                    date.normalized_start, date.normalized_end \
             FROM notes_dates date \
             JOIN subtree ON subtree.id = date.node_id \
             WHERE subtree.cycle = 0 \
             ORDER BY date.node_id, date.field, date.start_utf16, date.end_utf16",
        )
        .map_err(|error| format!("Could not prepare Notes export dates: {error}"))?;
    let date_rows = date_statement
        .query_map([root_node_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                StoredExportDate {
                    field: row.get(1)?,
                    start_utf16: row.get(2)?,
                    end_utf16: row.get(3)?,
                    normalized_start: row.get(4)?,
                    normalized_end: row.get(5)?,
                },
            ))
        })
        .map_err(|error| format!("Could not load Notes export dates: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes export dates: {error}"))?;
    let date_row_count = date_rows.len();
    for (node_id, indexed_date) in date_rows {
        let stored = by_id.get_mut(&node_id).ok_or_else(|| {
            format!("Note node {node_id} has an indexed date outside the export subtree.")
        })?;
        let start_utf16 = usize::try_from(indexed_date.start_utf16)
            .map_err(|_| format!("Note node {node_id} has an invalid export date start offset."))?;
        let end_utf16 = usize::try_from(indexed_date.end_utf16)
            .map_err(|_| format!("Note node {node_id} has an invalid export date end offset."))?;
        if start_utf16 >= end_utf16 {
            return Err(format!(
                "Note node {node_id} has an invalid export date span."
            ));
        }
        let normalized_start = LocalDate::parse_iso(&indexed_date.normalized_start)
            .ok_or_else(|| format!("Note node {node_id} has an invalid normalized start date."))?;
        let normalized_end = LocalDate::parse_iso(&indexed_date.normalized_end)
            .ok_or_else(|| format!("Note node {node_id} has an invalid normalized end date."))?;
        if normalized_start > normalized_end {
            return Err(format!(
                "Note node {node_id} has a reversed normalized export date range."
            ));
        }
        let span = ExportDateSpan {
            start_utf16,
            end_utf16,
            normalized_start: indexed_date.normalized_start,
            normalized_end: indexed_date.normalized_end,
        };
        match indexed_date.field.as_str() {
            "title" => stored.title_date_spans.push(span),
            "note" => stored.note_date_spans.push(span),
            _ => {
                return Err(format!(
                    "Note node {node_id} has an unsupported export date field."
                ))
            }
        }
    }
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for node in by_id.values() {
        if node.id == root_node_id {
            continue;
        }
        let parent_id = node
            .parent_id
            .as_ref()
            .ok_or_else(|| format!("Note node {} has no parent in the export subtree.", node.id))?;
        if !by_id.contains_key(parent_id) {
            return Err(format!(
                "Note node {} has a missing parent in the export subtree.",
                node.id
            ));
        }
        children
            .entry(parent_id.clone())
            .or_default()
            .push(node.id.clone());
    }
    for child_ids in children.values_mut() {
        child_ids.sort_by(|left, right| {
            let left_node = &by_id[left];
            let right_node = &by_id[right];
            left_node
                .sort_key
                .cmp(&right_node.sort_key)
                .then_with(|| left.cmp(right))
        });
    }

    let mut attachments_by_node_id: HashMap<String, Vec<ExportAttachment>> = HashMap::new();
    let mut attachment_statement = connection
        .prepare(
            "WITH RECURSIVE subtree(id, path, cycle) AS (\
               SELECT id, '|' || id || '|', 0 FROM notes_nodes \
               WHERE id = ?1 AND deleted_at IS NULL \
               UNION ALL \
               SELECT child.id, subtree.path || child.id || '|', \
                      instr(subtree.path, '|' || child.id || '|') > 0 \
               FROM notes_nodes child \
               JOIN subtree ON child.parent_id = subtree.id \
               WHERE child.deleted_at IS NULL AND subtree.cycle = 0\
             ) \
             SELECT attachment.id, attachment.node_id, attachment.relative_path, \
                    attachment.content_hash, attachment.original_name, attachment.mime_type, \
                    attachment.byte_size, attachment.intrinsic_width, \
                    attachment.intrinsic_height, attachment.display_width \
             FROM notes_attachments attachment \
             JOIN subtree ON subtree.id = attachment.node_id \
             WHERE subtree.cycle = 0 \
             ORDER BY attachment.node_id, attachment.sort_key, attachment.id",
        )
        .map_err(|error| format!("Could not prepare Notes export attachments: {error}"))?;
    let attachment_rows = attachment_statement
        .query_map([root_node_id], |row| {
            Ok((
                row.get::<_, String>(1)?,
                ExportAttachment {
                    id: row.get(0)?,
                    relative_path: row.get(2)?,
                    content_hash: row.get(3)?,
                    original_name: row.get(4)?,
                    mime_type: row.get(5)?,
                    byte_size: row.get(6)?,
                    intrinsic_width: row.get(7)?,
                    intrinsic_height: row.get(8)?,
                    display_width: row.get(9)?,
                    bytes: None,
                },
            ))
        })
        .map_err(|error| format!("Could not load Notes export attachments: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes export attachments: {error}"))?;
    for (node_id, attachment) in attachment_rows {
        attachments_by_node_id
            .entry(node_id)
            .or_default()
            .push(attachment);
    }

    fn build_node(
        node_id: &str,
        by_id: &mut HashMap<String, StoredExportNode>,
        children: &HashMap<String, Vec<String>>,
        attachments_by_node_id: &mut HashMap<String, Vec<ExportAttachment>>,
        visited: &mut HashSet<String>,
    ) -> Result<ExportNode, String> {
        if !visited.insert(node_id.to_string()) {
            return Err("The Notes tree contains a cycle and cannot be exported.".to_string());
        }
        let node = by_id.remove(node_id).ok_or_else(|| {
            format!("Note node {node_id} disappeared while building the export snapshot.")
        })?;
        let child_ids = children.get(node_id).cloned().unwrap_or_default();
        let child_nodes = child_ids
            .iter()
            .map(|child_id| build_node(child_id, by_id, children, attachments_by_node_id, visited))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ExportNode {
            id: node.id,
            title: node.title,
            note: node.note,
            title_date_spans: node.title_date_spans,
            note_date_spans: node.note_date_spans,
            completed: node.completed_at.is_some(),
            attachments: attachments_by_node_id.remove(node_id).unwrap_or_default(),
            children: child_nodes,
        })
    }

    let root = build_node(
        root_node_id,
        &mut by_id,
        &children,
        &mut attachments_by_node_id,
        &mut HashSet::new(),
    )?;
    if !by_id.is_empty() {
        return Err("The Notes export subtree could not be assembled safely.".to_string());
    }
    if !attachments_by_node_id.is_empty() {
        return Err("The Notes export attachments could not be assembled safely.".to_string());
    }

    Ok((
        NotesExportSnapshot {
            root_node_id: root_node_id.to_string(),
            title: root.title.clone(),
            exported_at,
            root,
        },
        ExportSnapshotRowCounts {
            node_rows,
            date_rows: date_row_count,
        },
    ))
}

pub(crate) fn load_workspace(
    connection: &Connection,
    scope: NotesWorkspaceScope,
) -> Result<NotesWorkspace, String> {
    const ACTIVE_SQL: &str =
        "SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                is_starred, completed_at, created_at, updated_at, deleted_at, \
                archived_at, archive_root_id \
         FROM notes_nodes WHERE deleted_at IS NULL AND archived_at IS NULL \
         ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, parent_id, sort_key, id";
    const STARRED_SQL: &str = "WITH RECURSIVE included(id, parent_id) AS (\
           SELECT id, parent_id FROM notes_nodes \
           WHERE deleted_at IS NULL AND archived_at IS NULL AND is_starred = 1 \
           UNION \
           SELECT parent.id, parent.parent_id FROM notes_nodes parent \
           JOIN included child ON child.parent_id = parent.id \
           WHERE parent.deleted_at IS NULL AND parent.archived_at IS NULL\
         ) \
         SELECT node.id, node.parent_id, node.sort_key, node.title, node.note, node.layout_mode, \
                node.is_collapsed, node.is_starred, node.completed_at, node.created_at, \
                node.updated_at, node.deleted_at, node.archived_at, node.archive_root_id \
         FROM notes_nodes node JOIN included ON included.id = node.id \
         ORDER BY CASE WHEN node.parent_id IS NULL THEN 0 ELSE 1 END, \
                  node.parent_id, node.sort_key, node.id";
    const RECENT_SQL: &str = "WITH RECURSIVE \
         matched(id, parent_id) AS (\
           SELECT id, parent_id FROM notes_nodes \
           WHERE deleted_at IS NULL AND archived_at IS NULL \
           ORDER BY updated_at DESC, id LIMIT 100\
         ), \
         included(id, parent_id) AS (\
           SELECT id, parent_id FROM matched \
           UNION \
           SELECT parent.id, parent.parent_id FROM notes_nodes parent \
           JOIN included child ON child.parent_id = parent.id \
           WHERE parent.deleted_at IS NULL AND parent.archived_at IS NULL\
         ) \
         SELECT node.id, node.parent_id, node.sort_key, node.title, node.note, node.layout_mode, \
                node.is_collapsed, node.is_starred, node.completed_at, node.created_at, \
                node.updated_at, node.deleted_at, node.archived_at, node.archive_root_id \
         FROM notes_nodes node JOIN included ON included.id = node.id \
         ORDER BY CASE WHEN node.parent_id IS NULL THEN 0 ELSE 1 END, \
                  node.parent_id, node.sort_key, node.id";
    const TAG_SQL: &str = "WITH RECURSIVE included(id, parent_id) AS (\
           SELECT node.id, node.parent_id FROM notes_nodes node \
           JOIN notes_tags tag ON tag.node_id = node.id \
           WHERE node.deleted_at IS NULL AND node.archived_at IS NULL \
             AND tag.prefix = '#' AND tag.normalized_tag = ?1 \
           UNION \
           SELECT parent.id, parent.parent_id FROM notes_nodes parent \
           JOIN included child ON child.parent_id = parent.id \
           WHERE parent.deleted_at IS NULL AND parent.archived_at IS NULL\
         ) \
         SELECT node.id, node.parent_id, node.sort_key, node.title, node.note, node.layout_mode, \
                node.is_collapsed, node.is_starred, node.completed_at, node.created_at, \
                node.updated_at, node.deleted_at, node.archived_at, node.archive_root_id \
         FROM notes_nodes node JOIN included ON included.id = node.id \
         ORDER BY CASE WHEN node.parent_id IS NULL THEN 0 ELSE 1 END, \
                  node.parent_id, node.sort_key, node.id";
    const TRASH_SQL: &str = "SELECT node.id, \
                CASE WHEN node.parent_id IS NULL OR EXISTS (\
                  SELECT 1 FROM notes_nodes parent \
                  WHERE parent.id = node.parent_id AND parent.deleted_at IS NOT NULL\
                ) THEN node.parent_id ELSE NULL END, \
                node.sort_key, node.title, node.note, node.layout_mode, node.is_collapsed, \
                node.is_starred, node.completed_at, node.created_at, node.updated_at, \
                node.deleted_at, node.archived_at, node.archive_root_id \
         FROM notes_nodes node WHERE node.deleted_at IS NOT NULL \
         ORDER BY CASE WHEN node.parent_id IS NULL OR NOT EXISTS (\
                    SELECT 1 FROM notes_nodes parent \
                    WHERE parent.id = node.parent_id AND parent.deleted_at IS NOT NULL\
                  ) THEN 0 ELSE 1 END, node.parent_id, node.sort_key, node.id";
    const ARCHIVE_SQL: &str = "SELECT node.id, node.parent_id, node.sort_key, node.title, \
                node.note, node.layout_mode, node.is_collapsed, node.is_starred, \
                node.completed_at, node.created_at, node.updated_at, node.deleted_at, \
                node.archived_at, node.archive_root_id \
         FROM notes_nodes node \
         WHERE node.deleted_at IS NULL AND node.archived_at IS NOT NULL \
           AND node.archive_root_id IS NOT NULL \
         ORDER BY CASE WHEN node.id = node.archive_root_id THEN 0 ELSE 1 END, \
                  node.archive_root_id, node.parent_id, node.sort_key, node.id";

    match scope {
        NotesWorkspaceScope::Active => query_workspace(connection, ACTIVE_SQL, []),
        NotesWorkspaceScope::Starred => query_workspace(connection, STARRED_SQL, []),
        NotesWorkspaceScope::Recent => query_workspace(connection, RECENT_SQL, []),
        NotesWorkspaceScope::Tag { tag } => {
            let normalized_tag = tag.trim().trim_start_matches('#').to_lowercase();
            if normalized_tag.is_empty() {
                return Ok(NotesWorkspace {
                    nodes: Vec::new(),
                    attachments_by_node_id: BTreeMap::new(),
                });
            }
            query_workspace(connection, TAG_SQL, [normalized_tag])
        }
        NotesWorkspaceScope::Tags { tags } => load_tag_workspace(connection, tags),
        NotesWorkspaceScope::Archive => query_workspace(connection, ARCHIVE_SQL, []),
        NotesWorkspaceScope::Trash => query_workspace(connection, TRASH_SQL, []),
    }
}

fn load_tag_workspace(
    connection: &Connection,
    tags: Vec<NoteTagFilter>,
) -> Result<NotesWorkspace, String> {
    validate_note_tag_filters(&tags)?;
    let tags = tags
        .into_iter()
        .map(|tag| (tag.prefix, tag.normalized_tag))
        .collect::<BTreeSet<_>>();
    if tags.is_empty() {
        return Ok(NotesWorkspace {
            nodes: Vec::new(),
            attachments_by_node_id: BTreeMap::new(),
        });
    }

    let mut parameters = Vec::with_capacity(tags.len() * 2);
    let mut required = Vec::with_capacity(tags.len());
    for (index, (prefix, normalized_tag)) in tags.into_iter().enumerate() {
        let prefix_parameter = index * 2 + 1;
        let tag_parameter = prefix_parameter + 1;
        required.push(format!(
            "EXISTS (SELECT 1 FROM notes_tags tag \
             WHERE tag.node_id = node.id AND tag.prefix = ?{prefix_parameter} \
               AND tag.normalized_tag = ?{tag_parameter})"
        ));
        parameters.push(prefix.as_str().to_string());
        parameters.push(normalized_tag);
    }
    let sql = format!(
        "WITH RECURSIVE matched(id, parent_id) AS (\
           SELECT node.id, node.parent_id FROM notes_nodes node \
           WHERE node.deleted_at IS NULL AND node.archived_at IS NULL AND {}\
         ), included(id, parent_id) AS (\
           SELECT id, parent_id FROM matched \
           UNION \
           SELECT parent.id, parent.parent_id FROM notes_nodes parent \
           JOIN included child ON child.parent_id = parent.id \
           WHERE parent.deleted_at IS NULL AND parent.archived_at IS NULL\
         ) \
         SELECT node.id, node.parent_id, node.sort_key, node.title, node.note, \
                node.layout_mode, node.is_collapsed, node.is_starred, node.completed_at, \
                node.created_at, node.updated_at, node.deleted_at, node.archived_at, \
                node.archive_root_id \
         FROM notes_nodes node JOIN included ON included.id = node.id \
         ORDER BY CASE WHEN node.parent_id IS NULL THEN 0 ELSE 1 END, \
                  node.parent_id, node.sort_key, node.id",
        required.join(" AND ")
    );
    query_workspace(connection, &sql, params_from_iter(parameters.iter()))
}

pub(crate) fn validate_note_tag_filters(tags: &[NoteTagFilter]) -> Result<(), String> {
    if tags
        .iter()
        .any(|tag| !is_canonical_tag_body(&tag.normalized_tag))
    {
        return Err(
            "Structured Notes search tag normalizedTag must be a canonical tag body.".to_string(),
        );
    }
    Ok(())
}

pub(crate) fn list_tags(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT tag.normalized_tag FROM notes_tags tag \
             JOIN notes_nodes node ON node.id = tag.node_id \
             WHERE node.deleted_at IS NULL AND node.archived_at IS NULL \
               AND tag.prefix = '#' \
             ORDER BY tag.normalized_tag",
        )
        .map_err(|error| format!("Could not prepare the Notes tag list: {error}"))?;
    let tags = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| format!("Could not load the Notes tag list: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Notes tag list: {error}"))?;
    Ok(tags)
}

pub(crate) fn list_tags_with_counts(
    connection: &Connection,
) -> Result<Vec<NoteTagSummary>, String> {
    let mut statement = connection
        .prepare(
            "WITH live_tags AS (\
               SELECT tag.prefix, tag.normalized_tag, tag.tag, \
                      row_number() OVER (\
                        PARTITION BY tag.prefix, tag.normalized_tag \
                        ORDER BY node.created_at, node.id\
                      ) AS display_rank \
               FROM notes_tags tag \
               JOIN notes_nodes node ON node.id = tag.node_id \
               WHERE node.deleted_at IS NULL AND node.archived_at IS NULL\
             ) \
             SELECT prefix, normalized_tag, \
                    max(CASE WHEN display_rank = 1 THEN tag END), count(*) \
             FROM live_tags \
             GROUP BY prefix, normalized_tag \
             ORDER BY prefix, normalized_tag",
        )
        .map_err(|error| format!("Could not prepare the counted Notes tag list: {error}"))?;
    let summaries = statement
        .query_map([], |row| {
            let prefix: String = row.get(0)?;
            let prefix = match prefix.as_str() {
                "#" => NoteTagPrefix::Hash,
                "@" => NoteTagPrefix::Mention,
                value => {
                    return Err(rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!("Unsupported Notes tag prefix: {value}"),
                        )),
                    ))
                }
            };
            Ok(NoteTagSummary {
                prefix,
                normalized_tag: row.get(1)?,
                display_tag: row.get(2)?,
                count: row.get(3)?,
            })
        })
        .map_err(|error| format!("Could not load the counted Notes tag list: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the counted Notes tag list: {error}"))?;
    Ok(summaries)
}

fn fts_match_expression(query: &str) -> Option<String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    for character in query.trim().chars() {
        if character.is_alphanumeric() || character == '_' {
            token.push(character);
        } else if !token.is_empty() {
            tokens.push(std::mem::take(&mut token));
        }
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    if tokens.is_empty() {
        return None;
    }

    Some(
        tokens
            .into_iter()
            .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

fn search_parent_map(
    connection: &Connection,
    scope: NoteSearchScope,
) -> Result<HashMap<String, (Option<String>, String)>, String> {
    let sql = format!(
        "SELECT node.id, node.parent_id, node.title FROM notes_nodes node WHERE {}",
        search_scope_predicate(scope)
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Could not prepare Notes search ancestors: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("Could not load Notes search ancestors: {error}"))?;
    let mut parents = HashMap::new();
    for row in rows {
        let (id, parent_id, title) =
            row.map_err(|error| format!("Could not read Notes search ancestors: {error}"))?;
        parents.insert(id, (parent_id, title));
    }
    Ok(parents)
}

fn parent_trail(
    node_id: &str,
    parents: &HashMap<String, (Option<String>, String)>,
) -> Result<Vec<String>, String> {
    let mut trail = Vec::new();
    let mut seen = HashSet::new();
    let mut parent_id = parents
        .get(node_id)
        .and_then(|(parent_id, _)| parent_id.clone());
    while let Some(id) = parent_id {
        if !seen.insert(id.clone()) {
            return Err(format!(
                "Could not assemble the Notes search parent trail for {node_id}: cycle detected."
            ));
        }
        let Some((next_parent_id, title)) = parents.get(&id) else {
            break;
        };
        trail.push(title.clone());
        parent_id = next_parent_id.clone();
    }
    trail.reverse();
    Ok(trail)
}

pub(crate) fn search_nodes(
    connection: &Connection,
    query: &str,
) -> Result<Vec<NoteSearchResult>, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    search_nodes_at(connection, query, NoteSearchScope::Active, today)
}

fn search_scope_predicate(scope: NoteSearchScope) -> &'static str {
    match scope {
        NoteSearchScope::Active => "node.deleted_at IS NULL AND node.archived_at IS NULL",
        NoteSearchScope::Archive => "node.deleted_at IS NULL AND node.archived_at IS NOT NULL",
        NoteSearchScope::Trash => "node.deleted_at IS NOT NULL",
    }
}

fn search_nodes_by_date(
    connection: &Connection,
    range: crate::notes::date_index::NoteDateRange,
    scope: NoteSearchScope,
) -> Result<Vec<NoteSearchResult>, String> {
    let sql = format!(
        "SELECT DISTINCT node.id, node.title \
         FROM notes_dates date INDEXED BY notes_dates_range \
         JOIN notes_nodes node ON node.id = date.node_id \
         WHERE date.normalized_start <= ?1 AND date.normalized_end >= ?2 \
           AND {} \
         ORDER BY node.updated_at DESC, node.id LIMIT 100",
        search_scope_predicate(scope)
    );
    let matches = connection
        .prepare(&sql)
        .map_err(|error| format!("Could not prepare the Notes date search: {error}"))?
        .query_map(params![range.end.to_iso(), range.start.to_iso()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not search Note dates: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Notes date search results: {error}"))?;
    let parents = search_parent_map(connection, scope)?;
    matches
        .into_iter()
        .map(|(node_id, title)| {
            Ok(NoteSearchResult {
                parent_trail: parent_trail(&node_id, &parents)?,
                node_id,
                title,
                matched_field: NoteSearchMatchedField::Date,
            })
        })
        .collect()
}

fn search_nodes_fts(
    connection: &Connection,
    query: &str,
    scope: NoteSearchScope,
) -> Result<Vec<NoteSearchResult>, String> {
    let Some(match_expression) = fts_match_expression(query) else {
        return Ok(Vec::new());
    };
    let search_table = match scope {
        NoteSearchScope::Active => "notes_search",
        NoteSearchScope::Archive | NoteSearchScope::Trash => "notes_search_lifecycle",
    };
    let sql = format!(
        "SELECT {search_table}.node_id, {search_table}.title, \
                highlight({search_table}, 1, '<notes-match>', '</notes-match>') \
                  <> {search_table}.title \
         FROM {search_table} \
         JOIN notes_nodes node ON node.id = {search_table}.node_id \
         WHERE {search_table} MATCH ?1 AND {} \
         ORDER BY bm25({search_table}, 0.0, 10.0, 1.0), node.updated_at DESC, node.id \
         LIMIT 100",
        search_scope_predicate(scope)
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Could not prepare the Notes search: {error}"))?;
    let matches = statement
        .query_map([match_expression], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })
        .map_err(|error| format!("Could not search Notes: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Notes search results: {error}"))?;
    let parents = search_parent_map(connection, scope)?;

    matches
        .into_iter()
        .map(|(node_id, title, matched_title)| {
            Ok(NoteSearchResult {
                parent_trail: parent_trail(&node_id, &parents)?,
                node_id,
                title,
                matched_field: if matched_title {
                    NoteSearchMatchedField::Title
                } else {
                    NoteSearchMatchedField::Note
                },
            })
        })
        .collect()
}

pub(crate) fn search_nodes_at(
    connection: &Connection,
    query: &str,
    scope: NoteSearchScope,
    today: LocalDate,
) -> Result<Vec<NoteSearchResult>, String> {
    if let Some(range) = parse_note_date_expression(query, today, WeekStartsOn::Monday) {
        search_nodes_by_date(connection, range, scope)
    } else {
        search_nodes_fts(connection, query, scope)
    }
}

fn canonical_search_tag(tag: &NoteSearchTag) -> (NoteTagPrefix, String) {
    (tag.prefix, tag.normalized_tag.clone())
}

type NormalizedNoteTag = (NoteTagPrefix, String);

struct CanonicalSearchFilters {
    required: BTreeSet<NormalizedNoteTag>,
    excluded: BTreeSet<NormalizedNoteTag>,
    or_groups: BTreeSet<Vec<NormalizedNoteTag>>,
}

fn canonical_search_filters(query: &NoteStructuredSearchQuery) -> CanonicalSearchFilters {
    let mut required = query
        .required_tags
        .iter()
        .map(canonical_search_tag)
        .collect::<BTreeSet<_>>();
    let excluded = query
        .excluded_tags
        .iter()
        .map(canonical_search_tag)
        .collect::<BTreeSet<_>>();
    let mut groups = BTreeSet::new();
    for group in &query.or_groups {
        let alternatives = group
            .iter()
            .map(canonical_search_tag)
            .collect::<BTreeSet<_>>();
        if alternatives.len() == 1 {
            required.extend(alternatives);
        } else if !alternatives.is_empty() {
            groups.insert(alternatives.into_iter().collect());
        }
    }
    CanonicalSearchFilters {
        required,
        excluded,
        or_groups: groups,
    }
}

pub(crate) fn validate_structured_search_query_input(
    query: &NoteStructuredSearchQuery,
) -> Result<(), String> {
    if query.text.len() > NOTE_SEARCH_MAX_TEXT_UTF8_BYTES {
        return Err("Structured Notes search text exceeds 4096 UTF-8 bytes.".to_string());
    }
    if query.or_groups.len() > NOTE_SEARCH_MAX_OR_GROUPS {
        return Err("Structured Notes search has more than 16 OR groups.".to_string());
    }
    if query
        .or_groups
        .iter()
        .any(|group| group.len() > NOTE_SEARCH_MAX_ALTERNATIVES_PER_OR_GROUP)
    {
        return Err("Structured Notes search OR group has more than 16 alternatives.".to_string());
    }

    let tags = query
        .required_tags
        .iter()
        .chain(query.excluded_tags.iter())
        .chain(query.or_groups.iter().flatten());
    if tags
        .into_iter()
        .any(|tag| !is_canonical_tag_body(&tag.normalized_tag))
    {
        return Err(
            "Structured Notes search tag normalizedTag must be a canonical tag body.".to_string(),
        );
    }

    let filters = canonical_search_filters(query);
    let unique_tags = filters
        .required
        .iter()
        .chain(filters.excluded.iter())
        .chain(filters.or_groups.iter().flatten())
        .collect::<BTreeSet<_>>();
    if unique_tags.len() > NOTE_SEARCH_MAX_UNIQUE_TAG_ALTERNATIVES {
        return Err(
            "Structured Notes search has more than 64 unique tag alternatives.".to_string(),
        );
    }
    Ok(())
}

fn validate_structured_search_query(
    query: &NoteStructuredSearchQuery,
) -> Result<CanonicalSearchFilters, String> {
    validate_structured_search_query_input(query)?;
    Ok(canonical_search_filters(query))
}

fn push_tag_parameters(
    parameters: &mut Vec<String>,
    prefix: NoteTagPrefix,
    normalized_tag: &str,
) -> (usize, usize) {
    parameters.push(prefix.as_str().to_string());
    let prefix_parameter = parameters.len();
    parameters.push(normalized_tag.to_string());
    (prefix_parameter, parameters.len())
}

pub(crate) fn search_nodes_structured(
    connection: &Connection,
    query: &NoteStructuredSearchQuery,
) -> Result<Vec<NoteSearchResult>, String> {
    let CanonicalSearchFilters {
        required,
        excluded,
        or_groups,
    } = validate_structured_search_query(query)?;
    let match_expression = fts_match_expression(&query.text);
    if match_expression.is_none()
        && required.is_empty()
        && excluded.is_empty()
        && or_groups.is_empty()
    {
        return Ok(Vec::new());
    }

    let positive_tags = required
        .iter()
        .cloned()
        .chain(or_groups.iter().flatten().cloned())
        .collect::<BTreeSet<_>>();
    let mut parameters = Vec::new();
    let mut predicates = Vec::new();
    if let Some(expression) = &match_expression {
        parameters.push(expression.clone());
        predicates.push(format!("notes_search MATCH ?{}", parameters.len()));
    }
    for (prefix, normalized_tag) in required {
        let (prefix_parameter, tag_parameter) =
            push_tag_parameters(&mut parameters, prefix, &normalized_tag);
        predicates.push(format!(
            "EXISTS (SELECT 1 FROM notes_tags tag \
             WHERE tag.node_id = node.id AND tag.prefix = ?{prefix_parameter} \
               AND tag.normalized_tag = ?{tag_parameter})"
        ));
    }
    for (prefix, normalized_tag) in excluded {
        let (prefix_parameter, tag_parameter) =
            push_tag_parameters(&mut parameters, prefix, &normalized_tag);
        predicates.push(format!(
            "NOT EXISTS (SELECT 1 FROM notes_tags tag \
             WHERE tag.node_id = node.id AND tag.prefix = ?{prefix_parameter} \
               AND tag.normalized_tag = ?{tag_parameter})"
        ));
    }
    for group in or_groups {
        let alternatives = group
            .into_iter()
            .map(|(prefix, normalized_tag)| {
                let (prefix_parameter, tag_parameter) =
                    push_tag_parameters(&mut parameters, prefix, &normalized_tag);
                format!(
                    "(tag.prefix = ?{prefix_parameter} AND tag.normalized_tag = ?{tag_parameter})"
                )
            })
            .collect::<Vec<_>>();
        predicates.push(format!(
            "EXISTS (SELECT 1 FROM notes_tags tag WHERE tag.node_id = node.id AND ({}))",
            alternatives.join(" OR ")
        ));
    }

    let tag_predicates = if predicates.is_empty() {
        String::new()
    } else {
        format!(" AND {}", predicates.join(" AND "))
    };
    let sql = if match_expression.is_some() {
        format!(
            "SELECT notes_search.node_id, node.title, node.note, \
                    highlight(notes_search, 1, '<notes-match>', '</notes-match>') \
                      <> notes_search.title \
             FROM notes_search \
             JOIN notes_nodes node ON node.id = notes_search.node_id \
             WHERE node.deleted_at IS NULL AND node.archived_at IS NULL{tag_predicates} \
             ORDER BY bm25(notes_search, 0.0, 10.0, 1.0), node.updated_at DESC, node.id \
             LIMIT 100"
        )
    } else {
        format!(
            "SELECT node.id, node.title, node.note, 0 \
             FROM notes_nodes node \
             WHERE node.deleted_at IS NULL AND node.archived_at IS NULL{tag_predicates} \
             ORDER BY node.updated_at DESC, node.id LIMIT 100"
        )
    };
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Could not prepare the structured Notes search: {error}"))?;
    let matches = statement
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
            ))
        })
        .map_err(|error| format!("Could not search Notes with tag filters: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read structured Notes search results: {error}"))?;
    let parents = search_parent_map(connection, NoteSearchScope::Active)?;

    matches
        .into_iter()
        .map(|(node_id, title, _note, matched_title)| {
            let matched_field = if match_expression.is_some() {
                if matched_title {
                    NoteSearchMatchedField::Title
                } else {
                    NoteSearchMatchedField::Note
                }
            } else if positive_tags.is_empty()
                || tokenize_note_text(&title)
                    .iter()
                    .any(|tag| positive_tags.contains(&(tag.prefix, tag.normalized.clone())))
            {
                NoteSearchMatchedField::Title
            } else {
                NoteSearchMatchedField::Note
            };
            Ok(NoteSearchResult {
                parent_trail: parent_trail(&node_id, &parents)?,
                node_id,
                title,
                matched_field,
            })
        })
        .collect()
}

fn with_workspace_transaction(
    connection: &mut Connection,
    operation: impl FnOnce(&Transaction<'_>) -> Result<(), String>,
) -> Result<NotesWorkspace, String> {
    let journaled = history::has_active_context(connection)?;
    let transaction = if journaled {
        connection.transaction_with_behavior(TransactionBehavior::Immediate)
    } else {
        connection.transaction()
    }
    .map_err(|error| format!("Could not start the Notes transaction: {error}"))?;
    operation(&transaction)?;
    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    if journaled {
        history::finalize_transaction(&transaction)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes transaction: {error}"))?;
    Ok(workspace)
}

fn node_by_id(transaction: &Transaction<'_>, node_id: &str) -> Result<Option<StoredNode>, String> {
    transaction
        .query_row(
            "SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                    is_starred, completed_at, deleted_at, deleted_batch_id, archived_at, \
                    archive_root_id \
             FROM notes_nodes WHERE id = ?1",
            [node_id],
            stored_node_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not read Note node {node_id}: {error}"))
}

fn require_live_node(transaction: &Transaction<'_>, node_id: &str) -> Result<StoredNode, String> {
    match node_by_id(transaction, node_id)? {
        Some(node) if node.deleted_at.is_none() => Ok(node),
        Some(_) => Err(format!("Note node {node_id} is in the trash.")),
        None => Err(format!("Note node {node_id} does not exist.")),
    }
}

fn require_active_node(transaction: &Transaction<'_>, node_id: &str) -> Result<StoredNode, String> {
    match require_live_node(transaction, node_id)? {
        node if node.archived_at.is_none() => Ok(node),
        _ => Err(format!("Note node {node_id} is archived.")),
    }
}

fn require_deleted_node(
    transaction: &Transaction<'_>,
    node_id: &str,
) -> Result<StoredNode, String> {
    match node_by_id(transaction, node_id)? {
        Some(node) if node.deleted_at.is_some() => Ok(node),
        Some(_) => Err(format!("Note node {node_id} is not in the trash.")),
        None => Err(format!("Note node {node_id} does not exist.")),
    }
}

fn ensure_fresh_id(transaction: &Transaction<'_>, node_id: &str) -> Result<(), String> {
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
            [node_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not validate the new Note ID: {error}"))?;
    if exists {
        Err(format!("Note ID {node_id} is already in use."))
    } else {
        Ok(())
    }
}

fn ensure_live_parent(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
) -> Result<(), String> {
    if let Some(parent_id) = parent_id {
        require_active_node(transaction, parent_id)?;
    }
    Ok(())
}

fn sibling_keys(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    excluded_id: Option<&str>,
) -> Result<Vec<(String, i64)>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, sort_key FROM notes_nodes \
             WHERE parent_id IS ?1 AND deleted_at IS NULL AND archived_at IS NULL \
               AND (?2 IS NULL OR id <> ?2) \
             ORDER BY sort_key, id",
        )
        .map_err(|error| format!("Could not prepare sibling ordering: {error}"))?;
    let siblings = statement
        .query_map(params![parent_id, excluded_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|error| format!("Could not read sibling ordering: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect sibling ordering: {error}"))?;
    Ok(siblings)
}

fn rebalance_siblings(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    excluded_id: Option<&str>,
) -> Result<(), String> {
    let siblings = sibling_keys(transaction, parent_id, excluded_id)?;
    for (index, (node_id, _)) in siblings.iter().enumerate() {
        let sort_key = i64::try_from(index + 1)
            .ok()
            .and_then(|position| position.checked_mul(SORT_KEY_STEP))
            .ok_or_else(|| "The Notes sibling ordering is too large to rebalance.".to_string())?;
        transaction
            .execute(
                "UPDATE notes_nodes \
                 SET sort_key = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?2",
                params![sort_key, node_id],
            )
            .map_err(|error| format!("Could not rebalance Note siblings: {error}"))?;
    }
    Ok(())
}

fn next_sort_key(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    after_id: Option<&str>,
) -> Result<i64, String> {
    next_sort_key_excluding(transaction, parent_id, after_id, None, None)
}

fn next_sort_key_excluding(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    before_id: Option<&str>,
    excluded_id: Option<&str>,
) -> Result<i64, String> {
    let siblings = sibling_keys(transaction, parent_id, excluded_id)?;
    let calculate = |siblings: &[(String, i64)]| -> Result<Option<i64>, String> {
        if after_id.is_some() && before_id.is_some() {
            return Err("A node move cannot specify both afterId and beforeId.".to_string());
        }
        if let Some(before_id) = before_id {
            let index = siblings
                .iter()
                .position(|(node_id, _)| node_id == before_id)
                .ok_or_else(|| {
                    "The requested beforeId must identify a live sibling under the target parent."
                        .to_string()
                })?;
            let right = siblings[index].1;
            return match index.checked_sub(1).and_then(|index| siblings.get(index)) {
                Some((_, left)) => {
                    let gap = i128::from(right) - i128::from(*left);
                    if gap > 1 {
                        Ok(Some((i128::from(*left) + gap / 2) as i64))
                    } else {
                        Ok(None)
                    }
                }
                None => Ok(right.checked_sub(SORT_KEY_STEP)),
            };
        }
        let Some(after_id) = after_id else {
            return match siblings.last() {
                Some((_, sort_key)) => Ok(sort_key.checked_add(SORT_KEY_STEP)),
                None => Ok(Some(SORT_KEY_STEP)),
            };
        };
        let index = siblings
            .iter()
            .position(|(node_id, _)| node_id == after_id)
            .ok_or_else(|| {
                "The requested afterId must identify a live sibling under the target parent."
                    .to_string()
            })?;
        let left = siblings[index].1;
        match siblings.get(index + 1) {
            Some((_, right)) => {
                let gap = i128::from(*right) - i128::from(left);
                if gap > 1 {
                    Ok(Some((i128::from(left) + gap / 2) as i64))
                } else {
                    Ok(None)
                }
            }
            None => Ok(left.checked_add(SORT_KEY_STEP)),
        }
    };

    if let Some(sort_key) = calculate(&siblings)? {
        return Ok(sort_key);
    }

    rebalance_siblings(transaction, parent_id, excluded_id)?;
    let rebalanced = sibling_keys(transaction, parent_id, excluded_id)?;
    calculate(&rebalanced)?.ok_or_else(|| {
        "Could not allocate a sparse Note sort key after rebalancing siblings.".to_string()
    })
}

fn replace_tags(
    transaction: &Transaction<'_>,
    node_id: &str,
    title: &str,
    note: &str,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM notes_tags WHERE node_id = ?1", [node_id])
        .map_err(|error| format!("Could not clear Note tags: {error}"))?;
    for ((prefix, normalized_tag), tag) in extract_note_tags(title, note) {
        transaction
            .execute(
                "INSERT INTO notes_tags (node_id, prefix, tag, normalized_tag) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![node_id, prefix.as_str(), tag, normalized_tag],
            )
            .map_err(|error| format!("Could not store Note tags: {error}"))?;
    }
    Ok(())
}

// Relative phrases are derived data: every content rebuild resolves them against
// the command's single injected local `today` value.
fn replace_dates(
    transaction: &Transaction<'_>,
    node_id: &str,
    title: &str,
    note: &str,
    today: LocalDate,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM notes_dates WHERE node_id = ?1", [node_id])
        .map_err(|error| format!("Could not clear Note dates: {error}"))?;
    for (field, source) in [("title", title), ("note", note)] {
        for date in find_note_date_matches(source, today, WeekStartsOn::Monday) {
            let start_utf16 = i64::try_from(date.start_utf16)
                .map_err(|_| "A Note date offset exceeds SQLite integer range.".to_string())?;
            let end_utf16 = i64::try_from(date.end_utf16)
                .map_err(|_| "A Note date offset exceeds SQLite integer range.".to_string())?;
            transaction
                .execute(
                    "INSERT INTO notes_dates (\
                       node_id, field, start_utf16, end_utf16, normalized_start, \
                       normalized_end, token_text\
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        node_id,
                        field,
                        start_utf16,
                        end_utf16,
                        date.start.to_iso(),
                        date.end.unwrap_or(date.start).to_iso(),
                        date.raw
                    ],
                )
                .map_err(|error| format!("Could not store Note dates: {error}"))?;
        }
    }
    Ok(())
}

fn replace_derived_content(
    transaction: &Transaction<'_>,
    node_id: &str,
    title: &str,
    note: &str,
    today: LocalDate,
) -> Result<(), String> {
    replace_tags(transaction, node_id, title, note)?;
    replace_dates(transaction, node_id, title, note, today)
}

pub(crate) fn rebuild_derived_for_nodes(
    transaction: &Transaction<'_>,
    node_ids: &BTreeSet<String>,
) -> Result<(), String> {
    let today = SystemLocalTodayProvider.local_today(transaction)?;
    rebuild_derived_for_nodes_at(transaction, node_ids, today)
}

pub(crate) fn rebuild_derived_for_nodes_at(
    transaction: &Transaction<'_>,
    node_ids: &BTreeSet<String>,
    today: LocalDate,
) -> Result<(), String> {
    for node_id in node_ids {
        let content = transaction
            .query_row(
                "SELECT title, note FROM notes_nodes WHERE id = ?1",
                [node_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| {
                format!("Could not read Note content after history replay: {error}")
            })?;
        if let Some((title, note)) = content {
            replace_derived_content(transaction, node_id, &title, &note, today)?;
        } else {
            transaction
                .execute("DELETE FROM notes_tags WHERE node_id = ?1", [node_id])
                .map_err(|error| {
                    format!("Could not clear Note tags after history replay: {error}")
                })?;
            transaction
                .execute("DELETE FROM notes_dates WHERE node_id = ?1", [node_id])
                .map_err(|error| {
                    format!("Could not clear Note dates after history replay: {error}")
                })?;
        }
    }
    Ok(())
}

pub(crate) fn create_node(
    connection: &mut Connection,
    input: CreateNodeInput,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    create_node_at(connection, input, today)
}

pub(crate) fn create_node_at(
    connection: &mut Connection,
    input: CreateNodeInput,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        ensure_fresh_id(transaction, &input.id)?;
        ensure_live_parent(transaction, input.parent_id.as_deref())?;
        let sort_key = next_sort_key(
            transaction,
            input.parent_id.as_deref(),
            input.after_id.as_deref(),
        )?;
        transaction
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, ?5, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 )",
                params![input.id, input.parent_id, sort_key, input.title, input.note],
            )
            .map_err(|error| format!("Could not create the Note node: {error}"))?;
        replace_derived_content(transaction, &input.id, &input.title, &input.note, today)
    })
}

pub(crate) fn update_node(
    connection: &mut Connection,
    input: UpdateNodeInput,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    update_node_at(connection, input, today)
}

pub(crate) fn update_node_at(
    connection: &mut Connection,
    input: UpdateNodeInput,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        require_active_node(transaction, &input.id)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET title = ?1, note = ?2, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?3 AND deleted_at IS NULL AND archived_at IS NULL",
                params![input.title, input.note, input.id],
            )
            .map_err(|error| format!("Could not update the Note node: {error}"))?;
        replace_derived_content(transaction, &input.id, &input.title, &input.note, today)
    })
}

pub(crate) fn split_node(
    connection: &mut Connection,
    input: SplitNodeInput,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    split_node_at(connection, input, today)
}

pub(crate) fn split_node_at(
    connection: &mut Connection,
    input: SplitNodeInput,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_active_node(transaction, &input.id)?;
        ensure_fresh_id(transaction, &input.new_node_id)?;
        let sort_key = next_sort_key(
            transaction,
            source.parent_id.as_deref(),
            Some(source.id.as_str()),
        )?;
        transaction
            .execute(
                "UPDATE notes_nodes SET title = ?1, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?2 AND deleted_at IS NULL AND archived_at IS NULL",
                params![input.prefix, source.id],
            )
            .map_err(|error| format!("Could not update the split Note node: {error}"))?;
        replace_derived_content(transaction, &source.id, &input.prefix, &source.note, today)?;
        transaction
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 )",
                params![input.new_node_id, source.parent_id, sort_key, input.suffix],
            )
            .map_err(|error| format!("Could not create the split Note node: {error}"))?;
        replace_derived_content(transaction, &input.new_node_id, &input.suffix, "", today)?;
        Ok(())
    })
}

fn live_descendant_exists(
    transaction: &Transaction<'_>,
    node_id: &str,
    candidate_id: &str,
) -> Result<bool, String> {
    transaction
        .query_row(
            "WITH RECURSIVE descendants(id) AS (\
               SELECT id FROM notes_nodes WHERE parent_id = ?1 AND deleted_at IS NULL \
                 AND archived_at IS NULL \
               UNION ALL \
               SELECT child.id FROM notes_nodes child \
               JOIN descendants parent ON child.parent_id = parent.id \
               WHERE child.deleted_at IS NULL AND child.archived_at IS NULL\
             ) \
             SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
            params![node_id, candidate_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not validate the Note move: {error}"))
}

pub(crate) fn move_node(
    connection: &mut Connection,
    input: MoveNodeInput,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        require_active_node(transaction, &input.id)?;
        ensure_live_parent(transaction, input.parent_id.as_deref())?;
        if let Some(parent_id) = input.parent_id.as_deref() {
            if live_descendant_exists(transaction, &input.id, parent_id)? {
                return Err("A Note node cannot be moved under a live descendant.".to_string());
            }
        }
        let sort_key = next_sort_key_excluding(
            transaction,
            input.parent_id.as_deref(),
            input.after_id.as_deref(),
            input.before_id.as_deref(),
            Some(&input.id),
        )?;
        transaction
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1, sort_key = ?2, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?3 AND deleted_at IS NULL AND archived_at IS NULL",
                params![input.parent_id, sort_key, input.id],
            )
            .map_err(|error| format!("Could not move the Note node: {error}"))?;
        Ok(())
    })
}

pub(crate) fn toggle_complete(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        require_active_node(transaction, node_id)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET \
                   completed_at = CASE WHEN completed_at IS NULL \
                     THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not toggle Note completion: {error}"))?;
        Ok(())
    })
}

pub(crate) fn toggle_collapsed(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        require_active_node(transaction, node_id)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET is_collapsed = CASE is_collapsed WHEN 0 THEN 1 ELSE 0 END, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not toggle Note collapse: {error}"))?;
        Ok(())
    })
}

pub(crate) fn toggle_star(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        require_active_node(transaction, node_id)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET is_starred = CASE is_starred WHEN 0 THEN 1 ELSE 0 END, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not toggle Note star: {error}"))?;
        Ok(())
    })
}

fn active_subtree(transaction: &Transaction<'_>, root_id: &str) -> Result<Vec<StoredNode>, String> {
    let mut statement = transaction
        .prepare(
            "WITH RECURSIVE subtree(id) AS (\
               SELECT id FROM notes_nodes WHERE id = ?1 AND deleted_at IS NULL \
                 AND archived_at IS NULL \
               UNION ALL \
               SELECT child.id FROM notes_nodes child \
               JOIN subtree parent ON child.parent_id = parent.id \
               WHERE child.deleted_at IS NULL AND child.archived_at IS NULL\
             ) \
             SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                    is_starred, completed_at, deleted_at, deleted_batch_id, archived_at, \
                    archive_root_id \
             FROM notes_nodes WHERE id IN subtree",
        )
        .map_err(|error| format!("Could not prepare the Note subtree: {error}"))?;
    let nodes = statement
        .query_map([root_id], stored_node_from_row)
        .map_err(|error| format!("Could not load the Note subtree: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Note subtree: {error}"))?;

    let mut by_id = nodes
        .into_iter()
        .map(|node| (node.id.clone(), node))
        .collect::<HashMap<_, _>>();
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for node in by_id.values() {
        if node.id != root_id {
            if let Some(parent_id) = &node.parent_id {
                children
                    .entry(parent_id.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }
    }
    for child_ids in children.values_mut() {
        child_ids.sort_by(|left, right| {
            let left_node = &by_id[left];
            let right_node = &by_id[right];
            left_node
                .sort_key
                .cmp(&right_node.sort_key)
                .then_with(|| left.cmp(right))
        });
    }

    fn visit(
        node_id: &str,
        by_id: &mut HashMap<String, StoredNode>,
        children: &HashMap<String, Vec<String>>,
        visited: &mut HashSet<String>,
        ordered: &mut Vec<StoredNode>,
    ) -> Result<(), String> {
        if !visited.insert(node_id.to_string()) {
            return Err("The Notes tree contains a cycle and cannot be duplicated.".to_string());
        }
        let node = by_id
            .remove(node_id)
            .ok_or_else(|| format!("Note node {node_id} disappeared while duplicating."))?;
        ordered.push(node);
        if let Some(child_ids) = children.get(node_id) {
            for child_id in child_ids {
                visit(child_id, by_id, children, visited, ordered)?;
            }
        }
        Ok(())
    }

    let mut ordered = Vec::new();
    visit(
        root_id,
        &mut by_id,
        &children,
        &mut HashSet::new(),
        &mut ordered,
    )?;
    Ok(ordered)
}

fn fresh_uuid_v4(
    transaction: &Transaction<'_>,
    reserved: &HashSet<String>,
) -> Result<String, String> {
    for _ in 0..16 {
        let id: String = transaction
            .query_row(
                "SELECT lower(\
                   hex(randomblob(4)) || '-' || hex(randomblob(2)) || \
                   '-4' || substr(hex(randomblob(2)), 2) || '-' || \
                   substr('89ab', (random() & 3) + 1, 1) || \
                   substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))\
                 )",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not generate a Note ID: {error}"))?;
        validate_note_id(&id)?;
        if !reserved.contains(&id) && node_by_id(transaction, &id)?.is_none() {
            return Ok(id);
        }
    }
    Err("Could not generate a unique Note ID.".to_string())
}

pub(crate) fn duplicate_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    duplicate_node_at(connection, node_id, today)
}

pub(crate) fn duplicate_node_at(
    connection: &mut Connection,
    node_id: &str,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_active_node(transaction, node_id)?;
        let subtree = active_subtree(transaction, node_id)?;
        let root_sort_key = next_sort_key(
            transaction,
            source.parent_id.as_deref(),
            Some(source.id.as_str()),
        )?;

        let mut reserved = HashSet::new();
        let mut copied_ids = HashMap::new();
        for original in &subtree {
            let copied_id = fresh_uuid_v4(transaction, &reserved)?;
            reserved.insert(copied_id.clone());
            copied_ids.insert(original.id.clone(), copied_id);
        }

        for original in &subtree {
            let copied_id = copied_ids
                .get(&original.id)
                .expect("every duplicated node has a generated ID");
            let copied_parent_id = if original.id == source.id {
                source.parent_id.as_deref()
            } else {
                original
                    .parent_id
                    .as_ref()
                    .and_then(|parent_id| copied_ids.get(parent_id))
                    .map(String::as_str)
            };
            let sort_key = if original.id == source.id {
                root_sort_key
            } else {
                original.sort_key
            };
            transaction
                .execute(
                    "INSERT INTO notes_nodes (\
                       id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                       is_starred, completed_at, created_at, updated_at\
                     ) VALUES (\
                       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                     )",
                    params![
                        copied_id,
                        copied_parent_id,
                        sort_key,
                        original.title,
                        original.note,
                        original.layout_mode,
                        original.is_collapsed,
                        original.is_starred,
                        original.completed_at
                    ],
                )
                .map_err(|error| format!("Could not duplicate the Note subtree: {error}"))?;
            replace_derived_content(
                transaction,
                copied_id,
                &original.title,
                &original.note,
                today,
            )?;
        }

        if copied_ids.contains_key(node_id) {
            Ok(())
        } else {
            Err("Could not identify the duplicated Note root.".to_string())
        }
    })
}

pub(crate) fn remove_empty_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_active_node(transaction, node_id)?;
        let has_attachments: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_attachments WHERE node_id = ?1)",
                [node_id],
                |row| row.get(0),
            )
            .map_err(|error| {
                format!("Could not inspect attachments on the empty Note node: {error}")
            })?;
        if !source.title.trim().is_empty() || !source.note.trim().is_empty() || has_attachments {
            return Err("Only an empty Note node can be removed.".to_string());
        }
        let children = sibling_keys(transaction, Some(node_id), None)?;
        if !children.is_empty() {
            let siblings = sibling_keys(transaction, source.parent_id.as_deref(), None)?;
            let mut desired_order = Vec::with_capacity(siblings.len() - 1 + children.len());
            for (sibling_id, _) in siblings {
                if sibling_id == node_id {
                    desired_order.extend(children.iter().map(|(child_id, _)| child_id.clone()));
                } else {
                    desired_order.push(sibling_id);
                }
            }
            for (index, sibling_id) in desired_order.iter().enumerate() {
                let sort_key = i64::try_from(index + 1)
                    .ok()
                    .and_then(|position| position.checked_mul(SORT_KEY_STEP))
                    .ok_or_else(|| {
                        "The Notes sibling ordering is too large to rewrite.".to_string()
                    })?;
                transaction
                    .execute(
                        "UPDATE notes_nodes SET parent_id = ?1, sort_key = ?2, \
                            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                         WHERE id = ?3 AND deleted_at IS NULL AND archived_at IS NULL",
                        params![source.parent_id, sort_key, sibling_id],
                    )
                    .map_err(|error| {
                        format!("Could not reparent children of the empty Note node: {error}")
                    })?;
            }
        }
        let deletion_batch_id = fresh_deletion_batch_id(transaction)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET \
                   deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   deleted_batch_id = ?2, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                params![node_id, deletion_batch_id],
            )
            .map_err(|error| format!("Could not remove the empty Note node: {error}"))?;
        Ok(())
    })
}

fn fresh_deletion_batch_id(transaction: &Transaction<'_>) -> Result<String, String> {
    transaction
        .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
        .map_err(|error| format!("Could not create a Notes deletion batch: {error}"))
}

pub(crate) fn archive_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_active_node(transaction, node_id)?;
        if source.parent_id.is_some() {
            return Err("Only a root Note node can be archived.".to_string());
        }
        transaction
            .execute(
                "WITH RECURSIVE \
                 archive_context(archived_at) AS (\
                   SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 ), \
                 subtree(id) AS (\
                   SELECT id FROM notes_nodes \
                   WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL \
                   UNION ALL \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id \
                   WHERE child.deleted_at IS NULL AND child.archived_at IS NULL\
                 ) \
                 UPDATE notes_nodes SET \
                   archived_at = (SELECT archived_at FROM archive_context), \
                   archive_root_id = ?1, \
                   updated_at = (SELECT archived_at FROM archive_context) \
                 WHERE id IN subtree",
                [node_id],
            )
            .map_err(|error| format!("Could not archive the Note subtree: {error}"))?;
        Ok(())
    })
}

pub(crate) fn unarchive_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = node_by_id(transaction, node_id)?
            .ok_or_else(|| format!("Note node {node_id} does not exist."))?;
        if source.deleted_at.is_some() {
            return Err(format!("Note node {node_id} is in the trash."));
        }
        if source.archived_at.is_none() {
            return Err(format!("Note node {node_id} is not archived."));
        }
        if source.parent_id.is_some() || source.archive_root_id.as_deref() != Some(node_id) {
            return Err("Only an archive root can be unarchived.".to_string());
        }

        resolve_restore_sort_collision(transaction, &source)?;
        let changed = transaction
            .execute(
                "UPDATE notes_nodes SET archived_at = NULL, archive_root_id = NULL, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE archive_root_id = ?1 AND deleted_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not unarchive the Note subtree: {error}"))?;
        if changed == 0 {
            return Err(format!("Archive root {node_id} owns no live Note nodes."));
        }
        Ok(())
    })
}

pub(crate) fn soft_delete_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_live_node(transaction, node_id)?;
        if source.archived_at.is_some()
            && (source.parent_id.is_some() || source.archive_root_id.as_deref() != Some(node_id))
        {
            return Err("Only an archive root can be moved to trash.".to_string());
        }
        let deletion_batch_id = fresh_deletion_batch_id(transaction)?;
        transaction
            .execute(
                "WITH RECURSIVE subtree(id) AS (\
                   SELECT id FROM notes_nodes \
                   WHERE id = ?1 AND deleted_at IS NULL AND archive_root_id IS ?3 \
                   UNION ALL \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id \
                   WHERE child.deleted_at IS NULL AND child.archive_root_id IS ?3\
                 ) \
                 UPDATE notes_nodes SET \
                   deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   deleted_batch_id = ?2, \
                   archived_at = NULL, \
                   archive_root_id = NULL, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id IN subtree",
                params![node_id, deletion_batch_id, source.archive_root_id],
            )
            .map_err(|error| format!("Could not move the Note subtree to trash: {error}"))?;
        Ok(())
    })
}

fn resolve_restore_sort_collision(
    transaction: &Transaction<'_>,
    source: &StoredNode,
) -> Result<(), String> {
    let siblings = sibling_keys(transaction, source.parent_id.as_deref(), None)?;
    if !siblings
        .iter()
        .any(|(_, sort_key)| *sort_key == source.sort_key)
    {
        return Ok(());
    }

    let insert_at = siblings
        .iter()
        .position(|(_, sort_key)| *sort_key >= source.sort_key)
        .unwrap_or(siblings.len());
    let mut ordered_ids = siblings
        .into_iter()
        .map(|(node_id, _)| node_id)
        .collect::<Vec<_>>();
    ordered_ids.insert(insert_at, source.id.clone());
    for (index, node_id) in ordered_ids.iter().enumerate() {
        let sort_key = i64::try_from(index + 1)
            .ok()
            .and_then(|position| position.checked_mul(SORT_KEY_STEP))
            .ok_or_else(|| "The Notes sibling ordering is too large to restore.".to_string())?;
        transaction
            .execute(
                "UPDATE notes_nodes SET sort_key = ?1, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?2",
                params![sort_key, node_id],
            )
            .map_err(|error| format!("Could not reorder restored Note siblings: {error}"))?;
    }
    Ok(())
}

pub(crate) fn restore_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    restore_node_at(connection, node_id, today)
}

pub(crate) fn restore_node_at(
    connection: &mut Connection,
    node_id: &str,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_deleted_node(transaction, node_id)?;
        let deletion_batch_id = source
            .deleted_batch_id
            .as_deref()
            .ok_or_else(|| format!("Deleted Note node {node_id} has no deletion batch."))?;
        let parent_is_live = match source.parent_id.as_deref() {
            Some(parent_id) => node_by_id(transaction, parent_id)?
                .is_some_and(|parent| parent.deleted_at.is_none() && parent.archived_at.is_none()),
            None => true,
        };
        if !parent_is_live {
            let sort_key = next_sort_key(transaction, None, None)?;
            transaction
                .execute(
                    "UPDATE notes_nodes SET parent_id = NULL, sort_key = ?1 \
                     WHERE id = ?2 AND deleted_at IS NOT NULL",
                    params![sort_key, node_id],
                )
                .map_err(|error| {
                    format!("Could not restore the Note subtree at the root: {error}")
                })?;
        } else {
            resolve_restore_sort_collision(transaction, &source)?;
        }
        transaction
            .execute(
                "WITH RECURSIVE subtree(id) AS (\
                   SELECT id FROM notes_nodes WHERE id = ?1 AND deleted_batch_id = ?2 \
                   UNION ALL \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id \
                   WHERE child.deleted_batch_id = ?2\
                 ) \
                 UPDATE notes_nodes SET deleted_at = NULL, deleted_batch_id = NULL, \
                   archived_at = NULL, archive_root_id = NULL, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id IN subtree AND deleted_batch_id = ?2",
                params![node_id, deletion_batch_id],
            )
            .map_err(|error| format!("Could not restore the Note subtree: {error}"))?;
        let restored_node_ids = active_subtree(transaction, node_id)?
            .into_iter()
            .map(|node| node.id)
            .collect::<BTreeSet<_>>();
        rebuild_derived_for_nodes_at(transaction, &restored_node_ids, today)?;
        Ok(())
    })
}

#[derive(Debug, Clone)]
pub(crate) struct NewAttachment {
    pub(crate) id: String,
    pub(crate) node_id: String,
    pub(crate) relative_path: String,
    pub(crate) content_hash: String,
    pub(crate) original_name: String,
    pub(crate) mime_type: String,
    pub(crate) byte_size: i64,
    pub(crate) intrinsic_width: i64,
    pub(crate) intrinsic_height: i64,
    pub(crate) display_width: i64,
}

fn validate_attachment_display_width(
    display_width: i64,
    intrinsic_width: i64,
) -> Result<(), String> {
    let minimum = intrinsic_width.min(MIN_ATTACHMENT_DISPLAY_WIDTH);
    if intrinsic_width <= 0 || display_width < minimum || display_width > intrinsic_width {
        return Err(format!(
            "A Notes attachment display width must be between {minimum} and {intrinsic_width} pixels."
        ));
    }
    Ok(())
}

pub(crate) fn attachment_by_id(
    connection: &Connection,
    attachment_id: &str,
) -> Result<Option<NoteAttachment>, String> {
    validate_note_id(attachment_id)
        .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
    connection
        .query_row(
            "SELECT id, node_id, sort_key, relative_path, content_hash, original_name, \
                    mime_type, byte_size, intrinsic_width, intrinsic_height, display_width, \
                    created_at, updated_at \
             FROM notes_attachments WHERE id = ?1",
            [attachment_id],
            note_attachment_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not read Notes attachment {attachment_id}: {error}"))
}

fn validate_new_attachment(attachment: &NewAttachment) -> Result<(), String> {
    validate_note_id(&attachment.id)
        .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
    validate_note_id(&attachment.node_id)?;
    validate_attachment_display_width(attachment.display_width, attachment.intrinsic_width)?;
    if attachment.intrinsic_height <= 0 || attachment.byte_size <= 0 {
        return Err(
            "A Notes attachment must have positive decoded dimensions and byte size.".to_string(),
        );
    }
    if attachment.original_name.trim().is_empty() || attachment.original_name.len() > 1024 {
        return Err("A Notes attachment original name must contain 1 to 1024 bytes.".to_string());
    }
    Ok(())
}

fn insert_new_attachment(
    transaction: &Transaction<'_>,
    attachment: NewAttachment,
) -> Result<(), String> {
    require_active_node(transaction, &attachment.node_id)?;
    let id_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_attachments WHERE id = ?1)",
            [&attachment.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not validate the new Notes attachment ID: {error}"))?;
    if id_exists {
        return Err(format!(
            "Notes attachment ID {} is already in use.",
            attachment.id
        ));
    }
    let sort_key: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_key), 0) FROM notes_attachments WHERE node_id = ?1",
            [&attachment.node_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Could not inspect Notes attachment ordering: {error}"))?
        .checked_add(SORT_KEY_STEP)
        .ok_or_else(|| "The Notes attachment ordering is too large.".to_string())?;
    transaction
        .execute(
            "INSERT INTO notes_attachments(\
               id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
               byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![
                attachment.id,
                attachment.node_id,
                sort_key,
                attachment.relative_path,
                attachment.content_hash,
                attachment.original_name,
                attachment.mime_type,
                attachment.byte_size,
                attachment.intrinsic_width,
                attachment.intrinsic_height,
                attachment.display_width,
            ],
        )
        .map_err(|error| format!("Could not create the Notes attachment metadata: {error}"))?;
    Ok(())
}

pub(crate) fn create_attachment(
    connection: &mut Connection,
    attachment: NewAttachment,
) -> Result<NotesWorkspace, String> {
    validate_new_attachment(&attachment)?;
    with_workspace_transaction(connection, |transaction| {
        insert_new_attachment(transaction, attachment)
    })
}

pub(crate) fn create_attachment_coordinated(
    connection: &mut Connection,
    prepare: impl FnOnce() -> Result<NewAttachment, String>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<NotesWorkspace, String> {
    let journaled = history::has_active_context(connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes attachment transaction: {error}"))?;
    let attachment = prepare()?;
    validate_new_attachment(&attachment)?;
    insert_new_attachment(&transaction, attachment)?;
    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    if journaled {
        history::finalize_transaction(&transaction)?;
    }
    before_commit()?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes attachment transaction: {error}"))?;
    Ok(workspace)
}

pub(crate) fn resize_attachment(
    connection: &mut Connection,
    attachment_id: &str,
    display_width: i64,
) -> Result<NotesWorkspace, String> {
    validate_note_id(attachment_id)
        .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
    with_workspace_transaction(connection, |transaction| {
        let attachment = attachment_by_id(transaction, attachment_id)?
            .ok_or_else(|| format!("Notes attachment {attachment_id} does not exist."))?;
        require_active_node(transaction, &attachment.node_id)?;
        validate_attachment_display_width(display_width, attachment.intrinsic_width)?;
        transaction
            .execute(
                "UPDATE notes_attachments SET display_width = ?1, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                params![display_width, attachment_id],
            )
            .map_err(|error| format!("Could not resize the Notes attachment: {error}"))?;
        Ok(())
    })
}

pub(crate) fn remove_attachment(
    connection: &mut Connection,
    attachment_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(attachment_id)
        .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
    with_workspace_transaction(connection, |transaction| {
        let attachment = attachment_by_id(transaction, attachment_id)?
            .ok_or_else(|| format!("Notes attachment {attachment_id} does not exist."))?;
        require_active_node(transaction, &attachment.node_id)?;
        transaction
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [attachment_id],
            )
            .map_err(|error| format!("Could not remove the Notes attachment: {error}"))?;
        Ok(())
    })
}

pub(crate) fn removed_attachment_snapshot(
    connection: &Connection,
    attachment_id: &str,
) -> Result<NoteAttachment, String> {
    validate_note_id(attachment_id)
        .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
    if attachment_by_id(connection, attachment_id)?.is_some() {
        return Err(format!("Notes attachment {attachment_id} already exists."));
    }
    let snapshot = connection
        .query_row(
            "SELECT change.before_json FROM notes_history_changes change \
             JOIN notes_history_entries entry ON entry.id = change.entry_id \
             WHERE change.table_name = 'notes_attachments' AND change.row_id = ?1 \
               AND change.before_json IS NOT NULL AND change.after_json IS NULL \
             ORDER BY entry.rowid DESC, change.ordinal DESC LIMIT 1",
            [attachment_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not find removed Notes attachment metadata: {error}"))?
        .ok_or_else(|| format!("Removed Notes attachment {attachment_id} is not in history."))?;
    let attachment: NoteAttachment = serde_json::from_str(&snapshot)
        .map_err(|error| format!("Could not decode removed Notes attachment metadata: {error}"))?;
    if attachment.id != attachment_id {
        return Err("A removed Notes attachment snapshot has the wrong ID.".to_string());
    }
    Ok(attachment)
}

pub(crate) fn restore_attachment(
    connection: &mut Connection,
    attachment: NoteAttachment,
) -> Result<NotesWorkspace, String> {
    validate_attachment_display_width(attachment.display_width, attachment.intrinsic_width)?;
    with_workspace_transaction(connection, |transaction| {
        require_active_node(transaction, &attachment.node_id)?;
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_attachments WHERE id = ?1)",
                [&attachment.id],
                |row| row.get(0),
            )
            .map_err(|error| {
                format!("Could not inspect restored Notes attachment metadata: {error}")
            })?;
        if exists {
            return Err(format!(
                "Notes attachment {} already exists.",
                attachment.id
            ));
        }
        transaction
            .execute(
                "INSERT INTO notes_attachments(\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    attachment.id,
                    attachment.node_id,
                    attachment.sort_key,
                    attachment.relative_path,
                    attachment.content_hash,
                    attachment.original_name,
                    attachment.mime_type,
                    attachment.byte_size,
                    attachment.intrinsic_width,
                    attachment.intrinsic_height,
                    attachment.display_width,
                    attachment.created_at,
                    attachment.updated_at,
                ],
            )
            .map_err(|error| format!("Could not restore the Notes attachment metadata: {error}"))?;
        Ok(())
    })
}

pub(crate) fn empty_trash(connection: &mut Connection) -> Result<NotesWorkspace, String> {
    with_workspace_transaction(connection, |transaction| {
        transaction
            .execute("DELETE FROM notes_nodes WHERE deleted_at IS NOT NULL", [])
            .map_err(|error| format!("Could not permanently empty Notes trash: {error}"))?;
        history::clear_all_history_in_transaction(transaction)?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::{
        archive_node, connect_notes_db, create_node, create_node_at, create_version_one_schema,
        delete_database, duplicate_node, duplicate_node_at, empty_trash, initialize_notes_db,
        list_tags, list_tags_with_counts, load_workspace, migrate_version_one_to_two, move_node,
        notes_db_path, observe_next_migration_busy, open_notes_export_db,
        preflight_existing_notes_schema, remove_empty_node, restore_node, restore_node_at,
        search_nodes, search_nodes_at, search_nodes_structured, soft_delete_node, split_node,
        split_node_at, sqlite_companion_path, toggle_collapsed, toggle_complete, toggle_star,
        unarchive_node, update_node, update_node_at,
    };
    use crate::notes::date_index::LocalDate;
    use crate::notes::types::{
        validate_note_id, CreateNodeInput, MoveNodeInput, NoteSearchMatchedField, NoteSearchScope,
        NoteSearchTag, NoteStructuredSearchQuery, NoteTagFilter, NoteTagPrefix,
        NotesWorkspaceScope, SplitNodeInput, UpdateNodeInput,
    };
    use rusqlite::{params, Connection};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_ID: &str = "33333333-3333-4333-8333-333333333333";
    const FOURTH_ID: &str = "44444444-4444-4444-8444-444444444444";
    const FIFTH_ID: &str = "55555555-5555-4555-8555-555555555555";
    const SIXTH_ID: &str = "66666666-6666-4666-8666-666666666666";

    fn fixed_today() -> LocalDate {
        LocalDate::new(2026, 7, 11).expect("fixed date")
    }

    fn date_rows(
        connection: &Connection,
        node_id: &str,
    ) -> Vec<(String, i64, i64, String, String, String)> {
        connection
            .prepare(
                "SELECT field, start_utf16, end_utf16, normalized_start, normalized_end, token_text \
                 FROM notes_dates WHERE node_id = ?1 ORDER BY field DESC, start_utf16",
            )
            .expect("prepare date rows")
            .query_map([node_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .expect("query date rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect date rows")
    }

    fn object_exists(connection: &Connection, object_type: &str, name: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2)",
                params![object_type, name],
                |row| row.get(0),
            )
            .expect("schema object query")
    }

    fn test_connection() -> Connection {
        let mut connection = Connection::open_in_memory().expect("in-memory notes database");
        initialize_notes_db(&mut connection).expect("initialize notes database");
        connection
    }

    fn seed_version_one_database(connection: &mut Connection) {
        let transaction = connection.transaction().expect("version one transaction");
        create_version_one_schema(&transaction).expect("create version one schema");
        transaction
            .pragma_update(None, "user_version", 1)
            .expect("record version one");
        transaction.commit().expect("commit version one schema");
    }

    fn seed_version_two_database(connection: &mut Connection) {
        seed_version_one_database(connection);
        let transaction = connection.transaction().expect("version two transaction");
        migrate_version_one_to_two(&transaction).expect("migrate to version two");
        transaction
            .pragma_update(None, "user_version", 2)
            .expect("record version two");
        transaction.commit().expect("commit version two schema");
    }

    #[test]
    fn export_open_rejects_a_missing_database_without_creating_notes_storage() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");

        let error = open_notes_export_db(vault_path.to_str().expect("vault path"))
            .expect_err("missing export database");

        assert!(error.contains("does not exist"));
        assert!(!vault_path.join(".yonalist").exists());
        assert!(!notes_db_path(vault_path.to_str().expect("vault path")).exists());
    }

    #[test]
    fn export_open_rejects_a_future_schema_without_migration_or_file_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let database_path = notes_db_path(vault_path.to_str().expect("vault path"));
        std::fs::create_dir_all(database_path.parent().expect("metadata path"))
            .expect("create metadata fixture");
        let connection = Connection::open(&database_path).expect("create database fixture");
        connection
            .execute_batch("CREATE TABLE future_only (value TEXT); PRAGMA user_version = 4;")
            .expect("seed future schema");
        drop(connection);
        let bytes_before = std::fs::read(&database_path).expect("read database before export open");

        let error = open_notes_export_db(vault_path.to_str().expect("vault path"))
            .expect_err("future schema must be rejected");

        assert_eq!(
            error,
            "This Notes database uses unsupported schema version 4."
        );
        assert_eq!(
            std::fs::read(&database_path).expect("read database after export open"),
            bytes_before
        );
        assert!(!database_path.with_file_name("notes.sqlite-wal").exists());
        assert!(!database_path.with_file_name("notes.sqlite-shm").exists());
    }

    fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
        connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table info")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table columns")
            .iter()
            .any(|name| name == column)
    }

    fn primary_key_columns(connection: &Connection, table: &str) -> Vec<String> {
        let mut columns = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table primary key")
            .query_map([], |row| {
                Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
            })
            .expect("query table primary key")
            .filter_map(|row| {
                let (position, name) = row.expect("read table primary key");
                (position > 0).then_some((position, name))
            })
            .collect::<Vec<_>>();
        columns.sort_by_key(|(position, _)| *position);
        columns.into_iter().map(|(_, name)| name).collect()
    }

    fn table_columns(connection: &Connection, table: &str) -> Vec<String> {
        connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table columns")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table columns")
    }

    fn insert_node(
        connection: &Connection,
        id: &str,
        parent_id: Option<&str>,
        sort_key: i64,
        title: &str,
    ) -> String {
        connection
            .execute(
                "INSERT INTO notes_nodes (id, parent_id, sort_key, title, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                params![id, parent_id, sort_key, title],
            )
            .expect("insert test node");
        id.to_string()
    }

    fn insert_tree(connection: &Connection) -> String {
        let root = insert_node(connection, NODE_ID, None, 1024, "root");
        insert_node(connection, CHILD_ID, Some(&root), 1024, "child");
        root
    }

    fn create_test_node(
        connection: &mut Connection,
        id: &str,
        parent_id: Option<&str>,
        after_id: Option<&str>,
        title: &str,
        note: &str,
    ) {
        create_node(
            connection,
            CreateNodeInput {
                id: id.to_string(),
                parent_id: parent_id.map(str::to_string),
                after_id: after_id.map(str::to_string),
                title: title.to_string(),
                note: note.to_string(),
            },
        )
        .expect("create test node");
    }

    fn active_children(connection: &Connection, parent_id: Option<&str>) -> Vec<(String, i64)> {
        let mut statement = connection
            .prepare(
                "SELECT id, sort_key FROM notes_nodes \
                 WHERE parent_id IS ?1 AND deleted_at IS NULL \
                 ORDER BY sort_key, id",
            )
            .expect("prepare active children");
        statement
            .query_map([parent_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query active children")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect active children")
    }

    #[derive(Debug, PartialEq)]
    struct PersistentNodeState {
        id: String,
        parent_id: Option<String>,
        sort_key: i64,
        title: String,
        note: String,
        layout_mode: String,
        is_collapsed: i64,
        is_starred: i64,
        completed_at: Option<String>,
        created_at: String,
        updated_at: String,
        deleted_at: Option<String>,
        deleted_batch_id: Option<String>,
    }

    #[derive(Debug, PartialEq)]
    struct PersistentState {
        nodes: Vec<PersistentNodeState>,
        search: Vec<(String, String, String)>,
        tags: Vec<(String, String, String)>,
    }

    fn persistent_state(connection: &Connection) -> PersistentState {
        let nodes = connection
            .prepare(
                "SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                        is_starred, completed_at, created_at, updated_at, deleted_at, \
                        deleted_batch_id \
                 FROM notes_nodes ORDER BY id",
            )
            .expect("prepare node state")
            .query_map([], |row| {
                Ok(PersistentNodeState {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    sort_key: row.get(2)?,
                    title: row.get(3)?,
                    note: row.get(4)?,
                    layout_mode: row.get(5)?,
                    is_collapsed: row.get(6)?,
                    is_starred: row.get(7)?,
                    completed_at: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    deleted_at: row.get(11)?,
                    deleted_batch_id: row.get(12)?,
                })
            })
            .expect("query node state")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect node state");
        let search = connection
            .prepare("SELECT node_id, title, note FROM notes_search ORDER BY node_id")
            .expect("prepare search state")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query search state")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect search state");
        let tags = connection
            .prepare(
                "SELECT node_id, tag, normalized_tag FROM notes_tags \
                 ORDER BY node_id, normalized_tag",
            )
            .expect("prepare tag state")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query tag state")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect tag state");
        PersistentState {
            nodes,
            search,
            tags,
        }
    }

    fn install_remove_terminal_failure_trigger(connection: &Connection, node_id: &str) {
        // Keeping the FTS work and failure in one trigger makes their order deterministic.
        // RAISE(FAIL) leaves earlier statement changes for the outer transaction to roll back.
        connection
            .execute_batch(&format!(
                "DROP TRIGGER notes_nodes_search_update; \
                 CREATE TRIGGER notes_nodes_search_update \
                 AFTER UPDATE OF title, note, deleted_at ON notes_nodes \
                 BEGIN \
                   DELETE FROM notes_search WHERE node_id = OLD.id; \
                   INSERT INTO notes_search (node_id, title, note) \
                   SELECT NEW.id, NEW.title, NEW.note WHERE NEW.deleted_at IS NULL; \
                   SELECT RAISE(FAIL, 'remove terminal search deletion rejected') \
                   WHERE OLD.id = '{node_id}' \
                     AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL \
                     AND NOT EXISTS (SELECT 1 FROM notes_search WHERE node_id = NEW.id); \
                 END;"
            ))
            .expect("install terminal remove failure trigger");
    }

    fn install_restore_terminal_failure_trigger(connection: &Connection, node_id: &str) {
        connection
            .execute_batch(&format!(
                "DROP TRIGGER notes_nodes_search_update; \
                 CREATE TRIGGER notes_nodes_search_update \
                 AFTER UPDATE OF title, note, deleted_at ON notes_nodes \
                 BEGIN \
                   DELETE FROM notes_search WHERE node_id = OLD.id; \
                   INSERT INTO notes_search (node_id, title, note) \
                   SELECT NEW.id, NEW.title, NEW.note WHERE NEW.deleted_at IS NULL; \
                   SELECT RAISE(FAIL, 'restore terminal search reinsertion rejected') \
                   WHERE OLD.id = '{node_id}' \
                     AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL \
                     AND 1 = (SELECT COUNT(*) FROM notes_search \
                              WHERE node_id = NEW.id \
                                AND title = NEW.title AND note = NEW.note); \
                 END;"
            ))
            .expect("install terminal restore failure trigger");
    }

    fn assert_tree_invariants(connection: &Connection) {
        let orphan_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes child \
                 LEFT JOIN notes_nodes parent ON parent.id = child.parent_id \
                 WHERE child.deleted_at IS NULL AND child.parent_id IS NOT NULL \
                   AND (parent.id IS NULL OR parent.deleted_at IS NOT NULL)",
                [],
                |row| row.get(0),
            )
            .expect("live orphan count");
        assert_eq!(orphan_count, 0, "live nodes must have live parents");

        let duplicate_sort_keys: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM (\
                   SELECT parent_id, sort_key FROM notes_nodes \
                   WHERE deleted_at IS NULL GROUP BY parent_id, sort_key HAVING COUNT(*) > 1\
                 )",
                [],
                |row| row.get(0),
            )
            .expect("duplicate sibling sort keys");
        assert_eq!(duplicate_sort_keys, 0, "live sibling keys must be unique");

        let unreachable_count: i64 = connection
            .query_row(
                "WITH RECURSIVE reachable(id) AS (\
                   SELECT id FROM notes_nodes \
                   WHERE deleted_at IS NULL AND parent_id IS NULL \
                   UNION \
                   SELECT child.id FROM notes_nodes child \
                   JOIN reachable parent ON child.parent_id = parent.id \
                   WHERE child.deleted_at IS NULL\
                 ) \
                 SELECT COUNT(*) FROM notes_nodes \
                 WHERE deleted_at IS NULL AND id NOT IN reachable",
                [],
                |row| row.get(0),
            )
            .expect("live nodes unreachable from a root");
        assert_eq!(
            unreachable_count, 0,
            "every live node must reach a root without a cycle"
        );
    }

    #[test]
    fn fresh_database_creates_the_complete_version_three_schema() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("path");
        let connection = connect_notes_db(vault_path).expect("connect notes");

        let node_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("nodes table");
        assert_eq!(node_count, 0);
        assert_eq!(
            notes_db_path(vault_path),
            temp_dir.path().join(".yonalist/notes.sqlite")
        );
        assert!(notes_db_path(vault_path).exists());
        assert!(!temp_dir.path().join(".yonalist/index.sqlite").exists());

        for table in [
            "notes_nodes",
            "notes_tags",
            "notes_preferences",
            "notes_search",
            "notes_search_lifecycle",
            "notes_dates",
            "notes_attachments",
            "notes_history_entries",
            "notes_history_changes",
        ] {
            assert!(
                object_exists(&connection, "table", table),
                "missing table {table}"
            );
        }
        for index in [
            "notes_nodes_active_parent_order",
            "notes_nodes_archive_parent_order",
            "notes_nodes_archive_root_order",
            "notes_tags_normalized_tag",
            "notes_tags_prefix_normalized_tag",
            "notes_dates_range",
            "notes_attachments_node_order",
            "notes_history_session_sequence",
        ] {
            assert!(
                object_exists(&connection, "index", index),
                "missing index {index}"
            );
        }
        assert!(column_exists(&connection, "notes_nodes", "archived_at"));
        assert!(column_exists(&connection, "notes_nodes", "archive_root_id"));
        assert!(column_exists(&connection, "notes_tags", "prefix"));
        assert!(column_exists(&connection, "notes_dates", "start_utf16"));
        assert!(column_exists(&connection, "notes_dates", "end_utf16"));
        assert!(column_exists(
            &connection,
            "notes_history_changes",
            "ordinal"
        ));
        assert_eq!(
            primary_key_columns(&connection, "notes_history_changes"),
            vec!["entry_id", "table_name", "row_id"]
        );
        assert_eq!(
            table_columns(&connection, "notes_history_entries"),
            vec![
                "id",
                "session_id",
                "sequence",
                "is_undone",
                "estimated_bytes"
            ]
        );
        assert_eq!(
            table_columns(&connection, "notes_history_changes"),
            vec![
                "entry_id",
                "table_name",
                "row_id",
                "ordinal",
                "before_json",
                "after_json"
            ]
        );
    }

    #[test]
    fn notes_connection_is_configured_and_migrated_to_version_three() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect notes");

        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign keys");
        let busy_timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy timeout");
        let user_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("user version");

        assert_eq!(journal_mode, "wal");
        assert_eq!(foreign_keys, 1);
        assert_eq!(busy_timeout, 5_000);
        assert_eq!(user_version, 3);
        assert!(column_exists(
            &connection,
            "notes_nodes",
            "deleted_batch_id"
        ));
        assert!(column_exists(&connection, "notes_nodes", "archived_at"));
        assert!(column_exists(&connection, "notes_nodes", "archive_root_id"));
    }

    #[test]
    fn version_three_initialization_repairs_a_missing_archive_ownership_index() {
        let mut connection = test_connection();
        connection
            .execute_batch("DROP INDEX IF EXISTS notes_nodes_archive_root_order;")
            .expect("drop archive ownership index");

        initialize_notes_db(&mut connection).expect("reinitialize version three database");

        assert!(object_exists(
            &connection,
            "index",
            "notes_nodes_archive_root_order"
        ));
    }

    #[test]
    fn version_three_initialization_rebuilds_old_tag_tokens_once_for_every_node() {
        let mut connection = test_connection();
        connection
            .execute(
                "DELETE FROM notes_preferences WHERE key = 'derived.tagTokenizerVersion'",
                [],
            )
            .expect("remove tokenizer version marker");
        connection
            .execute(
                "INSERT INTO notes_nodes (\
                   id, sort_key, title, note, created_at, updated_at\
                 ) VALUES (\
                   ?1, 1024, 'https://example.test/#fragment #café', '', \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'\
                 )",
                [NODE_ID],
            )
            .expect("insert active old-tokenizer node");
        connection
            .execute(
                "INSERT INTO notes_nodes (\
                   id, sort_key, title, note, created_at, updated_at, archived_at, archive_root_id\
                 ) VALUES (\
                   ?1, 2048, '#Archived', '', '2026-07-10T00:00:00.000Z', \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T01:00:00.000Z', ?1\
                 )",
                [CHILD_ID],
            )
            .expect("insert archived old-tokenizer node");
        connection
            .execute(
                "INSERT INTO notes_nodes (\
                   id, sort_key, title, note, created_at, updated_at, deleted_at, deleted_batch_id\
                 ) VALUES (\
                   ?1, 3072, 'Trash', '@Trashed', '2026-07-10T00:00:00.000Z', \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T02:00:00.000Z', 'legacy-trash'\
                 )",
                [THIRD_ID],
            )
            .expect("insert trashed old-tokenizer node");
        connection
            .execute_batch(&format!(
                "INSERT INTO notes_tags (node_id, prefix, tag, normalized_tag) VALUES \
                   ('{NODE_ID}', '#', 'fragment', 'fragment'), \
                   ('{NODE_ID}', '#', 'cafe', 'cafe'), \
                   ('{CHILD_ID}', '#', 'Archived', 'archived'), \
                   ('{THIRD_ID}', '@', 'Trashed', 'trashed'); \
                 CREATE TABLE tag_rebuild_audit (operation TEXT NOT NULL); \
                 CREATE TRIGGER audit_tag_rebuild_delete AFTER DELETE ON notes_tags BEGIN \
                   INSERT INTO tag_rebuild_audit VALUES ('delete'); \
                 END; \
                 CREATE TRIGGER audit_tag_rebuild_insert AFTER INSERT ON notes_tags BEGIN \
                   INSERT INTO tag_rebuild_audit VALUES ('insert'); \
                 END;"
            ))
            .expect("seed stale tags and rewrite audit");

        initialize_notes_db(&mut connection).expect("rebuild old tokenizer tags");

        let tags = connection
            .prepare(
                "SELECT node_id, prefix, tag, normalized_tag FROM notes_tags \
                 ORDER BY node_id, prefix, normalized_tag",
            )
            .expect("prepare rebuilt tags")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .expect("query rebuilt tags")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect rebuilt tags");
        assert_eq!(
            tags,
            vec![
                (
                    NODE_ID.to_string(),
                    "#".to_string(),
                    "café".to_string(),
                    "café".to_string(),
                ),
                (
                    CHILD_ID.to_string(),
                    "#".to_string(),
                    "Archived".to_string(),
                    "archived".to_string(),
                ),
                (
                    THIRD_ID.to_string(),
                    "@".to_string(),
                    "Trashed".to_string(),
                    "trashed".to_string(),
                ),
            ]
        );
        let version: String = connection
            .query_row(
                "SELECT value_json FROM notes_preferences \
                 WHERE key = 'derived.tagTokenizerVersion'",
                [],
                |row| row.get(0),
            )
            .expect("tag tokenizer version marker");
        assert_eq!(version, "1");
        let first_rewrite_count: i64 = connection
            .query_row("SELECT count(*) FROM tag_rebuild_audit", [], |row| {
                row.get(0)
            })
            .expect("first rewrite count");
        assert!(first_rewrite_count > 0);

        initialize_notes_db(&mut connection).expect("idempotent tokenizer initialization");

        let second_rewrite_count: i64 = connection
            .query_row("SELECT count(*) FROM tag_rebuild_audit", [], |row| {
                row.get(0)
            })
            .expect("second rewrite count");
        assert_eq!(second_rewrite_count, first_rewrite_count);

        connection
            .execute(
                "UPDATE notes_preferences SET value_json = '0' \
                 WHERE key = 'derived.tagTokenizerVersion'",
                [],
            )
            .expect("downgrade tokenizer marker");
        initialize_notes_db(&mut connection).expect("rebuild old tokenizer version");
        let old_version_rewrite_count: i64 = connection
            .query_row("SELECT count(*) FROM tag_rebuild_audit", [], |row| {
                row.get(0)
            })
            .expect("old-version rewrite count");
        assert!(old_version_rewrite_count > second_rewrite_count);

        initialize_notes_db(&mut connection).expect("idempotent upgraded tokenizer version");
        let final_rewrite_count: i64 = connection
            .query_row("SELECT count(*) FROM tag_rebuild_audit", [], |row| {
                row.get(0)
            })
            .expect("final rewrite count");
        assert_eq!(final_rewrite_count, old_version_rewrite_count);
    }

    #[test]
    fn version_three_initialization_backfills_the_date_index_once() {
        let mut connection = test_connection();
        connection
            .execute(
                "DELETE FROM notes_preferences WHERE key = 'derived.dateParserVersion'",
                [],
            )
            .expect("remove date parser version marker");
        connection
            .execute(
                "INSERT INTO notes_nodes (id, sort_key, title, note, created_at, updated_at) \
                 VALUES (?1, 1024, 'Due 07/12/2026', '07/13/2026', \
                         '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                [NODE_ID],
            )
            .expect("insert pre-index date node");
        connection
            .execute(
                "INSERT INTO notes_dates (node_id, field, start_utf16, end_utf16, \
                   normalized_start, normalized_end, token_text) \
                 VALUES (?1, 'title', 0, 5, '2000-01-01', '2000-01-01', 'stale')",
                [NODE_ID],
            )
            .expect("insert stale date row");
        connection
            .execute_batch(
                "CREATE TABLE date_rebuild_audit (operation TEXT NOT NULL); \
                 CREATE TRIGGER audit_date_rebuild_delete AFTER DELETE ON notes_dates BEGIN \
                   INSERT INTO date_rebuild_audit VALUES ('delete'); \
                 END; \
                 CREATE TRIGGER audit_date_rebuild_insert AFTER INSERT ON notes_dates BEGIN \
                   INSERT INTO date_rebuild_audit VALUES ('insert'); \
                 END;",
            )
            .expect("install date rebuild audit");

        initialize_notes_db(&mut connection).expect("backfill date index");
        assert_eq!(
            date_rows(&connection, NODE_ID),
            vec![
                (
                    "title".to_string(),
                    4,
                    14,
                    "2026-07-12".to_string(),
                    "2026-07-12".to_string(),
                    "07/12/2026".to_string()
                ),
                (
                    "note".to_string(),
                    0,
                    10,
                    "2026-07-13".to_string(),
                    "2026-07-13".to_string(),
                    "07/13/2026".to_string()
                ),
            ]
        );
        let first_rewrite_count: i64 = connection
            .query_row("SELECT count(*) FROM date_rebuild_audit", [], |row| {
                row.get(0)
            })
            .expect("date rebuild count");
        assert!(first_rewrite_count >= 3);

        initialize_notes_db(&mut connection).expect("idempotent date index initialization");
        let second_rewrite_count: i64 = connection
            .query_row("SELECT count(*) FROM date_rebuild_audit", [], |row| {
                row.get(0)
            })
            .expect("idempotent date rebuild count");
        assert_eq!(second_rewrite_count, first_rewrite_count);
        let version: String = connection
            .query_row(
                "SELECT value_json FROM notes_preferences \
                 WHERE key = 'derived.dateParserVersion'",
                [],
                |row| row.get(0),
            )
            .expect("current date parser version marker");
        assert_eq!(version, "2");
    }

    #[test]
    fn version_three_initialization_upgrades_stored_v1_dates_without_mutating_source() {
        let mut connection = test_connection();
        let title = "Plan 07/11 - 7/14 then 07/15/2026";
        let note = "Window 07/20/2026 - 07/22/2026";
        connection
            .execute(
                "INSERT INTO notes_nodes (id, sort_key, title, note, created_at, updated_at) \
                 VALUES (?1, 1024, ?2, ?3, '2026-07-10T00:00:00.000Z', \
                         '2026-07-10T00:00:00.000Z')",
                params![NODE_ID, title, note],
            )
            .expect("insert stored-v1 date node");
        connection
            .execute_batch(&format!(
                "DELETE FROM notes_dates WHERE node_id = '{NODE_ID}'; \
                 INSERT INTO notes_dates (node_id, field, start_utf16, end_utf16, \
                   normalized_start, normalized_end, token_text) VALUES \
                   ('{NODE_ID}', 'title', 5, 10, '2026-07-11', '2026-07-11', '07/11'), \
                   ('{NODE_ID}', 'note', 7, 17, '1999-01-01', '1999-01-01', 'stale-note'); \
                 UPDATE notes_preferences SET value_json = '1' \
                 WHERE key = 'derived.dateParserVersion';"
            ))
            .expect("seed stored-v1 stale date rows");
        connection
            .execute_batch(
                "CREATE TABLE v1_date_rebuild_audit (operation TEXT NOT NULL); \
                 CREATE TRIGGER audit_v1_date_rebuild_delete AFTER DELETE ON notes_dates BEGIN \
                   INSERT INTO v1_date_rebuild_audit VALUES ('delete'); \
                 END; \
                 CREATE TRIGGER audit_v1_date_rebuild_insert AFTER INSERT ON notes_dates BEGIN \
                   INSERT INTO v1_date_rebuild_audit VALUES ('insert'); \
                 END;",
            )
            .expect("install stored-v1 rebuild audit");

        initialize_notes_db(&mut connection).expect("upgrade stored-v1 date index");

        assert_eq!(
            date_rows(&connection, NODE_ID),
            vec![
                (
                    "title".to_string(),
                    23,
                    33,
                    "2026-07-15".to_string(),
                    "2026-07-15".to_string(),
                    "07/15/2026".to_string(),
                ),
                (
                    "note".to_string(),
                    7,
                    30,
                    "2026-07-20".to_string(),
                    "2026-07-22".to_string(),
                    "07/20/2026 - 07/22/2026".to_string(),
                ),
            ]
        );
        let stored_source: (String, String) = connection
            .query_row(
                "SELECT title, note FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("unchanged stored-v1 source");
        assert_eq!(stored_source, (title.to_string(), note.to_string()));
        let version: String = connection
            .query_row(
                "SELECT value_json FROM notes_preferences \
                 WHERE key = 'derived.dateParserVersion'",
                [],
                |row| row.get(0),
            )
            .expect("upgraded date parser marker");
        assert_eq!(version, "2");
        let first_rewrite_count: i64 = connection
            .query_row("SELECT count(*) FROM v1_date_rebuild_audit", [], |row| {
                row.get(0)
            })
            .expect("stored-v1 rebuild count");
        assert_eq!(first_rewrite_count, 4);

        initialize_notes_db(&mut connection).expect("idempotent stored-v1 upgrade");
        let second_rewrite_count: i64 = connection
            .query_row("SELECT count(*) FROM v1_date_rebuild_audit", [], |row| {
                row.get(0)
            })
            .expect("idempotent stored-v1 rebuild count");
        assert_eq!(second_rewrite_count, first_rewrite_count);
    }

    #[test]
    fn version_three_date_upgrade_failure_rolls_back_rows_marker_and_source() {
        let mut connection = test_connection();
        let title = "Plan 07/11 - 7/14 then 07/15/2026";
        connection
            .execute(
                "INSERT INTO notes_nodes (id, sort_key, title, created_at, updated_at) \
                 VALUES (?1, 1024, ?2, '2026-07-10T00:00:00.000Z', \
                         '2026-07-10T00:00:00.000Z')",
                params![NODE_ID, title],
            )
            .expect("insert failing stored-v1 date node");
        connection
            .execute_batch(&format!(
                "DELETE FROM notes_dates WHERE node_id = '{NODE_ID}'; \
                 INSERT INTO notes_dates (node_id, field, start_utf16, end_utf16, \
                   normalized_start, normalized_end, token_text) \
                 VALUES ('{NODE_ID}', 'title', 5, 10, '2026-07-11', '2026-07-11', '07/11'); \
                 UPDATE notes_preferences SET value_json = '1' \
                 WHERE key = 'derived.dateParserVersion'; \
                 CREATE TRIGGER reject_v1_date_upgrade BEFORE INSERT ON notes_dates \
                 WHEN NEW.token_text = '07/15/2026' \
                 BEGIN SELECT RAISE(ABORT, 'stored-v1 date upgrade rejected'); END;"
            ))
            .expect("seed rejected stored-v1 upgrade");
        let stale_rows = date_rows(&connection, NODE_ID);

        let error = initialize_notes_db(&mut connection).expect_err("date upgrade must fail");

        assert!(error.contains("stored-v1 date upgrade rejected"), "{error}");
        assert_eq!(date_rows(&connection, NODE_ID), stale_rows);
        let preserved: (String, String) = connection
            .query_row(
                "SELECT node.title, preference.value_json \
                 FROM notes_nodes node CROSS JOIN notes_preferences preference \
                 WHERE node.id = ?1 AND preference.key = 'derived.dateParserVersion'",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("rolled-back date upgrade state");
        assert_eq!(preserved, (title.to_string(), "1".to_string()));
    }

    #[test]
    fn version_one_deleted_rows_migrate_to_deterministic_legacy_batches() {
        let mut connection = Connection::open_in_memory().expect("in-memory database");
        seed_version_one_database(&mut connection);
        connection
            .execute(
                "INSERT INTO notes_nodes (id, sort_key, title, created_at, updated_at) \
                 VALUES (?1, 1024, 'live', '2026-07-10T00:00:00.000Z', \
                         '2026-07-10T00:00:00.000Z')",
                [NODE_ID],
            )
            .expect("insert live version one row");
        connection
            .execute(
                "INSERT INTO notes_nodes (id, sort_key, title, created_at, updated_at, deleted_at) \
                 VALUES (?1, 2048, 'legacy one', '2026-07-10T00:00:00.000Z', \
                         '2026-07-10T00:00:00.000Z', '2026-07-10T01:02:03.004Z'), \
                        (?2, 3072, 'legacy two', '2026-07-10T00:00:00.000Z', \
                         '2026-07-10T00:00:00.000Z', '2026-07-10T01:02:03.004Z'), \
                        (?3, 4096, 'legacy three', '2026-07-10T00:00:00.000Z', \
                         '2026-07-10T00:00:00.000Z', '2026-07-10T05:06:07.008Z')",
                params![CHILD_ID, THIRD_ID, FOURTH_ID],
            )
            .expect("insert deleted version one rows");

        initialize_notes_db(&mut connection).expect("migrate version one database");

        let user_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("migrated user version");
        assert_eq!(user_version, 3);
        let live_batch: Option<String> = connection
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("live batch marker");
        assert_eq!(live_batch, None);
        let migrated = connection
            .prepare(
                "SELECT id, deleted_at, deleted_batch_id FROM notes_nodes \
                 WHERE deleted_at IS NOT NULL ORDER BY id",
            )
            .expect("prepare migrated rows")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .expect("query migrated rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect migrated rows");
        assert_eq!(
            migrated,
            vec![
                (
                    CHILD_ID.to_string(),
                    "2026-07-10T01:02:03.004Z".to_string(),
                    "legacy:2026-07-10T01:02:03.004Z".to_string(),
                ),
                (
                    THIRD_ID.to_string(),
                    "2026-07-10T01:02:03.004Z".to_string(),
                    "legacy:2026-07-10T01:02:03.004Z".to_string(),
                ),
                (
                    FOURTH_ID.to_string(),
                    "2026-07-10T05:06:07.008Z".to_string(),
                    "legacy:2026-07-10T05:06:07.008Z".to_string(),
                ),
            ]
        );
        let archive_values: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT archived_at, archive_root_id FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("version one archive defaults");
        assert_eq!(archive_values, (None, None));
    }

    #[test]
    fn version_two_rows_and_hashtags_migrate_to_version_three() {
        let mut connection = Connection::open_in_memory().expect("in-memory database");
        seed_version_two_database(&mut connection);
        connection
            .execute(
                "INSERT INTO notes_nodes (id, sort_key, title, created_at, updated_at) \
                 VALUES (?1, 1024, '#Roadmap', '2026-07-10T00:00:00.000Z', \
                         '2026-07-10T00:00:00.000Z')",
                [NODE_ID],
            )
            .expect("insert version two node");
        connection
            .execute(
                "INSERT INTO notes_tags (node_id, tag, normalized_tag) VALUES (?1, 'Roadmap', 'roadmap')",
                [NODE_ID],
            )
            .expect("insert version two tag");

        initialize_notes_db(&mut connection).expect("migrate version two database");

        let user_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("migrated user version");
        assert_eq!(user_version, 3);
        let migrated: (String, String, String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT prefix, tag, normalized_tag, node.archived_at, node.archive_root_id \
                 FROM notes_tags tag JOIN notes_nodes node ON node.id = tag.node_id \
                 WHERE tag.node_id = ?1",
                [NODE_ID],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("migrated version two row");
        assert_eq!(
            migrated,
            (
                "#".to_string(),
                "Roadmap".to_string(),
                "roadmap".to_string(),
                None,
                None
            )
        );
    }

    #[test]
    fn failed_version_two_migration_keeps_version_one_schema_and_rows() {
        let mut connection = Connection::open_in_memory().expect("in-memory database");
        seed_version_one_database(&mut connection);
        connection
            .execute(
                "INSERT INTO notes_nodes (id, sort_key, title, created_at, updated_at, deleted_at) \
                 VALUES (?1, 1024, 'legacy', '2026-07-10T00:00:00.000Z', \
                         '2026-07-10T00:00:00.000Z', '2026-07-10T01:02:03.004Z')",
                [NODE_ID],
            )
            .expect("insert legacy deleted row");
        connection
            .execute_batch(
                "CREATE TRIGGER reject_version_two_update \
                 BEFORE UPDATE ON notes_nodes \
                 WHEN OLD.deleted_at IS NOT NULL \
                 BEGIN SELECT RAISE(ABORT, 'version two migration rejected'); END;",
            )
            .expect("install migration rejection trigger");

        let error = initialize_notes_db(&mut connection).expect_err("migration must fail");

        assert!(error.contains("version two migration rejected"));
        let user_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("user version after failed migration");
        assert_eq!(user_version, 1);
        assert!(!column_exists(
            &connection,
            "notes_nodes",
            "deleted_batch_id"
        ));
        let deleted_at: String = connection
            .query_row(
                "SELECT deleted_at FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("legacy row after rollback");
        assert_eq!(deleted_at, "2026-07-10T01:02:03.004Z");
    }

    #[test]
    fn concurrent_first_initialization_waits_for_locks_and_creates_one_valid_schema() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        let path = notes_db_path(&vault_path);
        std::fs::create_dir_all(path.parent().expect("metadata dir")).expect("metadata dir");
        let blocker = Connection::open(&path).expect("open migration blocker");
        blocker
            .execute_batch("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE")
            .expect("hold first initialization lock");

        let (busy_sender, busy_receiver) = mpsc::channel();
        let workers = (0..2)
            .map(|worker_id| {
                let vault_path = vault_path.clone();
                let busy_sender = busy_sender.clone();
                thread::spawn(move || {
                    observe_next_migration_busy(busy_sender, worker_id);
                    connect_notes_db(&vault_path)
                })
            })
            .collect::<Vec<_>>();
        drop(busy_sender);

        let mut workers_at_lock = vec![
            busy_receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("first initializer reached held migration lock"),
            busy_receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("second initializer reached held migration lock"),
        ];
        workers_at_lock.sort_unstable();
        assert_eq!(workers_at_lock, vec![0, 1]);
        blocker
            .execute_batch("COMMIT")
            .expect("release migration lock");

        for worker in workers {
            worker
                .join()
                .expect("initialization worker")
                .expect("concurrent first initialization");
        }

        let connection = Connection::open(&path).expect("reopen initialized database");
        let user_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("user version");
        assert_eq!(user_version, 3);
        assert!(column_exists(
            &connection,
            "notes_nodes",
            "deleted_batch_id"
        ));
        for (object_type, name) in [
            ("table", "notes_nodes"),
            ("table", "notes_tags"),
            ("table", "notes_preferences"),
            ("table", "notes_search"),
            ("table", "notes_search_lifecycle"),
            ("index", "notes_nodes_active_parent_order"),
            ("index", "notes_nodes_deleted_batch"),
            ("index", "notes_tags_normalized_tag"),
            ("trigger", "notes_nodes_search_insert"),
            ("trigger", "notes_nodes_search_update"),
            ("trigger", "notes_nodes_search_delete"),
            ("trigger", "notes_nodes_lifecycle_search_insert"),
            ("trigger", "notes_nodes_lifecycle_search_update"),
            ("trigger", "notes_nodes_lifecycle_search_delete"),
        ] {
            assert!(
                object_exists(&connection, object_type, name),
                "missing {object_type} {name}"
            );
        }
        let foreign_key_errors: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("foreign key check");
        assert_eq!(foreign_key_errors, 0);
    }

    #[test]
    fn failed_version_one_migration_keeps_the_prior_schema_and_version() {
        let mut connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute("CREATE TABLE notes_nodes (sentinel TEXT)", [])
            .expect("seed prior schema");

        let error = initialize_notes_db(&mut connection).expect_err("migration must fail");

        assert!(error.contains("already exists"));
        let user_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("user version after failed migration");
        assert_eq!(user_version, 0);
        assert!(object_exists(&connection, "table", "notes_nodes"));
        for (object_type, name) in [
            ("table", "notes_tags"),
            ("table", "notes_preferences"),
            ("table", "notes_search"),
            ("index", "notes_nodes_active_parent_order"),
            ("index", "notes_tags_normalized_tag"),
            ("trigger", "notes_nodes_search_insert"),
        ] {
            assert!(!object_exists(&connection, object_type, name));
        }
    }

    #[test]
    fn notes_connection_leaves_short_and_corrupt_headers_to_sqlite_diagnostics() {
        for (label, bytes) in [("short", vec![0_u8; 8]), ("corrupt", vec![b'x'; 64])] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let path = notes_db_path(temp_dir.path().to_str().expect("path"));
            std::fs::create_dir_all(path.parent().expect("metadata dir")).expect("metadata dir");
            std::fs::write(&path, bytes).expect("write malformed database");

            let error = connect_notes_db(temp_dir.path().to_str().expect("path"))
                .expect_err("SQLite must reject malformed database headers");

            assert!(error.contains("file is not a database"), "{label}: {error}");
        }
    }

    #[test]
    fn notes_connection_rejects_a_checkpointed_future_wal_without_creating_companions() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let path = notes_db_path(temp_dir.path().to_str().expect("path"));
        std::fs::create_dir_all(path.parent().expect("metadata dir")).expect("metadata dir");
        let connection = Connection::open(&path).expect("open future database");
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL; \
                 PRAGMA wal_autocheckpoint = 0; \
                 PRAGMA user_version = 4; \
                 PRAGMA wal_checkpoint(TRUNCATE);",
            )
            .expect("checkpoint future WAL schema");
        drop(connection);
        let bytes_before = std::fs::read(&path).expect("future database bytes before connect");
        assert_eq!(
            u32::from_be_bytes(bytes_before[60..64].try_into().expect("user version bytes")),
            4
        );
        let wal_path = sqlite_companion_path(&path, "-wal");
        let shm_path = sqlite_companion_path(&path, "-shm");
        assert!(!wal_path.exists());
        assert!(!shm_path.exists());

        let error = connect_notes_db(temp_dir.path().to_str().expect("path"))
            .expect_err("future schema must be rejected");
        assert!(error.contains("unsupported schema version 4"));
        assert_eq!(
            std::fs::read(&path).expect("future database bytes after connect"),
            bytes_before
        );
        assert!(!wal_path.exists());
        assert!(!shm_path.exists());
    }

    #[test]
    fn notes_connection_rejects_a_live_future_wal_without_touching_database_files() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("vault path");
        let path = notes_db_path(vault_path);
        std::fs::create_dir_all(path.parent().expect("metadata dir")).expect("metadata dir");
        let writer = Connection::open(&path).expect("open WAL fixture");
        writer
            .execute_batch(
                "PRAGMA journal_mode = WAL; \
                 PRAGMA wal_autocheckpoint = 0; \
                 PRAGMA user_version = 3; \
                 PRAGMA wal_checkpoint(TRUNCATE); \
                 PRAGMA user_version = 4;",
            )
            .expect("seed live future WAL schema");
        let visible_version: i64 = writer
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("live WAL user version");
        assert_eq!(visible_version, 4);

        let wal_path = sqlite_companion_path(&path, "-wal");
        let shm_path = sqlite_companion_path(&path, "-shm");
        assert!(wal_path.exists());
        assert!(shm_path.exists());
        let main_before = std::fs::read(&path).expect("main bytes before connect");
        let wal_before = std::fs::read(&wal_path).expect("WAL bytes before connect");
        let shm_before = std::fs::read(&shm_path).expect("SHM bytes before connect");
        assert_eq!(
            u32::from_be_bytes(main_before[60..64].try_into().expect("user version bytes")),
            3,
            "version 4 must remain uncheckpointed in the WAL"
        );

        let preflight_error = preflight_existing_notes_schema(&path)
            .expect_err("read-only preflight must reject the future WAL schema");
        assert!(preflight_error.contains("unsupported schema version 4"));

        let error = connect_notes_db(vault_path).expect_err("future WAL schema must be rejected");

        assert!(error.contains("unsupported schema version 4"));
        assert_eq!(
            std::fs::read(&path).expect("main bytes after connect"),
            main_before
        );
        assert_eq!(
            std::fs::read(&wal_path).expect("WAL bytes after connect"),
            wal_before
        );
        assert_eq!(
            std::fs::read(&shm_path).expect("SHM bytes after connect"),
            shm_before
        );
        drop(writer);
    }

    #[test]
    fn notes_search_tracks_active_node_content() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect notes");

        connection
            .execute(
                "INSERT INTO notes_nodes (id, sort_key, title, note, created_at, updated_at) \
                 VALUES (?1, 1024, 'Alpha', 'First note', '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z')",
                [NODE_ID],
            )
            .expect("insert node");
        let indexed_title: String = connection
            .query_row(
                "SELECT title FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("indexed node");
        assert_eq!(indexed_title, "Alpha");

        connection
            .execute(
                "UPDATE notes_nodes SET title = 'Beta', deleted_at = '2026-07-10T01:00:00Z' WHERE id = ?1",
                [NODE_ID],
            )
            .expect("soft delete node");
        let deleted_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("deleted search count");
        assert_eq!(deleted_count, 0);

        connection
            .execute(
                "UPDATE notes_nodes SET deleted_at = NULL WHERE id = ?1",
                [NODE_ID],
            )
            .expect("restore node");
        let restored_title: String = connection
            .query_row(
                "SELECT title FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("restored search node");
        assert_eq!(restored_title, "Beta");

        connection
            .execute("DELETE FROM notes_nodes WHERE id = ?1", [NODE_ID])
            .expect("delete node");
        let removed_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("removed search count");
        assert_eq!(removed_count, 0);
    }

    #[test]
    fn create_appends_or_inserts_after_a_sibling_and_rebalances_exhausted_gaps() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "first");
        insert_node(&connection, CHILD_ID, None, 1025, "second");

        create_node(
            &mut connection,
            CreateNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                title: "between".to_string(),
                note: String::new(),
            },
        )
        .expect("insert between roots");
        create_node(
            &mut connection,
            CreateNodeInput {
                id: FOURTH_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "last".to_string(),
                note: String::new(),
            },
        )
        .expect("append root");

        assert_eq!(
            active_children(&connection, None),
            vec![
                (NODE_ID.to_string(), 1024),
                (THIRD_ID.to_string(), 1536),
                (CHILD_ID.to_string(), 2048),
                (FOURTH_ID.to_string(), 3072),
            ]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn invalid_create_input_does_not_mutate_the_tree() {
        let mut connection = test_connection();
        let error = create_node(
            &mut connection,
            CreateNodeInput {
                id: "not-a-uuid".to_string(),
                parent_id: None,
                after_id: None,
                title: "invalid".to_string(),
                note: String::new(),
            },
        )
        .expect_err("invalid ID");

        assert!(error.contains("UUID v4"));
        assert!(load_workspace(&connection, NotesWorkspaceScope::Active)
            .expect("active workspace")
            .nodes
            .is_empty());
    }

    #[test]
    fn projection_failure_rolls_back_the_mutation_that_produced_it() {
        let mut connection = test_connection();
        connection
            .execute_batch(
                "CREATE TRIGGER corrupt_created_node_projection \
                 AFTER INSERT ON notes_nodes \
                 BEGIN \
                   UPDATE notes_nodes SET layout_mode = 'invalid' WHERE id = NEW.id; \
                 END;",
            )
            .expect("projection failure trigger");

        let error = create_node(
            &mut connection,
            CreateNodeInput {
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "must roll back".to_string(),
                note: String::new(),
            },
        )
        .expect_err("invalid workspace projection");

        assert!(error.contains("Unsupported Notes layout mode: invalid"));
        let node_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("node count after projection failure");
        assert_eq!(node_count, 0);
        let search_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_search", [], |row| row.get(0))
            .expect("search count after projection failure");
        assert_eq!(search_count, 0);
    }

    #[test]
    fn move_places_a_node_before_the_first_root_without_sort_key_overflow() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, i64::MIN, "first root");
        insert_node(&connection, CHILD_ID, None, i64::MIN + 1, "second root");
        insert_node(&connection, THIRD_ID, None, 0, "moving root");

        let workspace = move_node(
            &mut connection,
            MoveNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: None,
                before_id: Some(NODE_ID.to_string()),
            },
        )
        .expect("move before first root");

        assert_eq!(
            active_children(&connection, None),
            vec![
                (THIRD_ID.to_string(), 0),
                (NODE_ID.to_string(), 1024),
                (CHILD_ID.to_string(), 2048),
            ]
        );
        assert_eq!(workspace.nodes[0].id, THIRD_ID);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_places_a_node_before_the_first_child_without_rebalancing() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "first child");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 2048, "second child");

        let workspace = move_node(
            &mut connection,
            MoveNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                before_id: Some(CHILD_ID.to_string()),
            },
        )
        .expect("move before first child");

        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![(THIRD_ID.to_string(), 0), (CHILD_ID.to_string(), 1024)]
        );
        assert_eq!(
            workspace
                .nodes
                .iter()
                .find(|node| node.id == THIRD_ID)
                .expect("moved child")
                .parent_id
                .as_deref(),
            Some(NODE_ID)
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_places_a_node_before_a_middle_sibling() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "first");
        insert_node(&connection, CHILD_ID, None, 2048, "middle");
        insert_node(&connection, THIRD_ID, None, 3072, "moving");

        move_node(
            &mut connection,
            MoveNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: None,
                before_id: Some(CHILD_ID.to_string()),
            },
        )
        .expect("move before middle root");

        assert_eq!(
            active_children(&connection, None),
            vec![
                (NODE_ID.to_string(), 1024),
                (THIRD_ID.to_string(), 1536),
                (CHILD_ID.to_string(), 2048),
            ]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_rejects_cross_parent_and_deleted_before_anchors_without_mutation() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "target parent");
        insert_node(&connection, CHILD_ID, None, 2048, "other parent");
        insert_node(&connection, THIRD_ID, None, 3072, "moving root");
        insert_node(
            &connection,
            FOURTH_ID,
            Some(CHILD_ID),
            1024,
            "cross-parent anchor",
        );
        insert_node(&connection, FIFTH_ID, Some(NODE_ID), 1024, "deleted anchor");
        soft_delete_node(&mut connection, FIFTH_ID).expect("delete anchor");

        for anchor_id in [FOURTH_ID, FIFTH_ID] {
            let before = persistent_state(&connection);
            let error = move_node(
                &mut connection,
                MoveNodeInput {
                    id: THIRD_ID.to_string(),
                    parent_id: Some(NODE_ID.to_string()),
                    after_id: None,
                    before_id: Some(anchor_id.to_string()),
                },
            )
            .expect_err("invalid before anchor");

            assert!(error.contains("beforeId must identify a live sibling under the target parent"));
            assert_eq!(persistent_state(&connection), before);
            assert_tree_invariants(&connection);
        }
    }

    #[test]
    fn move_rejects_a_descendant_as_the_new_parent() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "grandchild");
        insert_node(
            &connection,
            FOURTH_ID,
            Some(THIRD_ID),
            1024,
            "great-grandchild",
        );
        insert_node(&connection, FIFTH_ID, None, 2048, "following root");
        let before = persistent_state(&connection);

        let error = move_node(
            &mut connection,
            MoveNodeInput {
                id: NODE_ID.to_string(),
                parent_id: Some(FOURTH_ID.to_string()),
                after_id: None,
                before_id: None,
            },
        )
        .expect_err("cycle");

        assert!(error.contains("descendant"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_rejects_the_node_itself_as_the_new_parent() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");

        let error = move_node(
            &mut connection,
            MoveNodeInput {
                id: NODE_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                before_id: None,
            },
        )
        .expect_err("self-parent cycle");

        assert!(error.contains("itself"));
        assert_eq!(active_children(&connection, None).len(), 1);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_can_reorder_siblings_and_promote_a_node_to_a_root() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root one");
        insert_node(&connection, CHILD_ID, None, 2048, "root two");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 1024, "child");

        move_node(
            &mut connection,
            MoveNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                before_id: None,
            },
        )
        .expect("promote child");
        move_node(
            &mut connection,
            MoveNodeInput {
                id: CHILD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                before_id: None,
            },
        )
        .expect("reorder root");

        let roots = active_children(&connection, None);
        assert_eq!(
            roots.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID, THIRD_ID]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn split_is_atomic_and_places_the_suffix_immediately_after_the_source() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "original");
        insert_node(&connection, CHILD_ID, None, 2048, "following");

        let workspace = split_node(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: THIRD_ID.to_string(),
                prefix: "alpha".to_string(),
                suffix: "beta".to_string(),
            },
        )
        .expect("split");

        assert!(workspace.nodes.iter().any(|node| node.id == THIRD_ID));
        let roots = active_children(&connection, None);
        assert_eq!(
            roots.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec![NODE_ID, THIRD_ID, CHILD_ID]
        );
        let source_title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("source title");
        assert_eq!(source_title, "alpha");

        connection
            .execute_batch(&format!(
                "CREATE TRIGGER reject_split_insert BEFORE INSERT ON notes_nodes \
                 WHEN NEW.id = '{FOURTH_ID}' BEGIN SELECT RAISE(ABORT, 'split rejected'); END;"
            ))
            .expect("rejecting trigger");
        let error = split_node(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: FOURTH_ID.to_string(),
                prefix: "changed".to_string(),
                suffix: "rejected".to_string(),
            },
        )
        .expect_err("split must roll back");
        assert!(error.contains("split rejected"));
        let rolled_back_title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("rolled back title");
        assert_eq!(rolled_back_title, "alpha");
    }

    #[test]
    fn remove_empty_node_reparents_children_at_the_removed_position() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "before");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 2048, " \t ");
        insert_node(&connection, FOURTH_ID, Some(THIRD_ID), 1024, "child one");
        insert_node(&connection, FIFTH_ID, Some(THIRD_ID), 2048, "child two");
        insert_node(&connection, SIXTH_ID, Some(NODE_ID), 3072, "after");

        remove_empty_node(&mut connection, THIRD_ID).expect("remove empty node");

        let children = active_children(&connection, Some(NODE_ID));
        assert_eq!(
            children
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec![CHILD_ID, FOURTH_ID, FIFTH_ID, SIXTH_ID]
        );
        let (removed_deleted_at, removed_batch_id): (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT deleted_at, deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [THIRD_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("removed node");
        assert!(removed_deleted_at.is_some());
        assert!(removed_batch_id.is_some());
        assert_tree_invariants(&connection);
    }

    #[test]
    fn remove_empty_node_rejects_a_non_whitespace_title_without_mutation() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            " keep #Title ",
            " \n ",
        );
        let before = persistent_state(&connection);

        let error = remove_empty_node(&mut connection, NODE_ID).expect_err("non-empty title");

        assert!(error.contains("empty"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn remove_empty_node_rejects_a_non_whitespace_note_without_mutation() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            " \t ",
            " keep #Supporting-Note ",
        );
        let before = persistent_state(&connection);

        let error = remove_empty_node(&mut connection, NODE_ID).expect_err("non-empty note");

        assert!(error.contains("empty"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn split_then_remove_empty_node_preserves_children_and_root_order() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "original");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        insert_node(&connection, THIRD_ID, None, 2048, "following root");

        let workspace = split_node(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: FOURTH_ID.to_string(),
                prefix: "alpha".to_string(),
                suffix: " \t ".to_string(),
            },
        )
        .expect("split before removing empty suffix");
        assert!(workspace.nodes.iter().any(|node| node.id == FOURTH_ID));
        assert_eq!(
            active_children(&connection, None),
            vec![
                (NODE_ID.to_string(), 1024),
                (FOURTH_ID.to_string(), 1536),
                (THIRD_ID.to_string(), 2048),
            ]
        );

        remove_empty_node(&mut connection, FOURTH_ID).expect("remove empty split node");

        assert_eq!(
            active_children(&connection, None),
            vec![(NODE_ID.to_string(), 1024), (THIRD_ID.to_string(), 2048)]
        );
        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![(CHILD_ID.to_string(), 1024)]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn remove_empty_leaf_soft_deletes_only_that_leaf() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "before");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 2048, " \n\t ");
        insert_node(&connection, FOURTH_ID, Some(NODE_ID), 3072, "after");

        remove_empty_node(&mut connection, THIRD_ID).expect("remove empty leaf");

        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![(CHILD_ID.to_string(), 1024), (FOURTH_ID.to_string(), 3072)]
        );
        let deleted_at: Option<String> = connection
            .query_row(
                "SELECT deleted_at FROM notes_nodes WHERE id = ?1",
                [THIRD_ID],
                |row| row.get(0),
            )
            .expect("removed leaf");
        assert!(deleted_at.is_some());
        assert_tree_invariants(&connection);
    }

    #[test]
    fn duplicate_node_deep_copies_with_fresh_ids_after_the_source_root() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "grandchild");
        insert_node(&connection, FOURTH_ID, None, 2048, "following root");

        let workspace = duplicate_node(&mut connection, NODE_ID).expect("duplicate subtree");
        let copied_root = workspace
            .nodes
            .iter()
            .find(|node| node.parent_id.is_none() && node.id != NODE_ID && node.id != FOURTH_ID)
            .expect("copied root in returned workspace")
            .id
            .clone();

        assert_ne!(copied_root, NODE_ID);
        validate_note_id(&copied_root).expect("copied root UUID");
        let roots = active_children(&connection, None);
        assert_eq!(roots[0].0, NODE_ID);
        assert_eq!(roots[1].0, copied_root);
        assert_eq!(roots[2].0, FOURTH_ID);

        let copied_children = active_children(&connection, Some(&copied_root));
        assert_eq!(copied_children.len(), 1);
        assert_ne!(copied_children[0].0, CHILD_ID);
        validate_note_id(&copied_children[0].0).expect("copied child UUID");
        let copied_grandchildren = active_children(&connection, Some(&copied_children[0].0));
        assert_eq!(copied_grandchildren.len(), 1);
        assert_ne!(copied_grandchildren[0].0, THIRD_ID);
        validate_note_id(&copied_grandchildren[0].0).expect("copied grandchild UUID");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active workspace")
                .nodes
                .len(),
            7
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn duplicate_node_rolls_back_nodes_search_and_tags_after_a_mid_copy_failure() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "copy root #Root",
            "root note #Details",
        );
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "copy child #Child",
            "child note #Details",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            None,
            Some(NODE_ID),
            "following #Root",
            "",
        );
        let before = persistent_state(&connection);
        connection
            .execute_batch(
                "CREATE TRIGGER reject_duplicate_child BEFORE INSERT ON notes_nodes \
                 WHEN NEW.parent_id IS NOT NULL AND NEW.title = 'copy child #Child' \
                 BEGIN SELECT RAISE(ABORT, 'duplicate child rejected'); END;",
            )
            .expect("duplicate failure trigger");

        let error = duplicate_node(&mut connection, NODE_ID).expect_err("duplicate rollback");

        assert!(error.contains("duplicate child rejected"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn remove_empty_node_rolls_back_full_state_after_terminal_search_deletion_failure() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "parent #Outline", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "before #Sibling",
            "",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(NODE_ID),
            Some(CHILD_ID),
            " \t ",
            "\n",
        );
        create_test_node(
            &mut connection,
            FOURTH_ID,
            Some(THIRD_ID),
            None,
            "child one #Child",
            "",
        );
        create_test_node(
            &mut connection,
            FIFTH_ID,
            Some(THIRD_ID),
            Some(FOURTH_ID),
            "child two #Child",
            "",
        );
        create_test_node(
            &mut connection,
            SIXTH_ID,
            Some(NODE_ID),
            Some(THIRD_ID),
            "after #Sibling",
            "",
        );
        connection
            .execute(
                "UPDATE notes_nodes SET \
                   is_collapsed = CASE WHEN id IN (?1, ?2) THEN 1 ELSE 0 END, \
                   is_starred = CASE WHEN id IN (?2, ?3) THEN 1 ELSE 0 END, \
                   completed_at = CASE WHEN id IN (?3, ?4) \
                     THEN '2025-01-02T03:04:05.000Z' ELSE NULL END, \
                   created_at = '2024-01-02T03:04:05.000Z', \
                   updated_at = '2025-02-03T04:05:06.000Z'",
                params![THIRD_ID, FOURTH_ID, FIFTH_ID, SIXTH_ID],
            )
            .expect("seed distinctive persisted node state");
        let before = persistent_state(&connection);
        install_remove_terminal_failure_trigger(&connection, THIRD_ID);

        let error = remove_empty_node(&mut connection, THIRD_ID).expect_err("remove rollback");

        assert!(error.contains("remove terminal search deletion rejected"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn deleting_a_node_hides_the_live_subtree_from_workspace_and_search_then_restores_it() {
        let mut connection = test_connection();
        let root = insert_tree(&connection);

        soft_delete_node(&mut connection, &root).expect("delete");
        let root_batch: String = connection
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("root deletion batch");
        let child_batch: String = connection
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("child deletion batch");
        assert_eq!(root_batch, child_batch);
        assert!(load_workspace(&connection, NotesWorkspaceScope::Active)
            .expect("active")
            .nodes
            .is_empty());
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Trash)
                .expect("trash")
                .nodes
                .len(),
            2
        );
        let search_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_search", [], |row| row.get(0))
            .expect("search count after delete");
        assert_eq!(search_count, 0);

        restore_node(&mut connection, &root).expect("restore");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active")
                .nodes
                .len(),
            2
        );
        let restored_search_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_search", [], |row| row.get(0))
            .expect("search count after restore");
        assert_eq!(restored_search_count, 2);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn restoring_an_ancestor_keeps_an_independently_trashed_child_deleted() {
        let mut connection = test_connection();
        let root = insert_tree(&connection);

        soft_delete_node(&mut connection, CHILD_ID).expect("delete child independently");
        let child_batch: String = connection
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("child deletion batch");
        soft_delete_node(&mut connection, &root).expect("delete ancestor later");
        connection
            .execute(
                "UPDATE notes_nodes SET deleted_at = '2026-07-10T09:08:07.006Z' \
                 WHERE id IN (?1, ?2)",
                params![NODE_ID, CHILD_ID],
            )
            .expect("force identical deletion timestamps");
        let (child_deleted_at, child_batch_after): (String, String) = connection
            .query_row(
                "SELECT deleted_at, deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("child deletion provenance");
        let (root_deleted_at, root_batch): (String, String) = connection
            .query_row(
                "SELECT deleted_at, deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("root deletion provenance");
        assert_eq!(child_deleted_at, root_deleted_at);
        assert_eq!(child_batch, child_batch_after);
        assert_ne!(child_batch, root_batch);

        restore_node(&mut connection, &root).expect("restore ancestor");

        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active workspace")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID]
        );
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Trash)
                .expect("trash workspace")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![CHILD_ID]
        );
        let root_provenance: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT deleted_at, deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("restored root provenance");
        assert_eq!(root_provenance, (None, None));
        let retained_child_batch: String = connection
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("retained child deletion batch");
        assert_eq!(retained_child_batch, child_batch);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn restoring_a_subtree_uses_the_root_when_its_parent_remains_deleted() {
        let mut connection = test_connection();
        let root = insert_tree(&connection);
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "grandchild");
        soft_delete_node(&mut connection, &root).expect("delete tree");

        restore_node(&mut connection, CHILD_ID).expect("restore child subtree");

        let child_parent: Option<String> = connection
            .query_row(
                "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("restored child parent");
        assert_eq!(child_parent, None);
        assert_eq!(active_children(&connection, Some(CHILD_ID)).len(), 1);
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Trash)
                .expect("trash")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn restore_rebalances_when_a_live_sibling_occupies_the_original_sort_key() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "trashed child");
        soft_delete_node(&mut connection, CHILD_ID).expect("delete child");
        create_node(
            &mut connection,
            CreateNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                title: "replacement child".to_string(),
                note: String::new(),
            },
        )
        .expect("occupy old sort key");

        restore_node(&mut connection, CHILD_ID).expect("restore child");

        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![(CHILD_ID.to_string(), 1024), (THIRD_ID.to_string(), 2048)]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn restore_collision_rolls_back_full_state_after_terminal_search_reinsertion_failure() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "parent #Outline", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "trashed child #Restore",
            "restore note #Details",
        );
        soft_delete_node(&mut connection, CHILD_ID).expect("delete child");
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(NODE_ID),
            None,
            "replacement #Restore",
            "",
        );
        connection
            .execute(
                "UPDATE notes_nodes SET \
                   is_collapsed = CASE WHEN id = ?1 THEN 1 ELSE 0 END, \
                   is_starred = CASE WHEN id IN (?1, ?2) THEN 1 ELSE 0 END, \
                   completed_at = CASE WHEN id = ?1 \
                     THEN '2025-03-04T05:06:07.000Z' ELSE NULL END, \
                   created_at = '2024-03-04T05:06:07.000Z', \
                   updated_at = '2025-04-05T06:07:08.000Z'",
                params![CHILD_ID, THIRD_ID],
            )
            .expect("seed distinctive persisted node state");
        let before = persistent_state(&connection);
        install_restore_terminal_failure_trigger(&connection, CHILD_ID);

        let error = restore_node(&mut connection, CHILD_ID).expect_err("restore rollback");

        assert!(error.contains("restore terminal search reinsertion rejected"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn empty_trash_removes_deleted_rows_and_their_search_and_tags() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "active #Keep", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            None,
            Some(NODE_ID),
            "trash root #Remove",
            "",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(CHILD_ID),
            None,
            "trash child #Remove",
            "",
        );
        soft_delete_node(&mut connection, CHILD_ID).expect("delete subtree");
        let tags_before_emptying: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_tags", [], |row| row.get(0))
            .expect("tags before emptying trash");
        assert_eq!(tags_before_emptying, 3);

        empty_trash(&mut connection).expect("empty trash");

        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID]
        );
        assert!(load_workspace(&connection, NotesWorkspaceScope::Trash)
            .expect("trash")
            .nodes
            .is_empty());
        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("remaining rows");
        assert_eq!(row_count, 1);
        let search_ids = connection
            .prepare("SELECT node_id FROM notes_search ORDER BY node_id")
            .expect("prepare remaining search rows")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query remaining search rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect remaining search rows");
        assert_eq!(search_ids, vec![NODE_ID]);
        let tag_rows = connection
            .prepare("SELECT node_id, normalized_tag FROM notes_tags ORDER BY node_id")
            .expect("prepare remaining tag rows")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query remaining tag rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect remaining tag rows");
        assert_eq!(tag_rows, vec![(NODE_ID.to_string(), "keep".to_string())]);
    }

    #[test]
    fn update_and_toggles_refresh_content_search_tags_and_flags() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "before");

        update_node(
            &mut connection,
            UpdateNodeInput {
                id: NODE_ID.to_string(),
                title: "After #Project".to_string(),
                note: "Details #project #Next-Step".to_string(),
            },
        )
        .expect("update node");
        toggle_complete(&mut connection, NODE_ID).expect("complete node");
        toggle_collapsed(&mut connection, NODE_ID).expect("collapse node");

        let node = load_workspace(&connection, NotesWorkspaceScope::Active)
            .expect("active workspace")
            .nodes
            .pop()
            .expect("updated node");
        assert_eq!(node.title, "After #Project");
        assert!(node.completed_at.is_some());
        assert!(node.is_collapsed);
        let indexed_note: String = connection
            .query_row(
                "SELECT note FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("indexed note");
        assert_eq!(indexed_note, "Details #project #Next-Step");
        let tags = connection
            .prepare(
                "SELECT normalized_tag FROM notes_tags WHERE node_id = ?1 ORDER BY normalized_tag",
            )
            .expect("prepare tags")
            .query_map([NODE_ID], |row| row.get::<_, String>(0))
            .expect("query tags")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect tags");
        assert_eq!(tags, vec!["next-step", "project"]);
    }

    #[test]
    fn update_indexes_tags_and_fts_content_together() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "Root", "");
        create_test_node(&mut connection, CHILD_ID, Some(NODE_ID), None, "Draft", "");

        update_node(
            &mut connection,
            UpdateNodeInput {
                id: CHILD_ID.to_string(),
                title: "#Roadmap search target".to_string(),
                note: "#Offline detail #ROADMAP".to_string(),
            },
        )
        .expect("update");

        assert_eq!(
            list_tags(&connection).expect("tags"),
            vec!["offline", "roadmap"]
        );
        let title_results = search_nodes(&connection, "  target  ").expect("title search");
        assert_eq!(title_results.len(), 1);
        assert_eq!(title_results[0].node_id, CHILD_ID);
        assert_eq!(title_results[0].parent_trail, vec!["Root"]);
        assert_eq!(
            title_results[0].matched_field,
            NoteSearchMatchedField::Title
        );

        let note_results = search_nodes(&connection, "detail").expect("note search");
        assert_eq!(note_results.len(), 1);
        assert_eq!(note_results[0].matched_field, NoteSearchMatchedField::Note);
        assert!(search_nodes(&connection, " \n\t ")
            .expect("blank search")
            .is_empty());
        assert!(search_nodes(&connection, "\" OR *")
            .expect("escaped FTS syntax")
            .is_empty());
        assert_eq!(
            search_nodes(&connection, "#Roadmap")
                .expect("tag-like search")
                .len(),
            1
        );
        for literal_query in [
            "target OR missing",
            "NEAR(target detail)",
            "tar\"get",
            "---",
            "#",
        ] {
            assert!(
                search_nodes(&connection, literal_query)
                    .unwrap_or_else(|error| panic!("literal query {literal_query:?}: {error}"))
                    .is_empty(),
                "FTS syntax must not change the meaning of {literal_query:?}"
            );
        }
    }

    #[test]
    fn tag_index_distinguishes_prefixes_and_rejects_embedded_or_url_markers() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "#Same @Same foo#embedded ##double",
            "https://example.test/#fragment valid @Owner",
        );

        let tags = connection
            .prepare(
                "SELECT prefix, normalized_tag FROM notes_tags WHERE node_id = ?1 \
                 ORDER BY prefix, normalized_tag",
            )
            .expect("prepare prefixed tags")
            .query_map([NODE_ID], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query prefixed tags")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect prefixed tags");
        assert_eq!(
            tags,
            vec![
                ("#".to_string(), "same".to_string()),
                ("@".to_string(), "owner".to_string()),
                ("@".to_string(), "same".to_string()),
            ]
        );
    }

    #[test]
    fn notes_tag_index_matches_unicode_and_url_tokenizer_rules() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "😀#Tag #𐐷 #café https://x/?q=#hidden",
            "/path/?q=@hidden #नमस्ते",
        );

        let tags = connection
            .prepare(
                "SELECT prefix, tag, normalized_tag FROM notes_tags WHERE node_id = ?1 \
                 ORDER BY prefix, normalized_tag",
            )
            .expect("prepare Unicode tags")
            .query_map([NODE_ID], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .expect("query Unicode tags")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect Unicode tags");

        assert_eq!(
            tags,
            vec![
                ("#".to_string(), "café".to_string(), "café".to_string()),
                ("#".to_string(), "Tag".to_string(), "tag".to_string()),
                ("#".to_string(), "नमस्ते".to_string(), "नमस्ते".to_string()),
                ("#".to_string(), "𐐷".to_string(), "𐐷".to_string()),
            ]
        );
    }

    #[test]
    fn notes_date_index_replaces_title_and_note_rows_for_every_content_copy_path() {
        let mut connection = test_connection();
        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "😀 today #old".to_string(),
                note: "07/12/2026".to_string(),
            },
            fixed_today(),
        )
        .expect("create dated node");
        assert_eq!(
            date_rows(&connection, NODE_ID),
            vec![
                (
                    "title".to_string(),
                    3,
                    8,
                    "2026-07-11".to_string(),
                    "2026-07-11".to_string(),
                    "today".to_string()
                ),
                (
                    "note".to_string(),
                    0,
                    10,
                    "2026-07-12".to_string(),
                    "2026-07-12".to_string(),
                    "07/12/2026".to_string()
                ),
            ]
        );

        update_node_at(
            &mut connection,
            UpdateNodeInput {
                id: NODE_ID.to_string(),
                title: "#new 07/13/2026".to_string(),
                note: "next week".to_string(),
            },
            fixed_today(),
        )
        .expect("update dated node");
        assert_eq!(list_tags(&connection).expect("updated tags"), vec!["new"]);
        assert_eq!(
            date_rows(&connection, NODE_ID),
            vec![
                (
                    "title".to_string(),
                    5,
                    15,
                    "2026-07-13".to_string(),
                    "2026-07-13".to_string(),
                    "07/13/2026".to_string()
                ),
                (
                    "note".to_string(),
                    0,
                    9,
                    "2026-07-13".to_string(),
                    "2026-07-19".to_string(),
                    "next week".to_string()
                ),
            ]
        );

        split_node_at(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: CHILD_ID.to_string(),
                prefix: "today".to_string(),
                suffix: "tomorrow".to_string(),
            },
            fixed_today(),
        )
        .expect("split dated node");
        assert_eq!(date_rows(&connection, NODE_ID)[0].5, "today");
        assert_eq!(date_rows(&connection, CHILD_ID)[0].5, "tomorrow");

        let duplicated = duplicate_node_at(&mut connection, NODE_ID, fixed_today())
            .expect("duplicate dated subtree");
        let copied_root = duplicated
            .nodes
            .iter()
            .find(|node| node.id != NODE_ID && node.id != CHILD_ID && node.title == "today")
            .expect("copied root");
        assert_eq!(
            date_rows(&connection, &copied_root.id),
            date_rows(&connection, NODE_ID)
        );

        soft_delete_node(&mut connection, NODE_ID).expect("trash dated subtree");
        connection
            .execute("DELETE FROM notes_dates WHERE node_id = ?1", [NODE_ID])
            .expect("simulate stale derived rows");
        restore_node_at(&mut connection, NODE_ID, fixed_today()).expect("restore dated subtree");
        assert_eq!(date_rows(&connection, NODE_ID)[0].5, "today");
    }

    #[test]
    fn notes_date_and_tag_replacement_rolls_back_with_the_content_transaction() {
        let mut connection = test_connection();
        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "today #old".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("seed dated node");
        connection
            .execute_batch(
                "CREATE TRIGGER fail_date_projection BEFORE INSERT ON notes_dates \
                 WHEN NEW.token_text = 'tomorrow' BEGIN SELECT RAISE(ABORT, 'date failure'); END;",
            )
            .expect("install date failure");

        assert!(update_node_at(
            &mut connection,
            UpdateNodeInput {
                id: NODE_ID.to_string(),
                title: "tomorrow #new".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .is_err());
        assert_eq!(
            list_tags(&connection).expect("rolled back tags"),
            vec!["old"]
        );
        assert_eq!(date_rows(&connection, NODE_ID)[0].5, "today");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("workspace")
                .nodes[0]
                .title,
            "today #old"
        );
    }

    #[test]
    fn notes_date_search_uses_interval_overlap_scopes_limits_and_fts_fallback() {
        let mut connection = test_connection();
        for (id, title) in [
            (NODE_ID, "fallback-target 07/12/2026"),
            (CHILD_ID, "Archived 07/13/2026"),
            (THIRD_ID, "Trashed 07/14/2026"),
        ] {
            create_node_at(
                &mut connection,
                CreateNodeInput {
                    id: id.to_string(),
                    parent_id: None,
                    after_id: None,
                    title: title.to_string(),
                    note: String::new(),
                },
                fixed_today(),
            )
            .expect("seed date search node");
        }
        archive_node(&mut connection, CHILD_ID).expect("archive fixture");
        soft_delete_node(&mut connection, THIRD_ID).expect("trash fixture");

        let active = search_nodes_at(
            &connection,
            "tomorrow",
            NoteSearchScope::Active,
            fixed_today(),
        )
        .expect("natural date search");
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].node_id, NODE_ID);
        assert_eq!(active[0].matched_field, NoteSearchMatchedField::Date);

        for (scope, expected) in [
            (NoteSearchScope::Active, NODE_ID),
            (NoteSearchScope::Archive, CHILD_ID),
            (NoteSearchScope::Trash, THIRD_ID),
        ] {
            let results =
                search_nodes_at(&connection, "07/12/2026 - 07/14/2026", scope, fixed_today())
                    .expect("scoped range search");
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].node_id, expected);
        }
        assert_eq!(
            search_nodes_at(
                &connection,
                "fallback-target",
                NoteSearchScope::Active,
                fixed_today(),
            )
            .expect("FTS fallback")[0]
                .matched_field,
            NoteSearchMatchedField::Title
        );

        for index in 0..101 {
            let id = format!("{index:08x}-7777-4777-8777-777777777777");
            create_node_at(
                &mut connection,
                CreateNodeInput {
                    id,
                    parent_id: None,
                    after_id: None,
                    title: "07/12/2026".to_string(),
                    note: String::new(),
                },
                fixed_today(),
            )
            .expect("seed date limit node");
        }
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = '2026-07-11T00:00:00.000Z'",
                [],
            )
            .expect("set deterministic date result order");
        let limited = search_nodes_at(
            &connection,
            "07/12/2026",
            NoteSearchScope::Active,
            fixed_today(),
        )
        .expect("limited date search");
        assert_eq!(
            limited
                .iter()
                .map(|result| result.node_id.clone())
                .collect::<Vec<_>>(),
            (0..100)
                .map(|index| format!("{index:08x}-7777-4777-8777-777777777777"))
                .collect::<Vec<_>>()
        );
        let plan = connection
            .prepare(
                "EXPLAIN QUERY PLAN SELECT node_id FROM notes_dates \
                 WHERE normalized_start <= ?1 AND normalized_end >= ?2",
            )
            .expect("prepare date query plan")
            .query_map(params!["2026-07-12", "2026-07-12"], |row| {
                row.get::<_, String>(3)
            })
            .expect("query date plan")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect date plan")
            .join(" ");
        assert!(plan.contains("notes_dates_range"), "query plan: {plan}");
    }

    #[test]
    fn notes_archive_and_trash_text_search_preserves_matches_order_and_limits() {
        let mut connection = test_connection();
        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Active needle".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create active search control");
        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: CHILD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                title: "Archived needle".to_string(),
                note: "supportdetail".to_string(),
            },
            fixed_today(),
        )
        .expect("create archive search fixture");
        archive_node(&mut connection, CHILD_ID).expect("archive search fixture");
        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                title: "Trashed needle".to_string(),
                note: "trashextra".to_string(),
            },
            fixed_today(),
        )
        .expect("create trash search fixture");
        soft_delete_node(&mut connection, THIRD_ID).expect("trash search fixture");

        let archived = search_nodes_at(
            &connection,
            "needle",
            NoteSearchScope::Archive,
            fixed_today(),
        )
        .expect("archive text search");
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].node_id, CHILD_ID);
        assert_eq!(archived[0].matched_field, NoteSearchMatchedField::Title);
        assert_eq!(
            search_nodes_at(
                &connection,
                "supportdetail",
                NoteSearchScope::Archive,
                fixed_today(),
            )
            .expect("archive note search")[0]
                .matched_field,
            NoteSearchMatchedField::Note
        );

        let trashed = search_nodes_at(&connection, "needle", NoteSearchScope::Trash, fixed_today())
            .expect("trash text search");
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].node_id, THIRD_ID);
        assert_eq!(
            search_nodes_at(
                &connection,
                "trashextra",
                NoteSearchScope::Trash,
                fixed_today(),
            )
            .expect("trash note search")[0]
                .matched_field,
            NoteSearchMatchedField::Note
        );
        assert_eq!(
            search_nodes_at(
                &connection,
                "needle",
                NoteSearchScope::Active,
                fixed_today(),
            )
            .expect("active FTS control")
            .iter()
            .map(|result| result.node_id.as_str())
            .collect::<Vec<_>>(),
            vec![NODE_ID]
        );

        for index in 0..101 {
            let id = format!("{index:08x}-8888-4888-8888-888888888888");
            connection
                .execute(
                    "INSERT INTO notes_nodes (id, sort_key, title, created_at, updated_at, \
                       archived_at, archive_root_id) \
                     VALUES (?1, ?2, 'lifecyclelimit', '2026-07-11T00:00:00.000Z', \
                             '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', ?1)",
                    params![id, i64::from(index + 1) * 1024],
                )
                .expect("insert archive limit fixture");
        }
        let limited = search_nodes_at(
            &connection,
            "lifecyclelimit",
            NoteSearchScope::Archive,
            fixed_today(),
        )
        .expect("limited archive text search");
        assert_eq!(limited.len(), 100);
        assert_eq!(
            limited
                .iter()
                .map(|result| result.node_id.clone())
                .collect::<Vec<_>>(),
            (0..100)
                .map(|index| format!("{index:08x}-8888-4888-8888-888888888888"))
                .collect::<Vec<_>>()
        );

        for (index, updated_at) in [
            (0, "2026-07-11T01:00:00.000Z"),
            (1, "2026-07-11T03:00:00.000Z"),
            (2, "2026-07-11T02:00:00.000Z"),
        ] {
            let id = format!("{index:08x}-9999-4999-8999-999999999999");
            connection
                .execute(
                    "INSERT INTO notes_nodes (id, sort_key, title, created_at, updated_at, \
                       deleted_at, deleted_batch_id) \
                     VALUES (?1, ?2, 'trashorder', '2026-07-11T00:00:00.000Z', ?3, \
                             '2026-07-11T00:00:00.000Z', 'trash-order')",
                    params![id, i64::from(index + 1) * 1024, updated_at],
                )
                .expect("insert trash order fixture");
        }
        assert_eq!(
            search_nodes_at(
                &connection,
                "trashorder",
                NoteSearchScope::Trash,
                fixed_today(),
            )
            .expect("ordered trash text search")
            .iter()
            .map(|result| result.node_id.clone())
            .collect::<Vec<_>>(),
            vec![
                "00000001-9999-4999-8999-999999999999".to_string(),
                "00000002-9999-4999-8999-999999999999".to_string(),
                "00000000-9999-4999-8999-999999999999".to_string(),
            ]
        );
    }

    #[test]
    fn notes_lifecycle_search_trails_match_trash_rerooting_and_archive_context() {
        let mut connection = test_connection();
        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Live parent".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create live parent");
        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: CHILD_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                title: "Independent trash 07/12/2026".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create independent trash child");
        soft_delete_node(&mut connection, CHILD_ID).expect("trash child only");
        let trash_workspace =
            load_workspace(&connection, NotesWorkspaceScope::Trash).expect("trash workspace");
        assert_eq!(trash_workspace.nodes[0].parent_id, None);
        assert_eq!(
            search_nodes_at(
                &connection,
                "07/12/2026",
                NoteSearchScope::Trash,
                fixed_today(),
            )
            .expect("re-rooted trash search")[0]
                .parent_trail,
            Vec::<String>::new()
        );

        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                title: "Trash subtree root".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create trash subtree root");
        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: FOURTH_ID.to_string(),
                parent_id: Some(THIRD_ID.to_string()),
                after_id: None,
                title: "Nested trash 07/13/2026".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create nested trash child");
        soft_delete_node(&mut connection, THIRD_ID).expect("trash subtree");
        assert_eq!(
            search_nodes_at(
                &connection,
                "07/13/2026",
                NoteSearchScope::Trash,
                fixed_today(),
            )
            .expect("nested trash search")[0]
                .parent_trail,
            vec!["Trash subtree root"]
        );

        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: FIFTH_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                title: "Archive root".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create archive root");
        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: SIXTH_ID.to_string(),
                parent_id: Some(FIFTH_ID.to_string()),
                after_id: None,
                title: "Archived child 07/14/2026".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create archive child");
        archive_node(&mut connection, FIFTH_ID).expect("archive subtree");
        assert_eq!(
            search_nodes_at(
                &connection,
                "07/14/2026",
                NoteSearchScope::Archive,
                fixed_today(),
            )
            .expect("archive context search")[0]
                .parent_trail,
            vec!["Archive root"]
        );
    }

    #[test]
    fn notes_tag_workspace_scope_rejects_noncanonical_body() {
        let connection = test_connection();
        let error = load_workspace(
            &connection,
            NotesWorkspaceScope::Tags {
                tags: vec![NoteTagFilter {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: "##x".to_string(),
                }],
            },
        )
        .expect_err("invalid typed tag workspace scope");

        assert_eq!(
            error,
            "Structured Notes search tag normalizedTag must be a canonical tag body."
        );
    }

    fn search_tag(prefix: NoteTagPrefix, tag: &str) -> NoteSearchTag {
        NoteSearchTag {
            prefix,
            normalized_tag: tag.to_string(),
            display_tag: tag.to_string(),
        }
    }

    fn structured_query(
        text: &str,
        required_tags: Vec<NoteSearchTag>,
        excluded_tags: Vec<NoteSearchTag>,
        or_groups: Vec<Vec<NoteSearchTag>>,
    ) -> NoteStructuredSearchQuery {
        NoteStructuredSearchQuery {
            text: text.to_string(),
            required_tags,
            excluded_tags,
            or_groups,
        }
    }

    #[test]
    fn notes_tag_structured_search_combines_fts_and_parameterized_filters() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "Home", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "Release #Roadmap @Minji",
            "shipping detail",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(NODE_ID),
            Some(CHILD_ID),
            "Release blocked #Roadmap @Minji #Blocked",
            "",
        );
        create_test_node(
            &mut connection,
            FOURTH_ID,
            Some(NODE_ID),
            Some(THIRD_ID),
            "Platform @Platform #Desktop",
            "release notes",
        );
        create_test_node(
            &mut connection,
            FIFTH_ID,
            Some(NODE_ID),
            Some(FOURTH_ID),
            "Note tag",
            "#Roadmap release notes",
        );
        create_test_node(
            &mut connection,
            SIXTH_ID,
            None,
            Some(NODE_ID),
            "Archived #Roadmap release",
            "",
        );
        archive_node(&mut connection, SIXTH_ID).expect("archive fixture");
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = CASE id \
                   WHEN ?1 THEN '2026-07-10T01:00:00.000Z' \
                   WHEN ?2 THEN '2026-07-10T04:00:00.000Z' \
                   WHEN ?3 THEN '2026-07-10T03:00:00.000Z' \
                   WHEN ?4 THEN '2026-07-10T02:00:00.000Z' \
                   ELSE '2026-07-10T00:00:00.000Z' END",
                params![CHILD_ID, THIRD_ID, FOURTH_ID, FIFTH_ID],
            )
            .expect("set deterministic search order");

        let mixed = search_nodes_structured(
            &connection,
            &structured_query(
                "release",
                vec![
                    search_tag(NoteTagPrefix::Hash, "roadmap"),
                    search_tag(NoteTagPrefix::Mention, "minji"),
                ],
                vec![search_tag(NoteTagPrefix::Hash, "blocked")],
                vec![],
            ),
        )
        .expect("mixed structured search");
        assert_eq!(mixed.len(), 1);
        assert_eq!(mixed[0].node_id, CHILD_ID);
        assert_eq!(mixed[0].parent_trail, vec!["Home"]);
        assert_eq!(mixed[0].matched_field, NoteSearchMatchedField::Title);

        let grouped = search_nodes_structured(
            &connection,
            &structured_query(
                "release notes",
                vec![],
                vec![],
                vec![vec![
                    search_tag(NoteTagPrefix::Hash, "desktop"),
                    search_tag(NoteTagPrefix::Mention, "platform"),
                ]],
            ),
        )
        .expect("OR group search");
        assert_eq!(
            grouped
                .iter()
                .map(|result| result.node_id.as_str())
                .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );

        let tag_only = search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Hash, "roadmap")],
                vec![],
                vec![],
            ),
        )
        .expect("tag-only search");
        assert_eq!(
            tag_only
                .iter()
                .map(|result| (result.node_id.as_str(), result.matched_field))
                .collect::<Vec<_>>(),
            vec![
                (THIRD_ID, NoteSearchMatchedField::Title),
                (FIFTH_ID, NoteSearchMatchedField::Note),
                (CHILD_ID, NoteSearchMatchedField::Title),
            ]
        );

        let exclusion_only = search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![],
                vec![search_tag(NoteTagPrefix::Hash, "blocked")],
                vec![],
            ),
        )
        .expect("exclusion-only search");
        assert_eq!(
            exclusion_only
                .iter()
                .map(|result| (result.node_id.as_str(), result.matched_field))
                .collect::<Vec<_>>(),
            vec![
                (FOURTH_ID, NoteSearchMatchedField::Title),
                (FIFTH_ID, NoteSearchMatchedField::Title),
                (CHILD_ID, NoteSearchMatchedField::Title),
                (NODE_ID, NoteSearchMatchedField::Title),
            ]
        );

        assert!(search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Mention, "roadmap")],
                vec![],
                vec![],
            )
        )
        .expect("prefix-distinct search")
        .is_empty());
        assert_eq!(
            search_nodes_structured(
                &connection,
                &structured_query(
                    "",
                    vec![search_tag(NoteTagPrefix::Hash, "x') OR 1=1 --")],
                    vec![],
                    vec![],
                )
            )
            .expect_err("invalid hostile tag"),
            "Structured Notes search tag normalizedTag must be a canonical tag body."
        );
    }

    fn indexed_search_tags(count: usize) -> Vec<NoteSearchTag> {
        (0..count)
            .map(|index| {
                search_tag(
                    if index % 2 == 0 {
                        NoteTagPrefix::Hash
                    } else {
                        NoteTagPrefix::Mention
                    },
                    &format!("tag-{index}"),
                )
            })
            .collect()
    }

    #[test]
    fn notes_tag_structured_search_enforces_utf8_text_byte_limit() {
        let connection = test_connection();
        let boundary_text = format!("{}a", "가".repeat(1365));
        assert_eq!(boundary_text.len(), 4096);
        assert!(search_nodes_structured(
            &connection,
            &structured_query(&boundary_text, vec![], vec![], vec![])
        )
        .expect("4096-byte structured search")
        .is_empty());

        let error = search_nodes_structured(
            &connection,
            &structured_query(&format!("{boundary_text}b"), vec![], vec![], vec![]),
        )
        .expect_err("4097-byte structured search");
        assert_eq!(
            error,
            "Structured Notes search text exceeds 4096 UTF-8 bytes."
        );
    }

    #[test]
    fn notes_tag_structured_search_enforces_total_unique_tag_limit_before_sql() {
        let connection = test_connection();
        let boundary_tags = indexed_search_tags(64);
        assert!(search_nodes_structured(
            &connection,
            &structured_query("", boundary_tags, vec![], vec![])
        )
        .expect("64 parameterized tag alternatives")
        .is_empty());

        connection
            .execute("DROP TABLE notes_tags", [])
            .expect("remove tag table before over-limit validation");
        let error = search_nodes_structured(
            &connection,
            &structured_query("", indexed_search_tags(65), vec![], vec![]),
        )
        .expect_err("65 unique tag alternatives");
        assert_eq!(
            error,
            "Structured Notes search has more than 64 unique tag alternatives."
        );
    }

    #[test]
    fn notes_tag_structured_search_enforces_raw_or_group_limit() {
        let connection = test_connection();
        let duplicate_group = vec![
            search_tag(NoteTagPrefix::Hash, "one"),
            search_tag(NoteTagPrefix::Mention, "two"),
        ];
        assert!(search_nodes_structured(
            &connection,
            &structured_query("", vec![], vec![], vec![duplicate_group.clone(); 16],)
        )
        .expect("16 OR groups")
        .is_empty());

        let error = search_nodes_structured(
            &connection,
            &structured_query("", vec![], vec![], vec![duplicate_group; 17]),
        )
        .expect_err("17 OR groups");
        assert_eq!(error, "Structured Notes search has more than 16 OR groups.");
    }

    #[test]
    fn notes_tag_structured_search_enforces_raw_alternatives_per_group_limit() {
        let connection = test_connection();
        let duplicate = search_tag(NoteTagPrefix::Hash, "duplicate");
        assert!(search_nodes_structured(
            &connection,
            &structured_query("", vec![], vec![], vec![vec![duplicate.clone(); 16]])
        )
        .expect("16 alternatives in one OR group")
        .is_empty());

        let error = search_nodes_structured(
            &connection,
            &structured_query("", vec![], vec![], vec![vec![duplicate; 17]]),
        )
        .expect_err("17 alternatives in one OR group");
        assert_eq!(
            error,
            "Structured Notes search OR group has more than 16 alternatives."
        );
    }

    #[test]
    fn notes_tag_structured_search_limits_tag_only_results_to_one_hundred() {
        let mut connection = test_connection();
        for index in 0..101 {
            let id = format!("00000000-0000-4000-8000-{index:012x}");
            create_test_node(&mut connection, &id, None, None, "#Bulk", "");
        }
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = '2026-07-10T00:00:00.000Z'",
                [],
            )
            .expect("set equal timestamps");

        let results = search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Hash, "bulk")],
                vec![],
                vec![],
            ),
        )
        .expect("limited tag search");

        assert_eq!(results.len(), 100);
        assert!(results
            .windows(2)
            .all(|pair| pair[0].node_id < pair[1].node_id));
    }

    #[test]
    fn notes_tag_lifecycle_rebuilds_exact_tags_and_cascades_empty_trash() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "#Left middle #Right",
            "",
        );
        split_node(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: CHILD_ID.to_string(),
                prefix: "#Left".to_string(),
                suffix: "#Right".to_string(),
            },
        )
        .expect("split tagged node");
        assert_eq!(
            search_nodes_structured(
                &connection,
                &structured_query(
                    "",
                    vec![search_tag(NoteTagPrefix::Hash, "left")],
                    vec![],
                    vec![],
                )
            )
            .expect("left after split")
            .len(),
            1
        );
        assert_eq!(
            search_nodes_structured(
                &connection,
                &structured_query(
                    "",
                    vec![search_tag(NoteTagPrefix::Hash, "right")],
                    vec![],
                    vec![],
                )
            )
            .expect("right after split")
            .len(),
            1
        );

        let workspace = duplicate_node(&mut connection, NODE_ID).expect("duplicate tagged node");
        let duplicate_id = workspace
            .nodes
            .iter()
            .find(|node| node.id != NODE_ID && node.id != CHILD_ID && node.title == "#Left")
            .expect("duplicate tagged node")
            .id
            .clone();
        let left_query = structured_query(
            "",
            vec![search_tag(NoteTagPrefix::Hash, "left")],
            vec![],
            vec![],
        );
        assert_eq!(
            search_nodes_structured(&connection, &left_query)
                .unwrap()
                .len(),
            2
        );

        soft_delete_node(&mut connection, &duplicate_id).expect("trash duplicate");
        assert_eq!(
            search_nodes_structured(&connection, &left_query)
                .unwrap()
                .len(),
            1
        );
        let stored_while_trashed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_tags WHERE node_id = ?1",
                [&duplicate_id],
                |row| row.get(0),
            )
            .expect("trashed tags remain");
        assert_eq!(stored_while_trashed, 1);
        connection
            .execute(
                "UPDATE notes_tags SET tag = 'stale', normalized_tag = 'stale' \
                 WHERE node_id = ?1",
                [&duplicate_id],
            )
            .expect("seed stale trashed tag");

        restore_node(&mut connection, &duplicate_id).expect("restore duplicate");
        assert_eq!(
            search_nodes_structured(&connection, &left_query)
                .unwrap()
                .len(),
            2
        );
        assert!(search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Hash, "stale")],
                vec![],
                vec![],
            )
        )
        .expect("stale tag after restore")
        .is_empty());
        archive_node(&mut connection, &duplicate_id).expect("archive duplicate");
        assert_eq!(
            search_nodes_structured(&connection, &left_query)
                .unwrap()
                .len(),
            1
        );
        unarchive_node(&mut connection, &duplicate_id).expect("unarchive duplicate");
        soft_delete_node(&mut connection, &duplicate_id).expect("trash duplicate again");
        empty_trash(&mut connection).expect("empty trash");
        let stored_after_empty: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_tags WHERE node_id = ?1",
                [&duplicate_id],
                |row| row.get(0),
            )
            .expect("cascaded tags");
        assert_eq!(stored_after_empty, 0);
    }

    #[test]
    fn starred_recent_tag_and_trash_scopes_are_disjoint() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "All", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "Starred",
            "",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(CHILD_ID),
            None,
            "Tagged #Élan",
            "",
        );
        create_test_node(
            &mut connection,
            FOURTH_ID,
            Some(NODE_ID),
            Some(CHILD_ID),
            "Trash #Hidden",
            "",
        );

        let workspace = toggle_star(&mut connection, CHILD_ID).expect("toggle star");
        assert!(
            workspace
                .nodes
                .iter()
                .find(|node| node.id == CHILD_ID)
                .expect("starred node")
                .is_starred
        );
        soft_delete_node(&mut connection, FOURTH_ID).expect("delete trash node");
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = CASE id \
                   WHEN ?1 THEN '2026-07-10T01:00:00.000Z' \
                   WHEN ?2 THEN '2026-07-10T02:00:00.000Z' \
                   WHEN ?3 THEN '2026-07-10T03:00:00.000Z' \
                   ELSE updated_at END",
                params![NODE_ID, CHILD_ID, THIRD_ID],
            )
            .expect("set deterministic recency");

        let starred =
            load_workspace(&connection, NotesWorkspaceScope::Starred).expect("starred workspace");
        assert_eq!(
            starred
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID]
        );
        let recent =
            load_workspace(&connection, NotesWorkspaceScope::Recent).expect("recent workspace");
        assert_eq!(
            recent
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID, THIRD_ID]
        );
        let tagged = load_workspace(
            &connection,
            NotesWorkspaceScope::Tag {
                tag: "#ÉLAN".to_string(),
            },
        )
        .expect("tag workspace");
        assert_eq!(
            tagged
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID, THIRD_ID]
        );
        let trash =
            load_workspace(&connection, NotesWorkspaceScope::Trash).expect("trash workspace");
        assert_eq!(
            trash
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );
        assert_eq!(trash.nodes[0].parent_id, None);
        assert_eq!(list_tags(&connection).expect("live tags"), vec!["élan"]);
    }

    #[test]
    fn archive_marks_one_live_root_subtree_and_excludes_it_from_active_discovery() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "Archived target #Roadmap @Minji",
            "searchable archive detail",
        );
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "Starred child #Roadmap @Minji",
            "",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(CHILD_ID),
            None,
            "Grandchild",
            "",
        );
        create_test_node(
            &mut connection,
            FOURTH_ID,
            None,
            Some(NODE_ID),
            "Active #Roadmap @Minji",
            "",
        );
        toggle_star(&mut connection, CHILD_ID).expect("star child");

        let active = archive_node(&mut connection, NODE_ID).expect("archive root");

        assert_eq!(
            active
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );
        let archived =
            load_workspace(&connection, NotesWorkspaceScope::Archive).expect("archive workspace");
        assert_eq!(
            archived
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID, THIRD_ID]
        );
        let archived_at = archived.nodes[0]
            .archived_at
            .clone()
            .expect("archive timestamp");
        assert!(archived.nodes.iter().all(|node| {
            node.archived_at.as_deref() == Some(archived_at.as_str())
                && node.archive_root_id.as_deref() == Some(NODE_ID)
                && node.deleted_at.is_none()
        }));
        assert!(load_workspace(&connection, NotesWorkspaceScope::Starred)
            .expect("starred")
            .nodes
            .is_empty());
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Recent)
                .expect("recent")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );
        assert_eq!(
            load_workspace(
                &connection,
                NotesWorkspaceScope::Tag {
                    tag: "#roadmap".to_string()
                }
            )
            .expect("legacy tag")
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );
        assert_eq!(
            load_workspace(
                &connection,
                NotesWorkspaceScope::Tags {
                    tags: vec![
                        NoteTagFilter {
                            prefix: NoteTagPrefix::Hash,
                            normalized_tag: "roadmap".to_string(),
                        },
                        NoteTagFilter {
                            prefix: NoteTagPrefix::Mention,
                            normalized_tag: "minji".to_string(),
                        },
                    ]
                }
            )
            .expect("structured tags")
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );
        assert!(search_nodes(&connection, "searchable")
            .expect("search")
            .is_empty());
        assert!(load_workspace(&connection, NotesWorkspaceScope::Trash)
            .expect("trash")
            .nodes
            .is_empty());
        assert_eq!(
            list_tags_with_counts(&connection).expect("tag summaries"),
            vec![
                crate::notes::types::NoteTagSummary {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: "roadmap".to_string(),
                    display_tag: "Roadmap".to_string(),
                    count: 1,
                },
                crate::notes::types::NoteTagSummary {
                    prefix: NoteTagPrefix::Mention,
                    normalized_tag: "minji".to_string(),
                    display_tag: "Minji".to_string(),
                    count: 1,
                },
            ]
        );
    }

    #[test]
    fn archive_rejects_non_roots_and_rolls_back_a_failed_subtree_update() {
        let mut connection = test_connection();
        insert_tree(&connection);
        let error = archive_node(&mut connection, CHILD_ID).expect_err("child archive");
        assert!(error.contains("root"));

        connection
            .execute_batch(&format!(
                "CREATE TRIGGER reject_archive_child \
                 BEFORE UPDATE OF archived_at ON notes_nodes \
                 WHEN OLD.id = '{CHILD_ID}' AND NEW.archived_at IS NOT NULL \
                 BEGIN SELECT RAISE(ABORT, 'archive child rejected'); END;"
            ))
            .expect("install archive failure");
        let error = archive_node(&mut connection, NODE_ID).expect_err("archive rollback");
        assert!(error.contains("archive child rejected"));
        let archived_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE archived_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("archived rows after rollback");
        assert_eq!(archived_count, 0);
    }

    #[test]
    fn unarchive_restores_the_original_root_position_and_archive_ownership_only() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "Archived root", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "Archived child",
            "",
        );
        archive_node(&mut connection, NODE_ID).expect("archive root");
        create_test_node(
            &mut connection,
            THIRD_ID,
            None,
            None,
            "Replacement root",
            "",
        );

        let error = unarchive_node(&mut connection, CHILD_ID).expect_err("child unarchive");
        assert!(error.contains("archive root"));
        let active = unarchive_node(&mut connection, NODE_ID).expect("unarchive root");

        assert_eq!(
            active
                .nodes
                .iter()
                .filter(|node| node.parent_id.is_none())
                .map(|node| (node.id.as_str(), node.sort_key))
                .collect::<Vec<_>>(),
            vec![(NODE_ID, 1024), (THIRD_ID, 2048)]
        );
        assert!(active
            .nodes
            .iter()
            .filter(|node| { node.id == NODE_ID || node.id == CHILD_ID })
            .all(|node| node.archived_at.is_none() && node.archive_root_id.is_none()));
        assert!(load_workspace(&connection, NotesWorkspaceScope::Archive)
            .expect("archive")
            .nodes
            .is_empty());
    }

    #[test]
    fn moving_an_archived_root_to_trash_keeps_archive_and_trash_disjoint() {
        let mut connection = test_connection();
        insert_tree(&connection);
        archive_node(&mut connection, NODE_ID).expect("archive root");

        soft_delete_node(&mut connection, NODE_ID).expect("trash archived root");

        assert!(load_workspace(&connection, NotesWorkspaceScope::Archive)
            .expect("archive")
            .nodes
            .is_empty());
        let trash = load_workspace(&connection, NotesWorkspaceScope::Trash).expect("trash");
        assert_eq!(trash.nodes.len(), 2);
        assert!(trash.nodes.iter().all(|node| {
            node.deleted_at.is_some()
                && node.archived_at.is_none()
                && node.archive_root_id.is_none()
        }));
        let restored = restore_node(&mut connection, NODE_ID).expect("restore from trash");
        assert_eq!(restored.nodes.len(), 2);
        assert!(restored.nodes.iter().all(|node| {
            node.deleted_at.is_none()
                && node.archived_at.is_none()
                && node.archive_root_id.is_none()
        }));
    }

    #[test]
    fn archived_descendant_cannot_be_trashed_and_restored_as_an_active_root() {
        let mut connection = test_connection();
        insert_tree(&connection);
        archive_node(&mut connection, NODE_ID).expect("archive root");

        let error = soft_delete_node(&mut connection, CHILD_ID)
            .expect_err("archived descendant trash must be rejected");

        assert!(error.contains("archive root"));
        assert!(load_workspace(&connection, NotesWorkspaceScope::Trash)
            .expect("trash")
            .nodes
            .is_empty());
        assert!(restore_node(&mut connection, CHILD_ID)
            .expect_err("archived child was never trashed")
            .contains("not in the trash"));
        let active = unarchive_node(&mut connection, NODE_ID).expect("unarchive root");
        assert_eq!(active.nodes.len(), 2);
        assert_eq!(
            active
                .nodes
                .iter()
                .find(|node| node.id == CHILD_ID)
                .expect("restored child")
                .parent_id
                .as_deref(),
            Some(NODE_ID)
        );
    }

    #[test]
    fn recent_scope_limits_matches_but_keeps_an_older_live_ancestor() {
        let connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "older ancestor");
        insert_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            1024,
            "recent descendant",
        );
        insert_node(&connection, THIRD_ID, None, 2048, "older unrelated node");
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = CASE id \
                   WHEN ?1 THEN '2026-07-08T00:00:00.000Z' \
                   WHEN ?2 THEN '2026-07-10T00:00:00.999Z' \
                   WHEN ?3 THEN '2026-07-09T00:00:00.000Z' END \
                 WHERE id IN (?1, ?2, ?3)",
                params![NODE_ID, CHILD_ID, THIRD_ID],
            )
            .expect("set anchor recency");

        let mut recent_peer_ids = Vec::new();
        for index in 0..99 {
            let id = format!("{index:08x}-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
            insert_node(
                &connection,
                &id,
                None,
                i64::from(index + 3) * 1024,
                "recent peer",
            );
            connection
                .execute(
                    "UPDATE notes_nodes SET updated_at = ?1 WHERE id = ?2",
                    params![format!("2026-07-10T00:00:00.{:03}Z", index + 1), id],
                )
                .expect("set peer recency");
            recent_peer_ids.push(id);
        }

        let active =
            load_workspace(&connection, NotesWorkspaceScope::Active).expect("active workspace");
        let recent =
            load_workspace(&connection, NotesWorkspaceScope::Recent).expect("recent workspace");
        let recent_ids = recent
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(active.nodes.len(), 102);
        assert_eq!(recent.nodes.len(), 101);
        assert!(recent_ids.contains(&NODE_ID));
        assert!(recent_ids.contains(&CHILD_ID));
        assert!(!recent_ids.contains(&THIRD_ID));
        assert!(recent_peer_ids
            .iter()
            .all(|id| recent_ids.contains(&id.as_str())));
    }

    #[test]
    fn search_limits_results_to_one_hundred_nodes() {
        let connection = test_connection();
        for index in 0..101 {
            let id = format!("{index:08x}-1111-4111-8111-111111111111");
            insert_node(
                &connection,
                &id,
                None,
                i64::from(index + 1) * 1024,
                "limit-target",
            );
        }

        assert_eq!(
            search_nodes(&connection, "limit-target")
                .expect("limited search")
                .len(),
            100
        );
    }

    #[test]
    fn delete_database_removes_only_notes_owned_sqlite_files() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("vault path");
        let connection = connect_notes_db(vault_path).expect("connect notes");
        let notes_path = notes_db_path(vault_path);
        let metadata_path = notes_path.parent().expect("metadata path");
        let index_path = metadata_path.join("index.sqlite");
        let settings_path = metadata_path.join("settings.json");
        std::fs::write(&index_path, b"index").expect("write index fixture");
        std::fs::write(&settings_path, b"{}").expect("write metadata fixture");
        drop(connection);

        let wal_path = metadata_path.join("notes.sqlite-wal");
        let shm_path = metadata_path.join("notes.sqlite-shm");
        std::fs::write(&wal_path, b"wal").expect("write WAL fixture");
        std::fs::write(&shm_path, b"shm").expect("write SHM fixture");

        delete_database(vault_path).expect("delete Notes database");
        delete_database(vault_path).expect("repeat missing Notes database deletion");

        assert!(!notes_path.exists());
        assert!(!wal_path.exists());
        assert!(!shm_path.exists());
        assert_eq!(std::fs::read(index_path).expect("read index"), b"index");
        assert_eq!(std::fs::read(settings_path).expect("read settings"), b"{}");
        assert!(metadata_path.exists());
    }

    #[test]
    fn deleted_database_reinitializes_empty_without_changing_other_metadata() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("vault path");
        let connection = connect_notes_db(vault_path).expect("connect notes");
        insert_node(&connection, NODE_ID, None, 1024, "stored note");

        let notes_path = notes_db_path(vault_path);
        let metadata_path = notes_path.parent().expect("metadata path");
        let index_path = metadata_path.join("index.sqlite");
        let settings_path = metadata_path.join("settings.json");
        std::fs::write(&index_path, b"index fixture").expect("write index fixture");
        std::fs::write(&settings_path, b"metadata fixture").expect("write metadata fixture");
        drop(connection);

        delete_database(vault_path).expect("delete Notes database");
        let reopened = connect_notes_db(vault_path).expect("reinitialize Notes database");
        let workspace =
            load_workspace(&reopened, NotesWorkspaceScope::Active).expect("load empty workspace");

        assert!(workspace.nodes.is_empty());
        assert!(notes_path.exists());
        assert_eq!(
            std::fs::read(index_path).expect("read index fixture"),
            b"index fixture"
        );
        assert_eq!(
            std::fs::read(settings_path).expect("read metadata fixture"),
            b"metadata fixture"
        );
    }
}
