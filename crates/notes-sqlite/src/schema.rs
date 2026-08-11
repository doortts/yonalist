use notes_application::StorageError;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

pub(crate) const SCHEMA_VERSION: i64 = 1;
pub(crate) const ROOT_ID: &str = "root";

/// Guarantees the single root row every outline hangs from and adopts legacy
/// top-level pages as its children, so a "page" is only ever a root child.
/// Idempotent and non-destructive: no schema change, no version flag, and the
/// adopted rows keep their order and their trash flag.
pub(crate) fn ensure_root(connection: &mut Connection) -> Result<(), StorageError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(internal)?;
    let kind: Option<String> = transaction
        .query_row(
            "SELECT kind FROM notes_nodes WHERE id = ?1",
            [ROOT_ID],
            |row| row.get(0),
        )
        .optional()
        .map_err(internal)?;
    match kind.as_deref() {
        Some("page") => {}
        Some(other) => {
            return Err(StorageError::Internal(format!(
                "notes node '{ROOT_ID}' is a {other}; expected the root page"
            )));
        }
        None => {
            transaction
                .execute(
                    "INSERT INTO notes_nodes(
                         id, parent_id, sort_key, kind, text, note, marker,
                         collapsed, completed, starred, deleted
                     )
                     VALUES (?1, NULL, 0, 'page', 'Home', '', 'bullet', 0, 0, 0, 0)",
                    [ROOT_ID],
                )
                .map_err(internal)?;
        }
    }
    // Legacy pages become collapsed root children; the deferred self-FK lets
    // this follow the insert above inside one transaction.
    transaction
        .execute(
            "UPDATE notes_nodes
             SET parent_id = ?1, kind = 'bullet', collapsed = 1
             WHERE parent_id IS NULL AND id <> ?1",
            [ROOT_ID],
        )
        .map_err(internal)?;
    transaction.commit().map_err(internal)
}

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
                kind TEXT NOT NULL CHECK (kind IN ('page', 'bullet', 'image')),
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
                    (kind IN ('bullet', 'image') AND parent_id IS NOT NULL)
                )
            ) STRICT;
            CREATE INDEX notes_nodes_parent_order
                ON notes_nodes(parent_id, deleted, sort_key, id);

            CREATE TABLE notes_images (
                node_id TEXT PRIMARY KEY NOT NULL,
                content_hash TEXT NOT NULL CHECK (
                    length(content_hash) = 64 AND
                    content_hash NOT GLOB '*[^0-9a-f]*'
                ),
                relative_path TEXT NOT NULL,
                original_name TEXT NOT NULL,
                mime_type TEXT NOT NULL CHECK (
                    mime_type IN (
                        'image/png', 'image/jpeg', 'image/gif', 'image/webp'
                    )
                ),
                byte_length INTEGER NOT NULL
                    CHECK (byte_length BETWEEN 1 AND 20971520),
                pixel_width INTEGER NOT NULL CHECK (pixel_width > 0),
                pixel_height INTEGER NOT NULL CHECK (pixel_height > 0),
                display_width INTEGER NOT NULL CHECK (display_width >= 120),
                FOREIGN KEY(node_id) REFERENCES notes_nodes(id) ON DELETE CASCADE
            ) STRICT;

            CREATE VIEW notes_node_records AS
            SELECT
                node.id,
                node.parent_id,
                node.sort_key,
                node.kind,
                node.text,
                node.note,
                node.marker,
                node.collapsed,
                node.completed,
                node.starred,
                node.deleted,
                image.content_hash,
                image.relative_path,
                image.original_name,
                image.mime_type,
                image.byte_length,
                image.pixel_width,
                image.pixel_height,
                image.display_width
            FROM notes_nodes node
            LEFT JOIN notes_images image ON image.node_id = node.id;

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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[derive(Debug, PartialEq, Eq)]
    struct Row {
        id: String,
        parent_id: Option<String>,
        kind: String,
        sort_key: i64,
        collapsed: i64,
        deleted: i64,
    }

    fn open() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db");
        initialize(&connection).expect("schema");
        connection
    }

    fn insert_page(connection: &Connection, id: &str, sort_key: i64, deleted: i64) {
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, deleted)
                 VALUES (?1, NULL, ?2, 'page', ?1, ?3)",
                params![id, sort_key, deleted],
            )
            .expect("page");
    }

    fn rows(connection: &Connection) -> Vec<Row> {
        let mut statement = connection
            .prepare(
                "SELECT id, parent_id, kind, sort_key, collapsed, deleted
                 FROM notes_nodes
                 ORDER BY sort_key, id",
            )
            .expect("prepare");
        let rows = statement
            .query_map([], |row| {
                Ok(Row {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    kind: row.get(2)?,
                    sort_key: row.get(3)?,
                    collapsed: row.get(4)?,
                    deleted: row.get(5)?,
                })
            })
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows");
        rows
    }

    #[test]
    fn creates_the_root_row_in_an_empty_database() {
        let mut connection = open();
        ensure_root(&mut connection).expect("ensure root");

        let (text, note, marker, completed, starred): (String, String, String, i64, i64) =
            connection
                .query_row(
                    "SELECT text, note, marker, completed, starred
                     FROM notes_nodes WHERE id = 'root'",
                    [],
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
                .expect("root row");
        assert_eq!(text, "Home");
        assert_eq!(note, "");
        assert_eq!(marker, "bullet");
        assert_eq!(completed, 0);
        assert_eq!(starred, 0);
        assert_eq!(
            rows(&connection),
            vec![Row {
                id: ROOT_ID.into(),
                parent_id: None,
                kind: "page".into(),
                sort_key: 0,
                collapsed: 0,
                deleted: 0,
            }]
        );
    }

    #[test]
    fn adopts_legacy_pages_as_collapsed_root_children_including_the_trashed_one() {
        let mut connection = open();
        insert_page(&connection, "page-a", 1024, 0);
        insert_page(&connection, "page-b", 2048, 0);
        insert_page(&connection, "page-trashed", 3072, 1);

        ensure_root(&mut connection).expect("ensure root");

        let adopted = |id: &str, sort_key: i64, deleted: i64| Row {
            id: id.into(),
            parent_id: Some(ROOT_ID.into()),
            kind: "bullet".into(),
            sort_key,
            collapsed: 1,
            deleted,
        };
        assert_eq!(
            rows(&connection),
            vec![
                Row {
                    id: ROOT_ID.into(),
                    parent_id: None,
                    kind: "page".into(),
                    sort_key: 0,
                    collapsed: 0,
                    deleted: 0,
                },
                adopted("page-a", 1024, 0),
                adopted("page-b", 2048, 0),
                adopted("page-trashed", 3072, 1),
            ]
        );
    }

    #[test]
    fn running_twice_changes_nothing_the_second_time() {
        let mut connection = open();
        insert_page(&connection, "page-a", 1024, 0);
        insert_page(&connection, "page-b", 2048, 0);

        ensure_root(&mut connection).expect("ensure root");
        let after_first = rows(&connection);
        ensure_root(&mut connection).expect("ensure root again");

        assert_eq!(rows(&connection), after_first);
    }

    #[test]
    fn refuses_to_adopt_when_the_root_id_is_taken_by_a_bullet() {
        let mut connection = open();
        insert_page(&connection, "page-a", 1024, 0);
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text)
                 VALUES ('root', 'page-a', 1024, 'bullet', 'not the root')",
                [],
            )
            .expect("impostor");

        let error = ensure_root(&mut connection).expect_err("kind mismatch");
        assert!(
            format!("{error:?}").contains("root"),
            "unexpected error: {error:?}"
        );
    }
}
