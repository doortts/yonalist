pub(crate) mod asset_gc;
pub(crate) mod bootstrap;
pub(crate) mod exporter;
pub(crate) mod merger;
pub(crate) mod runtime;
pub(crate) mod topic_file;
pub(crate) mod topic_parser;
pub(crate) mod watcher;

#[cfg(test)]
mod integration_tests;

use rusqlite::{params, Connection, Transaction};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Retain purge evidence long enough for a normally offline device to receive
/// it, then allow an older trash snapshot to restore its deleted node. HLC
/// timestamps are fixed-width and are the sole durable time source here; do
/// not use the local SQLite insertion time because a later import may carry
/// an older purge.
const PURGED_TOMBSTONE_RETENTION_MILLIS: u64 = 90 * 24 * 60 * 60 * 1_000;

pub(crate) fn prune_expired_purged_tombstones(connection: &Connection) -> Result<usize, String> {
    prune_expired_purged_tombstones_at(connection, current_purge_evidence_millis()?)
}

pub(crate) fn current_purge_evidence_millis() -> Result<u64, String> {
    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(now_millis)
        .map_err(|_| "System time exceeds the Notes purge-evidence range.".to_string())
}

pub(crate) fn purged_tombstone_is_expired_at(purged_hlc: &str, now_millis: u64) -> bool {
    let cutoff = now_millis.saturating_sub(PURGED_TOMBSTONE_RETENTION_MILLIS);
    crate::notes::hlc::Hlc::decode(purged_hlc).is_ok_and(|hlc| hlc.millis < cutoff)
}

fn prune_expired_purged_tombstones_at(
    connection: &Connection,
    now_millis: u64,
) -> Result<usize, String> {
    let mut statement = connection
        .prepare("SELECT node_id, purged_hlc FROM sync_purged_tombstones ORDER BY node_id")
        .map_err(|error| format!("Could not prepare Notes purge-evidence pruning: {error}"))?;
    let expired = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not inspect Notes purge evidence: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes purge evidence: {error}"))?
        .into_iter()
        .filter(|(_, purged_hlc)| purged_tombstone_is_expired_at(purged_hlc, now_millis))
        .collect::<Vec<_>>();
    drop(statement);

    if expired.is_empty() {
        return Ok(0);
    }
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Could not start Notes purge-evidence pruning: {error}"))?;
    let mut removed = 0;
    for (node_id, purged_hlc) in expired {
        removed += transaction
            .execute(
                "DELETE FROM sync_purged_tombstones WHERE node_id = ?1 AND purged_hlc = ?2",
                params![node_id, purged_hlc],
            )
            .map_err(|error| format!("Could not remove expired Notes purge evidence: {error}"))?;
    }
    if removed != 0 {
        transaction
            .execute(
                "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                 ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                [exporter::TRASH_TOPIC_ID],
            )
            .map_err(|error| format!("Could not schedule pruned Notes trash export: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit Notes purge-evidence pruning: {error}"))?;
    Ok(removed)
}
