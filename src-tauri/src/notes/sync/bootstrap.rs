use crate::notes::connection::{
    acquire_notes_connection, lock_notes_connection, validate_notes_connection,
};
use crate::notes::repository::notes_db_path;
use crate::notes::sync::exporter::{
    ensure_trash_metadata, load_all_exports, load_pending_exports, publish_pending_exports,
    sha256_hex, ExportBatchOutcome, TRASH_FILE_NAME, TRASH_TOPIC_ID,
};
use crate::notes::sync::merger::{
    merge_topic_doc_with_cleanup, merge_trash_doc_with_hash, MergeCleanupIntent,
};
use crate::notes::sync::topic_file::TopicFile;
use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const QUARANTINE_TOPIC_PREFIX: &str = "__yonalist_quarantine__:";
const CLEANUP_TOPIC_PREFIX: &str = "__yonalist_cleanup__:";

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

pub(crate) fn reconcile_startup(vault_path: &str) -> Result<BootstrapReport, String> {
    let database_existed = notes_db_path(vault_path)
        .try_exists()
        .map_err(|error| format!("Could not inspect Notes sync storage: {error}"))?;
    let vault_root = crate::expand_vault_path(vault_path);
    let markdown_files = root_markdown_files(&vault_root)?;
    let has_topic_file = has_parseable_topic_file(&markdown_files);
    let shared = acquire_notes_connection(vault_path)?;
    let mut connection = lock_notes_connection(&shared)?;

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
        let has_trash_file = markdown_files
            .iter()
            .any(|path| path.file_name().and_then(|name| name.to_str()) == Some(TRASH_FILE_NAME));
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

fn has_parseable_topic_file(markdown_files: &[PathBuf]) -> bool {
    for source in markdown_files {
        if source.file_name().and_then(|name| name.to_str()) == Some(TRASH_FILE_NAME) {
            continue;
        }
        let Ok(bytes) = fs::read(source) else {
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

fn root_markdown_files(vault_root: &Path) -> Result<Vec<PathBuf>, String> {
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
            files.push(path);
        }
    }
    files.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    Ok(files)
}

fn reconcile_files(
    connection: &mut Connection,
    sources: &[PathBuf],
    report: &mut BootstrapReport,
) -> Result<(), String> {
    let mut ordered_sources = sources.iter().collect::<Vec<_>>();
    ordered_sources.sort_by(|left, right| {
        canonical_source_rank(left)
            .cmp(&canonical_source_rank(right))
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });
    for source in ordered_sources {
        if let Err(error) = reconcile_file(connection, source, report) {
            report.retry_paths.insert(normalize_source_path(source));
            let Some(file_name) = source.file_name().and_then(|name| name.to_str()) else {
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

fn canonical_source_rank(source: &Path) -> u8 {
    let Some(file_name) = source.file_name().and_then(|name| name.to_str()) else {
        return 1;
    };
    if file_name == TRASH_FILE_NAME {
        return 0;
    }
    let Ok(bytes) = fs::read(source) else {
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

pub(crate) fn reconcile_file(
    connection: &mut Connection,
    source: &Path,
    report: &mut BootstrapReport,
) -> Result<ReconcileFileOutcome, String> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "A Notes sync filename must be UTF-8.".to_string())?;
    let bytes = fs::read(source)
        .map_err(|error| format!("Could not read Notes sync file {file_name}: {error}"))?;
    reconcile_file_bytes(connection, source, &bytes, report)
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
        TopicFile::Trash(document) => {
            if file_name != TRASH_FILE_NAME {
                return Err("A Notes trash document must be named trash.md.".to_string());
            }
            ensure_trash_metadata(connection)?;
            let merge = merge_trash_doc_with_hash(connection, &document, Some(&hash))
                .map_err(|error| error.to_string())?;
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
    fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf())
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
    use super::{flush_pending, reconcile_startup};
    use crate::notes::connection::{
        acquire_notes_connection, evict_notes_connection, lock_notes_connection,
    };
    use crate::notes::sync::exporter::{sha256_hex, TRASH_FILE_NAME, TRASH_TOPIC_ID};
    use crate::notes::sync::topic_file::{
        render_topic_doc, TopicContent, TopicDoc, TopicNode, TopicRoot,
    };
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
}
