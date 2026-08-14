use std::collections::{BTreeMap, HashMap};

use notes_application::{
    ExportError, ExportImage, ExportNode, ExportSnapshot, MAX_EXPORT_DEPTH, MAX_EXPORT_IMAGES,
    MAX_EXPORT_NODES, StorageError,
};
use notes_core::{NodeId, NoteNode, NoteNodeKind};
use rusqlite::{Connection, params};

use crate::row_mapping::parse_node;

struct StoredNode {
    node: NoteNode,
    depth: usize,
}

pub(crate) fn load(
    connection: &mut Connection,
    expected_revision: u64,
    root_id: &NodeId,
) -> Result<ExportSnapshot, ExportError> {
    let transaction = connection.unchecked_transaction().map_err(internal)?;
    let actual_revision = crate::repository::revision(&transaction)?;
    if actual_revision != expected_revision {
        return Err(StorageError::RevisionConflict {
            expected: expected_revision,
            actual: actual_revision,
        }
        .into());
    }
    let exported_at = transaction
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(internal)?;
    let mut statement = transaction
        .prepare(
            "WITH RECURSIVE subtree(id, path, depth, cycle) AS (
                SELECT id, '|' || id || '|', 1, 0
                FROM notes_nodes
                WHERE id = ?1 AND deleted = 0
                UNION ALL
                SELECT
                    child.id,
                    subtree.path || child.id || '|',
                    subtree.depth + 1,
                    instr(subtree.path, '|' || child.id || '|') > 0
                FROM notes_nodes child
                JOIN subtree ON child.parent_id = subtree.id
                WHERE child.deleted = 0
                  AND subtree.cycle = 0
                  AND subtree.depth <= ?2
             )
             SELECT record.*, subtree.depth, subtree.cycle
             FROM notes_node_records record
             JOIN subtree ON subtree.id = record.id
             ORDER BY record.id
             LIMIT ?3",
        )
        .map_err(internal)?;
    let rows = statement
        .query_map(
            params![
                root_id.as_str(),
                i64::try_from(MAX_EXPORT_DEPTH).expect("export depth fits SQLite INTEGER"),
                i64::try_from(MAX_EXPORT_NODES + 1).expect("export count fits SQLite INTEGER"),
            ],
            |row| {
                Ok((
                    parse_node(row)?,
                    row.get::<_, i64>(20)?,
                    row.get::<_, i64>(21)? != 0,
                ))
            },
        )
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    drop(statement);
    transaction.commit().map_err(internal)?;

    assemble(expected_revision, root_id, exported_at, rows)
}

fn assemble(
    revision: u64,
    root_id: &NodeId,
    exported_at: String,
    rows: Vec<(NoteNode, i64, bool)>,
) -> Result<ExportSnapshot, ExportError> {
    if rows.is_empty() {
        return Err(ExportError::Failed(format!(
            "Note node {root_id} is missing or deleted and cannot be exported."
        )));
    }
    if rows.len() > MAX_EXPORT_NODES {
        return Err(ExportError::TooLarge(format!(
            "Notes export must contain at most {MAX_EXPORT_NODES} nodes."
        )));
    }
    if rows.iter().any(|(_, _, cycle)| *cycle) {
        return Err(ExportError::Failed(
            "The Notes tree contains a cycle and cannot be exported.".into(),
        ));
    }

    let mut image_count = 0usize;
    let mut by_id = BTreeMap::new();
    for (node, depth, _) in rows {
        let depth = usize::try_from(depth).map_err(|_| {
            ExportError::Failed("The Notes export subtree depth is invalid.".into())
        })?;
        if depth == 0 {
            return Err(ExportError::Failed(
                "The Notes export subtree depth is invalid.".into(),
            ));
        }
        if depth > MAX_EXPORT_DEPTH {
            return Err(ExportError::TooLarge(format!(
                "Notes export cannot nest deeper than {MAX_EXPORT_DEPTH} levels."
            )));
        }
        match (node.kind(), node.image()) {
            (NoteNodeKind::Image, Some(_)) => image_count += 1,
            (NoteNodeKind::Image, None) => {
                return Err(ExportError::Failed(format!(
                    "Image node {} has no exportable image metadata.",
                    node.id()
                )));
            }
            (_, Some(_)) => {
                return Err(ExportError::Failed(format!(
                    "Non-image node {} owns unexpected image metadata.",
                    node.id()
                )));
            }
            (_, None) => {}
        }
        let node_id = node.id().clone();
        if by_id
            .insert(node_id.clone(), StoredNode { node, depth })
            .is_some()
        {
            return Err(ExportError::Failed(format!(
                "The Notes export subtree contains duplicate node {node_id}."
            )));
        }
    }
    if image_count > MAX_EXPORT_IMAGES {
        return Err(ExportError::TooLarge(format!(
            "Notes export must contain at most {MAX_EXPORT_IMAGES} image nodes."
        )));
    }

    let mut children: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    for stored in by_id.values() {
        if stored.node.id() == root_id {
            continue;
        }
        let parent_id = stored.node.parent_id().ok_or_else(|| {
            ExportError::Failed(format!(
                "Note node {} has no parent in the export subtree.",
                stored.node.id()
            ))
        })?;
        let parent = by_id.get(parent_id).ok_or_else(|| {
            ExportError::Failed(format!(
                "Note node {} has a missing parent in the export subtree.",
                stored.node.id()
            ))
        })?;
        if parent.depth + 1 != stored.depth {
            return Err(ExportError::Failed(format!(
                "Note node {} has an invalid export depth.",
                stored.node.id()
            )));
        }
        children
            .entry(parent_id.clone())
            .or_default()
            .push(stored.node.id().clone());
    }
    for child_ids in children.values_mut() {
        child_ids.sort_by(|left, right| {
            by_id[left]
                .node
                .sort_key()
                .cmp(&by_id[right].node.sort_key())
                .then_with(|| left.cmp(right))
        });
    }

    let title = by_id
        .get(root_id)
        .map(|stored| stored.node.text().to_owned())
        .ok_or_else(|| {
            ExportError::Failed(format!(
                "Note node {root_id} disappeared from the export subtree."
            ))
        })?;
    let root = build_node(root_id, &mut by_id, &children)?;
    if !by_id.is_empty() {
        return Err(ExportError::Failed(
            "The Notes export subtree could not be assembled safely.".into(),
        ));
    }
    Ok(ExportSnapshot {
        revision,
        root_node_id: root_id.clone(),
        title,
        exported_at,
        root,
    })
}

fn build_node(
    node_id: &NodeId,
    by_id: &mut BTreeMap<NodeId, StoredNode>,
    children: &HashMap<NodeId, Vec<NodeId>>,
) -> Result<ExportNode, ExportError> {
    let stored = by_id.remove(node_id).ok_or_else(|| {
        ExportError::Failed(format!(
            "Note node {node_id} disappeared while building the export snapshot."
        ))
    })?;
    let child_ids = children.get(node_id).cloned().unwrap_or_default();
    let child_nodes = child_ids
        .iter()
        .map(|child_id| build_node(child_id, by_id, children))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ExportNode {
        id: stored.node.id().clone(),
        kind: stored.node.kind(),
        marker: stored.node.marker(),
        text: stored.node.text().to_owned(),
        note: stored.node.note().to_owned(),
        completed: stored.node.is_completed(),
        image: stored.node.image().cloned().map(|metadata| ExportImage {
            metadata,
            bytes: None,
        }),
        children: child_nodes,
    })
}

fn internal(error: rusqlite::Error) -> ExportError {
    StorageError::Internal(error.to_string()).into()
}
