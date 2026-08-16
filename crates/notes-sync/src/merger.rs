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
            positioned: false,
        });
    }
    flatten(&page.nodes, &root_id, &mut incoming);

    apply(transaction, clock, &mut incoming, &mut outcome, false)?;
    repair_structure(transaction, clock, &mut outcome)?;
    outcome.needs_write_back |=
        document_is_missing_nodes(transaction, &root_id, &page.max_hlc, &incoming)?;
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
    repair_structure(transaction, clock, &mut outcome)?;
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
    for node in nodes {
        // A trash root states where it was taken from, and that is its place —
        // the line it sits on in the trash says nothing about where it belongs.
        let (parent_id, positioned) = match &node.from {
            Some((from, _)) => (from.clone(), false),
            None => (parent_id.to_owned(), true),
        };
        out.push(Incoming {
            id: node.id.clone(),
            node,
            parent_id,
            predecessor_id: predecessor.clone(),
            positioned,
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
    let existing = load_rows(transaction, incoming)?;
    for entry in incoming.iter_mut() {
        // A line with no id was typed by a person. The merge issues one; the
        // write-back that follows from the stamp teaches the file about it.
        if entry.id.is_empty() {
            entry.id = Uuid::new_v4().hyphenated().to_string();
        }
    }
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
        let row_content = row.map(|row| content_of_row(row, entry.positioned, &order));

        let (verdict, stamp, reason) = decide(
            row,
            deleted_now,
            &file_content,
            row_content.as_deref(),
            &file_hlc,
            drifted,
            clock,
            &device,
        )?;

        match verdict {
            Verdict::Skip => {}
            Verdict::Write => {
                if let Some(reason) = reason {
                    // What was lost is the row when there was one — a drifted
                    // stamp overwriting a local edit takes content with it, and
                    // a dirty row's content exists nowhere else at all. With no
                    // row, only the file's own stamp was discarded.
                    let (loser, loser_hlc) = match row {
                        Some(row) => (loser_of_row(row, reason.as_str()), row.hlc.clone()),
                        None => (
                            loser_of_file(entry, trash, reason.as_str()),
                            file_hlc.clone(),
                        ),
                    };
                    log_conflict(transaction, &entry.id, &loser, &loser_hlc, &stamp)?;
                    outcome.conflicts_recorded += 1;
                }
                write_row(transaction, entry, &stamp, trash, row, &mut order)?;
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
                    &loser_of_file(entry, trash, "lww"),
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
    *cached = Some(id.clone());
    Ok(id)
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
        transaction
            .prepare_cached(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, deleted, hlc)
                 VALUES (?1, 'root', ?2, 'bullet', '', 1, '')
                 ON CONFLICT(id) DO NOTHING",
            )
            .and_then(|mut statement| statement.execute(rusqlite::params![parent, SORT_KEY_STEP]))
            .map_err(|error| error.to_string())?;
        // The insert trigger stamps anything that arrives without a reading,
        // and a stamped placeholder would outrank the document it is waiting
        // for. Put the emptiness back, and take the dirty mark with it.
        transaction
            .prepare_cached("UPDATE notes_nodes SET hlc = '' WHERE id = ?1 AND text = ''")
            .and_then(|mut statement| statement.execute([parent]))
            .map_err(|error| error.to_string())?;
        transaction
            .prepare_cached("DELETE FROM sync_dirty_nodes WHERE node_id = ?1")
            .and_then(|mut statement| statement.execute([parent]))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Who follows whom under each parent this merge touches, and with what keys.
/// Held in memory because the answer changes as the merge writes.
struct SiblingOrder {
    children: BTreeMap<String, Vec<String>>,
    keys: BTreeMap<String, i64>,
}

impl SiblingOrder {
    fn load(
        transaction: &Transaction<'_>,
        incoming: &[Incoming<'_>],
        existing: &BTreeMap<String, Row>,
    ) -> Result<Self, MergeError> {
        let mut parents: BTreeSet<String> = incoming
            .iter()
            .filter(|entry| entry.positioned)
            .map(|entry| entry.parent_id.clone())
            .collect();
        for row in existing.values() {
            if let Some(parent) = &row.parent_id {
                parents.insert(parent.clone());
            }
        }
        parents.remove("");
        let mut children = BTreeMap::new();
        let mut keys = BTreeMap::new();
        if parents.is_empty() {
            return Ok(Self { children, keys });
        }
        // One statement for every parent this merge can touch, not one each.
        let mut statement = transaction
            .prepare_cached(
                "SELECT parent_id, id, sort_key FROM notes_nodes
                 WHERE parent_id IN (SELECT value FROM json_each(?1)) AND deleted = 0
                 ORDER BY parent_id, sort_key, id",
            )
            .map_err(|error| error.to_string())?;
        let list = json_list(&parents.iter().cloned().collect::<Vec<_>>());
        let rows = statement
            .query_map([list], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (parent, id, key) = row.map_err(|error| error.to_string())?;
            children
                .entry(parent)
                .or_insert_with(Vec::new)
                .push(id.clone());
            keys.insert(id, key);
        }
        Ok(Self { children, keys })
    }

    fn predecessor(&self, parent: &str, id: &str) -> String {
        let Some(siblings) = self.children.get(parent) else {
            return String::new();
        };
        let Some(at) = siblings.iter().position(|sibling| sibling == id) else {
            return String::new();
        };
        if at == 0 {
            String::new()
        } else {
            siblings[at - 1].clone()
        }
    }

    /// Places a node after the sibling the file says it follows, and answers
    /// with the key it should carry.
    fn place_after(&mut self, parent: &str, id: &str, predecessor: &str) -> Placement {
        let siblings = self.children.entry(parent.to_owned()).or_default();
        siblings.retain(|sibling| sibling != id);
        let at = if predecessor.is_empty() {
            0
        } else {
            siblings
                .iter()
                .position(|sibling| sibling == predecessor)
                .map_or(siblings.len(), |index| index + 1)
        };
        siblings.insert(at, id.to_owned());
        let before = at
            .checked_sub(1)
            .and_then(|index| self.keys.get(&siblings[index]).copied());
        let after = siblings
            .get(at + 1)
            .and_then(|sibling| self.keys.get(sibling).copied());
        match (before, after) {
            (None, None) => {
                self.keys.insert(id.to_owned(), SORT_KEY_STEP);
                Placement::Key(SORT_KEY_STEP)
            }
            (None, Some(after)) => {
                let key = after - SORT_KEY_STEP;
                if key >= after {
                    return self.renumber(parent);
                }
                self.keys.insert(id.to_owned(), key);
                Placement::Key(key)
            }
            (Some(before), None) => {
                let Some(key) = before.checked_add(SORT_KEY_STEP) else {
                    return self.renumber(parent);
                };
                self.keys.insert(id.to_owned(), key);
                Placement::Key(key)
            }
            (Some(before), Some(after)) => {
                // Midpoint only while there is room. Halving a gap thirty-two
                // times reaches one, and a midpoint of a gap of one is the
                // predecessor's own key — a duplicate that sorts by id and puts
                // the node in front of what it must follow.
                if after - before > 1 {
                    let key = before + (after - before) / 2;
                    self.keys.insert(id.to_owned(), key);
                    Placement::Key(key)
                } else {
                    self.renumber(parent)
                }
            }
        }
    }

    /// Out of room between two neighbours, so the whole sibling list is spaced
    /// out again. Every one of them has to be written, which is why it only
    /// happens when the gap is actually gone.
    fn renumber(&mut self, parent: &str) -> Placement {
        let siblings = self.children.get(parent).cloned().unwrap_or_default();
        let mut spaced = Vec::with_capacity(siblings.len());
        for (index, sibling) in siblings.iter().enumerate() {
            let key = (index as i64 + 1) * SORT_KEY_STEP;
            self.keys.insert(sibling.clone(), key);
            spaced.push((sibling.clone(), key));
        }
        Placement::Renumbered(spaced)
    }

    fn key(&self, id: &str) -> Option<i64> {
        self.keys.get(id).copied()
    }

    /// A page arriving for the first time goes at the end of the list. Where it
    /// really belongs is home's business, and home will say so.
    fn append(&mut self, parent: &str, id: &str) -> i64 {
        let siblings = self.children.entry(parent.to_owned()).or_default();
        let key = siblings
            .last()
            .and_then(|last| self.keys.get(last).copied())
            .map_or(SORT_KEY_STEP, |last| last.saturating_add(SORT_KEY_STEP));
        siblings.push(id.to_owned());
        self.keys.insert(id.to_owned(), key);
        key
    }
}

enum Placement {
    Key(i64),
    /// The keys every sibling now carries, this node included.
    Renumbered(Vec<(String, i64)>),
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

    if drifted {
        // Replaying the same broken file before the write-back lands must not
        // mint a new stamp each round, or the replay never settles.
        if same_content {
            return Ok((Verdict::Skip, row.hlc.clone(), None));
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

    // Equal stamps, different content: whoever changed it did not restamp it,
    // so it was edited by hand. Which machine that happened on is the only
    // thing that matters, and the stamp's own device field is the one piece of
    // evidence that survives the trip — the watcher cannot tell iCloud from
    // vim, and a hash mismatch looks the same either way.
    let mine = Hlc::decode(file_hlc).map(|reading| reading.device() == device);
    if mine.unwrap_or(false) {
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
                    d.node_id IS NOT NULL,
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
                    image: match row.get::<_, Option<String>>(15)? {
                        Some(path) => Some(ImageRow {
                            path,
                            display_width: row.get(16)?,
                            pixel_width: row.get(17)?,
                            pixel_height: row.get(18)?,
                            byte_length: row.get(19)?,
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
    order: &mut SiblingOrder,
) -> Result<(), MergeError> {
    let (marker, ordered_start) = match entry.node.marker {
        Marker::Bullet => ("bullet", 1),
        Marker::Todo => ("todo", 1),
        Marker::Ordered(start) => ("ordered", start),
    };
    let (kind, text) = match &entry.node.body {
        NodeBody::Text(text) => ("bullet", text.clone()),
        NodeBody::Image(image) => ("image", image.original_name.clone()),
        // The line's title is a display copy; the child document's frontmatter
        // is what owns this node's state, and giving the line authority here
        // would make merge order decide the answer. Wiring that up is M3.1e's.
        NodeBody::Split { .. } => {
            return Err("A split line has no state of its own to write.".to_owned());
        }
    };
    let parent_id = if entry.positioned || entry.node.from.is_some() {
        Some(entry.parent_id.clone())
    } else {
        // A page's place is its line in home, so its own file cannot move it.
        row.and_then(|row| row.parent_id.clone())
            .or_else(|| Some("root".to_owned()))
    };
    let parent = parent_id.clone().unwrap_or_else(|| "root".to_owned());
    let mut renumbered = Vec::new();
    let sort_key = if entry.positioned {
        match order.place_after(&parent, &entry.id, &entry.predecessor_id) {
            Placement::Key(key) => key,
            Placement::Renumbered(all) => {
                let key = all
                    .iter()
                    .find(|(id, _)| id == &entry.id)
                    .map(|(_, key)| *key)
                    .unwrap_or(SORT_KEY_STEP);
                renumbered = all;
                key
            }
        }
    } else if let Some((_, from_key)) = &entry.node.from {
        // Where it was deleted from. The row remembering that is the whole of
        // restoring: clearing the flag puts it back exactly where it stood.
        *from_key
    } else {
        match row.map(|row| row.sort_key).or_else(|| order.key(&entry.id)) {
            Some(key) => key,
            None => order.append(&parent, &entry.id),
        }
    };
    // In a page document a node's presence is the statement that it is live;
    // in the trash it is the statement that it is not.
    let deleted = trash;
    let extras = extras_of(entry);

    // The stamp is written with the row, so the stamping triggers leave it
    // alone: they only fire when the value is unchanged or empty.
    transaction
        .prepare_cached(
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
        )
        .and_then(|mut statement| {
            statement.execute(rusqlite::params![
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
            ])
        })
        .map_err(|error| error.to_string())?;

    if let NodeBody::Image(image) = &entry.node.body {
        write_image(transaction, &entry.id, image)?;
    }
    for (id, key) in renumbered {
        if id == entry.id {
            continue;
        }
        respace_sibling(transaction, &id, key)?;
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
    // marked on the way through.
    transaction
        .prepare_cached("DELETE FROM sync_dirty_nodes WHERE node_id = ?1")
        .and_then(|mut statement| statement.execute([&entry.id]))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Spacing the siblings out again is bookkeeping, not an edit — but `sort_key`
/// is in the stamping trigger's column list, so writing it restamps the row and
/// marks it dirty. Both are put back, and a row that was already dirty stays
/// dirty: that flag belongs to a local edit this has no business clearing.
fn respace_sibling(transaction: &Transaction<'_>, id: &str, key: i64) -> Result<(), MergeError> {
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
        transaction
            .prepare_cached("DELETE FROM sync_dirty_nodes WHERE node_id = ?1")
            .and_then(|mut statement| statement.execute([id]))
            .map_err(|error| error.to_string())?;
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
        (trash || entry.node.from.is_some()).to_string(),
        if entry.positioned {
            entry.parent_id.clone()
        } else {
            String::new()
        },
        if entry.positioned {
            entry.predecessor_id.clone()
        } else {
            String::new()
        },
        extras_of(entry),
    ]
    .join("\u{0}")
}

fn content_of_row(row: &Row, positioned: bool, order: &SiblingOrder) -> String {
    let parent = row.parent_id.clone().unwrap_or_default();
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
        if positioned {
            parent.clone()
        } else {
            String::new()
        },
        if positioned {
            order.predecessor(&parent, &row.id)
        } else {
            String::new()
        },
        row.extras.clone(),
    ]
    .join("\u{0}")
}

/// A defeated state, complete enough that the conflict screen can show it and
/// re-apply it with nothing else on hand. Re-applying is a new edit, so it
/// needs everything a new edit would carry — including where the node sat.
fn loser_of_row(row: &Row, reason: &str) -> String {
    json_object(&[
        ("v", "1".to_owned()),
        ("id", row.id.clone()),
        ("parent_id", row.parent_id.clone().unwrap_or_default()),
        ("kind", row.kind.clone()),
        ("text", row.text.clone()),
        ("note", row.note.clone()),
        ("marker", row.marker.clone()),
        ("ordered_start", row.ordered_start.to_string()),
        ("collapsed", row.collapsed.to_string()),
        ("completed", row.completed.to_string()),
        ("starred", row.starred.to_string()),
        ("deleted", row.deleted.to_string()),
        ("extras", row.extras.clone()),
        ("reason", reason.to_owned()),
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
        ("v", "1".to_owned()),
        ("id", entry.id.clone()),
        ("parent_id", entry.parent_id.clone()),
        ("kind", kind.to_owned()),
        ("text", text),
        ("note", entry.node.note.clone()),
        ("marker", marker.to_owned()),
        ("ordered_start", ordered_start.to_string()),
        ("collapsed", entry.node.collapsed.to_string()),
        ("completed", entry.node.completed.to_string()),
        ("starred", entry.node.starred.to_string()),
        ("deleted", (trash || entry.node.from.is_some()).to_string()),
        ("extras", extras_of(entry)),
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
    let seen: BTreeSet<String> = incoming.iter().map(|entry| entry.id.clone()).collect();
    let mut frontier = vec![root_id.to_owned()];
    let mut statement = transaction
        .prepare_cached(
            "SELECT n.id, n.hlc, d.root_id IS NOT NULL
             FROM notes_nodes n
             LEFT JOIN sync_documents d ON d.root_id = n.id
             WHERE n.parent_id = ?1 AND n.deleted = 0",
        )
        .map_err(|error| error.to_string())?;
    while let Some(parent) = frontier.pop() {
        let children = statement
            .query_map([&parent], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? == 1,
                ))
            })
            .map_err(|error| error.to_string())?;
        for child in children {
            let (id, hlc, own_document) = child.map_err(|error| error.to_string())?;
            if !seen.contains(&id) && hlc.as_str() < max_hlc {
                return Ok(true);
            }
            if !own_document {
                frontier.push(id);
            }
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
