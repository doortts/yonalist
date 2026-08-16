use notes_application::StorageError;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

pub(crate) const SCHEMA_VERSION: i64 = 1;
pub(crate) const ROOT_ID: &str = "root";

/// `MIGRATIONS[i]` carries a database from version `i + 1` to `i + 2`, so the
/// list length pins `SCHEMA_VERSION` and adding a step means bumping it.
///
/// Empty while the format is still moving: a schema change edits `create_schema`
/// in place and development databases get regenerated. The ladder stays because
/// the first release needs it; nothing rides it until then.
/// A step that touches `notes_nodes` will need the HLC function registered
/// first: the ladder runs inside `initialize`, before the worker builds the
/// clock, so today a stamping trigger would fire with no `yona_hlc()` to call.
type Migration = fn(&Transaction<'_>) -> Result<(), StorageError>;
/// The one copy of the DDL. notes-sync's merge tests read the same file
/// through `include_str!` — they need the real schema, and the architecture
/// check forbids them depending on this crate, so a second copy would drift.
pub const SCHEMA_SQL: &str = include_str!("schema.sql");

const MIGRATIONS: &[Migration] = &[];
const _: () = assert!(MIGRATIONS.len() as i64 + 1 == SCHEMA_VERSION);

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
    // gets a new path. A row that has no path at all cannot be ordered, so it
    // gets one here too — that is the only repair left now that the ladder is
    // empty. Nothing moved and nothing missing means nothing to rewrite, which
    // is what keeps a normal open from touching every row.
    let unpathed: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE path IS NULL)",
            [],
            |row| row.get(0),
        )
        .map_err(internal)?;
    if rewritten || adopted > 0 || unpathed {
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
    migrate(connection, version, MIGRATIONS)?;
    matches_shipped_schema(connection)
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
    connection.execute_batch(SCHEMA_SQL).map_err(internal)
}

/// Development has no migrations and keeps no old databases: the schema is
/// edited in place and the database is made again. So a development build
/// makes it again itself, rather than asking someone to press reset — the
/// notes live in the vault, and what the database holds it holds again the
/// moment the folder is read.
///
/// A release build does no such thing. There the database is what somebody
/// has, and throwing it away on a shape this build does not recognise is not
/// a decision to make on their behalf: `initialize` refuses instead, and the
/// message tells them what to do.
#[cfg(debug_assertions)]
pub(crate) fn remake_if_an_older_build_made_it(path: &std::path::Path) {
    let Ok(connection) = Connection::open(path) else {
        return;
    };
    if matches_shipped_schema(&connection).is_ok() {
        return;
    }
    drop(connection);
    eprintln!(
        "This database was made by an older build; making it again. \
         Development does not migrate — the notes are in the vault."
    );
    for suffix in ["", "-wal", "-shm"] {
        let mut beside = path.as_os_str().to_owned();
        beside.push(suffix);
        let _ = std::fs::remove_file(std::path::PathBuf::from(beside));
    }
}

#[cfg(not(debug_assertions))]
pub(crate) fn remake_if_an_older_build_made_it(_path: &std::path::Path) {}

/// Refuses a database whose shape is not the one this build was written
/// against.
///
/// Development does not migrate: the schema is edited in place and the
/// development database is made again. That rule works — until an older file
/// is opened by a newer build. The version says 1 and always will, every
/// `CREATE TABLE` is skipped because the table is there, and the app comes up
/// looking perfectly well. The first edit then dies on a column the file has
/// never had, and the message names the column rather than the cause.
///
/// So the shapes are compared at open, and the answer is given before anything
/// is typed. What the user does about it — a reset from the settings screen —
/// is a sentence they can act on, which "no such column: sync_prev" is not.
fn matches_shipped_schema(connection: &Connection) -> Result<(), StorageError> {
    let shipped = Connection::open_in_memory().map_err(internal)?;
    shipped.execute_batch(SCHEMA_SQL).map_err(internal)?;
    let expected = shape(&shipped)?;
    let found = shape(connection)?;
    if let Some(difference) = expected
        .iter()
        .zip(found.iter())
        .find(|(expected, found)| expected != found)
        .map(|(expected, _)| expected.0.clone())
        .or_else(|| {
            expected
                .len()
                .ne(&found.len())
                .then(|| {
                    expected
                        .iter()
                        .find(|(name, _)| !found.iter().any(|(found, _)| found == name))
                        .map(|(name, _)| name.clone())
                })
                .flatten()
        })
    {
        return Err(StorageError::Internal(format!(
            "This Notes database was made by an older build and cannot be used by \
             this one — `{difference}` is not what this build expects. There is no \
             upgrade for it yet: reset the Notes data from the settings screen, \
             which makes the database again."
        )));
    }
    Ok(())
}

/// Every table, index, trigger and view the database holds, by name and by the
/// statement that made it. Two databases with the same list are the same shape.
fn shape(connection: &Connection) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = connection
        .prepare(
            "SELECT name, sql FROM sqlite_master
             WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .map_err(internal)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                // Whitespace is the formatter's, not the schema's.
                row.get::<_, String>(1)?
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" "),
            ))
        })
        .map_err(internal)?;
    let mut shape = Vec::new();
    for row in rows {
        shape.push(row.map_err(internal)?);
    }
    Ok(shape)
}

fn internal(error: rusqlite::Error) -> StorageError {
    StorageError::Internal(error.to_string())
}

#[cfg(test)]
mod tests {
    /// A release build does not throw a database away: it is what somebody
    /// has, and a shape this build does not recognise is not a reason to
    /// decide that for them. The message is what they act on.
    #[test]
    fn a_database_from_an_older_build_is_refused_with_something_to_do() {
        let older = SCHEMA_SQL.replace("    sync_prev TEXT NOT NULL DEFAULT '',\n", "");
        assert_ne!(older, SCHEMA_SQL, "the column is named here");
        let connection = Connection::open_in_memory().expect("in-memory db");
        connection.execute_batch(&older).expect("older schema");

        let refused = matches_shipped_schema(&connection);

        let message = match refused {
            Ok(()) => panic!("it passed, and the first edit is where the user finds out"),
            Err(error) => error.to_string(),
        };
        assert!(
            message.contains("older build") && message.contains("reset"),
            "the message has to say what happened and what to do: {message}"
        );
    }

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
        // The stamping triggers call `yona_hlc()`, which is registered per
        // connection; a writer without one cannot insert a row.
        let clock = std::sync::Arc::new(notes_sync::hlc::Clock::new("c0de").expect("clock"));
        notes_sync::hlc::register(&connection, clock).expect("register");
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
        statement
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<Vec<String>, _>>()
            .expect("marks")
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
        statement
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
            .expect("rows")
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
            message.contains("unsupported Notes schema version 2")
                && message.contains("expected 1"),
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
                && message.contains("expected 1"),
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
