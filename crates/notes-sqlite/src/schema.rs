use notes_application::StorageError;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

pub(crate) const SCHEMA_VERSION: i64 = 2;
pub(crate) const ROOT_ID: &str = "root";

/// `MIGRATIONS[i]` carries a database from version `i + 1` to `i + 2`, so the
/// list length pins `SCHEMA_VERSION` and adding a step means bumping it.
type Migration = fn(&Transaction<'_>) -> Result<(), StorageError>;
const MIGRATIONS: &[Migration] = &[add_node_paths];
const _: () = assert!(MIGRATIONS.len() as i64 + 1 == SCHEMA_VERSION);

/// The DDL here and the mirror inside `create_schema` have to stay one shape:
/// a migrated database and a fresh one order the same outline off this column.
fn add_node_paths(transaction: &Transaction<'_>) -> Result<(), StorageError> {
    transaction
        .execute_batch(
            "ALTER TABLE notes_nodes ADD COLUMN path TEXT;
             CREATE INDEX notes_nodes_path ON notes_nodes(path);",
        )
        .map_err(internal)?;
    crate::node_paths::rebuild_all(transaction)
}

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
    let mut rewritten = false;
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
            rewritten = true;
        }
    }
    // Legacy pages become collapsed root children; the deferred self-FK lets
    // this follow the insert above inside one transaction.
    let adopted = transaction
        .execute(
            "UPDATE notes_nodes
             SET parent_id = ?1, kind = 'bullet', collapsed = 1
             WHERE parent_id IS NULL AND id <> ?1",
            [ROOT_ID],
        )
        .map_err(internal)?;
    // An adopted page hangs one level deeper than it did, so its whole branch
    // gets a new path. Nothing moved means nothing to rewrite, which is what
    // keeps a normal open from touching every row.
    if rewritten || adopted > 0 {
        crate::node_paths::rebuild_all(&transaction)?;
    }
    transaction.commit().map_err(internal)
}

pub(crate) fn initialize(connection: &mut Connection) -> Result<(), StorageError> {
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
        return create_schema(connection);
    }
    // Stays as wide as `!=` was: a negative user_version, which SQLite accepts,
    // would otherwise wrap the ladder's start index and open unmigrated.
    if version < 1 || version > SCHEMA_VERSION {
        return Err(StorageError::Internal(format!(
            "unsupported Notes schema version {version}; expected {SCHEMA_VERSION}"
        )));
    }
    migrate(connection, version, MIGRATIONS)
}

fn migrate(
    connection: &mut Connection,
    version: i64,
    steps: &[Migration],
) -> Result<(), StorageError> {
    for (index, step) in steps.iter().enumerate().skip(version as usize - 1) {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal)?;
        step(&transaction)?;
        // Inside the step's own transaction: a version that outlives a rolled
        // back step would skip that step forever.
        transaction
            .pragma_update(None, "user_version", index as i64 + 2)
            .map_err(internal)?;
        transaction.commit().map_err(internal)?;
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
                    CHECK (marker IN ('bullet', 'todo', 'ordered')),
                -- Only an `ordered` row reads this; every other marker leaves
                -- it at the default rather than carrying a number nobody draws.
                ordered_start INTEGER NOT NULL DEFAULT 1,
                collapsed INTEGER NOT NULL DEFAULT 0
                    CHECK (collapsed IN (0, 1)),
                completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
                starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1)),
                deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
                path TEXT,
                FOREIGN KEY(parent_id) REFERENCES notes_nodes(id)
                    DEFERRABLE INITIALLY DEFERRED,
                CHECK (
                    (kind = 'page' AND parent_id IS NULL) OR
                    (kind IN ('bullet', 'image') AND parent_id IS NOT NULL)
                )
            ) STRICT;
            CREATE INDEX notes_nodes_parent_order
                ON notes_nodes(parent_id, deleted, sort_key, id);
            CREATE INDEX notes_nodes_path ON notes_nodes(path);

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
                image.display_width,
                -- Last, so the image columns above keep the positions the row
                -- mapping reads them at.
                node.ordered_start
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

            PRAGMA user_version = 2;
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
        let mut connection = Connection::open_in_memory().expect("in-memory db");
        initialize(&mut connection).expect("schema");
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

    fn data_version(connection: &Connection) -> i64 {
        connection
            .pragma_query_value(None, "data_version", |row| row.get(0))
            .expect("data_version")
    }

    fn user_version(connection: &Connection) -> i64 {
        connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("user_version")
    }

    fn opened_at(version: i64) -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db");
        connection
            .pragma_update(None, "user_version", version)
            .expect("version");
        connection
    }

    fn ladder(version: i64) -> Connection {
        let connection = opened_at(version);
        connection
            .execute_batch("CREATE TABLE marks(step TEXT NOT NULL)")
            .expect("marks");
        connection
    }

    fn marks(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT step FROM marks ORDER BY rowid")
            .expect("prepare");
        let marks = statement
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<Vec<String>, _>>()
            .expect("marks");
        marks
    }

    fn mark(transaction: &Transaction<'_>, step: &str) -> Result<(), StorageError> {
        transaction
            .execute("INSERT INTO marks(step) VALUES (?1)", [step])
            .map_err(internal)?;
        Ok(())
    }

    fn first(transaction: &Transaction<'_>) -> Result<(), StorageError> {
        mark(transaction, "first")
    }

    fn second(transaction: &Transaction<'_>) -> Result<(), StorageError> {
        mark(transaction, "second")
    }

    fn marks_then_fails(transaction: &Transaction<'_>) -> Result<(), StorageError> {
        mark(transaction, "half applied")?;
        Err(StorageError::Internal("step gave up".into()))
    }

    fn marks_then_blocks_the_bump(transaction: &Transaction<'_>) -> Result<(), StorageError> {
        mark(transaction, "half applied")?;
        // query_only fails the version bump while still letting COMMIT through,
        // which is the only window a bump outside the transaction would leak.
        transaction
            .pragma_update(None, "query_only", true)
            .map_err(internal)
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
    fn an_empty_database_gets_the_schema_and_the_current_version() {
        let connection = open();

        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        let revision: i64 = connection
            .query_row("SELECT revision FROM notes_meta", [], |row| row.get(0))
            .expect("meta row");
        assert_eq!(revision, 0);
    }

    #[test]
    fn opening_a_current_database_writes_nothing() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("notes.db");
        let mut connection = Connection::open(&path).expect("database");
        initialize(&mut connection).expect("schema");
        // data_version moves for a header-only write, which total_changes cannot see.
        let observer = Connection::open(&path).expect("observer");
        let before = (connection.total_changes(), data_version(&observer));

        initialize(&mut connection).expect("reopen");

        assert_eq!(
            (connection.total_changes(), data_version(&observer)),
            before
        );
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
    }

    #[test]
    fn refuses_a_database_from_a_newer_build() {
        let mut connection = opened_at(SCHEMA_VERSION + 1);

        let error = initialize(&mut connection).expect_err("unsupported");

        let message = error.to_string();
        assert!(
            message.contains("unsupported Notes schema version 3")
                && message.contains("expected 2"),
            "unexpected error: {message}"
        );
    }

    #[test]
    fn refuses_a_negative_user_version() {
        let mut connection = opened_at(-1);

        let error = initialize(&mut connection).expect_err("unsupported");

        let message = error.to_string();
        assert!(
            message.contains("unsupported Notes schema version -1")
                && message.contains("expected 2"),
            "unexpected error: {message}"
        );
    }

    #[test]
    fn runs_every_step_the_database_is_behind_on() {
        let mut connection = ladder(1);

        migrate(&mut connection, 1, &[first, second]).expect("migrate");

        assert_eq!(marks(&connection), ["first", "second"]);
        assert_eq!(user_version(&connection), 3);
    }

    #[test]
    fn skips_the_steps_already_applied() {
        let mut connection = ladder(2);

        migrate(&mut connection, 2, &[first, second]).expect("migrate");

        assert_eq!(marks(&connection), ["second"]);
        assert_eq!(user_version(&connection), 3);
    }

    #[test]
    fn a_failing_step_leaves_the_database_untouched() {
        let mut connection = ladder(1);

        let error = migrate(&mut connection, 1, &[marks_then_fails, second]).expect_err("step");

        assert!(error.to_string().contains("step gave up"), "{error}");
        assert!(
            marks(&connection).is_empty(),
            "rolled back step left {:?}",
            marks(&connection)
        );
        assert_eq!(user_version(&connection), 1);
    }

    #[test]
    fn a_step_whose_version_bump_fails_leaves_the_database_untouched() {
        let mut connection = ladder(1);

        migrate(&mut connection, 1, &[marks_then_blocks_the_bump]).expect_err("bump");

        assert!(
            marks(&connection).is_empty(),
            "step committed outside its version bump, leaving {:?}",
            marks(&connection)
        );
        assert_eq!(user_version(&connection), 1);
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
