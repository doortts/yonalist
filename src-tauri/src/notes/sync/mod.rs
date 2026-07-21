pub(crate) mod bootstrap;
pub(crate) mod exporter;
pub(crate) mod merger;
pub(crate) mod runtime;
pub(crate) mod topic_file;
pub(crate) mod topic_parser;

use rusqlite::{params, Connection, Transaction};

pub(crate) fn topic_metadata_exists(
    connection: &Connection,
    topic_id: &str,
) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_topics WHERE topic_id = ?1)",
        [topic_id],
        |row| row.get(0),
    )
}

pub(crate) fn record_purged_node_ids(
    transaction: &Transaction<'_>,
    node_ids: &[&str],
) -> Result<(), String> {
    if node_ids.is_empty() {
        return Ok(());
    }
    let purge_hlc = crate::notes::hlc::now(transaction)?;
    for node_id in node_ids {
        transaction
            .execute(
                "INSERT INTO sync_purged_tombstones(node_id, purged_hlc) VALUES (?1, ?2) \
                 ON CONFLICT(node_id) DO UPDATE SET purged_hlc = excluded.purged_hlc \
                 WHERE excluded.purged_hlc > sync_purged_tombstones.purged_hlc",
                params![node_id, purge_hlc],
            )
            .map_err(|error| format!("Could not record Notes purge evidence: {error}"))?;
    }
    transaction
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
             ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
            [exporter::TRASH_TOPIC_ID],
        )
        .map_err(|error| format!("Could not dirty Notes trash purge evidence: {error}"))?;
    crate::notes::hlc::persist_clock(transaction)
}
