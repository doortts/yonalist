use crate::notes::connection::{
    acquire_notes_connection, lock_notes_connection, validate_notes_connection,
};
use crate::notes::repository::notes_db_path;
use crate::notes::sync::exporter::{
    ensure_trash_metadata, load_all_exports, load_pending_exports, publish_pending_exports,
    sha256_hex, ExportBatchOutcome, TRASH_FILE_NAME, TRASH_TOPIC_ID,
};
use crate::notes::sync::merger::{merge_topic_doc, merge_trash_doc};
use crate::notes::sync::topic_file::TopicFile;
use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const QUARANTINE_TOPIC_PREFIX: &str = "__yonalist_quarantine__:";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct BootstrapReport {
    pub(crate) merged_files: usize,
    pub(crate) skipped_files: usize,
    pub(crate) exported_files: usize,
    pub(crate) errors: Vec<String>,
    pub(crate) last_export_at: Option<String>,
    pub(crate) last_merge_at: Option<String>,
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
    for source in sources {
        if let Err(error) = reconcile_file(connection, source, report) {
            let Some(file_name) = source.file_name().and_then(|name| name.to_str()) else {
                report.record_error(error);
                continue;
            };
            record_quarantine(connection, file_name)?;
            report.record_error(format!("{file_name}: {error}"));
        }
    }
    Ok(())
}

fn reconcile_file(
    connection: &mut Connection,
    source: &Path,
    report: &mut BootstrapReport,
) -> Result<(), String> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "A Notes sync filename must be UTF-8.".to_string())?;
    let bytes = fs::read(source)
        .map_err(|error| format!("Could not read Notes sync file {file_name}: {error}"))?;
    let hash = sha256_hex(&bytes);
    let stored = connection
        .query_row(
            "SELECT exported_hash, quarantined FROM sync_topics WHERE file_name = ?1",
            [file_name],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Could not inspect a Notes sync file hash: {error}"))?;
    if stored
        .as_ref()
        .is_some_and(|(stored_hash, quarantined)| !quarantined && stored_hash == &hash)
    {
        report.skipped_files += 1;
        return Ok(());
    }

    let document = match parse_topic_file(&bytes) {
        TopicParseOutcome::Parsed(document) => document,
        TopicParseOutcome::Quarantined(quarantine) => {
            record_quarantine(connection, file_name)?;
            report.record_error(format!(
                "{file_name}: Notes sync file was quarantined: {:?}",
                quarantine.error
            ));
            return Ok(());
        }
    };
    if file_name == TRASH_FILE_NAME && matches!(document, TopicFile::Topic(_)) {
        record_quarantine(connection, file_name)?;
        report.record_error(format!(
            "{file_name}: a Notes topic cannot use the reserved trash filename."
        ));
        return Ok(());
    }
    clear_virtual_quarantine(connection, file_name)?;
    match document {
        TopicFile::Topic(document) => {
            let assigned_file_name = seed_source_filename(connection, &document.id, file_name)?;
            merge_topic_doc(connection, &document).map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE sync_topics SET quarantined = 0 WHERE topic_id = ?1",
                    [&document.id],
                )
                .map_err(|error| format!("Could not clear Notes topic quarantine: {error}"))?;
            if assigned_file_name == file_name {
                record_synchronized_hash(connection, &document.id, &hash, &document.max_hlc)?;
            }
        }
        TopicFile::Trash(document) => {
            if file_name != TRASH_FILE_NAME {
                return Err("A Notes trash document must be named trash.md.".to_string());
            }
            ensure_trash_metadata(connection)?;
            merge_trash_doc(connection, &document).map_err(|error| error.to_string())?;
            record_synchronized_hash(connection, TRASH_TOPIC_ID, &hash, &document.max_hlc)?;
        }
    }
    report.merged_files += 1;
    Ok(())
}

fn seed_source_filename(
    connection: &Connection,
    topic_id: &str,
    source_file_name: &str,
) -> Result<String, String> {
    let existing = connection
        .query_row(
            "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
            [topic_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect a Notes topic filename: {error}"))?;
    if let Some(existing) = existing {
        return Ok(existing);
    }
    let owner = connection
        .query_row(
            "SELECT topic_id FROM sync_topics WHERE file_name = ?1",
            [source_file_name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect Notes filename ownership: {error}"))?;
    if let Some(owner) = owner {
        return Err(format!(
            "Notes sync filename {source_file_name} is already assigned to {owner}."
        ));
    }
    connection
        .execute(
            "INSERT INTO sync_topics(topic_id, file_name) VALUES (?1, ?2)",
            params![topic_id, source_file_name],
        )
        .map_err(|error| format!("Could not seed a Notes source filename: {error}"))?;
    Ok(source_file_name.to_string())
}

fn record_synchronized_hash(
    connection: &Connection,
    topic_id: &str,
    hash: &str,
    max_hlc: &str,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE sync_topics SET exported_hash = ?1, \
                    applied_max_hlc = max(applied_max_hlc, ?2), quarantined = 0 \
             WHERE topic_id = ?3",
            params![hash, max_hlc, topic_id],
        )
        .map_err(|error| format!("Could not record a synchronized Notes file hash: {error}"))?;
    Ok(())
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

fn record_quarantine(connection: &Connection, file_name: &str) -> Result<(), String> {
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

fn clear_virtual_quarantine(connection: &Connection, file_name: &str) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM sync_topics WHERE file_name = ?1 AND quarantined = 1 \
             AND topic_id LIKE ?2",
            params![file_name, format!("{QUARANTINE_TOPIC_PREFIX}%")],
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
