//! Wrapping a merge in everything this crate owns.
//!
//! `notes-sync` decides what a vault file means; it cannot open a transaction,
//! rebuild a derived column, or move the revision, because none of those belong
//! to it. This is the seam: one transaction around the merge, the ancestor
//! paths rebuilt for whatever moved, and the revision advanced only if rows
//! actually changed — a replay that wrote nothing must not invalidate every
//! open session.

use crate::repository::internal;
use notes_application::{StorageError, SyncConflict};
use notes_sync::document::VaultFile;
use notes_sync::hlc::Clock;
use notes_sync::merger::{MergeInput, MergeOutcome, merge_document};
use rusqlite::{Connection, OptionalExtension};

pub(crate) fn merge(
    connection: &mut Connection,
    clock: &Clock,
    file: &VaultFile,
    input: &MergeInput,
) -> Result<MergeOutcome, StorageError> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(internal)?;
    let outcome =
        merge_document(&transaction, clock, file, input).map_err(StorageError::Internal)?;
    // Trimmed by the same write that could breach the bound — and a merge can
    // record a defeat while writing no rows at all, which is exactly what an
    // older file arriving does.
    if outcome.conflicts_recorded > 0 {
        prune_conflicts(&transaction)?;
    }
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

/// How much of the audit log is worth keeping. Past either bound it costs more
/// than it settles: nobody restores a defeat from six months ago, and a log
/// that grows without limit eventually dwarfs the notes it is about.
const MAX_CONFLICTS: usize = 1_000;
const MAX_CONFLICT_AGE_SECONDS: i64 = 180 * 24 * 60 * 60;

pub(crate) fn conflicts(
    connection: &Connection,
    limit: u32,
) -> Result<Vec<SyncConflict>, StorageError> {
    // Age is swept here too: a vault that stops having disagreements would
    // otherwise keep the last ones forever.
    connection
        .execute(
            "DELETE FROM sync_conflict_log WHERE recorded_at < unixepoch() - ?1",
            [MAX_CONFLICT_AGE_SECONDS],
        )
        .map_err(internal)?;
    let mut statement = connection
        .prepare(
            "SELECT seq, node_id, loser_json, recorded_at FROM sync_conflict_log
             ORDER BY seq DESC LIMIT ?1",
        )
        .map_err(internal)?;
    let rows = statement
        .query_map([limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(internal)?;
    let mut out = Vec::new();
    for row in rows {
        let (seq, node_id, loser_json, recorded_at) = row.map_err(internal)?;
        let loser: serde_json::Value = serde_json::from_str(&loser_json).map_err(|error| {
            StorageError::Internal(format!("a recorded defeat is not readable: {error}"))
        })?;
        out.push(SyncConflict {
            seq,
            node_id,
            text: loser
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_owned(),
            reason: loser
                .get("reason")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_owned(),
            recorded_at,
        });
    }
    Ok(out)
}

/// What a defeat said, for whoever is putting it back. The write itself is not
/// this crate's to make: a restore is an edit, and an edit that moved the
/// revision without telling the session would leave every later one failing.
pub(crate) fn conflict_loser(
    connection: &Connection,
    seq: i64,
) -> Result<Option<(String, String)>, StorageError> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT node_id, loser_json FROM sync_conflict_log WHERE seq = ?1",
            [seq],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(internal)?;
    let Some((node_id, loser_json)) = row else {
        return Ok(None);
    };
    let loser: serde_json::Value = serde_json::from_str(&loser_json).map_err(|error| {
        StorageError::Internal(format!("a recorded defeat is not readable: {error}"))
    })?;
    Ok(Some((
        node_id,
        loser
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_owned(),
    )))
}

/// Trimmed after every merge that recorded something, so the bound is kept by
/// the same write that could breach it.
fn prune_conflicts(transaction: &rusqlite::Transaction<'_>) -> Result<(), StorageError> {
    transaction
        .execute(
            "DELETE FROM sync_conflict_log
             WHERE recorded_at < unixepoch() - ?1
                OR seq <= (
                    SELECT seq FROM sync_conflict_log
                    ORDER BY seq DESC LIMIT 1 OFFSET ?2
                )",
            rusqlite::params![MAX_CONFLICT_AGE_SECONDS, MAX_CONFLICTS as i64],
        )
        .map_err(internal)?;
    Ok(())
}

/// Writes everything waiting into the vault.
///
/// The revision does not move: writing the notes down did not change them, and
/// a bump here would invalidate every open session for no reason at all. The
/// documents a set of dirty rows belongs to are resolved in one question.
pub(crate) fn export_pending(
    connection: &mut Connection,
    vault_root: &std::path::Path,
    store_root: &std::path::Path,
) -> Result<usize, StorageError> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(internal)?;
    // Before the documents, because a document's image line states where the
    // attachment pass put the bytes.
    notes_sync::attachments::place_attachments(&transaction, vault_root, store_root)
        .map_err(StorageError::Internal)?;
    // Order does not matter among the documents: each carries its own marks,
    // and home derives a page's folder the same way the page export does.
    let pending =
        notes_sync::export::pending_documents(&transaction).map_err(StorageError::Internal)?;
    let mut written = 0;
    for root_id in pending {
        // Per document: one that cannot be written — an image row stating a
        // path this format never writes, say — must not take every other
        // document down with it, home and the trash included. It keeps its
        // dirty marks and is tried again next time.
        let outcome = match root_id.as_str() {
            "yonalist-trash" => notes_sync::export::export_trash(&transaction, vault_root),
            "root" => notes_sync::export::export_home(&transaction, vault_root),
            id => notes_sync::export::export_document(&transaction, vault_root, id),
        };
        match outcome {
            Ok(outcome) if outcome.written => written += 1,
            Ok(_) => {}
            Err(_reason) => continue,
        }
    }
    notes_sync::export::retire_missing_documents(&transaction, vault_root)
        .map_err(StorageError::Internal)?;
    transaction.commit().map_err(internal)?;
    Ok(written)
}

/// Reads every document in the vault back in, ignoring what the records say
/// about them — the last net under the startup scan's stat gate.
///
/// Refused while this device is still holding edits it has not written out.
/// A reindex treats the vault as the truth, and the vault does not yet know
/// about those edits, so running it then would throw them away.
pub(crate) fn reindex_vault(
    connection: &mut Connection,
    clock: &Clock,
    vault_root: &std::path::Path,
) -> Result<usize, StorageError> {
    let waiting: i64 = connection
        .query_row("SELECT count(*) FROM sync_dirty_nodes", [], |row| {
            row.get(0)
        })
        .map_err(internal)?;
    if waiting > 0 {
        return Err(StorageError::Internal(
            "This device is still holding edits the vault has not been told about. \
             They have to be written out before the vault can be read as the truth."
                .to_owned(),
        ));
    }
    let mut merged = 0;
    let mut stack = vec![vault_root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(at) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&at) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|extension| extension == "md") {
                files.push(path);
            }
        }
    }
    files.sort();
    for path in files {
        // Every file, by content: this is what closes the gap the scan gate
        // leaves for a change that kept both its mtime and its size.
        let Ok(bytes) = notes_sync::file_io::read_regular_bounded(
            vault_root,
            &path,
            notes_sync::parse::MAX_FILE_BYTES,
        ) else {
            continue;
        };
        let Ok(file) = notes_sync::parse::parse(&bytes) else {
            continue;
        };
        let relative = path
            .strip_prefix(vault_root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        let input = notes_sync::merger::MergeInput {
            file_path: relative,
            file_hash: notes_sync::export::hash_bytes(&bytes),
            file_mtime_ms: None,
            file_size: None,
        };
        if merge(connection, clock, &file, &input)?.applied > 0 {
            merged += 1;
        }
    }
    Ok(merged)
}
