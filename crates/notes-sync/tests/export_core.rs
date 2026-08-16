//! Writing the rows back out as files.
//!
//! Two rules carry this. A document is written only if what was just rendered
//! reads back as the same document — a file nobody can parse is worse than one
//! that is a little out of date, because the merge would then quarantine it and
//! the notes would stop travelling. And a file that changed on disk since this
//! app last wrote it is never overwritten: that is somebody's edit, and it has
//! to be merged before anything replaces it.

use notes_sync::export::{ExportOutcome, export_document};
use notes_sync::hlc::{Clock, Hlc};
use rusqlite::Connection;

const DEVICE: &str = "cccc";
const PAGE_ID: &str = "4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1";
const NODE_ID: &str = "8a201f33-0000-4c91-8d02-000000000001";

fn database() -> Connection {
    let connection = Connection::open_in_memory().expect("open");
    connection
        .execute_batch(include_str!("../../notes-sqlite/src/schema.sql"))
        .expect("schema");
    connection
        .execute(
            "INSERT INTO sync_meta(singleton, device_id, vault_uuid) VALUES (1, ?1, ?2)",
            (DEVICE, "3f2a1c8e-0000-4c91-8d02-000000000000"),
        )
        .expect("sync meta");
    notes_sync::hlc::register(&connection, std::sync::Arc::new(clock())).expect("register");
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES ('root', NULL, 0, 'page', 'Home', ?1)",
            [stamp(1)],
        )
        .expect("root");
    connection
}

fn clock() -> Clock {
    Clock::new(DEVICE).expect("clock")
}

fn stamp(millis: u64) -> String {
    Hlc::new(millis, 0, "a3f2").expect("hlc").encode()
}

/// A page with one bullet under it, both stamped and both waiting to go out.
fn seed(connection: &Connection) {
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, 'root', 4294967296, 'bullet', 'Projects', ?3),
                    (?2, ?1, 4294967296, 'bullet', 'Thought', ?3)",
            rusqlite::params![PAGE_ID, NODE_ID, stamp(5)],
        )
        .expect("rows");
    connection
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, 0), (?2, 0)",
            rusqlite::params![PAGE_ID, NODE_ID],
        )
        .expect("dirty");
}

fn vault() -> tempfile::TempDir {
    tempfile::tempdir().expect("temporary directory")
}

fn export(connection: &mut Connection, root: &std::path::Path) -> ExportOutcome {
    let transaction = connection.transaction().expect("begin");
    let outcome = export_document(&transaction, root, PAGE_ID).expect("export");
    transaction.commit().expect("commit");
    outcome
}

fn written(root: &std::path::Path) -> Option<String> {
    let folder = std::fs::read_dir(root)
        .expect("read")
        .filter_map(|entry| entry.ok())
        .find(|entry| entry.path().is_dir())?;
    std::fs::read_to_string(folder.path().join("README.md")).ok()
}

#[test]
fn a_dirty_page_lands_in_the_vault_as_a_readme() {
    let mut connection = database();
    seed(&connection);
    let root = vault();

    let outcome = export(&mut connection, root.path());

    assert!(outcome.written);
    let file = written(root.path()).expect("the document");
    assert!(file.contains("# Projects"), "{file}");
    assert!(file.contains("- Thought <!-- yid:"), "{file}");
}

#[test]
fn an_export_clears_only_the_exported_dirty_rows() {
    let mut connection = database();
    seed(&connection);
    let elsewhere = "9d3f21b8-c440-4c91-8d02-2e77a05fb163";
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, 'root', 8589934592, 'bullet', 'Other page', ?2)",
            rusqlite::params![elsewhere, stamp(5)],
        )
        .expect("other");
    connection
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, 0)",
            [elsewhere],
        )
        .expect("dirty");
    let root = vault();

    export(&mut connection, root.path());

    let remaining: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT node_id FROM sync_dirty_nodes ORDER BY node_id")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query");
        rows.map(|row| row.expect("row")).collect()
    };
    assert_eq!(
        remaining,
        vec![elsewhere.to_owned()],
        "a document's export says nothing about anybody else's rows"
    );
}

/// Invariant 4. What was rendered has to read back as the same document, or the
/// bytes do not go out: a file the merge would quarantine stops the notes
/// travelling entirely, which is worse than a file that is briefly stale.
#[test]
fn self_validation_failure_leaves_the_file_untouched() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    export(&mut connection, root.path());
    let before = written(root.path()).expect("the document");

    // An image whose stored path points somewhere the format never writes. It
    // renders — the renderer states what the row says — and the parser refuses
    // the line, which is exactly the shape self-validation exists to catch.
    connection
        .execute(
            "UPDATE notes_nodes SET kind = 'image' WHERE id = ?1",
            [NODE_ID],
        )
        .expect("image");
    connection
        .execute(
            "INSERT INTO notes_images(
                 node_id, content_hash, relative_path, original_name, mime_type,
                 display_width, pixel_width, pixel_height, byte_length)
             VALUES (?1, '', 'elsewhere/shot-9f3a1c8e2044.png', 'shot.png', 'image/png',
                     320, 1280, 720, 421904)",
            [NODE_ID],
        )
        .expect("metadata");
    connection
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, 0)
             ON CONFLICT(node_id) DO NOTHING",
            [NODE_ID],
        )
        .expect("dirty");

    let mut transaction = connection.transaction().expect("begin");
    let refused = export_document(&mut transaction, root.path(), PAGE_ID);
    transaction.commit().expect("commit");

    assert!(
        refused.is_err(),
        "a document that cannot be read back is not written"
    );
    assert_eq!(
        written(root.path()).as_deref(),
        Some(before.as_str()),
        "and what was already on disk is left where it is"
    );
    let still_dirty: i64 = connection
        .query_row(
            "SELECT count(*) FROM sync_dirty_nodes WHERE node_id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("dirty");
    assert_eq!(still_dirty, 1, "the row still owes an export");
}

/// Spec §6. Somebody edited the file in another editor; overwriting it would
/// take their edit without a word. The merge has to see it first.
#[test]
fn an_export_refuses_to_overwrite_a_changed_file() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    export(&mut connection, root.path());
    let folder = std::fs::read_dir(root.path())
        .expect("read")
        .filter_map(|entry| entry.ok())
        .find(|entry| entry.path().is_dir())
        .expect("the folder")
        .path();
    std::fs::write(folder.join("README.md"), b"edited by hand\n").expect("hand edit");
    connection
        .execute(
            "UPDATE notes_nodes SET text = 'moved on' WHERE id = ?1",
            [NODE_ID],
        )
        .expect("edit");
    connection
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, 0)
             ON CONFLICT(node_id) DO NOTHING",
            [NODE_ID],
        )
        .expect("dirty");

    let mut transaction = connection.transaction().expect("begin");
    let outcome = export_document(&mut transaction, root.path(), PAGE_ID).expect("export");
    transaction.commit().expect("commit");

    assert!(
        !outcome.written,
        "somebody else's edit is not ours to replace"
    );
    assert!(
        outcome.needs_merge,
        "and it has to be merged before we write again"
    );
    assert_eq!(
        std::fs::read_to_string(folder.join("README.md")).expect("file"),
        "edited by hand\n"
    );
}

/// The recorded hash is what lets the watcher tell this app's own write from
/// somebody else's, so it has to be the hash of what actually went to disk.
#[test]
fn exported_hash_records_the_written_bytes() {
    let mut connection = database();
    seed(&connection);
    let root = vault();

    export(&mut connection, root.path());

    let recorded: String = connection
        .query_row(
            "SELECT exported_hash FROM sync_documents WHERE root_id = ?1",
            [PAGE_ID],
            |row| row.get(0),
        )
        .expect("document");
    let file = written(root.path()).expect("the document");
    assert_eq!(recorded, notes_sync::export::hash_bytes(file.as_bytes()));
}

#[test]
fn writing_the_same_document_twice_writes_nothing_the_second_time() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    export(&mut connection, root.path());
    connection
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, 0)",
            [PAGE_ID],
        )
        .expect("dirty again");

    let outcome = export(&mut connection, root.path());

    assert!(
        !outcome.written,
        "the same bytes going out again would look like an edit to every other device"
    );
}

fn export_trash(connection: &mut Connection, root: &std::path::Path) -> ExportOutcome {
    let transaction = connection.transaction().expect("begin");
    let outcome = notes_sync::export::export_trash(&transaction, root).expect("export");
    transaction.commit().expect("commit");
    outcome
}

fn trash_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join(".yonalist").join("trash.md")
}

/// The only evidence a deletion ever gets. Without it the other devices see a
/// node missing from a file, which says nothing at all.
#[test]
fn deleted_nodes_emit_into_trash_md() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    connection
        .execute(
            "UPDATE notes_nodes SET deleted = 1 WHERE id = ?1",
            [NODE_ID],
        )
        .expect("delete");

    let outcome = export_trash(&mut connection, root.path());

    assert!(outcome.written);
    let file = std::fs::read_to_string(trash_path(root.path())).expect("the trash");
    assert!(file.contains("kind: yonalist-trash"), "{file}");
    assert!(file.contains("Thought"), "{file}");
    assert!(
        file.contains(&format!("from: {PAGE_ID}@")),
        "a deleted node states where it was taken from, or nothing can put it back: {file}"
    );
}

/// A deleted row's mark is nobody else's to clear — its page skips it on
/// purpose, so that the deletion keeps its evidence until the trash states it.
/// If the trash does not clear it either, the queue never empties: every
/// export runs again forever and a reindex stays refused for good.
#[test]
fn stating_a_deletion_takes_it_off_the_queue() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    connection
        .execute(
            "UPDATE notes_nodes SET deleted = 1 WHERE id = ?1",
            [NODE_ID],
        )
        .expect("delete");

    export_trash(&mut connection, root.path());

    let still_waiting: i64 = connection
        .query_row(
            "SELECT count(*) FROM sync_dirty_nodes WHERE node_id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(
        still_waiting, 0,
        "the trash has stated this deletion, so nothing is still owed for it"
    );
}

/// No file at all rather than an empty one: absence is what "nothing was
/// deleted" looks like, and an empty document would have to be parsed to learn
/// the same thing.
#[test]
fn an_empty_trash_writes_no_file() {
    let mut connection = database();
    seed(&connection);
    let root = vault();

    let outcome = export_trash(&mut connection, root.path());

    assert!(!outcome.written);
    assert!(!trash_path(root.path()).exists());
}

#[test]
fn a_trash_that_empties_takes_its_file_with_it() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    connection
        .execute(
            "UPDATE notes_nodes SET deleted = 1 WHERE id = ?1",
            [NODE_ID],
        )
        .expect("delete");
    export_trash(&mut connection, root.path());
    assert!(trash_path(root.path()).exists());

    connection
        .execute(
            "UPDATE notes_nodes SET deleted = 0 WHERE id = ?1",
            [NODE_ID],
        )
        .expect("restore");
    export_trash(&mut connection, root.path());

    assert!(
        !trash_path(root.path()).exists(),
        "a file that still said something was deleted would keep deleting it"
    );
}

fn export_home(connection: &mut Connection, root: &std::path::Path) -> ExportOutcome {
    let transaction = connection.transaction().expect("begin");
    let outcome = notes_sync::export::export_home(&transaction, root).expect("export");
    transaction.commit().expect("commit");
    outcome
}

/// Home is an index, not a page: every top-level page is one link line, and the
/// order of those lines is the order of the pages. Their contents live in their
/// own folders.
#[test]
fn the_home_index_lists_every_page_as_a_split_line() {
    let mut connection = database();
    seed(&connection);
    let other = "11c8da70-b5e1-4c91-8d02-a3f204ee81cc";
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, 'root', 8589934592, 'bullet', 'Second', ?2)",
            rusqlite::params![other, stamp(5)],
        )
        .expect("second page");
    let root = vault();
    export(&mut connection, root.path());

    let outcome = export_home(&mut connection, root.path());

    assert!(outcome.written);
    let file = std::fs::read_to_string(root.path().join("README.md")).expect("home");
    assert!(file.contains("id: root"), "{file}");
    assert!(
        file.contains("- [Projects](Projects-4f1c8e20a3b7/README.md)"),
        "{file}"
    );
    assert!(
        file.contains("split -->"),
        "a page's own file owns its state: {file}"
    );
    assert!(
        !file.contains("Thought"),
        "the page's contents belong in the page's folder: {file}"
    );
    assert!(
        file.find("Projects").unwrap() < file.find("Second").unwrap(),
        "the order of the lines is the order of the pages"
    );
}

/// A page that is deleted, or stops being top-level, leaves a folder behind
/// that nothing points at. Vault folders are the user's to look at, so a folder
/// for a page that no longer exists is a lie about what they have.
#[test]
fn a_page_that_stops_being_a_page_loses_its_folder() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    export(&mut connection, root.path());
    let folder = root.path().join("Projects-4f1c8e20a3b7");
    assert!(folder.is_dir());

    connection
        .execute(
            "UPDATE notes_nodes SET deleted = 1 WHERE id = ?1",
            [PAGE_ID],
        )
        .expect("delete");
    let transaction = connection.transaction().expect("begin");
    notes_sync::export::retire_missing_documents(&transaction, root.path()).expect("retire");
    transaction.commit().expect("commit");

    assert!(
        !folder.exists(),
        "a folder for a page that is gone tells the user they still have it"
    );
    let recorded: i64 = connection
        .query_row(
            "SELECT count(*) FROM sync_documents WHERE root_id = ?1",
            [PAGE_ID],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(recorded, 0, "and the record of it goes too");
}

#[test]
fn a_live_page_keeps_its_folder() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    export(&mut connection, root.path());

    let transaction = connection.transaction().expect("begin");
    notes_sync::export::retire_missing_documents(&transaction, root.path()).expect("retire");
    transaction.commit().expect("commit");

    assert!(root.path().join("Projects-4f1c8e20a3b7").is_dir());
}

/// Which documents a set of dirty rows belongs to, in one question rather than
/// one per row. A vault where every edit costs a walk up the tree is a vault
/// that stops keeping up with typing.
#[test]
fn dirty_rows_resolve_to_the_documents_that_hold_them() {
    let mut connection = database();
    seed(&connection);
    let deep = "8a201f33-0000-4c91-8d02-000000000002";
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, ?2, 4294967296, 'bullet', 'Deeper', ?3)",
            rusqlite::params![deep, NODE_ID, stamp(5)],
        )
        .expect("deep");
    connection
        .execute("DELETE FROM sync_dirty_nodes", ())
        .expect("clear");
    connection
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, 0)",
            [deep],
        )
        .expect("dirty");

    let transaction = connection.transaction().expect("begin");
    let pending = notes_sync::export::pending_documents(&transaction).expect("pending");

    assert_eq!(
        pending,
        vec![PAGE_ID.to_owned()],
        "a node deep in a page belongs to that page's document"
    );
}

#[test]
fn a_dirty_page_root_resolves_to_its_own_document() {
    let mut connection = database();
    seed(&connection);

    let transaction = connection.transaction().expect("begin");
    let pending = notes_sync::export::pending_documents(&transaction).expect("pending");

    assert_eq!(pending, vec![PAGE_ID.to_owned()]);
}

/// The whole reason home is ever queued. A page nobody has opened yet is one
/// row under `root` and nothing else — if that does not put home in the queue,
/// the page never appears in the vault's own README and the user cannot reach
/// it from the folder they opened. The marking is the schema's, so the row
/// arrives the way a real one does: unstamped, for the trigger to stamp.
#[test]
fn a_new_page_puts_home_in_the_queue() {
    let mut connection = database();
    seed(&connection);
    let fresh = "8a201f33-0000-4c91-8d02-000000000009";
    connection
        .execute("DELETE FROM sync_dirty_nodes", ())
        .expect("clear");
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, 'root', 8589934592, 'bullet', 'Fresh', '')",
            [fresh],
        )
        .expect("page");

    let transaction = connection.transaction().expect("begin");
    let pending = notes_sync::export::pending_documents(&transaction).expect("pending");

    assert!(
        pending.contains(&"root".to_owned()),
        "a page that reaches no file is a page the user cannot open: {pending:?}"
    );
}

/// A split document says which node it hangs from. Writing it without that
/// line makes it a top-level page to any device reading the vault fresh — the
/// subtree leaves the page it belonged to and turns up beside it.
#[test]
fn a_split_document_states_the_node_it_hangs_from() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    connection
        .execute(
            "INSERT INTO sync_documents(root_id, folder_path) VALUES (?1, ?2)",
            rusqlite::params![
                NODE_ID,
                format!("Projects-4f1c8e20a3b7/Deeper-8a201f330000/README.md")
            ],
        )
        .expect("split document");

    {
        let transaction = connection.transaction().expect("begin");
        export_document(&transaction, root.path(), NODE_ID).expect("export");
        transaction.commit().expect("commit");
    }

    let file = std::fs::read_to_string(
        root.path()
            .join("Projects-4f1c8e20a3b7/Deeper-8a201f330000/README.md"),
    )
    .expect("the split document");
    assert!(
        file.contains(&format!("parent: {PAGE_ID}")),
        "without it the subtree becomes a page of its own on the next device \
         that reads the vault: {file}"
    );
}

/// Spec §9. Typing a word and taking it back leaves the note exactly as it
/// was, but each of those two edits is a real change to what was there a
/// moment before, so both stamp the row. Writing that stamp out would hand
/// every other device an edit that changes nothing — and beat a real edit
/// somebody made in the meantime.
#[test]
fn content_that_comes_back_to_what_was_written_keeps_its_reading() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    export(&mut connection, root.path());
    let first = written(root.path()).expect("the page");

    // There and back again, the way an edit and an undo leave it.
    for text in ["Changed", "Thought"] {
        connection
            .execute(
                "UPDATE notes_nodes SET text = ?2 WHERE id = ?1",
                rusqlite::params![NODE_ID, text],
            )
            .expect("edit");
    }
    let stamped: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("hlc");
    export(&mut connection, root.path());

    assert_eq!(
        written(root.path()).expect("the page"),
        first,
        "the file says the same thing it said, so it says it the same way"
    );
    let after: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("hlc");
    assert_ne!(
        after, stamped,
        "the reading the edits earned is given back, or the next file this \
         device writes carries it"
    );
}

/// A file somebody edited by hand is not this app's to replace, and what was
/// waiting to go into it is still waiting. Clearing the mark there would leave
/// the vault holding an older version of a note for good.
#[test]
fn a_hand_edited_file_keeps_its_place_in_the_queue() {
    let mut connection = database();
    seed(&connection);
    let root = vault();
    export_home(&mut connection, root.path());
    std::fs::write(root.path().join("README.md"), b"somebody's own words\n").expect("hand edit");
    connection
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES ('root', 0)",
            (),
        )
        .expect("dirty");

    let outcome = export_home(&mut connection, root.path());

    assert!(outcome.needs_merge, "somebody's edit comes first");
    let waiting: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = 'root'",
            [],
            |row| row.get(0),
        )
        .expect("dirty");
    assert_eq!(
        waiting, 1,
        "what this device is holding still has to reach the file, once the \
         merge has dealt with what the file already says"
    );
}

/// A deleted row belongs to the trash, whatever page it used to sit in.
#[test]
fn a_deleted_row_puts_the_trash_in_the_queue() {
    let mut connection = database();
    seed(&connection);
    connection
        .execute(
            "UPDATE notes_nodes SET deleted = 1 WHERE id = ?1",
            [NODE_ID],
        )
        .expect("delete");

    let transaction = connection.transaction().expect("begin");
    let pending = notes_sync::export::pending_documents(&transaction).expect("pending");

    assert!(
        pending.contains(&"yonalist-trash".to_owned()),
        "{pending:?}"
    );
}
