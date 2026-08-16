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

/// Restoring is a new edit, not a rewind: it takes a fresh stamp and travels
/// like anything else the user types.
#[test]
fn restoring_a_conflict_reapplies_the_loser_as_a_new_edit() {
    let (_directory, storage) = storage();
    storage
        .merge_document(&page("Winner", &stamp(9)), &input())
        .expect("seed");
    storage
        .merge_document(&page("Loser", &stamp(5)), &input())
        .expect("stale");
    let entry = storage.sync_conflicts(10).expect("conflicts")[0].clone();
    let revision = storage.revision().expect("revision");

    storage.restore_conflict(entry.seq).expect("restore");

    assert_eq!(
        storage
            .node(NODE_ID)
            .expect("node")
            .expect("the node")
            .text(),
        "Loser",
        "the defeated text is back"
    );
    assert!(
        storage.revision().expect("revision") > revision,
        "and it is a write like any other"
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

    assert!(
        kept.len() <= 1_000,
        "an unbounded audit log eventually costs more than it is worth: {}",
        kept.len()
    );
    assert!(
        kept.iter().any(|entry| entry.text == "Loser 1099"),
        "and what it drops is the oldest, not the newest"
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
