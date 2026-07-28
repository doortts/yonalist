use std::collections::BTreeSet;

use notes_application::{ForestRequest, ForestSnapshot, NoteView, StorageError};
use rusqlite::{Connection, params};

use crate::repository;

const MAX_FOREST_LIMIT: u32 = 2_000;

pub(crate) fn forest(
    connection: &Connection,
    request: ForestRequest,
) -> Result<ForestSnapshot, StorageError> {
    let revision = repository::revision(connection)?;
    let limit = request.limit.clamp(1, MAX_FOREST_LIMIT) as usize;
    let mut seen = BTreeSet::new();
    let mut nodes = Vec::new();
    let mut complete = true;
    for root_id in request.root_ids {
        if nodes.len() > limit {
            complete = false;
            break;
        }
        let remaining = limit.saturating_sub(nodes.len()) + 1;
        let mut statement = connection
            .prepare(
                "WITH RECURSIVE subtree(id, path) AS (
                    SELECT id, ''
                    FROM notes_nodes
                    WHERE id = ?1 AND kind = 'bullet' AND deleted = 0
                    UNION ALL
                    SELECT child.id,
                           subtree.path || '/' ||
                               CASE WHEN child.sort_key < 0
                                   THEN printf(
                                       '0%019lld:%s',
                                       9223372036854775807 + child.sort_key + 1,
                                       child.id
                                   )
                                   ELSE printf('1%019lld:%s', child.sort_key, child.id)
                               END
                    FROM notes_nodes child
                    JOIN subtree ON child.parent_id = subtree.id
                    WHERE child.deleted = 0
                 )
                 SELECT node.id, node.parent_id, node.sort_key, node.kind, node.text,
                        node.note, node.marker, node.collapsed, node.completed,
                        node.starred, node.deleted
                 FROM subtree
                 JOIN notes_nodes node ON node.id = subtree.id
                 ORDER BY subtree.path
                 LIMIT ?2",
            )
            .map_err(internal)?;
        let root_nodes = statement
            .query_map(
                params![
                    root_id,
                    i64::try_from(remaining).map_err(|_| {
                        StorageError::Internal("forest limit exceeded SQLite INTEGER".into())
                    })?
                ],
                repository::parse_node,
            )
            .map_err(internal)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(internal)?;
        if root_nodes.is_empty() {
            complete = false;
        }
        for node in root_nodes {
            if seen.insert(node.id().clone()) {
                nodes.push(NoteView::from(node));
                if nodes.len() > limit {
                    complete = false;
                    break;
                }
            }
        }
    }
    nodes.truncate(limit);
    Ok(ForestSnapshot {
        revision,
        nodes,
        complete,
    })
}

fn internal(error: rusqlite::Error) -> StorageError {
    StorageError::Internal(error.to_string())
}
