//! A merge is a write like any other, and it has to go through the same door.
//!
//! The worker owns the connection and the revision counter, so a merge that
//! reached the database another way would leave the revision untouched — and
//! every open session would keep committing against a state that had already
//! moved. The middle test here is what catches that: it only passes when the
//! merge really went through the worker.

use notes_application::{StorageError, StoragePort};
use notes_core::NotesCommand;
use notes_sqlite::SqliteStorage;
use notes_sync::document::{
    DocumentId, DocumentNode, DocumentRoot, Marker, NodeBody, PageDocument, VaultFile,
};
use notes_sync::merger::MergeInput;

const PAGE_ID: &str = "4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1";
const NODE_ID: &str = "8a201f33-0000-4c91-8d02-000000000001";

/// A file-backed database: the bypass this suite hunts for would open its own
/// connection, and an in-memory one cannot be opened twice.
/// This app's own image store. Empty here: these tests are about documents,
/// and an attachment with no bytes anywhere is simply not placed.
fn store() -> std::path::PathBuf {
    std::env::temp_dir().join("yonalist-empty-store")
}

fn storage() -> (tempfile::TempDir, SqliteStorage) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let storage = SqliteStorage::open(&directory.path().join("notes.sqlite")).expect("open");
    (directory, storage)
}

fn node(id: &str, hlc: &str, text: &str) -> DocumentNode {
    DocumentNode {
        id: id.to_owned(),
        hlc: hlc.to_owned(),
        body: NodeBody::Text(text.to_owned()),
        note: String::new(),
        marker: Marker::Bullet,
        collapsed: false,
        completed: false,
        starred: false,
        from: None,
        place: None,
        unknown_tokens: Vec::new(),
        children: Vec::new(),
    }
}

fn page(text: &str, hlc: &str) -> VaultFile {
    VaultFile::Page(PageDocument {
        id: DocumentId::Node(PAGE_ID.to_owned()),
        parent: None,
        sort_key: None,
        max_hlc: hlc.to_owned(),
        root: DocumentRoot {
            title: "Projects".to_owned(),
            hlc: hlc.to_owned(),
            ..DocumentRoot::default()
        },
        nodes: vec![node(NODE_ID, hlc, text)],
        unknown_frontmatter: Vec::new(),
    })
}

const IMAGE_NODE_ID: &str = "8a201f33-0000-4c91-8d02-00000000000f";

/// A page whose one line is a picture, linked the way a document in a page
/// folder links its own attachments.
fn page_with_image(disk_name: &str) -> VaultFile {
    let hlc = stamp(5);
    let mut image = node(IMAGE_NODE_ID, &hlc, "");
    image.body = NodeBody::Image(notes_sync::document::ImageReference {
        original_name: "holiday.png".to_owned(),
        path: format!("assets/{disk_name}"),
        display_width: 480,
        pixel_width: 800,
        pixel_height: 600,
        byte_size: 11,
        unknown_tokens: Vec::new(),
    });
    VaultFile::Page(PageDocument {
        id: DocumentId::Node(PAGE_ID.to_owned()),
        parent: None,
        sort_key: None,
        max_hlc: hlc.clone(),
        root: DocumentRoot {
            title: "Projects".to_owned(),
            hlc: hlc.clone(),
            ..DocumentRoot::default()
        },
        nodes: vec![image],
        unknown_frontmatter: Vec::new(),
    })
}

fn input() -> MergeInput {
    MergeInput {
        file_path: "Projects-4f1c8e20a3b7/README.md".to_owned(),
        file_hash: "a".repeat(64),
        file_mtime_ms: Some(1_700_000_000_000),
        file_size: Some(256),
    }
}

fn stamp(millis: u64) -> String {
    notes_sync::hlc::Hlc::new(millis, 0, "a3f2")
        .expect("hlc")
        .encode()
}

#[test]
fn a_merge_through_the_worker_bumps_the_revision_once() {
    let (_directory, storage) = storage();
    let before = storage.revision().expect("revision");

    let outcome = storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("merge");

    assert!(outcome.applied > 0);
    assert_eq!(storage.revision().expect("revision"), before + 1);
    assert_eq!(
        storage
            .node(NODE_ID)
            .expect("node")
            .expect("the node landed")
            .text(),
        "Thought"
    );
}

/// The bypass detector. A merge that wrote through its own connection would
/// leave the revision where it was, and this stale commit would then succeed.
#[test]
fn a_commit_with_the_pre_merge_revision_is_rejected() {
    let (_directory, storage) = storage();
    let stale = storage.revision().expect("revision");
    let command = NotesCommand::UpdateText {
        id: notes_core::NodeId::try_from("root".to_owned()).expect("root"),
        text: "Elsewhere".to_owned(),
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command.clone()).expect("plan");

    storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("merge");

    let refused = storage.commit(stale, &patch);

    assert!(
        matches!(refused, Err(StorageError::RevisionConflict { .. })),
        "a merge has to move the revision the same way any other write does: {refused:?}"
    );
}

#[test]
fn an_identical_merge_replay_keeps_the_revision() {
    let (_directory, storage) = storage();
    let file = page("Thought", &stamp(5));
    storage.merge_document(&file, &input()).expect("first");
    let after_first = storage.revision().expect("revision");

    let outcome = storage.merge_document(&file, &input()).expect("replay");

    assert_eq!(outcome.applied, 0, "a replay is not a write");
    assert_eq!(
        storage.revision().expect("revision"),
        after_first,
        "and it must not move the revision, or every echo would invalidate every open session"
    );
}

/// The merge writes rows straight into the table, so the derived column that
/// every subtree query reads has to be rebuilt in the same transaction.
#[test]
fn a_merge_leaves_the_derived_paths_correct() {
    let (_directory, storage) = storage();
    let mut parent = node(NODE_ID, &stamp(5), "Parent");
    let child_id = "8a201f33-0000-4c91-8d02-000000000002";
    parent.children = vec![node(child_id, &stamp(5), "Child")];
    let file = VaultFile::Page(PageDocument {
        id: DocumentId::Node(PAGE_ID.to_owned()),
        parent: None,
        sort_key: None,
        max_hlc: stamp(5),
        root: DocumentRoot {
            title: "Projects".to_owned(),
            hlc: stamp(5),
            ..DocumentRoot::default()
        },
        nodes: vec![parent],
        unknown_frontmatter: Vec::new(),
    });

    storage.merge_document(&file, &input()).expect("merge");

    let path = storage
        .node_path(child_id)
        .expect("path")
        .expect("the child");
    assert!(
        path.contains(NODE_ID) && path.contains(PAGE_ID),
        "a subtree query reads this column, and the merge is what filled the rows: {path}"
    );
}

/// A move made in the app has to leave a claim behind, or the next merge
/// rebuilds the order from stale claims and puts the node back — undoing the
/// user's own move on screen.
#[test]
fn a_local_move_survives_an_unrelated_merge() {
    let (_directory, storage) = storage();
    let first = "8a201f33-0000-4c91-8d02-000000000001";
    let second = "8a201f33-0000-4c91-8d02-000000000002";
    let seeded = stamp(5);
    let mut document = match page("One", &seeded) {
        VaultFile::Page(page) => page,
        VaultFile::Trash(_) => unreachable!(),
    };
    let third = "8a201f33-0000-4c91-8d02-000000000003";
    document.nodes = vec![
        node(first, &seeded, "One"),
        node(second, &seeded, "Two"),
        node(third, &seeded, "Three"),
    ];
    let file = VaultFile::Page(document.clone());
    storage.merge_document(&file, &input()).expect("seed");

    // The app moves `second` in front of `first`, the way a drag does.
    let command = NotesCommand::MoveNode {
        id: notes_core::NodeId::try_from(second.to_owned()).expect("id"),
        parent_id: notes_core::NodeId::try_from(PAGE_ID.to_owned()).expect("parent"),
        position: notes_core::Position::Before {
            sibling_id: notes_core::NodeId::try_from(first.to_owned()).expect("sibling"),
        },
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command).expect("plan");
    let revision = storage.revision().expect("revision");
    storage.commit(revision, &patch).expect("move");
    assert_eq!(
        order_of_children(&storage, PAGE_ID),
        vec![second, first, third]
    );

    // A merge that only has news about the third node. It still rebuilds the
    // order of every sibling under that parent, which is where a stale claim
    // would put the moved node back.
    let mut news = document;
    let mut edited = node(third, &stamp(9), "Three, edited elsewhere");
    // The other device edited the text and moved nothing, so its file still
    // claims the place the node has always had.
    edited.place = Some((first.to_owned(), seeded.clone()));
    news.nodes[2] = edited;
    news.max_hlc = stamp(9);
    storage
        .merge_document(&VaultFile::Page(news), &input())
        .expect("merge");

    assert_eq!(
        order_of_children(&storage, PAGE_ID),
        vec![second, first, third],
        "a merge about somebody else cannot undo the move"
    );
}

fn order_of_children(storage: &SqliteStorage, parent: &str) -> Vec<String> {
    storage
        .query_viewport(notes_application::ViewportRequest {
            page_id: parent.to_owned(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: None,
            limit: 32,
        })
        .expect("viewport")
        .nodes
        .into_iter()
        .map(|node| node.id)
        .collect()
}

/// The settings screen reads defeats from here and restores one by re-applying
/// it. Everything it needs has to be in the row, because by then the file that
/// lost is long gone.
#[test]
fn conflicts_page_returns_recorded_losers() {
    let (_directory, storage) = storage();
    storage
        .merge_document(&page("Winner", &stamp(9)), &input())
        .expect("seed");
    storage
        .merge_document(&page("Loser", &stamp(5)), &input())
        .expect("stale");

    let page_of_losers = storage.sync_conflicts(10).expect("conflicts");

    let entry = page_of_losers
        .iter()
        .find(|conflict| conflict.node_id == NODE_ID)
        .expect("the defeat was kept");
    assert_eq!(entry.text, "Loser");
    assert_eq!(entry.reason, "lww");
    assert!(entry.recorded_at > 0, "the screen shows when it happened");
}

/// The row keeps everything whoever puts it back will need. Making the write
/// is not this layer's job — a restore is an edit, and it goes the way edits
/// go.
#[test]
fn a_recorded_defeat_can_be_read_back_for_restoring() {
    let (_directory, storage) = storage();
    storage
        .merge_document(&page("Winner", &stamp(9)), &input())
        .expect("seed");
    storage
        .merge_document(&page("Loser", &stamp(5)), &input())
        .expect("stale");
    let entry = storage.sync_conflicts(10).expect("conflicts")[0].clone();

    let (node_id, text) = storage
        .conflict_loser(entry.seq)
        .expect("loser")
        .expect("the defeat is still there");

    assert_eq!(node_id, entry.node_id);
    assert_eq!(text, "Loser");
    assert_eq!(
        storage.conflict_loser(9_999).expect("missing"),
        None,
        "and one that is gone says so rather than pretending"
    );
}

#[test]
fn the_log_is_pruned_past_its_retention_count() {
    let (_directory, storage) = storage();
    storage
        .merge_document(&page("Winner", &stamp(4000)), &input())
        .expect("seed");
    for millis in 1..1_100u64 {
        storage
            .merge_document(&page(&format!("Loser {millis}"), &stamp(millis)), &input())
            .expect("stale");
    }

    let kept = storage.sync_conflicts(5_000).expect("conflicts");

    assert_eq!(
        kept.len(),
        1_000,
        "the bound is a thousand — not fewer, or the log forgets more than it was asked to"
    );
    assert_eq!(
        kept.first().map(|entry| entry.text.as_str()),
        Some("Loser 1099"),
        "newest first: the screen shows the most recent defeats, not the oldest"
    );
}

#[test]
fn the_log_is_pruned_past_its_retention_age() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("notes.sqlite");
    let storage = SqliteStorage::open(&path).expect("open");
    storage
        .merge_document(&page("Winner", &stamp(9)), &input())
        .expect("seed");
    storage
        .merge_document(&page("Loser", &stamp(5)), &input())
        .expect("stale");
    // Six months pass, as far as the log is concerned. A second connection is
    // the honest way to say that here: nothing in the app moves a clock, and
    // the test is simulating time rather than bypassing the worker.
    rusqlite::Connection::open(&path)
        .expect("open")
        .execute(
            "UPDATE sync_conflict_log SET recorded_at = recorded_at - ?1",
            [200 * 24 * 60 * 60],
        )
        .expect("age");

    storage
        .merge_document(&page("Loser again", &stamp(6)), &input())
        .expect("stale");

    let kept = storage.sync_conflicts(10).expect("conflicts");
    assert!(
        kept.iter().all(|entry| entry.text != "Loser"),
        "a defeat nobody looked at in six months is not worth keeping"
    );
}

/// A text edit must not promote a node's place claim. If it did, editing a note
/// here would beat a move another device made a moment earlier — and that
/// promoted claim would then win everywhere.
#[test]
fn a_text_edit_leaves_the_place_claim_where_it_was() {
    let (_directory, storage) = storage();
    let first = "8a201f33-0000-4c91-8d02-000000000001";
    let second = "8a201f33-0000-4c91-8d02-000000000002";
    let seeded = stamp(5);
    let mut document = match page("One", &seeded) {
        VaultFile::Page(page) => page,
        VaultFile::Trash(_) => unreachable!(),
    };
    document.nodes = vec![node(first, &seeded, "One"), node(second, &seeded, "Two")];
    storage
        .merge_document(&VaultFile::Page(document), &input())
        .expect("seed");
    let before = claim_of(&storage, second);

    let command = NotesCommand::UpdateText {
        id: notes_core::NodeId::try_from(second.to_owned()).expect("id"),
        text: "edited here".to_owned(),
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command).expect("plan");
    let revision = storage.revision().expect("revision");
    storage.commit(revision, &patch).expect("edit");

    assert_eq!(
        claim_of(&storage, second),
        before,
        "the node did not move, so nothing about where it sits was decided"
    );
}

fn claim_of(storage: &SqliteStorage, id: &str) -> (String, String) {
    storage.place_claim(id).expect("claim").expect("the node")
}

/// A file can be behind on the text and still be the one that knows where a
/// node moved to. That adoption rewrites sibling keys, so it is a write: the
/// derived paths the viewport orders by have to be rebuilt and open sessions
/// have to learn the revision moved.
#[test]
fn adopting_only_a_place_still_counts_as_a_write() {
    let (_directory, storage) = storage();
    let first = "8a201f33-0000-4c91-8d02-000000000001";
    let second = "8a201f33-0000-4c91-8d02-000000000002";
    let seeded = stamp(5);
    let mut document = match page("One", &seeded) {
        VaultFile::Page(page) => page,
        VaultFile::Trash(_) => unreachable!(),
    };
    document.nodes = vec![node(first, &seeded, "One"), node(second, &seeded, "Two")];
    storage
        .merge_document(&VaultFile::Page(document.clone()), &input())
        .expect("seed");
    let revision = storage.revision().expect("revision");

    // Same text, same stamps — only the claim moved, and later than what the
    // rows hold.
    let mut moved = document;
    let at = stamp(11);
    moved.nodes[1].place = Some((String::new(), at.clone()));
    moved.nodes[0].place = Some((second.to_owned(), at.clone()));
    let outcome = storage
        .merge_document(&VaultFile::Page(moved), &input())
        .expect("merge");

    assert!(
        outcome.applied > 0,
        "rows moved, so the merge cannot report that nothing happened"
    );
    assert!(
        storage.revision().expect("revision") > revision,
        "and every open session has to learn it"
    );
}

/// Exporting is the other half of the seam. It reads and writes the same rows
/// the worker owns, so it goes through the same door — and it must not move
/// the revision, because nothing about the notes changed by writing them down.
#[test]
fn an_export_through_the_worker_writes_the_vault_without_moving_the_revision() {
    let (_directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("seed");
    // A merge leaves nothing waiting — it adopted what another device already
    // wrote. A local edit is what puts a document in the queue.
    let command = NotesCommand::UpdateText {
        id: notes_core::NodeId::try_from(NODE_ID.to_owned()).expect("id"),
        text: "Thought, typed here".to_owned(),
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command).expect("plan");
    storage
        .commit(storage.revision().expect("revision"), &patch)
        .expect("edit");
    let revision = storage.revision().expect("revision");

    let written = storage
        .export_pending(vault.path(), &store())
        .expect("export");

    assert!(written > 0, "the waiting rows had somewhere to go");
    assert_eq!(
        storage.revision().expect("revision"),
        revision,
        "writing the notes down did not change them"
    );
    let home = std::fs::read_to_string(vault.path().join("README.md")).expect("home");
    assert!(home.contains("id: root"), "{home}");
    let file =
        std::fs::read_to_string(vault.path().join("Projects-4f1c8e20a3b7").join("README.md"))
            .expect("the page");
    // The comma is escaped: every ASCII punctuation mark is, so a user's text
    // can never turn into markup or into a node comment.
    assert!(file.contains(r"- Thought\, typed here <!-- yid:"), "{file}");
}

#[test]
fn an_export_with_nothing_waiting_writes_nothing() {
    let (_directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("seed");
    storage
        .export_pending(vault.path(), &store())
        .expect("first");

    let written = storage
        .export_pending(vault.path(), &store())
        .expect("again");

    assert_eq!(written, 0, "an export with nothing to say says nothing");
}

/// The write-back loop has to close. A merge that absorbed a hand edit records
/// exactly those bytes as what is on disk, so the next export is allowed to
/// replace them with the canonical form — otherwise the exporter answers
/// "somebody's edit" forever and the vault never catches up.
#[test]
fn a_hand_edited_file_gets_its_canonical_form_back() {
    let (_directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    let folder = vault.path().join("Projects-4f1c8e20a3b7");
    std::fs::create_dir_all(&folder).expect("folder");
    // A file somebody typed into: same node, no comment, so the merge issues an
    // id and marks the document for a rewrite.
    let by_hand = "---\nkind: yonalist-notes\nformat_version: 1\n\
                   id: 4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1\n\
                   max_hlc: 000000005-00-a3f2\nroot_hlc: 000000005-00-a3f2\n---\n\
                   # Projects\n\n- typed by hand\n";
    std::fs::write(folder.join("README.md"), by_hand).expect("write");
    let parsed = notes_sync::parse::parse(by_hand.as_bytes()).expect("parse");
    let mut input = input();
    input.file_hash = notes_sync::export::hash_bytes(by_hand.as_bytes());
    let outcome = storage.merge_document(&parsed, &input).expect("merge");
    assert!(
        outcome.needs_write_back,
        "the file is missing the id it was given"
    );

    let written = storage
        .export_pending(vault.path(), &store())
        .expect("export");

    assert!(written > 0, "the canonical form has to reach the file");
    let now = std::fs::read_to_string(folder.join("README.md")).expect("file");
    assert!(
        now.contains("yid:"),
        "the id the merge issued belongs in the file: {now}"
    );
}

/// A vault that has seen a deletion referencing a document it has not received
/// yet holds a placeholder with no stamp. Nothing can render that, and one such
/// row must not stop every other document from going out.
#[test]
fn a_placeholder_row_does_not_stop_the_export() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let db_path = directory.path().join("notes.sqlite");
    let storage = SqliteStorage::open(&db_path).expect("open");
    let vault = tempfile::tempdir().expect("vault");
    let unknown_parent = "9d3f21b8-c440-4c91-8d02-2e77a05fb163";
    let mut gone = node(NODE_ID, &stamp(5), "Gone");
    gone.from = Some((unknown_parent.to_owned(), 4_294_967_296));
    let mut trash_input = input();
    trash_input.file_path = ".yonalist/trash.md".to_owned();
    storage
        .merge_document(
            &VaultFile::Trash(notes_sync::document::TrashDocument {
                max_hlc: stamp(5),
                nodes: vec![gone],
            }),
            &trash_input,
        )
        .expect("trash");
    // A deletion made here is what puts the trash in the queue, so the trash
    // export actually runs alongside the placeholder.
    let side = rusqlite::Connection::open(&db_path).expect("open");
    notes_sync::hlc::register(
        &side,
        std::sync::Arc::new(notes_sync::hlc::Clock::new("dddd").expect("clock")),
    )
    .expect("register");
    side.execute(
        "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, deleted, hlc)
         VALUES ('8a201f33-0000-4c91-8d02-00000000000f', 'root', 4294967296, 'bullet',
                 'Deleted here', 1, '')",
        (),
    )
    .expect("local deletion");

    let written = storage
        .export_pending(vault.path(), &store())
        .expect("export");

    assert!(written > 0, "home still had to be written");
    let trash = std::fs::read_to_string(vault.path().join(".yonalist").join("trash.md"))
        .expect("the trash was written");
    assert!(trash.contains("Deleted here"), "{trash}");
    let mut found = Vec::new();
    let mut stack = vec![vault.path().to_path_buf()];
    while let Some(at) = stack.pop() {
        for entry in std::fs::read_dir(&at).expect("read") {
            let entry = entry.expect("entry");
            if entry.path().is_dir() {
                stack.push(entry.path());
            } else if let Ok(text) = std::fs::read_to_string(entry.path()) {
                found.push(text);
            }
        }
    }
    assert!(
        !found.iter().any(|text| text.contains(unknown_parent)),
        "a row waiting for its document has nothing to say yet"
    );
}

/// A page whose image row holds a path this format never writes must not take
/// the rest of the vault down with it.
#[test]
fn one_document_that_cannot_be_written_does_not_stop_the_others() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("notes.sqlite");
    let storage = SqliteStorage::open(&path).expect("open");
    let vault = tempfile::tempdir().expect("vault");
    storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("seed");
    let command = NotesCommand::UpdateText {
        id: notes_core::NodeId::try_from(NODE_ID.to_owned()).expect("id"),
        text: "typed here".to_owned(),
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command).expect("plan");
    storage
        .commit(storage.revision().expect("revision"), &patch)
        .expect("edit");
    // The onboarding page is dirty from the seed, and this one becomes a page
    // whose image states a path this format never writes — the shape every
    // real image row has until attachments are placed.
    let side = rusqlite::Connection::open(&path).expect("open");
    notes_sync::hlc::register(
        &side,
        std::sync::Arc::new(notes_sync::hlc::Clock::new("dddd").expect("clock")),
    )
    .expect("register");
    side.execute(
        "UPDATE notes_nodes SET kind = 'image' WHERE id = ?1",
        [NODE_ID],
    )
    .expect("image");
    side.execute(
        "INSERT INTO notes_images(
             node_id, content_hash, relative_path, original_name, mime_type,
             display_width, pixel_width, pixel_height, byte_length)
         VALUES (?1, '', 'elsewhere/shot.png', 'shot.png', 'image/png', 320, 10, 10, 4)",
        [NODE_ID],
    )
    .expect("metadata");

    let written = storage
        .export_pending(vault.path(), &store())
        .expect("export");

    assert!(
        written > 0,
        "the documents that could be written were written"
    );
    assert!(vault.path().join("README.md").exists(), "home included");
}

/// A file can state an image before its bytes have travelled: the note applies
/// with everything but the picture, and stays that way until the attachment
/// turns up. When it does, the rows waiting for it are the ones whose link
/// names it.
#[test]
fn an_arriving_attachment_resolves_the_rows_waiting_for_it() {
    let (_directory, storage) = storage();
    storage
        .merge_document(&page_with_image("holiday-9f2c1b7a4e6d.png"), &input())
        .expect("merge");
    let waiting: String = storage
        .image_hash(IMAGE_NODE_ID)
        .expect("row")
        .expect("an image row");
    assert_eq!(waiting, "", "the bytes have not arrived yet");

    let resolved = storage
        .resolve_asset(
            "holiday-9f2c1b7a4e6d.png",
            "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
            "Projects-4f1c8e20a3b7/assets/holiday-9f2c1b7a4e6d.png",
        )
        .expect("resolve");

    assert_eq!(resolved, 1, "one row was waiting for these bytes");
    assert_eq!(
        storage.image_hash(IMAGE_NODE_ID).expect("row"),
        Some("9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081".to_owned()),
        "the note can show its picture now"
    );
}

/// A hand edit can turn a picture line back into plain text. If the picture row
/// stays behind, the node reads back as a bullet owning image metadata and
/// every command on it is refused — it cannot be edited, and cannot even be
/// thrown away, because deleting a subtree upserts it too.
#[test]
fn a_picture_a_file_turned_back_into_text_is_not_stranded() {
    let (directory, storage) = storage();
    let path = directory.path().join("notes.sqlite");
    let hash = "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
    storage
        .merge_document(&page_with_image("holiday-9f2c1b7a4e6d.png"), &input())
        .expect("the picture");
    storage
        .resolve_asset(
            "holiday-9f2c1b7a4e6d.png",
            hash,
            "Projects-4f1c8e20a3b7/assets/holiday-9f2c1b7a4e6d.png",
        )
        .expect("the bytes");
    // The app's own record names the file by its hash, and a merge writes the
    // link its document states instead — which the app cannot read back. That
    // is a separate defect, so the row is given the app's spelling here.
    rusqlite::Connection::open(&path)
        .expect("open")
        .execute(
            "UPDATE notes_images SET relative_path = ?2 || '.png' WHERE node_id = ?1",
            rusqlite::params![IMAGE_NODE_ID, hash],
        )
        .expect("the app's own spelling");
    let mut document = match page("just words", &stamp(9)) {
        VaultFile::Page(page) => page,
        VaultFile::Trash(_) => unreachable!(),
    };
    document.nodes = vec![node(IMAGE_NODE_ID, &stamp(9), "just words")];
    storage
        .merge_document(&VaultFile::Page(document), &input())
        .expect("the hand edit");
    assert_eq!(
        storage
            .node(IMAGE_NODE_ID)
            .expect("node")
            .expect("the line")
            .kind(),
        notes_core::NoteNodeKind::Bullet,
        "the file's word: this line is no longer a picture"
    );

    let id = notes_core::NodeId::try_from(IMAGE_NODE_ID.to_owned()).expect("id");
    let edit = NotesCommand::UpdateText {
        id: id.clone(),
        text: "edited here".to_owned(),
    };
    let tree = storage.load_command_tree(&edit).expect("load");
    let patch = tree.plan(edit).expect("plan");
    storage
        .commit(storage.revision().expect("revision"), &patch)
        .expect("the line takes an edit");

    let trash = NotesCommand::DeleteSubtree { id };
    let tree = storage.load_command_tree(&trash).expect("load");
    let patch = tree.plan(trash).expect("plan");
    storage
        .commit(storage.revision().expect("revision"), &patch)
        .expect("and can be thrown away");
}

/// The name carries the first twelve characters of the content hash, so bytes
/// that do not hash to it are not the bytes that line is about — whatever the
/// file is called.
#[test]
fn bytes_that_do_not_match_the_name_resolve_nothing() {
    let (_directory, storage) = storage();
    storage
        .merge_document(&page_with_image("holiday-9f2c1b7a4e6d.png"), &input())
        .expect("merge");

    let resolved = storage
        .resolve_asset(
            "holiday-9f2c1b7a4e6d.png",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "Projects-4f1c8e20a3b7/assets/holiday-9f2c1b7a4e6d.png",
        )
        .expect("resolve");

    assert_eq!(
        resolved, 0,
        "these are somebody else's bytes under our name"
    );
    assert_eq!(
        storage.image_hash(IMAGE_NODE_ID).expect("row"),
        Some(String::new()),
        "and the row keeps waiting for the ones it asked for"
    );
}

/// The bytes arriving tell this device where they are, and the export writes
/// the link from that. A record saying "nowhere" cannot be rendered — and a
/// document that cannot be rendered keeps its marks and is tried again for
/// ever, which is a page that never reaches the folder again.
#[test]
fn a_resolved_attachment_leaves_its_page_exportable() {
    let (_directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    storage
        .merge_document(&page_with_image("holiday-9f2c1b7a4e6d.png"), &input())
        .expect("merge");
    storage
        .resolve_asset(
            "holiday-9f2c1b7a4e6d.png",
            "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
            "Projects-4f1c8e20a3b7/assets/holiday-9f2c1b7a4e6d.png",
        )
        .expect("resolve");

    // Something to write: the page changed after the picture resolved.
    let command = NotesCommand::UpdateText {
        id: notes_core::NodeId::try_from(PAGE_ID.to_owned()).expect("id"),
        text: "Renamed".to_owned(),
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command).expect("plan");
    storage
        .commit(storage.revision().expect("revision"), &patch)
        .expect("edit");

    storage
        .export_pending(vault.path(), &store())
        .expect("export");

    assert_eq!(
        storage.pending_count().expect("pending"),
        0,
        "the page could not be written, so it is owed for ever"
    );
    let written =
        std::fs::read_to_string(vault.path().join("Projects-4f1c8e20a3b7").join("README.md"))
            .expect("the page");
    assert!(
        written.contains("holiday-9f2c1b7a4e6d.png"),
        "the line still has to say where its picture is: {written}"
    );
}

/// The sweep re-reads the whole folder every minute. Every picture in it
/// being decoded again each time — including the ones this app wrote there —
/// is work that grows with the vault and never ends.
#[test]
fn bytes_already_taken_in_are_not_read_again() {
    let (_directory, storage) = storage();
    let location = "Projects-4f1c8e20a3b7/assets/holiday-9f2c1b7a4e6d.png";
    assert!(
        !storage.asset_known(location).expect("ask"),
        "nothing has been taken in yet"
    );

    storage
        .resolve_asset(
            "holiday-9f2c1b7a4e6d.png",
            "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
            location,
        )
        .expect("resolve");

    assert!(
        storage.asset_known(location).expect("ask"),
        "these bytes are already in this app's own store"
    );
}

/// The user's own markdown in the vault is theirs. Writing down that this app
/// cannot read a file must not make it one of this app's documents — the
/// folder retirement removes the folder of any document whose node is gone,
/// and that would delete the folder the user put their file in.
#[test]
fn a_file_this_app_cannot_read_is_not_one_of_its_documents() {
    let (_directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    std::fs::create_dir_all(vault.path().join("journal")).expect("folder");
    std::fs::write(
        vault.path().join("journal/today.md"),
        b"# Today\n\nSomebody's own notes.\n",
    )
    .expect("their file");

    storage
        .quarantine("journal/today.md", &"e".repeat(64))
        .expect("quarantine");
    storage
        .export_pending(vault.path(), &store())
        .expect("export");

    assert!(
        vault.path().join("journal/today.md").exists(),
        "a file this app cannot read is not a file it may delete"
    );
    assert!(vault.path().join("journal").is_dir(), "nor its folder");
}

/// A file this app cannot read is written down. Without that it is read and
/// refused again on every sweep, silently, for as long as it sits there.
#[test]
fn a_file_that_cannot_be_read_is_written_down() {
    let (_directory, storage) = storage();

    storage
        .quarantine("Projects-4f1c8e20a3b7/README.md", &"c".repeat(64))
        .expect("quarantine");

    assert_eq!(
        storage
            .vault_file_hash("Projects-4f1c8e20a3b7/README.md")
            .expect("hash")
            .as_deref(),
        Some("c".repeat(64).as_str()),
        "the same bytes arriving again are not news"
    );

    // Somebody had a go at fixing it and it still cannot be read. What is
    // written down has to be the file as it is now, or the next sweep reads
    // the old answer and skips a file that has changed.
    storage
        .quarantine("Projects-4f1c8e20a3b7/README.md", &"d".repeat(64))
        .expect("quarantine again");

    assert_eq!(
        storage
            .vault_file_hash("Projects-4f1c8e20a3b7/README.md")
            .expect("hash")
            .as_deref(),
        Some("d".repeat(64).as_str())
    );
}

/// The file that gets mangled is usually one of ours — somebody saves over a
/// page's README with something this format cannot read. Answering the sweep
/// with what this app last *wrote* there would have it re-read and re-refuse
/// the same bytes every minute, which is the loop the record exists to stop.
#[test]
fn a_document_that_becomes_unreadable_is_refused_only_once() {
    let (_directory, storage) = storage();
    storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("merge");

    storage
        .quarantine("Projects-4f1c8e20a3b7/README.md", &"f".repeat(64))
        .expect("quarantine");

    assert_eq!(
        storage
            .vault_file_hash("Projects-4f1c8e20a3b7/README.md")
            .expect("hash")
            .as_deref(),
        Some("f".repeat(64).as_str()),
        "the most recent look at that path is what decides whether to look again"
    );
}

/// A refusal is about a file. Once the file is gone, so is what it was about
/// — and one the user puts back is read rather than skipped as answered.
#[test]
fn a_refusal_goes_when_its_file_does() {
    let (directory, storage) = storage();
    storage
        .quarantine("journal/today.md", &"e".repeat(64))
        .expect("quarantine");

    storage
        .forget_missing_refusals(&["Projects-4f1c8e20a3b7/README.md".to_owned()])
        .expect("sweep");

    let remembered: i64 = rusqlite::Connection::open(directory.path().join("notes.sqlite"))
        .expect("read")
        .query_row("SELECT COUNT(*) FROM sync_quarantine", [], |row| row.get(0))
        .expect("quarantine");
    assert_eq!(remembered, 0, "the file it was about is not there any more");
}

/// A file that could not be read once can be fixed, or can simply finish
/// arriving. The note saying it was unreadable has to go with that, or every
/// later version of it is skipped as "already answered".
#[test]
fn a_file_that_becomes_readable_stops_being_refused() {
    let (directory, storage) = storage();
    storage
        .quarantine("Projects-4f1c8e20a3b7/README.md", &"c".repeat(64))
        .expect("quarantine");

    storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("merge");

    let still_refused: i64 = rusqlite::Connection::open(directory.path().join("notes.sqlite"))
        .expect("read")
        .query_row(
            "SELECT COUNT(*) FROM sync_quarantine WHERE relative_path = ?1",
            ["Projects-4f1c8e20a3b7/README.md"],
            |row| row.get(0),
        )
        .expect("quarantine");
    assert_eq!(
        still_refused, 0,
        "the refusal outlived the file it was about"
    );
}

/// A split document lives inside its page's folder and is not a page. A whole
/// export pass has to leave it exactly where it is — its file, its folder, and
/// its record.
#[test]
fn a_split_document_rides_through_an_export_untouched() {
    let (directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("seed");
    let split = "Projects-4f1c8e20a3b7/Deeper-8a201f330000/README.md";
    let connection =
        rusqlite::Connection::open(directory.path().join("notes.sqlite")).expect("open");
    connection
        .execute(
            "INSERT INTO sync_documents(root_id, folder_path, exported_hash, is_page)
             VALUES (?1, ?2, 'b', 0)",
            rusqlite::params![NODE_ID, split],
        )
        .expect("split document");
    std::fs::create_dir_all(
        vault
            .path()
            .join("Projects-4f1c8e20a3b7/Deeper-8a201f330000"),
    )
    .expect("folder");
    std::fs::write(vault.path().join(split), b"the split document\n").expect("its file");

    storage
        .export_pending(vault.path(), &store())
        .expect("export");

    assert!(
        vault.path().join(split).exists(),
        "the file a split document owns is not the page's to write over or remove"
    );
    let (retiring, still_recorded): (i64, i64) = connection
        .query_row(
            "SELECT coalesce(max(retiring), -1), count(*) FROM sync_documents
             WHERE root_id = ?1",
            [NODE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the document");
    assert_eq!(still_recorded, 1, "and its record stays");
    assert_eq!(retiring, 0, "it is where it belongs, not on its way out");
}

/// What a document is can change: a subtree that arrived as a split document
/// can become a page of its own, and a page can stop being one. Whoever writes
/// the record says which it is now — a first impression kept for ever would
/// leave a demotion unnoticed and the folder standing.
#[test]
fn what_a_document_is_follows_what_it_says_now() {
    let (directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    let connection =
        rusqlite::Connection::open(directory.path().join("notes.sqlite")).expect("open");
    connection
        .execute(
            "INSERT INTO sync_documents(root_id, folder_path, exported_hash, is_page)
             VALUES (?1, 'Projects-4f1c8e20a3b7/Deeper/README.md', 'b', 0)",
            [PAGE_ID],
        )
        .expect("as a split document");

    // This device makes it a page of its own and writes it out. The export is
    // the only writer here — nothing arrives from anywhere.
    let command = NotesCommand::CreateNode {
        id: notes_core::NodeId::try_from(PAGE_ID.to_owned()).expect("id"),
        parent_id: notes_core::NodeId::try_from("root".to_owned()).expect("id"),
        position: notes_core::Position::at_end(),
        text: "A page now".to_owned(),
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command).expect("plan");
    storage
        .commit(storage.revision().expect("revision"), &patch)
        .expect("make the page");
    storage
        .export_pending(vault.path(), &store())
        .expect("export");

    let is_page: i64 = connection
        .query_row(
            "SELECT is_page FROM sync_documents WHERE root_id = ?1",
            [PAGE_ID],
            |row| row.get(0),
        )
        .expect("the document");
    assert_eq!(
        is_page, 1,
        "it is a page now, and a demotion later has to be noticed"
    );
}

/// A reindex is the last net under the scan gate, so what it could not read
/// has to come back as a number. Answering "nothing changed" about a vault it
/// only half read is the one thing a net must not do.
#[test]
fn a_reindex_reports_what_it_could_not_read() {
    let (_directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("seed");
    storage
        .export_pending(vault.path(), &store())
        .expect("export");
    std::fs::write(
        vault.path().join("hand-written.md"),
        b"nothing here is a document\n",
    )
    .expect("stray file");

    let report = storage.reindex_vault(vault.path()).expect("reindex");

    assert_eq!(
        report.skipped, 1,
        "a file this format cannot read is not a file that says nothing changed"
    );
}

/// §3.4's no-follow contract. A link in the vault pointing at somebody's home
/// directory would otherwise have the reindex read it, and a link pointing at
/// a folder above itself would have it read forever — inside the one thread
/// that owns the database, which freezes everything the app can do.
#[test]
fn a_reindex_does_not_follow_links_out_of_the_vault() {
    let (_directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    storage
        .export_pending(vault.path(), &store())
        .expect("export");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(outside.path().join("elsewhere.md"), b"not ours\n").expect("file");
    std::os::unix::fs::symlink(outside.path(), vault.path().join("linked")).expect("link");
    std::os::unix::fs::symlink(vault.path(), vault.path().join("loop")).expect("loop");

    let report = storage.reindex_vault(vault.path()).expect("reindex");

    assert_eq!(
        report.skipped, 0,
        "a link is not a file this vault holds, so there is nothing to read \
         and nothing to report"
    );
}

/// Spec §9. A reindex reads the vault as the truth. Doing that while this
/// device is holding edits it has not written out yet would throw them away —
/// so it is refused until the export catches up.
#[test]
fn reindex_is_refused_while_edits_are_unexported() {
    let (_directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("seed");
    let command = NotesCommand::UpdateText {
        id: notes_core::NodeId::try_from(NODE_ID.to_owned()).expect("id"),
        text: "not written out yet".to_owned(),
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command).expect("plan");
    storage
        .commit(storage.revision().expect("revision"), &patch)
        .expect("edit");

    let refused = storage.reindex_vault(vault.path());

    assert!(
        refused.is_err(),
        "reading the vault as the truth would discard what this device is still holding"
    );

    storage
        .export_pending(vault.path(), &store())
        .expect("export");
    assert_eq!(
        storage.pending_count().expect("pending"),
        0,
        "the export left nothing behind"
    );
    assert!(
        storage.reindex_vault(vault.path()).is_ok(),
        "once everything is written out, the vault is safe to read as the truth"
    );
}

/// A split document with an edit inside it has to survive two passes, not
/// one. The first writes its file — and if that write says "page", the second
/// retires it: the folder taken and the subtree flattened, one edit later.
/// What the export states about a document has to come from the node, not
/// from the fact that the export is writing it.
#[test]
fn an_edited_split_document_survives_two_export_passes() {
    let (directory, storage) = storage();
    let vault = tempfile::tempdir().expect("vault");
    storage
        .merge_document(&page("Thought", &stamp(5)), &input())
        .expect("seed");
    let split = "Projects-4f1c8e20a3b7/Deeper-8a201f330000/README.md";
    let connection =
        rusqlite::Connection::open(directory.path().join("notes.sqlite")).expect("open");
    connection
        .execute(
            "INSERT INTO sync_documents(root_id, folder_path, is_page)
             VALUES (?1, ?2, 0)",
            rusqlite::params![NODE_ID, split],
        )
        .expect("split document");
    // An edit inside the split document — its normal life.
    connection
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, unixepoch())
             ON CONFLICT(node_id) DO NOTHING",
            [NODE_ID],
        )
        .expect("dirty");

    storage
        .export_pending(vault.path(), &store())
        .expect("pass one");
    let is_page: i64 = connection
        .query_row(
            "SELECT is_page FROM sync_documents WHERE root_id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("the document");
    storage
        .export_pending(vault.path(), &store())
        .expect("pass two");

    assert_eq!(
        is_page, 0,
        "exporting a split document must not make it a page"
    );
    assert!(
        vault.path().join(split).exists(),
        "two passes later the split document's file is still its own"
    );
    let still_recorded: i64 = connection
        .query_row(
            "SELECT count(*) FROM sync_documents WHERE root_id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(still_recorded, 1, "and so is its record");
}
