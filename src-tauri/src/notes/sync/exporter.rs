use crate::notes::export::normalize_newlines;
use crate::notes::markdown_import::MAX_MARKDOWN_BYTES;
use crate::notes::repository::SORT_KEY_STEP;
use crate::notes::schema::SYNC_REMOVE_TOPIC_PREFIX;
use crate::notes::sync::topic_file::{
    derive_topic_filename, render_topic_file, PurgedTombstone, TopicAttachment, TopicContent,
    TopicDoc, TopicFile, TopicNode, TopicRoot, TrashDoc,
};
use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
use cap_std::fs::Dir;
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
    node_kind: String,
    starred: bool,
    completed_at: Option<String>,
    archived_at: Option<String>,
    deleted_batch_id: Option<String>,
    hlc: String,
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
    Ok(ExportSnapshot {
        target: pending.target.clone(),
        file_name,
        document,
        dirty: pending.dirty.clone(),
    })
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

enum ExportWriter<'a> {
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
                capture_export_snapshot(connection, pending).and_then(|snapshot| {
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
                outcome.errors.push(match retry_error {
                    Some(retry_error) => {
                        format!("{:?}: {error}; {retry_error}", pending.target)
                    }
                    None => format!("{:?}: {error}", pending.target),
                });
            }
        }
    }
    outcome
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
    let source_path = vault_path.join(&prepared.file_name);
    match fs::read(&source_path) {
        Ok(bytes)
            if prepared.exported_hash.is_empty()
                || sha256_hex(&bytes) != prepared.exported_hash =>
        {
            return Err(format!(
                "Removed Notes topic source {} changed since its last export.",
                prepared.file_name
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not verify removed Notes topic source {}: {error}",
                prepared.file_name
            ));
        }
    }
    let removed = remove(&source_path)?;
    record_topic_removal(connection, pending, &prepared.topic_id)?;
    Ok(removed)
}

struct PreparedTopicRemoval {
    topic_id: String,
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

    let (file_name, exported_hash, quarantined): (String, String, bool) = connection
        .query_row(
            "SELECT file_name, exported_hash, quarantined FROM sync_topics WHERE topic_id = ?1",
            [topic_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Could not load removed Notes topic metadata: {error}"))?;
    if quarantined {
        return Err(format!(
            "Removed Notes topic source {file_name} is quarantined."
        ));
    }
    Ok(PreparedTopicRemoval {
        topic_id: topic_id.clone(),
        file_name,
        exported_hash,
    })
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
    if parsed != snapshot.document {
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
    let file_name = Path::new(&prepared.file_name);
    let source = read_topic_file_in_guarded_vault(vault, file_name)?;
    if source.as_ref().is_some_and(|(bytes, _)| {
        prepared.exported_hash.is_empty() || sha256_hex(bytes) != prepared.exported_hash
    }) {
        return Err(format!(
            "Removed Notes topic source {} changed since its last export.",
            prepared.file_name
        ));
    }
    let held = source.map(|(_, held)| held);
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
                    node.image_offset_utf16, node.node_kind, node.is_starred, \
                    node.completed_at, node.archived_at, node.deleted_batch_id, node.hlc \
             FROM notes_nodes node JOIN subtree ON subtree.id = node.id \
             ORDER BY node.id",
        )
        .map_err(|error| format!("Could not prepare a Notes topic export: {error}"))?;
    let rows = statement
        .query_map([topic_id], stored_node_from_row)
        .map_err(|error| format!("Could not load a Notes topic export: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read a Notes topic export: {error}"))?;
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
            "SELECT id, parent_id, sort_key, title, note, image_offset_utf16, node_kind, \
                    is_starred, completed_at, archived_at, deleted_batch_id, hlc \
             FROM notes_nodes WHERE deleted_at IS NOT NULL ORDER BY id",
        )
        .map_err(|error| format!("Could not prepare the Notes trash export: {error}"))?;
    let rows = statement
        .query_map([], stored_node_from_row)
        .map_err(|error| format!("Could not load the Notes trash export: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Notes trash export: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|node| (node.id.clone(), node))
        .collect())
}

fn stored_node_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredNode> {
    Ok(StoredNode {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        sort_key: row.get(2)?,
        title: row.get(3)?,
        note: row.get(4)?,
        image_offset_utf16: row.get(5)?,
        node_kind: row.get(6)?,
        starred: row.get::<_, i64>(7)? != 0,
        completed_at: row.get(8)?,
        archived_at: row.get(9)?,
        deleted_batch_id: row.get(10)?,
        hlc: row.get(11)?,
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
    Ok(TopicDoc {
        id: root.id,
        sort_key: root.sort_key,
        max_hlc,
        root: TopicRoot {
            title: normalize_newlines(&root.title),
            hlc: root.hlc,
            starred: root.starred,
            completed_at: root.completed_at,
            archived_at: root.archived_at,
        },
        nodes: built,
    })
}

fn build_trash_doc(connection: &Connection) -> Result<TrashDoc, String> {
    let nodes = load_trash_nodes(connection)?;
    let ids = nodes.keys().cloned().collect::<BTreeSet<_>>();
    let mut root_ids = nodes
        .values()
        .filter(|node| {
            node.parent_id.as_ref().is_none_or(|parent| {
                !ids.contains(parent) || nodes[parent].deleted_batch_id != node.deleted_batch_id
            })
        })
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
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
        .map_err(|error| format!("Could not prepare Notes purge evidence: {error}"))?;
    let purged = statement
        .query_map([], |row| {
            Ok(PurgedTombstone {
                id: row.get(0)?,
                hlc: row.get(1)?,
            })
        })
        .map_err(|error| format!("Could not load Notes purge evidence: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes purge evidence: {error}"))?;
    let max_hlc = nodes
        .values()
        .map(|node| node.hlc.as_str())
        .chain(purged.iter().map(|tombstone| tombstone.hlc.as_str()))
        .max()
        .unwrap_or_default()
        .to_string();
    Ok(TrashDoc {
        max_hlc,
        purged,
        nodes: built,
    })
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
    Ok(TopicNode {
        id: Some(node.id.clone()),
        hlc: node.hlc.clone(),
        starred: node.starred,
        completed: node.completed_at.is_some(),
        content,
        note: normalize_newlines(&node.note),
        from: trash_root
            .then(|| node.parent_id.clone().map(|parent| (parent, node.sort_key)))
            .flatten(),
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
    let bytes = render(&snapshot.document)?;
    let parsed = match parse_topic_file(&bytes) {
        TopicParseOutcome::Parsed(document) => document,
        TopicParseOutcome::Quarantined(_) => {
            return Err("Rendered Notes sync bytes failed self-validation.".to_string())
        }
    };
    if parsed != snapshot.document {
        return Err(
            "Rendered Notes sync bytes changed semantic state during self-validation.".to_string(),
        );
    }
    write(&vault_path.join(&snapshot.file_name), &bytes)?;
    let hash = sha256_hex(&bytes);
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
        capture_export_snapshot, load_pending_exports, publish_export_snapshot,
        publish_export_snapshot_with, publish_topic_removal, publish_topic_removal_with,
        DebounceSchedule, ExportTarget, TRASH_FILE_NAME, TRASH_TOPIC_ID,
    };
    use crate::notes::repository::{
        connect_notes_db, empty_trash, move_node, restore_node, soft_delete_node,
    };
    use crate::notes::sync::merger::merge_trash_doc;
    use crate::notes::sync::topic_file::{render_topic_file, TopicFile};
    use crate::notes::types::MoveNodeInput;
    use rusqlite::{params, Connection};
    use std::cell::Cell;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;
    use std::time::Duration;
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
}
