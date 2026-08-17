//! The attachment list, which answers "why is this folder so large".
//!
//! One row per bullet showing a picture, biggest first. What the row has to
//! carry is where the picture is — the page and the bullet above it — because
//! that is how the user decides whether they still want it.

use notes_application::{CommandEnvelope, IpcNotesCommand, NotesService};
use notes_sqlite::SqliteStorage;
use rusqlite::Connection;

const PAGE: &str = "26VJSt4Rw5eO";
const OTHER_PAGE: &str = "SAu1WnG-Neew";
const SECTION: &str = "vTnXZwnGL468";
const SHOT: &str = "V3F6tu7wEImb";
const COPY: &str = "K0J91lhlBPWo";
const HASH: &str = "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
const OTHER_HASH: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn workspace() -> (tempfile::TempDir, SqliteStorage, std::path::PathBuf) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("notes.sqlite");
    let storage = SqliteStorage::open(&database).expect("open");
    (directory, storage, database)
}

fn writer(database: &std::path::Path) -> Connection {
    let connection = Connection::open(database).expect("open");
    let clock = std::sync::Arc::new(notes_sync::hlc::Clock::new("c0de").expect("clock"));
    notes_sync::hlc::register(&connection, clock).expect("register");
    connection
}

/// A page, a bullet under it, and a picture under that — the shape the list has
/// to describe back.
///
/// The tree is built through the app's own commands, because the ancestor path
/// the list reads is written by them: a hand-rolled one would be this test
/// agreeing with itself about a format production does not produce.
fn seed(storage: &SqliteStorage, connection: &Connection) {
    for (id, parent, text) in [
        (PAGE, "root", "Projects"),
        (OTHER_PAGE, "root", "Archive"),
        (SECTION, PAGE, "Trip notes"),
        (SHOT, SECTION, "holiday.png"),
        (COPY, OTHER_PAGE, "holiday.png"),
    ] {
        let revision = storage.revision().expect("revision");
        NotesService::new(storage, "session".to_owned(), revision)
            .execute(CommandEnvelope {
                session_id: "session".to_owned(),
                request_id: format!("make-{id}"),
                base_revision: revision,
                history_group: None,
                command: IpcNotesCommand::CreateNode {
                    id: id.to_owned(),
                    parent_id: parent.to_owned(),
                    before_id: None,
                    text: text.to_owned(),
                },
            })
            .expect("command");
    }
    for (node, hash, bytes) in [(SHOT, HASH, 2_048), (COPY, HASH, 2_048)] {
        connection
            .execute(
                "INSERT INTO notes_images(node_id, content_hash, relative_path, original_name,
                     mime_type, byte_length, pixel_width, pixel_height, display_width)
                 VALUES (?1, ?2, ?2 || '.png', 'holiday.png',
                     'image/png', ?3, 800, 600, 480)",
                rusqlite::params![node, hash, bytes],
            )
            .expect("image");
    }
}

#[test]
fn a_row_says_which_page_and_which_bullet_it_sits_under() {
    let (_directory, storage, database) = workspace();
    seed(&storage, &writer(&database));

    let rows = storage.attachments(50).expect("list");

    let shot = rows
        .iter()
        .find(|row| row.node_id == SHOT)
        .expect("the picture");
    assert_eq!(shot.page_title, "Projects", "the page it is on");
    assert_eq!(
        shot.parent_title, "Trip notes",
        "and the bullet above it, so the user knows which picture this is"
    );
    assert_eq!(shot.page_id, PAGE, "the row is what the click follows");
}

/// One row per bullet, not one per file. The same picture on two pages is two
/// rows, because the user finds it by the note they put it in.
#[test]
fn a_file_used_twice_appears_on_two_rows() {
    let (_directory, storage, database) = workspace();
    seed(&storage, &writer(&database));

    let rows = storage.attachments(50).expect("list");

    let sharing: Vec<_> = rows.iter().filter(|row| row.content_hash == HASH).collect();
    assert_eq!(sharing.len(), 2, "{rows:#?}");
    for row in sharing {
        assert_eq!(
            row.references, 2,
            "and each says how many notes are keeping it"
        );
    }
}

/// A picture in the trash is a picture the user can still get back, so it
/// counts — deleting its bytes because "nothing points at it" would empty the
/// note they restore.
#[test]
fn a_trashed_note_still_counts_as_a_reference() {
    let (_directory, storage, database) = workspace();
    let connection = writer(&database);
    seed(&storage, &connection);
    // A deleted row as the app leaves one: in the trash, and with no ancestor
    // path — the path is where a row sits, and a row in the trash sits nowhere.
    connection
        .execute(
            "UPDATE notes_nodes SET deleted = 1, path = NULL WHERE id = ?1",
            [COPY],
        )
        .expect("trash");

    let rows = storage.attachments(50).expect("list");

    let trashed = rows
        .iter()
        .find(|row| row.node_id == COPY)
        .expect("the deleted note's picture");
    assert!(trashed.trashed, "the row says where it is");
    assert_eq!(
        trashed.page_title, "",
        "a note in the trash is not on a page any more, and saying it is on \
         Home would send the user somewhere it is not"
    );
    assert_eq!(
        trashed.references, 2,
        "a note in the trash is one the user can still restore"
    );
    assert!(
        rows.iter()
            .find(|row| row.node_id == SHOT)
            .expect("the other one")
            .unreferenced_at
            .is_none(),
        "so nothing about it is counting down"
    );
}

#[test]
fn the_biggest_files_come_first() {
    let (_directory, storage, database) = workspace();
    let connection = writer(&database);
    seed(&storage, &connection);
    connection
        .execute(
            "UPDATE notes_images SET content_hash = ?2, byte_length = 9999 WHERE node_id = ?1",
            rusqlite::params![COPY, OTHER_HASH],
        )
        .expect("a bigger one");

    let rows = storage.attachments(50).expect("list");

    assert_eq!(
        rows.first().map(|row| row.node_id.as_str()),
        Some(COPY),
        "the list is for finding what is taking up the room"
    );
}

/// Bytes nothing points at have no bullet to belong to, which is exactly why
/// they need a line of their own — they are the ones the user can act on.
#[test]
fn bytes_nothing_points_at_get_a_line_and_can_be_removed() {
    let (_directory, storage, database) = workspace();
    let vault = tempfile::tempdir().expect("vault");
    let connection = writer(&database);
    seed(&storage, &connection);
    std::fs::create_dir_all(vault.path().join("assets")).expect("folder");
    std::fs::write(vault.path().join("assets/old-1111.png"), b"old bytes").expect("bytes");
    connection
        .execute(
            "INSERT INTO sync_assets(
                 content_hash, disk_name, location, byte_length, unreferenced_at)
             VALUES (?1, 'old-1111.png', 'assets/old-1111.png', 4096, 1750000000)",
            [OTHER_HASH],
        )
        .expect("unreferenced");

    let rows = storage.attachments(50).expect("list");
    let orphan = rows
        .iter()
        .find(|row| row.content_hash == OTHER_HASH)
        .expect("the line");
    assert_eq!(orphan.references, 0);
    assert_eq!(
        orphan.byte_length, 4_096,
        "the rows the user can actually act on are the ones that have to say \
         how much room they take"
    );
    assert_eq!(
        orphan.unreferenced_at,
        Some(1_750_000_000),
        "the screen counts the two weeks from here"
    );

    let removed = storage
        .delete_attachment(OTHER_HASH, Some(vault.path()))
        .expect("delete");

    assert!(removed);
    assert!(
        !vault.path().join("assets/old-1111.png").exists(),
        "the bytes go with the record"
    );
}

/// The list the user is looking at can be a moment old. The count is taken with
/// the removal, so a picture that got used again in that moment is kept.
#[test]
fn an_attachment_that_is_used_again_is_not_removed() {
    let (_directory, storage, database) = workspace();
    let vault = tempfile::tempdir().expect("vault");
    seed(&storage, &writer(&database));

    let removed = storage
        .delete_attachment(HASH, Some(vault.path()))
        .expect("delete");

    assert!(
        !removed,
        "two notes are still showing it, whatever the screen said"
    );
}
