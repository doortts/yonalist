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
const FIRST_PAGE: &str = "Notes0000001";
const SECOND_PAGE: &str = "Notes0000002";
const IMAGE_NODE: &str = "Nd0000000001";
const OTHER_IMAGE_NODE: &str = "Nd0000000002";
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

const FIRST_FOLDER: &str = "Notes-Notes0000001";
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

/// A split document sits inside its page's folder, and its attachments belong
/// to the page. Bytes put in a split folder's own `assets/` would be reachable
/// only through a link every device quarantines.
#[test]
fn an_attachment_inside_a_split_document_belongs_to_the_page() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    let split = "Nd00000000dd";
    connection
        .execute(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, ?2, 4294967296, 'bullet', 'Deeper', ?3)",
            rusqlite::params![split, FIRST_PAGE, stamp(6)],
        )
        .expect("split root");
    connection
        .execute(
            "INSERT INTO sync_documents(root_id, folder_path) VALUES (?1, ?2)",
            rusqlite::params![
                split,
                format!("{FIRST_FOLDER}/Deeper-Nd00000000dd/README.md")
            ],
        )
        .expect("split document");
    image_node(&connection, IMAGE_NODE, split, "holiday.png", false);

    place(&mut connection, &workspace);

    assert!(
        workspace
            .vault
            .path()
            .join(FIRST_FOLDER)
            .join("assets")
            .join(DISK_NAME)
            .exists(),
        "an attachment has two legal homes — its page's assets and the vault's"
    );
}

/// Where a file sits is not something the note said. If moving an attachment
/// restamped the node holding it, this device would beat every other device's
/// real edit to that note — for doing nothing but tidying a folder.
#[test]
fn moving_the_bytes_does_not_restamp_the_note() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", false);
    place(&mut connection, &workspace);
    let before: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [IMAGE_NODE],
            |row| row.get(0),
        )
        .expect("hlc");

    // A second page points at the same bytes, so they move to the root store.
    page(&connection, SECOND_PAGE, "Other", 8589934592);
    image_node(
        &connection,
        OTHER_IMAGE_NODE,
        SECOND_PAGE,
        "holiday.png",
        false,
    );
    place(&mut connection, &workspace);

    let after: String = connection
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [IMAGE_NODE],
            |row| row.get(0),
        )
        .expect("hlc");
    assert_eq!(after, before, "the note did not change; its picture moved");
}

/// A page travels as text and its pictures travel as files, and the two do not
/// arrive together. Until the bytes turn up there is nothing to place — and
/// nothing to place must not stop everything else from being placed, or a
/// vault that is mid-arrival exports nothing at all.
#[test]
fn an_attachment_whose_bytes_have_not_arrived_stops_nothing_else() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", false);
    // What a receiving device holds: the line names the file, the file is not
    // in the vault yet, and this app's store has never seen it either.
    connection
        .execute(
            "UPDATE notes_images SET relative_path = '../assets/elsewhere-000000000000.png'",
            (),
        )
        .expect("link");
    std::fs::remove_file(workspace.store.path().join(format!("{HASH}.png"))).expect("no bytes");

    let placed = {
        let transaction = connection.transaction().expect("begin");
        let placed = notes_sync::attachments::place_attachments(
            &transaction,
            workspace.vault.path(),
            workspace.store.path(),
        );
        transaction.commit().expect("commit");
        placed
    };

    assert!(
        placed.is_ok(),
        "one picture nobody can find yet is not a reason to write no files at all: {placed:?}"
    );
}

/// A recorded path is data, and data can be wrong — a folder path carrying
/// `..` is the case the folder retirement already guards against. Neither
/// making a folder for the new copy nor removing the old one may act on one
/// without checking where it lands.
#[test]
fn a_recorded_path_cannot_reach_outside_the_vault() {
    let mut connection = database();
    let workspace = workspace();
    let outside = tempfile::tempdir().expect("outside");
    let victim = outside.path().join("keep-me.png");
    std::fs::write(&victim, b"somebody else's file").expect("victim");
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", false);
    place(&mut connection, &workspace);
    // What a poisoned record looks like: the bytes are said to be somewhere
    // the vault does not reach.
    let escape = format!(
        "../{}/keep-me.png",
        outside.path().file_name().expect("name").to_string_lossy()
    );
    connection
        .execute(
            "UPDATE sync_assets SET location = ?1",
            [format!(
                "../../{}/{}/keep-me.png",
                outside
                    .path()
                    .parent()
                    .expect("parent")
                    .file_name()
                    .expect("name")
                    .to_string_lossy(),
                outside.path().file_name().expect("name").to_string_lossy()
            )],
        )
        .expect("poison");
    let _ = escape;

    // A second page: the bytes have to move, which is what reads the record.
    page(&connection, SECOND_PAGE, "Other", 8589934592);
    image_node(
        &connection,
        OTHER_IMAGE_NODE,
        SECOND_PAGE,
        "holiday.png",
        false,
    );
    place(&mut connection, &workspace);

    assert!(
        victim.exists(),
        "a file outside the vault is nobody's to remove, whatever a record says"
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

fn export_trash(connection: &mut Connection, workspace: &Workspace) {
    let transaction = connection.transaction().expect("begin");
    notes_sync::export::export_trash(&transaction, workspace.vault.path()).expect("export");
    transaction.commit().expect("commit");
}

/// The trash is a document like any other, and a line in it says what the node
/// is. Stating a picture as its file name in plain text is the file telling
/// every other device the picture was removed — which the user never said.
#[test]
fn a_trashed_picture_is_stated_as_a_picture() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", true);
    place(&mut connection, &workspace);

    export_trash(&mut connection, &workspace);

    let file = read(&workspace, ".yonalist/trash.md").expect("the trash");
    assert!(
        file.contains(&format!("](../assets/{DISK_NAME})")),
        "the trash sits one folder down: {file}"
    );
    // `![holiday`, not the whole escaped alt text: what it proves is that the
    // name came from the picture's own record. An image node's `text` is empty,
    // so reading the alt text from there would leave `![](…)`.
    assert!(
        file.contains("![holiday"),
        "and the line is the picture, under the name the user gave it: {file}"
    );
}

/// Bytes this device holds but has not managed to carry into the vault. The
/// row's own `relative_path` names them the way the app's store does — by their
/// hash — and no other device could ever match that name to these bytes. The
/// line has to state the name the placement would have given them.
#[test]
fn a_trashed_picture_with_bytes_but_no_placement_states_the_name_it_will_get() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", true);
    // The hash is known, so the row holds the app store's own name for the
    // file — but nothing has placed it, so there is no asset record to read.
    assert_eq!(
        connection
            .query_row("SELECT relative_path FROM notes_images", [], |row| row
                .get::<_, String>(
                0
            ))
            .expect("the row"),
        format!("{HASH}.png"),
        "the fixture is the row an unplaced picture leaves"
    );

    export_trash(&mut connection, &workspace);

    let file = read(&workspace, ".yonalist/trash.md").expect("the trash");
    assert!(
        file.contains(&format!("](../assets/{DISK_NAME})")),
        "the name every device can match to these bytes: {file}"
    );
    assert!(
        !file.contains(HASH),
        "the app store's own name means nothing in a vault: {file}"
    );
}

/// Which name those bytes get is the whole group's to decide, not one row's:
/// the placement takes the smallest of the names the users gave. A line naming
/// the file by its own note's spelling would name a file nobody ever writes,
/// and the note that arrives at the other device would wait for it for ever.
#[test]
fn an_unplaced_picture_two_notes_share_states_the_name_they_will_agree_on() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    page(&connection, SECOND_PAGE, "Other", 8589934592);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "zebra.png", true);
    image_node(
        &connection,
        OTHER_IMAGE_NODE,
        SECOND_PAGE,
        "apple.png",
        true,
    );

    export_trash(&mut connection, &workspace);

    let file = read(&workspace, ".yonalist/trash.md").expect("the trash");
    assert!(
        file.contains("](../assets/apple-9f2c1b7a4e6d.png)"),
        "the smallest name wins, for both lines: {file}"
    );
    assert!(
        !file.contains("zebra-9f2c1b7a4e6d.png"),
        "one note's own spelling is not the answer: {file}"
    );
}

/// A device that only ever saw the trash file holds the link that file wrote,
/// which is a place in the document it came from, not in this vault. Read as a
/// vault path it climbs one folder further out every round.
#[test]
fn a_trashed_picture_waiting_for_its_bytes_links_inside_the_vault() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "holiday.png", true);
    connection
        .execute(
            "UPDATE notes_images SET content_hash = '', relative_path = ?1",
            [format!("../assets/{DISK_NAME}")],
        )
        .expect("the bytes have not arrived");

    export_trash(&mut connection, &workspace);

    let file = read(&workspace, ".yonalist/trash.md").expect("the trash");
    assert!(
        file.contains(&format!("](../assets/{DISK_NAME})")),
        "a waiting row still states where its picture will be: {file}"
    );
    assert!(
        file.contains("![holiday"),
        "and states it as a picture, under its own name: {file}"
    );
    assert!(
        !file.contains("../../"),
        "a link out of the vault is not a place: {file}"
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

/// Two pages that added the same picture under different names agree on one,
/// and what is written down has to be the name the file actually got — the
/// merge finds an attachment's hash by the name in the link, so a record
/// naming the other one leaves every arriving line unable to find its bytes.
#[test]
fn the_recorded_name_is_the_name_on_disk() {
    let mut connection = database();
    let workspace = workspace();
    page(&connection, FIRST_PAGE, "Notes", 4294967296);
    page(&connection, SECOND_PAGE, "Other", 8589934592);
    image_node(&connection, IMAGE_NODE, FIRST_PAGE, "shot-2.png", false);
    image_node(
        &connection,
        OTHER_IMAGE_NODE,
        SECOND_PAGE,
        "shot.png",
        false,
    );

    place(&mut connection, &workspace);

    let (name, location): (String, String) = connection
        .query_row(
            "SELECT disk_name, location FROM sync_assets WHERE content_hash = ?1",
            [HASH],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("asset row");
    assert!(
        location.ends_with(&name),
        "`{name}` is not what was written at `{location}`"
    );
    assert!(
        workspace.vault.path().join(&location).exists(),
        "and the bytes are there under that name"
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
