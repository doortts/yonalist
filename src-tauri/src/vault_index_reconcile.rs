use rusqlite::{OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultManifestFingerprint {
    pub content_hash: String,
    pub size: u64,
    pub modified_ns: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultIndexScanChange {
    pub relative_path: String,
    pub size: u64,
    pub modified_ns: String,
    pub content_hash: String,
    pub frontmatter: Option<String>,
    pub frontmatter_error: bool,
    pub expected: Option<VaultManifestFingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultRemovedIndexPath {
    pub relative_path: String,
    pub expected: VaultManifestFingerprint,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct VaultParsedIndexChange {
    pub relative_path: String,
    pub size: u64,
    pub modified_ns: String,
    pub content_hash: String,
    pub expected: Option<VaultManifestFingerprint>,
    pub candidate: Option<super::VaultItemIndexRecord>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VaultIndexCommitReport {
    pub upserted: u32,
    pub removed: u32,
    pub deferred: u32,
}

fn validate_candidate(record: &super::VaultItemIndexRecord) -> Result<(), String> {
    if !matches!(record.kind.as_str(), "issue" | "pull" | "discussion")
        || record.number <= 0
        || record.host.trim().is_empty()
        || record.owner.trim().is_empty()
        || record.repo.trim().is_empty()
        || record.title.trim().is_empty()
    {
        return Err("Vault item candidate is invalid.".to_string());
    }
    serde_json::from_str::<Vec<String>>(&record.labels_json)
        .map_err(|_| "Vault item labels are invalid.".to_string())?;
    serde_json::from_str::<HashMap<String, String>>(&record.label_colors_json)
        .map_err(|_| "Vault item label colors are invalid.".to_string())?;
    Ok(())
}

fn candidate_identity(record: &super::VaultItemIndexRecord) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        record.host.to_ascii_lowercase(),
        record.owner.to_ascii_lowercase(),
        record.repo.to_ascii_lowercase(),
        record.kind.to_ascii_lowercase(),
        record.number
    )
}

fn merge_candidates(
    records: impl IntoIterator<Item = super::VaultItemIndexRecord>,
) -> Vec<super::VaultItemIndexRecord> {
    let mut winners = HashMap::<String, super::VaultItemIndexRecord>::new();
    for record in records {
        let key = candidate_identity(&record);
        let Some(existing) = winners.get_mut(&key) else {
            winners.insert(key, record);
            continue;
        };
        let favorite = existing.favorite || record.favorite;
        let comment_count = existing.comment_count.or(record.comment_count);
        if record.updated_at > existing.updated_at {
            let mut winner = record;
            winner.favorite = favorite;
            winner.comment_count = winner.comment_count.or(comment_count);
            *existing = winner;
        } else {
            existing.favorite = favorite;
            existing.comment_count = comment_count;
        }
    }
    let mut records = winners.into_values().collect::<Vec<_>>();
    records.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    records
}

fn current_manifest_matches(
    transaction: &Transaction<'_>,
    vault_path: &str,
    relative_path: &str,
    expected: Option<&VaultManifestFingerprint>,
) -> Result<bool, String> {
    let current = transaction
        .query_row(
            "SELECT content_hash, size, modified_ns FROM document_hashes WHERE vault_root = ?1 AND relative_path = ?2",
            rusqlite::params![vault_path, relative_path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(match (current, expected) {
        (None, None) => true,
        (Some(_), None) => false,
        (Some((content_hash, size, modified_ns)), Some(expected)) => {
            content_hash == expected.content_hash
                && u64::try_from(size).ok() == Some(expected.size)
                && modified_ns.to_string() == expected.modified_ns
        }
        (None, Some(_)) => false,
    })
}

fn rebuild_item_index_projection(transaction: &Transaction<'_>) -> Result<(), String> {
    let mut statement = transaction
        .prepare(
            "SELECT item_candidate_json FROM document_hashes WHERE item_candidate_json IS NOT NULL ORDER BY relative_path",
        )
        .map_err(|error| error.to_string())?;
    let candidates = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|value| {
            serde_json::from_str::<super::VaultItemIndexRecord>(&value)
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    transaction
        .execute("DELETE FROM item_index", [])
        .map_err(|error| error.to_string())?;
    for candidate in merge_candidates(candidates) {
        super::upsert_item_index_record(transaction, &candidate)?;
    }
    Ok(())
}

pub(crate) fn commit_vault_item_index_changes_inner(
    vault_path: String,
    changes: Vec<VaultParsedIndexChange>,
    removed_paths: Vec<VaultRemovedIndexPath>,
) -> Result<VaultIndexCommitReport, String> {
    let change_count = changes.len();
    let removed_path_count = removed_paths.len();
    struct PreparedChange {
        change: VaultParsedIndexChange,
        modified_ns: i64,
        candidate_json: Option<String>,
    }

    let mut prepared = Vec::with_capacity(changes.len());
    for change in changes {
        let modified_ns = change
            .modified_ns
            .parse::<i64>()
            .map_err(|_| "Vault scan fingerprint is invalid.".to_string())?;
        let _ = i64::try_from(change.size)
            .map_err(|_| "Vault file size is out of range.".to_string())?;
        if let Some(candidate) = change.candidate.as_ref() {
            if candidate.relative_path != change.relative_path {
                return Err("Vault item candidate path does not match the scan.".to_string());
            }
            validate_candidate(candidate)?;
        }
        let path = super::resolve_vault_file(&vault_path, &change.relative_path)?;
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        let current_modified_ns = super::file_modified_ns(&metadata)?;
        if metadata.len() != change.size || current_modified_ns != modified_ns {
            continue;
        }
        prepared.push(PreparedChange {
            candidate_json: change
                .candidate
                .as_ref()
                .map(|candidate| {
                    serde_json::to_string(candidate).map_err(|error| error.to_string())
                })
                .transpose()?,
            change,
            modified_ns,
        });
    }

    let mut prepared_removed = Vec::with_capacity(removed_paths.len());
    for removed in removed_paths {
        let path = super::resolve_vault_file(&vault_path, &removed.relative_path)?;
        if path.exists() {
            continue;
        }
        if removed.expected.modified_ns.parse::<i64>().is_err() {
            return Err("Vault scan fingerprint is invalid.".to_string());
        }
        prepared_removed.push(removed);
    }

    let mut connection = super::connect_index_db(&vault_path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let mut upserted = 0_u32;
    let mut removed_count = 0_u32;
    let mut applied_changes = 0_u32;
    let mut deferred = (change_count - prepared.len() + removed_path_count
        - prepared_removed.len())
    .try_into()
    .unwrap_or(u32::MAX);

    for prepared_change in prepared {
        let path = super::resolve_vault_file(&vault_path, &prepared_change.change.relative_path)?;
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                deferred = deferred.saturating_add(1);
                continue;
            }
            Err(error) => return Err(error.to_string()),
        };
        if metadata.len() != prepared_change.change.size
            || super::file_modified_ns(&metadata)? != prepared_change.modified_ns
        {
            deferred = deferred.saturating_add(1);
            continue;
        }
        if !current_manifest_matches(
            &transaction,
            &vault_path,
            &prepared_change.change.relative_path,
            prepared_change.change.expected.as_ref(),
        )? {
            deferred = deferred.saturating_add(1);
            continue;
        }
        let now = super::now_unix_string();
        transaction
            .execute(
                r#"
                INSERT INTO document_hashes (
                  vault_root, relative_path, content_hash, size, modified_ns,
                  item_candidate_json, updated_at, last_seen_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                ON CONFLICT(vault_root, relative_path) DO UPDATE SET
                  content_hash = excluded.content_hash,
                  size = excluded.size,
                  modified_ns = excluded.modified_ns,
                  item_candidate_json = excluded.item_candidate_json,
                  updated_at = excluded.updated_at,
                  last_seen_at = excluded.last_seen_at
                "#,
                rusqlite::params![
                    &vault_path,
                    &prepared_change.change.relative_path,
                    &prepared_change.change.content_hash,
                    i64::try_from(prepared_change.change.size)
                        .map_err(|_| "Vault file size is out of range.")?,
                    prepared_change.modified_ns,
                    prepared_change.candidate_json,
                    now,
                ],
            )
            .map_err(|error| error.to_string())?;
        applied_changes = applied_changes.saturating_add(1);
        if prepared_change.change.candidate.is_some() {
            upserted = upserted.saturating_add(1);
        }
    }

    for removed in prepared_removed {
        let path = super::resolve_vault_file(&vault_path, &removed.relative_path)?;
        if path.exists() {
            deferred = deferred.saturating_add(1);
            continue;
        }
        if !current_manifest_matches(
            &transaction,
            &vault_path,
            &removed.relative_path,
            Some(&removed.expected),
        )? {
            deferred = deferred.saturating_add(1);
            continue;
        }
        removed_count = removed_count.saturating_add(
            transaction
                .execute(
                    "DELETE FROM document_hashes WHERE vault_root = ?1 AND relative_path = ?2",
                    rusqlite::params![&vault_path, &removed.relative_path],
                )
                .map_err(|error| error.to_string())?
                .try_into()
                .unwrap_or(u32::MAX),
        );
        applied_changes = applied_changes.saturating_add(1);
    }

    if applied_changes == 0 {
        transaction.rollback().map_err(|error| error.to_string())?;
        return Ok(VaultIndexCommitReport {
            upserted,
            removed: removed_count,
            deferred,
        });
    }
    rebuild_item_index_projection(&transaction)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(VaultIndexCommitReport {
        upserted,
        removed: removed_count,
        deferred,
    })
}

#[tauri::command]
pub(crate) async fn commit_vault_item_index_changes(
    vault_path: String,
    changes: Vec<VaultParsedIndexChange>,
    removed_paths: Vec<VaultRemovedIndexPath>,
) -> Result<VaultIndexCommitReport, String> {
    super::run_vault_blocking(move || {
        commit_vault_item_index_changes_inner(vault_path, changes, removed_paths)
    })
    .await
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VaultIndexScan {
    pub changes: Vec<VaultIndexScanChange>,
    pub removed_paths: Vec<VaultRemovedIndexPath>,
    pub scanned: u32,
    pub read: u32,
    pub unchanged: u32,
    pub deferred: u32,
}

#[derive(Debug, Clone)]
struct ManifestEntry {
    fingerprint: VaultManifestFingerprint,
}

fn frontmatter_only(contents: &str) -> (Option<String>, bool) {
    let Some(rest) = contents.strip_prefix("---\n") else {
        return (None, false);
    };
    if let Some(close) = rest.find("\n---\n") {
        return (Some(rest[..close].to_string()), false);
    }
    if let Some(close) = rest.strip_suffix("\n---").map(str::len) {
        return (Some(rest[..close].to_string()), false);
    }
    (None, true)
}

fn collect_markdown_paths(
    root: &Path,
    directory: &Path,
    paths: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_markdown_paths(root, &path, paths)?;
            continue;
        }
        if !file_type.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        paths.push((relative_path, path));
    }
    Ok(())
}

fn load_manifest(vault_path: &str) -> Result<HashMap<String, ManifestEntry>, String> {
    let connection = super::connect_index_db(vault_path)?;
    let mut statement = connection
        .prepare(
            "SELECT relative_path, content_hash, size, modified_ns FROM document_hashes WHERE vault_root = ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([vault_path], |row| {
            let size: i64 = row.get(2)?;
            let modified_ns: i64 = row.get(3)?;
            Ok((
                row.get::<_, String>(0)?,
                ManifestEntry {
                    fingerprint: VaultManifestFingerprint {
                        content_hash: row.get(1)?,
                        size: u64::try_from(size).unwrap_or_default(),
                        modified_ns: modified_ns.to_string(),
                    },
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())
}

fn scan_with_reader<R>(
    vault_path: String,
    force: bool,
    mut reader: R,
) -> Result<VaultIndexScan, String>
where
    R: FnMut(&Path) -> Result<String, String>,
{
    let root = super::expand_vault_path(&vault_path);
    let manifest = load_manifest(&vault_path)?;
    let mut paths = Vec::new();
    collect_markdown_paths(&root, &root, &mut paths)?;
    paths.sort_by(|left, right| left.0.cmp(&right.0));

    let mut changes = Vec::new();
    let mut seen = HashSet::new();
    let mut read = 0_u32;
    let mut unchanged = 0_u32;
    let mut deferred = 0_u32;

    for (relative_path, path) in paths {
        seen.insert(relative_path.clone());
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        let size = metadata.len();
        let modified_ns = super::file_modified_ns(&metadata)?.to_string();
        let expected = manifest
            .get(&relative_path)
            .map(|entry| entry.fingerprint.clone());
        if !force
            && expected
                .as_ref()
                .map(|fingerprint| {
                    fingerprint.size == size && fingerprint.modified_ns == modified_ns
                })
                .unwrap_or(false)
        {
            unchanged += 1;
            continue;
        }

        let contents = reader(&path)?;
        let after = fs::metadata(&path).map_err(|error| error.to_string())?;
        let after_size = after.len();
        let after_modified_ns = super::file_modified_ns(&after)?.to_string();
        if after_size != size || after_modified_ns != modified_ns {
            deferred += 1;
            continue;
        }
        let (frontmatter, frontmatter_error) = frontmatter_only(&contents);
        changes.push(VaultIndexScanChange {
            relative_path,
            size,
            modified_ns,
            content_hash: super::hash_text(&contents),
            frontmatter,
            frontmatter_error,
            expected,
        });
        read += 1;
    }

    let mut removed_paths = manifest
        .into_iter()
        .filter(|(relative_path, _)| !seen.contains(relative_path))
        .map(|(relative_path, entry)| VaultRemovedIndexPath {
            relative_path,
            expected: entry.fingerprint,
        })
        .collect::<Vec<_>>();
    changes.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    removed_paths.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    Ok(VaultIndexScan {
        changes,
        removed_paths,
        scanned: seen.len().try_into().unwrap_or(u32::MAX),
        read,
        unchanged,
        deferred,
    })
}

pub(crate) fn scan_vault_item_index_changes_inner(
    vault_path: String,
    force: bool,
) -> Result<VaultIndexScan, String> {
    scan_with_reader(vault_path, force, |path| {
        fs::read_to_string(path).map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub(crate) async fn scan_vault_item_index_changes(
    vault_path: String,
    force: bool,
) -> Result<VaultIndexScan, String> {
    super::run_vault_blocking(move || {
        #[cfg(debug_assertions)]
        if let Ok(value) = std::env::var("YONALIST_RECONCILE_DELAY_MS") {
            let delay = value.parse::<u64>().unwrap_or(0).min(30_000);
            std::thread::sleep(std::time::Duration::from_millis(delay));
        }
        scan_vault_item_index_changes_inner(vault_path, force)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct ScanFixture {
        _temp_dir: tempfile::TempDir,
        vault_path: String,
        relative_path: String,
        contents: String,
    }

    impl ScanFixture {
        fn one_item(body: &str) -> Self {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let vault_path = temp_dir.path().to_string_lossy().into_owned();
            let relative_path = "github.com/acme/app/issues/42/issue.md".to_string();
            let contents = format!(
                "---\nkind: issue\nhost: github.com\nowner: acme\nrepo: app\nnumber: 42\n\
                 title: Indexed issue\nstate: open\nauthor: mona\nlabels: []\n\
                 created_at: 2026-07-03T00:00:00Z\nupdated_at: 2026-07-04T00:00:00Z\n\
                 local:\n  favorite: false\nsync:\n  status: synced\n---\n{body}"
            );
            super::super::write_text_file_inner(&temp_dir.path().join(&relative_path), &contents)
                .expect("write item");
            Self {
                _temp_dir: temp_dir,
                vault_path,
                relative_path,
                contents,
            }
        }

        fn vault(&self) -> String {
            self.vault_path.clone()
        }

        fn item_record(&self) -> super::super::VaultItemIndexRecord {
            super::super::VaultItemIndexRecord {
                relative_path: self.relative_path.clone(),
                host: "github.com".to_string(),
                owner: "acme".to_string(),
                repo: "app".to_string(),
                kind: "issue".to_string(),
                number: 42,
                title: "Indexed issue".to_string(),
                state: "open".to_string(),
                author: "mona".to_string(),
                labels_json: "[]".to_string(),
                label_colors_json: "{}".to_string(),
                comment_count: Some(0),
                created_at: "2026-07-03T00:00:00Z".to_string(),
                updated_at: "2026-07-04T00:00:00Z".to_string(),
                html_url: None,
                favorite: false,
                sync_status: "synced".to_string(),
            }
        }

        fn assert_manifest_candidate_matches(&self) {
            let connection = super::super::connect_index_db(&self.vault_path).expect("index db");
            let candidate_json: String = connection
                .query_row(
                    "SELECT item_candidate_json FROM document_hashes",
                    [],
                    |row| row.get(0),
                )
                .expect("candidate");
            assert_eq!(
                serde_json::from_str::<super::super::VaultItemIndexRecord>(&candidate_json)
                    .expect("candidate json"),
                self.item_record()
            );
        }

        fn seed_matching_manifest(&self) {
            let metadata = fs::metadata(
                super::super::resolve_vault_file(&self.vault_path, &self.relative_path)
                    .expect("item path"),
            )
            .expect("metadata");
            let connection = super::super::connect_index_db(&self.vault_path).expect("index db");
            connection
                .execute(
                    "INSERT INTO document_hashes (\
                       vault_root, relative_path, content_hash, size, modified_ns,\
                       updated_at, last_seen_at\
                     ) VALUES (?1, ?2, ?3, ?4, ?5, '0', '0')",
                    rusqlite::params![
                        self.vault_path,
                        self.relative_path,
                        super::super::hash_text(&self.contents),
                        metadata.len() as i64,
                        super::super::file_modified_ns(&metadata).expect("modified ns")
                    ],
                )
                .expect("seed manifest");
        }
    }

    #[test]
    fn unchanged_scan_reads_zero_bodies_and_force_reads_frontmatter_only() {
        let fixture = ScanFixture::one_item("Body must stay native");
        fixture.seed_matching_manifest();

        let unchanged =
            scan_vault_item_index_changes_inner(fixture.vault(), false).expect("unchanged scan");
        assert_eq!(unchanged.read, 0);
        assert_eq!(unchanged.unchanged, 1);

        let forced =
            scan_vault_item_index_changes_inner(fixture.vault(), true).expect("forced scan");
        assert_eq!(forced.read, 1);
        assert!(!forced.changes[0]
            .frontmatter
            .as_deref()
            .unwrap_or_default()
            .contains("Body must stay native"));
    }

    #[test]
    fn scan_reports_new_changed_renamed_and_removed_paths() {
        let fixture = ScanFixture::one_item("Body");
        fixture.seed_matching_manifest();
        let old_path =
            super::super::resolve_vault_file(&fixture.vault_path, &fixture.relative_path)
                .expect("old path");
        let renamed_relative = "github.com/acme/app/issues/42/renamed.md";
        let renamed_path = super::super::resolve_vault_file(&fixture.vault_path, renamed_relative)
            .expect("renamed path");
        fs::rename(old_path, &renamed_path).expect("rename");

        let scan = scan_vault_item_index_changes_inner(fixture.vault(), false).expect("scan");
        assert_eq!(scan.scanned, 1);
        assert_eq!(scan.changes.len(), 1);
        assert_eq!(scan.changes[0].relative_path, renamed_relative);
        assert_eq!(scan.changes[0].expected, None);
        assert_eq!(scan.removed_paths.len(), 1);
        assert_eq!(scan.removed_paths[0].relative_path, fixture.relative_path);
    }

    #[test]
    fn scan_defers_a_file_that_changes_during_read() {
        let fixture = ScanFixture::one_item("Body");
        fixture.seed_matching_manifest();
        let mut changed = false;
        let scan = scan_with_reader(fixture.vault(), true, |path| {
            let contents = fs::read_to_string(path).expect("read");
            if !changed {
                fs::write(path, format!("{contents}race")).expect("race write");
                changed = true;
            }
            Ok(contents)
        })
        .expect("scan");

        assert_eq!(scan.read, 0);
        assert_eq!(scan.deferred, 1);
        assert!(scan.changes.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn scan_skips_markdown_symlinks() {
        use std::os::unix::fs::symlink;

        let fixture = ScanFixture::one_item("Body");
        let link_path = super::super::resolve_vault_file(
            &fixture.vault_path,
            "github.com/acme/app/issues/42/link.md",
        )
        .expect("link path");
        symlink(
            super::super::resolve_vault_file(&fixture.vault_path, &fixture.relative_path)
                .expect("source path"),
            link_path,
        )
        .expect("symlink");

        let scan = scan_vault_item_index_changes_inner(fixture.vault(), false).expect("scan");
        assert_eq!(scan.scanned, 1);
        assert!(scan
            .changes
            .iter()
            .all(|change| change.relative_path == fixture.relative_path));
    }

    #[test]
    fn scan_marks_missing_frontmatter_fence_without_returning_body() {
        let fixture = ScanFixture::one_item("Body must stay out");
        let path = super::super::resolve_vault_file(&fixture.vault_path, &fixture.relative_path)
            .expect("path");
        fs::write(&path, "---\nkind: issue\nBody must stay out").expect("malformed file");

        let scan = scan_vault_item_index_changes_inner(fixture.vault(), true).expect("scan");
        assert_eq!(scan.changes.len(), 1);
        assert!(scan.changes[0].frontmatter_error);
        assert!(scan.changes[0].frontmatter.is_none());
    }

    fn parsed_change(
        change: &VaultIndexScanChange,
        candidate: super::super::VaultItemIndexRecord,
    ) -> VaultParsedIndexChange {
        VaultParsedIndexChange {
            relative_path: change.relative_path.clone(),
            size: change.size,
            modified_ns: change.modified_ns.clone(),
            content_hash: change.content_hash.clone(),
            expected: change.expected.clone(),
            candidate: Some(candidate),
        }
    }

    #[test]
    fn commit_updates_manifest_candidate_and_index_atomically() {
        let fixture = ScanFixture::one_item("body");
        let scan = scan_vault_item_index_changes_inner(fixture.vault(), false).expect("scan");
        let change = parsed_change(&scan.changes[0], fixture.item_record());

        let report =
            commit_vault_item_index_changes_inner(fixture.vault(), vec![change], Vec::new())
                .expect("commit");

        assert_eq!(report.upserted, 1);
        assert_eq!(
            super::super::list_vault_item_index_inner(fixture.vault()).expect("index"),
            vec![fixture.item_record()]
        );
        fixture.assert_manifest_candidate_matches();
    }

    #[test]
    fn commit_persists_manifest_even_when_frontmatter_has_no_candidate() {
        let fixture = ScanFixture::one_item("body");
        let scan = scan_vault_item_index_changes_inner(fixture.vault(), false).expect("scan");
        let change = VaultParsedIndexChange {
            relative_path: scan.changes[0].relative_path.clone(),
            size: scan.changes[0].size,
            modified_ns: scan.changes[0].modified_ns.clone(),
            content_hash: scan.changes[0].content_hash.clone(),
            expected: None,
            candidate: None,
        };

        let report =
            commit_vault_item_index_changes_inner(fixture.vault(), vec![change], Vec::new())
                .expect("commit");

        assert_eq!(report.upserted, 0);
        assert_eq!(report.deferred, 0);
        let connection = super::super::connect_index_db(&fixture.vault_path).expect("index db");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM document_hashes", [], |row| row.get(0))
            .expect("manifest count");
        assert_eq!(count, 1);
    }

    #[test]
    fn commit_defers_when_manifest_cas_no_longer_matches() {
        let fixture = ScanFixture::one_item("body");
        let scan = scan_vault_item_index_changes_inner(fixture.vault(), false).expect("scan");
        fixture.seed_matching_manifest();
        let change = parsed_change(&scan.changes[0], fixture.item_record());

        let report =
            commit_vault_item_index_changes_inner(fixture.vault(), vec![change], Vec::new())
                .expect("commit");

        assert_eq!(report.upserted, 0);
        assert_eq!(report.deferred, 1);
        assert!(super::super::list_vault_item_index_inner(fixture.vault())
            .expect("index")
            .is_empty());
    }
}
