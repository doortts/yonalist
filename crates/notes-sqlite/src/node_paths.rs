use std::collections::{BTreeMap, BTreeSet};

use notes_application::StorageError;
use notes_core::{DomainPatch, TreeMutation};
use rusqlite::Transaction;

use crate::repository::internal;

/// Rewrites `path` for one node and everything below it. The seed's own prefix
/// is climbed from the row up to the tree root rather than read out of the
/// parent's stored `path`, so two rebuilds inside one transaction cannot see
/// each other's half-written state and the call order stops mattering.
///
/// A trashed row contributes NULL, and NULL swallows every concatenation that
/// carries it, which prunes exactly the branches the viewport CTE's
/// `deleted = 0` filter drops.
const REBUILD: &str = "WITH RECURSIVE climb(seed, parent_id, path) AS (
        SELECT node.id, node.parent_id,
               CASE WHEN node.deleted = 1 THEN NULL
                   WHEN node.sort_key < 0
                   THEN printf(
                       '0%019lld:%s',
                       9223372036854775807 + node.sort_key + 1,
                       node.id
                   )
                   ELSE printf('1%019lld:%s', node.sort_key, node.id)
               END
        FROM notes_nodes node
        WHERE node.id = ?1
        UNION ALL
        SELECT climb.seed, parent.parent_id,
               CASE WHEN parent.deleted = 1 THEN NULL
                   WHEN parent.sort_key < 0
                   THEN printf(
                       '0%019lld:%s',
                       9223372036854775807 + parent.sort_key + 1,
                       parent.id
                   )
                   ELSE printf('1%019lld:%s', parent.sort_key, parent.id)
               END || '/' || climb.path
        FROM notes_nodes parent
        JOIN climb ON parent.id = climb.parent_id
     ),
     subtree(id, path) AS (
        SELECT seed, path FROM climb WHERE parent_id IS NULL
        UNION ALL
        SELECT child.id,
               subtree.path || '/' ||
                   CASE WHEN child.deleted = 1 THEN NULL
                       WHEN child.sort_key < 0
                       THEN printf(
                           '0%019lld:%s',
                           9223372036854775807 + child.sort_key + 1,
                           child.id
                       )
                       ELSE printf('1%019lld:%s', child.sort_key, child.id)
                   END
        FROM notes_nodes child
        JOIN subtree ON child.parent_id = subtree.id
     )
     UPDATE notes_nodes SET path = subtree.path
     FROM subtree
     WHERE notes_nodes.id = subtree.id";

/// Restores `path` for every row a committed patch can have moved. A patch only
/// carries the rows that changed, so a move arrives without the descendants
/// whose paths it just invalidated; each seed therefore rewrites a whole
/// subtree.
pub(crate) fn refresh(
    transaction: &Transaction<'_>,
    patch: &DomainPatch,
) -> Result<(), StorageError> {
    // The state each upserted row is coming from, which the insert-or-update
    // decision in `commit` already reads this same patch for.
    let previous = patch
        .inverse
        .iter()
        .filter_map(|mutation| match mutation {
            TreeMutation::Upsert(node) => Some((node.id(), node.as_ref())),
            TreeMutation::Delete { .. } => None,
        })
        .collect::<BTreeMap<_, _>>();
    // The rows `commit` inserts. A coalesced group can carry both an inverse
    // delete and an inverse upsert for one id -- dropping a row and writing it
    // back is one such group -- and the row that comes back in is a fresh insert
    // with no path, however little its own fields moved.
    let inserted = patch
        .inverse
        .iter()
        .filter_map(|mutation| match mutation {
            TreeMutation::Delete { id } => Some(id),
            TreeMutation::Upsert(_) => None,
        })
        .collect::<BTreeSet<_>>();
    // A path is built out of a row's parent, its sort key, its id and whether it
    // sits in the trash. Everything else a patch carries -- text, marker, the
    // flags -- leaves the whole branch exactly where it was, and that is most of
    // what a session writes. A row with no previous state is rewritten.
    let moved = patch
        .forward
        .iter()
        .filter_map(|mutation| match mutation {
            TreeMutation::Upsert(node) => Some(node.as_ref()),
            TreeMutation::Delete { .. } => None,
        })
        .filter(|node| {
            inserted.contains(node.id())
                || previous.get(node.id()).is_none_or(|before| {
                    before.parent_id() != node.parent_id()
                        || before.sort_key() != node.sort_key()
                        || before.is_deleted() != node.is_deleted()
                })
        })
        .collect::<Vec<_>>();
    let moved_ids = moved.iter().map(|node| node.id()).collect::<BTreeSet<_>>();
    for node in &moved {
        // Skipping the rows a coarser seed already covers is what keeps a
        // subtree delete, which flags every descendant, from walking the
        // subtree once per row.
        // ponytail: only the parent is checked, so a patch that moves a branch
        // and re-keys something deeper inside the same branch walks the overlap
        // twice. Climb the whole chain here if a command makes that shape common.
        if node
            .parent_id()
            .is_some_and(|parent_id| moved_ids.contains(parent_id))
        {
            continue;
        }
        rebuild(transaction, node.id().as_str())?;
    }
    Ok(())
}

/// Rebuilds every path in the database, walking down from each parentless row.
pub(crate) fn rebuild_all(transaction: &Transaction<'_>) -> Result<(), StorageError> {
    let mut statement = transaction
        .prepare("SELECT id FROM notes_nodes WHERE parent_id IS NULL")
        .map_err(internal)?;
    let roots = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    for root_id in roots {
        rebuild(transaction, &root_id)?;
    }
    Ok(())
}

/// One subtree from its seed down. Also called with a bare id by the delete
/// path, which trashes a row without upserting it: the window has no `deleted`
/// predicate, so a trashed row leaves the page by having no path at all.
pub(crate) fn rebuild(transaction: &Transaction<'_>, seed_id: &str) -> Result<(), StorageError> {
    transaction
        .prepare_cached(REBUILD)
        .and_then(|mut statement| statement.execute([seed_id]))
        .map_err(internal)?;
    Ok(())
}
