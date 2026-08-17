//! The schema window: every existing mutation path has to stamp an HLC and mark
//! the row dirty without a line of mutation code changing.

use notes_application::{CommandEnvelope, IpcNotesCommand, NotesService, StoragePort};
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

/// A device that has been through first run with a folder of its own. The
/// guide is written once that folder is settled rather than when the database
/// is opened, so a test that wants it has to say so.
fn open(database: &std::path::Path) -> SqliteStorage {
    let storage = SqliteStorage::open(database).expect("open");
    storage.seed_onboarding().expect("the guide");
    storage
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
    let storage = open(&database);
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

/// A file states its children's lines, so a child arriving, leaving or moving
/// is a change to the file that held it. Only the row itself was ever marked,
/// which left the holding document's file stating something that is no longer
/// true.
#[test]
fn a_document_is_queued_by_what_happens_to_the_rows_it_holds() {
    let (_directory, database) = workspace();
    let _storage = open(&database);
    let page = seeded_page(&database);
    let connection = writer(&database);
    let child = "Nd00000000aa";
    connection
        .execute("DELETE FROM sync_dirty_nodes", [])
        .expect("clear");

    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, ?2, 4294967296, 'bullet', 'Added', '')",
            rusqlite::params![child, &page],
        )
        .expect("insert");

    assert!(
        waiting(&connection, &page),
        "the page's file has to state the line that just appeared in it"
    );

    // Undo taking the create back, with the row's own mark still in the queue
    // from the create — which is how the orphan gets there.
    connection
        .execute("DELETE FROM notes_nodes WHERE id = ?1", [child])
        .expect("delete");

    assert!(
        waiting(&connection, &page),
        "and the line that just left it"
    );
    assert!(
        !waiting(&connection, child),
        "a row that is gone owes no file anything, and a mark nothing can \
         resolve keeps the queue from ever emptying"
    );
}

/// Both files, because both of them state something that is no longer true:
/// the one it left still carries the line, and the one it arrived in does not
/// carry it yet.
#[test]
fn moving_a_line_between_pages_queues_both_of_them() {
    let (_directory, database) = workspace();
    let _storage = open(&database);
    let first = seeded_page(&database);
    let connection = writer(&database);
    let second = "PrJects000bb";
    let child = "Nd00000000cc";
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, 'root', 8589934592, 'bullet', 'Second', ''),
                    (?2, ?3, 4294967296, 'bullet', 'Moves', '')",
            rusqlite::params![second, child, &first],
        )
        .expect("seed");
    connection
        .execute("DELETE FROM sync_dirty_nodes", [])
        .expect("clear");

    connection
        .execute(
            "UPDATE notes_nodes SET parent_id = ?1 WHERE id = ?2",
            rusqlite::params![second, child],
        )
        .expect("move");

    assert!(
        waiting(&connection, &first),
        "the page it left still states a line that is not there any more"
    );
    assert!(
        waiting(&connection, second),
        "and the page it arrived in does not state it yet"
    );
}

/// The guard on the parent marks: a mark naming a row that is not there can
/// never be resolved to a document, and a queue that cannot empty blocks the
/// reindex for good. Foreign keys are off here because the rule under test is
/// the trigger's own — it must not depend on something else having already
/// made the case impossible.
#[test]
fn a_parent_that_is_not_there_is_not_queued() {
    let (_directory, database) = workspace();
    let _storage = open(&database);
    let page = seeded_page(&database);
    let connection = writer(&database);
    connection
        .execute_batch("PRAGMA foreign_keys = OFF")
        .expect("pragma");
    connection
        .execute("DELETE FROM sync_dirty_nodes", [])
        .expect("clear");

    connection
        .execute(
            "UPDATE notes_nodes SET parent_id = 'ghost' WHERE id = ?1",
            [&page],
        )
        .expect("move");

    let unresolvable: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_dirty_nodes d
             WHERE NOT EXISTS (SELECT 1 FROM notes_nodes n WHERE n.id = d.node_id)",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(
        unresolvable, 0,
        "nothing can work out which file owes a write for a row that is not there"
    );
}

/// A node moved to the front of another page follows nobody in both places, so
/// what it claims does not change — but *when* it claims it has to. The reading
/// on the claim is what decides whose move wins, and a move that keeps an old
/// one loses to a reorder somebody made before it.
#[test]
fn a_move_that_changes_no_neighbour_still_says_when_it_moved() {
    let (_directory, database) = workspace();
    let storage = open(&database);
    let first = seeded_page(&database);
    let connection = writer(&database);
    let second = "PrJects000dd";
    let moving = "Nd00000000ee";
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, 'root', 8589934592, 'bullet', 'Second', ''),
                    (?2, ?3, 1, 'bullet', 'Moves', '')",
            rusqlite::params![second, moving, &first],
        )
        .expect("seed");
    let before: String = connection
        .query_row(
            "SELECT sync_prev_hlc FROM notes_nodes WHERE id = ?1",
            [moving],
            |row| row.get(0),
        )
        .expect("claim");

    let command = notes_core::NotesCommand::MoveNode {
        id: notes_core::NodeId::try_from(moving.to_owned()).expect("id"),
        parent_id: notes_core::NodeId::try_from(second.to_owned()).expect("id"),
        position: notes_core::Position::at_end(),
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command).expect("plan");
    storage
        .commit(storage.revision().expect("revision"), &patch)
        .expect("move");

    let (prev, at): (String, String) = connection
        .query_row(
            "SELECT sync_prev, sync_prev_hlc FROM notes_nodes WHERE id = ?1",
            [moving],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("claim");
    assert_eq!(
        prev, "",
        "it is first in its new page, as it was in the old one"
    );
    assert_ne!(
        at, before,
        "the claim has to carry this move's reading, or somebody else's older \
         reorder beats it and the node lands back where it was"
    );
}

/// Making room for a new line renumbers the lines around it. None of them
/// moved — each still follows whoever it followed — so none of their claims
/// may take on the new reading, or somebody else's real move loses to a
/// neighbour that only had its number changed.
#[test]
fn making_room_for_a_line_does_not_promote_its_neighbours_claims() {
    let (_directory, database) = workspace();
    let storage = open(&database);
    let page = seeded_page(&database);
    let connection = writer(&database);
    // Packed tight, which is what a run of inserts in one spot leaves.
    let ids: Vec<String> = (0..3)
        .map(|index| format!("Nd000000ee{index:02}"))
        .collect();
    for (index, id) in ids.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
                 VALUES (?1, ?2, ?3, 'bullet', 'Line', '')",
                rusqlite::params![id, &page, (index as i64) + 1],
            )
            .expect("line");
    }
    connection
        .execute(
            "UPDATE notes_nodes SET sync_prev = ?2, sync_prev_hlc = '000000001-00-aaaa'
             WHERE id = ?1",
            rusqlite::params![&ids[2], &ids[1]],
        )
        .expect("an older claim");

    let command = notes_core::NotesCommand::CreateNode {
        id: notes_core::NodeId::try_from("Nd000000eeff".to_owned()).expect("id"),
        parent_id: notes_core::NodeId::try_from(page.clone()).expect("id"),
        position: notes_core::Position::Before {
            sibling_id: notes_core::NodeId::try_from(ids[1].clone()).expect("id"),
        },
        text: "Squeezed in".to_owned(),
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command).expect("plan");
    storage
        .commit(storage.revision().expect("revision"), &patch)
        .expect("insert");

    let bystander: String = connection
        .query_row(
            "SELECT sync_prev_hlc FROM notes_nodes WHERE id = ?1",
            [&ids[2]],
            |row| row.get(0),
        )
        .expect("claim");
    assert_eq!(
        bystander, "000000001-00-aaaa",
        "this line follows who it always followed; only its number changed"
    );
}

/// Where a node sits is written in the file next to it, so a claim changing is
/// a change to the file — but not to the node, which is why the stamping
/// trigger deliberately ignores these columns.
#[test]
fn a_place_claim_queues_the_document_without_restamping_the_row() {
    let (_directory, database) = workspace();
    let _storage = open(&database);
    let page = seeded_page(&database);
    let connection = writer(&database);
    let before: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("hlc");
    connection
        .execute("DELETE FROM sync_dirty_nodes", [])
        .expect("clear");

    connection
        .execute(
            "UPDATE notes_nodes SET sync_prev = 'somebody-else' WHERE id = ?1",
            [&page],
        )
        .expect("claim");

    assert!(
        waiting(&connection, &page),
        "a claim nothing writes out is a claim the other devices never see"
    );
    let after: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("hlc");
    assert_eq!(
        after, before,
        "moving a line is not editing it — a restamp here would have the move \
         beat somebody else's edit"
    );
}

fn waiting(connection: &Connection, node_id: &str) -> bool {
    connection
        .query_row(
            "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
            [node_id],
            |row| row.get::<_, i64>(0),
        )
        .expect("dirty")
        > 0
}

/// The rule has to sit in the trigger, not in whoever writes. The merge writes
/// every row it looked at, most of them with the values they already had, and a
/// restamp there hands this device a reading it did not earn — one that then
/// beats every other device's real edit.
#[test]
fn a_row_written_with_the_values_it_already_had_is_not_restamped() {
    let (_directory, database) = workspace();
    let _storage = open(&database);
    let page = seeded_page(&database);
    let connection = writer(&database);
    let before: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("hlc");
    connection
        .execute("DELETE FROM sync_dirty_nodes", [])
        .expect("clear");

    connection
        .execute(
            "UPDATE notes_nodes SET text = text, sort_key = sort_key, \
             collapsed = collapsed WHERE id = ?1",
            [&page],
        )
        .expect("write");

    let after: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("hlc");
    assert_eq!(after, before, "nothing changed, so nothing is newer");
    let dirty: i64 = connection
        .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
            row.get(0)
        })
        .expect("dirty");
    assert_eq!(dirty, 0, "and there is nothing to write out");
}

/// Typing a word and taking it back again leaves the row exactly as it was.
/// Without this the reading advances anyway, and that later reading beats a
/// real edit another device made in the meantime — a note lost to a keystroke
/// that changed nothing.
#[test]
fn a_write_that_changes_nothing_does_not_move_the_reading() {
    let (_directory, database) = workspace();
    let storage = open(&database);
    let page = seeded_page(&database);
    let title: String = inspect(&database)
        .query_row(
            "SELECT text FROM notes_nodes WHERE id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("title");
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
            text: title,
        },
        inspect(&database)
            .query_row("SELECT revision FROM notes_meta", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("revision") as u64,
    );

    let connection = inspect(&database);
    let after: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("hlc");
    assert_eq!(after, before, "nothing changed, so nothing is newer");
    let dirty: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
            [&page],
            |row| row.get(0),
        )
        .expect("dirty");
    assert_eq!(
        dirty, 0,
        "a file rewritten with the bytes it already had is an edit to every \
         other device"
    );
}

#[test]
fn moving_a_parent_leaves_its_descendants_unstamped() {
    let (_directory, database) = workspace();
    let storage = open(&database);
    let page = seeded_page(&database);
    let mut revision: u64 = inspect(&database)
        .query_row("SELECT revision FROM notes_meta", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("revision") as u64;
    for (id, parent) in [
        ("branch", page.as_str()),
        ("leaf", "branch"),
        ("elsewhere", "root"),
    ] {
        revision = run(
            &storage,
            IpcNotesCommand::CreateNode {
                id: id.into(),
                parent_id: parent.into(),
                before_id: None,
                text: id.into(),
            },
            revision,
        );
    }
    let before: String = inspect(&database)
        .query_row("SELECT hlc FROM notes_nodes WHERE id = 'leaf'", [], |row| {
            row.get(0)
        })
        .expect("hlc");
    inspect(&database)
        .execute("DELETE FROM sync_dirty_nodes", [])
        .expect("clear");

    // The move rewrites the stored path of everything under `branch`. Those
    // rows did not change, so nothing about them may look newer.
    run(
        &storage,
        IpcNotesCommand::MoveNode {
            id: "branch".into(),
            parent_id: "elsewhere".into(),
            before_id: None,
        },
        revision,
    );

    let connection = inspect(&database);
    let path: String = connection
        .query_row(
            "SELECT path FROM notes_nodes WHERE id = 'leaf'",
            [],
            |row| row.get(0),
        )
        .expect("path");
    assert!(
        path.contains("elsewhere"),
        "the move has to have rewritten the descendant's path, or this proves nothing"
    );
    let after: String = connection
        .query_row("SELECT hlc FROM notes_nodes WHERE id = 'leaf'", [], |row| {
            row.get(0)
        })
        .expect("hlc");
    assert_eq!(
        after, before,
        "a row whose content did not change must not get a newer reading, \
         or a move on this device beats a real edit on another one"
    );
    let dirty: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = 'leaf'",
            [],
            |row| row.get(0),
        )
        .expect("dirty");
    assert_eq!(dirty, 0, "and it does not need re-exporting either");
}

#[test]
fn user_version_stays_one() {
    let (_directory, database) = workspace();
    drop(open(&database));

    let version: i64 = inspect(&database)
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("user_version");
    assert_eq!(version, 1);
}

#[test]
fn there_is_no_tombstone_table() {
    let (_directory, database) = workspace();
    drop(open(&database));

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
    drop(open(&database));
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
fn a_delete_queues_the_file_that_still_states_the_line() {
    let (_directory, database) = workspace();
    drop(open(&database));
    let connection = writer(&database);
    // A leaf, since a parent cannot leave before its children.
    let (leaf, holder): (String, String) = connection
        .query_row(
            "SELECT id, parent_id FROM notes_nodes
             WHERE id NOT IN (SELECT parent_id FROM notes_nodes WHERE parent_id IS NOT NULL)
             LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("leaf");
    connection
        .execute("DELETE FROM sync_dirty_nodes", [])
        .expect("clear");

    connection
        .execute("DELETE FROM notes_nodes WHERE id = ?1", [&leaf])
        .expect("delete");

    assert!(
        waiting(&connection, &holder),
        "the file it left still states the line it no longer holds"
    );
    assert!(
        !waiting(&connection, &leaf),
        "and nothing can work out which file owes a write for a row that is \
         gone, so that mark would sit in the queue for good"
    );
}

#[test]
fn an_hlc_stamp_does_not_touch_the_fts_index() {
    let (_directory, database) = workspace();
    drop(open(&database));
    let connection = writer(&database);
    // A cost contract, so what it measures is work done: the search index is
    // rebuilt by delete-then-insert, which leaves the same rows behind and can
    // only be seen in the row count the connection reports.
    connection
        .execute("UPDATE notes_nodes SET collapsed = 0 WHERE id = 'root'", [])
        .expect("settle");
    let before = connection.total_changes();

    // A content column the search index does not follow, so the stamping
    // trigger fires here and the FTS one must not.
    connection
        .execute("UPDATE notes_nodes SET collapsed = 1 WHERE id = 'root'", [])
        .expect("collapse");

    let changed = connection.total_changes() - before;
    assert_eq!(
        changed, 3,
        "the row, its stamp and its dirty mark — the search index follows text \
         and note, and a stamp on anything else must not rewrite it"
    );
}

#[test]
fn sync_meta_is_seeded_once_with_a_stable_device_id() {
    let (_directory, database) = workspace();
    drop(open(&database));
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
    drop(open(&database));
    let page = seeded_page(&database);
    // A reading well ahead of anything this run would issue, but inside the
    // drift the guard allows.
    let ahead = {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("epoch")
            .as_millis() as u64
            // Well clear of anything this run issues, and well inside the 24h
            // the drift guard allows, so a slow machine cannot false-pass it.
            + 12 * 60 * 60 * 1_000;
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
