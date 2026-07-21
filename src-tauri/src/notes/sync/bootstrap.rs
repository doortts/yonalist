use crate::file_io::{
    hold_capability_regular_file_bounded_nofollow, read_regular_file_bounded_nofollow,
    rename_noreplace, write_atomic_file_in_guarded_parent,
};
use crate::notes::connection::{
    acquire_notes_connection, lock_notes_connection, validate_notes_connection,
};
use crate::notes::markdown_import::MAX_MARKDOWN_BYTES;
use crate::notes::repository::notes_db_path;
use crate::notes::sync::exporter::{
    ensure_trash_metadata, load_all_exports, load_pending_exports, publish_pending_exports,
    render_canonical_sync_bytes, sha256_hex, ExportBatchOutcome, TRASH_FILE_NAME, TRASH_TOPIC_ID,
};
use crate::notes::sync::merger::{
    merge_topic_doc_with_cleanup, merge_trash_doc_with_hash, MergeCleanupIntent,
};
use crate::notes::sync::topic_file::TopicFile;
use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
use crate::notes::sync::{
    current_purge_evidence_millis, prune_expired_purged_tombstones, purged_tombstone_is_expired_at,
};
use cap_std::{ambient_authority, fs::Dir};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const QUARANTINE_TOPIC_PREFIX: &str = "__yonalist_quarantine__:";
const CLEANUP_TOPIC_PREFIX: &str = "__yonalist_cleanup__:";

#[cfg(test)]
thread_local! {
    static STARTUP_AFTER_ENTRY_INSPECT_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(&Path)>>> =
        const { std::cell::RefCell::new(None) };
    static STARTUP_BEFORE_RANK_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static TRUNCATED_RECOVERY_BEFORE_PUBLICATION_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        const { std::cell::RefCell::new(None) };
    static TRUNCATED_RECOVERY_AFTER_ISOLATION_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
struct StartupReadHookReset;

#[cfg(test)]
impl Drop for StartupReadHookReset {
    fn drop(&mut self) {
        STARTUP_AFTER_ENTRY_INSPECT_HOOK.with(|hook| hook.borrow_mut().take());
        STARTUP_BEFORE_RANK_HOOK.with(|hook| hook.borrow_mut().take());
        TRUNCATED_RECOVERY_BEFORE_PUBLICATION_HOOK.with(|hook| hook.borrow_mut().take());
        TRUNCATED_RECOVERY_AFTER_ISOLATION_HOOK.with(|hook| hook.borrow_mut().take());
    }
}

#[cfg(test)]
fn inject_startup_after_entry_inspect_hook(action: impl FnMut(&Path) + 'static) {
    STARTUP_AFTER_ENTRY_INSPECT_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn inject_startup_before_rank_hook(action: impl FnOnce() + 'static) {
    STARTUP_BEFORE_RANK_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn inject_truncated_recovery_before_publication_hook(action: impl FnOnce(&Path) + 'static) {
    TRUNCATED_RECOVERY_BEFORE_PUBLICATION_HOOK
        .with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn inject_truncated_recovery_after_isolation_hook(action: impl FnOnce() + 'static) {
    TRUNCATED_RECOVERY_AFTER_ISOLATION_HOOK
        .with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_startup_after_entry_inspect(path: &Path) {
    STARTUP_AFTER_ENTRY_INSPECT_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().as_mut() {
            action(path);
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_startup_after_entry_inspect(_path: &Path) {}

#[cfg(test)]
fn maybe_inject_startup_before_rank() {
    STARTUP_BEFORE_RANK_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn maybe_inject_truncated_recovery_before_publication(path: &Path) {
    TRUNCATED_RECOVERY_BEFORE_PUBLICATION_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action(path);
        }
    });
}

#[cfg(test)]
fn maybe_inject_truncated_recovery_after_isolation() {
    TRUNCATED_RECOVERY_AFTER_ISOLATION_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_truncated_recovery_before_publication(_path: &Path) {}

#[cfg(not(test))]
fn maybe_inject_truncated_recovery_after_isolation() {}

#[cfg(not(test))]
fn maybe_inject_startup_before_rank() {}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct BootstrapReport {
    pub(crate) merged_files: usize,
    pub(crate) skipped_files: usize,
    pub(crate) exported_files: usize,
    pub(crate) errors: Vec<String>,
    pub(crate) last_export_at: Option<String>,
    pub(crate) last_merge_at: Option<String>,
    pub(crate) changed_topic_ids: BTreeSet<String>,
    pub(crate) pending_cleanup: BTreeMap<PathBuf, String>,
    pub(crate) retry_paths: BTreeSet<PathBuf>,
    pub(crate) status_changed: bool,
}

impl BootstrapReport {
    fn record_error(&mut self, error: String) {
        if !self.errors.contains(&error) {
            self.errors.push(error);
        }
    }

    fn record_export_outcome(&mut self, outcome: &ExportBatchOutcome) {
        self.exported_files += outcome.exported;
        for error in outcome.errors() {
            self.record_error(error.clone());
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ReconcileFileOutcome {
    pub(crate) merged: bool,
    pub(crate) sqlite_changed: bool,
    pub(crate) topic_id: Option<String>,
    pub(crate) assigned_file_name: Option<String>,
    pub(crate) source_hash: Option<String>,
    pub(crate) cleanup_pending: bool,
}

#[derive(Debug)]
struct StartupMarkdownFile {
    path: PathBuf,
    bytes: Result<Vec<u8>, String>,
}

pub(crate) fn reconcile_startup(vault_path: &str) -> Result<BootstrapReport, String> {
    #[cfg(test)]
    let _startup_read_hook_reset = StartupReadHookReset;

    let database_existed = notes_db_path(vault_path)
        .try_exists()
        .map_err(|error| format!("Could not inspect Notes sync storage: {error}"))?;
    let vault_root = crate::expand_vault_path(vault_path);
    let markdown_files = root_markdown_files(&vault_root)?;
    let has_topic_file = has_parseable_topic_file(&markdown_files);
    let shared = acquire_notes_connection(vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;
    prune_expired_purged_tombstones(&connection)?;

    if !database_existed && !markdown_files.is_empty() {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Could not start Notes file bootstrap reset: {error}"))?;
        transaction
            .execute("DELETE FROM notes_nodes", [])
            .map_err(|error| format!("Could not remove fresh Notes onboarding rows: {error}"))?;
        transaction
            .execute("DELETE FROM sync_dirty_nodes", [])
            .map_err(|error| format!("Could not clear fresh Notes bootstrap dirtiness: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Could not finish Notes file bootstrap reset: {error}"))?;
    }

    let node_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
        .map_err(|error| format!("Could not inspect Notes startup rows: {error}"))?;
    let mut report = BootstrapReport::default();
    if database_existed && !has_topic_file && node_count > 0 {
        let has_trash_file = markdown_files.iter().any(|source| {
            source.path.file_name().and_then(|name| name.to_str()) == Some(TRASH_FILE_NAME)
        });
        reconcile_files(&mut connection, &markdown_files, &mut report)?;
        let pending = load_all_exports(&connection, !has_trash_file)?;
        let outcome = publish_pending_exports(&mut connection, &vault_root, pending.iter());
        report.record_export_outcome(&outcome);
    } else {
        reconcile_files(&mut connection, &markdown_files, &mut report)?;
    }
    reconcile_pending_cleanup_intents(&connection, &vault_root, &mut report)?;

    let outcome = flush_pending_outcome(&mut connection, &vault_root)?;
    report.record_export_outcome(&outcome);
    if report.merged_files != 0 {
        report.last_merge_at = Some(current_timestamp(&connection)?);
    }
    if report.exported_files != 0 {
        report.last_export_at = Some(current_timestamp(&connection)?);
    }
    validate_notes_connection(&connection)?;
    Ok(report)
}

fn reconcile_pending_cleanup_intents(
    connection: &Connection,
    vault_root: &Path,
    report: &mut BootstrapReport,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT file_name, exported_hash FROM sync_topics \
             WHERE topic_id LIKE ?1 ORDER BY file_name",
        )
        .map_err(|error| format!("Could not prepare Notes cleanup recovery: {error}"))?;
    let intents = statement
        .query_map([format!("{CLEANUP_TOPIC_PREFIX}%")], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not load Notes cleanup recovery: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes cleanup recovery: {error}"))?;
    drop(statement);
    for (file_name, source_hash) in intents {
        let path = vault_root.join(&file_name);
        let staging_path = cleanup_staging_path(&path)?;
        let staging_exists = match fs::symlink_metadata(&staging_path) {
            Ok(_) => true,
            Err(error) if error.kind() == ErrorKind::NotFound => false,
            Err(_) => true,
        };
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                report
                    .pending_cleanup
                    .insert(normalize_cleanup_path(&path), source_hash);
            }
            Err(error) if error.kind() == ErrorKind::NotFound && !staging_exists => {
                clear_virtual_quarantine(connection, &file_name)?;
                report.status_changed = true;
            }
            Err(_) => {
                report
                    .pending_cleanup
                    .insert(normalize_cleanup_path(&path), source_hash);
            }
        }
    }
    Ok(())
}

pub(crate) fn cleanup_staging_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "A Notes cleanup path must have a vault parent.".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "A Notes cleanup filename must be UTF-8.".to_string())?;
    let digest = Sha256::digest(file_name.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(parent
        .join(".yonalist/sync-cleanup")
        .join(format!("{digest}.pending")))
}

fn normalize_cleanup_path(path: &Path) -> PathBuf {
    path.parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .and_then(|parent| path.file_name().map(|file_name| parent.join(file_name)))
        .unwrap_or_else(|| path.to_path_buf())
}

pub(crate) fn flush_pending(
    connection: &mut Connection,
    vault_root: &Path,
) -> Result<usize, String> {
    let outcome = flush_pending_outcome(connection, vault_root)?;
    outcome.result()?;
    Ok(outcome.exported)
}

fn flush_pending_outcome(
    connection: &mut Connection,
    vault_root: &Path,
) -> Result<ExportBatchOutcome, String> {
    let pending = load_pending_exports(connection)?
        .into_values()
        .collect::<Vec<_>>();
    Ok(publish_pending_exports(
        connection,
        vault_root,
        pending.iter(),
    ))
}

fn has_parseable_topic_file(markdown_files: &[StartupMarkdownFile]) -> bool {
    for source in markdown_files {
        if source.path.file_name().and_then(|name| name.to_str()) == Some(TRASH_FILE_NAME) {
            continue;
        }
        let Ok(bytes) = source.bytes.as_deref() else {
            continue;
        };
        if matches!(
            parse_topic_file(&bytes),
            TopicParseOutcome::Parsed(TopicFile::Topic(_))
        ) {
            return true;
        }
    }
    false
}

fn root_markdown_files(vault_root: &Path) -> Result<Vec<StartupMarkdownFile>, String> {
    let entries = match fs::read_dir(vault_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not inspect Notes vault files: {error}")),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not read a Notes vault entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("md")
            && entry
                .file_type()
                .map_err(|error| format!("Could not inspect a Notes vault entry: {error}"))?
                .is_file()
        {
            maybe_inject_startup_after_entry_inspect(&path);
            let bytes = read_regular_file_bounded_nofollow(&path, MAX_MARKDOWN_BYTES)
                .map_err(|error| format!("Could not securely read Notes startup file: {error}"));
            files.push(StartupMarkdownFile { path, bytes });
        }
    }
    files.sort_by(|left, right| left.path.file_name().cmp(&right.path.file_name()));
    Ok(files)
}

fn reconcile_files(
    connection: &mut Connection,
    sources: &[StartupMarkdownFile],
    report: &mut BootstrapReport,
) -> Result<(), String> {
    maybe_inject_startup_before_rank();
    let mut ordered_sources = sources.iter().collect::<Vec<_>>();
    ordered_sources.sort_by(|left, right| {
        canonical_source_rank(left)
            .cmp(&canonical_source_rank(right))
            .then_with(|| left.path.file_name().cmp(&right.path.file_name()))
    });
    for source in ordered_sources {
        let reconcile = source
            .bytes
            .as_deref()
            .map_err(Clone::clone)
            .and_then(|bytes| reconcile_file_bytes(connection, &source.path, bytes, report));
        if let Err(error) = reconcile {
            report
                .retry_paths
                .insert(normalize_source_path(&source.path));
            let Some(file_name) = source.path.file_name().and_then(|name| name.to_str()) else {
                report.record_error(error);
                continue;
            };
            record_quarantine(connection, file_name)?;
            report.status_changed = true;
            report.record_error(format!("{file_name}: {error}"));
        }
    }
    Ok(())
}

fn canonical_source_rank(source: &StartupMarkdownFile) -> u8 {
    let Some(file_name) = source.path.file_name().and_then(|name| name.to_str()) else {
        return 1;
    };
    if file_name == TRASH_FILE_NAME {
        return 0;
    }
    let Ok(bytes) = source.bytes.as_deref() else {
        return 1;
    };
    let TopicParseOutcome::Parsed(TopicFile::Topic(document)) = parse_topic_file(&bytes) else {
        return 1;
    };
    let Some(topic_prefix) = document.id.get(..8) else {
        return 1;
    };
    file_name
        .ends_with(&format!(".{topic_prefix}.md"))
        .then_some(0)
        .unwrap_or(1)
}

pub(crate) fn reconcile_file_bytes(
    connection: &mut Connection,
    source: &Path,
    bytes: &[u8],
    report: &mut BootstrapReport,
) -> Result<ReconcileFileOutcome, String> {
    reconcile_file_bytes_inner(connection, source, bytes, report, false)
}

pub(crate) fn reconcile_staged_file_bytes(
    connection: &mut Connection,
    source: &Path,
    bytes: &[u8],
    report: &mut BootstrapReport,
) -> Result<ReconcileFileOutcome, String> {
    reconcile_file_bytes_inner(connection, source, bytes, report, true)
}

fn reconcile_file_bytes_inner(
    connection: &mut Connection,
    source: &Path,
    bytes: &[u8],
    report: &mut BootstrapReport,
    staged_cleanup: bool,
) -> Result<ReconcileFileOutcome, String> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "A Notes sync filename must be UTF-8.".to_string())?;
    let hash = sha256_hex(&bytes);
    let stored = connection
        .query_row(
            "SELECT topic_id, exported_hash, quarantined FROM sync_topics WHERE file_name = ?1",
            [file_name],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not inspect a Notes sync file hash: {error}"))?;
    if let Some((topic_id, stored_hash, _)) = &stored {
        if topic_id.starts_with(CLEANUP_TOPIC_PREFIX) && !staged_cleanup {
            let staging_exists = match fs::symlink_metadata(cleanup_staging_path(source)?) {
                Ok(_) => true,
                Err(error) if error.kind() == ErrorKind::NotFound => false,
                Err(_) => true,
            };
            if staging_exists {
                report
                    .pending_cleanup
                    .insert(normalize_source_path(source), stored_hash.clone());
                return Ok(ReconcileFileOutcome {
                    source_hash: Some(stored_hash.clone()),
                    cleanup_pending: true,
                    ..ReconcileFileOutcome::default()
                });
            }
            if stored_hash == &hash {
                report
                    .pending_cleanup
                    .insert(normalize_source_path(source), hash.clone());
                return Ok(ReconcileFileOutcome {
                    source_hash: Some(hash),
                    cleanup_pending: true,
                    ..ReconcileFileOutcome::default()
                });
            }
            clear_virtual_quarantine(connection, file_name)?;
            report.status_changed = true;
        }
    }
    if stored
        .as_ref()
        .is_some_and(|(_, stored_hash, quarantined)| !quarantined && stored_hash == &hash)
    {
        report.skipped_files += 1;
        return Ok(ReconcileFileOutcome {
            source_hash: Some(hash),
            ..ReconcileFileOutcome::default()
        });
    }
    let was_quarantined = stored
        .as_ref()
        .is_some_and(|(_, _, quarantined)| *quarantined);

    if !staged_cleanup {
        if let Some((topic_id, canonical)) =
            verified_truncated_export_canonical(connection, bytes, &stored)
        {
            let recovery = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    format!("Could not start truncated Notes file recovery: {error}")
                })?;
            recovery
                .execute(
                    "UPDATE sync_topics SET quarantined = 0 WHERE topic_id = ?1",
                    [&topic_id],
                )
                .map_err(|error| {
                    format!("Could not prepare truncated Notes file recovery: {error}")
                })?;
            recovery
                .execute(
                    "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                     ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                    [&topic_id],
                )
                .map_err(|error| {
                    format!("Could not schedule truncated Notes file recovery: {error}")
                })?;
            recovery.commit().map_err(|error| {
                format!("Could not commit truncated Notes file recovery: {error}")
            })?;
            if recover_verified_truncated_export(source, bytes, &canonical)? {
                record_quarantine(connection, file_name)?;
                report.record_error(format!(
                    "{file_name}: a truncated Notes sync file was isolated and recovered from its last synchronized export."
                ));
                report.exported_files += 1;
                report.status_changed = true;
                report.retry_paths.insert(normalize_source_path(source));
            } else {
                record_quarantine(connection, file_name)?;
                report.status_changed |= !was_quarantined;
                report.record_error(format!(
                    "{file_name}: a truncated Notes sync file changed during recovery and was left quarantined without overwriting the newer bytes."
                ));
                report.retry_paths.insert(normalize_source_path(source));
            }
            return Ok(ReconcileFileOutcome::default());
        }
    }

    let document = match parse_topic_file(&bytes) {
        TopicParseOutcome::Parsed(document) => document,
        TopicParseOutcome::Quarantined(quarantine) => {
            if staged_cleanup {
                report.record_error(format!(
                    "{file_name}: staged Notes replacement was quarantined: {:?}",
                    quarantine.error
                ));
                return Ok(ReconcileFileOutcome::default());
            }
            record_quarantine(connection, file_name)?;
            report.status_changed |= !was_quarantined;
            report.record_error(format!(
                "{file_name}: Notes sync file was quarantined: {:?}",
                quarantine.error
            ));
            return Ok(ReconcileFileOutcome::default());
        }
    };
    if file_name == TRASH_FILE_NAME && matches!(document, TopicFile::Topic(_)) {
        record_quarantine(connection, file_name)?;
        report.status_changed |= !was_quarantined;
        report.record_error(format!(
            "{file_name}: a Notes topic cannot use the reserved trash filename."
        ));
        return Ok(ReconcileFileOutcome::default());
    }
    if !staged_cleanup {
        clear_virtual_quarantine(connection, file_name)?;
    }
    report.status_changed |= was_quarantined;
    let (sqlite_changed, topic_id, assigned_file_name, cleanup_pending) = match document {
        TopicFile::Topic(document) => {
            let assigned_file_name =
                seed_source_filename(connection, &document.id, source, staged_cleanup)?;
            let cleanup_pending = assigned_file_name != file_name;
            let cleanup_marker = cleanup_pending.then(|| cleanup_topic_id(file_name));
            let cleanup = cleanup_marker
                .as_deref()
                .map(|marker_topic_id| MergeCleanupIntent {
                    marker_topic_id,
                    file_name,
                    source_hash: &hash,
                });
            let synchronized_hash = (assigned_file_name == file_name).then_some(hash.as_str());
            let merge =
                merge_topic_doc_with_cleanup(connection, &document, cleanup, synchronized_hash)
                    .map_err(|error| error.to_string())?;
            if cleanup_pending {
                report.status_changed = true;
            }
            (
                merge.applied != 0,
                document.id,
                Some(assigned_file_name),
                cleanup_pending,
            )
        }
        TopicFile::Trash(mut document) => {
            if file_name != TRASH_FILE_NAME {
                return Err("A Notes trash document must be named trash.md.".to_string());
            }
            ensure_trash_metadata(connection)?;
            let now_millis = current_purge_evidence_millis()?;
            let purge_count = document.purged.len();
            document
                .purged
                .retain(|tombstone| !purged_tombstone_is_expired_at(&tombstone.hlc, now_millis));
            let expired_purge_evidence_removed = document.purged.len() != purge_count;
            let synchronized_hash = (!expired_purge_evidence_removed).then_some(hash.as_str());
            let merge = merge_trash_doc_with_hash(connection, &document, synchronized_hash)
                .map_err(|error| error.to_string())?;
            if expired_purge_evidence_removed {
                connection
                    .execute(
                        "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                         ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                        [TRASH_TOPIC_ID],
                    )
                    .map_err(|error| {
                        format!("Could not schedule expired Notes purge-evidence rewrite: {error}")
                    })?;
            }
            (
                merge.applied != 0,
                TRASH_TOPIC_ID.to_string(),
                Some(file_name.to_string()),
                false,
            )
        }
    };
    report.merged_files += 1;
    if sqlite_changed {
        report.changed_topic_ids.insert(topic_id.clone());
    }
    if cleanup_pending {
        report
            .pending_cleanup
            .insert(normalize_source_path(source), hash.clone());
    }
    Ok(ReconcileFileOutcome {
        merged: true,
        sqlite_changed,
        topic_id: Some(topic_id),
        assigned_file_name,
        source_hash: Some(hash),
        cleanup_pending,
    })
}

fn verified_truncated_export_canonical(
    connection: &Connection,
    bytes: &[u8],
    stored: &Option<(String, String, bool)>,
) -> Option<(String, Vec<u8>)> {
    let Some((topic_id, exported_hash, _)) = stored else {
        return None;
    };
    if exported_hash.is_empty()
        || topic_id.starts_with(QUARANTINE_TOPIC_PREFIX)
        || topic_id.starts_with(CLEANUP_TOPIC_PREFIX)
    {
        return None;
    }
    let canonical = match render_canonical_sync_bytes(connection, topic_id) {
        Ok(canonical) => canonical,
        Err(_) => return None,
    };
    if bytes.len() >= canonical.len()
        || !canonical.starts_with(bytes)
        || sha256_hex(&canonical) != *exported_hash
    {
        return None;
    }
    Some((topic_id.clone(), canonical))
}

fn read_held_truncated_recovery_bytes(
    held: &crate::file_io::HeldBoundedCapabilityFile,
) -> Result<Vec<u8>, String> {
    let mut reader = held
        .reader_from_start()
        .map_err(|error| format!("Could not reopen a held truncated Notes file: {error}"))?;
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not reread a held truncated Notes file: {error}"))?;
    Ok(bytes)
}

fn restore_isolated_truncated_recovery(
    parent: &Dir,
    recovery_name: &Path,
    source_name: &Path,
) -> Result<(), String> {
    rename_noreplace(parent, recovery_name, parent, source_name).map_err(|error| {
        format!(
            "Could not restore a displaced Notes file; it remains preserved as {}: {error}",
            recovery_name.display()
        )
    })
}

fn recover_verified_truncated_export(
    source: &Path,
    truncated_bytes: &[u8],
    canonical: &[u8],
) -> Result<bool, String> {
    let parent_path = source
        .parent()
        .ok_or_else(|| "A Notes recovery file must have a parent directory.".to_string())?;
    let source_name = source
        .file_name()
        .map(Path::new)
        .ok_or_else(|| "A Notes recovery file must have a filename.".to_string())?;
    let parent = Dir::open_ambient_dir(parent_path, ambient_authority())
        .map_err(|error| format!("Could not hold the Notes recovery directory: {error}"))?;
    let held = match hold_capability_regular_file_bounded_nofollow(
        &parent,
        source_name,
        u64::try_from(MAX_MARKDOWN_BYTES).expect("Markdown byte limit fits u64"),
    ) {
        Ok(held) => held,
        Err(_) => return Ok(false),
    };
    if read_held_truncated_recovery_bytes(&held)? != truncated_bytes {
        return Ok(false);
    }

    maybe_inject_truncated_recovery_before_publication(source);

    let recovery_name = loop {
        let candidate = format!(".yonalist-truncated-recovery-{}", Uuid::new_v4());
        match rename_noreplace(&parent, source_name, &parent, Path::new(&candidate)) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(_) => return Ok(false),
        }
    };
    let recovery_path = Path::new(&recovery_name);
    maybe_inject_truncated_recovery_after_isolation();
    let isolated_bytes_are_original = held.verify_at(&parent, recovery_path).is_ok()
        && read_held_truncated_recovery_bytes(&held)? == truncated_bytes;
    if !isolated_bytes_are_original {
        restore_isolated_truncated_recovery(&parent, recovery_path, source_name)?;
        return Ok(false);
    }

    let publication = write_atomic_file_in_guarded_parent(
        &parent,
        source_name,
        canonical,
        false,
        || {
            held.verify_at(&parent, recovery_path).map_err(|error| {
                format!("The isolated truncated Notes file identity changed: {error}")
            })?;
            if read_held_truncated_recovery_bytes(&held)? != truncated_bytes {
                return Err(
                    "The isolated truncated Notes file changed during recovery.".to_string()
                );
            }
            Ok(())
        },
        || {},
    );
    if let Err(error) = publication {
        let restoration = restore_isolated_truncated_recovery(&parent, recovery_path, source_name);
        return match restoration {
            Ok(()) => Err(format!(
                "Could not publish the recovered Notes file: {error}"
            )),
            Err(restoration_error) => Err(format!(
                "Could not publish the recovered Notes file: {error}; {restoration_error}"
            )),
        };
    }

    // Keep the displaced file under a hidden, non-Markdown name. A cooperative
    // cloud provider may still hold that inode and write to it after publication;
    // retaining it prevents those bytes from being silently destroyed.
    Ok(true)
}

fn seed_source_filename(
    connection: &Connection,
    topic_id: &str,
    source: &Path,
    allow_cleanup_owner: bool,
) -> Result<String, String> {
    let source_file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "A Notes sync filename must be UTF-8.".to_string())?;
    let existing = connection
        .query_row(
            "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
            [topic_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect a Notes topic filename: {error}"))?;
    let owner = connection
        .query_row(
            "SELECT topic_id FROM sync_topics WHERE file_name = ?1",
            [source_file_name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect Notes filename ownership: {error}"))?;
    if let Some(owner) = owner.as_deref() {
        if owner != topic_id && !(allow_cleanup_owner && owner.starts_with(CLEANUP_TOPIC_PREFIX)) {
            return Err(format!(
                "Notes sync filename {source_file_name} is already assigned to {owner}."
            ));
        }
    }
    if let Some(existing) = existing {
        return Ok(existing);
    }
    if !is_canonical_topic_filename(source_file_name, topic_id) {
        if let Some(candidate) = unresolved_canonical_candidate(connection, source, topic_id)? {
            return Err(format!(
                "Notes bounced copy {source_file_name} is waiting for canonical source {candidate}."
            ));
        }
    }
    connection
        .execute(
            "INSERT INTO sync_topics(topic_id, file_name) VALUES (?1, ?2)",
            params![topic_id, source_file_name],
        )
        .map_err(|error| format!("Could not seed a Notes source filename: {error}"))?;
    Ok(source_file_name.to_string())
}

fn is_canonical_topic_filename(file_name: &str, topic_id: &str) -> bool {
    topic_id
        .get(..8)
        .is_some_and(|prefix| file_name.ends_with(&format!(".{prefix}.md")))
}

fn unresolved_canonical_candidate(
    connection: &Connection,
    source: &Path,
    topic_id: &str,
) -> Result<Option<String>, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "A Notes sync source must have a vault parent.".to_string())?;
    let mut candidates = fs::read_dir(parent)
        .map_err(|error| format!("Could not inspect canonical Notes sources: {error}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let is_file = entry.file_type().ok()?.is_file();
            let file_name = entry.file_name().into_string().ok()?;
            (is_file
                && file_name != source.file_name()?.to_str()?
                && is_canonical_topic_filename(&file_name, topic_id))
            .then_some(file_name)
        })
        .collect::<Vec<_>>();
    candidates.sort();
    for candidate in candidates {
        let owner = connection
            .query_row(
                "SELECT topic_id FROM sync_topics WHERE file_name = ?1",
                [&candidate],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Could not inspect a canonical Notes source: {error}"))?;
        if owner.as_deref().is_none_or(|owner| {
            owner.starts_with(QUARANTINE_TOPIC_PREFIX) || owner.starts_with(CLEANUP_TOPIC_PREFIX)
        }) {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn quarantine_topic_id(file_name: &str) -> String {
    let digest = Sha256::digest(file_name.as_bytes());
    format!(
        "{QUARANTINE_TOPIC_PREFIX}{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn cleanup_topic_id(file_name: &str) -> String {
    let digest = Sha256::digest(file_name.as_bytes());
    format!(
        "{CLEANUP_TOPIC_PREFIX}{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn normalize_source_path(source: &Path) -> PathBuf {
    source
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .and_then(|parent| source.file_name().map(|file_name| parent.join(file_name)))
        .unwrap_or_else(|| source.to_path_buf())
}

pub(crate) fn record_quarantine(connection: &Connection, file_name: &str) -> Result<(), String> {
    if file_name == TRASH_FILE_NAME {
        ensure_trash_metadata(connection)?;
        connection
            .execute(
                "UPDATE sync_topics SET quarantined = 1 WHERE topic_id = ?1",
                [TRASH_TOPIC_ID],
            )
            .map_err(|error| format!("Could not quarantine the Notes trash file: {error}"))?;
        return Ok(());
    }
    if connection
        .execute(
            "UPDATE sync_topics SET quarantined = 1 WHERE file_name = ?1",
            [file_name],
        )
        .map_err(|error| format!("Could not mark a Notes file quarantined: {error}"))?
        != 0
    {
        return Ok(());
    }
    connection
        .execute(
            "INSERT INTO sync_topics(topic_id, file_name, quarantined) VALUES (?1, ?2, 1)",
            params![quarantine_topic_id(file_name), file_name],
        )
        .map_err(|error| format!("Could not record a quarantined Notes file: {error}"))?;
    Ok(())
}

pub(crate) fn clear_virtual_quarantine(
    connection: &Connection,
    file_name: &str,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM sync_topics WHERE file_name = ?1 AND quarantined = 1 \
             AND (topic_id LIKE ?2 OR topic_id LIKE ?3)",
            params![
                file_name,
                format!("{QUARANTINE_TOPIC_PREFIX}%"),
                format!("{CLEANUP_TOPIC_PREFIX}%")
            ],
        )
        .map_err(|error| format!("Could not clear a Notes file quarantine: {error}"))?;
    Ok(())
}

fn current_timestamp(connection: &Connection) -> Result<String, String> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not record Notes sync time: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        flush_pending, inject_startup_after_entry_inspect_hook, inject_startup_before_rank_hook,
        inject_truncated_recovery_after_isolation_hook,
        inject_truncated_recovery_before_publication_hook, reconcile_startup,
    };
    use crate::notes::connection::{
        acquire_notes_connection, evict_notes_connection, lock_notes_connection,
    };
    use crate::notes::sync::exporter::{sha256_hex, TRASH_FILE_NAME, TRASH_TOPIC_ID};
    use crate::notes::sync::topic_file::{
        render_topic_doc, TopicContent, TopicDoc, TopicFile, TopicNode, TopicRoot,
    };
    use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
    use rusqlite::params;
    use std::fs;

    const TOPIC_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SECOND_TOPIC_ID: &str = "33333333-3333-4333-8333-333333333333";
    const SECOND_CHILD_ID: &str = "44444444-4444-4444-8444-444444444444";
    const HLC_1: &str = "000000001-00-a3f2";
    const HLC_2: &str = "000000002-00-a3f2";

    fn topic(title: &str, root_hlc: &str) -> TopicDoc {
        TopicDoc {
            id: TOPIC_ID.to_string(),
            sort_key: 1024,
            max_hlc: HLC_2.to_string(),
            root: TopicRoot {
                title: title.to_string(),
                note: String::new(),
                hlc: root_hlc.to_string(),
                starred: false,
                completed_at: None,
                archived_at: None,
            },
            nodes: vec![TopicNode {
                id: Some(CHILD_ID.to_string()),
                hlc: HLC_2.to_string(),
                starred: false,
                completed: false,
                content: TopicContent::Text("Child".to_string()),
                note: String::new(),
                from: None,
                sibling_ordinal: 1,
                sort_key: 1024,
                children: Vec::new(),
            }],
        }
    }

    fn vault_string(vault: &tempfile::TempDir) -> String {
        vault.path().to_str().expect("utf-8 vault").to_string()
    }

    #[test]
    fn new_database_bootstraps_existing_vault_files_without_onboarding_residue() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let source_name = "source-name.md";
        let bytes = render_topic_doc(&topic("Imported", HLC_1)).expect("render source");
        fs::write(vault.path().join(source_name), &bytes).expect("write source");

        let report = reconcile_startup(&vault_path).expect("bootstrap new database");
        assert_eq!(report.merged_files, 1);
        let shared = acquire_notes_connection(&vault_path).expect("acquire database");
        let connection = lock_notes_connection(&shared).expect("lock database");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            source_name
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            sha256_hex(&bytes)
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn existing_database_with_empty_vault_exports_all_topics_using_title_filename() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let shared = acquire_notes_connection(&vault_path).expect("initialize database");
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection.execute("DELETE FROM notes_nodes", []).unwrap();
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO notes_nodes(id, parent_id, sort_key, title, created_at, updated_at, hlc) \
                     VALUES (?1, NULL, 1024, 'Local topic', '2026-07-21T00:00:00.000Z', \
                             '2026-07-21T00:00:00.000Z', ?2)",
                    params![TOPIC_ID, HLC_1],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1)",
                    [TOPIC_ID],
                )
                .unwrap();
        }

        let report = reconcile_startup(&vault_path).expect("export initial vault");
        assert_eq!(report.exported_files, 1);
        assert!(vault.path().join("Local-topic.11111111.md").is_file());
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn existing_database_merges_changed_hash_and_skips_unchanged_topic_and_trash_hashes() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let shared = acquire_notes_connection(&vault_path).expect("initialize database");
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection.execute("DELETE FROM notes_nodes", []).unwrap();
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();
        }
        let topic_name = "external.md";
        fs::write(
            vault.path().join(topic_name),
            render_topic_doc(&topic("First", HLC_1)).unwrap(),
        )
        .unwrap();
        fs::write(
            vault.path().join(TRASH_FILE_NAME),
            b"---\nkind: yonalist-trash\nformat_version: 2\nmax_hlc: \n---\n",
        )
        .unwrap();

        let first = reconcile_startup(&vault_path).expect("merge changed files");
        assert_eq!(first.merged_files, 2);
        let second = reconcile_startup(&vault_path).expect("skip unchanged files");
        assert_eq!(second.skipped_files, 2);
        let connection = lock_notes_connection(&shared).unwrap();
        assert!(connection
            .query_row(
                "SELECT exported_hash <> '' FROM sync_topics WHERE topic_id = ?1",
                [TRASH_TOPIC_ID],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn crash_left_dirty_rows_export_immediately_during_startup() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let source_name = "stable.md";
        fs::write(
            vault.path().join(source_name),
            render_topic_doc(&topic("Before crash", HLC_1)).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).expect("initial bootstrap");
        let shared = acquire_notes_connection(&vault_path).unwrap();
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection
                .execute(
                    "UPDATE notes_nodes SET title = 'Recovered edit', hlc = ?1 WHERE id = ?2",
                    params![HLC_2, TOPIC_ID],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                     ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                    [TOPIC_ID],
                )
                .unwrap();
        }

        let report = reconcile_startup(&vault_path).expect("flush crash dirtiness");
        assert_eq!(report.exported_files, 1);
        assert!(fs::read_to_string(vault.path().join(source_name))
            .unwrap()
            .contains("# Recovered edit"));
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn initial_topic_export_still_reconciles_an_existing_trash_file() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let shared = acquire_notes_connection(&vault_path).expect("initialize database");
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection.execute("DELETE FROM notes_nodes", []).unwrap();
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO notes_nodes(id, parent_id, sort_key, title, created_at, updated_at, hlc) \
                     VALUES (?1, NULL, 1024, 'Local topic', '2026-07-21T00:00:00.000Z', \
                             '2026-07-21T00:00:00.000Z', ?2)",
                    params![TOPIC_ID, HLC_1],
                )
                .unwrap();
        }
        let trash = format!(
            "---\nkind: yonalist-trash\nformat_version: 2\nmax_hlc: {HLC_2}\n---\n- [ ] Remote deleted <!-- yid: {CHILD_ID} t: {HLC_2} -->\n"
        );
        fs::write(vault.path().join(TRASH_FILE_NAME), trash).unwrap();

        let report = reconcile_startup(&vault_path).expect("reconcile trash and export topics");
        assert_eq!(report.merged_files, 1);
        assert!(vault.path().join("Local-topic.11111111.md").is_file());
        let connection = lock_notes_connection(&shared).unwrap();
        assert!(connection
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn quarantined_trash_is_not_overwritten_during_initial_topic_export() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let shared = acquire_notes_connection(&vault_path).expect("initialize database");
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection.execute("DELETE FROM notes_nodes", []).unwrap();
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO notes_nodes(id, parent_id, sort_key, title, created_at, updated_at, hlc) \
                     VALUES (?1, NULL, 1024, 'Local topic', '2026-07-21T00:00:00.000Z', \
                             '2026-07-21T00:00:00.000Z', ?2)",
                    params![TOPIC_ID, HLC_1],
                )
                .unwrap();
        }
        let invalid = b"not a canonical trash file";
        fs::write(vault.path().join(TRASH_FILE_NAME), invalid).unwrap();

        reconcile_startup(&vault_path).expect("quarantine trash and export topics");
        assert_eq!(
            fs::read(vault.path().join(TRASH_FILE_NAME)).unwrap(),
            invalid
        );
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT quarantined FROM sync_topics WHERE topic_id = ?1 AND file_name = ?2",
                    params![TRASH_TOPIC_ID, TRASH_FILE_NAME],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn topic_document_named_trash_is_quarantined_under_the_reserved_identity() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let bytes = render_topic_doc(&topic("Wrongly named", HLC_1)).unwrap();
        fs::write(vault.path().join(TRASH_FILE_NAME), &bytes).unwrap();

        reconcile_startup(&vault_path).expect("quarantine reserved filename");
        assert_eq!(fs::read(vault.path().join(TRASH_FILE_NAME)).unwrap(), bytes);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT topic_id, quarantined FROM sync_topics WHERE file_name = ?1",
                    [TRASH_FILE_NAME],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap(),
            (TRASH_TOPIC_ID.to_string(), 1)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn invalid_non_topic_file_does_not_suppress_initial_local_topic_export() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let shared = acquire_notes_connection(&vault_path).expect("initialize database");
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection.execute("DELETE FROM notes_nodes", []).unwrap();
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO notes_nodes(id, parent_id, sort_key, title, created_at, updated_at, hlc) \
                     VALUES (?1, NULL, 1024, 'Local topic', '2026-07-21T00:00:00.000Z', \
                             '2026-07-21T00:00:00.000Z', ?2)",
                    params![TOPIC_ID, HLC_1],
                )
                .unwrap();
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();
        }
        let invalid = b"not a canonical Notes topic";
        fs::write(vault.path().join("broken.md"), invalid).unwrap();

        let report =
            reconcile_startup(&vault_path).expect("quarantine invalid file and export local topic");
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors[0].contains("broken.md"));
        assert_eq!(fs::read(vault.path().join("broken.md")).unwrap(), invalid);
        assert!(vault.path().join("Local-topic.11111111.md").is_file());
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn one_merge_failure_is_quarantined_without_starving_a_healthy_file() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let shared = acquire_notes_connection(&vault_path).expect("initialize database");
        {
            let connection = lock_notes_connection(&shared).unwrap();
            connection.execute("DELETE FROM notes_nodes", []).unwrap();
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO sync_topics(topic_id, file_name) VALUES (?1, 'a-broken.md')",
                    ["55555555-5555-4555-8555-555555555555"],
                )
                .unwrap();
        }
        fs::write(
            vault.path().join("a-broken.md"),
            render_topic_doc(&topic("Broken", HLC_1)).unwrap(),
        )
        .unwrap();
        let mut healthy = topic("Healthy", HLC_1);
        healthy.id = SECOND_TOPIC_ID.to_string();
        healthy.nodes[0].id = Some(SECOND_CHILD_ID.to_string());
        fs::write(
            vault.path().join("z-healthy.md"),
            render_topic_doc(&healthy).unwrap(),
        )
        .unwrap();

        let report = reconcile_startup(&vault_path).expect("continue after one merge failure");

        assert_eq!(report.merged_files, 1);
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors[0].contains("a-broken.md"));
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [SECOND_TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Healthy"
        );
        assert!(connection
            .query_row(
                "SELECT quarantined <> 0 FROM sync_topics WHERE file_name = 'a-broken.md'",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn flush_failure_does_not_starve_a_later_healthy_topic() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let shared = acquire_notes_connection(&vault_path).expect("initialize database");
        let mut connection = lock_notes_connection(&shared).unwrap();
        connection.execute("DELETE FROM notes_nodes", []).unwrap();
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let broken_topic = "00000000-0000-4000-8000-000000000001";
        let broken_child = "00000000-0000-4000-8000-000000000002";
        let healthy_topic = "99999999-9999-4999-8999-999999999999";
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, title, created_at, updated_at, hlc) \
                 VALUES (?1, NULL, 1024, 'Broken topic', '2026-07-21T00:00:00.000Z', \
                         '2026-07-21T00:00:00.000Z', ?2)",
                params![broken_topic, HLC_1],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, note, image_offset_utf16, node_kind, \
                   created_at, updated_at, hlc\
                 ) VALUES (?1, ?2, 1024, 'Broken image', '', 0, 'image', \
                           '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', ?3)",
                params![broken_child, broken_topic, HLC_1],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, title, created_at, updated_at, hlc) \
                 VALUES (?1, NULL, 2048, 'Healthy topic', '2026-07-21T00:00:00.000Z', \
                         '2026-07-21T00:00:00.000Z', ?2)",
                params![healthy_topic, HLC_1],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1), (?2)",
                params![broken_child, healthy_topic],
            )
            .unwrap();

        let error = flush_pending(&mut connection, vault.path()).expect_err("aggregate failure");
        assert!(error.contains("must own exactly one attachment"));
        assert!(vault.path().join("Healthy-topic.99999999.md").is_file());
        let dirty = connection
            .prepare("SELECT node_id FROM sync_dirty_nodes ORDER BY node_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(dirty, vec![broken_child.to_string()]);
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn restoring_exact_last_good_bytes_clears_topic_quarantine() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let source_name = "stable.md";
        let good = render_topic_doc(&topic("Stable", HLC_1)).unwrap();
        fs::write(vault.path().join(source_name), &good).unwrap();
        reconcile_startup(&vault_path).expect("bootstrap good file");
        fs::write(vault.path().join(source_name), b"corrupted").unwrap();
        reconcile_startup(&vault_path).expect("quarantine corruption");

        fs::write(vault.path().join(source_name), &good).unwrap();
        reconcile_startup(&vault_path).expect("restore exact last-good bytes");
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT quarantined FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn truncated_export_recovery_does_not_overwrite_a_newer_path_replacement() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let source_name = "Stable.11111111.md";
        let source = vault.path().join(source_name);
        let good = render_topic_doc(&topic("Stable", HLC_1)).unwrap();
        fs::write(&source, &good).unwrap();
        reconcile_startup(&vault_path).expect("bootstrap good file");
        fs::write(&source, &good[..good.len() / 2]).unwrap();

        let replacement = b"newer unrelated cloud bytes".to_vec();
        let replacement_for_hook = replacement.clone();
        inject_truncated_recovery_before_publication_hook(move |path| {
            fs::write(path, &replacement_for_hook).expect("replace recovery path");
        });

        let report = reconcile_startup(&vault_path).expect("reject stale recovery source");

        assert_eq!(fs::read(&source).expect("read replacement"), replacement);
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("truncated")));
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
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
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn truncated_recovery_preserves_a_competing_path_created_after_isolation() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let source = vault.path().join("Stable.11111111.md");
        let good = render_topic_doc(&topic("Stable", HLC_1)).unwrap();
        fs::write(&source, &good).unwrap();
        reconcile_startup(&vault_path).expect("bootstrap good file");
        fs::write(&source, &good[..good.len() / 2]).unwrap();

        let replacement = b"competing cloud publication".to_vec();
        let replacement_for_hook = replacement.clone();
        let source_for_hook = source.clone();
        inject_truncated_recovery_after_isolation_hook(move || {
            fs::write(&source_for_hook, &replacement_for_hook)
                .expect("publish competing source path");
        });

        let report = reconcile_startup(&vault_path).expect("quarantine publication conflict");

        assert_eq!(
            fs::read(&source).expect("read competing source"),
            replacement
        );
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("Could not publish the recovered Notes file")));
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
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
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn syntactically_valid_truncated_export_is_restored_before_it_can_false_converge() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let source_name = "Stable.11111111.md";
        let source = vault.path().join(source_name);
        let good = render_topic_doc(&topic("Stable", HLC_1)).unwrap();
        fs::write(&source, &good).unwrap();
        reconcile_startup(&vault_path).expect("bootstrap good file");

        let first_bullet = good
            .windows(b"- [ ]".len())
            .position(|window| window == b"- [ ]")
            .expect("canonical topic contains a child bullet");
        let valid_root_only_prefix = &good[..first_bullet];
        assert!(matches!(
            parse_topic_file(valid_root_only_prefix),
            TopicParseOutcome::Parsed(TopicFile::Topic(_))
        ));
        fs::write(&source, valid_root_only_prefix).unwrap();

        let report = reconcile_startup(&vault_path).expect("recover valid truncated export");

        assert_eq!(fs::read(&source).expect("read restored topic"), good);
        assert_eq!(report.exported_files, 1);
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("truncated")));
        assert_eq!(
            fs::read_dir(vault.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".yonalist-truncated-recovery-")
                })
                .count(),
            1
        );
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE parent_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
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
        drop(connection);
        drop(shared);

        let retry = reconcile_startup(&vault_path).expect("acknowledge recovered canonical file");
        assert!(retry.status_changed);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT quarantined FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn startup_recovers_if_the_process_stops_after_truncated_source_isolation() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_string(&vault);
        let source = vault.path().join("Stable.11111111.md");
        let good = render_topic_doc(&topic("Stable", HLC_1)).unwrap();
        let mut healthy = topic("Healthy", HLC_1);
        healthy.id = SECOND_TOPIC_ID.to_string();
        healthy.nodes[0].id = Some(SECOND_CHILD_ID.to_string());
        fs::write(&source, &good).unwrap();
        fs::write(
            vault.path().join("Healthy.33333333.md"),
            render_topic_doc(&healthy).unwrap(),
        )
        .unwrap();
        reconcile_startup(&vault_path).expect("bootstrap good file");
        fs::write(&source, b"arbitrary corruption").unwrap();
        reconcile_startup(&vault_path).expect("quarantine arbitrary corruption");
        fs::write(&source, &good[..good.len() / 2]).unwrap();

        inject_truncated_recovery_after_isolation_hook(|| {
            panic!("simulate process stop after recovery isolation")
        });
        let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reconcile_startup(&vault_path)
        }));
        assert!(stopped.is_err());
        assert!(!source.exists());
        evict_notes_connection(&vault_path);

        let report = reconcile_startup(&vault_path).expect("restart recovers canonical file");

        assert_eq!(fs::read(&source).expect("read restart recovery"), good);
        assert_eq!(report.exported_files, 1);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT quarantined FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[cfg(unix)]
    #[test]
    fn startup_rejects_a_symlink_swap_after_entry_inspection_without_starving_healthy_files() {
        use std::os::unix::fs::symlink;

        const OUTSIDE_TOPIC_ID: &str = "55555555-5555-4555-8555-555555555555";
        const OUTSIDE_CHILD_ID: &str = "66666666-6666-4666-8666-666666666666";

        let vault = tempfile::tempdir().expect("create vault");
        let outside = tempfile::tempdir().expect("create outside directory");
        let vault_path = vault_string(&vault);
        let victim = vault.path().join("a-victim.md");
        let outside_path = outside.path().join("outside.md");
        let mut healthy = topic("Healthy", HLC_1);
        healthy.id = SECOND_TOPIC_ID.to_string();
        healthy.nodes[0].id = Some(SECOND_CHILD_ID.to_string());
        let mut external = topic("External", "000000009-00-a3f2");
        external.id = OUTSIDE_TOPIC_ID.to_string();
        external.nodes[0].id = Some(OUTSIDE_CHILD_ID.to_string());
        let external_bytes = render_topic_doc(&external).expect("render external source");
        fs::write(&victim, render_topic_doc(&topic("Inside", HLC_1)).unwrap()).unwrap();
        fs::write(
            vault.path().join("z-healthy.md"),
            render_topic_doc(&healthy).unwrap(),
        )
        .unwrap();
        fs::write(&outside_path, &external_bytes).unwrap();

        let victim_for_hook = victim.clone();
        let outside_for_hook = outside_path.clone();
        inject_startup_after_entry_inspect_hook(move |inspected| {
            if inspected == victim_for_hook {
                fs::remove_file(&victim_for_hook).unwrap();
                symlink(&outside_for_hook, &victim_for_hook).unwrap();
            }
        });

        let report = reconcile_startup(&vault_path).expect("continue after unsafe startup source");

        let expected_retry = fs::canonicalize(vault.path()).unwrap().join("a-victim.md");
        assert!(report.retry_paths.contains(&expected_retry), "{report:?}");
        assert!(
            !report
                .retry_paths
                .contains(&fs::canonicalize(&outside_path).unwrap()),
            "{report:?}"
        );
        assert_eq!(fs::read(&outside_path).unwrap(), external_bytes);
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [OUTSIDE_TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "external bytes must never become owned Notes state"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [SECOND_TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Healthy"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_topics WHERE exported_hash = ?1",
                    [sha256_hex(&external_bytes)],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "external bytes must not be hashed as a synchronized vault file"
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }

    #[cfg(unix)]
    #[test]
    fn startup_ranking_carries_the_enumerated_bytes_across_a_canonical_path_swap() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().expect("create vault");
        let outside = tempfile::tempdir().expect("create outside directory");
        let vault_path = vault_string(&vault);
        let canonical = vault.path().join("topic.11111111.md");
        let bounce = vault.path().join("a-bounce.md");
        let healthy_path = vault.path().join("z-healthy.md");
        let outside_path = outside.path().join("outside.md");
        let canonical_bytes = render_topic_doc(&topic("Canonical", HLC_1)).unwrap();
        let bounce_bytes = render_topic_doc(&topic("Bounce", HLC_2)).unwrap();
        let external_bytes = render_topic_doc(&topic("External", "000000009-00-a3f2")).unwrap();
        let mut healthy = topic("Healthy", HLC_1);
        healthy.id = SECOND_TOPIC_ID.to_string();
        healthy.nodes[0].id = Some(SECOND_CHILD_ID.to_string());
        fs::write(&canonical, &canonical_bytes).unwrap();
        fs::write(&bounce, &bounce_bytes).unwrap();
        fs::write(&healthy_path, render_topic_doc(&healthy).unwrap()).unwrap();
        fs::write(&outside_path, &external_bytes).unwrap();

        let canonical_for_hook = canonical.clone();
        let outside_for_hook = outside_path.clone();
        inject_startup_before_rank_hook(move || {
            fs::remove_file(&canonical_for_hook).unwrap();
            symlink(&outside_for_hook, &canonical_for_hook).unwrap();
        });

        let report = reconcile_startup(&vault_path).expect("reconcile captured startup sources");

        assert_eq!(fs::read(&outside_path).unwrap(), external_bytes);
        let expected_bounce = fs::canonicalize(vault.path()).unwrap().join("a-bounce.md");
        assert!(
            report.pending_cleanup.contains_key(&expected_bounce),
            "{report:?}"
        );
        let shared = acquire_notes_connection(&vault_path).unwrap();
        let connection = lock_notes_connection(&shared).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Bounce",
            "ranking and reconcile must use the captured vault bytes, not the swapped link"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [SECOND_TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Healthy"
        );
        assert_ne!(
            connection
                .query_row(
                    "SELECT exported_hash FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            sha256_hex(&external_bytes)
        );
        drop(connection);
        drop(shared);
        evict_notes_connection(&vault_path);
    }
}
