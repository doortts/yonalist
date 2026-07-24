use crate::notes::error::NotesError;
use cap_fs_ext::DirExt;
use cap_std::fs::{Dir, OpenOptions};
use rusqlite::OptionalExtension;
use std::collections::BTreeSet;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub(crate) const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const LEGACY_UUID_PREFIX_HEX_DIGITS: usize = 15;
const SAFE_UUID_PREFIX_HEX_DIGITS: usize = 13;
const REPAIR_BACKUP_DIRECTORY: &str = "notes-repair-backups";

fn uuid_prefix_sort_key(node_id: &str, digits: usize) -> Result<i64, NotesError> {
    let canonical = Uuid::parse_str(node_id)
        .map_err(|_| "A recovered Notes node ID is invalid.".to_string())?
        .simple()
        .to_string();
    let prefix = u64::from_str_radix(&canonical[..digits], 16)
        .map_err(|_| "A recovered Notes node ID is invalid.".to_string())?;
    i64::try_from(prefix).map_err(|_| {
        "A recovered Notes sort key is too large."
            .to_string()
            .into()
    })
}

pub(crate) fn safe_recovery_sort_key(node_id: &str) -> Result<i64, NotesError> {
    uuid_prefix_sort_key(node_id, SAFE_UUID_PREFIX_HEX_DIGITS)
}

fn legacy_recovery_sort_key(node_id: &str) -> Result<i64, NotesError> {
    uuid_prefix_sort_key(node_id, LEGACY_UUID_PREFIX_HEX_DIGITS)
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotesRepairReport {
    pub(crate) repaired_node_count: usize,
    pub(crate) backed_up_file_count: usize,
    pub(crate) backup_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RepairRow {
    id: String,
    old_sort_key: i64,
    old_hlc: String,
    old_dirty_marked_at: Option<String>,
    new_sort_key: i64,
}

#[derive(Debug)]
struct BackupFile {
    name: PathBuf,
    bytes: Vec<u8>,
}

fn load_repair_rows(connection: &rusqlite::Connection) -> Result<Vec<RepairRow>, String> {
    let unsupported_attachment = connection
        .query_row(
            "SELECT id FROM notes_attachments \
             WHERE sort_key > ?1 OR sort_key < ?2 \
             ORDER BY id LIMIT 1",
            rusqlite::params![JAVASCRIPT_MAX_SAFE_INTEGER, -JAVASCRIPT_MAX_SAFE_INTEGER],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect Notes attachment ordering data: {error}"))?;
    if let Some(attachment_id) = unsupported_attachment {
        return Err(format!(
            "Notes attachment {attachment_id} has an unsupported unsafe attachment sort key."
        ));
    }

    let mut statement = connection
        .prepare(
            "SELECT node.id, node.sort_key, node.hlc, dirty.marked_at \
             FROM notes_nodes node \
             LEFT JOIN sync_dirty_nodes dirty ON dirty.node_id = node.id \
             WHERE node.sort_key > ?1 OR node.sort_key < ?2 \
             ORDER BY node.id",
        )
        .map_err(|error| format!("Could not inspect Notes ordering data: {error}"))?;
    let rows = statement
        .query_map(
            rusqlite::params![JAVASCRIPT_MAX_SAFE_INTEGER, -JAVASCRIPT_MAX_SAFE_INTEGER],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .map_err(|error| format!("Could not read Notes ordering data: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes ordering data: {error}"))?;
    drop(statement);

    rows.into_iter()
        .map(
            |(id, old_sort_key, old_hlc, old_dirty_marked_at)| -> Result<RepairRow, String> {
                let legacy = legacy_recovery_sort_key(&id).map_err(|error| error.to_string())?;
                if old_sort_key != legacy {
                    return Err(format!(
                        "Notes node {id} has an unsupported unsafe sort key."
                    ));
                }
                Ok(RepairRow {
                    new_sort_key: safe_recovery_sort_key(&id).map_err(|error| error.to_string())?,
                    id,
                    old_sort_key,
                    old_hlc,
                    old_dirty_marked_at,
                })
            },
        )
        .collect()
}

fn is_single_markdown_file_name(name: &Path) -> bool {
    name.extension().and_then(|extension| extension.to_str()) == Some("md")
        && matches!(
            name.components().next(),
            Some(std::path::Component::Normal(_))
        )
        && name.components().nth(1).is_none()
}

fn repair_target_file_names(
    connection: &rusqlite::Connection,
    rows: &[RepairRow],
) -> Result<Vec<PathBuf>, String> {
    let mut names = BTreeSet::new();
    for row in rows {
        let deleted = connection
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM notes_nodes WHERE id = ?1",
                [&row.id],
                |record| record.get::<_, bool>(0),
            )
            .map_err(|error| format!("Could not inspect a Notes repair target: {error}"))?;
        let topic_id = if deleted {
            connection
                .query_row(
                    "WITH RECURSIVE ancestors(id, parent_id, deleted_at, depth) AS (\
                       SELECT parent.id, parent.parent_id, parent.deleted_at, 0 \
                       FROM notes_nodes child \
                       JOIN notes_nodes parent ON parent.id = child.parent_id \
                       WHERE child.id = ?1 \
                       UNION ALL \
                       SELECT parent.id, parent.parent_id, parent.deleted_at, ancestors.depth + 1 \
                       FROM notes_nodes parent \
                       JOIN ancestors ON ancestors.parent_id = parent.id \
                       WHERE ancestors.depth < 10000\
                     ) \
                     SELECT id FROM ancestors \
                     WHERE parent_id IS NULL AND deleted_at IS NULL \
                     ORDER BY depth DESC LIMIT 1",
                    [&row.id],
                    |record| record.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| {
                    format!("Could not resolve a deleted Notes repair target: {error}")
                })?
        } else {
            Some(
                connection
                    .query_row(
                        "WITH RECURSIVE ancestors(id, parent_id, depth) AS (\
                           SELECT id, parent_id, 0 FROM notes_nodes WHERE id = ?1 \
                           UNION ALL \
                           SELECT parent.id, parent.parent_id, ancestors.depth + 1 \
                           FROM notes_nodes parent \
                           JOIN ancestors ON ancestors.parent_id = parent.id \
                           WHERE ancestors.depth < 10000\
                         ) \
                         SELECT id FROM ancestors WHERE parent_id IS NULL \
                         ORDER BY depth DESC LIMIT 1",
                        [&row.id],
                        |record| record.get::<_, String>(0),
                    )
                    .map_err(|error| format!("Could not resolve a Notes repair topic: {error}"))?,
            )
        };
        let Some(topic_id) = topic_id else {
            names.insert(PathBuf::from(crate::notes::sync::exporter::TRASH_FILE_NAME));
            continue;
        };
        let assigned = connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [&topic_id],
                |record| record.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Could not load a Notes repair filename: {error}"))?;
        let file_name = match assigned {
            Some(file_name) => file_name,
            None => {
                let title = connection
                    .query_row(
                        "SELECT title FROM notes_nodes WHERE id = ?1",
                        [&topic_id],
                        |record| record.get::<_, String>(0),
                    )
                    .map_err(|error| {
                        format!("Could not load a Notes repair topic title: {error}")
                    })?;
                crate::notes::sync::topic_file::derive_topic_filename(&title, &topic_id)?
            }
        };
        let name = PathBuf::from(file_name);
        if !is_single_markdown_file_name(&name) {
            return Err("A Notes repair target has an invalid filename.".to_string());
        }
        names.insert(name);
    }
    Ok(names.into_iter().collect())
}

fn collect_markdown_backups(
    app_lock: &crate::notes::connection::VaultAppLockGuard,
    target_names: &[PathBuf],
) -> Result<(Vec<BackupFile>, Vec<PathBuf>), String> {
    use crate::file_io::hold_capability_regular_file_bounded_nofollow;
    use crate::notes::markdown_import::MAX_MARKDOWN_BYTES;

    app_lock.revalidate_vault_path()?;
    let vault = app_lock.try_clone_vault()?;
    let mut backups = Vec::new();
    let mut absent = Vec::new();
    for name in target_names {
        if !is_single_markdown_file_name(&name) {
            return Err("A Notes repair target has an invalid filename.".to_string());
        }
        let metadata = match vault.symlink_metadata(name) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                absent.push(name.clone());
                continue;
            }
            Err(error) => return Err(format!("Could not inspect a Notes repair file: {error}")),
        };
        if !metadata.is_file() {
            return Err("A Notes repair target is not a regular file.".to_string());
        }
        let held =
            hold_capability_regular_file_bounded_nofollow(&vault, name, MAX_MARKDOWN_BYTES as u64)
                .map_err(|error| format!("Could not securely open a Notes repair file: {error}"))?;
        let mut bytes = Vec::with_capacity(usize::try_from(held.byte_size()).unwrap_or(0));
        held.reader_from_start()
            .and_then(|mut reader| reader.read_to_end(&mut bytes))
            .map_err(|error| format!("Could not read a Notes repair file: {error}"))?;
        held.verify_at(&vault, name).map_err(|error| {
            format!("A Notes repair file changed while it was being backed up: {error}")
        })?;
        app_lock.revalidate_vault_path()?;
        backups.push(BackupFile {
            name: name.clone(),
            bytes,
        });
    }
    backups.sort_by(|left, right| left.name.cmp(&right.name));
    absent.sort();
    Ok((backups, absent))
}

fn open_backup_root(metadata: &Dir) -> Result<Dir, String> {
    match metadata.create_dir(REPAIR_BACKUP_DIRECTORY) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!(
                "Could not create Notes repair backup storage: {error}"
            ))
        }
    }
    metadata
        .open_dir_nofollow(REPAIR_BACKUP_DIRECTORY)
        .map_err(|error| format!("Could not open Notes repair backup storage: {error}"))
}

fn create_backup(
    vault_path: &str,
    app_lock: &crate::notes::connection::VaultAppLockGuard,
    files: &[BackupFile],
) -> Result<String, String> {
    app_lock.revalidate_metadata_path()?;
    let metadata = app_lock.try_clone_metadata()?;
    let root = open_backup_root(&metadata)?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not timestamp the Notes repair backup: {error}"))?
        .as_millis();
    let directory_name = format!("repair-{millis}-{}", Uuid::new_v4().simple());
    root.create_dir(&directory_name)
        .map_err(|error| format!("Could not create the Notes repair backup: {error}"))?;
    let backup = root
        .open_dir_nofollow(&directory_name)
        .map_err(|error| format!("Could not open the Notes repair backup: {error}"))?;

    for file in files {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut destination = backup
            .open_with(&file.name, &options)
            .map_err(|error| format!("Could not create a Notes repair backup file: {error}"))?;
        destination
            .write_all(&file.bytes)
            .and_then(|()| destination.sync_all())
            .map_err(|error| format!("Could not write a Notes repair backup file: {error}"))?;
        let verified = backup
            .read(&file.name)
            .map_err(|error| format!("Could not verify a Notes repair backup file: {error}"))?;
        if verified != file.bytes {
            return Err("A Notes repair backup file did not verify.".to_string());
        }
        app_lock.revalidate_metadata_path()?;
    }

    Ok(crate::metadata_dir(vault_path)
        .join(REPAIR_BACKUP_DIRECTORY)
        .join(directory_name)
        .to_string_lossy()
        .into_owned())
}

fn apply_repair_rows(
    connection: &mut rusqlite::Connection,
    rows: &[RepairRow],
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin Notes data repair: {error}"))?;
    for row in rows {
        let changed = transaction
            .execute(
                "UPDATE notes_nodes SET sort_key = ?1 \
                 WHERE id = ?2 AND sort_key = ?3 AND hlc = ?4",
                rusqlite::params![row.new_sort_key, row.id, row.old_sort_key, row.old_hlc],
            )
            .map_err(|error| format!("Could not repair Notes ordering data: {error}"))?;
        if changed != 1 {
            return Err(format!(
                "Notes node {} changed before its ordering data could be repaired.",
                row.id
            ));
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit Notes data repair: {error}"))
}

fn restore_repair_rows(
    connection: &mut rusqlite::Connection,
    rows: &[RepairRow],
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not begin Notes repair rollback: {error}"))?;
    for row in rows {
        let changed = transaction
            .execute(
                "UPDATE notes_nodes SET sort_key = ?1, hlc = ?2 \
                 WHERE id = ?3 AND sort_key = ?4",
                rusqlite::params![row.old_sort_key, row.old_hlc, row.id, row.new_sort_key],
            )
            .map_err(|error| format!("Could not roll back Notes ordering data: {error}"))?;
        if changed != 1 {
            return Err(format!(
                "Notes node {} changed before its repair could be rolled back.",
                row.id
            ));
        }
        if let Some(marked_at) = &row.old_dirty_marked_at {
            transaction
                .execute(
                    "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, ?2) \
                     ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                    rusqlite::params![row.id, marked_at],
                )
                .map_err(|error| format!("Could not restore Notes export state: {error}"))?;
        } else {
            transaction
                .execute("DELETE FROM sync_dirty_nodes WHERE node_id = ?1", [&row.id])
                .map_err(|error| format!("Could not restore Notes export state: {error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit Notes repair rollback: {error}"))
}

fn restore_backup_files(
    vault_path: &str,
    app_lock: &crate::notes::connection::VaultAppLockGuard,
    files: &[BackupFile],
    originally_absent: &[PathBuf],
) -> Result<(), String> {
    let vault_root = crate::expand_vault_path(vault_path);
    for file in files {
        app_lock.revalidate_vault_path()?;
        crate::file_io::write_atomic_file(&vault_root.join(&file.name), &file.bytes, true)
            .map_err(|error| format!("Could not restore a Notes repair backup: {error}"))?;
        app_lock.revalidate_vault_path()?;
    }
    let vault = app_lock.try_clone_vault()?;
    for name in originally_absent {
        app_lock.revalidate_vault_path()?;
        match vault.symlink_metadata(name) {
            Ok(metadata) if metadata.is_file() => vault.remove_file(name).map_err(|error| {
                format!("Could not remove a partial Notes repair file: {error}")
            })?,
            Ok(_) => {
                return Err("A partial Notes repair target is no longer a regular file.".to_string())
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Could not inspect a partial Notes repair file: {error}"
                ))
            }
        }
        app_lock.revalidate_vault_path()?;
    }
    Ok(())
}

fn validate_safe_ordering(connection: &rusqlite::Connection) -> Result<(), String> {
    let unsafe_count = connection
        .query_row(
            "SELECT (\
               SELECT COUNT(*) FROM notes_nodes \
               WHERE sort_key > ?1 OR sort_key < ?2\
             ) + (\
               SELECT COUNT(*) FROM notes_attachments \
               WHERE sort_key > ?1 OR sort_key < ?2\
             )",
            rusqlite::params![JAVASCRIPT_MAX_SAFE_INTEGER, -JAVASCRIPT_MAX_SAFE_INTEGER],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Could not validate repaired Notes ordering data: {error}"))?;
    if unsafe_count != 0 {
        return Err("Notes data repair left unsafe ordering data behind.".to_string());
    }
    Ok(())
}

pub(crate) fn repair_legacy_recovery_sort_keys(
    vault_path: &str,
    app_lock: &crate::notes::connection::VaultAppLockGuard,
    mut flush: impl FnMut() -> Result<(), String>,
) -> Result<NotesRepairReport, String> {
    app_lock.revalidate_vault_path()?;
    let shared = crate::notes::connection::acquire_notes_connection(vault_path)?;
    let connection = crate::notes::connection::lock_notes_connection(&shared)?;
    let rows = load_repair_rows(&connection)?;
    if rows.is_empty() {
        return Ok(NotesRepairReport {
            repaired_node_count: 0,
            backed_up_file_count: 0,
            backup_path: None,
        });
    }
    drop(connection);
    drop(shared);

    flush()
        .map_err(|error| format!("Could not flush pending Notes data before repair: {error}"))?;
    app_lock.revalidate_vault_path()?;
    let shared = crate::notes::connection::acquire_notes_connection(vault_path)?;
    let mut connection = crate::notes::connection::lock_notes_connection(&shared)?;
    let rows = load_repair_rows(&connection)?;
    if rows.is_empty() {
        return Ok(NotesRepairReport {
            repaired_node_count: 0,
            backed_up_file_count: 0,
            backup_path: None,
        });
    }

    let target_names = repair_target_file_names(&connection, &rows)?;
    let (backup_files, originally_absent) = collect_markdown_backups(app_lock, &target_names)?;
    let backup_path = create_backup(vault_path, app_lock, &backup_files)?;
    apply_repair_rows(&mut connection, &rows)?;
    drop(connection);
    drop(shared);

    let operation_result = flush().and_then(|()| {
        app_lock.revalidate_vault_path()?;
        let shared = crate::notes::connection::acquire_notes_connection(vault_path)?;
        let connection = crate::notes::connection::lock_notes_connection(&shared)?;
        validate_safe_ordering(&connection)
    });
    if let Err(operation_error) = operation_result {
        let rollback_result = (|| {
            app_lock.revalidate_vault_path()?;
            let shared = crate::notes::connection::acquire_notes_connection(vault_path)?;
            let mut connection = crate::notes::connection::lock_notes_connection(&shared)?;
            restore_repair_rows(&mut connection, &rows)?;
            drop(connection);
            restore_backup_files(vault_path, app_lock, &backup_files, &originally_absent)
        })();
        return match rollback_result {
            Ok(()) => Err(format!("{operation_error} Backup: {backup_path}")),
            Err(rollback_error) => Err(format!(
                "{operation_error} Backup: {backup_path}. Rollback also failed: {rollback_error}"
            )),
        };
    }

    Ok(NotesRepairReport {
        repaired_node_count: rows.len(),
        backed_up_file_count: backup_files.len(),
        backup_path: Some(backup_path),
    })
}

#[cfg(test)]
mod tests {
    use super::{legacy_recovery_sort_key, safe_recovery_sort_key, JAVASCRIPT_MAX_SAFE_INTEGER};
    use crate::notes::connection::{
        acquire_notes_connection, acquire_vault_app_lock, evict_notes_connection,
        lock_notes_connection,
    };
    use crate::notes::repository::create_node;
    use crate::notes::sync::bootstrap::flush_pending;
    use crate::notes::types::{CreateNodeInput, NoteMarkerKind};
    use std::fs;
    use std::path::{Path, PathBuf};

    const UNSAFE_ID: &str = "a463bd35-2362-43fd-a784-bcad33920222";

    #[test]
    fn recovery_sort_keys_stay_javascript_safe() {
        let legacy = legacy_recovery_sort_key(UNSAFE_ID).expect("legacy key");
        let safe = safe_recovery_sort_key(UNSAFE_ID).expect("safe key");

        assert!(legacy > JAVASCRIPT_MAX_SAFE_INTEGER);
        assert!(safe <= JAVASCRIPT_MAX_SAFE_INTEGER);
        assert_eq!(safe, 2_891_972_529_501_732);
    }

    #[test]
    fn truncating_the_uuid_prefix_preserves_recovery_order() {
        let first = "26feb39b-1698-4060-b0e6-c8e8d67f28da";
        let second = "a463bd35-2362-43fd-a784-bcad33920222";

        assert_eq!(
            legacy_recovery_sort_key(first)
                .unwrap()
                .cmp(&legacy_recovery_sort_key(second).unwrap()),
            safe_recovery_sort_key(first)
                .unwrap()
                .cmp(&safe_recovery_sort_key(second).unwrap())
        );
    }

    fn seed_repair_topic(vault_path: &str, node_id: &str, sort_key: i64) -> PathBuf {
        let shared = acquire_notes_connection(vault_path).expect("open repair database");
        let mut connection = lock_notes_connection(&shared).expect("lock repair database");
        create_node(
            &mut connection,
            CreateNodeInput {
                id: node_id.to_string(),
                parent_id: None,
                after_id: None,
                title: "Repair target".to_string(),
                note: "Preserve me".to_string(),
                marker_kind: NoteMarkerKind::Bullet,
            },
        )
        .expect("seed repair node");
        connection
            .execute(
                "UPDATE notes_nodes SET sort_key = ?1 WHERE id = ?2",
                rusqlite::params![sort_key, node_id],
            )
            .expect("seed repair sort key");
        flush_pending(&mut connection, Path::new(vault_path)).expect("seed repair export");
        let file_name = connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [node_id],
                |row| row.get::<_, String>(0),
            )
            .expect("repair topic filename");
        Path::new(vault_path).join(file_name)
    }

    fn workspace_sort_key(vault_path: &str, node_id: &str) -> i64 {
        let shared = acquire_notes_connection(vault_path).expect("open repair database");
        let connection = lock_notes_connection(&shared).expect("lock repair database");
        connection
            .query_row(
                "SELECT sort_key FROM notes_nodes WHERE id = ?1",
                [node_id],
                |row| row.get(0),
            )
            .expect("repair node sort key")
    }

    #[test]
    fn repairs_only_legacy_unsafe_keys_and_backups_the_export() {
        let vault = tempfile::tempdir().expect("temp vault");
        let vault_path = vault.path().to_string_lossy().into_owned();
        let topic = seed_repair_topic(
            &vault_path,
            UNSAFE_ID,
            legacy_recovery_sort_key(UNSAFE_ID).unwrap(),
        );
        let original = fs::read(&topic).expect("original topic");
        let app_lock = acquire_vault_app_lock(&vault_path).expect("app lock");
        let state = crate::notes::sync::runtime::SyncState::default();
        let flush_vault = vault_path.clone();

        let report = super::repair_legacy_recovery_sort_keys(&vault_path, &app_lock, || {
            crate::notes::sync::runtime::flush_sync(&state, flush_vault.clone())
        })
        .expect("repair");

        assert_eq!(report.repaired_node_count, 1);
        assert_eq!(report.backed_up_file_count, 1);
        let backup = PathBuf::from(report.backup_path.expect("backup path"))
            .join(topic.file_name().expect("topic filename"));
        assert_eq!(fs::read(backup).unwrap(), original);
        assert!(workspace_sort_key(&vault_path, UNSAFE_ID) <= JAVASCRIPT_MAX_SAFE_INTEGER);
        assert!(fs::read_to_string(topic)
            .unwrap()
            .contains("sort_key: 2891972529501732"));
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn flushes_pending_exports_before_backing_up_or_changing_repair_rows() {
        let vault = tempfile::tempdir().expect("temp vault");
        let vault_path = vault.path().to_string_lossy().into_owned();
        let legacy = legacy_recovery_sort_key(UNSAFE_ID).unwrap();
        seed_repair_topic(&vault_path, UNSAFE_ID, legacy);
        let app_lock = acquire_vault_app_lock(&vault_path).expect("app lock");
        let state = crate::notes::sync::runtime::SyncState::default();
        let flush_vault = vault_path.clone();
        let backup_root = vault
            .path()
            .join(".yonalist")
            .join(super::REPAIR_BACKUP_DIRECTORY);
        let mut flush_count = 0;

        super::repair_legacy_recovery_sort_keys(&vault_path, &app_lock, || {
            flush_count += 1;
            if flush_count == 1 {
                assert_eq!(workspace_sort_key(&vault_path, UNSAFE_ID), legacy);
                assert!(
                    !backup_root.exists(),
                    "preflight flush must run before backup creation"
                );
            } else {
                assert!(workspace_sort_key(&vault_path, UNSAFE_ID) <= JAVASCRIPT_MAX_SAFE_INTEGER);
            }
            crate::notes::sync::runtime::flush_sync(&state, flush_vault.clone())
        })
        .expect("repair");

        assert_eq!(flush_count, 2);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn second_repair_is_a_no_op_without_a_backup() {
        let vault = tempfile::tempdir().expect("temp vault");
        let vault_path = vault.path().to_string_lossy().into_owned();
        seed_repair_topic(
            &vault_path,
            UNSAFE_ID,
            legacy_recovery_sort_key(UNSAFE_ID).unwrap(),
        );
        let state = crate::notes::sync::runtime::SyncState::default();
        let app_lock = acquire_vault_app_lock(&vault_path).expect("app lock");
        let flush_vault = vault_path.clone();
        super::repair_legacy_recovery_sort_keys(&vault_path, &app_lock, || {
            crate::notes::sync::runtime::flush_sync(&state, flush_vault.clone())
        })
        .expect("first repair");

        let second_flush_vault = vault_path.clone();
        let second = super::repair_legacy_recovery_sort_keys(&vault_path, &app_lock, || {
            crate::notes::sync::runtime::flush_sync(&state, second_flush_vault.clone())
        })
        .expect("second repair");

        assert_eq!(
            second,
            super::NotesRepairReport {
                repaired_node_count: 0,
                backed_up_file_count: 0,
                backup_path: None,
            }
        );
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn unrelated_unsafe_key_aborts_without_changes() {
        let vault = tempfile::tempdir().expect("temp vault");
        let vault_path = vault.path().to_string_lossy().into_owned();
        let unsupported = JAVASCRIPT_MAX_SAFE_INTEGER + 1;
        let topic = seed_repair_topic(&vault_path, UNSAFE_ID, unsupported);
        let original = fs::read(&topic).expect("original topic");
        let app_lock = acquire_vault_app_lock(&vault_path).expect("app lock");

        let result = super::repair_legacy_recovery_sort_keys(&vault_path, &app_lock, || {
            panic!("unsupported data must abort before export")
        });

        assert!(result.unwrap_err().contains("unsupported unsafe sort key"));
        assert_eq!(workspace_sort_key(&vault_path, UNSAFE_ID), unsupported);
        assert_eq!(fs::read(topic).unwrap(), original);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn unrelated_unsafe_attachment_key_aborts_without_changes() {
        let vault = tempfile::tempdir().expect("temp vault");
        let vault_path = vault.path().to_string_lossy().into_owned();
        let legacy = legacy_recovery_sort_key(UNSAFE_ID).unwrap();
        let topic = seed_repair_topic(&vault_path, UNSAFE_ID, legacy);
        let original = fs::read(&topic).expect("original topic");
        let shared = acquire_notes_connection(&vault_path).expect("open repair database");
        let connection = lock_notes_connection(&shared).expect("lock repair database");
        connection
            .execute(
                "INSERT INTO notes_attachments(\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'image/png', 1, 1, 1, 1, ?7, ?7)",
                rusqlite::params![
                    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    UNSAFE_ID,
                    JAVASCRIPT_MAX_SAFE_INTEGER + 1,
                    "notes-assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "image.png",
                    "2026-07-25T00:00:00.000Z",
                ],
            )
            .expect("seed unsupported attachment sort key");
        drop(connection);
        drop(shared);
        let app_lock = acquire_vault_app_lock(&vault_path).expect("app lock");

        let result = super::repair_legacy_recovery_sort_keys(&vault_path, &app_lock, || {
            panic!("unsupported attachment data must abort before export")
        });

        assert!(result
            .unwrap_err()
            .contains("unsupported unsafe attachment sort key"));
        assert_eq!(workspace_sort_key(&vault_path, UNSAFE_ID), legacy);
        assert_eq!(fs::read(topic).unwrap(), original);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn failed_export_restores_old_database_and_file_bytes() {
        let vault = tempfile::tempdir().expect("temp vault");
        let vault_path = vault.path().to_string_lossy().into_owned();
        let legacy = legacy_recovery_sort_key(UNSAFE_ID).unwrap();
        let topic = seed_repair_topic(&vault_path, UNSAFE_ID, legacy);
        let original = fs::read(&topic).expect("original topic");
        let app_lock = acquire_vault_app_lock(&vault_path).expect("app lock");
        let mut flush_count = 0;

        let result = super::repair_legacy_recovery_sort_keys(&vault_path, &app_lock, || {
            flush_count += 1;
            if flush_count == 1 {
                Ok(())
            } else {
                Err("injected export failure".to_string())
            }
        });

        let error = result.expect_err("export failure");
        assert!(error.contains("injected export failure"));
        assert!(error.contains("notes-repair-backups"));
        assert_eq!(workspace_sort_key(&vault_path, UNSAFE_ID), legacy);
        assert_eq!(fs::read(topic).unwrap(), original);
        evict_notes_connection(&vault_path);
    }

    #[test]
    fn failed_export_removes_a_repair_target_that_was_originally_absent() {
        let vault = tempfile::tempdir().expect("temp vault");
        let vault_path = vault.path().to_string_lossy().into_owned();
        let legacy = legacy_recovery_sort_key(UNSAFE_ID).unwrap();
        let topic = seed_repair_topic(&vault_path, UNSAFE_ID, legacy);
        fs::remove_file(&topic).expect("remove topic before repair");
        let app_lock = acquire_vault_app_lock(&vault_path).expect("app lock");
        let partial_topic = topic.clone();
        let mut flush_count = 0;

        let result = super::repair_legacy_recovery_sort_keys(&vault_path, &app_lock, || {
            flush_count += 1;
            if flush_count == 1 {
                Ok(())
            } else {
                fs::write(&partial_topic, b"partial repair output").expect("write partial topic");
                Err("injected partial export failure".to_string())
            }
        });

        let error = result.expect_err("partial export failure");
        assert!(error.contains("injected partial export failure"));
        assert_eq!(workspace_sort_key(&vault_path, UNSAFE_ID), legacy);
        assert!(
            !topic.exists(),
            "rollback must remove a target created by the failed export"
        );
        evict_notes_connection(&vault_path);
    }
}
