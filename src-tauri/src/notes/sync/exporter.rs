use crate::notes::connection::{lock_notes_connection, SharedNotesConnection};
use crate::notes::export::normalize_newlines;
use crate::notes::github_notifications::{
    parse_github_plugin_meta_storage, GithubNotificationsPluginMeta,
    GithubNotificationsPluginState, GITHUB_NOTIFICATIONS_FILENAME, GITHUB_NOTIFICATIONS_PLUGIN_ID,
    GITHUB_NOTIFICATIONS_ROOT_ID,
};
use crate::notes::markdown_import::MAX_MARKDOWN_BYTES;
use crate::notes::repository::{MAX_NOTES_EXPORT_DEPTH, MAX_NOTES_EXPORT_NODES, SORT_KEY_STEP};
use crate::notes::schema::SYNC_REMOVE_TOPIC_PREFIX;
use crate::notes::sync::topic_file::{
    canonicalize_topic_file_semantics, derive_topic_filename, render_topic_file, PurgedTombstone,
    TopicAttachment, TopicContent, TopicDoc, TopicFile, TopicNode, TopicPluginMeta, TopicRoot,
    TrashDoc, TOPIC_FORMAT_VERSION,
};
use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
use crate::notes::types::NoteMarkerKind;
use cap_std::{ambient_authority, fs::Dir};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

type TopicRenderer<'a> = dyn Fn(&TopicFile) -> Result<Vec<u8>, String> + 'a;
type AtomicWriter<'a> = dyn FnMut(&Path, &[u8]) -> Result<(), String> + 'a;

pub(crate) const TRASH_TOPIC_ID: &str = "__yonalist_trash__";
pub(crate) const TRASH_FILE_NAME: &str = "trash.md";
/// Prefix for write-once trash overflow segments: `trash-archive-<seq>.md`
/// (spec A2.5). The parser accepts them as `kind: yonalist-trash` documents.
pub(crate) const TRASH_ARCHIVE_PREFIX: &str = "trash-archive-";

/// Recognizes a `trash-archive-<seq>.md` segment filename and returns its
/// sequence number, or `None` for any other name.
pub(crate) fn trash_archive_seq(file_name: &str) -> Option<i64> {
    file_name
        .strip_prefix(TRASH_ARCHIVE_PREFIX)?
        .strip_suffix(".md")?
        .parse::<i64>()
        .ok()
        .filter(|seq| *seq >= 0)
}

#[cfg(test)]
thread_local! {
    static INJECT_AFTER_UNLOCKED_WRITE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_after_unlocked_write_once(action: impl FnOnce() + 'static) {
    INJECT_AFTER_UNLOCKED_WRITE.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_after_unlocked_write() {
    INJECT_AFTER_UNLOCKED_WRITE.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_after_unlocked_write() {}

const IDLE_DEBOUNCE: Duration = Duration::from_secs(3);
const MAX_DEBOUNCE: Duration = Duration::from_secs(30);

#[cfg(test)]
thread_local! {
    static BEFORE_ATOMIC_EXPORT_PUBLICATION_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static AFTER_TOPIC_REMOVAL_PUBLICATION_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn inject_before_atomic_export_publication_once(action: impl FnOnce() + 'static) {
    BEFORE_ATOMIC_EXPORT_PUBLICATION_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
pub(crate) fn inject_after_topic_removal_publication_once(action: impl FnOnce() + 'static) {
    AFTER_TOPIC_REMOVAL_PUBLICATION_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_before_atomic_export_publication() {
    BEFORE_ATOMIC_EXPORT_PUBLICATION_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn maybe_inject_after_topic_removal_publication() {
    AFTER_TOPIC_REMOVAL_PUBLICATION_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_atomic_export_publication() {}

#[cfg(not(test))]
fn maybe_inject_after_topic_removal_publication() {}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum ExportTarget {
    Topic(String),
    Trash,
    RemoveTopic(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DirtyMarker {
    node_id: String,
    marked_at: String,
    node_hlc: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingExport {
    pub(crate) target: ExportTarget,
    dirty: Vec<DirtyMarker>,
    pub(crate) fingerprint: String,
}

#[derive(Debug, Default)]
pub(crate) struct ExportBatchOutcome {
    pub(crate) exported: usize,
    pub(crate) succeeded: Vec<ExportTarget>,
    // B6: the target and the exact error string for every export that failed
    // this batch, so the runtime can count consecutive same-error failures and
    // quarantine a wedged topic instead of retrying it forever in silence.
    pub(crate) failed: Vec<(ExportTarget, String)>,
    errors: Vec<String>,
}

impl ExportBatchOutcome {
    pub(crate) fn errors(&self) -> &[String] {
        &self.errors
    }

    pub(crate) fn result(&self) -> Result<(), String> {
        if self.errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "One or more Notes exports failed: {}",
                self.errors.join("; ")
            ))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExportSnapshot {
    target: ExportTarget,
    file_name: String,
    document: TopicFile,
    dirty: Vec<DirtyMarker>,
}

#[derive(Debug)]
struct StoredNode {
    id: String,
    parent_id: Option<String>,
    sort_key: i64,
    title: String,
    note: String,
    image_offset_utf16: i64,
    markdown_image_width: Option<i64>,
    node_kind: String,
    marker_kind: NoteMarkerKind,
    starred: bool,
    completed_at: Option<String>,
    archived_at: Option<String>,
    deleted_batch_id: Option<String>,
    hlc: String,
    is_collapsed: bool,
    is_readonly: Option<bool>,
    plugin_state: Option<GithubNotificationsPluginState>,
    plugin_meta: Option<GithubNotificationsPluginMeta>,
}

#[derive(Debug)]
struct StoredAttachment {
    content_hash: String,
    original_name: String,
    mime_type: String,
    display_width: i64,
}

#[derive(Debug)]
struct PendingWindow {
    first_seen: Duration,
    last_changed: Duration,
    fingerprint: String,
}

#[derive(Debug, Default)]
pub(crate) struct DebounceSchedule {
    pending: BTreeMap<ExportTarget, PendingWindow>,
}

impl DebounceSchedule {
    pub(crate) fn due(
        &mut self,
        now: Duration,
        observed: BTreeMap<ExportTarget, String>,
        force: bool,
    ) -> Vec<ExportTarget> {
        self.pending
            .retain(|target, _| observed.contains_key(target));
        for (target, fingerprint) in &observed {
            match self.pending.get_mut(target) {
                Some(window) if window.fingerprint != *fingerprint => {
                    window.last_changed = now;
                    window.fingerprint.clone_from(fingerprint);
                }
                Some(_) => {}
                None => {
                    self.pending.insert(
                        target.clone(),
                        PendingWindow {
                            first_seen: now,
                            last_changed: now,
                            fingerprint: fingerprint.clone(),
                        },
                    );
                }
            }
        }

        let due = self
            .pending
            .iter()
            .filter(|(target, window)| {
                observed.contains_key(*target)
                    && (force
                        || now.saturating_sub(window.last_changed) >= IDLE_DEBOUNCE
                        || now.saturating_sub(window.first_seen) >= MAX_DEBOUNCE)
            })
            .map(|(target, _)| target.clone())
            .collect::<Vec<_>>();
        due
    }

    pub(crate) fn complete(&mut self, target: &ExportTarget) {
        self.pending.remove(target);
    }
}

pub(crate) fn load_pending_exports(
    connection: &Connection,
) -> Result<BTreeMap<ExportTarget, PendingExport>, String> {
    let mut statement = connection
        .prepare(
            "SELECT dirty.node_id, dirty.marked_at, node.hlc, node.deleted_at \
             FROM sync_dirty_nodes dirty \
             LEFT JOIN notes_nodes node ON node.id = dirty.node_id \
             ORDER BY dirty.node_id",
        )
        .map_err(|error| format!("Could not prepare dirty Notes exports: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| format!("Could not load dirty Notes exports: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read dirty Notes exports: {error}"))?;

    let mut dirty_by_target = BTreeMap::<ExportTarget, Vec<DirtyMarker>>::new();
    for (node_id, marked_at, node_hlc, deleted_at) in rows {
        let target = if let Some(topic_id) = node_id.strip_prefix(SYNC_REMOVE_TOPIC_PREFIX) {
            if uuid::Uuid::parse_str(topic_id).is_err() {
                return Err(format!("Invalid Notes topic-removal marker {node_id}."));
            }
            if topic_is_live_root(connection, topic_id)? {
                ExportTarget::Topic(topic_id.to_string())
            } else {
                ExportTarget::RemoveTopic(topic_id.to_string())
            }
        } else if node_id == TRASH_TOPIC_ID {
            ExportTarget::Trash
        } else if node_hlc.is_none() {
            if topic_metadata_exists(connection, &node_id)? {
                ExportTarget::RemoveTopic(node_id.clone())
            } else {
                ExportTarget::Trash
            }
        } else if deleted_at.is_some() {
            if let Some(topic_id) = resolve_live_topic_for_deleted_node(connection, &node_id)? {
                ExportTarget::Topic(topic_id)
            } else if topic_metadata_exists(connection, &node_id)? {
                ExportTarget::RemoveTopic(node_id.clone())
            } else {
                ExportTarget::Trash
            }
        } else {
            ExportTarget::Topic(resolve_topic_id(connection, &node_id)?)
        };
        let quarantined = match &target {
            ExportTarget::Topic(topic_id) => metadata_quarantined(connection, topic_id),
            ExportTarget::Trash => metadata_quarantined(connection, TRASH_TOPIC_ID),
            ExportTarget::RemoveTopic(topic_id) => metadata_quarantined(connection, topic_id),
        }?;
        if quarantined {
            continue;
        }
        let marker = DirtyMarker {
            node_id,
            marked_at,
            node_hlc,
        };
        dirty_by_target.entry(target).or_default().push(marker);
    }

    Ok(dirty_by_target
        .into_iter()
        .map(|(target, dirty)| {
            let fingerprint = dirty
                .iter()
                .map(|marker| {
                    format!(
                        "{}\0{}\0{}",
                        marker.node_id,
                        marker.marked_at,
                        marker.node_hlc.as_deref().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("\0");
            (
                target.clone(),
                PendingExport {
                    dirty,
                    target,
                    fingerprint,
                },
            )
        })
        .collect())
}

fn topic_metadata_exists(connection: &Connection, topic_id: &str) -> Result<bool, String> {
    crate::notes::sync::topic_metadata_exists(connection, topic_id)
        .map_err(|error| format!("Could not inspect Notes topic metadata: {error}"))
}

fn resolve_live_topic_for_deleted_node(
    connection: &Connection,
    node_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "WITH RECURSIVE ancestors(id, parent_id, deleted_at, depth) AS (\
               SELECT parent.id, parent.parent_id, parent.deleted_at, 0 \
               FROM notes_nodes child JOIN notes_nodes parent ON parent.id = child.parent_id \
               WHERE child.id = ?1 \
               UNION ALL \
               SELECT parent.id, parent.parent_id, parent.deleted_at, ancestors.depth + 1 \
               FROM notes_nodes parent JOIN ancestors ON ancestors.parent_id = parent.id \
               WHERE ancestors.depth < 10000\
             ) \
             SELECT id FROM ancestors \
             WHERE parent_id IS NULL AND deleted_at IS NULL \
             ORDER BY depth DESC LIMIT 1",
            [node_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not resolve a deleted node's former Notes topic: {error}"))
}

/// Whether an export target's topic is currently quarantined. Lets the runtime
/// surface an immediate (A2.4 pre-render cap) quarantine right away instead of
/// waiting for the three-strike failure counter that never trips once the target
/// is excluded from the pending set (R2).
pub(crate) fn export_target_quarantined(
    connection: &Connection,
    target: &ExportTarget,
) -> Result<bool, String> {
    let topic_id = match target {
        ExportTarget::Topic(id) | ExportTarget::RemoveTopic(id) => id.as_str(),
        ExportTarget::Trash => TRASH_TOPIC_ID,
    };
    metadata_quarantined(connection, topic_id)
}

fn metadata_quarantined(connection: &Connection, topic_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT quarantined <> 0 FROM sync_topics WHERE topic_id = ?1",
            [topic_id],
            |row| row.get(0),
        )
        .optional()
        .map(|value| value.unwrap_or(false))
        .map_err(|error| format!("Could not inspect Notes quarantine state: {error}"))
}

fn topic_is_live_root(connection: &Connection, topic_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes \
             WHERE id = ?1 AND parent_id IS NULL AND deleted_at IS NULL)",
            [topic_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect a rerooted Notes topic: {error}"))
}

fn resolve_topic_id(connection: &Connection, node_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "WITH RECURSIVE ancestors(id, parent_id, depth) AS (\
               SELECT id, parent_id, 0 FROM notes_nodes WHERE id = ?1 \
               UNION ALL \
               SELECT parent.id, parent.parent_id, ancestors.depth + 1 \
               FROM notes_nodes parent JOIN ancestors ON ancestors.parent_id = parent.id \
               WHERE ancestors.depth < 10000\
             ) \
             SELECT id FROM ancestors WHERE parent_id IS NULL \
             ORDER BY depth DESC LIMIT 1",
            [node_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not resolve a dirty Notes topic: {error}"))
}

pub(crate) fn capture_export_snapshot(
    connection: &mut Connection,
    pending: &PendingExport,
) -> Result<ExportSnapshot, String> {
    let (file_name, document) = match &pending.target {
        ExportTarget::Topic(topic_id) => {
            let nodes = load_topic_nodes(connection, topic_id)?;
            let root = nodes
                .get(topic_id)
                .ok_or_else(|| format!("Notes topic root {topic_id} does not exist."))?;
            let file_name = assigned_topic_filename(connection, topic_id, &root.title)?;
            let document = TopicFile::Topic(build_topic_doc(connection, topic_id, nodes)?);
            (file_name, document)
        }
        ExportTarget::Trash => {
            ensure_trash_metadata(connection)?;
            (
                TRASH_FILE_NAME.to_string(),
                TopicFile::Trash(build_trash_doc(connection)?),
            )
        }
        ExportTarget::RemoveTopic(topic_id) => {
            return Err(format!(
                "Notes topic {topic_id} is pending removal, not file rendering."
            ))
        }
    };
    // A pre-render cap check keeps an over-large subtree from rendering bytes its
    // own parser would reject: instead of failing self-validation on every tick
    // forever (a silent wedge), quarantine the target once so the existing
    // sync-status path surfaces it and the retry loop stops (common rule 11).
    if let Some(reason) = topic_file_cap_violation(&document) {
        // Rule 11: route through Track B's shared quarantine helper so the
        // pre-render cap wedge and the repeated-failure wedge stay unified.
        quarantine_export_target(connection, &pending.target, &reason)?;
        return Err(format!(
            "Notes export {file_name} exceeds the export cap ({reason}); quarantined pending repair."
        ));
    }
    Ok(ExportSnapshot {
        target: pending.target.clone(),
        file_name,
        document,
        dirty: pending.dirty.clone(),
    })
}

/// Mirrors the topic parser's node-count and nesting-depth caps so the exporter
/// can detect, before rendering, a document its own self-validation would reject.
fn topic_file_cap_violation(document: &TopicFile) -> Option<String> {
    let nodes = match document {
        TopicFile::Topic(document) => &document.nodes,
        TopicFile::Trash(document) => &document.nodes,
    };
    let mut count = 0_usize;
    let mut max_depth = 0_usize;
    let mut stack = nodes.iter().map(|node| (node, 0_usize)).collect::<Vec<_>>();
    while let Some((node, depth)) = stack.pop() {
        count += 1;
        max_depth = max_depth.max(depth);
        for child in &node.children {
            stack.push((child, depth + 1));
        }
    }
    if count > MAX_NOTES_EXPORT_NODES {
        return Some(format!("more than {MAX_NOTES_EXPORT_NODES} nodes"));
    }
    // The parser rejects a bullet whose zero-based depth + 1 exceeds the cap.
    if max_depth >= MAX_NOTES_EXPORT_DEPTH {
        return Some(format!(
            "nesting deeper than {MAX_NOTES_EXPORT_DEPTH} levels"
        ));
    }
    None
}

/// Reconstructs the current canonical bytes for a previously assigned sync
/// file without changing dirty markers or sync metadata. Bootstrap uses this
/// only to prove that a malformed on-disk prefix is exactly a torn write of
/// the last verified export before it restores that file atomically.
pub(crate) fn render_canonical_sync_bytes(
    connection: &Connection,
    topic_id: &str,
) -> Result<Vec<u8>, String> {
    let document = if topic_id == TRASH_TOPIC_ID {
        TopicFile::Trash(build_trash_doc(connection)?)
    } else {
        TopicFile::Topic(build_topic_doc(
            connection,
            topic_id,
            load_topic_nodes(connection, topic_id)?,
        )?)
    };
    render_topic_file(&document)
}

pub(crate) fn load_all_exports(
    connection: &Connection,
    include_trash: bool,
) -> Result<Vec<PendingExport>, String> {
    let mut pending = load_pending_exports(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT id FROM notes_nodes \
             WHERE parent_id IS NULL AND deleted_at IS NULL \
             ORDER BY sort_key, id",
        )
        .map_err(|error| format!("Could not prepare initial Notes topics: {error}"))?;
    let topic_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not load initial Notes topics: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read initial Notes topics: {error}"))?;
    drop(statement);
    let mut exports = Vec::with_capacity(topic_ids.len() + 1);
    for topic_id in topic_ids {
        if metadata_quarantined(connection, &topic_id)? {
            continue;
        }
        let target = ExportTarget::Topic(topic_id);
        let fallback = PendingExport {
            target: target.clone(),
            dirty: Vec::new(),
            fingerprint: String::new(),
        };
        exports.push(pending.remove(&target).unwrap_or(fallback));
    }
    let has_trash: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE deleted_at IS NOT NULL) \
             OR EXISTS(SELECT 1 FROM sync_purged_tombstones)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect initial Notes trash: {error}"))?;
    if include_trash
        && (has_trash || pending.contains_key(&ExportTarget::Trash))
        && !metadata_quarantined(connection, TRASH_TOPIC_ID)?
    {
        let fallback = PendingExport {
            target: ExportTarget::Trash,
            dirty: Vec::new(),
            fingerprint: String::new(),
        };
        exports.push(pending.remove(&ExportTarget::Trash).unwrap_or(fallback));
    }
    Ok(exports)
}

pub(crate) fn publish_pending_exports<'a>(
    connection: &mut Connection,
    vault_path: &Path,
    pending: impl IntoIterator<Item = &'a PendingExport>,
) -> ExportBatchOutcome {
    publish_pending_exports_with_writer(connection, vault_path, pending, ExportWriter::Ambient)
}

pub(crate) fn publish_pending_exports_in_guarded_vault<'a>(
    connection: &mut Connection,
    vault_path: &Path,
    pending: impl IntoIterator<Item = &'a PendingExport>,
    vault: &Dir,
    revalidate: &mut dyn FnMut() -> Result<(), String>,
) -> ExportBatchOutcome {
    publish_pending_exports_with_writer(
        connection,
        vault_path,
        pending,
        ExportWriter::Guarded { vault, revalidate },
    )
}

pub(crate) enum ExportWriter<'a> {
    Ambient,
    Guarded {
        vault: &'a Dir,
        revalidate: &'a mut dyn FnMut() -> Result<(), String>,
    },
}

fn publish_pending_exports_with_writer<'a>(
    connection: &mut Connection,
    vault_path: &Path,
    pending: impl IntoIterator<Item = &'a PendingExport>,
    mut writer: ExportWriter<'_>,
) -> ExportBatchOutcome {
    let mut outcome = ExportBatchOutcome::default();
    for pending in pending {
        let result = match &pending.target {
            ExportTarget::RemoveTopic(_) => match &mut writer {
                ExportWriter::Ambient => publish_topic_removal(connection, vault_path, pending),
                ExportWriter::Guarded { vault, revalidate } => {
                    publish_topic_removal_in_guarded_vault(
                        connection,
                        vault_path,
                        pending,
                        vault,
                        *revalidate,
                    )
                }
            }
            .map(drop),
            ExportTarget::Topic(_) | ExportTarget::Trash => {
                // A2.5: peel trash overflow into write-once segments before the
                // trash snapshot is captured so trash.md stays under the cap.
                let archived = if matches!(pending.target, ExportTarget::Trash) {
                    archive_trash_overflow(connection, vault_path, &mut writer).map(drop)
                } else {
                    Ok(())
                };
                archived
                    .and_then(|()| capture_export_snapshot(connection, pending))
                    .and_then(|snapshot| {
                        if github_exported_hash(connection, &snapshot)?
                            .is_some_and(|exported_hash| exported_hash.is_empty())
                        {
                            return match &mut writer {
                                ExportWriter::Ambient => publish_github_first_snapshot_ambient(
                                    connection, vault_path, &snapshot,
                                ),
                                ExportWriter::Guarded { vault, revalidate } => {
                                    publish_github_first_snapshot_in_guarded_vault(
                                        connection,
                                        &snapshot,
                                        vault,
                                        *revalidate,
                                    )
                                }
                            }
                            .map(drop);
                        }
                        if let Some(exported_hash) = github_exported_hash(connection, &snapshot)? {
                            return match &mut writer {
                                ExportWriter::Ambient => publish_github_snapshot_ambient(
                                    connection,
                                    vault_path,
                                    &snapshot,
                                    &exported_hash,
                                ),
                                ExportWriter::Guarded { vault, revalidate } => {
                                    publish_github_snapshot_in_guarded_vault(
                                        connection,
                                        &snapshot,
                                        vault,
                                        &exported_hash,
                                        *revalidate,
                                    )
                                }
                            }
                            .map(drop);
                        }
                        match &mut writer {
                            ExportWriter::Ambient => {
                                publish_export_snapshot(connection, vault_path, &snapshot)
                            }
                            ExportWriter::Guarded { vault, revalidate } => {
                                publish_export_snapshot_in_guarded_vault(
                                    connection,
                                    vault_path,
                                    &snapshot,
                                    vault,
                                    *revalidate,
                                )
                            }
                        }
                        .map(drop)
                    })
            }
        };
        match result {
            Ok(()) => {
                outcome.exported += 1;
                outcome.succeeded.push(pending.target.clone());
            }
            Err(error) => {
                let retry_error = if pending.dirty.is_empty() {
                    retain_failed_export_for_retry(connection, &pending.target).err()
                } else {
                    None
                };
                let combined = match retry_error {
                    Some(retry_error) => format!("{:?}: {error}; {retry_error}", pending.target),
                    None => format!("{:?}: {error}", pending.target),
                };
                outcome
                    .failed
                    .push((pending.target.clone(), combined.clone()));
                outcome.errors.push(combined);
            }
        }
    }
    outcome
}

/// B4: the runtime export tick. Unlike [`publish_pending_exports`] (kept for
/// bootstrap and tests, which run before the worker threads exist), this holds
/// the per-vault connection lock only to capture+render snapshots and to record
/// results — the atomic file writes happen with the lock released, so a slow
/// cloud write never freezes UI reloads or other Notes commands. Per-target
/// failures are collected in the outcome (rule 11 counts them); only a failure
/// to lock the connection at all returns `Err`.
pub(crate) fn publish_pending_exports_unlocked(
    shared: &SharedNotesConnection,
    vault_path: &Path,
    pending: Vec<PendingExport>,
) -> Result<ExportBatchOutcome, String> {
    let mut outcome = ExportBatchOutcome::default();
    let mut prepared: Vec<(ExportSnapshot, Vec<u8>)> = Vec::new();
    let mut first_github_publications: Vec<(ExportSnapshot, Vec<u8>)> = Vec::new();
    let mut subsequent_github_publications: Vec<(ExportSnapshot, Vec<u8>, String)> = Vec::new();
    let mut removals: Vec<PendingExport> = Vec::new();
    {
        let mut connection = lock_notes_connection(shared)?;
        // A2.5: peel any trash overflow into write-once segments before the
        // trash snapshot is captured so trash.md stays under the node cap.
        if pending
            .iter()
            .any(|pending| matches!(pending.target, ExportTarget::Trash))
        {
            // The unlocked runtime tick does its own ambient writes after the
            // lock is released; the cold archive path writes inline (ambient).
            if let Err(error) =
                archive_trash_overflow(&connection, vault_path, &mut ExportWriter::Ambient)
            {
                record_target_failure(&connection, &mut outcome, &ExportTarget::Trash, &[], error);
            }
        }
        for pending in pending {
            match &pending.target {
                ExportTarget::RemoveTopic(_) => removals.push(pending),
                ExportTarget::Topic(_) | ExportTarget::Trash => {
                    match capture_export_snapshot(&mut connection, &pending).and_then(|snapshot| {
                        render_snapshot_bytes(&snapshot).map(|b| (snapshot, b))
                    }) {
                        Ok((snapshot, bytes)) => {
                            match github_exported_hash(&connection, &snapshot)? {
                                Some(exported_hash) if exported_hash.is_empty() => {
                                    first_github_publications.push((snapshot, bytes));
                                }
                                Some(exported_hash) => {
                                    subsequent_github_publications.push((
                                        snapshot,
                                        bytes,
                                        exported_hash,
                                    ));
                                }
                                None => prepared.push((snapshot, bytes)),
                            }
                        }
                        Err(error) => record_target_failure(
                            &connection,
                            &mut outcome,
                            &pending.target,
                            &pending.dirty,
                            error,
                        ),
                    }
                }
            }
        }
    }
    // Lock released: the potentially slow atomic writes run unlocked.
    let mut written: Vec<(ExportSnapshot, Vec<u8>)> = Vec::new();
    let mut held_github_publications: Vec<(ExportSnapshot, Vec<u8>, HeldGithubFirstPublication)> =
        Vec::new();
    let mut write_failures: Vec<(ExportSnapshot, String)> = Vec::new();
    for (snapshot, bytes) in first_github_publications {
        match publish_github_first_snapshot_unlocked(vault_path, &snapshot, &bytes) {
            Ok(held) => held_github_publications.push((snapshot, bytes, held)),
            Err(error) => write_failures.push((snapshot, error)),
        }
    }
    for (snapshot, bytes, exported_hash) in subsequent_github_publications {
        match publish_github_snapshot_unlocked(vault_path, &snapshot, &bytes, &exported_hash) {
            Ok(held) => held_github_publications.push((snapshot, bytes, held)),
            Err(error) => write_failures.push((snapshot, error)),
        }
    }
    for (snapshot, bytes) in prepared {
        match crate::file_io::write_atomic_file(&vault_path.join(&snapshot.file_name), &bytes, true)
        {
            Ok(()) => written.push((snapshot, bytes)),
            Err(error) => write_failures.push((snapshot, error)),
        }
    }
    // Test seam: a merge entering here proves the connection lock is free during
    // the write window (a same-thread relock would otherwise deadlock).
    maybe_inject_after_unlocked_write();
    {
        let mut connection = lock_notes_connection(shared)?;
        for (snapshot, bytes, held) in held_github_publications {
            match record_published_snapshot_with_revalidation(
                &mut connection,
                &snapshot,
                &bytes,
                || held.revalidate(&bytes),
            ) {
                Ok(_) => {
                    outcome.exported += 1;
                    outcome.succeeded.push(snapshot.target.clone());
                }
                Err(error) => record_target_failure(
                    &connection,
                    &mut outcome,
                    &snapshot.target,
                    &snapshot.dirty,
                    error,
                ),
            }
        }
        for (snapshot, bytes) in written {
            match record_published_snapshot(&mut connection, &snapshot, &bytes) {
                Ok(_) => {
                    outcome.exported += 1;
                    outcome.succeeded.push(snapshot.target.clone());
                }
                Err(error) => record_target_failure(
                    &connection,
                    &mut outcome,
                    &snapshot.target,
                    &snapshot.dirty,
                    error,
                ),
            }
        }
        for (snapshot, error) in write_failures {
            record_target_failure(
                &connection,
                &mut outcome,
                &snapshot.target,
                &snapshot.dirty,
                error,
            );
        }
        for removal in &removals {
            match publish_topic_removal(&mut connection, vault_path, removal) {
                Ok(_) => {
                    outcome.exported += 1;
                    outcome.succeeded.push(removal.target.clone());
                }
                Err(error) => record_target_failure(
                    &connection,
                    &mut outcome,
                    &removal.target,
                    &removal.dirty,
                    error,
                ),
            }
        }
    }
    Ok(outcome)
}

fn github_exported_hash(
    connection: &Connection,
    snapshot: &ExportSnapshot,
) -> Result<Option<String>, String> {
    if snapshot.target != ExportTarget::Topic(GITHUB_NOTIFICATIONS_ROOT_ID.to_string())
        || snapshot.file_name != GITHUB_NOTIFICATIONS_FILENAME
    {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT exported_hash, quarantined FROM sync_topics WHERE topic_id = ?1",
            [GITHUB_NOTIFICATIONS_ROOT_ID],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .map_err(|error| format!("Could not inspect GitHub publication: {error}"))
        .and_then(|(exported_hash, quarantined)| {
            (!quarantined)
                .then_some(Some(exported_hash))
                .ok_or_else(|| "The GitHub Notifications topic is quarantined.".to_string())
        })
}

fn record_target_failure(
    connection: &Connection,
    outcome: &mut ExportBatchOutcome,
    target: &ExportTarget,
    dirty: &[DirtyMarker],
    error: String,
) {
    let retry_error = if dirty.is_empty() {
        retain_failed_export_for_retry(connection, target).err()
    } else {
        None
    };
    let combined = match retry_error {
        Some(retry_error) => format!("{target:?}: {error}; {retry_error}"),
        None => format!("{target:?}: {error}"),
    };
    outcome.failed.push((target.clone(), combined.clone()));
    outcome.errors.push(combined);
}

/// Rule 11 helper (shared contract with Track A's pre-render cap check):
/// mark a wedged export target quarantined so its dirty rows stop being retried
/// silently. Ensures a metadata row exists first so a target that never got a
/// filename is still recorded. Un-quarantine (a later successful merge of the
/// on-disk file, or an operator action) resumes it because the dirty rows are
/// left in place.
pub(crate) fn quarantine_export_target(
    connection: &Connection,
    target: &ExportTarget,
    reason: &str,
) -> Result<(), String> {
    let topic_id = match target {
        ExportTarget::Topic(id) | ExportTarget::RemoveTopic(id) => id.clone(),
        ExportTarget::Trash => {
            ensure_trash_metadata(connection)?;
            TRASH_TOPIC_ID.to_string()
        }
    };
    let updated = connection
        .execute(
            "UPDATE sync_topics SET quarantined = 1 WHERE topic_id = ?1",
            [&topic_id],
        )
        .map_err(|error| format!("Could not quarantine a wedged Notes export target: {error}"))?;
    if updated == 0 {
        if let ExportTarget::Topic(_) = target {
            let title: String = connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [&topic_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("Could not read a wedged Notes topic title: {error}"))?
                .unwrap_or_default();
            let file_name = derive_topic_filename(&title, &topic_id)?;
            connection
                .execute(
                    "INSERT INTO sync_topics(topic_id, file_name, quarantined) VALUES (?1, ?2, 1) \
                     ON CONFLICT(topic_id) DO UPDATE SET quarantined = 1",
                    params![topic_id, file_name],
                )
                .map_err(|error| {
                    format!("Could not record a wedged Notes topic quarantine: {error}")
                })?;
        }
    }
    eprintln!("Notes export target {topic_id} quarantined after repeated failures: {reason}");
    Ok(())
}

fn retain_failed_export_for_retry(
    connection: &Connection,
    target: &ExportTarget,
) -> Result<(), String> {
    let marker = match target {
        ExportTarget::Topic(topic_id) => topic_id.clone(),
        ExportTarget::Trash => TRASH_TOPIC_ID.to_string(),
        ExportTarget::RemoveTopic(topic_id) => format!("{SYNC_REMOVE_TOPIC_PREFIX}{topic_id}"),
    };
    connection
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
             ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
            [marker],
        )
        .map_err(|error| format!("Could not retain failed Notes export for retry: {error}"))?;
    Ok(())
}

fn publish_topic_removal(
    connection: &mut Connection,
    vault_path: &Path,
    pending: &PendingExport,
) -> Result<bool, String> {
    publish_topic_removal_with(connection, vault_path, pending, &|path| {
        let removed = crate::file_io::remove_file_durable(path)?;
        maybe_inject_after_topic_removal_publication();
        Ok(removed)
    })
}

type DurableRemover<'a> = dyn Fn(&Path) -> Result<bool, String> + 'a;

fn publish_topic_removal_with(
    connection: &mut Connection,
    vault_path: &Path,
    pending: &PendingExport,
    remove: &DurableRemover<'_>,
) -> Result<bool, String> {
    let read =
        |file_name: &Path| fs::read(vault_path.join(file_name)).map_err(|error| error.to_string());
    let prepared = prepare_topic_removal(connection, pending, &read)?;
    let Some(source) = prepared.source else {
        record_absent_topic_removal(connection, pending, &prepared.topic_id)?;
        return Ok(false);
    };
    let source_path = vault_path.join(&source.file_name);
    match fs::read(&source_path) {
        Ok(bytes)
            if source.exported_hash.is_empty() || sha256_hex(&bytes) != source.exported_hash =>
        {
            return Err(format!(
                "Removed Notes topic source {} changed since its last export.",
                source.file_name
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not verify removed Notes topic source {}: {error}",
                source.file_name
            ));
        }
    }
    let removed = remove(&source_path)?;
    record_topic_removal(connection, pending, &prepared.topic_id)?;
    Ok(removed)
}

struct PreparedTopicRemoval {
    topic_id: String,
    source: Option<PreparedTopicRemovalSource>,
}

struct PreparedTopicRemovalSource {
    file_name: String,
    exported_hash: String,
}

type TopicFileReader<'a> = dyn Fn(&Path) -> Result<Vec<u8>, String> + 'a;

fn prepare_topic_removal(
    connection: &mut Connection,
    pending: &PendingExport,
    read: &TopicFileReader<'_>,
) -> Result<PreparedTopicRemoval, String> {
    let ExportTarget::RemoveTopic(topic_id) = &pending.target else {
        return Err("A Notes topic-removal export requires a removal target.".to_string());
    };
    let lifecycle = connection
        .query_row(
            "SELECT deleted_at FROM notes_nodes WHERE id = ?1",
            [topic_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect a removed Notes topic root: {error}"))?;
    match lifecycle {
        Some(Some(_)) => {
            ensure_export_is_current_with_reader(connection, &ExportTarget::Trash, read)?
        }
        Some(None) => {
            let current_topic = resolve_topic_id(connection, topic_id)?;
            if current_topic == *topic_id {
                return Err(format!(
                    "Notes topic {topic_id} is still a live root and cannot be removed."
                ));
            }
            ensure_export_is_current_with_reader(
                connection,
                &ExportTarget::Topic(current_topic),
                read,
            )?;
        }
        None => {
            let has_purge_evidence: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sync_purged_tombstones WHERE node_id = ?1)",
                    [topic_id],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    format!("Could not inspect removed Notes topic purge evidence: {error}")
                })?;
            if !has_purge_evidence {
                return Err(format!(
                    "Removed Notes topic {topic_id} has no durable purge evidence."
                ));
            }
            ensure_export_is_current_with_reader(connection, &ExportTarget::Trash, read)?;
        }
    }

    let metadata: Option<(String, String, bool)> = connection
        .query_row(
            "SELECT file_name, exported_hash, quarantined FROM sync_topics WHERE topic_id = ?1",
            [topic_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("Could not load removed Notes topic metadata: {error}"))?;
    let Some((file_name, exported_hash, quarantined)) = metadata else {
        return Ok(PreparedTopicRemoval {
            topic_id: topic_id.clone(),
            source: None,
        });
    };
    if quarantined {
        return Err(format!(
            "Removed Notes topic source {file_name} is quarantined."
        ));
    }
    Ok(PreparedTopicRemoval {
        topic_id: topic_id.clone(),
        source: Some(PreparedTopicRemovalSource {
            file_name,
            exported_hash,
        }),
    })
}

fn record_absent_topic_removal(
    connection: &mut Connection,
    pending: &PendingExport,
    topic_id: &str,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            format!("Could not start recording an absent Notes topic removal: {error}")
        })?;
    if crate::notes::sync::topic_metadata_exists(&transaction, topic_id)
        .map_err(|error| format!("Could not recheck absent Notes topic metadata: {error}"))?
    {
        return Err(format!(
            "Removed Notes topic {topic_id} gained file metadata while its removal was prepared."
        ));
    }
    clear_dirty_markers(&transaction, &pending.dirty)?;
    transaction.commit().map_err(|error| {
        format!("Could not finish recording an absent Notes topic removal: {error}")
    })?;
    Ok(())
}

fn record_topic_removal(
    connection: &mut Connection,
    pending: &PendingExport,
    topic_id: &str,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start recording a Notes topic removal: {error}"))?;
    transaction
        .execute(
            "UPDATE sync_topics SET exported_hash = '' WHERE topic_id = ?1",
            [topic_id],
        )
        .map_err(|error| format!("Could not record a removed Notes topic file: {error}"))?;
    clear_dirty_markers(&transaction, &pending.dirty)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not finish recording a Notes topic removal: {error}"))?;
    Ok(())
}

fn ensure_export_is_current_with_reader(
    connection: &mut Connection,
    target: &ExportTarget,
    read: &TopicFileReader<'_>,
) -> Result<(), String> {
    if matches!(target, ExportTarget::RemoveTopic(_)) {
        return Err("A Notes topic removal cannot depend on another removal.".to_string());
    }
    let pending = PendingExport {
        target: target.clone(),
        dirty: Vec::new(),
        fingerprint: String::new(),
    };
    let snapshot = capture_export_snapshot(connection, &pending)?;
    let expected = render_topic_file(&snapshot.document)?;
    let parsed = match parse_topic_file(&expected) {
        TopicParseOutcome::Parsed(document) => document,
        TopicParseOutcome::Quarantined(_) => {
            return Err("Rendered Notes dependency bytes failed self-validation.".to_string())
        }
    };
    if canonicalize_topic_file_semantics(&parsed)
        != canonicalize_topic_file_semantics(&snapshot.document)
    {
        return Err("Rendered Notes dependency bytes changed semantic state.".to_string());
    }
    let expected_hash = sha256_hex(&expected);
    let metadata_topic_id = match target {
        ExportTarget::Topic(topic_id) => topic_id.as_str(),
        ExportTarget::Trash => TRASH_TOPIC_ID,
        ExportTarget::RemoveTopic(_) => unreachable!(),
    };
    let (exported_hash, quarantined): (String, bool) = connection
        .query_row(
            "SELECT exported_hash, quarantined FROM sync_topics WHERE topic_id = ?1",
            [metadata_topic_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Could not inspect a Notes removal dependency: {error}"))?;
    if quarantined || exported_hash != expected_hash {
        return Err(format!(
            "Notes removal dependency {} is not durably exported.",
            snapshot.file_name
        ));
    }
    let actual = read(Path::new(&snapshot.file_name)).map_err(|error| {
        format!(
            "Could not verify Notes removal dependency {}: {error}",
            snapshot.file_name
        )
    })?;
    if actual != expected {
        return Err(format!(
            "Notes removal dependency {} does not match SQLite state.",
            snapshot.file_name
        ));
    }
    Ok(())
}

fn read_topic_file_in_guarded_vault(
    vault: &Dir,
    file_name: &Path,
) -> Result<Option<(Vec<u8>, crate::file_io::HeldBoundedCapabilityFile)>, String> {
    if file_name.components().count() != 1 {
        return Err("A Notes sync filename must name one vault-root file.".to_string());
    }
    let held = match crate::file_io::hold_capability_regular_file_bounded_nofollow(
        vault,
        file_name,
        MAX_MARKDOWN_BYTES as u64,
    ) {
        Ok(held) => held,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::with_capacity(usize::try_from(held.byte_size()).unwrap_or(0));
    held.reader_from_start()
        .and_then(|mut reader| reader.read_to_end(&mut bytes))
        .map_err(|error| error.to_string())?;
    held.verify_at(vault, file_name)
        .map_err(|error| error.to_string())?;
    Ok(Some((bytes, held)))
}

fn publish_topic_removal_in_guarded_vault(
    connection: &mut Connection,
    _vault_path: &Path,
    pending: &PendingExport,
    vault: &Dir,
    revalidate: &mut dyn FnMut() -> Result<(), String>,
) -> Result<bool, String> {
    let read = |file_name: &Path| {
        read_topic_file_in_guarded_vault(vault, file_name)?
            .map(|(bytes, _)| bytes)
            .ok_or_else(|| "held Notes sync file does not exist".to_string())
    };
    let prepared = prepare_topic_removal(connection, pending, &read)?;
    let Some(metadata) = prepared.source else {
        record_absent_topic_removal(connection, pending, &prepared.topic_id)?;
        return Ok(false);
    };
    let file_name = Path::new(&metadata.file_name);
    let source_file = read_topic_file_in_guarded_vault(vault, file_name)?;
    if source_file.as_ref().is_some_and(|(bytes, _)| {
        metadata.exported_hash.is_empty() || sha256_hex(bytes) != metadata.exported_hash
    }) {
        return Err(format!(
            "Removed Notes topic source {} changed since its last export.",
            metadata.file_name
        ));
    }
    let held = source_file.map(|(_, held)| held);
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start recording a Notes topic removal: {error}"))?;
    transaction
        .execute(
            "UPDATE sync_topics SET exported_hash = '' WHERE topic_id = ?1",
            [&prepared.topic_id],
        )
        .map_err(|error| format!("Could not record a removed Notes topic file: {error}"))?;
    clear_dirty_markers(&transaction, &pending.dirty)?;
    crate::file_io::remove_file_durable_in_guarded_parent(
        vault,
        file_name,
        held,
        &mut *revalidate,
        maybe_inject_after_topic_removal_publication,
        || {
            transaction.commit().map_err(|error| {
                format!("Could not finish recording a Notes topic removal: {error}")
            })
        },
    )
}

fn assigned_topic_filename(
    connection: &Connection,
    topic_id: &str,
    title: &str,
) -> Result<String, String> {
    if let Some(file_name) = connection
        .query_row(
            "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
            [topic_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not load a Notes topic filename: {error}"))?
    {
        return Ok(file_name);
    }
    let file_name = derive_topic_filename(title, topic_id)?;
    connection
        .execute(
            "INSERT INTO sync_topics(topic_id, file_name) VALUES (?1, ?2)",
            params![topic_id, file_name],
        )
        .map_err(|error| format!("Could not assign a Notes topic filename: {error}"))?;
    Ok(file_name)
}

pub(crate) fn ensure_trash_metadata(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO sync_topics(topic_id, file_name) VALUES (?1, ?2) \
             ON CONFLICT(topic_id) DO NOTHING",
            params![TRASH_TOPIC_ID, TRASH_FILE_NAME],
        )
        .map_err(|error| format!("Could not assign the Notes trash filename: {error}"))?;
    let file_name: String = connection
        .query_row(
            "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
            [TRASH_TOPIC_ID],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not load the Notes trash filename: {error}"))?;
    if file_name != TRASH_FILE_NAME {
        return Err("The reserved Notes trash metadata row is invalid.".to_string());
    }
    Ok(())
}

fn load_topic_nodes(
    connection: &Connection,
    topic_id: &str,
) -> Result<BTreeMap<String, StoredNode>, String> {
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE subtree(id, depth) AS (\
               SELECT id, 0 FROM notes_nodes \
               WHERE id = ?1 AND parent_id IS NULL AND deleted_at IS NULL \
               UNION ALL \
               SELECT child.id, subtree.depth + 1 FROM notes_nodes child \
               JOIN subtree ON child.parent_id = subtree.id \
               WHERE child.deleted_at IS NULL AND subtree.depth < 10000\
             ) \
             SELECT node.id, node.parent_id, node.sort_key, node.title, node.note, \
                    node.image_offset_utf16, node.node_kind, node.marker_kind, node.is_starred, \
                    node.completed_at, node.archived_at, node.deleted_batch_id, node.hlc, \
                    node.markdown_image_width, \
                    node.is_collapsed, node.is_readonly, node.plugin_state, node.plugin_meta \
             FROM notes_nodes node JOIN subtree ON subtree.id = node.id \
             ORDER BY node.id",
        )
        .map_err(|error| format!("Could not prepare a v3 Notes topic export: {error}"))?;
    let rows = statement
        .query_map([topic_id], stored_node_from_row)
        .map_err(|error| format!("Could not load a v3 Notes topic export: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read a v3 Notes topic export: {error}"))?;
    if rows.is_empty() {
        return Err(format!("Notes topic root {topic_id} does not exist."));
    }
    Ok(rows
        .into_iter()
        .map(|node| (node.id.clone(), node))
        .collect())
}

fn load_trash_nodes(connection: &Connection) -> Result<BTreeMap<String, StoredNode>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, parent_id, sort_key, title, note, image_offset_utf16, node_kind, marker_kind, \
                    is_starred, completed_at, archived_at, deleted_batch_id, hlc, \
                    markdown_image_width, \
                    is_collapsed, is_readonly, plugin_state, plugin_meta \
             FROM notes_nodes WHERE deleted_at IS NOT NULL \
               AND id NOT IN (SELECT node_id FROM sync_trash_archive) \
             ORDER BY id",
        )
        .map_err(|error| format!("Could not prepare a v3 Notes trash export: {error}"))?;
    let rows = statement
        .query_map([], stored_node_from_row)
        .map_err(|error| format!("Could not load a v3 Notes trash export: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read a v3 Notes trash export: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|node| (node.id.clone(), node))
        .collect())
}

fn stored_node_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredNode> {
    let id = row.get::<_, String>(0)?;
    let raw_readonly = row.get::<_, Option<i64>>(15)?;
    let is_readonly = match raw_readonly {
        None => None,
        Some(0) => Some(false),
        Some(1) => Some(true),
        Some(value) => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                15,
                rusqlite::types::Type::Integer,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Unsupported Notes readonly value: {value}"),
                )),
            ))
        }
    };
    let plugin_state = row
        .get::<_, Option<String>>(16)?
        .map(|value| {
            serde_json::from_str::<Vec<String>>(&value)
                .map(|collapsed_groups| GithubNotificationsPluginState { collapsed_groups })
                .and_then(|state| {
                    state.is_valid().then_some(state).ok_or_else(|| {
                        serde_json::Error::io(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "plugin groups must be sorted unique calendar dates",
                        ))
                    })
                })
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        16,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!("Invalid Notes plugin state: {error}"),
                        )),
                    )
                })
        })
        .transpose()?;
    let plugin_meta = row
        .get::<_, Option<String>>(17)?
        .map(|value| {
            parse_github_plugin_meta_storage(&value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    17,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("Invalid Notes plugin metadata: {error}"),
                    )),
                )
            })
        })
        .transpose()?;
    let plugin_owned = id == GITHUB_NOTIFICATIONS_ROOT_ID || plugin_meta.is_some();
    if (plugin_owned && is_readonly.is_some())
        || (!plugin_owned
            && (plugin_state.is_some() || plugin_meta.is_some() || is_readonly.is_none()))
        || (id == GITHUB_NOTIFICATIONS_ROOT_ID) != plugin_state.is_some()
        || (plugin_state.is_some() && plugin_meta.is_some())
        || plugin_state.as_ref().is_some_and(|state| !state.is_valid())
        || plugin_meta.as_ref().is_some_and(|meta| !meta.is_valid())
    {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            15,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid Notes plugin storage contract",
            )),
        ));
    }
    Ok(StoredNode {
        id,
        parent_id: row.get(1)?,
        sort_key: row.get(2)?,
        title: row.get(3)?,
        note: row.get(4)?,
        image_offset_utf16: row.get(5)?,
        node_kind: row.get(6)?,
        marker_kind: match row.get::<_, String>(7)?.as_str() {
            "bullet" => NoteMarkerKind::Bullet,
            "todo" => NoteMarkerKind::Todo,
            value => {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    7,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("Unsupported Notes marker kind: {value}"),
                    )),
                ))
            }
        },
        starred: row.get::<_, i64>(8)? != 0,
        completed_at: row.get(9)?,
        archived_at: row.get(10)?,
        deleted_batch_id: row.get(11)?,
        hlc: row.get(12)?,
        markdown_image_width: row.get(13)?,
        is_collapsed: row.get::<_, i64>(14)? != 0,
        is_readonly,
        plugin_state,
        plugin_meta,
    })
}

fn build_topic_doc(
    connection: &Connection,
    topic_id: &str,
    mut nodes: BTreeMap<String, StoredNode>,
) -> Result<TopicDoc, String> {
    let root = nodes
        .remove(topic_id)
        .ok_or_else(|| format!("Notes topic root {topic_id} does not exist."))?;
    let max_hlc = nodes
        .values()
        .map(|node| node.hlc.as_str())
        .chain(std::iter::once(root.hlc.as_str()))
        .max()
        .unwrap_or_default()
        .to_string();
    let children = child_ids(&nodes, Some(topic_id));
    let mut built = Vec::with_capacity(children.len());
    for (index, child_id) in children.iter().enumerate() {
        built.push(build_topic_node(
            connection,
            child_id,
            &nodes,
            index + 1,
            false,
            None,
        )?);
    }
    let is_github_root = topic_id == GITHUB_NOTIFICATIONS_ROOT_ID;
    let (plugin, plugin_children, collapsed_groups, root_readonly) = if is_github_root {
        let state = root
            .plugin_state
            .as_ref()
            .ok_or_else(|| "Github Notifications root is missing plugin state.".to_string())?;
        (
            Some(GITHUB_NOTIFICATIONS_PLUGIN_ID.to_string()),
            Some("hybrid".to_string()),
            state.collapsed_groups.clone(),
            None,
        )
    } else {
        if root.plugin_state.is_some() || root.plugin_meta.is_some() {
            return Err("An ordinary Notes root cannot own plugin storage.".to_string());
        }
        (
            None,
            None,
            Vec::new(),
            Some(root.is_readonly.unwrap_or(false)),
        )
    };
    Ok(TopicDoc {
        id: root.id,
        sort_key: root.sort_key,
        max_hlc,
        root: TopicRoot {
            marker_kind: root.marker_kind,
            format_version: TOPIC_FORMAT_VERSION,
            title: normalize_newlines(&root.title),
            note: normalize_newlines(&root.note),
            markdown_image_width: root.markdown_image_width,
            hlc: root.hlc,
            starred: root.starred,
            completed_at: root.completed_at,
            archived_at: root.archived_at,
            root_collapsed: root.is_collapsed,
            root_readonly,
            plugin,
            plugin_children,
            collapsed_groups,
        },
        nodes: built,
    })
}

/// A trash node is a rendered root when its parent is not itself a trash node in
/// the same deleted batch (an orphaned or cross-batch child renders standalone).
fn trash_root_ids(nodes: &BTreeMap<String, StoredNode>) -> Vec<String> {
    let ids = nodes.keys().cloned().collect::<BTreeSet<_>>();
    nodes
        .values()
        .filter(|node| {
            node.parent_id.as_ref().is_none_or(|parent| {
                !ids.contains(parent) || nodes[parent].deleted_batch_id != node.deleted_batch_id
            })
        })
        .map(|node| node.id.clone())
        .collect::<Vec<_>>()
}

fn build_trash_doc(connection: &Connection) -> Result<TrashDoc, String> {
    let nodes = load_trash_nodes(connection)?;
    let mut root_ids = trash_root_ids(&nodes);
    root_ids.sort_by(|left, right| {
        nodes[left]
            .sort_key
            .cmp(&nodes[right].sort_key)
            .then_with(|| left.cmp(right))
    });
    let mut built = Vec::with_capacity(root_ids.len());
    for (index, root_id) in root_ids.iter().enumerate() {
        built.push(build_topic_node(
            connection,
            root_id,
            &nodes,
            index + 1,
            true,
            nodes[root_id].deleted_batch_id.as_deref(),
        )?);
    }
    let mut statement = connection
        .prepare(
            "SELECT node_id, purged_hlc FROM sync_purged_tombstones ORDER BY node_id, purged_hlc",
        )
        .map_err(|error| format!("Could not prepare v3 Notes purge evidence: {error}"))?;
    let purged = statement
        .query_map([], |row| {
            Ok(PurgedTombstone {
                id: row.get(0)?,
                hlc: row.get(1)?,
            })
        })
        .map_err(|error| format!("Could not load v3 Notes purge evidence: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read v3 Notes purge evidence: {error}"))?;
    let max_hlc = nodes
        .values()
        .map(|node| node.hlc.as_str())
        .chain(purged.iter().map(|tombstone| tombstone.hlc.as_str()))
        .max()
        .unwrap_or_default()
        .to_string();
    Ok(TrashDoc {
        format_version: TOPIC_FORMAT_VERSION,
        max_hlc,
        purged,
        nodes: built,
    })
}

fn count_topic_nodes(node: &TopicNode) -> usize {
    1 + node.children.iter().map(count_topic_nodes).sum::<usize>()
}

fn collect_topic_node_ids(node: &TopicNode, out: &mut Vec<String>) {
    if let Some(id) = &node.id {
        out.push(id.clone());
    }
    for child in &node.children {
        collect_topic_node_ids(child, out);
    }
}

/// A2.5 emission side: when live trash exceeds the parser node cap, migrate the
/// oldest (by HLC) whole deleted subtrees into `trash-archive-<seq>.md`
/// write-once segments so `trash.md` stays renderable instead of wedging on the
/// pre-render cap check. Archived nodes are recorded in `sync_trash_archive`,
/// which the v3 trash loader excludes, so they never re-appear in `trash.md` and
/// are never re-archived. Returns true when at least one segment was written.
///
/// ponytail: runs under the connection lock and does its own segment writes
/// inline (Track B moved the hot export path off the lock, but this only fires
/// above the 20k-node trash cap — a cold path). Cross-device segment-seq
/// collision (two devices both minting trash-archive-1.md) is out of scope for
/// the dev stage; identity is still the frontmatter yid, so nodes never dup.
pub(crate) fn archive_trash_overflow(
    connection: &Connection,
    vault_path: &Path,
    writer: &mut ExportWriter<'_>,
) -> Result<bool, String> {
    let nodes = load_trash_nodes(connection)?;
    // Every deleted node appears exactly once in the rendered trash tree (a
    // cross-batch child becomes its own root), so the map size is the node
    // count — the common (≤ cap) case returns before building any subtree.
    if nodes.len() <= MAX_NOTES_EXPORT_NODES {
        return Ok(false);
    }
    let mut root_ids = trash_root_ids(&nodes);
    // Oldest HLC first so the freshest deletions stay in the live trash.md.
    root_ids.sort_by(|left, right| {
        nodes[left]
            .hlc
            .cmp(&nodes[right].hlc)
            .then_with(|| left.cmp(right))
    });
    let mut built: Vec<(String, TopicNode, usize)> = Vec::with_capacity(root_ids.len());
    for root_id in &root_ids {
        let node = build_topic_node(
            connection,
            root_id,
            &nodes,
            1,
            true,
            nodes[root_id].deleted_batch_id.as_deref(),
        )?;
        let size = count_topic_nodes(&node);
        built.push((root_id.clone(), node, size));
    }
    let total: usize = built.iter().map(|(_, _, size)| size).sum();
    if total <= MAX_NOTES_EXPORT_NODES {
        return Ok(false);
    }
    // Peel oldest roots into cap-sized segments until the live remainder fits.
    let mut remaining = total;
    let mut segment: Vec<TopicNode> = Vec::new();
    let mut segment_size = 0_usize;
    let mut seq = next_trash_archive_seq(connection)?;
    let mut archived_any = false;
    for (_, node, size) in built {
        if remaining <= MAX_NOTES_EXPORT_NODES {
            break;
        }
        // A single deleted subtree larger than the cap cannot form a valid
        // segment; leave it in trash.md and let the pre-render cap check
        // quarantine+surface it (rare, pathological).
        if size > MAX_NOTES_EXPORT_NODES {
            continue;
        }
        if segment_size + size > MAX_NOTES_EXPORT_NODES {
            flush_trash_archive_segment(
                connection,
                vault_path,
                seq,
                std::mem::take(&mut segment),
                writer,
            )?;
            segment_size = 0;
            seq = seq
                .checked_add(1)
                .ok_or_else(|| "Trash archive sequence overflowed i64::MAX.".to_string())?;
            archived_any = true;
        }
        segment_size += size;
        remaining -= size;
        segment.push(node);
    }
    if !segment.is_empty() {
        flush_trash_archive_segment(connection, vault_path, seq, segment, writer)?;
        archived_any = true;
    }
    Ok(archived_any)
}

fn next_trash_archive_seq(connection: &Connection) -> Result<i64, String> {
    let max: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM sync_trash_archive",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Could not resolve the next trash archive sequence: {error}"))?;
    // R15: a crafted `trash-archive-9223372036854775807.md` can set MAX(seq) to
    // i64::MAX; `max + 1` would then wrap (release) or panic (debug). Fail here
    // instead so the export surfaces the error and the trash target quarantines.
    max.checked_add(1)
        .ok_or_else(|| "Trash archive sequence overflowed i64::MAX.".to_string())
}

/// Renders one write-once segment, self-validates it, writes it atomically only
/// if it does not already exist (crash-safe retry: a matching existing segment
/// is accepted, a differing one is refused rather than clobbered), then records
/// its nodes as archived.
fn flush_trash_archive_segment(
    connection: &Connection,
    vault_path: &Path,
    seq: i64,
    nodes: Vec<TopicNode>,
    writer: &mut ExportWriter<'_>,
) -> Result<(), String> {
    let mut ids = Vec::new();
    for node in &nodes {
        collect_topic_node_ids(node, &mut ids);
    }
    let max_hlc = nodes
        .iter()
        .flat_map(|node| {
            let mut hlcs = Vec::new();
            collect_topic_node_hlcs(node, &mut hlcs);
            hlcs
        })
        .max()
        .unwrap_or_default();
    let document = TrashDoc {
        format_version: TOPIC_FORMAT_VERSION,
        max_hlc,
        purged: Vec::new(),
        nodes,
    };
    let bytes = render_topic_file(&TopicFile::Trash(document.clone()))?;
    match parse_topic_file(&bytes) {
        TopicParseOutcome::Parsed(TopicFile::Trash(parsed)) if parsed == document => {}
        _ => return Err("Trash archive segment failed self-validation.".to_string()),
    }
    let file_name = format!("{TRASH_ARCHIVE_PREFIX}{seq}.md");
    let path = vault_path.join(&file_name);
    match fs::read(&path) {
        Ok(existing) if existing == bytes => {}
        Ok(_) => {
            return Err(format!(
                "Trash archive segment {file_name} already exists with different bytes; \
                 refusing to rewrite a write-once segment."
            ))
        }
        // R10: honor the writer the export was invoked with. The guarded startup
        // path holds the vault directory open against path swaps; segment writes
        // must go through the same held parent rather than re-resolving the path.
        Err(_) => match writer {
            ExportWriter::Ambient => crate::file_io::write_atomic_file(&path, &bytes, true)?,
            ExportWriter::Guarded { vault, revalidate } => {
                crate::file_io::write_atomic_file_in_guarded_parent(
                    vault,
                    Path::new(&file_name),
                    &bytes,
                    true,
                    &mut **revalidate,
                    maybe_inject_before_atomic_export_publication,
                )?
            }
        },
    }
    // R10: register the archived nodes in one savepoint after the file write, so
    // the on-disk segment and its DB bookkeeping land together. A crash between
    // the atomic file write and this savepoint leaves an orphan segment on disk;
    // re-running re-writes identical bytes (accepted by the write-once check
    // above) and re-runs the registration. Duplicate segment content across such
    // a retry is harmless because node identity is the frontmatter yid — no node
    // is ever duplicated on re-merge (rule 2, idempotent merge).
    connection
        .execute_batch("SAVEPOINT trash_archive_registration")
        .map_err(|error| format!("Could not begin trash archive registration: {error}"))?;
    let registration = (|| -> rusqlite::Result<()> {
        for id in &ids {
            connection.execute(
                "INSERT OR IGNORE INTO sync_trash_archive(node_id, seq) VALUES (?1, ?2)",
                params![id, seq],
            )?;
        }
        Ok(())
    })();
    match registration {
        Ok(()) => connection
            .execute_batch("RELEASE trash_archive_registration")
            .map_err(|error| format!("Could not commit trash archive registration: {error}"))?,
        Err(error) => {
            let _ = connection.execute_batch(
                "ROLLBACK TO trash_archive_registration; RELEASE trash_archive_registration",
            );
            return Err(format!("Could not record an archived trash node: {error}"));
        }
    }
    Ok(())
}

fn collect_topic_node_hlcs(node: &TopicNode, out: &mut Vec<String>) {
    out.push(node.hlc.clone());
    for child in &node.children {
        collect_topic_node_hlcs(child, out);
    }
}

fn child_ids(nodes: &BTreeMap<String, StoredNode>, parent_id: Option<&str>) -> Vec<String> {
    let mut children = nodes
        .values()
        .filter(|node| node.parent_id.as_deref() == parent_id)
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    children.sort_by(|left, right| {
        nodes[left]
            .sort_key
            .cmp(&nodes[right].sort_key)
            .then_with(|| left.cmp(right))
    });
    children
}

fn build_topic_node(
    connection: &Connection,
    node_id: &str,
    nodes: &BTreeMap<String, StoredNode>,
    sibling_ordinal: usize,
    trash_root: bool,
    trash_batch_id: Option<&str>,
) -> Result<TopicNode, String> {
    let node = nodes
        .get(node_id)
        .ok_or_else(|| format!("Notes export node {node_id} is missing."))?;
    let attachment = load_attachment(connection, node)?;
    let content = match node.node_kind.as_str() {
        "text" => {
            if attachment.is_some() {
                return Err(format!(
                    "Text Notes node {node_id} cannot own a file-SSOT attachment."
                ));
            }
            TopicContent::Text(normalize_newlines(&node.title))
        }
        "image" => {
            let attachment = attachment.ok_or_else(|| {
                format!("Image Notes node {node_id} must own exactly one attachment for sync.")
            })?;
            let offset = crate::notes::schema::validate_image_offset_utf16(
                &node.title,
                crate::notes::types::NoteNodeKind::Image,
                node.image_offset_utf16,
            )?;
            let (before, after) = node.title.split_at(offset);
            TopicContent::Image {
                before: normalize_newlines(before),
                attachment,
                after: normalize_newlines(after),
            }
        }
        value => return Err(format!("Unsupported Notes node kind for sync: {value}")),
    };
    let children = child_ids(nodes, Some(node_id))
        .into_iter()
        .filter(|child_id| {
            trash_batch_id.is_none_or(|batch_id| {
                nodes[child_id].deleted_batch_id.as_deref() == Some(batch_id)
            })
        })
        .collect::<Vec<_>>();
    let mut built = Vec::with_capacity(children.len());
    for (index, child_id) in children.iter().enumerate() {
        built.push(build_topic_node(
            connection,
            child_id,
            nodes,
            index + 1,
            false,
            trash_batch_id,
        )?);
    }
    let plugin_meta = node.plugin_meta.as_ref().map(|meta| match meta {
        GithubNotificationsPluginMeta::Date { date_key } => TopicPluginMeta::GithubDate {
            date_key: date_key.clone(),
        },
        GithubNotificationsPluginMeta::Notification {
            notification_key,
            notification_type,
            url,
            updated_at,
            unread,
        } => TopicPluginMeta::GithubNotification {
            notification_key: notification_key.clone(),
            notification_type: notification_type.clone(),
            url: url.clone(),
            updated_at: updated_at.clone(),
            unread: *unread,
        },
    });
    if plugin_meta.is_some() && node.is_readonly.is_some() {
        return Err(format!(
            "Plugin-owned Notes node {node_id} has readonly storage."
        ));
    }
    Ok(TopicNode {
        marker_kind: node.marker_kind,
        id: Some(node.id.clone()),
        hlc: node.hlc.clone(),
        starred: node.starred,
        completed: node.completed_at.is_some(),
        content,
        note: normalize_newlines(&node.note),
        markdown_image_width: node.markdown_image_width,
        from: trash_root
            .then(|| node.parent_id.clone().map(|parent| (parent, node.sort_key)))
            .flatten(),
        // GN date/notification rows use the root's collapsed_groups and have
        // no per-row collapse token; user-owned descendants keep ordinary
        // collapse state.
        collapsed: plugin_meta.is_none() && node.is_collapsed,
        readonly: if plugin_meta.is_some() {
            None
        } else {
            node.is_readonly
        },
        plugin_meta,
        sibling_ordinal,
        sort_key: i64::try_from(sibling_ordinal)
            .ok()
            .and_then(|ordinal| ordinal.checked_mul(SORT_KEY_STEP))
            .ok_or_else(|| "A Notes sync sibling position is too large.".to_string())?,
        children: built,
    })
}

fn load_attachment(
    connection: &Connection,
    node: &StoredNode,
) -> Result<Option<TopicAttachment>, String> {
    let mut statement = connection
        .prepare(
            "SELECT content_hash, original_name, mime_type, display_width \
             FROM notes_attachments WHERE node_id = ?1 ORDER BY sort_key, id",
        )
        .map_err(|error| format!("Could not prepare a Notes sync attachment: {error}"))?;
    let attachments = statement
        .query_map([&node.id], |row| {
            Ok(StoredAttachment {
                content_hash: row.get(0)?,
                original_name: row.get(1)?,
                mime_type: row.get(2)?,
                display_width: row.get(3)?,
            })
        })
        .map_err(|error| format!("Could not load a Notes sync attachment: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read a Notes sync attachment: {error}"))?;
    if attachments.len() > 1 {
        return Err(format!(
            "Notes node {} owns more than one file-SSOT attachment.",
            node.id
        ));
    }
    attachments
        .into_iter()
        .next()
        .map(|attachment| {
            let extension = match attachment.mime_type.as_str() {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                "image/gif" => "gif",
                value => return Err(format!("Unsupported Notes sync attachment type: {value}")),
            };
            Ok(TopicAttachment {
                content_hash: attachment.content_hash,
                extension: extension.to_string(),
                encoded_original_name: encode_original_name(&attachment.original_name),
                display_width: (attachment.display_width > 0).then_some(attachment.display_width),
            })
        })
        .transpose()
}

fn encode_original_name(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

pub(crate) fn publish_export_snapshot(
    connection: &mut Connection,
    vault_path: &Path,
    snapshot: &ExportSnapshot,
) -> Result<String, String> {
    let mut write = |path: &Path, bytes: &[u8]| {
        maybe_inject_before_atomic_export_publication();
        crate::file_io::write_atomic_file(path, bytes, true)
    };
    publish_export_snapshot_with(
        connection,
        vault_path,
        snapshot,
        &render_topic_file,
        &mut write,
    )
}

fn publish_export_snapshot_in_guarded_vault(
    connection: &mut Connection,
    vault_path: &Path,
    snapshot: &ExportSnapshot,
    vault: &Dir,
    revalidate: &mut dyn FnMut() -> Result<(), String>,
) -> Result<String, String> {
    let file_name = Path::new(&snapshot.file_name);
    let mut write = |_path: &Path, bytes: &[u8]| {
        crate::file_io::write_atomic_file_in_guarded_parent(
            vault,
            file_name,
            bytes,
            true,
            &mut *revalidate,
            maybe_inject_before_atomic_export_publication,
        )
    };
    publish_export_snapshot_with(
        connection,
        vault_path,
        snapshot,
        &render_topic_file,
        &mut write,
    )
}

fn publish_export_snapshot_with(
    connection: &mut Connection,
    vault_path: &Path,
    snapshot: &ExportSnapshot,
    render: &TopicRenderer<'_>,
    write: &mut AtomicWriter<'_>,
) -> Result<String, String> {
    let bytes = render_validated_snapshot_bytes(snapshot, render)?;
    write(&vault_path.join(&snapshot.file_name), &bytes)?;
    record_published_snapshot(connection, snapshot, &bytes)
}

/// B4: renders the snapshot and proves render(parse) round-trips (unchanged
/// self-validation), touching only the in-memory snapshot. Callers run this
/// while holding the connection lock, then release the lock before the atomic
/// write so a slow cloud write never blocks every other Notes database
/// operation. The rendered bytes are the sole hand-off to the write phase.
pub(crate) fn render_validated_snapshot_bytes(
    snapshot: &ExportSnapshot,
    render: &TopicRenderer<'_>,
) -> Result<Vec<u8>, String> {
    let bytes = render(&snapshot.document)?;
    let parsed = match parse_topic_file(&bytes) {
        TopicParseOutcome::Parsed(document) => document,
        TopicParseOutcome::Quarantined(_) => {
            return Err("Rendered Notes sync bytes failed self-validation.".to_string())
        }
    };
    if canonicalize_topic_file_semantics(&parsed)
        != canonicalize_topic_file_semantics(&snapshot.document)
    {
        return Err(
            "Rendered Notes sync bytes changed semantic state during self-validation.".to_string(),
        );
    }
    Ok(bytes)
}

pub(crate) fn render_snapshot_bytes(snapshot: &ExportSnapshot) -> Result<Vec<u8>, String> {
    render_validated_snapshot_bytes(snapshot, &render_topic_file)
}

fn publish_github_first_snapshot_ambient(
    connection: &mut Connection,
    vault_path: &Path,
    snapshot: &ExportSnapshot,
) -> Result<Option<String>, String> {
    let vault = Dir::open_ambient_dir(vault_path, ambient_authority())
        .map_err(|error| format!("Could not hold the GitHub Notifications vault: {error}"))?;
    publish_github_first_snapshot_in_guarded_vault(connection, snapshot, &vault, &mut || Ok(()))
}

pub(crate) fn publish_github_first_snapshot_in_guarded_vault(
    connection: &mut Connection,
    snapshot: &ExportSnapshot,
    vault: &Dir,
    revalidate_vault: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Option<String>, String> {
    publish_github_first_snapshot_with(
        connection,
        snapshot,
        vault,
        revalidate_vault,
        maybe_inject_before_atomic_export_publication,
        || {},
        || Ok(()),
    )
    .and_then(|published| {
        published.ok_or_else(|| {
            "The first GitHub Notifications file already exists with different bytes.".to_string()
        })
    })
    .map(Some)
}

fn publish_github_snapshot_ambient(
    connection: &mut Connection,
    vault_path: &Path,
    snapshot: &ExportSnapshot,
    exported_hash: &str,
) -> Result<String, String> {
    let vault = Dir::open_ambient_dir(vault_path, ambient_authority())
        .map_err(|error| format!("Could not hold the GitHub Notifications vault: {error}"))?;
    publish_github_snapshot_in_guarded_vault(
        connection,
        snapshot,
        &vault,
        exported_hash,
        &mut || Ok(()),
    )
}

fn publish_github_snapshot_in_guarded_vault(
    connection: &mut Connection,
    snapshot: &ExportSnapshot,
    vault: &Dir,
    exported_hash: &str,
    revalidate_vault: &mut dyn FnMut() -> Result<(), String>,
) -> Result<String, String> {
    if snapshot.target != ExportTarget::Topic(GITHUB_NOTIFICATIONS_ROOT_ID.to_string())
        || snapshot.file_name != GITHUB_NOTIFICATIONS_FILENAME
        || exported_hash.is_empty()
    {
        return Err(
            "A GitHub Notifications update requires an exported canonical snapshot.".to_string(),
        );
    }
    let bytes = render_snapshot_bytes(snapshot)?;
    let file_name = Path::new(GITHUB_NOTIFICATIONS_FILENAME);
    let Some((existing, previous)) = read_topic_file_in_guarded_vault(vault, file_name)? else {
        crate::file_io::write_atomic_file_in_guarded_parent(
            vault,
            file_name,
            &bytes,
            false,
            &mut *revalidate_vault,
            || {},
        )?;
        let (current, held) = read_topic_file_in_guarded_vault(vault, file_name)?
            .ok_or_else(|| "The GitHub Notifications recovery disappeared.".to_string())?;
        if current != bytes {
            return Err("The GitHub Notifications recovery changed before recording.".to_string());
        }
        let current_hash = sha256_hex(&bytes);
        return record_published_snapshot_with_revalidation(connection, snapshot, &bytes, || {
            revalidate_vault()?;
            revalidate_github_publication(&held, vault, file_name, &current_hash)
        });
    };
    if sha256_hex(&existing) != exported_hash {
        return Err(
            "The GitHub Notifications file changed since its last export and was not overwritten."
                .to_string(),
        );
    }
    let mut prepublication_revalidations = 0_u8;
    crate::file_io::write_atomic_file_in_guarded_parent(
        vault,
        file_name,
        &bytes,
        true,
        || {
            revalidate_vault()?;
            let validate_previous = prepublication_revalidations < 2;
            prepublication_revalidations += 1;
            if validate_previous {
                revalidate_github_publication(&previous, vault, file_name, exported_hash)
            } else {
                Ok(())
            }
        },
        || {},
    )?;
    let (current, held) = read_topic_file_in_guarded_vault(vault, file_name)?
        .ok_or_else(|| "The GitHub Notifications update disappeared.".to_string())?;
    if current != bytes {
        return Err("The GitHub Notifications update changed before recording.".to_string());
    }
    let current_hash = sha256_hex(&bytes);
    record_published_snapshot_with_revalidation(connection, snapshot, &bytes, || {
        revalidate_vault()?;
        revalidate_github_publication(&held, vault, file_name, &current_hash)
    })
}

fn publish_github_first_snapshot_with(
    connection: &mut Connection,
    snapshot: &ExportSnapshot,
    vault: &Dir,
    revalidate_vault: &mut dyn FnMut() -> Result<(), String>,
    before_no_replace_publication: impl FnOnce(),
    after_held_read: impl FnOnce(),
    after_create_before_record: impl FnOnce() -> Result<(), String>,
) -> Result<Option<String>, String> {
    if snapshot.target != ExportTarget::Topic(GITHUB_NOTIFICATIONS_ROOT_ID.to_string())
        || snapshot.file_name != GITHUB_NOTIFICATIONS_FILENAME
    {
        return Err(
            "The first GitHub publication requires the canonical topic snapshot.".to_string(),
        );
    }
    let bytes = render_snapshot_bytes(snapshot)?;
    let file_name = Path::new(GITHUB_NOTIFICATIONS_FILENAME);
    let created = match crate::file_io::write_atomic_file_in_guarded_parent(
        vault,
        file_name,
        &bytes,
        false,
        &mut *revalidate_vault,
        before_no_replace_publication,
    ) {
        Ok(()) => true,
        Err(error) if error == crate::file_io::DESTINATION_EXISTS_MESSAGE => false,
        Err(error) => Err(format!(
            "Could not publish the first GitHub Notifications file: {error}"
        ))?,
    };
    let (existing, held) = read_topic_file_in_guarded_vault(vault, file_name)?
        .ok_or_else(|| "The GitHub Notifications publication disappeared.".to_string())?;
    if existing != bytes {
        return Ok(None);
    }
    after_held_read();
    if created {
        after_create_before_record()?;
    }
    record_published_snapshot_with_revalidation(connection, snapshot, &bytes, || {
        revalidate_vault()?;
        held.verify_at(vault, file_name).map_err(|error| {
            format!(
                "The GitHub Notifications publication identity changed before recording: {error}"
            )
        })
    })
    .map(Some)
}

fn publish_github_first_snapshot_unlocked(
    vault_path: &Path,
    snapshot: &ExportSnapshot,
    bytes: &[u8],
) -> Result<HeldGithubFirstPublication, String> {
    if snapshot.target != ExportTarget::Topic(GITHUB_NOTIFICATIONS_ROOT_ID.to_string())
        || snapshot.file_name != GITHUB_NOTIFICATIONS_FILENAME
    {
        return Err(
            "The first GitHub publication requires the canonical topic snapshot.".to_string(),
        );
    }
    let path = vault_path.join(GITHUB_NOTIFICATIONS_FILENAME);
    if let Err(error) = crate::file_io::write_atomic_file(&path, bytes, false) {
        if error != crate::file_io::DESTINATION_EXISTS_MESSAGE {
            return Err(format!(
                "Could not publish the first GitHub Notifications file: {error}"
            ));
        }
    }
    let vault = Dir::open_ambient_dir(vault_path, ambient_authority())
        .map_err(|error| format!("Could not hold the first GitHub Notifications vault: {error}"))?;
    let (existing, held) =
        read_topic_file_in_guarded_vault(&vault, Path::new(GITHUB_NOTIFICATIONS_FILENAME))?
            .ok_or_else(|| "The GitHub Notifications publication disappeared.".to_string())?;
    (existing == bytes)
        .then_some(HeldGithubFirstPublication { vault, held })
        .ok_or_else(|| {
            "The first GitHub Notifications file already exists with different bytes.".to_string()
        })
}

fn publish_github_snapshot_unlocked(
    vault_path: &Path,
    snapshot: &ExportSnapshot,
    bytes: &[u8],
    exported_hash: &str,
) -> Result<HeldGithubFirstPublication, String> {
    if snapshot.target != ExportTarget::Topic(GITHUB_NOTIFICATIONS_ROOT_ID.to_string())
        || snapshot.file_name != GITHUB_NOTIFICATIONS_FILENAME
        || exported_hash.is_empty()
    {
        return Err(
            "A GitHub Notifications update requires an exported canonical snapshot.".to_string(),
        );
    }
    let vault = Dir::open_ambient_dir(vault_path, ambient_authority())
        .map_err(|error| format!("Could not hold the GitHub Notifications vault: {error}"))?;
    let file_name = Path::new(GITHUB_NOTIFICATIONS_FILENAME);
    let Some((existing, previous)) = read_topic_file_in_guarded_vault(&vault, file_name)? else {
        let path = vault_path.join(GITHUB_NOTIFICATIONS_FILENAME);
        crate::file_io::write_atomic_file(&path, bytes, false).map_err(|error| {
            format!("Could not safely recreate the GitHub Notifications file: {error}")
        })?;
        let (current, held) = read_topic_file_in_guarded_vault(&vault, file_name)?
            .ok_or_else(|| "The GitHub Notifications recovery disappeared.".to_string())?;
        if current != bytes {
            return Err("The GitHub Notifications recovery changed before recording.".to_string());
        }
        return Ok(HeldGithubFirstPublication { vault, held });
    };
    if sha256_hex(&existing) != exported_hash {
        return Err(
            "The GitHub Notifications file changed since its last export and was not overwritten."
                .to_string(),
        );
    }
    let mut prepublication_revalidations = 0_u8;
    crate::file_io::write_atomic_file_in_guarded_parent(
        &vault,
        file_name,
        bytes,
        true,
        || {
            let mut current =
                Vec::with_capacity(usize::try_from(previous.byte_size()).unwrap_or(0));
            previous
                .reader_from_start()
                .and_then(|mut reader| reader.read_to_end(&mut current))
                .map_err(|error| {
                    format!("Could not re-read the prior GitHub Notifications publication: {error}")
                })?;
            if sha256_hex(&current) != exported_hash {
                return Err(
                    "The GitHub Notifications file changed since its last export and was not overwritten."
                        .to_string(),
                );
            }
            let validate_previous = prepublication_revalidations < 2;
            prepublication_revalidations += 1;
            if validate_previous {
                previous.verify_at(&vault, file_name).map_err(|error| {
                    format!(
                        "The GitHub Notifications publication identity changed before update: {error}"
                    )
                })
            } else {
                Ok(())
            }
        },
        || {},
    )?;
    let (current, held) = read_topic_file_in_guarded_vault(&vault, file_name)?
        .ok_or_else(|| "The GitHub Notifications update disappeared.".to_string())?;
    if current != bytes {
        return Err("The GitHub Notifications update changed before recording.".to_string());
    }
    Ok(HeldGithubFirstPublication { vault, held })
}

fn revalidate_github_publication(
    held: &crate::file_io::HeldBoundedCapabilityFile,
    vault: &Dir,
    file_name: &Path,
    expected_hash: &str,
) -> Result<(), String> {
    let mut current = Vec::with_capacity(usize::try_from(held.byte_size()).unwrap_or(0));
    held.reader_from_start()
        .and_then(|mut reader| reader.read_to_end(&mut current))
        .map_err(|error| {
            format!("Could not re-read the GitHub Notifications publication: {error}")
        })?;
    if sha256_hex(&current) != expected_hash {
        return Err(
            "The GitHub Notifications file changed since its last export and was not overwritten."
                .to_string(),
        );
    }
    held.verify_at(vault, file_name).map_err(|error| {
        format!("The GitHub Notifications publication identity changed before recording: {error}")
    })
}

struct HeldGithubFirstPublication {
    vault: Dir,
    held: crate::file_io::HeldBoundedCapabilityFile,
}

impl HeldGithubFirstPublication {
    fn revalidate(&self, expected: &[u8]) -> Result<(), String> {
        let mut actual = Vec::with_capacity(usize::try_from(self.held.byte_size()).unwrap_or(0));
        self.held
            .reader_from_start()
            .and_then(|mut reader| reader.read_to_end(&mut actual))
            .map_err(|error| {
                format!("Could not re-read the first GitHub Notifications publication: {error}")
            })?;
        if actual != expected {
            return Err(
                "The first GitHub Notifications publication bytes changed before recording."
                    .to_string(),
            );
        }
        self.held
            .verify_at(&self.vault, Path::new(GITHUB_NOTIFICATIONS_FILENAME))
            .map_err(|error| {
                format!(
                    "The first GitHub Notifications publication identity changed before recording: {error}"
                )
            })
    }
}

/// B4: records the exported hash and drains the captured dirty markers after the
/// file is already on disk. Re-acquiring the connection lock here is what lets
/// the write happen unlocked; the exact-match dirty deletion in
/// `clear_dirty_markers` still only clears rows whose hlc is unchanged, so a
/// concurrent edit during the unlocked window keeps the topic dirty for the
/// next tick. Echo window: between the write and this hash record a watcher may
/// read our own file, but the merge is idempotent, so it is harmless — the same
/// property the pre-crash single-lock path relied on.
pub(crate) fn record_published_snapshot(
    connection: &mut Connection,
    snapshot: &ExportSnapshot,
    bytes: &[u8],
) -> Result<String, String> {
    record_published_snapshot_with_revalidation(connection, snapshot, bytes, || Ok(()))
}

fn record_published_snapshot_with_revalidation(
    connection: &mut Connection,
    snapshot: &ExportSnapshot,
    bytes: &[u8],
    revalidate: impl FnOnce() -> Result<(), String>,
) -> Result<String, String> {
    let hash = sha256_hex(bytes);
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start recording a Notes export: {error}"))?;
    let topic_id = match &snapshot.target {
        ExportTarget::Topic(topic_id) => topic_id.as_str(),
        ExportTarget::Trash => TRASH_TOPIC_ID,
        ExportTarget::RemoveTopic(_) => unreachable!("removals do not publish snapshots"),
    };
    let max_hlc = match &snapshot.document {
        TopicFile::Topic(document) => document.max_hlc.as_str(),
        TopicFile::Trash(document) => document.max_hlc.as_str(),
    };
    transaction
        .execute(
            "UPDATE sync_topics SET exported_hash = ?1, applied_max_hlc = max(applied_max_hlc, ?2), \
                    quarantined = 0 WHERE topic_id = ?3",
            params![hash, max_hlc, topic_id],
        )
        .map_err(|error| format!("Could not record a Notes export hash: {error}"))?;
    clear_dirty_markers(&transaction, &snapshot.dirty)?;
    revalidate()?;
    transaction
        .commit()
        .map_err(|error| format!("Could not finish recording a Notes export: {error}"))?;
    Ok(hash)
}

fn clear_dirty_markers(
    transaction: &rusqlite::Transaction<'_>,
    markers: &[DirtyMarker],
) -> Result<(), String> {
    for marker in markers {
        transaction
            .execute(
                "DELETE FROM sync_dirty_nodes \
                 WHERE node_id = ?1 AND marked_at = ?2 \
                   AND ((?3 IS NULL AND NOT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)) \
                        OR (?3 IS NOT NULL AND (SELECT hlc FROM notes_nodes WHERE id = ?1) = ?3))",
                params![marker.node_id, marker.marked_at, marker.node_hlc],
            )
            .map_err(|error| format!("Could not clear an exported Notes dirty row: {error}"))?;
    }
    Ok(())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        capture_export_snapshot, inject_after_unlocked_write_once, load_pending_exports,
        next_trash_archive_seq, publish_export_snapshot, publish_export_snapshot_with,
        publish_github_first_snapshot_in_guarded_vault, publish_github_first_snapshot_with,
        publish_pending_exports_unlocked, publish_topic_removal, publish_topic_removal_with,
        quarantine_export_target, render_snapshot_bytes, DebounceSchedule, ExportSnapshot,
        ExportTarget, PendingExport, TRASH_FILE_NAME, TRASH_TOPIC_ID,
    };
    use crate::notes::connection::{
        acquire_notes_connection, evict_notes_connection, lock_notes_connection,
    };
    use crate::notes::github_notifications::{
        github_date_node_id, github_notification_node_id, serialize_github_plugin_meta_storage,
        GithubNotificationsPluginMeta, GITHUB_NOTIFICATIONS_FILENAME, GITHUB_NOTIFICATIONS_ROOT_ID,
        GITHUB_NOTIFICATIONS_TITLE, SEED_HLC,
    };
    use crate::notes::history::install_session_history;
    use crate::notes::repository::{
        connect_notes_db, empty_trash, move_node, restore_node, soft_delete_node,
    };
    use crate::notes::schema::{install_notes_sql_functions, V3_SCHEMA_SQL};
    use crate::notes::sync::bootstrap::seed_github_notifications_root;
    use crate::notes::sync::merger::{merge_topic_doc, merge_trash_doc};
    use crate::notes::sync::topic_file::{
        render_topic_file, TopicDoc, TopicFile, TopicRoot, TOPIC_FORMAT_VERSION,
    };
    use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
    use crate::notes::types::MoveNodeInput;
    use rusqlite::{params, Connection};
    use std::cell::Cell;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    const TOPIC_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SECOND_TOPIC_ID: &str = "33333333-3333-4333-8333-333333333333";
    const PURGED_ID: &str = "44444444-4444-4444-8444-444444444444";
    const HLC_1: &str = "000000001-00-a3f2";
    const HLC_2: &str = "000000002-00-a3f2";
    const HLC_3: &str = "000000003-00-a3f2";

    fn fixture() -> (TempDir, Connection) {
        let vault = tempfile::tempdir().expect("create vault");
        let mut connection = connect_notes_db(vault.path().to_str().expect("utf-8 vault"))
            .expect("open Notes database");
        let transaction = connection.transaction().expect("start fixture reset");
        transaction
            .execute("DELETE FROM notes_nodes", [])
            .expect("remove onboarding nodes");
        transaction
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear onboarding dirtiness");
        transaction.commit().expect("commit fixture reset");
        (vault, connection)
    }

    fn github_first_publication_fixture() -> (TempDir, Connection, ExportSnapshot, Vec<u8>) {
        let vault = tempfile::tempdir().expect("create GN publication vault");
        let mut connection = Connection::open_in_memory().expect("open GN publication database");
        install_notes_sql_functions(&connection).expect("install SQL functions");
        connection
            .execute_batch(V3_SCHEMA_SQL)
            .expect("create v3 schema");
        install_session_history(&connection).expect("install v3 history");
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id,parent_id,sort_key,title,note,is_collapsed,is_readonly,plugin_state,plugin_meta,\
                   created_at,updated_at,hlc\
                 ) VALUES (?1,NULL,1024,?2,'',0,NULL,'[]',NULL,\
                           '1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z',?3)",
                params![
                    GITHUB_NOTIFICATIONS_ROOT_ID,
                    GITHUB_NOTIFICATIONS_TITLE,
                    SEED_HLC
                ],
            )
            .expect("insert seeded GN root");
        connection
            .execute(
                "INSERT INTO sync_topics(topic_id,file_name) VALUES (?1,?2)",
                params![GITHUB_NOTIFICATIONS_ROOT_ID, GITHUB_NOTIFICATIONS_FILENAME],
            )
            .expect("register GN topic");
        connection
            .execute(
                "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1)",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
            )
            .expect("dirty GN topic");
        let pending = load_pending_exports(&connection)
            .expect("load GN pending export")
            .remove(&ExportTarget::Topic(
                GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
            ))
            .expect("GN export target");
        let snapshot =
            capture_export_snapshot(&mut connection, &pending).expect("capture GN v3 snapshot");
        let bytes = render_snapshot_bytes(&snapshot).expect("render GN v3 snapshot");
        (vault, connection, snapshot, bytes)
    }

    fn publish_github_first_snapshot_for_test(
        connection: &mut Connection,
        vault: &TempDir,
        snapshot: &ExportSnapshot,
    ) -> Result<Option<String>, String> {
        let guarded =
            cap_std::fs::Dir::open_ambient_dir(vault.path(), cap_std::ambient_authority())
                .expect("hold GN publication vault");
        publish_github_first_snapshot_in_guarded_vault(connection, snapshot, &guarded, &mut || {
            Ok(())
        })
    }

    #[test]
    fn github_first_publication_creates_or_acknowledges_but_never_overwrites() {
        let (vault, mut connection, snapshot, bytes) = github_first_publication_fixture();
        let hash = publish_github_first_snapshot_for_test(&mut connection, &vault, &snapshot)
            .expect("publish absent canonical GN file")
            .expect("absent publication completed");
        assert_eq!(
            fs::read(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME)).unwrap(),
            bytes
        );
        assert_eq!(hash, super::sha256_hex(&bytes));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );

        let (vault, mut connection, snapshot, bytes) = github_first_publication_fixture();
        fs::write(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME), &bytes)
            .expect("precreate identical GN file");
        assert!(
            publish_github_first_snapshot_for_test(&mut connection, &vault, &snapshot)
                .expect("acknowledge identical GN file")
                .is_some()
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );

        let (vault, mut connection, snapshot, _) = github_first_publication_fixture();
        let competing = b"competing iCloud bytes";
        fs::write(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME), competing)
            .expect("precreate competing GN file");
        let error = publish_github_first_snapshot_for_test(&mut connection, &vault, &snapshot)
            .expect_err("differing first publication must not overwrite the competing file");
        assert!(error.contains("different bytes"), "{error}");
        assert_eq!(
            fs::read(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME)).unwrap(),
            competing
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            ""
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn github_first_publication_rejects_identical_read_replacement_before_record() {
        let (vault, mut connection, snapshot, bytes) = github_first_publication_fixture();
        let path = vault.path().join(GITHUB_NOTIFICATIONS_FILENAME);
        fs::write(&path, bytes).expect("precreate identical GN file");
        let guarded =
            cap_std::fs::Dir::open_ambient_dir(vault.path(), cap_std::ambient_authority())
                .expect("hold GN vault");
        let mut revalidate = || Ok(());

        let error = publish_github_first_snapshot_with(
            &mut connection,
            &snapshot,
            &guarded,
            &mut revalidate,
            || {},
            || {
                let replacement = path.with_extension("replacement");
                fs::write(&replacement, b"replacement bytes").expect("stage replacement GN bytes");
                fs::rename(&replacement, &path)
                    .expect("replace canonical GN identity after held read");
            },
            || Ok(()),
        )
        .expect_err("held publication identity must reject a replacement");
        assert!(error.contains("identity"), "{error}");
        assert_eq!(fs::read(&path).unwrap(), b"replacement bytes");
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            ""
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn github_first_publication_handles_create_competitors_and_post_create_retry() {
        let (vault, mut connection, snapshot, bytes) = github_first_publication_fixture();
        let path = vault.path().join(GITHUB_NOTIFICATIONS_FILENAME);
        let guarded =
            cap_std::fs::Dir::open_ambient_dir(vault.path(), cap_std::ambient_authority())
                .expect("hold GN vault");
        let mut revalidate = || Ok(());
        let hash = publish_github_first_snapshot_with(
            &mut connection,
            &snapshot,
            &guarded,
            &mut revalidate,
            || fs::write(&path, &bytes).expect("publish identical competitor"),
            || {},
            || Ok(()),
        )
        .expect("acknowledge identical create competitor")
        .expect("record identical create competitor");
        assert_eq!(hash, super::sha256_hex(&bytes));
        assert_eq!(fs::read(&path).unwrap(), bytes);

        let (vault, mut connection, snapshot, _) = github_first_publication_fixture();
        let path = vault.path().join(GITHUB_NOTIFICATIONS_FILENAME);
        let guarded =
            cap_std::fs::Dir::open_ambient_dir(vault.path(), cap_std::ambient_authority())
                .expect("hold GN vault");
        let mut revalidate = || Ok(());
        assert_eq!(
            publish_github_first_snapshot_with(
                &mut connection,
                &snapshot,
                &guarded,
                &mut revalidate,
                || fs::write(&path, b"different competitor").expect("publish competitor"),
                || {},
                || Ok(()),
            )
            .expect("defer to differing create competitor"),
            None
        );
        assert_eq!(fs::read(&path).unwrap(), b"different competitor");
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            ""
        );

        let (vault, mut connection, snapshot, bytes) = github_first_publication_fixture();
        let path = vault.path().join(GITHUB_NOTIFICATIONS_FILENAME);
        let guarded =
            cap_std::fs::Dir::open_ambient_dir(vault.path(), cap_std::ambient_authority())
                .expect("hold GN vault");
        let mut revalidate = || Ok(());
        assert!(publish_github_first_snapshot_with(
            &mut connection,
            &snapshot,
            &guarded,
            &mut revalidate,
            || {},
            || {},
            || Err("injected post-create database failure".to_string()),
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            ""
        );
        assert!(
            publish_github_first_snapshot_for_test(&mut connection, &vault, &snapshot)
                .expect("retry exact created file")
                .is_some()
        );
    }

    #[test]
    fn github_first_publication_revalidates_the_guarded_vault_inside_recording() {
        let (vault, mut connection, snapshot, bytes) = github_first_publication_fixture();
        fs::write(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME), bytes)
            .expect("precreate identical GN file");
        let guarded =
            cap_std::fs::Dir::open_ambient_dir(vault.path(), cap_std::ambient_authority())
                .expect("hold GN vault");
        let after_read = Cell::new(false);
        let mut revalidate = || {
            if after_read.get() {
                Err("injected guarded vault identity change".to_string())
            } else {
                Ok(())
            }
        };
        let error = publish_github_first_snapshot_with(
            &mut connection,
            &snapshot,
            &guarded,
            &mut revalidate,
            || {},
            || after_read.set(true),
            || Ok(()),
        )
        .expect_err("recording must revalidate the guarded vault");
        assert!(error.contains("identity change"), "{error}");
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            ""
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn github_first_publication_rejects_a_preexisting_symlink() {
        use std::os::unix::fs::symlink;

        let (vault, mut connection, snapshot, _) = github_first_publication_fixture();
        let target = vault.path().join("outside.md");
        fs::write(&target, b"outside bytes").expect("create symlink target");
        symlink(&target, vault.path().join(GITHUB_NOTIFICATIONS_FILENAME))
            .expect("create canonical symlink");
        let error = publish_github_first_snapshot_for_test(&mut connection, &vault, &snapshot)
            .expect_err("canonical symlink must fail closed");
        assert!(!error.is_empty());
        assert_eq!(fs::read(&target).unwrap(), b"outside bytes");
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            ""
        );
    }

    #[test]
    fn export_round_trips_collapse_readonly_and_github_snapshot_fields() {
        let mut connection = Connection::open_in_memory().expect("v3 export database");
        install_notes_sql_functions(&connection).expect("install SQL functions");
        connection
            .execute_batch(V3_SCHEMA_SQL)
            .expect("create v3 schema");
        install_session_history(&connection).expect("install v3 history");
        let root = GITHUB_NOTIFICATIONS_ROOT_ID;
        let date = github_date_node_id("2026.07.21").unwrap();
        let notification_key =
            "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"thread-17\"]";
        let notification = github_notification_node_id(notification_key).unwrap();
        let user_child = "44444444-4444-4444-8444-444444444444";
        let writable_user_child = "55555555-5555-4555-8555-555555555555";
        let state = serde_json::to_string(&vec!["2026.07.21", "2026.07.22"]).unwrap();
        let date_meta =
            serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Date {
                date_key: "2026.07.21".to_string(),
            })
            .unwrap();
        let notification_meta =
            serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Notification {
                notification_key: notification_key.to_string(),
                notification_type: "issue".to_string(),
                url: "https://github.com/acme/yonalist/issues/17".to_string(),
                updated_at: "2026-07-21T10:00:00.000Z".to_string(),
                unread: true,
            })
            .unwrap();
        for (id, parent, sort, title, collapsed, readonly, state, meta) in [
            (
                root,
                None,
                1024_i64,
                "Github Notifications",
                true,
                None,
                Some(state.as_str()),
                None,
            ),
            (
                date.as_str(),
                Some(root),
                1024,
                "2026.07.21",
                false,
                None,
                None,
                Some(date_meta.as_str()),
            ),
            (
                notification.as_str(),
                Some(date.as_str()),
                1024,
                "Fix inline caret #17",
                false,
                None,
                None,
                Some(notification_meta.as_str()),
            ),
            (
                user_child,
                Some(notification.as_str()),
                1024,
                "Personal child",
                true,
                Some(1_i64),
                None,
                None,
            ),
            (
                writable_user_child,
                Some(notification.as_str()),
                2048,
                "Writable personal child",
                false,
                Some(0_i64),
                None,
                None,
            ),
        ] {
            connection.execute(
                "INSERT INTO notes_nodes(id,parent_id,sort_key,title,note,is_collapsed,is_readonly,plugin_state,plugin_meta,created_at,updated_at,hlc) \
                 VALUES (?1,?2,?3,?4,'',?5,?6,?7,?8,'2026-07-21T00:00:00Z','2026-07-21T00:00:00Z','0swkd7qz2-00-a3f2')",
                rusqlite::params![id,parent,sort,title,collapsed,readonly,state,meta],
            ).expect("insert v3 export node");
        }
        let pending = PendingExport {
            target: ExportTarget::Topic(root.to_string()),
            dirty: Vec::new(),
            fingerprint: String::new(),
        };
        let snapshot =
            capture_export_snapshot(&mut connection, &pending).expect("capture v3 topic");
        let bytes = render_snapshot_bytes(&snapshot).expect("render v3 topic");
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains(&format!("format_version: {TOPIC_FORMAT_VERSION}")));
        assert!(text.contains("collapsed_groups: [\"2026.07.21\",\"2026.07.22\"]"));
        assert!(text.contains("collapsed readonly"));
        connection
            .execute(
                "UPDATE notes_nodes SET is_readonly = 0 WHERE id = ?1",
                [date.as_str()],
            )
            .expect("corrupt plugin readonly storage");
        assert!(capture_export_snapshot(&mut connection, &pending).is_err());
    }

    #[test]
    fn v3_writable_children_round_trip_through_parse_merge_and_reexport() {
        let make_connection = || {
            let connection = Connection::open_in_memory().expect("v3 round trip database");
            install_notes_sql_functions(&connection).expect("install SQL functions");
            connection
                .execute_batch(V3_SCHEMA_SQL)
                .expect("create v3 schema");
            install_session_history(&connection).expect("install v3 history");
            connection
        };
        let root = TOPIC_ID;
        let child = CHILD_ID;
        let grandchild = SECOND_TOPIC_ID;
        let readonly = PURGED_ID;
        let mut source = make_connection();
        for (id, parent, title, readonly_value) in [
            (root, None, "Round trip", 0_i64),
            (child, Some(root), "Writable child", 0),
            (grandchild, Some(child), "Writable grandchild", 0),
            (readonly, Some(grandchild), "Readonly descendant", 1),
        ] {
            source
                .execute(
                    "INSERT INTO notes_nodes(id,parent_id,sort_key,title,note,is_collapsed,is_readonly,created_at,updated_at,hlc) \
                     VALUES (?1,?2,1024,?3, '', 0, ?4, '2026-07-21T00:00:00Z','2026-07-21T00:00:00Z','0swkd7qz2-00-a3f2')",
                    params![id, parent, title, readonly_value],
                )
                .expect("insert v3 ordinary node");
        }
        let pending = PendingExport {
            target: ExportTarget::Topic(root.to_string()),
            dirty: Vec::new(),
            fingerprint: String::new(),
        };
        let snapshot = capture_export_snapshot(&mut source, &pending).expect("capture source");
        let bytes = render_snapshot_bytes(&snapshot).expect("render source");
        let parsed = match parse_topic_file(&bytes) {
            TopicParseOutcome::Parsed(TopicFile::Topic(document)) => document,
            other => panic!("unexpected parsed v3 topic: {other:?}"),
        };
        let mut destination = make_connection();
        merge_topic_doc(&mut destination, &parsed).expect("merge parsed v3 topic");
        for id in [root, child, grandchild, readonly] {
            let value = destination
                .query_row(
                    "SELECT is_readonly FROM notes_nodes WHERE id = ?1",
                    [id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .expect("read readonly state");
            assert_eq!(value, Some(if id == readonly { 1 } else { 0 }));
        }
        let reexport =
            capture_export_snapshot(&mut destination, &pending).expect("capture reexport");
        let reparsed = render_snapshot_bytes(&reexport).expect("render reexport");
        assert_eq!(bytes, reparsed);

        source
            .execute(
                "UPDATE notes_nodes SET deleted_at = '2026-07-21T01:00:00Z', deleted_batch_id = 'batch-1'",
                [],
            )
            .expect("move ordinary tree to trash");
        let trash_pending = PendingExport {
            target: ExportTarget::Trash,
            dirty: Vec::new(),
            fingerprint: String::new(),
        };
        let trash_snapshot =
            capture_export_snapshot(&mut source, &trash_pending).expect("capture v3 trash");
        let trash_bytes = render_snapshot_bytes(&trash_snapshot).expect("render v3 trash");
        let trash_document = match parse_topic_file(&trash_bytes) {
            TopicParseOutcome::Parsed(TopicFile::Trash(document)) => document,
            other => panic!("unexpected parsed v3 trash: {other:?}"),
        };
        let mut trash_destination = make_connection();
        merge_trash_doc(&mut trash_destination, &trash_document).expect("merge v3 trash");
        let trash_reexport = capture_export_snapshot(&mut trash_destination, &trash_pending)
            .expect("capture v3 trash reexport");
        assert_eq!(
            trash_bytes,
            render_snapshot_bytes(&trash_reexport).expect("render v3 trash reexport")
        );
    }

    #[test]
    #[ignore = "release-only v3 export performance contract"]
    fn v3_export_performance_fixture_has_deterministic_size() {
        let mut connection = Connection::open_in_memory().expect("v3 performance database");
        install_notes_sql_functions(&connection).expect("install SQL functions");
        connection
            .execute_batch(V3_SCHEMA_SQL)
            .expect("create v3 schema");
        install_session_history(&connection).expect("install v3 history");
        connection
            .execute(
                "INSERT INTO notes_nodes(id,parent_id,sort_key,title,note,is_collapsed,is_readonly,created_at,updated_at,hlc) \
                 VALUES (?1,NULL,1024,'V3 performance fixture','',0,0,'2026-07-21T00:00:00Z','2026-07-21T00:00:00Z','0swkd7qz2-00-a3f2')",
                [TOPIC_ID],
            )
            .expect("insert v3 performance root");
        for index in 0..1_000 {
            let id = format!("00000000-0000-4000-8000-{index:012x}");
            connection
                .execute(
                    "INSERT INTO notes_nodes(id,parent_id,sort_key,title,note,is_collapsed,is_readonly,created_at,updated_at,hlc) \
                     VALUES (?1,?2,?3,?4,'',0,0,'2026-07-21T00:00:00Z','2026-07-21T00:00:00Z','0swkd7qz2-00-a3f2')",
                    params![id, TOPIC_ID, (index as i64 + 1) * 1024, format!("Node {index}")],
                )
                .expect("insert v3 performance child");
        }
        let pending = PendingExport {
            target: ExportTarget::Topic(TOPIC_ID.to_string()),
            dirty: Vec::new(),
            fingerprint: String::new(),
        };
        let started = Instant::now();
        let snapshot = capture_export_snapshot(&mut connection, &pending)
            .expect("capture v3 performance fixture");
        let first = render_snapshot_bytes(&snapshot).expect("render first fixture");
        let elapsed = started.elapsed();
        let second = render_snapshot_bytes(&snapshot).expect("render second fixture");
        assert_eq!(first, second);
        assert!(first.len() > 10_000);
        eprintln!("v3 export performance: ordinary 1k={elapsed:?}");
        assert!(
            elapsed < Duration::from_secs(1),
            "ordinary v3 1k capture+render took {elapsed:?}; personal-laptop gate is 1s"
        );
    }

    // R15: a crafted `trash-archive-9223372036854775807.md` sets MAX(seq) to
    // i64::MAX; the next sequence must fail instead of wrapping/panicking, so the
    // export surfaces the error and quarantines rather than clobbering.
    #[test]
    fn trash_archive_sequence_overflow_is_rejected() {
        let (_vault, connection) = fixture();
        connection
            .execute(
                "INSERT INTO sync_trash_archive(node_id, seq) VALUES ('n', ?1)",
                params![i64::MAX],
            )
            .expect("seed max sequence");
        let error = next_trash_archive_seq(&connection).expect_err("overflow must error");
        assert!(error.contains("overflow"), "unexpected error: {error}");
    }

    fn insert_node(
        connection: &Connection,
        id: &str,
        parent_id: Option<&str>,
        sort_key: i64,
        title: &str,
        hlc: &str,
        deleted: bool,
    ) {
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, note, created_at, updated_at, deleted_at, hlc\
                 ) VALUES (?1, ?2, ?3, ?4, '', '2026-07-21T00:00:00.000Z', \
                           '2026-07-21T00:00:00.000Z', ?5, ?6)",
                params![
                    id,
                    parent_id,
                    sort_key,
                    title,
                    deleted.then_some("2026-07-21T00:00:00.000Z"),
                    hlc
                ],
            )
            .expect("insert node");
    }

    fn mark_dirty(connection: &Connection, node_id: &str) {
        connection
            .execute(
                "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                 ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                [node_id],
            )
            .expect("mark node dirty");
    }

    fn topic_snapshot(connection: &mut Connection) -> super::ExportSnapshot {
        let pending = load_pending_exports(connection).expect("load pending exports");
        capture_export_snapshot(
            connection,
            pending
                .get(&ExportTarget::Topic(TOPIC_ID.to_string()))
                .expect("pending topic"),
        )
        .expect("capture topic")
    }

    fn observed(target: ExportTarget, fingerprint: &str) -> BTreeMap<ExportTarget, String> {
        BTreeMap::from([(target, fingerprint.to_string())])
    }

    #[test]
    fn debounce_exports_after_three_idle_seconds() {
        let target = ExportTarget::Topic("11111111-1111-4111-8111-111111111111".to_string());
        let mut schedule = DebounceSchedule::default();

        assert!(schedule
            .due(Duration::ZERO, observed(target.clone(), "a"), false)
            .is_empty());
        assert!(schedule
            .due(Duration::from_secs(2), observed(target.clone(), "a"), false)
            .is_empty());
        assert_eq!(
            schedule.due(Duration::from_secs(3), observed(target.clone(), "a"), false),
            vec![target]
        );
    }

    #[test]
    fn debounce_exports_after_thirty_total_seconds_despite_continuous_changes() {
        let target = ExportTarget::Trash;
        let mut schedule = DebounceSchedule::default();

        for second in 0..30 {
            assert!(schedule
                .due(
                    Duration::from_secs(second),
                    observed(target.clone(), &second.to_string()),
                    false,
                )
                .is_empty());
        }
        assert_eq!(
            schedule.due(
                Duration::from_secs(30),
                observed(target.clone(), "30"),
                false,
            ),
            vec![target]
        );
    }

    #[test]
    fn forced_flush_bypasses_debounce() {
        let target = ExportTarget::Trash;
        let mut schedule = DebounceSchedule::default();
        assert_eq!(
            schedule.due(Duration::ZERO, observed(target.clone(), "a"), true),
            vec![target]
        );
    }

    #[test]
    fn failed_debounce_target_remains_due_until_explicitly_completed() {
        let target = ExportTarget::Trash;
        let mut schedule = DebounceSchedule::default();

        assert_eq!(
            schedule.due(Duration::ZERO, observed(target.clone(), "a"), true),
            vec![target.clone()]
        );
        assert_eq!(
            schedule.due(Duration::from_secs(3), observed(target.clone(), "a"), false,),
            vec![target.clone()]
        );
        schedule.complete(&target);
        assert!(schedule
            .due(Duration::from_secs(4), observed(target, "a"), false,)
            .is_empty());
    }

    #[test]
    fn trash_uses_one_reserved_non_uuid_metadata_identity() {
        assert_eq!(TRASH_TOPIC_ID, "__yonalist_trash__");
        assert_eq!(TRASH_FILE_NAME, "trash.md");
        assert!(uuid::Uuid::parse_str(TRASH_TOPIC_ID).is_err());
    }

    #[test]
    fn topic_export_is_deterministic_and_records_hash_before_exact_dirty_clear() {
        let (vault, mut connection) = fixture();
        insert_node(&connection, TOPIC_ID, None, 2048, "Planning", HLC_1, false);
        insert_node(
            &connection,
            CHILD_ID,
            Some(TOPIC_ID),
            4096,
            "First child",
            HLC_2,
            false,
        );
        mark_dirty(&connection, CHILD_ID);

        let first = topic_snapshot(&mut connection);
        let second = topic_snapshot(&mut connection);
        assert_eq!(first, second);
        let hash =
            publish_export_snapshot(&mut connection, vault.path(), &first).expect("publish topic");

        let file_name: String = connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .expect("load topic filename");
        assert_eq!(file_name, "Planning.11111111.md");
        let bytes = fs::read(vault.path().join(file_name)).expect("read topic file");
        assert_eq!(
            bytes,
            render_topic_file(&first.document).expect("render topic")
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("load exported hash"),
            hash
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count dirty rows"),
            0
        );
    }

    #[test]
    fn topic_export_preserves_root_and_child_markdown_image_widths() {
        let (_vault, mut connection) = fixture();
        insert_node(&connection, TOPIC_ID, None, 2048, "Planning", HLC_1, false);
        insert_node(
            &connection,
            CHILD_ID,
            Some(TOPIC_ID),
            4096,
            "![root](https://example.com/child.png)",
            HLC_2,
            false,
        );
        connection
            .execute(
                "UPDATE notes_nodes SET markdown_image_width = CASE id \
                   WHEN ?1 THEN 640 WHEN ?2 THEN 480 END \
                 WHERE id IN (?1, ?2)",
                params![TOPIC_ID, CHILD_ID],
            )
            .expect("seed Markdown image widths");
        mark_dirty(&connection, CHILD_ID);

        let snapshot = topic_snapshot(&mut connection);
        let TopicFile::Topic(topic) = snapshot.document else {
            panic!("expected topic snapshot")
        };
        assert_eq!(topic.root.markdown_image_width, Some(640));
        assert_eq!(topic.nodes[0].markdown_image_width, Some(480));
    }

    #[test]
    fn trash_export_is_deterministic_and_tracks_virtual_hash_and_purge_evidence() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Live parent",
            HLC_1,
            false,
        );
        insert_node(
            &connection,
            CHILD_ID,
            Some(TOPIC_ID),
            2048,
            "Deleted child",
            HLC_2,
            true,
        );
        connection
            .execute(
                "INSERT INTO sync_purged_tombstones(node_id, purged_hlc) VALUES (?1, ?2)",
                params![PURGED_ID, HLC_3],
            )
            .expect("insert purge evidence");
        mark_dirty(&connection, TRASH_TOPIC_ID);

        let pending = load_pending_exports(&connection).expect("load pending trash");
        let snapshot = capture_export_snapshot(
            &mut connection,
            pending.get(&ExportTarget::Trash).expect("pending trash"),
        )
        .expect("capture trash");
        let hash = publish_export_snapshot(&mut connection, vault.path(), &snapshot)
            .expect("publish trash");
        let bytes = fs::read(vault.path().join(TRASH_FILE_NAME)).expect("read trash");
        assert_eq!(bytes, render_topic_file(&snapshot.document).unwrap());
        let text = String::from_utf8(bytes).expect("utf-8 trash");
        assert!(text.contains(&format!("purged: {PURGED_ID} {HLC_3}")));
        assert!(text.contains(&format!("from: {TOPIC_ID}@2048")));
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1 AND file_name = ?2",
                    params![TRASH_TOPIC_ID, TRASH_FILE_NAME],
                    |row| row.get::<_, String>(0),
                )
                .expect("load trash hash"),
            hash
        );
    }

    #[test]
    fn semantic_self_validation_failure_preserves_destination_hash_and_dirty_rows() {
        let (vault, mut connection) = fixture();
        insert_node(&connection, TOPIC_ID, None, 1024, "Original", HLC_1, false);
        mark_dirty(&connection, TOPIC_ID);
        let snapshot = topic_snapshot(&mut connection);
        let destination = vault.path().join(&snapshot.file_name);
        fs::write(&destination, b"existing").expect("seed destination");
        let wrote = Cell::new(false);
        let mut write = |_: &Path, _: &[u8]| {
            wrote.set(true);
            Ok(())
        };

        let error = publish_export_snapshot_with(
            &mut connection,
            vault.path(),
            &snapshot,
            &|document| {
                let mut changed = document.clone();
                let TopicFile::Topic(topic) = &mut changed else {
                    unreachable!()
                };
                topic.root.title.push_str(" changed");
                render_topic_file(&changed)
            },
            &mut write,
        )
        .expect_err("self-validation must reject semantic drift");
        assert!(error.contains("semantic state"));
        assert!(!wrote.get());
        assert_eq!(fs::read(destination).unwrap(), b"existing");
        assert_eq!(dirty_count(&connection), 1);
        assert_eq!(exported_hash(&connection, TOPIC_ID), "");
    }

    #[test]
    fn atomic_write_failure_preserves_destination_hash_and_dirty_rows() {
        let (vault, mut connection) = fixture();
        insert_node(&connection, TOPIC_ID, None, 1024, "Original", HLC_1, false);
        mark_dirty(&connection, TOPIC_ID);
        let snapshot = topic_snapshot(&mut connection);
        let mut write = |_: &Path, _: &[u8]| Err("injected atomic write failure".to_string());

        let error = publish_export_snapshot_with(
            &mut connection,
            vault.path(),
            &snapshot,
            &render_topic_file,
            &mut write,
        )
        .expect_err("write must fail");
        assert_eq!(error, "injected atomic write failure");
        assert_eq!(dirty_count(&connection), 1);
        assert_eq!(exported_hash(&connection, TOPIC_ID), "");
    }

    #[test]
    fn over_cap_topic_capture_quarantines_the_target_and_stops_retrying() {
        let (_vault, mut connection) = fixture();
        let cap = crate::notes::repository::MAX_NOTES_EXPORT_DEPTH;
        let root = uuid::Uuid::new_v4().to_string();
        insert_node(&connection, &root, None, 1024, "Deep root", HLC_1, false);
        let mut parent = root.clone();
        // cap + 1 descendants push the deepest bullet to zero-based depth `cap`,
        // which the parser (and therefore self-validation) would reject.
        for _ in 0..=cap {
            let id = uuid::Uuid::new_v4().to_string();
            insert_node(&connection, &id, Some(&parent), 1024, "deep", HLC_1, false);
            parent = id;
        }
        mark_dirty(&connection, &root);

        let pending = load_pending_exports(&connection).expect("load pending");
        let target = ExportTarget::Topic(root.clone());
        let error = capture_export_snapshot(
            &mut connection,
            pending.get(&target).expect("pending over-cap topic"),
        )
        .expect_err("an over-cap capture must fail rather than render invalid bytes");
        assert!(error.contains("export cap"), "{error}");
        assert_eq!(
            connection
                .query_row(
                    "SELECT quarantined FROM sync_topics WHERE topic_id = ?1",
                    [&root],
                    |row| row.get::<_, i64>(0),
                )
                .expect("quarantine flag"),
            1
        );
        // Quarantine makes the exporter skip the target instead of retrying it.
        assert!(!load_pending_exports(&connection)
            .expect("reload pending")
            .contains_key(&target));
    }

    #[test]
    fn export_clears_only_captured_unchanged_dirty_rows() {
        let (vault, mut connection) = fixture();
        insert_node(&connection, TOPIC_ID, None, 1024, "Original", HLC_1, false);
        insert_node(
            &connection,
            SECOND_TOPIC_ID,
            None,
            2048,
            "Other",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        let snapshot = topic_snapshot(&mut connection);
        mark_dirty(&connection, SECOND_TOPIC_ID);
        connection
            .execute(
                "UPDATE notes_nodes SET title = 'Changed while exporting', hlc = ?1 WHERE id = ?2",
                params![HLC_2, TOPIC_ID],
            )
            .expect("change captured topic");

        publish_export_snapshot(&mut connection, vault.path(), &snapshot)
            .expect("publish snapshot");
        let dirty = connection
            .prepare("SELECT node_id FROM sync_dirty_nodes ORDER BY node_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            dirty,
            vec![TOPIC_ID.to_string(), SECOND_TOPIC_ID.to_string()]
        );
    }

    #[test]
    fn assigned_filename_never_changes_after_title_changes() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Initial title",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        let first = topic_snapshot(&mut connection);
        publish_export_snapshot(&mut connection, vault.path(), &first).unwrap();
        let assigned = first.file_name.clone();
        connection
            .execute(
                "UPDATE notes_nodes SET title = 'Renamed title', hlc = ?1 WHERE id = ?2",
                params![HLC_2, TOPIC_ID],
            )
            .unwrap();
        mark_dirty(&connection, TOPIC_ID);
        let second = topic_snapshot(&mut connection);
        assert_eq!(second.file_name, assigned);
    }

    #[test]
    fn local_empty_trash_exports_newer_purge_evidence() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            CHILD_ID,
            None,
            1024,
            "Deleted forever",
            HLC_1,
            true,
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();

        empty_trash(&mut connection).expect("empty local trash");
        let purge_hlc: String = connection
            .query_row(
                "SELECT purged_hlc FROM sync_purged_tombstones WHERE node_id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("local purge evidence");
        assert!(purge_hlc.as_str() > HLC_1);
        let pending = load_pending_exports(&connection).expect("load purge dirtiness");
        let snapshot = capture_export_snapshot(
            &mut connection,
            pending.get(&ExportTarget::Trash).expect("pending trash"),
        )
        .expect("capture purged trash");
        publish_export_snapshot(&mut connection, vault.path(), &snapshot).unwrap();
        assert!(fs::read_to_string(vault.path().join(TRASH_FILE_NAME))
            .unwrap()
            .contains(&format!("purged: {CHILD_ID} {purge_hlc}")));
    }

    #[test]
    fn delete_and_restore_export_both_topic_and_trash_before_clearing_dirty() {
        let (vault, mut connection) = fixture();
        insert_node(&connection, TOPIC_ID, None, 1024, "Topic", HLC_1, false);
        insert_node(
            &connection,
            CHILD_ID,
            Some(TOPIC_ID),
            1024,
            "Lifecycle child",
            HLC_2,
            false,
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        soft_delete_node(&mut connection, CHILD_ID).expect("delete child");

        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [TRASH_TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        export_lifecycle_targets(&vault, &mut connection);
        let topic_name: String = connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!fs::read_to_string(vault.path().join(&topic_name))
            .unwrap()
            .contains("Lifecycle child"));
        assert!(fs::read_to_string(vault.path().join(TRASH_FILE_NAME))
            .unwrap()
            .contains("Lifecycle child"));
        assert_eq!(dirty_count(&connection), 0);

        restore_node(&mut connection, CHILD_ID).expect("restore child");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [TRASH_TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        export_lifecycle_targets(&vault, &mut connection);
        assert!(fs::read_to_string(vault.path().join(topic_name))
            .unwrap()
            .contains("Lifecycle child"));
        assert!(!fs::read_to_string(vault.path().join(TRASH_FILE_NAME))
            .unwrap()
            .contains("Lifecycle child"));
        assert_eq!(dirty_count(&connection), 0);
    }

    #[test]
    fn trash_export_preserves_independent_deletion_batch_boundaries() {
        let (_vault, mut source) = fixture();
        insert_node(&source, TOPIC_ID, None, 1024, "Parent", HLC_1, false);
        insert_node(
            &source,
            CHILD_ID,
            Some(TOPIC_ID),
            2048,
            "Child",
            HLC_2,
            false,
        );
        source.execute("DELETE FROM sync_dirty_nodes", []).unwrap();
        soft_delete_node(&mut source, CHILD_ID).expect("delete child independently");
        soft_delete_node(&mut source, TOPIC_ID).expect("delete ancestor later");

        let pending = load_pending_exports(&source).expect("load trash export");
        let snapshot = capture_export_snapshot(
            &mut source,
            pending.get(&ExportTarget::Trash).expect("pending trash"),
        )
        .expect("capture trash");
        let TopicFile::Trash(document) = snapshot.document else {
            unreachable!()
        };
        assert_eq!(document.nodes.len(), 2);
        let child = document
            .nodes
            .iter()
            .find(|node| node.id.as_deref() == Some(CHILD_ID))
            .expect("independently deleted child remains a trash root");
        assert_eq!(child.from, Some((TOPIC_ID.to_string(), 2048)));

        let (_other_vault, mut other) = fixture();
        merge_trash_doc(&mut other, &document).expect("merge trash on another device");
        let parent_batch: String = other
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        let child_batch: String = other
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(parent_batch, child_batch);
    }

    #[test]
    fn deleting_and_restoring_a_topic_root_removes_then_recreates_its_assigned_file() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Root lifecycle",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        let initial = topic_snapshot(&mut connection);
        let assigned_file_name = initial.file_name.clone();
        publish_export_snapshot(&mut connection, vault.path(), &initial).unwrap();
        assert!(vault.path().join(&assigned_file_name).is_file());

        soft_delete_node(&mut connection, TOPIC_ID).expect("delete topic root");
        export_all_pending(&vault, &mut connection).expect("export root deletion");
        assert!(!vault.path().join(&assigned_file_name).exists());
        assert!(fs::read_to_string(vault.path().join(TRASH_FILE_NAME))
            .unwrap()
            .contains("Root lifecycle"));
        assert_eq!(dirty_count(&connection), 0);

        restore_node(&mut connection, TOPIC_ID).expect("restore topic root");
        export_all_pending(&vault, &mut connection).expect("export root restore");
        assert!(fs::read_to_string(vault.path().join(&assigned_file_name))
            .unwrap()
            .contains("# Root lifecycle"));
        assert!(!fs::read_to_string(vault.path().join(TRASH_FILE_NAME))
            .unwrap()
            .contains("Root lifecycle"));
        assert_eq!(dirty_count(&connection), 0);
    }

    #[test]
    fn root_removal_waits_for_trash_and_retries_remove_or_post_unlink_failure() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Durable delete",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        let initial = topic_snapshot(&mut connection);
        let assigned_file_name = initial.file_name.clone();
        publish_export_snapshot(&mut connection, vault.path(), &initial).unwrap();
        soft_delete_node(&mut connection, TOPIC_ID).expect("delete topic root");
        let pending = load_pending_exports(&connection).unwrap();
        let removal = pending
            .get(&ExportTarget::RemoveTopic(TOPIC_ID.to_string()))
            .expect("pending topic removal")
            .clone();
        let remove_called = Cell::new(false);

        let error = publish_topic_removal_with(&mut connection, vault.path(), &removal, &|_| {
            remove_called.set(true);
            Ok(true)
        })
        .expect_err("topic removal must wait for trash");
        assert!(error.contains("dependency"));
        assert!(!remove_called.get());
        assert!(vault.path().join(&assigned_file_name).is_file());

        let trash = capture_export_snapshot(
            &mut connection,
            pending.get(&ExportTarget::Trash).expect("pending trash"),
        )
        .unwrap();
        publish_export_snapshot(&mut connection, vault.path(), &trash).unwrap();
        let error = publish_topic_removal_with(&mut connection, vault.path(), &removal, &|_| {
            Err("injected remove failure".to_string())
        })
        .expect_err("remove must fail before unlink");
        assert_eq!(error, "injected remove failure");
        assert!(vault.path().join(&assigned_file_name).is_file());
        assert_eq!(dirty_count(&connection), 1);

        let error = publish_topic_removal_with(&mut connection, vault.path(), &removal, &|path| {
            fs::remove_file(path).map_err(|error| error.to_string())?;
            Err("injected post-unlink failure".to_string())
        })
        .expect_err("post-unlink step must fail");
        assert_eq!(error, "injected post-unlink failure");
        assert!(!vault.path().join(&assigned_file_name).exists());
        assert_eq!(dirty_count(&connection), 1);

        assert!(
            !publish_topic_removal(&mut connection, vault.path(), &removal)
                .expect("retry absent removal and parent sync")
        );
        assert_eq!(dirty_count(&connection), 0);
    }

    #[test]
    fn metadata_absent_topic_removal_completes_after_destination_is_durable() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            SECOND_TOPIC_ID,
            None,
            1024,
            "Destination",
            HLC_1,
            false,
        );
        insert_node(
            &connection,
            TOPIC_ID,
            Some(SECOND_TOPIC_ID),
            1024,
            "Moved before export",
            HLC_2,
            false,
        );
        mark_dirty(&connection, SECOND_TOPIC_ID);
        export_all_pending(&vault, &mut connection).expect("export destination dependency");
        let marker = format!(
            "{}{}",
            crate::notes::schema::SYNC_REMOVE_TOPIC_PREFIX,
            TOPIC_ID
        );
        mark_dirty(&connection, &marker);
        let pending = load_pending_exports(&connection).expect("load orphan removal");
        let removal = pending
            .get(&ExportTarget::RemoveTopic(TOPIC_ID.to_string()))
            .expect("metadata-absent removal target")
            .clone();
        let remove_called = Cell::new(false);

        let removed = publish_topic_removal_with(&mut connection, vault.path(), &removal, &|_| {
            remove_called.set(true);
            Ok(true)
        })
        .expect("complete metadata-absent removal");

        assert!(!removed);
        assert!(!remove_called.get());
        assert_eq!(dirty_count(&connection), 0);
    }

    #[test]
    fn root_removal_preserves_a_source_changed_after_its_last_export() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Externally edited source",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        let initial = topic_snapshot(&mut connection);
        let assigned_file_name = initial.file_name.clone();
        publish_export_snapshot(&mut connection, vault.path(), &initial).unwrap();

        soft_delete_node(&mut connection, TOPIC_ID).expect("delete topic root");
        let pending = load_pending_exports(&connection).unwrap();
        let trash = capture_export_snapshot(
            &mut connection,
            pending.get(&ExportTarget::Trash).expect("pending trash"),
        )
        .unwrap();
        publish_export_snapshot(&mut connection, vault.path(), &trash).unwrap();
        let removal = pending
            .get(&ExportTarget::RemoveTopic(TOPIC_ID.to_string()))
            .expect("pending removal")
            .clone();
        let source_path = vault.path().join(&assigned_file_name);
        fs::write(&source_path, b"external edit after startup\n").unwrap();
        let remove_called = Cell::new(false);

        let error = publish_topic_removal_with(&mut connection, vault.path(), &removal, &|_| {
            remove_called.set(true);
            Ok(true)
        })
        .expect_err("changed source must survive retirement");

        assert!(error.contains("changed since its last export"));
        assert!(!remove_called.get());
        assert_eq!(
            fs::read(&source_path).unwrap(),
            b"external edit after startup\n"
        );
        assert_eq!(dirty_count(&connection), 1);
    }

    #[test]
    fn purging_a_topic_root_before_flush_still_exports_evidence_then_retires_its_file() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Purged root",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        let initial = topic_snapshot(&mut connection);
        let assigned_file_name = initial.file_name.clone();
        publish_export_snapshot(&mut connection, vault.path(), &initial).unwrap();

        soft_delete_node(&mut connection, TOPIC_ID).expect("delete root");
        empty_trash(&mut connection).expect("purge root before exporter tick");
        export_all_pending(&vault, &mut connection).expect("export purge and removal");

        assert!(!vault.path().join(assigned_file_name).exists());
        assert!(fs::read_to_string(vault.path().join(TRASH_FILE_NAME))
            .unwrap()
            .contains(&format!("purged: {TOPIC_ID}")));
        assert_eq!(dirty_count(&connection), 0);
    }

    #[test]
    fn purging_a_previously_retired_root_reexports_trash_before_finishing_removal() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Retired before purge",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        let initial = topic_snapshot(&mut connection);
        let assigned_file_name = initial.file_name.clone();
        publish_export_snapshot(&mut connection, vault.path(), &initial).unwrap();
        soft_delete_node(&mut connection, TOPIC_ID).expect("delete root");
        export_all_pending(&vault, &mut connection).expect("retire deleted root");
        assert!(!vault.path().join(&assigned_file_name).exists());
        assert_eq!(dirty_count(&connection), 0);

        empty_trash(&mut connection).expect("purge retired root later");
        export_all_pending(&vault, &mut connection)
            .expect("export purge evidence before completing removal retry");

        assert!(!vault.path().join(assigned_file_name).exists());
        assert!(fs::read_to_string(vault.path().join(TRASH_FILE_NAME))
            .unwrap()
            .contains(&format!("purged: {TOPIC_ID}")));
        assert_eq!(dirty_count(&connection), 0);
    }

    #[test]
    fn cross_topic_moves_rewrite_the_former_topic_or_retire_a_moved_root_file() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Former topic",
            HLC_1,
            false,
        );
        insert_node(
            &connection,
            CHILD_ID,
            Some(TOPIC_ID),
            1024,
            "Moved child",
            HLC_2,
            false,
        );
        insert_node(
            &connection,
            SECOND_TOPIC_ID,
            None,
            2048,
            "Destination topic",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        mark_dirty(&connection, SECOND_TOPIC_ID);
        export_all_pending(&vault, &mut connection).unwrap();
        let former_file: String = connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        let destination_file: String = connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [SECOND_TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();

        move_node(
            &mut connection,
            MoveNodeInput {
                id: CHILD_ID.to_string(),
                parent_id: Some(SECOND_TOPIC_ID.to_string()),
                after_id: None,
                before_id: None,
            },
        )
        .expect("move child between topics");
        export_all_pending(&vault, &mut connection).expect("export cross-topic child move");
        assert!(!fs::read_to_string(vault.path().join(&former_file))
            .unwrap()
            .contains("Moved child"));
        assert!(fs::read_to_string(vault.path().join(&destination_file))
            .unwrap()
            .contains("Moved child"));

        move_node(
            &mut connection,
            MoveNodeInput {
                id: TOPIC_ID.to_string(),
                parent_id: Some(SECOND_TOPIC_ID.to_string()),
                after_id: Some(CHILD_ID.to_string()),
                before_id: None,
            },
        )
        .expect("move former root into destination topic");
        export_all_pending(&vault, &mut connection).expect("export moved root retirement");
        assert!(!vault.path().join(former_file).exists());
        assert!(fs::read_to_string(vault.path().join(destination_file))
            .unwrap()
            .contains("Former topic"));
        assert_eq!(dirty_count(&connection), 0);
    }

    #[test]
    fn moving_an_unexported_root_does_not_schedule_file_removal() {
        let (_vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Unexported root",
            HLC_1,
            false,
        );
        insert_node(
            &connection,
            SECOND_TOPIC_ID,
            None,
            2048,
            "Destination",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        mark_dirty(&connection, SECOND_TOPIC_ID);

        move_node(
            &mut connection,
            MoveNodeInput {
                id: TOPIC_ID.to_string(),
                parent_id: Some(SECOND_TOPIC_ID.to_string()),
                after_id: None,
                before_id: None,
            },
        )
        .expect("move root before its first export");

        let pending = load_pending_exports(&connection).expect("load coalesced export targets");
        assert!(pending.contains_key(&ExportTarget::Topic(SECOND_TOPIC_ID.to_string())));
        assert!(!pending.contains_key(&ExportTarget::RemoveTopic(TOPIC_ID.to_string())));
    }

    #[test]
    fn moving_a_root_away_and_back_before_flush_cancels_stale_file_removal() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Round trip",
            HLC_1,
            false,
        );
        insert_node(
            &connection,
            SECOND_TOPIC_ID,
            None,
            2048,
            "Destination",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        mark_dirty(&connection, SECOND_TOPIC_ID);
        export_all_pending(&vault, &mut connection).unwrap();
        let original_file: String = connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();

        move_node(
            &mut connection,
            MoveNodeInput {
                id: TOPIC_ID.to_string(),
                parent_id: Some(SECOND_TOPIC_ID.to_string()),
                after_id: None,
                before_id: None,
            },
        )
        .unwrap();
        move_node(
            &mut connection,
            MoveNodeInput {
                id: TOPIC_ID.to_string(),
                parent_id: None,
                after_id: Some(SECOND_TOPIC_ID.to_string()),
                before_id: None,
            },
        )
        .unwrap();

        export_all_pending(&vault, &mut connection).expect("flush coalesced root round trip");
        assert!(vault.path().join(original_file).is_file());
        assert_eq!(dirty_count(&connection), 0);
    }

    #[test]
    fn loading_a_rerooted_topic_coalesces_a_stale_removal_marker() {
        let (vault, mut connection) = fixture();
        insert_node(
            &connection,
            TOPIC_ID,
            None,
            1024,
            "Rerooted topic",
            HLC_1,
            false,
        );
        insert_node(
            &connection,
            SECOND_TOPIC_ID,
            None,
            2048,
            "Destination",
            HLC_1,
            false,
        );
        mark_dirty(&connection, TOPIC_ID);
        mark_dirty(&connection, SECOND_TOPIC_ID);
        export_all_pending(&vault, &mut connection).unwrap();

        move_node(
            &mut connection,
            MoveNodeInput {
                id: TOPIC_ID.to_string(),
                parent_id: Some(SECOND_TOPIC_ID.to_string()),
                after_id: None,
                before_id: None,
            },
        )
        .unwrap();
        connection
            .execute(
                "UPDATE notes_nodes SET parent_id = NULL, hlc = ?1 WHERE id = ?2",
                params![HLC_3, TOPIC_ID],
            )
            .expect("emulate a reroot through merge or replay");

        export_all_pending(&vault, &mut connection).expect("flush rerooted topic");
        let topic_file: String = connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert!(vault.path().join(topic_file).is_file());
        assert_eq!(dirty_count(&connection), 0);
    }

    fn export_all_pending(vault: &TempDir, connection: &mut Connection) -> Result<(), String> {
        let pending = load_pending_exports(connection)?
            .into_values()
            .collect::<Vec<_>>();
        let outcome = super::publish_pending_exports(connection, vault.path(), pending.iter());
        outcome.result()
    }

    fn export_lifecycle_targets(vault: &TempDir, connection: &mut Connection) {
        let pending = load_pending_exports(connection).expect("load lifecycle exports");
        assert!(pending.contains_key(&ExportTarget::Topic(TOPIC_ID.to_string())));
        assert!(pending.contains_key(&ExportTarget::Trash));
        let topic = capture_export_snapshot(
            connection,
            pending
                .get(&ExportTarget::Topic(TOPIC_ID.to_string()))
                .unwrap(),
        )
        .expect("capture lifecycle topic");
        let trash = capture_export_snapshot(connection, pending.get(&ExportTarget::Trash).unwrap())
            .expect("capture lifecycle trash");
        publish_export_snapshot(connection, vault.path(), &topic).expect("publish lifecycle topic");
        assert_eq!(dirty_count(connection), 1);
        publish_export_snapshot(connection, vault.path(), &trash).expect("publish lifecycle trash");
    }

    fn dirty_count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn exported_hash(connection: &Connection, topic_id: &str) -> String {
        connection
            .query_row(
                "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                [topic_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn seed_shared_topic(vault_path: &str, id: &str, title: &str, sort_key: i64, hlc: &str) {
        let shared = acquire_notes_connection(vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, title, created_at, updated_at, hlc) \
                 VALUES (?1, NULL, ?2, ?3, '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', ?4)",
                params![id, sort_key, title, hlc],
            )
            .unwrap();
        connection
            .execute("INSERT INTO sync_dirty_nodes(node_id) VALUES (?1)", [id])
            .unwrap();
    }

    fn reset_shared_vault(vault_path: &str) {
        let shared = acquire_notes_connection(vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        connection.execute("DELETE FROM notes_nodes", []).unwrap();
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        connection.execute("DELETE FROM sync_topics", []).unwrap();
    }

    // B4: the write happens with the connection lock released. A merge injected
    // between the write and the hash record would deadlock (same-thread relock)
    // if the lock were still held; that it lands proves the lock-free window,
    // and the exact-match dirty clear plus echo hash still apply.
    #[test]
    fn unlocked_publish_writes_with_the_connection_lock_released_for_a_concurrent_merge() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        reset_shared_vault(&vault_path);
        seed_shared_topic(&vault_path, TOPIC_ID, "Topic A", 1024, HLC_1);
        let shared = acquire_notes_connection(&vault_path).unwrap();

        let injected = shared.clone();
        inject_after_unlocked_write_once(move || {
            let mut connection = lock_notes_connection(&injected).unwrap();
            merge_topic_doc(
                &mut connection,
                &TopicDoc {
                    id: SECOND_TOPIC_ID.to_string(),
                    sort_key: 2048,
                    max_hlc: HLC_1.to_string(),
                    root: TopicRoot {
                        marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                        format_version: TOPIC_FORMAT_VERSION,
                        title: "Merged mid-write".to_string(),
                        note: String::new(),
                        markdown_image_width: None,
                        hlc: HLC_1.to_string(),
                        starred: false,
                        completed_at: None,
                        archived_at: None,
                        root_collapsed: false,
                        root_readonly: Some(false),
                        plugin: None,
                        plugin_children: None,
                        collapsed_groups: Vec::new(),
                    },
                    nodes: Vec::new(),
                },
            )
            .expect("merge must run while the exporter write holds no lock");
        });

        let pending = {
            let connection = lock_notes_connection(&shared).unwrap();
            load_pending_exports(&connection)
                .unwrap()
                .into_values()
                .collect::<Vec<_>>()
        };
        let outcome = publish_pending_exports_unlocked(&shared, vault.path(), pending).unwrap();
        outcome.result().expect("topic A export succeeds");

        let connection = lock_notes_connection(&shared).unwrap();
        let file_a: String = connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert!(vault.path().join(file_a).is_file());
        let recorded_hash: String = connection
            .query_row(
                "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                [TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!recorded_hash.is_empty(), "echo hash recorded after write");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "captured dirty marker cleared on success"
        );
        let merged_during_write: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
                [SECOND_TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            merged_during_write,
            "a merge entered during the unlocked write window"
        );
        drop(connection);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn unlocked_first_github_publication_keeps_competitor_bytes_dirty_after_replacement() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let pending = {
            let mut connection = lock_notes_connection(&shared).unwrap();
            seed_github_notifications_root(&mut connection).expect("seed first GN export");
            load_pending_exports(&connection)
                .expect("load first GN export")
                .into_values()
                .collect::<Vec<_>>()
        };
        let canonical = vault.path().join(GITHUB_NOTIFICATIONS_FILENAME);
        let replacement = vault.path().join("github-competitor.md");
        fs::write(&replacement, b"competing GitHub notification bytes")
            .expect("stage competing canonical bytes");
        inject_after_unlocked_write_once(move || {
            fs::rename(&replacement, &canonical)
                .expect("replace first GN publication after equal held read");
        });

        let outcome = publish_pending_exports_unlocked(&shared, vault.path(), pending)
            .expect("publish batch completes with per-target failure");
        assert!(
            outcome.result().is_err(),
            "identity replacement must fail recording"
        );
        assert_eq!(
            fs::read(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME)).unwrap(),
            b"competing GitHub notification bytes",
        );
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "",
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
        );
        drop(connection);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn unlocked_github_update_refuses_a_divergent_canonical_file_and_keeps_it_dirty() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let initial = {
            let mut connection = lock_notes_connection(&shared).unwrap();
            seed_github_notifications_root(&mut connection).expect("seed GN root");
            load_pending_exports(&connection)
                .unwrap()
                .into_values()
                .collect::<Vec<_>>()
        };
        publish_pending_exports_unlocked(&shared, vault.path(), initial)
            .unwrap()
            .result()
            .expect("publish initial GN canonical file");

        let (pending, recorded_hash) = {
            let connection = lock_notes_connection(&shared).unwrap();
            let recorded_hash: String = connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get(0),
                )
                .unwrap();
            connection
                .execute(
                    "UPDATE notes_nodes SET is_collapsed = 1, hlc = '000000001-00-a3f2' WHERE id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) ON CONFLICT(node_id) DO NOTHING",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                )
                .unwrap();
            (
                load_pending_exports(&connection)
                    .unwrap()
                    .into_values()
                    .collect::<Vec<_>>(),
                recorded_hash,
            )
        };
        fs::write(
            vault.path().join(GITHUB_NOTIFICATIONS_FILENAME),
            b"corrupt external GitHub notification bytes",
        )
        .unwrap();

        let outcome = publish_pending_exports_unlocked(&shared, vault.path(), pending).unwrap();
        assert!(outcome.result().is_err(), "divergence must fail closed");
        assert_eq!(
            fs::read(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME)).unwrap(),
            b"corrupt external GitHub notification bytes",
        );
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            recorded_hash,
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
        );
        drop(connection);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn unlocked_github_update_recreates_a_deleted_canonical_file_without_resetting_ownership() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let initial = {
            let mut connection = lock_notes_connection(&shared).unwrap();
            seed_github_notifications_root(&mut connection).unwrap();
            load_pending_exports(&connection)
                .unwrap()
                .into_values()
                .collect::<Vec<_>>()
        };
        publish_pending_exports_unlocked(&shared, vault.path(), initial)
            .unwrap()
            .result()
            .unwrap();
        fs::remove_file(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME)).unwrap();
        let pending = {
            let connection = lock_notes_connection(&shared).unwrap();
            connection
                .execute(
                    "UPDATE notes_nodes SET is_collapsed = 1, hlc = '000000001-00-a3f2' WHERE id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) ON CONFLICT(node_id) DO NOTHING",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                )
                .unwrap();
            load_pending_exports(&connection)
                .unwrap()
                .into_values()
                .collect::<Vec<_>>()
        };

        publish_pending_exports_unlocked(&shared, vault.path(), pending)
            .unwrap()
            .result()
            .expect("missing canonical recovery must publish once");
        let bytes = fs::read(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME)).unwrap();
        assert!(std::str::from_utf8(&bytes)
            .unwrap()
            .contains("root_collapsed: true"));
        let connection = lock_notes_connection(&shared).unwrap();
        assert!(!connection
            .query_row(
                "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
            .is_empty());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
        );
        drop(connection);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn unlocked_github_missing_recovery_preserves_a_competitor_arriving_before_recording() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap().to_string();
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let initial = {
            let mut connection = lock_notes_connection(&shared).unwrap();
            seed_github_notifications_root(&mut connection).unwrap();
            load_pending_exports(&connection)
                .unwrap()
                .into_values()
                .collect::<Vec<_>>()
        };
        publish_pending_exports_unlocked(&shared, vault.path(), initial)
            .unwrap()
            .result()
            .unwrap();
        let recorded_hash = {
            let connection = lock_notes_connection(&shared).unwrap();
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        };
        fs::remove_file(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME)).unwrap();
        let pending = {
            let connection = lock_notes_connection(&shared).unwrap();
            connection
                .execute(
                    "UPDATE notes_nodes SET is_collapsed = 1, hlc = '000000001-00-a3f2' WHERE id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) ON CONFLICT(node_id) DO NOTHING",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                )
                .unwrap();
            load_pending_exports(&connection)
                .unwrap()
                .into_values()
                .collect::<Vec<_>>()
        };
        let canonical = vault.path().join(GITHUB_NOTIFICATIONS_FILENAME);
        let competitor = vault.path().join("github-recovery-competitor.md");
        fs::write(
            &competitor,
            b"competitor arrived during missing-file recovery",
        )
        .unwrap();
        inject_after_unlocked_write_once(move || {
            fs::rename(&competitor, &canonical).unwrap();
        });

        let outcome = publish_pending_exports_unlocked(&shared, vault.path(), pending).unwrap();
        assert!(outcome.result().is_err());
        assert_eq!(
            fs::read(vault.path().join(GITHUB_NOTIFICATIONS_FILENAME)).unwrap(),
            b"competitor arrived during missing-file recovery",
        );
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            recorded_hash,
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
        );
        drop(connection);
        evict_notes_connection(&vault_path);
    }

    // B6/rule 11: the shared quarantine helper marks a wedged target isolated
    // and leaves its dirty rows so a later un-quarantine resumes it.
    #[test]
    fn quarantine_export_target_isolates_a_wedged_topic_and_keeps_it_dirty() {
        let (vault, mut connection) = fixture();
        insert_node(&connection, TOPIC_ID, None, 1024, "Wedged", HLC_1, false);
        mark_dirty(&connection, TOPIC_ID);
        // Assign a filename first (as a real export attempt would).
        let snapshot = topic_snapshot(&mut connection);
        let _ = snapshot;

        quarantine_export_target(
            &connection,
            &ExportTarget::Topic(TOPIC_ID.to_string()),
            "self-validation failed three times",
        )
        .expect("quarantine wedged topic");

        assert_eq!(
            connection
                .query_row(
                    "SELECT quarantined FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        // The wedge is visible via skipped pending exports, dirty row retained.
        assert!(!load_pending_exports(&connection)
            .unwrap()
            .contains_key(&ExportTarget::Topic(TOPIC_ID.to_string())));
        assert_eq!(dirty_count(&connection), 1);

        // Un-quarantine resumes it.
        connection
            .execute(
                "UPDATE sync_topics SET quarantined = 0 WHERE topic_id = ?1",
                [TOPIC_ID],
            )
            .unwrap();
        let resumed = topic_snapshot(&mut connection);
        publish_export_snapshot(&mut connection, vault.path(), &resumed)
            .expect("resumed export after un-quarantine");
        assert_eq!(dirty_count(&connection), 0);
    }
}
