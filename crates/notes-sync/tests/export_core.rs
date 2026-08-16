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
