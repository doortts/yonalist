use notes_application::StorageError;
use rusqlite::Connection;

pub(crate) const SCHEMA_VERSION: i64 = 1;

pub(crate) fn initialize(connection: &Connection) -> Result<(), StorageError> {
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(internal)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(internal)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(internal)?;
    connection
        .pragma_update(None, "temp_store", "MEMORY")
        .map_err(internal)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(internal)?;

    let version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(internal)?;
    if version == 0 {
        create_schema(connection)?;
    } else if version != SCHEMA_VERSION {
        return Err(StorageError::Internal(format!(
            "unsupported Notes schema version {version}; expected {SCHEMA_VERSION}"
        )));
    }
    Ok(())
}

fn create_schema(connection: &Connection) -> Result<(), StorageError> {
    connection
        .execute_batch(
            "
            BEGIN IMMEDIATE;
            CREATE TABLE notes_meta (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                revision INTEGER NOT NULL CHECK (revision >= 0)
            ) STRICT;
            INSERT INTO notes_meta(singleton, revision) VALUES (1, 0);

            CREATE TABLE notes_nodes (
                id TEXT PRIMARY KEY NOT NULL,
                parent_id TEXT,
                sort_key INTEGER NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('page', 'bullet')),
                text TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                marker TEXT NOT NULL DEFAULT 'bullet'
                    CHECK (marker IN ('bullet', 'todo')),
                collapsed INTEGER NOT NULL DEFAULT 0
                    CHECK (collapsed IN (0, 1)),
                completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
                starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
                deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
                FOREIGN KEY(parent_id) REFERENCES notes_nodes(id)
                    DEFERRABLE INITIALLY DEFERRED,
                CHECK (
                    (kind = 'page' AND parent_id IS NULL) OR
                    (kind = 'bullet' AND parent_id IS NOT NULL)
                )
            ) STRICT;
            CREATE INDEX notes_nodes_parent_order
                ON notes_nodes(parent_id, deleted, sort_key, id);

            CREATE TABLE notes_tags (
                node_id TEXT NOT NULL,
                token TEXT NOT NULL,
                display_tag TEXT NOT NULL,
                PRIMARY KEY(node_id, token),
                FOREIGN KEY(node_id) REFERENCES notes_nodes(id) ON DELETE CASCADE
            ) STRICT;
            CREATE INDEX notes_tags_token ON notes_tags(token, node_id);

            CREATE TABLE notes_dates (
                node_id TEXT NOT NULL,
                date_key TEXT NOT NULL,
                PRIMARY KEY(node_id, date_key),
                FOREIGN KEY(node_id) REFERENCES notes_nodes(id) ON DELETE CASCADE
            ) STRICT;
            CREATE INDEX notes_dates_key ON notes_dates(date_key, node_id);

            CREATE VIRTUAL TABLE notes_fts USING fts5(
                node_id UNINDEXED,
                text,
                note,
                tokenize = 'unicode61'
            );
            CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes_nodes BEGIN
                INSERT INTO notes_fts(node_id, text, note)
                VALUES (new.id, new.text, new.note);
            END;
            CREATE TRIGGER notes_fts_update AFTER UPDATE OF text, note ON notes_nodes BEGIN
                DELETE FROM notes_fts WHERE node_id = old.id;
                INSERT INTO notes_fts(node_id, text, note)
                VALUES (new.id, new.text, new.note);
            END;
            CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes_nodes BEGIN
                DELETE FROM notes_fts WHERE node_id = old.id;
            END;

            CREATE TABLE notes_ui_state (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            ) STRICT;

            PRAGMA user_version = 1;
            COMMIT;
            ",
        )
        .map_err(internal)
}

fn internal(error: rusqlite::Error) -> StorageError {
    StorageError::Internal(error.to_string())
}
