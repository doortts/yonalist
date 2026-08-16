//! Landing a vault file on the rows.
//!
//! One comparison decides every node: the file's stamp against the row's. The
//! file is newer and it wins, the file is older and it loses, or they match and
//! the node has not moved. Nothing else in this file is allowed to decide it.
//!
//! Two rules are easy to get backwards and both cost data:
//!
//! - A node the file does not mention is not evidence of anything. Only
//!   `trash.md` deletes, because only `trash.md` says a deletion happened.
//! - A stamp from a clock that runs a day fast is never absorbed. Taking it
//!   would hand every later local edit that same future time, and a value near
//!   the encoding ceiling would leave the clock unable to issue anything at
//!   all — including the delete that would remove the row it came from.
//!
//! The merge is a library function over a transaction the caller opened.
//! Rebuilding derived columns and advancing the revision belong to whoever owns
//! the database; this owns the sync semantics.

use crate::document::{DocumentNode, Marker, NodeBody, PageDocument, TrashDocument, VaultFile};
use crate::hlc::{Clock, Hlc};
use rusqlite::{OptionalExtension, Transaction};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// The step between sibling keys, matching the domain's own spacing so a merged
/// order and a locally built one are the same kind of thing.
const SORT_KEY_STEP: i64 = 4_294_967_296;

#[derive(Clone, Debug)]
pub struct MergeInput {
    /// Where the file sits under the vault root, e.g. `Projects-4f1c/README.md`.
    pub file_path: String,
    /// SHA-256 of the bytes that were parsed, in hex.
    pub file_hash: String,
    pub file_mtime_ms: Option<i64>,
    pub file_size: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct MergeOutcome {
    /// Rows actually written. Zero means the caller must not advance the
    /// revision: a replay is not an edit.
    pub applied: usize,
    pub changed_ids: BTreeSet<String>,
    pub deleted_ids: BTreeSet<String>,
    /// The file disagrees with what won, so the exporter has to rewrite it.
    pub needs_write_back: bool,
    pub conflicts_recorded: usize,
}

pub type MergeError = String;

pub fn merge_document(
    transaction: &Transaction<'_>,
    clock: &Clock,
    file: &VaultFile,
    input: &MergeInput,
) -> Result<MergeOutcome, MergeError> {
    match file {
        VaultFile::Page(page) => merge_page(transaction, clock, page, input),
        VaultFile::Trash(trash) => merge_trash(transaction, clock, trash, input),
    }
}

/// What a row holds, as far as the merge cares. Loaded in one statement for the
/// whole document rather than one per node — the query budget is what makes a
/// large vault's merge affordable.
#[derive(Clone, Debug)]
struct Row {
    hlc: String,
    text: String,
    note: String,
    marker: String,
    ordered_start: i64,
    collapsed: bool,
    completed: bool,
    starred: bool,
    deleted: bool,
    parent_id: Option<String>,
    sort_key: i64,
    extras: String,
    dirty: bool,
}

/// A node as the file states it, flattened with the place it claims.
struct Incoming<'a> {
    id: String,
    node: &'a DocumentNode,
    parent_id: String,
    /// The sibling it follows in the file, empty when it is first. Position is
    /// relative on purpose: a raw sort_key would never match, since the parser
    /// quantises to `ordinal * SORT_KEY_STEP` while the database uses midpoints,
    /// and every echo would then look like a move.
    predecessor_id: String,
    ordinal: usize,
}

fn merge_page(
    transaction: &Transaction<'_>,
    clock: &Clock,
    page: &PageDocument,
    input: &MergeInput,
) -> Result<MergeOutcome, MergeError> {
    let mut outcome = MergeOutcome::default();
    let root_id = page.id.as_str().to_owned();

    // The document root is a node like any other; its state lives in the
    // frontmatter because a heading has nowhere to carry a comment.
    let root_node = DocumentNode {
        id: root_id.clone(),
        hlc: page.root.hlc.clone(),
        body: NodeBody::Text(page.root.title.clone()),
        note: page.root.note.clone(),
        marker: page.root.marker,
        collapsed: page.root.collapsed,
        completed: page.root.completed,
        starred: page.root.starred,
        from: None,
        unknown_tokens: Vec::new(),
        children: Vec::new(),
    };

    let mut incoming = Vec::new();
    if root_id != "root" {
        incoming.push(Incoming {
            id: root_id.clone(),
            node: &root_node,
            parent_id: page.parent.clone().unwrap_or_else(|| "root".to_owned()),
            predecessor_id: String::new(),
            ordinal: 1,
        });
    }
    flatten(&page.nodes, &root_id, &mut incoming);

    apply(transaction, clock, &mut incoming, &mut outcome, false)?;
    outcome.needs_write_back |= document_is_missing_nodes(transaction, &root_id, &incoming)?;
    record_document(
        transaction,
        &root_id,
        input,
        page.max_hlc.as_str(),
        &outcome,
    )?;
    Ok(outcome)
}

fn merge_trash(
    transaction: &Transaction<'_>,
    clock: &Clock,
    trash: &TrashDocument,
    input: &MergeInput,
) -> Result<MergeOutcome, MergeError> {
    let mut outcome = MergeOutcome::default();
    let mut incoming = Vec::new();
    flatten(&trash.nodes, "", &mut incoming);
    apply(transaction, clock, &mut incoming, &mut outcome, true)?;
    record_document(
        transaction,
        "yonalist-trash",
        input,
        trash.max_hlc.as_str(),
        &outcome,
    )?;
    Ok(outcome)
}

fn flatten<'a>(nodes: &'a [DocumentNode], parent_id: &str, out: &mut Vec<Incoming<'a>>) {
    let mut predecessor = String::new();
    for (index, node) in nodes.iter().enumerate() {
        out.push(Incoming {
            id: node.id.clone(),
            node,
            parent_id: parent_id.to_owned(),
            predecessor_id: predecessor.clone(),
            ordinal: index + 1,
        });
        predecessor = node.id.clone();
        let owner = node.id.clone();
        flatten(&node.children, &owner, out);
    }
}

fn apply(
    transaction: &Transaction<'_>,
    clock: &Clock,
    incoming: &mut [Incoming<'_>],
    outcome: &mut MergeOutcome,
    trash: bool,
) -> Result<(), MergeError> {
    let device = device_id(transaction)?;
    // A line with no id, or one whose id nothing here has seen and which
    // carries no stamp either, was typed by a person. The merge issues both,
    // and the file has to be rewritten to learn them.
    let existing = load_rows(transaction, incoming)?;
    for entry in incoming.iter_mut() {
        if entry.id.is_empty() {
            // The write-back follows from the stamp the merge issues below —
            // one rule, in one place.
            entry.id = Uuid::new_v4().hyphenated().to_string();
        }
    }

    for entry in incoming.iter() {
        let file_hlc = entry.node.hlc.clone();
        let drifted = match Hlc::decode(&file_hlc) {
            Ok(reading) => clock.is_beyond_drift(&reading),
            Err(_) => false,
        };
        let row = existing.get(&entry.id.to_ascii_lowercase());

        let (adopt, stamp, reason) = decide(entry, row, &file_hlc, drifted, clock, &device)?;
        // A drifted reading is deliberately not absorbed: taking it would hand
        // every later local edit that same future time.
        if !drifted && let Ok(reading) = Hlc::decode(&file_hlc) {
            clock.observe(&reading);
        }

        match adopt {
            Verdict::Skip => {}
            Verdict::Write => {
                match reason {
                    // The file's stamp is the thing being discarded, so the
                    // file's state is what gets kept.
                    Some(Reason::ClockDrift) => {
                        log_conflict(
                            transaction,
                            &entry.id,
                            &loser_of_file(entry, "clock_drift"),
                            &file_hlc,
                            &stamp,
                        )?;
                        outcome.conflicts_recorded += 1;
                    }
                    Some(Reason::DirtyOverwrite) => {
                        let row = row.expect("a dirty overwrite means a row exists");
                        log_conflict(transaction, &entry.id, &loser_of_row(row), &row.hlc, &stamp)?;
                        outcome.conflicts_recorded += 1;
                    }
                    None => {}
                }
                write_row(transaction, entry, &stamp, trash, row)?;
                outcome.applied += 1;
                outcome.changed_ids.insert(entry.id.clone());
                if trash {
                    outcome.deleted_ids.insert(entry.id.clone());
                }
                if stamp != file_hlc {
                    outcome.needs_write_back = true;
                }
            }
            Verdict::LocalWins => {
                let row = row.expect("a local win means a row exists");
                log_conflict(
                    transaction,
                    &entry.id,
                    &loser_of_file(entry, "lww"),
                    &file_hlc,
                    &row.hlc,
                )?;
                outcome.conflicts_recorded += 1;
                outcome.needs_write_back = true;
            }
        }
    }
    Ok(())
}

enum Verdict {
    Write,
    Skip,
    LocalWins,
}

#[derive(Clone, Copy)]
enum Reason {
    /// A remote value overwrote a local edit that had never been exported, so
    /// this device holds the only copy of what it replaced.
    DirtyOverwrite,
    /// A stamp from a clock running more than a day fast.
    ClockDrift,
}

fn decide(
    entry: &Incoming<'_>,
    row: Option<&Row>,
    file_hlc: &str,
    drifted: bool,
    clock: &Clock,
    _device: &str,
) -> Result<(Verdict, String, Option<Reason>), MergeError> {
    let Some(row) = row else {
        // Nothing local to compare against. A hand-written line with no stamp
        // gets one; a stamp from a broken clock is replaced and the reading it
        // replaced is kept, since that is the only record the file's own value
        // ever existed.
        if drifted {
            return Ok((
                Verdict::Write,
                clock.now()?.encode(),
                Some(Reason::ClockDrift),
            ));
        }
        let stamp = if file_hlc.is_empty() {
            clock.now()?.encode()
        } else {
            file_hlc.to_owned()
        };
        return Ok((Verdict::Write, stamp, None));
    };

    if drifted {
        // Replaying the same broken file before the write-back lands must not
        // mint a new stamp each time, or the replay never settles.
        if content_of_row(row) == content_of_file(entry) {
            return Ok((Verdict::Skip, row.hlc.clone(), None));
        }
        return Ok((
            Verdict::Write,
            clock.now()?.encode(),
            Some(Reason::ClockDrift),
        ));
    }

    if file_hlc > row.hlc.as_str() {
        let reason = if row.dirty && content_of_row(row) != content_of_file(entry) {
            Some(Reason::DirtyOverwrite)
        } else {
            None
        };
        return Ok((Verdict::Write, file_hlc.to_owned(), reason));
    }
    if file_hlc < row.hlc.as_str() {
        return Ok((Verdict::LocalWins, row.hlc.clone(), None));
    }
    // Equal stamps. Telling a hand edit apart from a remote one is M3.1b's
    // job; until then the conservative reading is that nothing changed.
    Ok((Verdict::Skip, row.hlc.clone(), None))
}

fn load_rows(
    transaction: &Transaction<'_>,
    incoming: &[Incoming<'_>],
) -> Result<BTreeMap<String, Row>, MergeError> {
    let ids: Vec<String> = incoming
        .iter()
        .filter(|entry| !entry.id.is_empty())
        .map(|entry| entry.id.to_ascii_lowercase())
        .collect();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let list = serde_ids(&ids);
    // One statement for the whole document: a per-node lookup would put the
    // merge's cost on the node count, which is what the query budget forbids.
    let mut statement = transaction
        .prepare(
            "SELECT n.id, n.hlc, n.text, n.note, n.marker, n.ordered_start, n.collapsed,
                    n.completed, n.starred, n.deleted, n.parent_id, n.sort_key, n.sync_extras,
                    d.node_id IS NOT NULL
             FROM notes_nodes n
             LEFT JOIN sync_dirty_nodes d ON d.node_id = n.id
             WHERE lower(n.id) IN (SELECT value FROM json_each(?1))",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([list], |row| {
            Ok((
                row.get::<_, String>(0)?.to_ascii_lowercase(),
                Row {
                    hlc: row.get(1)?,
                    text: row.get(2)?,
                    note: row.get(3)?,
                    marker: row.get(4)?,
                    ordered_start: row.get(5)?,
                    collapsed: row.get::<_, i64>(6)? == 1,
                    completed: row.get::<_, i64>(7)? == 1,
                    starred: row.get::<_, i64>(8)? == 1,
                    deleted: row.get::<_, i64>(9)? == 1,
                    parent_id: row.get(10)?,
                    sort_key: row.get(11)?,
                    extras: row.get(12)?,
                    dirty: row.get::<_, i64>(13)? == 1,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (id, value) = row.map_err(|error| error.to_string())?;
        out.insert(id, value);
    }
    Ok(out)
}

fn serde_ids(ids: &[String]) -> String {
    let mut json = String::from("[");
    for (index, id) in ids.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push('"');
        json.push_str(&id.replace('\\', "\\\\").replace('"', "\\\""));
        json.push('"');
    }
    json.push(']');
    json
}

fn write_row(
    transaction: &Transaction<'_>,
    entry: &Incoming<'_>,
    stamp: &str,
    trash: bool,
    row: Option<&Row>,
) -> Result<(), MergeError> {
    let (marker, ordered_start) = match entry.node.marker {
        Marker::Bullet => ("bullet", 1),
        Marker::Todo => ("todo", 1),
        Marker::Ordered(start) => ("ordered", start),
    };
    let (kind, text) = match &entry.node.body {
        NodeBody::Text(text) => ("bullet", text.clone()),
        NodeBody::Image(image) => ("image", image.original_name.clone()),
        NodeBody::Split { title, .. } => ("bullet", title.clone()),
    };
    let (parent_id, sort_key) = place(entry, row);
    let deleted = trash || entry.node.from.is_some();
    let extras = extras_of(entry);

    // The stamp is written with the row, so the stamping triggers leave it
    // alone: they only fire when the value is unchanged or empty.
    transaction
        .execute(
            "INSERT INTO notes_nodes(
                 id, parent_id, sort_key, kind, text, note, marker, ordered_start,
                 collapsed, completed, starred, deleted, hlc, sync_extras)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
                 parent_id = excluded.parent_id,
                 sort_key = excluded.sort_key,
                 kind = excluded.kind,
                 text = excluded.text,
                 note = excluded.note,
                 marker = excluded.marker,
                 ordered_start = excluded.ordered_start,
                 collapsed = excluded.collapsed,
                 completed = excluded.completed,
                 starred = excluded.starred,
                 deleted = excluded.deleted,
                 hlc = excluded.hlc,
                 sync_extras = excluded.sync_extras",
            rusqlite::params![
                entry.id,
                parent_id,
                sort_key,
                kind,
                text,
                entry.node.note,
                marker,
                ordered_start,
                i64::from(entry.node.collapsed),
                i64::from(entry.node.completed),
                i64::from(entry.node.starred),
                i64::from(deleted),
                stamp,
                extras,
            ],
        )
        .map_err(|error| error.to_string())?;
    // Adopting what another device decided is not a local edit, so it leaves
    // nothing for the exporter to pick up.
    transaction
        .execute(
            "DELETE FROM sync_dirty_nodes WHERE node_id = ?1",
            [&entry.id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// The file states order, not keys. A node keeps the key it already had unless
/// its place changed, so re-reading a file the exporter wrote does not renumber
/// every sibling.
fn place(entry: &Incoming<'_>, row: Option<&Row>) -> (Option<String>, i64) {
    let parent = if entry.parent_id.is_empty() {
        row.and_then(|row| row.parent_id.clone())
            .or_else(|| Some("root".to_owned()))
    } else {
        Some(entry.parent_id.clone())
    };
    let key = match row {
        Some(row) if row.parent_id == parent => row.sort_key,
        _ => entry.ordinal as i64 * SORT_KEY_STEP,
    };
    (parent, key)
}

fn extras_of(entry: &Incoming<'_>) -> String {
    let mut tokens: Vec<String> = entry.node.unknown_tokens.clone();
    if let NodeBody::Image(image) = &entry.node.body {
        tokens.extend(image.unknown_tokens.iter().cloned());
    }
    if tokens.is_empty() {
        return String::new();
    }
    tokens.join(" ")
}

/// What the merge compares when two stamps are equal, and what M4 will hash for
/// the export record. Field order is fixed so two devices build the same bytes.
fn content_of_file(entry: &Incoming<'_>) -> String {
    let (marker, ordered_start) = match entry.node.marker {
        Marker::Bullet => ("bullet", 1),
        Marker::Todo => ("todo", 1),
        Marker::Ordered(start) => ("ordered", start),
    };
    let (kind, text) = match &entry.node.body {
        NodeBody::Text(text) => ("bullet", text.clone()),
        NodeBody::Image(image) => (
            "image",
            format!(
                "{}\u{0}{}\u{0}{}\u{0}{}x{}\u{0}{}",
                image.original_name,
                image.path,
                image.display_width,
                image.pixel_width,
                image.pixel_height,
                image.byte_size
            ),
        ),
        NodeBody::Split { title, .. } => ("split", title.clone()),
    };
    [
        "v1".to_owned(),
        kind.to_owned(),
        text,
        entry.node.note.clone(),
        marker.to_owned(),
        ordered_start.to_string(),
        entry.node.collapsed.to_string(),
        entry.node.completed.to_string(),
        entry.node.starred.to_string(),
        entry.node.from.is_some().to_string(),
        entry.parent_id.clone(),
        entry.predecessor_id.clone(),
        extras_of(entry),
    ]
    .join("\u{0}")
}

fn content_of_row(row: &Row) -> String {
    [
        "v1".to_owned(),
        "bullet".to_owned(),
        row.text.clone(),
        row.note.clone(),
        row.marker.clone(),
        row.ordered_start.to_string(),
        row.collapsed.to_string(),
        row.completed.to_string(),
        row.starred.to_string(),
        row.deleted.to_string(),
        row.parent_id.clone().unwrap_or_default(),
        String::new(),
        row.extras.clone(),
    ]
    .join("\u{0}")
}

/// A defeated state, complete enough that the conflict screen can show it and
/// re-apply it without anything else on hand.
fn loser_of_row(row: &Row) -> String {
    json_object(&[
        ("v", "1".to_owned()),
        ("text", row.text.clone()),
        ("note", row.note.clone()),
        ("marker", row.marker.clone()),
        ("deleted", row.deleted.to_string()),
        ("reason", "dirty_overwrite".to_owned()),
    ])
}

fn loser_of_file(entry: &Incoming<'_>, reason: &str) -> String {
    let text = match &entry.node.body {
        NodeBody::Text(text) => text.clone(),
        NodeBody::Image(image) => image.original_name.clone(),
        NodeBody::Split { title, .. } => title.clone(),
    };
    json_object(&[
        ("v", "1".to_owned()),
        ("text", text),
        ("note", entry.node.note.clone()),
        ("marker", "bullet".to_owned()),
        ("deleted", entry.node.from.is_some().to_string()),
        ("reason", reason.to_owned()),
    ])
}

fn json_object(fields: &[(&str, String)]) -> String {
    let mut json = String::from("{");
    for (index, (key, value)) in fields.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push('"');
        json.push_str(key);
        json.push_str("\":\"");
        json.push_str(&value.replace('\\', "\\\\").replace('"', "\\\""));
        json.push('"');
    }
    json.push('}');
    json
}

/// Recorded once per defeat. The winner is deliberately not part of the key:
/// keying on it re-logs the same loser every time the local row moves on.
fn log_conflict(
    transaction: &Transaction<'_>,
    node_id: &str,
    loser_json: &str,
    loser_hlc: &str,
    winner_hlc: &str,
) -> Result<(), MergeError> {
    transaction
        .execute(
            "INSERT INTO sync_conflict_log(node_id, loser_json, loser_hlc, winner_hlc, recorded_at)
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE NOT EXISTS (
                 SELECT 1 FROM sync_conflict_log
                 WHERE node_id = ?1 AND loser_hlc = ?3 AND loser_json = ?2
             )",
            rusqlite::params![node_id, loser_json, loser_hlc, winner_hlc, 0_i64],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// A document that should hold a node the file left out gets rewritten. The
/// node is not touched — the file is simply incomplete, and the next export
/// finishes it.
fn document_is_missing_nodes(
    transaction: &Transaction<'_>,
    root_id: &str,
    incoming: &[Incoming<'_>],
) -> Result<bool, MergeError> {
    if root_id == "root" {
        return Ok(false);
    }
    let seen: BTreeSet<String> = incoming
        .iter()
        .map(|entry| entry.id.to_ascii_lowercase())
        .collect();
    let mut statement = transaction
        .prepare("SELECT id FROM notes_nodes WHERE parent_id = ?1 AND deleted = 0")
        .map_err(|error| error.to_string())?;
    let children = statement
        .query_map([root_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for child in children {
        let child = child.map_err(|error| error.to_string())?;
        if !seen.contains(&child.to_ascii_lowercase()) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn record_document(
    transaction: &Transaction<'_>,
    root_id: &str,
    input: &MergeInput,
    max_hlc: &str,
    outcome: &MergeOutcome,
) -> Result<(), MergeError> {
    // A merge that has to be written back deliberately leaves a stale exported
    // hash, so the exporter knows the file is not what this device holds.
    let exported_hash = if outcome.needs_write_back {
        String::new()
    } else {
        input.file_hash.clone()
    };
    transaction
        .execute(
            "INSERT INTO sync_documents(
                 root_id, folder_path, applied_max_hlc, exported_hash,
                 file_mtime_ms, file_size, quarantined)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
             ON CONFLICT(root_id) DO UPDATE SET
                 folder_path = excluded.folder_path,
                 applied_max_hlc = max(sync_documents.applied_max_hlc, excluded.applied_max_hlc),
                 exported_hash = excluded.exported_hash,
                 file_mtime_ms = excluded.file_mtime_ms,
                 file_size = excluded.file_size,
                 quarantined = 0",
            rusqlite::params![
                root_id,
                input.file_path,
                max_hlc,
                exported_hash,
                input.file_mtime_ms,
                input.file_size,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn device_id(transaction: &Transaction<'_>) -> Result<String, MergeError> {
    transaction
        .query_row(
            "SELECT device_id FROM sync_meta WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "The vault has no device id.".to_owned())
}
