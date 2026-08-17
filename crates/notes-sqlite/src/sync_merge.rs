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
use std::collections::BTreeSet;

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
    bump_revision(&transaction)?;
    transaction.commit().map_err(internal)?;
    Ok(outcome)
}

/// What a session reads to know it has missed something. Only a caller that
/// actually wrote rows may move it: a replay is not an edit.
fn bump_revision(transaction: &rusqlite::Transaction<'_>) -> Result<(), StorageError> {
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
    Ok(())
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
    // Before the queue is read: a page that stopped being a page has to be out
    // of the way for the render that states its notes in their new home.
    notes_sync::export::begin_retirement(&transaction).map_err(StorageError::Internal)?;
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
/// An attachment's bytes arrived. Every image row still waiting for them —
/// its link names this file and it has no hash of its own yet — learns the
/// hash, and the app's own store is now where those bytes live.
///
/// The name carries the first twelve characters of the hash, so bytes that do
/// not hash to it are not the bytes those lines are about, whatever the file
/// is called. Nothing is resolved then: the rows go on waiting for the file
/// they asked for.
///
/// The answer names the rows rather than counting them, because that is what
/// the window needs to redraw those notes instead of re-reading the page.
/// There can be more than one: the same picture pasted onto two notes leaves
/// two rows waiting for the same file, and both stop waiting together. A set
/// because that is the shape `MergeOutcome` reports ids in — `settled_ids`
/// rather than `changed_ids`: the window redraws these, and nobody edited
/// them, so no history entry falls out of reach for them.
///
/// Named are the rows a window can draw, so a note the trash holds learns its
/// hash and is left out of the answer. The learning is unconditional on
/// purpose: the arrival records the bytes once and no later sweep offers them
/// again, so a row that skipped it would draw a placeholder for ever over a
/// picture the store is holding, and the attachment list would read those
/// bytes as an orphan nobody points at.
pub(crate) fn resolve_asset(
    connection: &mut Connection,
    disk_name: &str,
    content_hash: &str,
    location: &str,
) -> Result<BTreeSet<String>, StorageError> {
    let Some((_, stated)) = disk_name.rsplit_once('-') else {
        return Ok(BTreeSet::new());
    };
    let stated = stated.split('.').next().unwrap_or_default();
    if !content_hash.starts_with(stated) {
        return Ok(BTreeSet::new());
    }
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(internal)?;
    let resolved = transaction
        .prepare_cached(
            // The path goes with the hash: from here on the row can say which
            // picture it is, so it stops holding the link it was found by. The
            // extension is spelled out again here because SQL cannot call the
            // Rust that spells it elsewhere; the `mime_type` CHECK in
            // schema.sql names the others that have to agree with this one.
            "UPDATE notes_images
                SET content_hash = ?2,
                    relative_path = ?2 || '.' || CASE mime_type
                        WHEN 'image/jpeg' THEN 'jpg'
                        WHEN 'image/gif' THEN 'gif'
                        WHEN 'image/webp' THEN 'webp'
                        ELSE 'png'
                    END
             WHERE content_hash = ''
               -- The link's own file name, so a page's `assets/x.png` and the
               -- root store's `../assets/x.png` are the same attachment.
               AND (relative_path = ?1 OR relative_path LIKE '%/' || ?1)
             RETURNING node_id",
        )
        .and_then(|mut statement| {
            let rows = statement
                .query_map(rusqlite::params![disk_name, content_hash], |row| row.get(0))?;
            rows.collect::<Result<BTreeSet<String>, _>>()
        })
        .map_err(internal)?;
    transaction
        .prepare_cached(
            // Where the file actually is, which the arrival knows and nothing
            // else does. A record saying "nowhere" cannot be rendered into a
            // link, and a document that cannot be rendered is owed for ever.
            "INSERT INTO sync_assets(content_hash, disk_name, location, unreferenced_at)
             VALUES (?1, ?2, ?3, NULL)
             ON CONFLICT(content_hash) DO UPDATE SET
                 disk_name = excluded.disk_name,
                 location = excluded.location",
        )
        .and_then(|mut statement| {
            statement.execute(rusqlite::params![content_hash, disk_name, location])
        })
        .map_err(internal)?;
    // The rows a window can act on. A note the trash holds is on no page to
    // redraw, and named there it reads as a note that came back — so the window
    // keeps the caret's typing and sends it to a row this database holds as
    // deleted. Its picture row still learnt which picture it is above:
    // restored later, it draws the picture rather than a placeholder.
    let mut live = BTreeSet::new();
    {
        let mut statement = transaction
            .prepare_cached("SELECT 1 FROM notes_nodes WHERE id = ?1 AND deleted = 0")
            .map_err(internal)?;
        for node_id in resolved {
            if statement.exists([&node_id]).map_err(internal)? {
                live.insert(node_id);
            }
        }
    }
    // Rows changed, so the revision moves — the same rule the merge follows.
    // Nothing in the outline moved, but a note that was drawing a placeholder
    // is drawing a picture now, and the window learns that no other way. Only
    // the rows above: a revision this session is never told about leaves its
    // next command rejected for a change nobody could see.
    if !live.is_empty() {
        bump_revision(&transaction)?;
    }
    transaction.commit().map_err(internal)?;
    Ok(live)
}

/// What a reindex did, and what it could not do. The second number is the
/// point: a net that silently drops what it cannot read reports the same
/// "nothing changed" as one that read the whole vault.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ReindexReport {
    pub merged: usize,
    pub skipped: usize,
}

pub(crate) fn reindex_vault(
    connection: &mut Connection,
    clock: &Clock,
    vault_root: &std::path::Path,
) -> Result<ReindexReport, StorageError> {
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
    let mut report = ReindexReport::default();
    let mut stack = vec![vault_root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(at) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&at) else {
            report.skipped += 1;
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // The link itself, never what it points at: following one walks
            // out of the vault, and a link to a folder above itself walks for
            // ever — inside the thread that owns the database.
            let Ok(kind) = std::fs::symlink_metadata(&path) else {
                report.skipped += 1;
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
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
            report.skipped += 1;
            continue;
        };
        let Ok(file) = notes_sync::parse::parse(&bytes) else {
            // Somebody's own markdown, or a document this version cannot read.
            // Either way it is left alone and counted, never merged.
            report.skipped += 1;
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
            report.merged += 1;
        }
    }
    Ok(report)
}
