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
