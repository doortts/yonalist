use notes_application::{ExportSnapshotPort, StoragePort};
use notes_core::{
    DomainPatch, NodeId, NoteImage, NoteMarkerKind, NoteNode, NoteNodeKind, TreeMutation,
};
use notes_sqlite::SqliteStorage;

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).expect("valid node id")
}

fn image() -> NoteImage {
    let hash = "a".repeat(64);
    NoteImage::try_new(
        hash.clone(),
        format!("{hash}.png"),
        "diagram.png",
        "image/png",
        67,
        1,
        1,
        320,
    )
    .expect("valid image")
}

#[allow(clippy::too_many_arguments)]
fn node(
    node_id: &str,
    parent_id: Option<&str>,
    sort_key: i64,
    kind: NoteNodeKind,
    text: &str,
    marker: NoteMarkerKind,
    collapsed: bool,
    completed: bool,
    deleted: bool,
) -> NoteNode {
    NoteNode::from_persisted(
        id(node_id),
        parent_id.map(id),
        sort_key,
        kind,
        text.into(),
        String::new(),
        marker,
        collapsed,
        completed,
        false,
        deleted,
    )
}

fn insertion_patch(forward: Vec<TreeMutation>) -> DomainPatch {
    let inverse = forward
        .iter()
        .filter_map(|mutation| match mutation {
            TreeMutation::Upsert(node) => Some(TreeMutation::Delete {
                id: node.id().clone(),
            }),
            TreeMutation::Delete { .. } => None,
        })
        .collect();
    DomainPatch {
        forward,
        inverse,
        ..DomainPatch::default()
    }
}

fn seeded_storage() -> SqliteStorage {
    let storage = SqliteStorage::open_in_memory().expect("open storage");
    let patch = insertion_patch(vec![
        TreeMutation::upsert(node(
            "page",
            None,
            1_024,
            NoteNodeKind::Page,
            "프로젝트",
            NoteMarkerKind::Bullet,
            false,
            false,
            false,
        )),
        TreeMutation::upsert(node(
            "alpha",
            Some("page"),
            1_024,
            NoteNodeKind::Bullet,
            "Alpha",
            NoteMarkerKind::Todo,
            false,
            true,
            false,
        )),
        TreeMutation::upsert(node(
            "beta",
            Some("page"),
            1_024,
            NoteNodeKind::Bullet,
            "Beta",
            NoteMarkerKind::Bullet,
            false,
            false,
            false,
        )),
        TreeMutation::upsert(node(
            "collapsed",
            Some("page"),
            2_048,
            NoteNodeKind::Bullet,
            "Collapsed",
            NoteMarkerKind::Bullet,
            true,
            false,
            false,
        )),
        TreeMutation::upsert(node(
            "hidden-child",
            Some("collapsed"),
            1_024,
            NoteNodeKind::Bullet,
            "Hidden child",
            NoteMarkerKind::Bullet,
            false,
            false,
            false,
        )),
        TreeMutation::upsert(NoteNode::image_child(
            id("image"),
            id("collapsed"),
            2_048,
            image(),
        )),
        TreeMutation::upsert(node(
            "deleted-child",
            Some("page"),
            3_072,
            NoteNodeKind::Bullet,
            "Deleted",
            NoteMarkerKind::Bullet,
            false,
            false,
            true,
        )),
    ]);
    storage.commit(0, &patch).expect("seed snapshot fixture");
    storage
}

#[test]
fn snapshot_is_revision_consistent_ordered_and_includes_collapsed_descendants() {
    let storage = seeded_storage();

    let snapshot = storage
        .load_export_snapshot(1, &id("page"))
        .expect("load export snapshot");

    assert_eq!(snapshot.revision, 1);
    assert_eq!(snapshot.root_node_id, id("page"));
    assert_eq!(snapshot.title, "프로젝트");
    assert!(!snapshot.exported_at.is_empty());
    assert_eq!(
        snapshot
            .root
            .children
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["alpha", "beta", "collapsed"]
    );
    assert!(snapshot.root.children[0].completed);
    assert_eq!(snapshot.root.children[0].marker, NoteMarkerKind::Todo);
    assert_eq!(
        snapshot.root.children[2]
            .children
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["hidden-child", "image"]
    );
    let image = snapshot.root.children[2].children[1]
        .image
        .as_ref()
        .expect("image metadata");
    assert_eq!(image.metadata.original_name(), "diagram.png");
    assert!(image.bytes.is_none());
    assert!(
        snapshot
            .root
            .children
            .iter()
            .all(|node| node.id.as_str() != "deleted-child")
    );
}

#[test]
fn snapshot_rejects_stale_revision_and_deleted_root() {
    let storage = seeded_storage();

    let stale = storage
        .load_export_snapshot(0, &id("page"))
        .expect_err("stale revision");
    assert!(matches!(
        stale,
        notes_application::ExportError::Storage(
            notes_application::StorageError::RevisionConflict {
                expected: 0,
                actual: 1
            }
        )
    ));

    let deleted = storage
        .load_export_snapshot(1, &id("deleted-child"))
        .expect_err("deleted root");
    assert!(matches!(deleted, notes_application::ExportError::Failed(_)));
}

#[test]
fn snapshot_rejects_depth_and_image_count_over_the_export_limits() {
    let depth_storage = SqliteStorage::open_in_memory().expect("open depth storage");
    let mut depth_nodes = vec![TreeMutation::upsert(node(
        "page",
        None,
        1_024,
        NoteNodeKind::Page,
        "Page",
        NoteMarkerKind::Bullet,
        false,
        false,
        false,
    ))];
    let mut parent = "page".to_string();
    for level in 1..notes_application::MAX_EXPORT_DEPTH {
        let current = format!("level-{level}");
        depth_nodes.push(TreeMutation::upsert(node(
            &current,
            Some(&parent),
            1_024,
            NoteNodeKind::Bullet,
            "Nested",
            NoteMarkerKind::Bullet,
            false,
            false,
            false,
        )));
        parent = current;
    }
    depth_nodes.push(TreeMutation::upsert(node(
        "too-deep",
        Some(&parent),
        1_024,
        NoteNodeKind::Bullet,
        "Too deep",
        NoteMarkerKind::Bullet,
        false,
        false,
        false,
    )));
    depth_storage
        .commit(0, &insertion_patch(depth_nodes))
        .expect("seed deep tree");
    assert!(matches!(
        depth_storage
            .load_export_snapshot(1, &id("page"))
            .expect_err("depth limit"),
        notes_application::ExportError::TooLarge(_)
    ));

    let image_storage = SqliteStorage::open_in_memory().expect("open image storage");
    let mut image_nodes = vec![TreeMutation::upsert(node(
        "page",
        None,
        1_024,
        NoteNodeKind::Page,
        "Page",
        NoteMarkerKind::Bullet,
        false,
        false,
        false,
    ))];
    for index in 0..=notes_application::MAX_EXPORT_IMAGES {
        image_nodes.push(TreeMutation::upsert(NoteNode::image_child(
            id(&format!("image-{index}")),
            id("page"),
            i64::try_from(index + 1).expect("sort key"),
            image(),
        )));
    }
    image_storage
        .commit(0, &insertion_patch(image_nodes))
        .expect("seed image tree");
    assert!(matches!(
        image_storage
            .load_export_snapshot(1, &id("page"))
            .expect_err("image limit"),
        notes_application::ExportError::TooLarge(_)
    ));
}
