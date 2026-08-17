//! Every attachment this vault holds, and what still points at it.
//!
//! One row per bullet, not one per file: the same picture used on two pages is
//! two rows, because the user finds it by the note they put it in. What they
//! learn from the row is where it is and how big it is — the two questions
//! behind "why is this folder so large".
//!
//! The reference count is counted off the rows every time rather than stored.
//! A stored count that drifts either hides a file nothing points at or deletes
//! one something still needs, and neither is worth the query it saves.

use notes_application::{StorageError, SyncAttachment};
use rusqlite::Connection;

/// Rows nothing points at any more come last regardless of size: they are the
/// ones the user can actually act on, and they are shown with what is left of
/// their two weeks.
const LIST_SQL: &str = "SELECT i.node_id, i.original_name, i.byte_length, i.content_hash,
            n.deleted, n.path,
            (SELECT count(*) FROM notes_images j WHERE j.content_hash = i.content_hash),
            a.unreferenced_at
     FROM notes_images i
     JOIN notes_nodes n ON n.id = i.node_id
     LEFT JOIN sync_assets a ON a.content_hash = i.content_hash
     UNION ALL
     -- Bytes in the vault that no note mentions any more. They have no row to
     -- belong to, which is exactly why they need a line of their own.
     -- The size is the last one any note stated for those bytes. Nothing
     -- points at them now, but the file is the same file, and a list about
     -- what is taking up room cannot show zero for the rows it offers to
     -- delete.
     SELECT '', a.disk_name, coalesce(a.byte_length, 0), a.content_hash, 0, NULL, 0,
            a.unreferenced_at
     FROM sync_assets a
     WHERE a.content_hash NOT IN (SELECT content_hash FROM notes_images)
     ORDER BY 3 DESC, 2
     LIMIT ?1";

pub(crate) fn attachments(
    connection: &Connection,
    limit: u32,
) -> Result<Vec<SyncAttachment>, StorageError> {
    let mut statement = connection.prepare_cached(LIST_SQL).map_err(internal)?;
    let rows = statement
        .query_map([limit], |row| {
            let path: Option<String> = row.get(5)?;
            let (page_id, parent_id) = ancestors(path.as_deref());
            Ok(Row {
                node_id: row.get(0)?,
                name: row.get(1)?,
                byte_length: row.get(2)?,
                content_hash: row.get(3)?,
                trashed: row.get::<_, i64>(4)? == 1,
                page_id,
                parent_id,
                references: row.get::<_, i64>(6)? as u32,
                unreferenced_at: row.get(7)?,
            })
        })
        .map_err(internal)?;
    let mut found = Vec::new();
    for row in rows {
        found.push(row.map_err(internal)?);
    }

    // One more query for every title at once, rather than one per row.
    let wanted: Vec<String> = found
        .iter()
        .flat_map(|row| [row.page_id.clone(), row.parent_id.clone()])
        .filter(|id| !id.is_empty())
        .collect();
    let titles = titles(connection, &wanted)?;
    Ok(found
        .into_iter()
        .map(|row| SyncAttachment {
            node_id: row.node_id,
            name: row.name,
            byte_length: row.byte_length,
            content_hash: row.content_hash,
            page_title: titles.get(&row.page_id).cloned().unwrap_or_default(),
            page_id: row.page_id,
            parent_title: titles.get(&row.parent_id).cloned().unwrap_or_default(),
            references: row.references,
            trashed: row.trashed,
            unreferenced_at: row.unreferenced_at,
        })
        .collect())
}

struct Row {
    node_id: String,
    name: String,
    byte_length: i64,
    content_hash: String,
    trashed: bool,
    page_id: String,
    parent_id: String,
    references: u32,
    unreferenced_at: Option<i64>,
}

/// The materialised path holds every ancestor in order, so the page a node sits
/// on and the bullet above it are read from it rather than climbed to. Each
/// step is `<ordering>:<id>`; the first step is the page, and the last step
/// before the node itself is its parent.
fn ancestors(path: Option<&str>) -> (String, String) {
    let Some(path) = path else {
        return (String::new(), String::new());
    };
    let steps: Vec<&str> = path
        .split('/')
        .filter(|step| !step.is_empty())
        .filter_map(|step| step.split_once(':').map(|(_, id)| id))
        // The path starts at the tree's own root, which is not a page and has
        // no title anyone put there.
        .filter(|id| *id != "root")
        .collect();
    // The node's own step is the last one. A node directly on a page has the
    // page as both, and the list shows the page once.
    let page = steps.first().copied().unwrap_or_default().to_owned();
    let parent = steps
        .len()
        .checked_sub(2)
        .and_then(|index| steps.get(index))
        .copied()
        .unwrap_or_default()
        .to_owned();
    (page, parent)
}

fn titles(
    connection: &Connection,
    ids: &[String],
) -> Result<std::collections::BTreeMap<String, String>, StorageError> {
    if ids.is_empty() {
        return Ok(std::collections::BTreeMap::new());
    }
    let list = notes_sync::export::json_list(ids);
    let mut statement = connection
        .prepare_cached(
            "SELECT id, text FROM notes_nodes
             WHERE id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(internal)?;
    let rows = statement
        .query_map([list], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(internal)?;
    let mut titles = std::collections::BTreeMap::new();
    for row in rows {
        let (id, text) = row.map_err(internal)?;
        titles.insert(id, text);
    }
    Ok(titles)
}

/// Removes an attachment nothing points at. Refused while anything still does:
/// the count is taken here, inside the same transaction as the removal, so it
/// cannot be answered from a stale list the user is looking at.
pub(crate) fn delete_attachment(
    connection: &mut Connection,
    content_hash: &str,
    vault_root: Option<&std::path::Path>,
) -> Result<bool, StorageError> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(internal)?;
    let still_used: i64 = transaction
        .query_row(
            "SELECT count(*) FROM notes_images WHERE content_hash = ?1",
            [content_hash],
            |row| row.get(0),
        )
        .map_err(internal)?;
    if still_used > 0 {
        return Ok(false);
    }
    let location: Option<String> = transaction
        .query_row(
            "SELECT location FROM sync_assets WHERE content_hash = ?1",
            [content_hash],
            |row| row.get(0),
        )
        .map_err(internal)?;
    transaction
        .prepare_cached("DELETE FROM sync_assets WHERE content_hash = ?1")
        .and_then(|mut statement| statement.execute([content_hash]))
        .map_err(internal)?;
    transaction.commit().map_err(internal)?;

    // The record first, the bytes after: a removal that stops halfway leaves a
    // file nothing mentions, which the next pass reports as unreferenced. The
    // other order leaves a record pointing at nothing.
    if let (Some(vault_root), Some(location)) = (vault_root, location.filter(|at| !at.is_empty()))
        && let Ok(path) = notes_sync::file_io::inside_vault(vault_root, &vault_root.join(&location))
    {
        let _ = std::fs::remove_file(path);
    }
    Ok(true)
}

fn internal(error: rusqlite::Error) -> StorageError {
    StorageError::Internal(error.to_string())
}
