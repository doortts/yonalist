use notes_application::StoragePort;
use notes_core::{
    DomainPatch, ImportImageNode, NodeId, NoteImage, NoteNode, NotesCommand, NotesTree, Position,
    TreeMutation,
};
use notes_sqlite::SqliteStorage;

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).expect("valid node id")
}

fn image(original_name: &str, display_width: u32) -> NoteImage {
    let hash = "a".repeat(64);
    NoteImage::try_new(
        hash.clone(),
        format!("{hash}.png"),
        original_name,
        "image/png",
        67,
        1,
        1,
        display_width,
    )
    .expect("valid image")
}

fn commit_page(storage: &SqliteStorage, tree: &mut NotesTree) {
    // The root row is already in the database; the tree only needs to know it
    // so the page can be planned as its child.
    tree.apply(&[TreeMutation::upsert(NoteNode::page(id("root"), "Home"))])
        .expect("root apply");
    let patch = tree
        .plan(NotesCommand::CreateNode {
            id: id("page"),
            parent_id: id("root"),
            position: Position::at_end(),
            text: "Page".into(),
        })
        .expect("page patch");
    storage.commit(0, &patch).expect("page commit");
    tree.apply(&patch.forward).expect("page apply");
}

#[test]
fn image_metadata_commits_and_restarts_with_its_owner() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("notes-v2.sqlite");
    {
        let storage = SqliteStorage::open(&database).expect("open storage");
        let mut tree = NotesTree::default();
        commit_page(&storage, &mut tree);
        let patch = tree
            .plan(NotesCommand::ImportImages {
                parent_id: id("page"),
                position: Position::at_end(),
                nodes: vec![ImportImageNode {
                    id: id("image"),
                    image: image("cat.png", 320),
                }],
            })
            .expect("image patch");
        let committed = storage.commit(1, &patch).expect("image commit");
        assert_eq!(committed.revision, 2);
        assert_eq!(committed.changed_nodes.len(), 1);
        assert_eq!(
            committed.changed_nodes[0]
                .image()
                .expect("committed image")
                .original_name(),
            "cat.png"
        );
    }

    let reopened = SqliteStorage::open(&database).expect("reopen storage");
    let node = reopened
        .node("image")
        .expect("read image node")
        .expect("stored image node");
    let stored = node.image().expect("stored image metadata");
    assert_eq!(stored.original_name(), "cat.png");
    assert_eq!(stored.mime_type(), "image/png");
    assert_eq!(stored.byte_length(), 67);
    assert_eq!((stored.pixel_width(), stored.pixel_height()), (1, 1));
    assert_eq!(stored.display_width(), 320);
}

#[test]
fn invalid_node_image_ownership_rolls_back_the_whole_revision() {
    let storage = SqliteStorage::open_in_memory().expect("open storage");
    let mut tree = NotesTree::default();
    commit_page(&storage, &mut tree);
    let valid_image = NoteNode::image_child(id("image"), id("page"), 1_024, image("cat.png", 320));
    let invalid_page = NoteNode::from_persisted_with_image(
        id("bad-page"),
        None,
        2_048,
        notes_core::NoteNodeKind::Page,
        Some(image("bad.png", 320)),
        "Bad".into(),
        String::new(),
        notes_core::NoteMarkerKind::Bullet,
        false,
        false,
        false,
        false,
    );
    let patch = DomainPatch {
        forward: vec![
            TreeMutation::upsert(valid_image),
            TreeMutation::upsert(invalid_page),
        ],
        inverse: Vec::new(),
    };

    assert!(storage.commit(1, &patch).is_err());
    assert_eq!(storage.revision().expect("revision"), 1);
    assert!(storage.node("image").expect("image query").is_none());
    assert!(storage.node("bad-page").expect("page query").is_none());
}

#[test]
fn fresh_schema_joins_image_kind_and_metadata() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("notes-v2.sqlite");
    {
        let storage = SqliteStorage::open(&database).expect("open storage");
        let mut tree = NotesTree::default();
        commit_page(&storage, &mut tree);
        let patch = tree
            .plan(NotesCommand::ImportImages {
                parent_id: id("page"),
                position: Position::at_end(),
                nodes: vec![ImportImageNode {
                    id: id("image"),
                    image: image("cat.png", 320),
                }],
            })
            .expect("image patch");
        storage.commit(1, &patch).expect("image commit");
    }

    let connection = rusqlite::Connection::open(database).expect("inspect database");
    let row = connection
        .query_row(
            "SELECT kind, original_name, display_width
             FROM notes_nodes
             JOIN notes_images ON notes_images.node_id = notes_nodes.id
             WHERE notes_nodes.id = 'image'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .expect("joined image row");
    assert_eq!(row, ("image".into(), "cat.png".into(), 320));
}
