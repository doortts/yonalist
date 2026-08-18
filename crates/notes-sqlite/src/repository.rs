use std::collections::{BTreeMap, BTreeSet};

use notes_application::StorageError;
use notes_core::{
    NodeId, NoteMarkerKind, NoteNode, NotesCommand, NotesTree, Position, SORT_KEY_STEP,
    TreeMutation,
};
use rusqlite::{Connection, OptionalExtension, params};

pub(crate) use crate::row_mapping::{internal, kind_name, parse_node, parse_revision};

pub(crate) fn revision(connection: &Connection) -> Result<u64, StorageError> {
    connection
        .query_row(
            "SELECT revision FROM notes_meta WHERE singleton = 1",
            [],
            parse_revision,
        )
        .map_err(internal)
}

pub(crate) fn node(connection: &Connection, id: &str) -> Result<Option<NoteNode>, StorageError> {
    connection
        .query_row(
            "SELECT * FROM notes_node_records WHERE id = ?1",
            [id],
            parse_node,
        )
        .optional()
        .map_err(internal)
}

pub(crate) fn live_image_hashes(connection: &Connection) -> Result<BTreeSet<String>, StorageError> {
    let mut statement = connection
        .prepare("SELECT DISTINCT content_hash FROM notes_images ORDER BY content_hash")
        .map_err(internal)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(internal)?;
    rows.collect::<Result<BTreeSet<_>, _>>().map_err(internal)
}

pub(crate) fn load_command_tree(
    connection: &Connection,
    command: &NotesCommand,
) -> Result<NotesTree, StorageError> {
    let mut nodes = BTreeMap::new();
    collect_command_context(connection, command, &mut nodes)?;
    let mut tree = NotesTree::default();
    let mutations = nodes
        .into_values()
        .map(TreeMutation::upsert)
        .collect::<Vec<_>>();
    tree.apply(&mutations).map_err(StorageError::Domain)?;
    Ok(tree)
}

fn collect_command_context(
    connection: &Connection,
    command: &NotesCommand,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    match command {
        NotesCommand::Batch { commands } => {
            for command in commands {
                collect_command_context(connection, command, nodes)?;
            }
        }
        NotesCommand::CreateNode {
            id,
            parent_id,
            position,
            ..
        } => {
            // Ancestors rather than the row alone: when the proposed id is
            // already taken somewhere else in the tree, the domain can only
            // report the collision if that node arrives with its parent chain.
            collect_ancestors(connection, id, nodes)?;
            collect_ancestors(connection, parent_id, nodes)?;
            collect_position_context(connection, parent_id, position, None, nodes)?;
        }
        NotesCommand::ImportNodes {
            parent_id,
            nodes: imported,
            ..
        } => {
            collect_ancestors(connection, parent_id, nodes)?;
            collect_children(connection, parent_id, nodes)?;
            for node in imported {
                collect_node(connection, &node.id, nodes)?;
            }
        }
        NotesCommand::ImportImages {
            parent_id,
            nodes: imported,
            ..
        } => {
            collect_ancestors(connection, parent_id, nodes)?;
            collect_children(connection, parent_id, nodes)?;
            for node in imported {
                collect_node(connection, &node.id, nodes)?;
            }
        }
        NotesCommand::UpdateText { id, .. }
        | NotesCommand::UpdateNote { id, .. }
        | NotesCommand::ResizeImage { id, .. }
        | NotesCommand::ReplaceImage { id, .. }
        | NotesCommand::SetStarred { id, .. }
        | NotesCommand::SetCollapsed { id, .. }
        | NotesCommand::SetMarker { id, .. } => {
            collect_ancestors(connection, id, nodes)?;
        }
        NotesCommand::SetCompleted { id, .. } => {
            collect_todo_chain(connection, id, nodes)?;
        }
        NotesCommand::SetCompletedMany { ids, .. } => {
            // Every listed row cascades the way a single tick does, so each one
            // brings its own chain along. A selection usually sits inside one
            // chain, so the roots are collected first and each subtree is read
            // once instead of once per selected row.
            for id in ids {
                collect_ancestors(connection, id, nodes)?;
            }
            let roots = ids
                .iter()
                .map(|id| todo_chain_root(nodes, id))
                .collect::<BTreeSet<_>>();
            for root in &roots {
                collect_descendants(connection, root, nodes)?;
            }
        }
        NotesCommand::SplitNode {
            id,
            new_id,
            parent_id,
            position,
            ..
        } => {
            collect_node(connection, new_id, nodes)?;
            collect_ancestors(connection, id, nodes)?;
            collect_ancestors(connection, parent_id, nodes)?;
            collect_position_context(connection, parent_id, position, None, nodes)?;
        }
        NotesCommand::MergeNodeBackward {
            id, previous_id, ..
        } => {
            collect_ancestors(connection, id, nodes)?;
            collect_ancestors(connection, previous_id, nodes)?;
            if let Some(parent_id) = nodes.get(id).and_then(NoteNode::parent_id).cloned() {
                collect_children(connection, &parent_id, nodes)?;
            }
            collect_children(connection, previous_id, nodes)?;
        }
        NotesCommand::RemoveEmptyNode { id } => {
            collect_remove_context(connection, id, nodes)?;
        }
        // The same slice the blank-row removal needs -- the row, its ancestors
        // (the parent among them), its children, and the sibling after it.
        NotesCommand::MergeNodeIntoParent { id, .. } => {
            collect_remove_context(connection, id, nodes)?;
        }
        NotesCommand::MoveNode {
            id,
            parent_id,
            position,
        } => {
            collect_move_context(connection, id, parent_id, position, nodes)?;
        }
        NotesCommand::MoveNodes { moves } => {
            let target_parents = moves
                .iter()
                .map(|node_move| &node_move.parent_id)
                .collect::<BTreeSet<_>>();
            for parent_id in target_parents {
                collect_children(connection, parent_id, nodes)?;
            }
            for node_move in moves {
                collect_move_context(
                    connection,
                    &node_move.id,
                    &node_move.parent_id,
                    &node_move.position,
                    nodes,
                )?;
            }
        }
        NotesCommand::IndentNode { id, parent_id } => {
            collect_ancestors(connection, id, nodes)?;
            collect_ancestors(connection, parent_id, nodes)?;
            collect_descendants(connection, id, nodes)?;
            collect_position_context(connection, parent_id, &Position::at_end(), Some(id), nodes)?;
        }
        NotesCommand::DuplicateNode {
            source_id,
            new_id,
            parent_id,
            position,
        } => {
            collect_duplicate_context(connection, source_id, new_id, parent_id, position, nodes)?;
        }
        NotesCommand::DuplicateNodes { duplicates } => {
            let target_parents = duplicates
                .iter()
                .map(|duplicate| &duplicate.parent_id)
                .collect::<BTreeSet<_>>();
            for parent_id in target_parents {
                collect_children(connection, parent_id, nodes)?;
            }
            for duplicate in duplicates {
                collect_duplicate_context(
                    connection,
                    &duplicate.source_id,
                    &duplicate.new_id,
                    &duplicate.parent_id,
                    &duplicate.position,
                    nodes,
                )?;
            }
        }
        NotesCommand::DeleteSubtree { id } | NotesCommand::RestoreSubtree { id } => {
            collect_ancestors(connection, id, nodes)?;
            collect_descendants(connection, id, nodes)?;
        }
        NotesCommand::DeleteSubtrees { ids } => {
            for id in ids {
                collect_ancestors(connection, id, nodes)?;
                collect_descendants(connection, id, nodes)?;
            }
        }
    }
    Ok(())
}

/// A tick settles the whole Todo chain the row sits in, so the working set is
/// that chain and not the row alone. Ancestors load first: the climb to the
/// chain's top reads their markers.
fn collect_todo_chain(
    connection: &Connection,
    id: &NodeId,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    collect_ancestors(connection, id, nodes)?;
    let chain_root = todo_chain_root(nodes, id);
    collect_descendants(connection, &chain_root, nodes)
}

/// The highest Todo an unbroken chain of Todo parents reaches from `id` -- the
/// row whose descendants a completion cascade may touch. `id` itself when its
/// parent is not a live Todo. Reads the already-loaded ancestors.
fn todo_chain_root(nodes: &BTreeMap<NodeId, NoteNode>, id: &NodeId) -> NodeId {
    let mut root = id.clone();
    let mut visited = BTreeSet::new();
    while visited.insert(root.clone()) {
        let Some(parent) = nodes
            .get(&root)
            .and_then(NoteNode::parent_id)
            .and_then(|parent_id| nodes.get(parent_id))
        else {
            break;
        };
        if parent.is_deleted() || parent.marker() != NoteMarkerKind::Todo {
            break;
        }
        root = parent.id().clone();
    }
    root
}

fn collect_move_context(
    connection: &Connection,
    id: &NodeId,
    parent_id: &NodeId,
    position: &Position,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    collect_ancestors(connection, id, nodes)?;
    collect_ancestors(connection, parent_id, nodes)?;
    collect_descendants(connection, id, nodes)?;
    collect_position_context(connection, parent_id, position, Some(id), nodes)
}

fn collect_duplicate_context(
    connection: &Connection,
    source_id: &NodeId,
    new_id: &NodeId,
    parent_id: &NodeId,
    position: &Position,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    collect_duplicate_namespace(connection, new_id, nodes)?;
    collect_ancestors(connection, source_id, nodes)?;
    collect_descendants(connection, source_id, nodes)?;
    collect_ancestors(connection, parent_id, nodes)?;
    collect_position_context(connection, parent_id, position, None, nodes)
}

fn collect_remove_context(
    connection: &Connection,
    id: &NodeId,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    collect_ancestors(connection, id, nodes)?;
    let Some(source) = nodes.get(id).cloned() else {
        return Ok(());
    };
    let Some(parent_id) = source.parent_id().cloned() else {
        return Ok(());
    };
    collect_children(connection, id, nodes)?;
    let child_count = nodes
        .values()
        .filter(|node| node.parent_id() == Some(id))
        .count();
    if child_count == 0 {
        return Ok(());
    }
    let next = connection
        .query_row(
            "SELECT *
             FROM notes_node_records
             WHERE parent_id = ?1
               AND (sort_key > ?2 OR (sort_key = ?2 AND id > ?3))
             ORDER BY sort_key, id
             LIMIT 1",
            params![parent_id.as_str(), source.sort_key(), source.id().as_str()],
            parse_node,
        )
        .optional()
        .map_err(internal)?;
    let child_count = i64::try_from(child_count)
        .map_err(|_| StorageError::Internal("child count exceeded SQLite INTEGER".into()))?;
    let needs_rebalance = match next.as_ref() {
        Some(next) => next
            .sort_key()
            .checked_sub(source.sort_key())
            .is_none_or(|gap| gap <= child_count),
        None => child_count
            .checked_mul(SORT_KEY_STEP)
            .and_then(|offset| source.sort_key().checked_add(offset))
            .is_none(),
    };
    if let Some(next) = next {
        nodes.insert(next.id().clone(), next);
    }
    if needs_rebalance {
        collect_children(connection, &parent_id, nodes)?;
    }
    Ok(())
}

fn collect_node(
    connection: &Connection,
    id: &NodeId,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    if let Some(node) = node(connection, id.as_str())? {
        nodes.insert(node.id().clone(), node);
    }
    Ok(())
}

fn collect_duplicate_namespace(
    connection: &Connection,
    new_id: &NodeId,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    let mut statement = connection
        .prepare(
            "SELECT *
             FROM notes_node_records
             WHERE id = ?1 OR substr(id, 1, length(?1) + 1) = ?1 || '/'",
        )
        .map_err(internal)?;
    let candidates = statement
        .query_map([new_id.as_str()], parse_node)
        .map_err(internal)?;
    for candidate in candidates {
        let candidate = candidate.map_err(internal)?;
        nodes.insert(candidate.id().clone(), candidate);
    }
    Ok(())
}

fn collect_ancestors(
    connection: &Connection,
    id: &NodeId,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    let mut current = Some(id.clone());
    let mut visited = BTreeSet::new();
    while let Some(id) = current {
        if !visited.insert(id.clone()) {
            break;
        }
        // A row another collector already put in the map — an id-collision
        // probe, say — arrives without its parents, so the walk goes through it
        // instead of stopping: the loaded slice always reaches the root.
        current = match nodes.get(&id) {
            Some(node) => node.parent_id().cloned(),
            None => {
                let Some(node) = node(connection, id.as_str())? else {
                    break;
                };
                let parent_id = node.parent_id().cloned();
                nodes.insert(id, node);
                parent_id
            }
        };
    }
    Ok(())
}

fn collect_children(
    connection: &Connection,
    parent_id: &NodeId,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    let mut statement = connection
        .prepare(
            "SELECT *
             FROM notes_node_records
             WHERE parent_id = ?1
             ORDER BY sort_key, id",
        )
        .map_err(internal)?;
    let children = statement
        .query_map([parent_id.as_str()], parse_node)
        .map_err(internal)?;
    for child in children {
        let child = child.map_err(internal)?;
        nodes.insert(child.id().clone(), child);
    }
    Ok(())
}

fn collect_position_context(
    connection: &Connection,
    parent_id: &NodeId,
    position: &Position,
    excluded_id: Option<&NodeId>,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    match position {
        Position::AtEnd => {
            let last = connection
                .query_row(
                    "SELECT *
                     FROM notes_node_records
                     WHERE parent_id = ?1 AND (?2 IS NULL OR id <> ?2)
                     ORDER BY sort_key DESC, id DESC
                     LIMIT 1",
                    params![parent_id.as_str(), excluded_id.map(NodeId::as_str)],
                    parse_node,
                )
                .optional()
                .map_err(internal)?;
            if let Some(last) = last {
                let needs_rebalance = last.sort_key().checked_add(SORT_KEY_STEP).is_none();
                nodes.insert(last.id().clone(), last);
                if needs_rebalance {
                    collect_children(connection, parent_id, nodes)?;
                }
            }
        }
        Position::Before { sibling_id } => {
            let sibling = node(connection, sibling_id.as_str())?;
            let Some(sibling) = sibling else {
                return Ok(());
            };
            let previous = connection
                .query_row(
                    "SELECT *
                     FROM notes_node_records
                     WHERE parent_id = ?1
                       AND (?2 IS NULL OR id <> ?2)
                       AND (
                         sort_key < ?3 OR (sort_key = ?3 AND id < ?4)
                       )
                     ORDER BY sort_key DESC, id DESC
                     LIMIT 1",
                    params![
                        parent_id.as_str(),
                        excluded_id.map(NodeId::as_str),
                        sibling.sort_key(),
                        sibling.id().as_str(),
                    ],
                    parse_node,
                )
                .optional()
                .map_err(internal)?;
            let needs_rebalance = match previous.as_ref() {
                Some(previous) => sibling
                    .sort_key()
                    .checked_sub(previous.sort_key())
                    .is_none_or(|gap| gap <= 1),
                None => sibling.sort_key().checked_sub(SORT_KEY_STEP).is_none(),
            };
            nodes.insert(sibling.id().clone(), sibling);
            if let Some(previous) = previous {
                nodes.insert(previous.id().clone(), previous);
            }
            if needs_rebalance {
                collect_children(connection, parent_id, nodes)?;
            }
        }
    }
    Ok(())
}

fn collect_descendants(
    connection: &Connection,
    root_id: &NodeId,
    nodes: &mut BTreeMap<NodeId, NoteNode>,
) -> Result<(), StorageError> {
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE descendants(id) AS (
                SELECT id FROM notes_nodes WHERE id = ?1
                UNION ALL
                SELECT child.id
                FROM notes_nodes child
                JOIN descendants parent ON child.parent_id = parent.id
             )
             SELECT node.*
             FROM notes_node_records node
             JOIN descendants ON descendants.id = node.id",
        )
        .map_err(internal)?;
    let descendants = statement
        .query_map([root_id.as_str()], parse_node)
        .map_err(internal)?;
    for descendant in descendants {
        let descendant = descendant.map_err(internal)?;
        nodes.insert(descendant.id().clone(), descendant);
    }
    Ok(())
}
