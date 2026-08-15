//! The schema window: every existing mutation path has to stamp an HLC and mark
//! the row dirty without a line of mutation code changing.

use notes_application::{CommandEnvelope, IpcNotesCommand, NotesService};
use notes_sqlite::SqliteStorage;
use rusqlite::Connection;

fn workspace() -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("notes-v2.sqlite");
    (directory, database)
}

fn inspect(database: &std::path::Path) -> Connection {
    Connection::open(database).expect("inspect")
}

/// A connection that may write. The stamping triggers call `yona_hlc()`, which
/// is registered per connection, so anything writing outside the worker has to
/// bring a clock of its own — which is what the merge will do in M3.
fn writer(database: &std::path::Path) -> Connection {
    let connection = inspect(database);
    let clock = std::sync::Arc::new(notes_sync::hlc::Clock::new("c0de").expect("clock"));
    notes_sync::hlc::register(&connection, clock).expect("register");
    connection
}

fn run(storage: &SqliteStorage, command: IpcNotesCommand, revision: u64) -> u64 {
    let service = NotesService::new(storage, "session", revision);
    service
        .execute(CommandEnvelope {
            session_id: "session".into(),
            request_id: format!("request-{revision}"),
            base_revision: revision,
            history_group: None,
            command,
        })
        .expect("command")
        .revision
}

fn seeded_page(database: &std::path::Path) -> String {
    inspect(database)
        .query_row(
            "SELECT id FROM notes_nodes WHERE parent_id = 'root'",
            [],
            |row| row.get(0),
        )
        .expect("seeded page")
}

#[test]
fn a_command_commit_stamps_hlc_and_marks_dirty() {
    let (_directory, database) = workspace();
    let storage = SqliteStorage::open(&database).expect("open");
    let page = seeded_page(&database);
    let before: String = inspect(&database)
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("hlc");
    inspect(&database)
        .execute("DELETE FROM sync_dirty_nodes", [])
        .expect("clear");

    run(
        &storage,
        IpcNotesCommand::UpdateText {
            id: page.clone(),
            text: "Renamed".into(),
        },
        inspect(&database)
            .query_row("SELECT revision FROM notes_meta", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("revision") as u64,
    );

    let connection = inspect(&database);
    let hlc: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("hlc");
    assert_eq!(hlc.len(), 17, "an unstamped row cannot be exported");
    assert!(
        hlc > before,
        "the edit has to carry a newer reading than the row already had, \
         got {hlc} against {before}"
    );
    let dirty: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("dirty");
    assert_eq!(dirty, 1, "the export has to be told which rows moved");
}

#[test]
fn user_version_stays_one() {
    let (_directory, database) = workspace();
    drop(SqliteStorage::open(&database).expect("open"));

    let version: i64 = inspect(&database)
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("user_version");
    assert_eq!(version, 1);
}

#[test]
fn there_is_no_tombstone_table() {
    let (_directory, database) = workspace();
    drop(SqliteStorage::open(&database).expect("open"));

    let tables: i64 = inspect(&database)
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'sync_purged_tombstones'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(tables, 0, "decision 7 removed purge from this format");
}

#[test]
fn an_explicit_hlc_survives_a_merge_style_upsert() {
    let (_directory, database) = workspace();
    drop(SqliteStorage::open(&database).expect("open"));
    let page = seeded_page(&database);
    let connection = writer(&database);

    // What a merge does: carry the reading the other device stamped.
    connection
        .execute(
            "UPDATE notes_nodes SET text = 'From elsewhere', hlc = ?2 WHERE id = ?1",
            rusqlite::params![page, "0swkd7qz5-00-b1c2"],
        )
        .expect("merge-style update");

    let hlc: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("hlc");
    assert_eq!(
        hlc, "0swkd7qz5-00-b1c2",
        "a reading that came from another device must not be restamped"
    );
}

#[test]
fn a_delete_marks_the_dirty_row() {
    let (_directory, database) = workspace();
    drop(SqliteStorage::open(&database).expect("open"));
    let connection = writer(&database);
    // A leaf, since a parent cannot leave before its children.
    let leaf: String = connection
        .query_row(
            "SELECT id FROM notes_nodes
             WHERE id NOT IN (SELECT parent_id FROM notes_nodes WHERE parent_id IS NOT NULL)
             LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("leaf");
    connection
        .execute("DELETE FROM sync_dirty_nodes", [])
        .expect("clear");

    connection
        .execute("DELETE FROM notes_nodes WHERE id = ?1", [&leaf])
        .expect("delete");

    let dirty: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
            [&leaf],
            |row| row.get(0),
        )
        .expect("dirty");
    assert_eq!(dirty, 1, "the export has to learn the row went away");
}

#[test]
fn an_hlc_stamp_does_not_touch_the_fts_index() {
    let (_directory, database) = workspace();
    drop(SqliteStorage::open(&database).expect("open"));
    let connection = writer(&database);
    let before: i64 = connection
        .query_row("SELECT COUNT(*) FROM notes_fts", [], |row| row.get(0))
        .expect("count");

    connection
        .execute("UPDATE notes_nodes SET hlc = '' WHERE id = 'root'", [])
        .expect("restamp");

    let after: i64 = connection
        .query_row("SELECT COUNT(*) FROM notes_fts", [], |row| row.get(0))
        .expect("count");
    assert_eq!(
        before, after,
        "the search index follows text and note, not the clock"
    );
}

#[test]
fn sync_meta_is_seeded_once_with_a_stable_device_id() {
    let (_directory, database) = workspace();
    drop(SqliteStorage::open(&database).expect("open"));
    let first: (String, String) = inspect(&database)
        .query_row("SELECT device_id, vault_uuid FROM sync_meta", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("sync_meta");

    drop(SqliteStorage::open(&database).expect("reopen"));

    let second: (String, String) = inspect(&database)
        .query_row("SELECT device_id, vault_uuid FROM sync_meta", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("sync_meta");
    assert_eq!(
        first, second,
        "a device that renames itself is a new device"
    );
    assert_eq!(first.0.len(), 4);
}

#[test]
fn the_clock_reseeds_from_stored_hlcs_on_boot() {
    let (_directory, database) = workspace();
    drop(SqliteStorage::open(&database).expect("open"));
    let page = seeded_page(&database);
    // A reading well ahead of anything this run would issue, but inside the
    // drift the guard allows.
    let ahead = {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("epoch")
            .as_millis() as u64
            + 60_000;
        notes_sync::hlc::Hlc::new(millis, 0, "b1c2")
            .expect("hlc")
            .encode()
    };
    writer(&database)
        .execute(
            "UPDATE notes_nodes SET hlc = ?2 WHERE id = ?1",
            rusqlite::params![page, ahead],
        )
        .expect("plant");

    let storage = SqliteStorage::open(&database).expect("reopen");
    let revision: u64 = inspect(&database)
        .query_row("SELECT revision FROM notes_meta", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("revision") as u64;
    run(
        &storage,
        IpcNotesCommand::UpdateText {
            id: page.clone(),
            text: "After the reseed".into(),
        },
        revision,
    );

    let stamped: String = inspect(&database)
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("hlc");
    assert!(
        stamped > ahead,
        "an edit after boot has to beat what the rows already carried, got {stamped} against {ahead}"
    );
}
