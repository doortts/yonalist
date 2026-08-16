//! Opening a database an older build made.
//!
//! Development does not migrate — the schema is edited in place and the
//! development database is made again. The failure that rule leaves behind is
//! the one this file is about: an older file opens without complaint, because
//! the version is the same and every `CREATE TABLE` is skipped, and the app
//! only falls over when somebody types.

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

#[test]
fn a_database_from_an_older_build_is_refused_at_the_door() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("notes-v2.sqlite");
    older_database(&path);

    let refused = SqliteStorage::open(&path);

    let message = match refused {
        Ok(_) => panic!("it opened, and the first edit is where the user finds out"),
        Err(error) => error.to_string(),
    };
    assert!(
        message.contains("older build") && message.contains("reset"),
        "the message has to say what happened and what to do: {message}"
    );
}

#[test]
fn a_database_this_build_made_opens() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("notes-v2.sqlite");

    drop(SqliteStorage::open(&path).expect("make it"));

    SqliteStorage::open(&path).expect("open it again");
}
