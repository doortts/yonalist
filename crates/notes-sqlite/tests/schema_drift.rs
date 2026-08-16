//! Opening a database an older build made.
//!
//! Development has no migrations and keeps no old databases: the schema is
//! edited in place and the database is made again. The failure that leaves
//! behind is what this file is about — an older file opens without complaint,
//! because the version is the same and every `CREATE TABLE` is skipped, and
//! the app only falls over when somebody types.

use notes_sqlite::SqliteStorage;

/// The shape a build from before the place claims left behind: the same
/// version, the same table names, two columns short.
fn older_database(path: &std::path::Path) {
    let connection = rusqlite::Connection::open(path).expect("open");
    let older = notes_sqlite::SCHEMA_SQL
        .replace("    sync_prev TEXT NOT NULL DEFAULT '',\n", "")
        .replace("    sync_prev_hlc TEXT NOT NULL DEFAULT '',\n", "");
    assert_ne!(
        older,
        notes_sqlite::SCHEMA_SQL,
        "the columns are named here"
    );
    connection.execute_batch(&older).expect("older schema");
}

/// A development build makes it again itself rather than asking anyone to
/// press reset. The notes are in the vault; what the database holds it holds
/// again the moment the folder is read.
#[test]
#[cfg(debug_assertions)]
fn a_database_from_an_older_build_is_made_again() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("notes-v2.sqlite");
    older_database(&path);

    let storage = SqliteStorage::open(&path).expect("it makes the database again");

    drop(storage);
    let connection = rusqlite::Connection::open(&path).expect("open");
    let has_the_column: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('notes_nodes') WHERE name = 'sync_prev'",
            [],
            |row| row.get(0),
        )
        .expect("columns");
    assert_eq!(
        has_the_column, 1,
        "the file this build opened has to be the shape this build knows"
    );
}

#[test]
fn a_database_this_build_made_opens() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("notes-v2.sqlite");

    drop(SqliteStorage::open(&path).expect("make it"));

    SqliteStorage::open(&path).expect("open it again");
}
