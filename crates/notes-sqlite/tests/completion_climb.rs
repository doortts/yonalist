use notes_application::{
    CommandEnvelope, IpcNotesCommand, MutationReceipt, NotesService, StoragePort,
};
use notes_core::{DomainPatch, NodeId, NoteMarkerKind, NoteNode, NoteNodeKind, TreeMutation};
use notes_sqlite::SqliteStorage;

/// Longer than the desktop's viewport window (80 rows), so the rows the cascade
/// has to reach are ones no client could have loaded.
const CHAIN_DEPTH: usize = 120;

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).unwrap()
}

fn chain_id(depth: usize) -> NodeId {
    id(&format!("chain-{depth:03}"))
}

fn todo(node_id: NodeId, parent_id: NodeId, completed: bool) -> NoteNode {
    NoteNode::from_persisted(
        node_id.clone(),
        Some(parent_id),
        1_024,
        NoteNodeKind::Bullet,
        node_id.to_string(),
        String::new(),
        NoteMarkerKind::Todo,
        false,
        completed,
        false,
        false,
    )
}

/// A page holding one Todo chain `CHAIN_DEPTH` rows deep, with a plain bullet
/// hanging off its foot and one more Todo under that bullet.
fn stored_chain() -> SqliteStorage {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let mut forward = vec![TreeMutation::upsert(NoteNode::child(
        id("page"),
        id("root"),
        1_024,
        "Page",
    ))];
    for depth in 0..CHAIN_DEPTH {
        let parent_id = if depth == 0 {
            id("page")
        } else {
            chain_id(depth - 1)
        };
        forward.push(TreeMutation::upsert(todo(
            chain_id(depth),
            parent_id,
            false,
        )));
    }
    forward.push(TreeMutation::upsert(NoteNode::child(
        id("divider"),
        chain_id(CHAIN_DEPTH - 1),
        1_024,
        "Divider",
    )));
    forward.push(TreeMutation::upsert(todo(
        id("beyond"),
        id("divider"),
        false,
    )));
    // Every seeded row is one this patch creates, which is what the inverse
    // tells the commit: an id it deletes is an id to INSERT rather than update.
    let inverse = forward
        .iter()
        .filter_map(|mutation| match mutation {
            TreeMutation::Upsert(node) => Some(TreeMutation::Delete {
                id: node.id().clone(),
            }),
            TreeMutation::Delete { .. } => None,
        })
        .collect();
    storage
        .commit(
            0,
            &DomainPatch {
                forward,
                inverse,
                carried_pictures: Vec::new(),
            },
        )
        .unwrap();
    storage
}

fn set_completed(storage: &SqliteStorage, node_id: &NodeId, completed: bool) {
    let revision = storage.revision().unwrap();
    NotesService::new(storage, "session", revision)
        .execute(CommandEnvelope {
            session_id: "session".into(),
            request_id: format!("{node_id}-{completed}"),
            base_revision: revision,
            history_group: None,
            command: IpcNotesCommand::SetCompleted {
                id: node_id.to_string(),
                completed,
            },
        })
        .unwrap();
}

fn set_completed_many(
    storage: &SqliteStorage,
    node_ids: &[NodeId],
    completed: bool,
) -> MutationReceipt {
    let revision = storage.revision().unwrap();
    NotesService::new(storage, "session", revision)
        .execute(CommandEnvelope {
            session_id: "session".into(),
            request_id: format!("many-{completed}"),
            base_revision: revision,
            history_group: None,
            command: IpcNotesCommand::SetCompletedMany {
                ids: node_ids.iter().map(NodeId::to_string).collect(),
                completed,
            },
        })
        .unwrap()
}

fn is_completed(storage: &SqliteStorage, node_id: &NodeId) -> bool {
    storage
        .node(node_id.as_str())
        .unwrap()
        .unwrap()
        .is_completed()
}

#[test]
fn ticking_the_deepest_row_settles_the_chain_far_past_any_client_window() {
    let storage = stored_chain();

    // Each row on this chain has exactly one child, so finishing the foot
    // finishes every row above it -- none of which a client could have loaded.
    set_completed(&storage, &id("beyond"), true);

    assert!(is_completed(&storage, &id("divider")));
    for depth in 0..CHAIN_DEPTH {
        assert!(
            is_completed(&storage, &chain_id(depth)),
            "chain row {depth} was left open"
        );
    }
}

#[test]
fn ticking_the_top_speaks_for_the_top_alone() {
    let storage = stored_chain();

    set_completed(&storage, &chain_id(0), true);

    assert!(is_completed(&storage, &chain_id(0)));
    assert!(!is_completed(&storage, &chain_id(1)));
    assert!(!is_completed(&storage, &id("beyond")));
}

/// The selection bulk-complete climbs just as far as a single tick: the working
/// set has to load the path above each listed row, not the row alone.
#[test]
fn a_bulk_selection_settles_the_chain_far_past_any_client_window() {
    let storage = stored_chain();

    let receipt = set_completed_many(&storage, &[id("beyond")], true);

    for depth in 0..CHAIN_DEPTH {
        assert!(
            is_completed(&storage, &chain_id(depth)),
            "chain row {depth} was left open"
        );
    }

    // The client redraws from the receipt, so every row the climb flipped has to
    // ride back in it -- including the ones no client ever sent.
    let changed = receipt
        .changed_nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    for depth in 0..CHAIN_DEPTH {
        let row = chain_id(depth);
        assert!(
            changed.contains(row.as_str()),
            "chain row {depth} never reached the receipt"
        );
    }
}

/// The climb reads an ancestor's own children before it may tick it, and the
/// rows it reads can only be the ones the working set loaded. A sibling the
/// window never reached reads as no row at all, and an ancestor is settled by a
/// row that is still open.
#[test]
fn an_open_row_outside_the_window_keeps_the_rows_above_it_open() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let forward = vec![
        TreeMutation::upsert(NoteNode::child(id("page"), id("root"), 1_024, "Page")),
        TreeMutation::upsert(NoteNode::child(id("parent"), id("page"), 1_024, "Parent")),
        TreeMutation::upsert(NoteNode::child(id("branch-a"), id("parent"), 1_024, "A")),
        TreeMutation::upsert(todo(id("leaf-a"), id("branch-a"), false)),
        TreeMutation::upsert(NoteNode::child(id("branch-b"), id("parent"), 2_048, "B")),
        TreeMutation::upsert(todo(id("leaf-b"), id("branch-b"), false)),
    ];
    let inverse = forward
        .iter()
        .filter_map(|mutation| match mutation {
            TreeMutation::Upsert(node) => Some(TreeMutation::Delete {
                id: node.id().clone(),
            }),
            TreeMutation::Delete { .. } => None,
        })
        .collect();
    storage
        .commit(
            0,
            &DomainPatch {
                forward,
                inverse,
                carried_pictures: Vec::new(),
            },
        )
        .unwrap();

    set_completed(&storage, &id("leaf-a"), true);

    assert!(is_completed(&storage, &id("branch-a")));
    // `branch-b` is open, so nothing above it may close.
    assert!(!is_completed(&storage, &id("parent")));
    assert!(!is_completed(&storage, &id("page")));
}

#[test]
fn reopening_the_deepest_row_clears_every_ancestor_above_the_window() {
    let storage = stored_chain();
    set_completed(&storage, &id("beyond"), true);

    set_completed(&storage, &chain_id(CHAIN_DEPTH - 1), false);
    for depth in 0..CHAIN_DEPTH {
        assert!(
            !is_completed(&storage, &chain_id(depth)),
            "chain row {depth} stayed ticked over an open row"
        );
    }

    // And back the other way: the last open row settles the whole chain above it,
    // none of which a client could have sent.
    set_completed(&storage, &id("beyond"), true);
    assert!(is_completed(&storage, &chain_id(0)));
}
