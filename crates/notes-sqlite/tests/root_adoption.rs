use notes_application::StoragePort;
use notes_core::{DomainPatch, NodeId, NoteNode, NoteNodeKind, TreeMutation};
use notes_sqlite::SqliteStorage;

/// Opening a workspace that predates the root row has to adopt its top-level
/// pages, otherwise an existing database keeps an outline the home view cannot
/// reach.
#[test]
fn reopening_a_legacy_workspace_adopts_its_pages_under_the_root() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("notes-v2.sqlite");
    {
        let storage = SqliteStorage::open(&database).expect("open storage");
        // A top-level page row, the shape this workspace predates the root row
        // with. No command writes one any more, so the patch is written by hand.
        let page_id = NodeId::try_from("page").expect("valid node id");
        let patch = DomainPatch {
            forward: vec![TreeMutation::upsert(NoteNode::page(
                page_id.clone(),
                "Page",
            ))],
            inverse: vec![TreeMutation::Delete { id: page_id }],
            ..DomainPatch::default()
        };
        storage.commit(0, &patch).expect("page commit");
    }

    let reopened = SqliteStorage::open(&database).expect("reopen storage");
    let page = reopened
        .node("page")
        .expect("read page node")
        .expect("stored page node");
    assert_eq!(page.parent_id().map(NodeId::as_str), Some("root"));
    assert_eq!(page.kind(), NoteNodeKind::Bullet);
}
