use rusqlite::{Connection, Transaction};
use std::fs;
use std::path::PathBuf;

const NOTES_SCHEMA_VERSION: i64 = 1;

pub(crate) fn notes_db_path(vault_path: &str) -> PathBuf {
    crate::metadata_dir(vault_path).join("notes.sqlite")
}

pub(crate) fn connect_notes_db(vault_path: &str) -> Result<Connection, String> {
    if vault_path.trim().is_empty() {
        return Err("Vault path must not be empty.".to_string());
    }

    let metadata = crate::metadata_dir(vault_path);
    fs::create_dir_all(&metadata)
        .map_err(|error| format!("Could not prepare Notes storage: {error}"))?;
    let mut connection = Connection::open(notes_db_path(vault_path))
        .map_err(|error| format!("Could not open Notes storage: {error}"))?;
    initialize_notes_db(&mut connection)?;
    Ok(connection)
}

fn initialize_notes_db(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            "#,
        )
        .map_err(|error| format!("Could not configure Notes storage: {error}"))?;

    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Could not read the Notes schema version: {error}"))?;

    match user_version {
        0 => migrate_to_version_one(connection),
        NOTES_SCHEMA_VERSION => Ok(()),
        version => Err(format!(
            "This Notes database uses unsupported schema version {version}."
        )),
    }
}

fn migrate_to_version_one(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not start the Notes database migration: {error}"))?;

    create_version_one_schema(&transaction)?;
    transaction
        .pragma_update(None, "user_version", NOTES_SCHEMA_VERSION)
        .map_err(|error| format!("Could not record the Notes schema version: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not finish the Notes database migration: {error}"))
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

#[cfg(test)]
mod tests {
    use super::{connect_notes_db, notes_db_path};
    use rusqlite::{params, Connection};

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";

    fn object_exists(connection: &Connection, object_type: &str, name: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2)",
                params![object_type, name],
                |row| row.get(0),
            )
            .expect("schema object query")
    }

    #[test]
    fn notes_database_uses_its_own_schema_and_fts_table() {
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
        ] {
            assert!(
                object_exists(&connection, "table", table),
                "missing table {table}"
            );
        }
        for index in [
            "notes_nodes_active_parent_order",
            "notes_tags_normalized_tag",
        ] {
            assert!(
                object_exists(&connection, "index", index),
                "missing index {index}"
            );
        }
    }

    #[test]
    fn notes_connection_is_configured_and_migrated_to_version_one() {
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
        assert_eq!(user_version, 1);
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
}
