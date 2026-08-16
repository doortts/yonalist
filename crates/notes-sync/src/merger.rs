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
    /// The file this came from is a copy some sync client wrote, and its
    /// notes are now in the document they belong to. Whoever handed it over
    /// removes it — left there, every device reads it again for ever, and
    /// each one writes it back out.
    pub retire_file: bool,
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
    id: String,
    hlc: String,
    kind: String,
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
    prev: String,
    prev_hlc: String,
    image: Option<ImageRow>,
}

/// What an image line stated, kept so the comparison can be made again on the
/// way back. Without it every replay of the same file reads as an edit.
#[derive(Clone, Debug)]
struct ImageRow {
    path: String,
    display_width: i64,
    pixel_width: i64,
    pixel_height: i64,
    byte_length: i64,
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
    /// True only for a document root this vault has never applied before. The
    /// split line that announced the node had to show *something*, and the
    /// child document's real state arrives carrying the same stamp — that is
    /// the two file shapes meeting, not two devices disagreeing.
    first_arrival: bool,
    /// False for a document root. A page's own file states no position — its
    /// place is its line in home — and reading that absence as "first child of
    /// root" would drag the page to the front every time its file was read,
    /// then restamp it and send that everywhere.
    positioned: bool,
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
        place: None,
        unknown_tokens: Vec::new(),
        children: Vec::new(),
    };

    // A child document can arrive before the document holding the node it hangs
    // under. The place is held open with an empty stamp, which loses to the
    // real parent the moment it lands — a fresh stamp would beat the real
    // evidence instead.
    if let Some(parent) = &page.parent {
        place_missing_parent(transaction, clock, parent)?;
    }
    let mut incoming = Vec::new();
    if root_id != "root" {
        incoming.push(Incoming {
            id: root_id.clone(),
            node: &root_node,
            parent_id: page.parent.clone().unwrap_or_else(|| "root".to_owned()),
            predecessor_id: String::new(),
            positioned: false,
            first_arrival: !document_was_applied(transaction, &root_id)?,
        });
    }
    flatten(&page.nodes, &root_id, &mut incoming);

    apply(transaction, clock, &incoming, &mut outcome, false)?;
    repair_structure(transaction, clock, &mut outcome)?;
    outcome.needs_write_back |=
        document_is_missing_nodes(transaction, &root_id, &page.max_hlc, &incoming)?;
    if outcome.needs_write_back {
        // Queued for the exporter the same way a local edit is: the file needs
        // rewriting, and the dirty mark is how anything learns that.
        mark_dirty(transaction, &root_id)?;
    }
    if crate::watcher::is_conflicted_copy(&input.file_path) {
        // Its notes are in the document they belong to now, and the document
        // owes a write because of them.
        outcome.retire_file = true;
        outcome.needs_write_back = true;
        mark_dirty(transaction, &root_id)?;
    }
    record_document(transaction, &root_id, input, page.max_hlc.as_str())?;
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
    apply(transaction, clock, &incoming, &mut outcome, true)?;
    repair_structure(transaction, clock, &mut outcome)?;
    outcome.retire_file = crate::watcher::is_conflicted_copy(&input.file_path);
    record_document(transaction, "yonalist-trash", input, trash.max_hlc.as_str())?;
    Ok(outcome)
}

/// Ids are issued here rather than later: the line after a hand-typed one
/// records which line it follows, and an id issued after that is recorded would
/// leave the follower claiming to be first — one typed line would reorder the
/// document around it.
fn flatten<'a>(nodes: &'a [DocumentNode], parent_id: &str, out: &mut Vec<Incoming<'a>>) {
    let mut predecessor = String::new();
    for node in nodes {
        let id = if node.id.is_empty() {
            Uuid::new_v4().hyphenated().to_string()
        } else {
            node.id.clone()
        };
        // A trash root states where it was taken from, and that is its place —
        // the line it sits on in the trash says nothing about where it belongs.
        let (parent_id, positioned) = match &node.from {
            Some((from, _)) => (from.clone(), false),
            None => (parent_id.to_owned(), true),
        };
        out.push(Incoming {
            id: id.clone(),
            node,
            parent_id,
            predecessor_id: predecessor.clone(),
            positioned,
            first_arrival: false,
        });
        predecessor = id.clone();
        flatten(&node.children, &id, out);
    }
}

fn apply(
    transaction: &Transaction<'_>,
    clock: &Clock,
    incoming: &[Incoming<'_>],
    outcome: &mut MergeOutcome,
    trash: bool,
) -> Result<(), MergeError> {
    let device = device_id(transaction)?;
    let existing = load_rows(transaction, incoming)?;
    // The order siblings are actually in, kept up to date as rows land. A
    // snapshot taken before the writes would make every sibling after a moved
    // one look reordered too, and each would be dragged through the conflict
    // machinery for a move it never made.
    if trash {
        place_missing_parents(transaction, incoming)?;
    }
    let mut order = SiblingOrder::load(transaction, incoming, &existing)?;

    for entry in incoming.iter() {
        let file_hlc = entry.node.hlc.clone();
        let drifted = match Hlc::decode(&file_hlc) {
            Ok(reading) => clock.is_beyond_drift(&reading),
            Err(_) => false,
        };
        // Observed before anything is issued, so a stamp the merge mints beats
        // what the file brought in. A drifted reading is deliberately left
        // behind: taking it would hand every later local edit that future time.
        if !drifted && let Ok(reading) = Hlc::decode(&file_hlc) {
            clock.observe(&reading);
        }
        let row = existing.get(&entry.id);
        let deleted_now = trash;
        let file_content = content_of_file(entry, trash);
        let split = matches!(entry.node.body, NodeBody::Split { .. });
        let row_content = row.map(|row| content_of_row(row, split));

        // A node's place is judged on its own, before and apart from its
        // content. A file can be behind on the text and still be the one that
        // knows where the node moved to — tying the two loses that move.
        let parent_for_place = if entry.parent_id.is_empty() {
            row.and_then(|row| row.parent_id.clone())
                .unwrap_or_default()
        } else {
            entry.parent_id.clone()
        };
        let place = if entry.positioned {
            decide_place(entry, row, &device, clock, &order, &parent_for_place)?
        } else {
            None
        };
        // A page arriving before home joins the end of the list, claiming that
        // spot at the earliest reading there is — so home's real line beats it
        // whenever it lands, however long the page has been sitting there being
        // edited. An empty stamp cannot be used here: empty means "no claim has
        // ever been recorded", which is what makes the row fall back to where
        // it currently sits.
        let place = match place {
            Some(place) => Some(place),
            None if !entry.positioned && entry.node.from.is_none() && row.is_none() => Some((
                order.last(&parent_for_place),
                Hlc::new(0, 0, &device)?.encode(),
            )),
            None => None,
        };
        if let Some((prev, claim_stamp)) = &place {
            order.claim(&parent_for_place, &entry.id, prev, claim_stamp);
        }

        let (verdict, stamp, reason) = decide(
            row,
            entry.first_arrival,
            deleted_now,
            &file_content,
            row_content.as_deref(),
            &file_hlc,
            drifted,
            clock,
            &device,
        )?;

        // Recorded even where the content did not move: the two records are
        // independent, and a place that only exists in memory would be lost the
        // moment this merge ends.
        if !matches!(verdict, Verdict::Write)
            && let Some((prev, claim_stamp)) = &place
            && row
                .is_none_or(|row| (row.prev.as_str(), row.prev_hlc.as_str()) != (prev, claim_stamp))
        {
            write_place(transaction, &entry.id, prev, claim_stamp)?;
            // A place adoption rewrites sibling keys, so the caller has rows to
            // rebuild and a revision to move: reporting nothing would leave the
            // ordering column stale and every open session none the wiser.
            outcome.applied += 1;
            outcome.changed_ids.insert(entry.id.clone());
        }
        match verdict {
            Verdict::Skip => {}
            Verdict::RewriteFile => outcome.needs_write_back = true,
            Verdict::Write => {
                if let Some(reason) = reason {
                    // What was lost is the row when there was one — a drifted
                    // stamp overwriting a local edit takes content with it, and
                    // a dirty row's content exists nowhere else at all. With no
                    // row, only the file's own stamp was discarded.
                    let (loser, loser_hlc) = match row {
                        Some(row) => (
                            loser_of_row(
                                row,
                                &order.predecessor(
                                    row.parent_id.as_deref().unwrap_or_default(),
                                    &row.id,
                                ),
                                reason.as_str(),
                            ),
                            row.hlc.clone(),
                        ),
                        None => (
                            loser_of_file(entry, trash, reason.as_str()),
                            file_hlc.clone(),
                        ),
                    };
                    log_conflict(transaction, &entry.id, &loser, &loser_hlc, &stamp)?;
                    outcome.conflicts_recorded += 1;
                }
                write_row(transaction, entry, &stamp, trash, row, place.as_ref())?;
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
                let reason = if file_hlc == row.hlc { "same_t" } else { "lww" };
                log_conflict(
                    transaction,
                    &entry.id,
                    &loser_of_file(entry, trash, reason),
                    &file_hlc,
                    &row.hlc,
                )?;
                outcome.conflicts_recorded += 1;
                outcome.needs_write_back = true;
            }
        }
    }
    // The keys the claims add up to, written once for every parent something
    // moved under.
    order.flush(transaction)?;
    Ok(())
}

/// The vault-wide bookkeeping every merge ends with: a parent chain that closes
/// on itself, or a live node whose parent is gone, leaves the tree in a state
/// nothing downstream can draw. Both are repaired the same way — the node moves
/// to a page the user can actually find.
///
/// Determinism is the whole contract. Two devices merging the same files in
/// different orders must take the *same* node out of a cycle, or their vaults
/// never agree again.
fn repair_structure(
    transaction: &Transaction<'_>,
    clock: &Clock,
    outcome: &mut MergeOutcome,
) -> Result<(), MergeError> {
    let mut recovery: Option<String> = None;
    // Orphans first: a deletion that won over a parent while an edit won over
    // its child leaves the child alive and unreachable.
    loop {
        let orphan: Option<String> = transaction
            .prepare_cached(
                "SELECT n.id FROM notes_nodes n
                 LEFT JOIN notes_nodes p ON p.id = n.parent_id
                 WHERE n.deleted = 0 AND n.parent_id IS NOT NULL
                   AND (p.id IS NULL OR p.deleted = 1)
                 ORDER BY n.id LIMIT 1",
            )
            .and_then(|mut statement| {
                statement
                    .query_row([], |row| row.get::<_, String>(0))
                    .optional()
            })
            .map_err(|error| error.to_string())?;
        let Some(orphan) = orphan else { break };
        let page = recovery_page(transaction, clock, &mut recovery)?;
        park(transaction, clock, &orphan, &page, outcome)?;
    }
    while let Some(node) = cycle_member(transaction)? {
        let page = recovery_page(transaction, clock, &mut recovery)?;
        park(transaction, clock, &node, &page, outcome)?;
    }
    Ok(())
}

/// The node a cycle gives up: the smallest `(stamp, id)` on the ring. The stamp
/// came out of the file, so every device walking the same ring picks the same
/// node without talking to any other device.
fn cycle_member(transaction: &Transaction<'_>) -> Result<Option<String>, MergeError> {
    let mut statement = transaction
        .prepare_cached(
            "SELECT id, parent_id, hlc FROM notes_nodes WHERE deleted = 0 AND parent_id IS NOT NULL",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut parents = BTreeMap::new();
    let mut stamps = BTreeMap::new();
    for row in rows {
        let (id, parent, hlc) = row.map_err(|error| error.to_string())?;
        parents.insert(id.clone(), parent);
        stamps.insert(id, hlc);
    }
    // Every id is walked, so the ring is found no matter which node this merge
    // happened to touch. The map is ordered, so the walk is too.
    for start in parents.keys() {
        let mut seen = BTreeSet::new();
        let mut at = start.clone();
        while let Some(parent) = parents.get(&at) {
            if !seen.insert(at.clone()) {
                // Back where we have been: collect the ring itself, which is
                // everything reachable from here.
                let mut ring = BTreeSet::new();
                let mut walk = at.clone();
                while ring.insert(walk.clone()) {
                    walk = parents.get(&walk).cloned().unwrap_or_default();
                }
                let chosen = ring
                    .into_iter()
                    .min_by(|left, right| {
                        let left_stamp = stamps.get(left).cloned().unwrap_or_default();
                        let right_stamp = stamps.get(right).cloned().unwrap_or_default();
                        (left_stamp, left).cmp(&(right_stamp, right))
                    })
                    .expect("a ring holds at least one node");
                return Ok(Some(chosen));
            }
            at = parent.clone();
        }
    }
    Ok(None)
}

/// Where a rescued node goes. Its key comes from its own id, so the page reads
/// the same on every device that had to rescue the same node.
fn park(
    transaction: &Transaction<'_>,
    clock: &Clock,
    id: &str,
    page: &str,
    outcome: &mut MergeOutcome,
) -> Result<(), MergeError> {
    let sort_key = recovery_sort_key(id)?;
    let stamp = clock.now()?.encode();
    transaction
        .prepare_cached(
            "UPDATE notes_nodes SET parent_id = ?2, sort_key = ?3, hlc = ?4 WHERE id = ?1",
        )
        .and_then(|mut statement| statement.execute(rusqlite::params![id, page, sort_key, stamp]))
        .map_err(|error| error.to_string())?;
    // The stamping trigger cannot: this write carries its own reading, which
    // is what tells it to keep out of the way. So the marks are made here — a
    // rescue no file states is one no other device ever sees, and one this
    // device would undo the moment it read the vault as the truth.
    mark_dirty(transaction, id)?;
    mark_dirty(transaction, page)?;
    outcome.applied += 1;
    outcome.changed_ids.insert(id.to_owned());
    outcome.needs_write_back = true;
    Ok(())
}

/// A stable key inside the range JavaScript can hold exactly, derived from the
/// node's own id (ported from v1's `safe_recovery_sort_key`).
fn recovery_sort_key(id: &str) -> Result<i64, MergeError> {
    let canonical = Uuid::parse_str(id)
        .map_err(|_| format!("`{id}` is not a UUID."))?
        .simple()
        .to_string();
    let prefix = u64::from_str_radix(&canonical[..13], 16)
        .map_err(|_| format!("`{id}` has no readable prefix."))?;
    i64::try_from(prefix).map_err(|_| "A recovery key is too large.".to_owned())
}

/// Made only when something actually has to be rescued. Its id comes from this
/// vault's own uuid, so two devices can each make one and they merge like any
/// other pair of nodes.
fn recovery_page(
    transaction: &Transaction<'_>,
    clock: &Clock,
    cached: &mut Option<String>,
) -> Result<String, MergeError> {
    if let Some(page) = cached {
        return Ok(page.clone());
    }
    let vault_uuid: String = transaction
        .prepare_cached("SELECT vault_uuid FROM sync_meta WHERE singleton = 1")
        .and_then(|mut statement| statement.query_row([], |row| row.get(0)))
        .map_err(|error| error.to_string())?;
    let id = Uuid::new_v5(
        &Uuid::parse_str(&vault_uuid).map_err(|_| "The vault uuid is not a UUID.".to_owned())?,
        b"yonalist-recovery-page",
    )
    .hyphenated()
    .to_string();
    let stamp = clock.now()?.encode();
    transaction
        .prepare_cached(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, 'root', ?2, 'bullet', 'Recovered', ?3)
             ON CONFLICT(id) DO NOTHING",
        )
        .and_then(|mut statement| statement.execute(rusqlite::params![id, i64::MAX / 2, stamp]))
        .map_err(|error| error.to_string())?;
    // Same reason as `park`: the insert carries a reading, so nothing marks it
    // for us. Home states every page, and this is a new one.
    mark_dirty(transaction, &id)?;
    mark_dirty(transaction, "root")?;
    *cached = Some(id.clone());
    Ok(id)
}

/// Whether this vault has ever applied the document with this root. The absence
/// of the row is the evidence — it is written the first time the document is
/// merged, and nothing else records that fact.
fn document_was_applied(transaction: &Transaction<'_>, root_id: &str) -> Result<bool, MergeError> {
    transaction
        .prepare_cached("SELECT 1 FROM sync_documents WHERE root_id = ?1")
        .and_then(|mut statement| statement.query_row([root_id], |_| Ok(())).optional())
        .map(|found| found.is_some())
        .map_err(|error| error.to_string())
}

/// A live stand-in for a parent that has not arrived. Empty stamp, so the real
/// document takes over the moment it lands; parked out of the way rather than
/// at the top level, where it would look like a page.
fn place_missing_parent(
    transaction: &Transaction<'_>,
    clock: &Clock,
    parent: &str,
) -> Result<(), MergeError> {
    if parent == "root" || document_row_exists(transaction, parent)? {
        return Ok(());
    }
    let mut cached = None;
    let page = recovery_page(transaction, clock, &mut cached)?;
    transaction
        .prepare_cached(
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES (?1, ?2, ?3, 'bullet', '', '')
             ON CONFLICT(id) DO NOTHING",
        )
        .and_then(|mut statement| {
            statement.execute(rusqlite::params![
                parent,
                page,
                recovery_sort_key(parent).unwrap_or(SORT_KEY_STEP)
            ])
        })
        .map_err(|error| error.to_string())?;
    // The insert trigger stamps anything without a reading, and a stamped
    // stand-in would outrank the document it is waiting for.
    transaction
        .prepare_cached("UPDATE notes_nodes SET hlc = '' WHERE id = ?1 AND text = ''")
        .and_then(|mut statement| statement.execute([parent]))
        .map_err(|error| error.to_string())?;
    transaction
        .prepare_cached("DELETE FROM sync_dirty_nodes WHERE node_id = ?1")
        .and_then(|mut statement| statement.execute([parent]))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn document_row_exists(transaction: &Transaction<'_>, id: &str) -> Result<bool, MergeError> {
    transaction
        .prepare_cached("SELECT 1 FROM notes_nodes WHERE id = ?1")
        .and_then(|mut statement| statement.query_row([id], |_| Ok(())).optional())
        .map(|found| found.is_some())
        .map_err(|error| error.to_string())
}

/// Trash can arrive before the document holding the node it was taken from.
/// The place is held open by a deleted row with an empty stamp, which loses
/// every comparison — so the real document takes it over the moment it lands.
/// A fresh stamp here would beat the real evidence instead.
fn place_missing_parents(
    transaction: &Transaction<'_>,
    incoming: &[Incoming<'_>],
) -> Result<(), MergeError> {
    for entry in incoming {
        let Some((parent, _)) = &entry.node.from else {
            continue;
        };
        if parent == "root" {
            continue;
        }
        // Asked before the insert, because everything after it is only for a
        // row this statement made. A note that is already here is somebody's:
        // emptying its reading would lose it every later comparison, and
        // taking its mark would drop a write it is owed.
        let inserted = transaction
            .prepare_cached(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, deleted, hlc)
                 VALUES (?1, 'root', ?2, 'bullet', '', 1, '')
                 ON CONFLICT(id) DO NOTHING",
            )
            .and_then(|mut statement| statement.execute(rusqlite::params![parent, SORT_KEY_STEP]))
            .map_err(|error| error.to_string())?;
        if inserted == 0 {
            continue;
        }
        // The insert trigger stamps anything that arrives without a reading,
        // and a stamped placeholder would outrank the document it is waiting
        // for. Put the emptiness back, and take the dirty mark with it.
        transaction
            .prepare_cached("UPDATE notes_nodes SET hlc = '' WHERE id = ?1")
            .and_then(|mut statement| statement.execute([parent]))
            .map_err(|error| error.to_string())?;
        transaction
            .prepare_cached("DELETE FROM sync_dirty_nodes WHERE node_id = ?1")
            .and_then(|mut statement| statement.execute([parent]))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// The order siblings are in, rebuilt from what each of them claims rather than
/// from the keys they happen to hold.
///
/// Each node remembers which sibling its last accepted move said it follows.
/// Replaying those claims newest-first gives the same sequence on every device,
/// whichever file each one read first — which is the whole point. Deciding a
/// contested slot by looking at a neighbour's *current* stamp cannot do that:
/// the neighbour's stamp changes as the merge runs, so the answer would depend
/// on the order the files arrived in.
struct SiblingOrder {
    claims: BTreeMap<String, Vec<Claim>>,
    dirty: BTreeSet<String>,
}

#[derive(Clone, Debug)]
struct Claim {
    id: String,
    /// The sibling this node says it follows; empty means first.
    prev: String,
    stamp: String,
}

impl SiblingOrder {
    fn load(
        transaction: &Transaction<'_>,
        incoming: &[Incoming<'_>],
        existing: &BTreeMap<String, Row>,
    ) -> Result<Self, MergeError> {
        let mut parents: BTreeSet<String> = incoming
            .iter()
            .map(|entry| {
                if entry.positioned {
                    entry.parent_id.clone()
                } else {
                    // Where a first arrival would be appended.
                    "root".to_owned()
                }
            })
            .collect();
        for row in existing.values() {
            if let Some(parent) = &row.parent_id {
                parents.insert(parent.clone());
            }
        }
        parents.remove("");
        let mut claims: BTreeMap<String, Vec<Claim>> = BTreeMap::new();
        if parents.is_empty() {
            return Ok(Self {
                claims,
                dirty: BTreeSet::new(),
            });
        }
        let mut statement = transaction
            .prepare_cached(
                // A row no merge has claimed for yet reads its place from where
                // it currently sits, at its own stamp — the seed's rows, and
                // rows the command path writes until it records claims of its
                // own (M3.2). Once a claim exists it stands: a later text edit
                // restamps the row, and reading the position again there would
                // turn that edit into a move.
                "SELECT parent_id, id, sync_prev, sync_prev_hlc, hlc,
                        coalesce((
                            SELECT p.id FROM notes_nodes p
                            WHERE p.parent_id IS n.parent_id AND p.deleted = 0
                              AND (p.sort_key, p.id) < (n.sort_key, n.id)
                            ORDER BY p.sort_key DESC, p.id DESC LIMIT 1
                        ), '')
                 FROM notes_nodes n
                 WHERE parent_id IN (SELECT value FROM json_each(?1)) AND deleted = 0
                 ORDER BY parent_id, sort_key, id",
            )
            .map_err(|error| error.to_string())?;
        let list = json_list(&parents.iter().cloned().collect::<Vec<_>>());
        let rows = statement
            .query_map([list], |row| {
                let stored_stamp: String = row.get(3)?;
                let own_stamp: String = row.get(4)?;
                let (prev, stamp) = if stored_stamp.is_empty() {
                    (row.get::<_, String>(5)?, own_stamp)
                } else {
                    (row.get::<_, String>(2)?, stored_stamp)
                };
                Ok((
                    row.get::<_, String>(0)?,
                    Claim {
                        id: row.get(1)?,
                        prev,
                        stamp,
                    },
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (parent, claim) = row.map_err(|error| error.to_string())?;
            claims.entry(parent).or_default().push(claim);
        }
        Ok(Self {
            claims,
            dirty: BTreeSet::new(),
        })
    }

    /// The sequence the claims add up to. Oldest claim is laid down first and
    /// newer ones insert over it, so the most recent move gets the slot it
    /// asked for. A claim whose predecessor has not been laid down yet waits
    /// its turn rather than falling to the end.
    fn sequence(&self, parent: &str) -> Vec<String> {
        let Some(claims) = self.claims.get(parent) else {
            return Vec::new();
        };
        let mut pending: Vec<&Claim> = claims.iter().collect();
        // Ties by id, so two claims stamped identically land the same way on
        // every device.
        pending.sort_by(|left, right| {
            left.stamp
                .cmp(&right.stamp)
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut sequence: Vec<String> = Vec::with_capacity(pending.len());
        while !pending.is_empty() {
            let ready = pending.iter().position(|claim| {
                claim.prev.is_empty() || sequence.iter().any(|id| id == &claim.prev)
            });
            // Nothing is ready only when the remaining claims point at each
            // other; the oldest of them goes down first and the rest follow.
            let at = ready.unwrap_or(0);
            let claim = pending.remove(at);
            let index = if claim.prev.is_empty() {
                0
            } else {
                sequence
                    .iter()
                    .position(|id| id == &claim.prev)
                    .map_or(sequence.len(), |found| found + 1)
            };
            sequence.insert(index, claim.id.clone());
        }
        sequence
    }

    fn predecessor(&self, parent: &str, id: &str) -> String {
        let sequence = self.sequence(parent);
        match sequence.iter().position(|sibling| sibling == id) {
            Some(0) | None => String::new(),
            Some(at) => sequence[at - 1].clone(),
        }
    }

    /// Records what a node now claims. The keys are not touched here — they are
    /// rewritten once, at the end, from the sequence the claims produce.
    fn claim(&mut self, parent: &str, id: &str, prev: &str, stamp: &str) {
        let siblings = self.claims.entry(parent.to_owned()).or_default();
        siblings.retain(|claim| claim.id != id);
        siblings.push(Claim {
            id: id.to_owned(),
            prev: prev.to_owned(),
            stamp: stamp.to_owned(),
        });
        self.dirty.insert(parent.to_owned());
    }

    /// Who is currently last under a parent.
    fn last(&self, parent: &str) -> String {
        self.sequence(parent).last().cloned().unwrap_or_default()
    }

    /// Writes the keys the sequences imply, for every parent something moved
    /// under. `sort_key` is in the stamping trigger's column list, so each row
    /// keeps its stamp and a row that was already dirty stays dirty.
    fn flush(&self, transaction: &Transaction<'_>) -> Result<(), MergeError> {
        for parent in &self.dirty {
            for (index, id) in self.sequence(parent).iter().enumerate() {
                let key = (index as i64 + 1) * SORT_KEY_STEP;
                respace_sibling(transaction, id, key)?;
            }
        }
        Ok(())
    }
}

enum Verdict {
    Write,
    Skip,
    /// The row is right and the file is not, with nothing to record.
    RewriteFile,
    LocalWins,
}

#[derive(Clone, Copy)]
enum Reason {
    /// A remote value overwrote a local edit that had never been exported, so
    /// this device holds the only copy of what it replaced.
    DirtyOverwrite,
    /// A stamp from a clock running more than a day fast.
    ClockDrift,
    /// Two devices carrying the same stamp and different content.
    SameStamp,
    /// A plain defeat on the stamps, where what lost was worth keeping.
    Lww,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Reason::DirtyOverwrite => "dirty_overwrite",
            Reason::ClockDrift => "clock_drift",
            Reason::SameStamp => "same_t",
            Reason::Lww => "lww",
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn decide(
    row: Option<&Row>,
    first_arrival: bool,
    deleted_now: bool,
    file_content: &str,
    row_content: Option<&str>,
    file_hlc: &str,
    drifted: bool,
    clock: &Clock,
    device: &str,
) -> Result<(Verdict, String, Option<Reason>), MergeError> {
    let Some(row) = row else {
        // Nothing local to compare against. A hand-written line with no stamp
        // gets one; a stamp from a broken clock is replaced.
        if drifted {
            // Nothing was overwritten, but the stamp the file carried is gone,
            // and this is the only place it is recorded.
            return Ok((
                Verdict::Write,
                clock.now()?.encode(),
                Some(Reason::ClockDrift),
            ));
        }
        if file_hlc.is_empty() {
            return Ok((Verdict::Write, clock.now()?.encode(), None));
        }
        return Ok((Verdict::Write, file_hlc.to_owned(), None));
    };
    let row_content = row_content.expect("a row was loaded, so its content was built");
    let same_content = digest(file_content) == digest(row_content);
    // Where the node sits is not part of what it *is*: the place is a record of
    // its own, judged separately, so a move can win while the text loses.
    let mine = Hlc::decode(file_hlc)
        .map(|reading| reading.device() == device)
        .unwrap_or(false);

    if drifted {
        // Replaying the same broken file before the write-back lands must not
        // mint a new stamp each round, or the replay never settles.
        if same_content {
            // Nothing to write, but the file still holds the broken stamp and
            // the exporter is what replaces it.
            return Ok((Verdict::RewriteFile, row.hlc.clone(), None));
        }
        // The content being replaced is the thing worth keeping — the file's
        // content is what just won, only its stamp lost.
        return Ok((
            Verdict::Write,
            clock.now()?.encode(),
            Some(Reason::ClockDrift),
        ));
    }

    if file_hlc > row.hlc.as_str() {
        // A deletion is one of a node's states, so a merge that reverses one —
        // in either direction — has beaten something worth keeping.
        let reason = if row.deleted != deleted_now {
            Some(Reason::Lww)
        } else if row.dirty && !same_content {
            Some(Reason::DirtyOverwrite)
        } else {
            None
        };
        return Ok((Verdict::Write, file_hlc.to_owned(), reason));
    }
    if file_hlc < row.hlc.as_str() {
        return Ok((Verdict::LocalWins, row.hlc.clone(), None));
    }
    if same_content {
        return Ok((Verdict::Skip, row.hlc.clone(), None));
    }
    if first_arrival {
        // The row is whatever the parent's split line could show; this document
        // is the first description of the node this vault has ever had. Nothing
        // is in conflict — the two halves of one node are meeting.
        return Ok((Verdict::Write, file_hlc.to_owned(), None));
    }

    // Equal stamps, different content: whoever changed it did not restamp it,
    // so it was edited by hand. Which machine that happened on is the only
    // thing that matters, and the stamp's own device field is the one piece of
    // evidence that survives the trip — the watcher cannot tell iCloud from
    // vim, and a hash mismatch looks the same either way.
    if mine {
        // My stamp under content I did not write. That is authoring, so the
        // text is adopted and stamped afresh to propagate normally.
        return Ok((Verdict::Write, clock.now()?.encode(), None));
    }
    // Their stamp. A fresh one here would make the answer depend on which
    // device merged first, so the content digest decides — the same comparison
    // the export record will hash — and the stamp stays put.
    if digest(file_content) > digest(row_content) {
        Ok((Verdict::Write, row.hlc.clone(), Some(Reason::SameStamp)))
    } else {
        Ok((Verdict::LocalWins, row.hlc.clone(), None))
    }
}

/// One definition of "the same node state", shared by the tie-break and, later,
/// by the export record. Comparing raw strings would order differently from
/// comparing digests, and then two devices could pick different winners.
fn digest(content: &str) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(content.as_bytes()).into()
}

fn load_rows(
    transaction: &Transaction<'_>,
    incoming: &[Incoming<'_>],
) -> Result<BTreeMap<String, Row>, MergeError> {
    let ids: Vec<String> = incoming
        .iter()
        .filter(|entry| !entry.id.is_empty())
        .map(|entry| entry.id.clone())
        .collect();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let list = json_list(&ids);
    // One statement for the whole document: a per-node lookup would put the
    // merge's cost on the node count, which is what the query budget forbids.
    let mut statement = transaction
        .prepare(
            // Ids are canonical lowercase by the time the parser is done, so
            // this matches the primary key directly rather than scanning.
            "SELECT n.id, n.hlc, n.kind, n.text, n.note, n.marker, n.ordered_start, n.collapsed,
                    n.completed, n.starred, n.deleted, n.parent_id, n.sort_key, n.sync_extras,
                    d.node_id IS NOT NULL, n.sync_prev, n.sync_prev_hlc,
                    i.relative_path, i.display_width, i.pixel_width, i.pixel_height, i.byte_length
             FROM notes_nodes n
             LEFT JOIN sync_dirty_nodes d ON d.node_id = n.id
             LEFT JOIN notes_images i ON i.node_id = n.id
             WHERE n.id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([list], |row| {
            let id: String = row.get(0)?;
            Ok((
                id.clone(),
                Row {
                    id,
                    hlc: row.get(1)?,
                    kind: row.get(2)?,
                    text: row.get(3)?,
                    note: row.get(4)?,
                    marker: row.get(5)?,
                    ordered_start: row.get(6)?,
                    collapsed: row.get::<_, i64>(7)? == 1,
                    completed: row.get::<_, i64>(8)? == 1,
                    starred: row.get::<_, i64>(9)? == 1,
                    deleted: row.get::<_, i64>(10)? == 1,
                    parent_id: row.get(11)?,
                    sort_key: row.get(12)?,
                    extras: row.get(13)?,
                    dirty: row.get::<_, i64>(14)? == 1,
                    prev: row.get(15)?,
                    prev_hlc: row.get(16)?,
                    image: match row.get::<_, Option<String>>(17)? {
                        Some(path) => Some(ImageRow {
                            path,
                            display_width: row.get(18)?,
                            pixel_width: row.get(19)?,
                            pixel_height: row.get(20)?,
                            byte_length: row.get(21)?,
                        }),
                        None => None,
                    },
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

fn json_list(ids: &[String]) -> String {
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
    place: Option<&(String, String)>,
) -> Result<(), MergeError> {
    // Before the write, so a parent that was already waiting for something
    // else is not counted as this write's doing.
    let holder = undirty_holder(transaction, &entry.id)?;
    let (marker, ordered_start) = match entry.node.marker {
        Marker::Bullet => ("bullet", 1),
        Marker::Todo => ("todo", 1),
        Marker::Ordered(start) => ("ordered", start),
    };
    let (kind, text) = match &entry.node.body {
        NodeBody::Text(text) => ("bullet", text.clone()),
        NodeBody::Image(image) => ("image", image.original_name.clone()),
        // The line's title is a display copy. Which one is written is decided
        // below: a node arriving for the first time needs something to show,
        // and a node the child document has already described keeps that.
        NodeBody::Split { title, .. } => ("bullet", title.clone()),
    };
    let parent_id = if entry.positioned || entry.node.from.is_some() {
        Some(entry.parent_id.clone())
    } else if let Some(row) = row {
        // A page's place is its line in home, so its own file cannot move it.
        row.parent_id.clone().or_else(|| Some("root".to_owned()))
    } else {
        // Nothing local yet. A split document's frontmatter states which node
        // it hangs under, and it is the only thing that knows until the parent
        // document arrives; a page states nothing and belongs at the top.
        Some(entry.parent_id.clone()).filter(|parent| !parent.is_empty())
    };
    let claim = place;
    let sort_key = match (&entry.node.from, row) {
        // Where it was deleted from. The row remembering that is the whole of
        // restoring: clearing the flag puts it back exactly where it stood.
        (Some((_, from_key)), _) => *from_key,
        (None, Some(row)) => row.sort_key,
        (None, None) => SORT_KEY_STEP,
    };
    // In a page document a node's presence is the statement that it is live;
    // in the trash it is the statement that it is not.
    let deleted = trash;
    let extras = extras_of(entry);
    // A split node lives in two files and only one of them owns its state. The
    // line gives existence, parent and order; everything else stays as the
    // child document left it, or takes the line's title only because nothing
    // has described the node yet.
    let split = matches!(entry.node.body, NodeBody::Split { .. });
    let state = match (split, row) {
        (true, Some(row)) => NodeState {
            text: row.text.clone(),
            note: row.note.clone(),
            marker: row.marker.clone(),
            ordered_start: row.ordered_start,
            collapsed: row.collapsed,
            completed: row.completed,
            starred: row.starred,
            extras: row.extras.clone(),
        },
        _ => NodeState {
            text,
            note: entry.node.note.clone(),
            marker: marker.to_owned(),
            ordered_start,
            collapsed: entry.node.collapsed,
            completed: entry.node.completed,
            starred: entry.node.starred,
            extras,
        },
    };

    // The stamp is written with the row, so the stamping triggers leave it
    // alone: they only fire when the value is unchanged or empty.
    transaction
        .prepare_cached(
            "INSERT INTO notes_nodes(
                 id, parent_id, sort_key, kind, text, note, marker, ordered_start,
                 collapsed, completed, starred, deleted, hlc, sync_extras, sync_prev,
                 sync_prev_hlc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
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
                 sync_extras = excluded.sync_extras,
                 sync_prev = excluded.sync_prev,
                 sync_prev_hlc = excluded.sync_prev_hlc",
        )
        .and_then(|mut statement| {
            statement.execute(rusqlite::params![
                entry.id,
                parent_id,
                sort_key,
                kind,
                state.text,
                state.note,
                state.marker,
                state.ordered_start,
                i64::from(state.collapsed),
                i64::from(state.completed),
                i64::from(state.starred),
                i64::from(deleted),
                stamp,
                state.extras,
                claim
                    .map(|(prev, _)| prev.clone())
                    .unwrap_or_else(|| row.map(|row| row.prev.clone()).unwrap_or_default()),
                claim
                    .map(|(_, claim_stamp)| claim_stamp.clone())
                    .unwrap_or_else(|| row.map(|row| row.prev_hlc.clone()).unwrap_or_default()),
            ])
        })
        .map_err(|error| error.to_string())?;

    if let NodeBody::Image(image) = &entry.node.body {
        write_image(transaction, &entry.id, image)?;
    }

    // Keeping a stamp while changing the content is the one write the stamping
    // triggers would undo: the update trigger fires precisely when the hlc did
    // not change, and replaces it. Putting the stamp back in its own statement
    // slips past it, because `hlc` is not in the trigger's column list.
    transaction
        .prepare_cached("UPDATE notes_nodes SET hlc = ?2 WHERE id = ?1 AND hlc <> ?2")
        .and_then(|mut statement| statement.execute(rusqlite::params![entry.id, stamp]))
        .map_err(|error| error.to_string())?;
    // Adopting what another device decided is not a local edit, so it leaves
    // nothing for the exporter to pick up — including whatever the trigger just
    // marked on the way through, which is the row *and* the file that holds it.
    unmark(transaction, &entry.id)?;
    unmark_holder(transaction, &entry.id, holder)?;
    Ok(())
}

/// The claim columns alone. They are outside the stamping trigger's list, so
/// recording where a node sits is not an edit to the node.
fn write_place(
    transaction: &Transaction<'_>,
    id: &str,
    prev: &str,
    claim_stamp: &str,
) -> Result<(), MergeError> {
    transaction
        .prepare_cached("UPDATE notes_nodes SET sync_prev = ?2, sync_prev_hlc = ?3 WHERE id = ?1")
        .and_then(|mut statement| statement.execute(rusqlite::params![id, prev, claim_stamp]))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// A file's claim about where a node sits, judged on its own. The file states
/// one explicitly when the line order alone would not say it; otherwise the
/// line order is the claim and the node's own stamp dates it.
fn decide_place(
    entry: &Incoming<'_>,
    row: Option<&Row>,
    device: &str,
    clock: &Clock,
    order: &SiblingOrder,
    parent: &str,
) -> Result<Option<(String, String)>, MergeError> {
    let (file_prev, file_stamp) = match &entry.node.place {
        Some((prev, stamp)) => (prev.clone(), stamp.clone()),
        None => (entry.predecessor_id.clone(), entry.node.hlc.clone()),
    };
    let Some(row) = row else {
        return Ok(Some((file_prev, file_stamp)));
    };
    let (row_prev, row_stamp) = if row.prev_hlc.is_empty() {
        (order.predecessor(parent, &row.id), row.hlc.clone())
    } else {
        (row.prev.clone(), row.prev_hlc.clone())
    };
    if file_stamp > row_stamp {
        return Ok(Some((file_prev, file_stamp)));
    }
    if file_stamp < row_stamp || file_prev == row_prev {
        return Ok(None);
    }
    // Same claim stamp, different claim. Whose stamp it is decides, exactly as
    // it does for content: mine means someone dragged lines around in my own
    // vault, which is an edit; theirs means a race, and the value settles it
    // the same way on every device.
    let mine = Hlc::decode(&file_stamp)
        .map(|reading| reading.device() == device)
        .unwrap_or(false);
    if mine {
        return Ok(Some((entry.predecessor_id.clone(), clock.now()?.encode())));
    }
    if digest(&file_prev) > digest(&row_prev) {
        Ok(Some((file_prev, file_stamp)))
    } else {
        Ok(None)
    }
}

/// Spacing the siblings out again is bookkeeping, not an edit — but `sort_key`
/// is in the stamping trigger's column list, so writing it restamps the row and
/// marks it dirty. Both are put back, and a row that was already dirty stays
/// dirty: that flag belongs to a local edit this has no business clearing.
fn respace_sibling(transaction: &Transaction<'_>, id: &str, key: i64) -> Result<(), MergeError> {
    let holder = undirty_holder(transaction, id)?;
    let (stamp, was_dirty): (String, bool) = transaction
        .prepare_cached(
            "SELECT n.hlc, d.node_id IS NOT NULL FROM notes_nodes n
             LEFT JOIN sync_dirty_nodes d ON d.node_id = n.id WHERE n.id = ?1",
        )
        .and_then(|mut statement| {
            statement.query_row([id], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? == 1)))
        })
        .map_err(|error| error.to_string())?;
    transaction
        .prepare_cached("UPDATE notes_nodes SET sort_key = ?2 WHERE id = ?1")
        .and_then(|mut statement| statement.execute(rusqlite::params![id, key]))
        .map_err(|error| error.to_string())?;
    transaction
        .prepare_cached("UPDATE notes_nodes SET hlc = ?2 WHERE id = ?1 AND hlc <> ?2")
        .and_then(|mut statement| statement.execute(rusqlite::params![id, stamp]))
        .map_err(|error| error.to_string())?;
    if !was_dirty {
        unmark(transaction, id)?;
    }
    // Respacing never moves a row out of its parent, so this always applies.
    unmark_holder(transaction, id, holder)?;
    Ok(())
}

fn unmark(transaction: &Transaction<'_>, id: &str) -> Result<(), MergeError> {
    transaction
        .prepare_cached("DELETE FROM sync_dirty_nodes WHERE node_id = ?1")
        .and_then(|mut statement| statement.execute([id]))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// The file that held this row before the write, if it owed nothing at the
/// time. A parent already waiting is waiting for something else, and that is
/// not this write's to take back.
fn undirty_holder(transaction: &Transaction<'_>, id: &str) -> Result<Option<String>, MergeError> {
    transaction
        .prepare_cached(
            "SELECT parent_id FROM notes_nodes
             WHERE id = ?1 AND parent_id IS NOT NULL
               AND parent_id NOT IN (SELECT node_id FROM sync_dirty_nodes)",
        )
        .and_then(|mut statement| {
            statement
                .query_row([id], |row| row.get::<_, String>(0))
                .optional()
        })
        .map_err(|error| error.to_string())
}

/// Takes back the mark on the file that held this row, but only if the row is
/// still in it. A row that moved leaves two files stating something untrue —
/// the one it left still lists it — and both of those writes are owed.
fn unmark_holder(
    transaction: &Transaction<'_>,
    id: &str,
    before: Option<String>,
) -> Result<(), MergeError> {
    let Some(before) = before else {
        return Ok(());
    };
    let still_there: bool = transaction
        .prepare_cached("SELECT parent_id IS ?2 FROM notes_nodes WHERE id = ?1")
        .and_then(|mut statement| {
            statement.query_row(rusqlite::params![id, &before], |row| {
                row.get::<_, i64>(0).map(|same| same == 1)
            })
        })
        .map_err(|error| error.to_string())?;
    if still_there {
        unmark(transaction, &before)?;
    }
    Ok(())
}

fn disk_extension(path: &str) -> String {
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}

/// What actually lands in the row's state columns. A split line contributes
/// none of it once the child document has spoken.
struct NodeState {
    text: String,
    note: String,
    marker: String,
    ordered_start: i64,
    collapsed: bool,
    completed: bool,
    starred: bool,
    extras: String,
}

/// The line states the file's name, its size on screen and its real dimensions.
/// Without a row for that, the comparison can never match on the way back and
/// the line could never be rendered again. The content hash stays empty until
/// the bytes themselves arrive.
fn write_image(
    transaction: &Transaction<'_>,
    id: &str,
    image: &crate::document::ImageReference,
) -> Result<(), MergeError> {
    // The four the format writes. The line's own extension is what names it —
    // there is nowhere else in the file it could come from.
    let mime_type = match disk_extension(&image.path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        other => {
            return Err(format!(
                "`{other}` is not an image type this format writes."
            ));
        }
    };
    let disk_name = image
        .path
        .rsplit('/')
        .next()
        .unwrap_or(&image.path)
        .to_owned();
    let content_hash: String = transaction
        .prepare_cached("SELECT content_hash FROM sync_assets WHERE disk_name = ?1")
        .and_then(|mut statement| {
            statement
                .query_row([&disk_name], |row| row.get::<_, String>(0))
                .optional()
        })
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    transaction
        .prepare_cached(
            "INSERT INTO notes_images(
                 node_id, content_hash, relative_path, original_name, mime_type,
                 display_width, pixel_width, pixel_height, byte_length)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(node_id) DO UPDATE SET
                 content_hash = excluded.content_hash,
                 relative_path = excluded.relative_path,
                 original_name = excluded.original_name,
                 mime_type = excluded.mime_type,
                 display_width = excluded.display_width,
                 pixel_width = excluded.pixel_width,
                 pixel_height = excluded.pixel_height,
                 byte_length = excluded.byte_length",
        )
        .and_then(|mut statement| {
            statement.execute(rusqlite::params![
                id,
                content_hash,
                image.path,
                image.original_name,
                mime_type,
                i64::from(image.display_width),
                i64::from(image.pixel_width),
                i64::from(image.pixel_height),
                image.byte_size as i64,
            ])
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Tokens this version has no meaning for, in the order they were read.
fn extras_of(entry: &Incoming<'_>) -> String {
    let mut tokens: Vec<String> = entry.node.unknown_tokens.clone();
    if let NodeBody::Image(image) = &entry.node.body {
        tokens.extend(image.unknown_tokens.iter().cloned());
    }
    tokens.join(" ")
}

/// One shape for an image's state, built the same way from a file line and from
/// a row — otherwise the two could never compare equal and every replay of the
/// same picture would read as an edit.
fn image_content(
    name: &str,
    path: &str,
    display_width: i64,
    pixel_width: i64,
    pixel_height: i64,
    byte_length: i64,
) -> String {
    format!(
        "{name}\u{0}{path}\u{0}{display_width}\u{0}{pixel_width}x{pixel_height}\u{0}{byte_length}"
    )
}

/// What the merge compares when two stamps are equal, and what M4 will hash for
/// the export record. Field order is fixed so two devices build the same bytes.
fn content_of_file(entry: &Incoming<'_>, trash: bool) -> String {
    let (marker, ordered_start) = match entry.node.marker {
        Marker::Bullet => ("bullet", 1),
        Marker::Todo => ("todo", 1),
        Marker::Ordered(start) => ("ordered", start),
    };
    let (kind, text) = match &entry.node.body {
        NodeBody::Text(text) => ("bullet", text.clone()),
        NodeBody::Image(image) => (
            "image",
            image_content(
                &image.original_name,
                &image.path,
                i64::from(image.display_width),
                i64::from(image.pixel_width),
                i64::from(image.pixel_height),
                image.byte_size as i64,
            ),
        ),
        // Position and existence are all a split line asserts, so nothing
        // else may enter its comparison — otherwise a stale display title
        // would read as an edit on every merge.
        NodeBody::Split { .. } => ("split", String::new()),
    };
    if kind == "split" {
        // A split line asserts existence and place, and place is compared
        // separately, so a line has no state of its own to compare at all.
        return ["v1".to_owned(), kind.to_owned()].join("\u{0}");
    }
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
        (trash || entry.node.from.is_some()).to_string(),
        extras_of(entry),
    ]
    .join("\u{0}")
}

/// `split` comes from the file's line, not the row: the row cannot tell whether
/// the node currently lives in a document of its own, and the comparison has to
/// be the same shape on both sides.
fn content_of_row(row: &Row, split: bool) -> String {
    if split {
        return ["v1".to_owned(), "split".to_owned()].join("\u{0}");
    }
    let text = match &row.image {
        Some(image) => image_content(
            &row.text,
            &image.path,
            image.display_width,
            image.pixel_width,
            image.pixel_height,
            image.byte_length,
        ),
        None => row.text.clone(),
    };
    [
        "v1".to_owned(),
        row.kind.clone(),
        text,
        row.note.clone(),
        row.marker.clone(),
        row.ordered_start.to_string(),
        row.collapsed.to_string(),
        row.completed.to_string(),
        row.starred.to_string(),
        row.deleted.to_string(),
        row.extras.clone(),
    ]
    .join("\u{0}")
}

/// A defeated state, complete enough that the conflict screen can show it and
/// re-apply it with nothing else on hand. Re-applying is a new edit, so it
/// carries everything a new edit would — including where the node sat, which is
/// a parent *and* the sibling it followed.
fn loser_of_row(row: &Row, predecessor: &str, reason: &str) -> String {
    json_object(&[
        ("v", Value::Number(1)),
        ("id", Value::Text(row.id.clone())),
        (
            "parent_id",
            Value::Text(row.parent_id.clone().unwrap_or_default()),
        ),
        ("predecessor_id", Value::Text(predecessor.to_owned())),
        ("kind", Value::Text(row.kind.clone())),
        ("text", Value::Text(row.text.clone())),
        ("note", Value::Text(row.note.clone())),
        ("marker", Value::Text(row.marker.clone())),
        ("ordered_start", Value::Number(row.ordered_start)),
        ("collapsed", Value::Bool(row.collapsed)),
        ("completed", Value::Bool(row.completed)),
        ("starred", Value::Bool(row.starred)),
        ("deleted", Value::Bool(row.deleted)),
        (
            "image",
            match &row.image {
                Some(image) => Value::Strings(vec![
                    image.path.clone(),
                    image.display_width.to_string(),
                    image.pixel_width.to_string(),
                    image.pixel_height.to_string(),
                    image.byte_length.to_string(),
                ]),
                None => Value::Null,
            },
        ),
        ("extras", Value::Strings(split_extras(&row.extras))),
        ("reason", Value::Text(reason.to_owned())),
    ])
}

fn loser_of_file(entry: &Incoming<'_>, trash: bool, reason: &str) -> String {
    let (kind, text) = match &entry.node.body {
        NodeBody::Text(text) => ("bullet", text.clone()),
        NodeBody::Image(image) => ("image", image.original_name.clone()),
        NodeBody::Split { title, .. } => ("bullet", title.clone()),
    };
    let (marker, ordered_start) = match entry.node.marker {
        Marker::Bullet => ("bullet", 1),
        Marker::Todo => ("todo", 1),
        Marker::Ordered(start) => ("ordered", start),
    };
    json_object(&[
        ("v", Value::Number(1)),
        ("id", Value::Text(entry.id.clone())),
        ("parent_id", Value::Text(entry.parent_id.clone())),
        ("predecessor_id", Value::Text(entry.predecessor_id.clone())),
        ("kind", Value::Text(kind.to_owned())),
        ("text", Value::Text(text)),
        ("note", Value::Text(entry.node.note.clone())),
        ("marker", Value::Text(marker.to_owned())),
        ("ordered_start", Value::Number(ordered_start)),
        ("collapsed", Value::Bool(entry.node.collapsed)),
        ("completed", Value::Bool(entry.node.completed)),
        ("starred", Value::Bool(entry.node.starred)),
        ("deleted", Value::Bool(trash || entry.node.from.is_some())),
        (
            "image",
            match &entry.node.body {
                NodeBody::Image(image) => Value::Strings(vec![
                    image.path.clone(),
                    image.display_width.to_string(),
                    image.pixel_width.to_string(),
                    image.pixel_height.to_string(),
                    image.byte_size.to_string(),
                ]),
                _ => Value::Null,
            },
        ),
        ("extras", Value::Strings(split_extras(&extras_of(entry)))),
        ("reason", Value::Text(reason.to_owned())),
    ])
}

fn split_extras(extras: &str) -> Vec<String> {
    if extras.is_empty() {
        Vec::new()
    } else {
        extras.split(' ').map(str::to_owned).collect()
    }
}

/// A JSON object built by hand. Control characters have to be escaped or the
/// value is not JSON at all, and a defeat nobody can parse is a defeat nobody
/// can recover.
fn json_object(fields: &[(&str, Value)]) -> String {
    let mut json = String::from("{");
    for (index, (key, value)) in fields.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push('"');
        json.push_str(key);
        json.push_str("\":");
        match value {
            Value::Text(text) => json.push_str(&json_string(text)),
            Value::Number(number) => json.push_str(&number.to_string()),
            Value::Bool(flag) => json.push_str(if *flag { "true" } else { "false" }),
            Value::Strings(items) => {
                json.push('[');
                for (at, item) in items.iter().enumerate() {
                    if at > 0 {
                        json.push(',');
                    }
                    json.push_str(&json_string(item));
                }
                json.push(']');
            }
            Value::Null => json.push_str("null"),
        }
    }
    json.push('}');
    json
}

enum Value {
    Text(String),
    Number(i64),
    Bool(bool),
    Strings(Vec<String>),
    Null,
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            // The named escapes are only for readability; the range below is
            // what makes the value JSON at all.
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            character if (character as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => out.push(character),
        }
    }
    out.push('"');
    out
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
             SELECT ?1, ?2, ?3, ?4, unixepoch()
             WHERE NOT EXISTS (
                 SELECT 1 FROM sync_conflict_log
                 WHERE node_id = ?1 AND loser_hlc = ?3 AND loser_json = ?2
             )",
            rusqlite::params![node_id, loser_json, loser_hlc, winner_hlc],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// A document that should hold a node the file left out gets rewritten. The
/// node is not touched — the file is simply incomplete, and the next export
/// finishes it.
///
/// Two bounds matter. Only nodes older than the document's own high-water mark
/// count: a node stamped after the file was written is simply newer than the
/// file, not missing from it. And the walk stops at split boundaries, since a
/// child that lives in its own document is supposed to be absent here.
fn document_is_missing_nodes(
    transaction: &Transaction<'_>,
    root_id: &str,
    max_hlc: &str,
    incoming: &[Incoming<'_>],
) -> Result<bool, MergeError> {
    let seen = json_list(
        &incoming
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>(),
    );
    // One statement for the whole subtree: this runs on every merge, echoes
    // included, so its cost must not follow the document's size in round trips.
    // The walk stops at nodes that own a document of their own — a split child
    // is supposed to be absent here — and a placeholder waiting for its real
    // document carries no stamp, which is not the same as being older than one.
    transaction
        .prepare_cached(
            "WITH RECURSIVE subtree(id) AS (
                 SELECT id FROM notes_nodes WHERE parent_id = ?1 AND deleted = 0
                 UNION ALL
                 SELECT n.id FROM notes_nodes n
                 JOIN subtree s ON n.parent_id = s.id
                 WHERE n.deleted = 0
                   AND NOT EXISTS (SELECT 1 FROM sync_documents d WHERE d.root_id = s.id)
             )
             SELECT EXISTS (
                 SELECT 1 FROM subtree
                 JOIN notes_nodes n ON n.id = subtree.id
                 WHERE n.hlc <> '' AND n.hlc < ?2
                   AND subtree.id NOT IN (SELECT value FROM json_each(?3))
             )",
        )
        .and_then(|mut statement| {
            statement.query_row(rusqlite::params![root_id, max_hlc, seen], |row| {
                row.get::<_, i64>(0)
            })
        })
        .map(|found| found == 1)
        .map_err(|error| error.to_string())
}

/// Where a document is kept, and what was last read from it.
///
/// A conflicted copy is read but never recorded: it holds the same document
/// id, so recording it would move that document's file to the copy's name.
/// Every later write would go into the copy while the real file went stale,
/// and two devices would swap the name back and forth for ever.
fn record_document(
    transaction: &Transaction<'_>,
    root_id: &str,
    input: &MergeInput,
    max_hlc: &str,
) -> Result<(), MergeError> {
    if crate::watcher::is_conflicted_copy(&input.file_path) {
        return Ok(());
    }
    // The bytes on disk are exactly what was just absorbed, so replacing them
    // loses nothing — recording anything else would leave the exporter
    // answering "somebody's edit" forever and the canonical form would never
    // reach the file. What says the file is behind is the root's dirty mark.
    let exported_hash = input.file_hash.clone();
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

fn mark_dirty(transaction: &Transaction<'_>, id: &str) -> Result<(), MergeError> {
    transaction
        .prepare_cached(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, unixepoch())
             ON CONFLICT(node_id) DO NOTHING",
        )
        .and_then(|mut statement| statement.execute([id]))
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
