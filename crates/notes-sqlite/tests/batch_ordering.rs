use notes_application::{
    CommandEnvelope, IpcImportNode, IpcNodeDuplicate, IpcNodeMove, IpcNotesCommand, NotesService,
    StoragePort,
};
use notes_core::{DomainPatch, NodeId, NoteNode, TreeMutation};
use notes_sqlite::SqliteStorage;

fn command(request_id: &str, base_revision: u64, command: IpcNotesCommand) -> CommandEnvelope {
    CommandEnvelope {
        session_id: "session".into(),
        request_id: request_id.into(),
        base_revision,
        history_group: None,
        command,
    }
}

fn sparse_batch_storage() -> SqliteStorage {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let page_id = NodeId::try_from("page").unwrap();
    let holder_id = NodeId::try_from("holder").unwrap();
    let mut nodes = vec![
        NoteNode::page(page_id.clone(), "Page"),
        NoteNode::child(
            NodeId::try_from("left").unwrap(),
            page_id.clone(),
            1_024,
            "Left",
        ),
        NoteNode::child(
            NodeId::try_from("boundary").unwrap(),
            page_id.clone(),
            2_048,
            "Boundary",
        ),
        NoteNode::child(
            NodeId::try_from("tail").unwrap(),
            page_id.clone(),
            3_072,
            "Tail",
        ),
        NoteNode::child(holder_id.clone(), page_id, 4_096, "Holder"),
    ];
    nodes.extend((0..12).map(|index| {
        NoteNode::child(
            NodeId::try_from(format!("source-{index:02}")).unwrap(),
            holder_id.clone(),
            i64::from(index + 1) * 1_024,
            format!("Source {index}"),
        )
    }));
    let inverse = nodes
        .iter()
        .map(|node| TreeMutation::Delete {
            id: node.id().clone(),
        })
        .collect();
    storage
        .commit(
            0,
            &DomainPatch {
                forward: nodes.into_iter().map(TreeMutation::upsert).collect(),
                inverse,
                carried_pictures: Vec::new(),
            },
        )
        .unwrap();
    storage
}

fn assert_page_sort_keys_are_unique(storage: &SqliteStorage, inserted_ids: &[String]) {
    let mut ids = vec![
        "left".to_owned(),
        "boundary".to_owned(),
        "tail".to_owned(),
        "holder".to_owned(),
    ];
    ids.extend_from_slice(inserted_ids);
    let keys = ids
        .iter()
        .map(|id| storage.node(id).unwrap().unwrap().sort_key())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(keys.len(), ids.len(), "page siblings must have unique keys");
}

#[test]
fn batch_insert_shapes_rebalance_with_the_complete_target_sibling_set() {
    let imported_ids = (0..12)
        .map(|index| format!("import-{index:02}"))
        .collect::<Vec<_>>();
    let imported = sparse_batch_storage();
    NotesService::new(&imported, "session", 1)
        .execute(command(
            "import-many",
            1,
            IpcNotesCommand::ImportNodes {
                parent_id: "page".into(),
                before_id: Some("boundary".into()),
                nodes: imported_ids
                    .iter()
                    .map(|id| IpcImportNode {
                        id: id.clone(),
                        parent_id: "page".into(),
                        text: id.clone(),
                        ..IpcImportNode::default()
                    })
                    .collect(),
            },
        ))
        .unwrap();
    assert_page_sort_keys_are_unique(&imported, &imported_ids);

    let moved_ids = (0..12)
        .map(|index| format!("source-{index:02}"))
        .collect::<Vec<_>>();
    let moved = sparse_batch_storage();
    NotesService::new(&moved, "session", 1)
        .execute(command(
            "move-many",
            1,
            IpcNotesCommand::MoveNodes {
                moves: moved_ids
                    .iter()
                    .map(|id| IpcNodeMove {
                        id: id.clone(),
                        parent_id: "page".into(),
                        before_id: Some("boundary".into()),
                    })
                    .collect(),
            },
        ))
        .unwrap();
    assert_page_sort_keys_are_unique(&moved, &moved_ids);

    let copied_ids = (0..12)
        .map(|index| format!("copy-{index:02}"))
        .collect::<Vec<_>>();
    let copied = sparse_batch_storage();
    NotesService::new(&copied, "session", 1)
        .execute(command(
            "duplicate-many",
            1,
            IpcNotesCommand::DuplicateNodes {
                duplicates: copied_ids
                    .iter()
                    .map(|new_id| IpcNodeDuplicate {
                        id: "source-00".into(),
                        new_id: new_id.clone(),
                        parent_id: "page".into(),
                        before_id: Some("boundary".into()),
                    })
                    .collect(),
            },
        ))
        .unwrap();
    assert_page_sort_keys_are_unique(&copied, &copied_ids);
}
