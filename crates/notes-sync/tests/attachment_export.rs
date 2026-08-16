//! Attachments reaching the vault.
//!
//! The bytes live in this app's own store, under a name that is only a hash. A
//! vault is a folder the user opens, so what lands there is named after what
//! they called the file, and it sits in the folder of the page that uses it —
//! until a second page uses it too, at which point it belongs to neither and
//! moves to the vault's own store.

use notes_sync::hlc::{Clock, Hlc};
use rusqlite::Connection;

const DEVICE: &str = "cccc";
const FIRST_PAGE: &str = "4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1";
const SECOND_PAGE: &str = "4f1c8e20-a3b7-4c91-8d02-11c8da70b5e2";
const IMAGE_NODE: &str = "8a201f33-0000-4c91-8d02-000000000001";
const OTHER_IMAGE_NODE: &str = "8a201f33-0000-4c91-8d02-000000000002";
/// Not a real png, and nothing here decodes it — the store already checked.
const BYTES: &[u8] = b"pretend png";
const HASH: &str = "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";

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

fn page(connection: &Connection, id: &str, title: &str, sort_key: i64) {
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, 'root', ?2, 'bullet', ?3, ?4)",
            rusqlite::params![id, sort_key, title, stamp(5)],
        )
        .expect("page");
}

/// An image bullet under `parent`, with its asset row. `deleted` puts the node
/// in the trash without taking the reference away — a deleted note is one the
/// user can still restore, so its picture has to survive.
fn image_node(connection: &Connection, id: &str, parent: &str, name: &str, deleted: bool) {
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc, deleted)
             VALUES (?1, ?2, 4294967296, 'image', '', ?3, ?4)",
            rusqlite::params![id, parent, stamp(6), i64::from(deleted)],
        )
        .expect("node");
    connection
        .execute(
            "INSERT INTO notes_images(node_id, content_hash, relative_path, original_name,
                 mime_type, byte_length, pixel_width, pixel_height, display_width)
             VALUES (?1, ?2, ?3, ?4, 'image/png', ?5, 800, 600, 480)",
            rusqlite::params![id, HASH, format!("{HASH}.png"), name, BYTES.len() as i64],
        )
        .expect("image");
}

struct Workspace {
    vault: tempfile::TempDir,
    store: tempfile::TempDir,
}

fn workspace() -> Workspace {
    let store = tempfile::tempdir().expect("store");
    std::fs::write(store.path().join(format!("{HASH}.png")), BYTES).expect("asset");
    Workspace {
        vault: tempfile::tempdir().expect("vault"),
        store,
    }
}

fn place(connection: &mut Connection, workspace: &Workspace) {
    let transaction = connection.transaction().expect("begin");
    notes_sync::attachments::place_attachments(
        &transaction,
        workspace.vault.path(),
        workspace.store.path(),
    )
    .expect("place");
    transaction.commit().expect("commit");
}

fn export(connection: &mut Connection, workspace: &Workspace, root_id: &str) {
    let transaction = connection.transaction().expect("begin");
    notes_sync::export::export_document(&transaction, workspace.vault.path(), root_id)
        .expect("export");
    transaction.commit().expect("commit");
}

fn read(workspace: &Workspace, relative: &str) -> Option<String> {
    std::fs::read_to_string(workspace.vault.path().join(relative)).ok()
}

const FIRST_FOLDER: &str = "Notes-4f1c8e20a3b7";
const SECOND_FOLDER: &str = "Other-4f1c8e20a3b7";
const DISK_NAME: &str = "holiday-9f2c1b7a4e6d.png";

#[test]
fn one_page_keeps_its_attachment_in_its_own_folder() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", false);

    place(&mut connection, &workspace);
    export(&mut connection, &workspace, FIRST_PAGE);

    let asset = workspace
        .vault
        .path()
        .join(FIRST_FOLDER)
        .join("assets")
        .join(DISK_NAME);
    assert_eq!(
        std::fs::read(&asset).ok().as_deref(),
        Some(BYTES),
        "a folder the user opens has to hold the picture the page shows"
    );
    let document = read(&workspace, &format!("{FIRST_FOLDER}/README.md")).expect("page");
    assert!(
        document.contains(&format!("assets/{DISK_NAME}")),
        "the link is relative to the document, so moving the vault rewrites nothing: {document}"
    );
}

#[test]
fn a_second_page_using_the_same_bytes_moves_them_to_the_vault_store() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", false);
    place(&mut connection, &workspace);

    page(&connection, SECOND_PAGE, "Other", 8589934592);
    image_node(
        &connection,
        OTHER_IMAGE_NODE,
        SECOND_PAGE,
        "holiday.png",
        false,
    );
    place(&mut connection, &workspace);
    export(&mut connection, &workspace, FIRST_PAGE);

    assert_eq!(
        std::fs::read(workspace.vault.path().join("assets").join(DISK_NAME))
            .ok()
            .as_deref(),
        Some(BYTES),
        "bytes two pages share belong to neither of their folders"
    );
    assert!(
        !workspace
            .vault
            .path()
            .join(FIRST_FOLDER)
            .join("assets")
            .join(DISK_NAME)
            .exists(),
        "the old copy goes once the new one is there, and not before"
    );
    let document = read(&workspace, &format!("{FIRST_FOLDER}/README.md")).expect("page");
    assert!(
        document.contains(&format!("../assets/{DISK_NAME}")),
        "one `../` for each folder between the document and the root: {document}"
    );
}

#[test]
fn an_attachment_nobody_points_at_stays_where_it_is() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", false);
    place(&mut connection, &workspace);

    connection
        .execute("DELETE FROM notes_images WHERE node_id = ?1", [IMAGE_NODE])
        .expect("drop the reference");
    connection
        .execute("DELETE FROM notes_nodes WHERE id = ?1", [IMAGE_NODE])
        .expect("drop the node");
    place(&mut connection, &workspace);

    assert!(
        workspace
            .vault
            .path()
            .join(FIRST_FOLDER)
            .join("assets")
            .join(DISK_NAME)
            .exists(),
        "deleting an attachment is something the user does from the list, \
         not something an export does behind them"
    );
    let recorded: Option<i64> = connection
        .query_row(
            "SELECT unreferenced_at FROM sync_assets WHERE content_hash = ?1",
            [HASH],
            |row| row.get(0),
        )
        .expect("asset row");
    assert!(
        recorded.is_some(),
        "without the reading, nothing can tell the user how long it has left"
    );
}

#[test]
fn a_deleted_note_still_counts_as_a_reference() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", true);

    place(&mut connection, &workspace);

    assert!(
        workspace
            .vault
            .path()
            .join("assets")
            .join(DISK_NAME)
            .exists(),
        "the trash sits at the vault root and cannot point into a page's folder, \
         so a deleted note's picture has to be promoted"
    );
    let unreferenced: Option<i64> = connection
        .query_row(
            "SELECT unreferenced_at FROM sync_assets WHERE content_hash = ?1",
            [HASH],
            |row| row.get(0),
        )
        .expect("asset row");
    assert_eq!(
        unreferenced, None,
        "a note in the trash is one the user can still restore"
    );
}

#[test]
fn bytes_that_have_not_arrived_yet_are_not_invented() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", false);
    // The metadata reached this device before the file did.
    connection
        .execute("UPDATE notes_images SET content_hash = ''", ())
        .expect("clear the hash");

    place(&mut connection, &workspace);

    let placed: i64 = connection
        .query_row("SELECT count(*) FROM sync_assets", [], |row| row.get(0))
        .expect("count");
    assert_eq!(
        placed, 0,
        "there is nothing to place until the bytes turn up"
    );
}

/// The name is a fact about the bytes, not about the device that made it: two
/// devices working out where the same attachment goes have to write the same
/// name, or each will keep moving the other's copy.
#[test]
fn the_disk_name_carries_what_the_user_called_the_file() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(
        &connection,
        IMAGE_NODE,
        FIRST_PAGE,
        "Summer Holiday (2026)/best.png",
        false,
    );

    place(&mut connection, &workspace);

    let name: String = connection
        .query_row(
            "SELECT disk_name FROM sync_assets WHERE content_hash = ?1",
            [HASH],
            |row| row.get(0),
        )
        .expect("asset row");
    assert_eq!(
        name, "Summer-Holiday-2026-best-9f2c1b7a4e6d.png",
        "a name that would break a path or close a markdown link cannot go in one"
    );
}
