//! Wrapping a merge in everything this crate owns.
//!
//! `notes-sync` decides what a vault file means; it cannot open a transaction,
//! rebuild a derived column, or move the revision, because none of those belong
//! to it. This is the seam: one transaction around the merge, the ancestor
//! paths rebuilt for whatever moved, and the revision advanced only if rows
//! actually changed — a replay that wrote nothing must not invalidate every
//! open session.

use crate::repository::internal;
use notes_application::StorageError;
use notes_sync::document::VaultFile;
use notes_sync::hlc::Clock;
use notes_sync::merger::{MergeInput, MergeOutcome, merge_document};
use rusqlite::Connection;

pub(crate) fn merge(
    connection: &mut Connection,
    clock: &Clock,
    file: &VaultFile,
    input: &MergeInput,
) -> Result<MergeOutcome, StorageError> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(internal)?;
    let outcome = merge_document(&transaction, clock, file, input)
        .map_err(StorageError::Internal)?;
    if outcome.applied == 0 {
        // Nothing was written, so there is nothing to rebuild and nothing for a
        // session to have missed.
        transaction.commit().map_err(internal)?;
        return Ok(outcome);
    }
    // The merge writes rows directly, so the column that says where each node
    // sits in the tree is stale until it is rebuilt — and a merge can reparent
    // anything, so the cheapest correct answer is the whole tree.
    crate::node_paths::rebuild_all(&transaction)?;
    let revision: u64 = transaction
        .query_row(
            "SELECT revision FROM notes_meta WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(internal)
        .map(|value| value as u64)?;
    let next = revision
        .checked_add(1)
        .ok_or_else(|| StorageError::Internal("revision overflowed".into()))?;
    transaction
        .execute(
            "UPDATE notes_meta SET revision = ?1 WHERE singleton = 1",
            [i64::try_from(next)
                .map_err(|_| StorageError::Internal("revision exceeded SQLite INTEGER".into()))?],
        )
        .map_err(internal)?;
    transaction.commit().map_err(internal)?;
    Ok(outcome)
}
