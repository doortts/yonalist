use crate::file_io::{
    capability_file_link_count, hold_capability_regular_file_bounded_nofollow,
    HeldBoundedCapabilityFile,
};
use crate::notes::markdown_import::MAX_MARKDOWN_BYTES;
use crate::notes::sync::topic_file::TopicFile;
use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

const SYNC_CLEANUP_DIRECTORY: &str = "sync-cleanup";

#[cfg(test)]
thread_local! {
    static AFTER_MAINTENANCE_APP_LOCK_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static AFTER_SYNC_FILE_CLASSIFICATION_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static BEFORE_BOOTSTRAP_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static BEFORE_SYNC_FILE_REMOVAL_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static BEFORE_SYNC_CLEANUP_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static BEFORE_SYNC_CLEANUP_REMOVAL_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn inject_after_maintenance_app_lock_once(action: impl FnOnce() + 'static) {
    AFTER_MAINTENANCE_APP_LOCK_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn inject_after_sync_file_classification_once(action: impl FnOnce() + 'static) {
    AFTER_SYNC_FILE_CLASSIFICATION_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn inject_before_bootstrap_once(action: impl FnOnce() + 'static) {
    BEFORE_BOOTSTRAP_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn inject_before_sync_file_removal_once(action: impl FnOnce() + 'static) {
    BEFORE_SYNC_FILE_REMOVAL_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn inject_before_sync_cleanup_open_once(action: impl FnOnce() + 'static) {
    BEFORE_SYNC_CLEANUP_OPEN_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn inject_before_sync_cleanup_removal_once(action: impl FnOnce() + 'static) {
    BEFORE_SYNC_CLEANUP_REMOVAL_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(action)));
}

#[cfg(test)]
fn maybe_inject_before_sync_file_removal() {
    BEFORE_SYNC_FILE_REMOVAL_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn maybe_inject_after_maintenance_app_lock() {
    AFTER_MAINTENANCE_APP_LOCK_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_after_maintenance_app_lock() {}

#[cfg(test)]
fn maybe_inject_after_sync_file_classification() {
    AFTER_SYNC_FILE_CLASSIFICATION_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_after_sync_file_classification() {}

#[cfg(test)]
fn maybe_inject_before_bootstrap() {
    BEFORE_BOOTSTRAP_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_bootstrap() {}

#[cfg(not(test))]
fn maybe_inject_before_sync_file_removal() {}

#[cfg(test)]
fn maybe_inject_before_sync_cleanup_open() {
    BEFORE_SYNC_CLEANUP_OPEN_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_sync_cleanup_open() {}

#[cfg(test)]
fn maybe_inject_before_sync_cleanup_removal() {
    BEFORE_SYNC_CLEANUP_REMOVAL_HOOK.with(|hook| {
        if let Some(action) = hook.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_sync_cleanup_removal() {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NotesMaintenanceMode {
    ResetDatabase,
    DeleteAll,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct NotesMaintenanceOutcome {
    pub(crate) attachment_cleanup_failed: bool,
}

struct OwnedSyncFile {
    name: PathBuf,
    held: HeldBoundedCapabilityFile,
}

struct OwnedSyncFiles {
    vault: Dir,
    files: Vec<OwnedSyncFile>,
}

pub(crate) fn rebuild_notes_storage(
    vault_path: &str,
    mode: NotesMaintenanceMode,
) -> Result<NotesMaintenanceOutcome, String> {
    crate::notes::repository::validate_vault_path(vault_path)?;
    let app_lock = crate::notes::connection::acquire_vault_app_lock(vault_path)?;
    maybe_inject_after_maintenance_app_lock();
    app_lock.revalidate_vault_path()?;
    let deletion_guard = crate::notes::connection::begin_notes_database_deletion(vault_path)?;
    let owned_files = match mode {
        NotesMaintenanceMode::ResetDatabase => None,
        NotesMaintenanceMode::DeleteAll => {
            app_lock.revalidate_vault_path()?;
            Some(collect_owned_sync_files(app_lock.try_clone_vault()?)?)
        }
    };
    maybe_inject_after_sync_file_classification();
    // Reset must remain callable while legacy v1 blocks attachment storage.
    let storage = match mode {
        NotesMaintenanceMode::ResetDatabase => None,
        NotesMaintenanceMode::DeleteAll => {
            app_lock.revalidate_vault_path()?;
            Some(
                crate::notes::attachments::AttachmentStorageLease::acquire_with_app_lock(
                    vault_path, &app_lock,
                )?,
            )
        }
    };
    crate::notes::repository::delete_database_with_app_lock(vault_path, &app_lock)?;
    crate::notes::repository::delete_legacy_database_with_app_lock(vault_path, &app_lock)?;
    if let Some(owned_files) = owned_files {
        remove_owned_sync_files(&app_lock, owned_files)?;
        app_lock.revalidate_vault_path()?;
        let metadata = app_lock.try_clone_metadata()?;
        remove_owned_sync_cleanup_files(&app_lock, &metadata)?;
    }
    let attachment_cleanup_failed = match storage {
        Some(storage) => {
            app_lock.revalidate_vault_path()?;
            storage.delete_attachment_files().is_err()
        }
        None => false,
    };
    maybe_inject_before_bootstrap();
    app_lock.revalidate_vault_path()?;
    deletion_guard.with_maintenance_access(|| {
        crate::notes::sync::bootstrap::reconcile_startup_during_maintenance(vault_path, &app_lock)
    })?;
    drop(deletion_guard);
    Ok(NotesMaintenanceOutcome {
        attachment_cleanup_failed,
    })
}

fn collect_owned_sync_files(vault: Dir) -> Result<OwnedSyncFiles, String> {
    let entries = vault
        .entries()
        .map_err(|error| format!("Could not inspect Notes vault files for maintenance: {error}"))?;
    let mut owned_files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!("Could not inspect a Notes vault entry for maintenance: {error}")
        })?;
        let name = PathBuf::from(entry.file_name());
        if name.extension().and_then(|extension| extension.to_str()) != Some("md")
            || !is_single_file_name(&name)
        {
            continue;
        }
        let metadata = vault.symlink_metadata(&name).map_err(|error| {
            format!("Could not inspect a Notes markdown file for maintenance: {error}")
        })?;
        if !metadata.is_file() {
            continue;
        }
        let held =
            hold_capability_regular_file_bounded_nofollow(&vault, &name, MAX_MARKDOWN_BYTES as u64)
                .map_err(|error| {
                    format!("Could not securely read a Notes markdown file: {error}")
                })?;
        let mut bytes = Vec::with_capacity(usize::try_from(held.byte_size()).unwrap_or(0));
        held.reader_from_start()
            .and_then(|mut reader| reader.read_to_end(&mut bytes))
            .map_err(|error| format!("Could not read a Notes markdown file: {error}"))?;
        held.verify_at(&vault, &name).map_err(|error| {
            format!("A Notes markdown file changed while it was being classified: {error}")
        })?;
        if matches!(
            parse_topic_file(&bytes),
            TopicParseOutcome::Parsed(TopicFile::Topic(_) | TopicFile::Trash(_))
        ) {
            owned_files.push(OwnedSyncFile { name, held });
        }
    }
    Ok(OwnedSyncFiles {
        vault,
        files: owned_files,
    })
}

fn remove_owned_sync_files(
    app_lock: &crate::notes::connection::VaultAppLockGuard,
    owned_files: OwnedSyncFiles,
) -> Result<(), String> {
    let OwnedSyncFiles { vault, files } = owned_files;
    for OwnedSyncFile { name, held } in files {
        maybe_inject_before_sync_file_removal();
        app_lock.revalidate_vault_path()?;
        retire_verified_regular_file(&vault, &name, held, "Notes sync file")?;
    }
    Ok(())
}

fn remove_owned_sync_cleanup_files(
    app_lock: &crate::notes::connection::VaultAppLockGuard,
    metadata: &Dir,
) -> Result<(), String> {
    maybe_inject_before_sync_cleanup_open();
    app_lock.revalidate_vault_path()?;
    let cleanup = match metadata.open_dir_nofollow(SYNC_CLEANUP_DIRECTORY) {
        Ok(cleanup) => cleanup,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "The Notes cleanup storage must be an owned directory, not a symlink: {error}"
            ))
        }
    };
    let entries = cleanup
        .entries()
        .map_err(|error| format!("Could not inspect Notes cleanup storage: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not inspect a Notes cleanup entry: {error}"))?;
        let name = PathBuf::from(entry.file_name());
        if !is_sync_cleanup_staging_name(&name) {
            continue;
        }
        let metadata = cleanup
            .symlink_metadata(&name)
            .map_err(|error| format!("Could not inspect a Notes cleanup staging file: {error}"))?;
        if !metadata.is_file() {
            continue;
        }
        let held = hold_capability_regular_file_bounded_nofollow(
            &cleanup,
            &name,
            MAX_MARKDOWN_BYTES as u64,
        )
        .map_err(|error| {
            format!("Could not securely open a Notes cleanup staging file: {error}")
        })?;
        maybe_inject_before_sync_cleanup_removal();
        app_lock.revalidate_vault_path()?;
        retire_verified_regular_file(&cleanup, &name, held, "Notes cleanup staging file")?;
    }
    Ok(())
}

fn retire_verified_regular_file(
    parent: &Dir,
    name: &Path,
    held: HeldBoundedCapabilityFile,
    description: &str,
) -> Result<(), String> {
    let metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect a held {description}: {error}"))?;
    if capability_file_link_count(&metadata)
        .map_err(|error| format!("Could not inspect a held {description} link count: {error}"))?
        != 1
    {
        return Err(format!(
            "The {description} must not have multiple hard links."
        ));
    }
    let mut validate_directories = || Ok(());
    crate::notes::sync::asset_gc::logical_retire_noreplace(
        parent,
        name,
        held,
        None,
        None,
        &mut validate_directories,
    )
    .map_err(|error| format!("Could not retire the {description}: {error}"))
}

fn is_single_file_name(name: &Path) -> bool {
    matches!(
        name.components().next(),
        Some(std::path::Component::Normal(_))
    ) && name.components().nth(1).is_none()
}

fn is_sync_cleanup_staging_name(name: &Path) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let Some(digest) = name.strip_suffix(".pending") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::{
        inject_after_maintenance_app_lock_once, inject_after_sync_file_classification_once,
        inject_before_bootstrap_once, inject_before_sync_cleanup_open_once,
        inject_before_sync_cleanup_removal_once, inject_before_sync_file_removal_once,
        rebuild_notes_storage, NotesMaintenanceMode,
    };
    use crate::notes::connection::{acquire_notes_connection, lock_notes_connection};
    use crate::notes::repository::notes_db_path;
    use crate::notes::sync::bootstrap::{
        flush_pending, inject_startup_before_flush_hook, reconcile_startup,
    };
    use crate::notes::sync::topic_file::{
        render_topic_doc, TopicContent, TopicDoc, TopicNode, TopicRoot,
    };
    use rusqlite::{params, Connection};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    const TOPIC_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const HLC_1: &str = "000000001-00-a3f2";
    const HLC_2: &str = "000000002-00-a3f2";
    const ONBOARDING_TITLE: &str = "Yonalist Notes 시작하기";

    fn topic(title: &str) -> TopicDoc {
        TopicDoc {
            id: TOPIC_ID.to_string(),
            sort_key: 1024,
            max_hlc: HLC_2.to_string(),
            root: TopicRoot {
                title: title.to_string(),
                hlc: HLC_1.to_string(),
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

    fn vault_path(vault: &tempfile::TempDir) -> String {
        vault.path().to_string_lossy().into_owned()
    }

    fn node_count(vault_path: &str, predicate: &str) -> i64 {
        let shared = crate::notes::connection::acquire_notes_connection(vault_path).unwrap();
        let connection = crate::notes::connection::lock_notes_connection(&shared).unwrap();
        connection
            .query_row(
                &format!("SELECT COUNT(*) FROM notes_nodes WHERE {predicate}"),
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn assert_one_onboarding_set(vault_path: &str) {
        assert_eq!(node_count(vault_path, "1 = 1"), 7);
        assert_eq!(
            node_count(
                vault_path,
                &format!("parent_id IS NULL AND title = '{ONBOARDING_TITLE}'"),
            ),
            1
        );
    }

    fn insert_late_export_fixture(vault_path: &str) {
        let shared = acquire_notes_connection(vault_path).expect("initialize late export fixture");
        let connection = lock_notes_connection(&shared).expect("lock late export fixture");
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, note, created_at, updated_at, hlc\
                 ) VALUES (?1, NULL, 1024, 'Late export', '', \
                           '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', ?2)",
                params!["33333333-3333-4333-8333-333333333333", HLC_2],
            )
            .expect("insert late export topic");
        connection
            .execute(
                "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1)",
                ["33333333-3333-4333-8333-333333333333"],
            )
            .expect("mark late export topic dirty");
    }

    #[test]
    fn database_reset_preserves_sync_files_and_reimports_them() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        let topic_path = vault.path().join("Imported.11111111.md");
        let topic_bytes = render_topic_doc(&topic("Imported")).expect("render topic");
        let ordinary_path = vault.path().join("ordinary.md");
        let ordinary_bytes = b"ordinary Markdown must remain untouched";
        fs::write(&topic_path, &topic_bytes).expect("write topic");
        fs::write(&ordinary_path, ordinary_bytes).expect("write ordinary file");
        reconcile_startup(&vault_path).expect("initialize fixture database");

        rebuild_notes_storage(&vault_path, NotesMaintenanceMode::ResetDatabase)
            .expect("reset database");

        assert_eq!(fs::read(&topic_path).expect("read topic"), topic_bytes);
        assert_eq!(
            fs::read(&ordinary_path).expect("read ordinary file"),
            ordinary_bytes
        );
        assert_eq!(node_count(&vault_path, "title = 'Imported'"), 1);
    }

    #[test]
    fn full_delete_removes_owned_notes_files_but_recreates_onboarding() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        let topic_path = vault.path().join("Imported.11111111.md");
        let topic_bytes = render_topic_doc(&topic("Imported")).expect("render topic");
        let ordinary_path = vault.path().join("ordinary.md");
        let ordinary_bytes = b"ordinary Markdown must remain untouched";
        fs::write(&topic_path, topic_bytes).expect("write topic");
        fs::write(&ordinary_path, ordinary_bytes).expect("write ordinary file");
        reconcile_startup(&vault_path).expect("initialize fixture database");

        rebuild_notes_storage(&vault_path, NotesMaintenanceMode::DeleteAll)
            .expect("delete all Notes storage");

        assert!(!topic_path.exists(), "the owned topic must be removed");
        assert_eq!(
            fs::read(&ordinary_path).expect("read ordinary file"),
            ordinary_bytes
        );
        assert_one_onboarding_set(&vault_path);
    }

    #[cfg(unix)]
    #[test]
    fn full_delete_rejects_an_early_vault_path_swap() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().expect("create sandbox");
        let vault = sandbox.path().join("vault");
        let displaced_vault = sandbox.path().join("displaced-vault");
        let outside = sandbox.path().join("outside");
        let topic_path = vault.join("Imported.11111111.md");
        fs::create_dir_all(&vault).expect("create vault");
        fs::create_dir_all(&outside).expect("create outside vault");
        fs::write(
            &topic_path,
            render_topic_doc(&topic("Imported")).expect("render topic"),
        )
        .expect("write topic");
        let vault_path = vault.to_string_lossy().into_owned();
        let vault_for_hook = vault.clone();
        let displaced_for_hook = displaced_vault.clone();
        let outside_for_hook = outside.clone();
        inject_after_maintenance_app_lock_once(move || {
            fs::rename(&vault_for_hook, &displaced_for_hook).expect("relocate vault");
            symlink(&outside_for_hook, &vault_for_hook).expect("redirect vault path");
        });

        let result = rebuild_notes_storage(&vault_path, NotesMaintenanceMode::DeleteAll);

        assert!(result.is_err(), "swapped vault unexpectedly accepted");
        assert!(
            displaced_vault.join("Imported.11111111.md").exists(),
            "the original vault must not be modified after an early path swap"
        );
        assert!(
            !outside.join("Imported.11111111.md").exists(),
            "the replacement vault must not receive the original topic"
        );
    }

    #[cfg(unix)]
    #[test]
    fn full_delete_rejects_a_vault_swap_after_classification() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().expect("create sandbox");
        let vault = sandbox.path().join("vault");
        let displaced_vault = sandbox.path().join("displaced-vault");
        let outside = sandbox.path().join("outside");
        let topic_path = vault.join("Imported.11111111.md");
        fs::create_dir_all(&vault).expect("create vault");
        fs::create_dir_all(&outside).expect("create outside vault");
        fs::write(
            &topic_path,
            render_topic_doc(&topic("Imported")).expect("render topic"),
        )
        .expect("write topic");
        let vault_path = vault.to_string_lossy().into_owned();
        let vault_for_hook = vault.clone();
        let displaced_for_hook = displaced_vault.clone();
        let outside_for_hook = outside.clone();
        inject_after_sync_file_classification_once(move || {
            fs::rename(&vault_for_hook, &displaced_for_hook).expect("relocate classified vault");
            symlink(&outside_for_hook, &vault_for_hook).expect("redirect vault path");
        });

        let result = rebuild_notes_storage(&vault_path, NotesMaintenanceMode::DeleteAll);

        assert!(
            result.is_err(),
            "split vault maintenance unexpectedly succeeded"
        );
        assert!(
            displaced_vault.join("Imported.11111111.md").exists(),
            "the classified topic must remain when the vault identity changes"
        );
        assert!(
            !outside.join("Imported.11111111.md").exists(),
            "the replacement vault must remain unrelated"
        );
    }

    #[test]
    fn full_delete_rejects_a_metadata_identity_replacement_before_cleanup() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        let replacement_name = format!("{}.pending", "d".repeat(64));
        let metadata = vault.path().join(".yonalist");
        let displaced_metadata = vault.path().join(".yonalist-displaced");
        let original_staging = metadata
            .join("sync-cleanup")
            .join(format!("{}.pending", "e".repeat(64)));
        fs::create_dir_all(original_staging.parent().expect("original staging parent"))
            .expect("create original staging");
        fs::write(&original_staging, b"original staging").expect("write original staging");
        let replacement_staging = metadata.join("sync-cleanup").join(&replacement_name);
        let metadata_for_hook = metadata.clone();
        let displaced_for_hook = displaced_metadata.clone();
        let replacement_for_hook = replacement_staging.clone();
        inject_before_sync_cleanup_open_once(move || {
            fs::rename(&metadata_for_hook, &displaced_for_hook)
                .expect("replace the held metadata directory");
            fs::create_dir_all(replacement_for_hook.parent().expect("replacement parent"))
                .expect("create replacement metadata directory");
            fs::write(&replacement_for_hook, b"replacement staging")
                .expect("write replacement staging");
        });

        let result = rebuild_notes_storage(&vault_path, NotesMaintenanceMode::DeleteAll);

        assert!(
            result.is_err(),
            "replaced metadata identity unexpectedly accepted"
        );
        assert_eq!(
            fs::read(&replacement_staging).expect("read replacement staging"),
            b"replacement staging"
        );
        assert!(
            displaced_metadata
                .join("sync-cleanup")
                .join(format!("{}.pending", "e".repeat(64)))
                .exists(),
            "the displaced metadata staging must remain untouched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn full_delete_rejects_an_app_lock_identity_replacement_before_cleanup() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        let metadata = vault.path().join(".yonalist");
        let staging_path = metadata
            .join("sync-cleanup")
            .join(format!("{}.pending", "f".repeat(64)));
        fs::create_dir_all(staging_path.parent().expect("staging parent"))
            .expect("create staging storage");
        fs::write(&staging_path, b"owned staging").expect("write staging file");
        let lock_path = metadata.join(crate::notes::attachments::VAULT_APP_LOCK_NAME);
        inject_before_sync_cleanup_open_once(move || {
            fs::remove_file(&lock_path).expect("replace held app lock");
            fs::write(&lock_path, b"replacement lock").expect("write replacement app lock");
        });

        let result = rebuild_notes_storage(&vault_path, NotesMaintenanceMode::DeleteAll);

        assert!(
            result.is_err(),
            "replacement app lock unexpectedly accepted"
        );
        assert!(
            staging_path.exists(),
            "cleanup must not continue after the app-lock identity changes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn database_reset_rejects_a_vault_swap_before_startup_export() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().expect("create sandbox");
        let vault = sandbox.path().join("vault");
        let displaced_vault = sandbox.path().join("displaced-vault");
        let outside = sandbox.path().join("outside");
        let topic_path = vault.join("Imported.11111111.md");
        fs::create_dir_all(&vault).expect("create vault");
        fs::create_dir_all(&outside).expect("create outside vault");
        let rendered =
            String::from_utf8(render_topic_doc(&topic("Imported")).expect("render topic"))
                .expect("topic bytes are UTF-8");
        let imported = rendered.replace(&format!(" <!-- yid: {CHILD_ID} t: {HLC_2} -->"), "");
        fs::write(&topic_path, imported).expect("write topic");
        let vault_path = vault.to_string_lossy().into_owned();
        let vault_for_hook = vault.clone();
        let displaced_for_hook = displaced_vault.clone();
        let outside_for_hook = outside.clone();
        inject_startup_before_flush_hook(move || {
            fs::rename(&vault_for_hook, &displaced_for_hook)
                .expect("relocate vault before startup export");
            symlink(&outside_for_hook, &vault_for_hook).expect("redirect vault path");
        });

        let result = rebuild_notes_storage(&vault_path, NotesMaintenanceMode::ResetDatabase);

        assert!(
            result.is_err(),
            "swapped bootstrap vault unexpectedly accepted"
        );
        assert!(
            displaced_vault.join("Imported.11111111.md").exists(),
            "the original topic must remain in the displaced vault"
        );
        assert!(
            !outside.join("Imported.11111111.md").exists(),
            "startup must not export into the replacement vault"
        );
    }

    #[test]
    fn full_delete_blocks_an_exporter_started_after_classification() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        insert_late_export_fixture(&vault_path);
        let exporter_result = Arc::new(Mutex::new(None));
        let exporter_result_for_hook = Arc::clone(&exporter_result);
        let vault_for_hook = vault_path.clone();
        inject_after_sync_file_classification_once(move || {
            let result = (|| {
                let shared = acquire_notes_connection(&vault_for_hook)?;
                let mut connection = lock_notes_connection(&shared)?;
                flush_pending(&mut connection, Path::new(&vault_for_hook)).map(drop)
            })();
            *exporter_result_for_hook
                .lock()
                .expect("record exporter result") = Some(result);
        });

        rebuild_notes_storage(&vault_path, NotesMaintenanceMode::DeleteAll)
            .expect("delete Notes storage");

        assert!(
            exporter_result
                .lock()
                .expect("read exporter result")
                .as_ref()
                .expect("exporter ran")
                .is_err(),
            "an exporter started after enumeration must be rejected by the deletion gate"
        );
        assert_eq!(node_count(&vault_path, "title = 'Late export'"), 0);
    }

    #[test]
    fn database_reset_keeps_a_waiter_blocked_until_bootstrap_finishes() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        let waiter_result = Arc::new(Mutex::new(None));
        let waiter_result_for_hook = Arc::clone(&waiter_result);
        let vault_for_waiter = vault_path.clone();
        inject_before_bootstrap_once(move || {
            let waiter = std::thread::spawn(move || reconcile_startup(&vault_for_waiter));
            *waiter_result_for_hook.lock().expect("record waiter result") =
                Some(waiter.join().expect("join bootstrap waiter"));
        });

        rebuild_notes_storage(&vault_path, NotesMaintenanceMode::ResetDatabase)
            .expect("reset Notes storage");

        assert!(
            waiter_result
                .lock()
                .expect("read waiter result")
                .as_ref()
                .expect("waiter ran")
                .is_err(),
            "a competing bootstrap must stay excluded while maintenance bootstraps"
        );
        assert_one_onboarding_set(&vault_path);
    }

    #[test]
    fn database_reset_without_topic_recreates_one_onboarding_set() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        let _database = acquire_notes_connection(&vault_path).expect("create SQLite only fixture");

        rebuild_notes_storage(&vault_path, NotesMaintenanceMode::ResetDatabase)
            .expect("reset SQLite only vault");

        assert_one_onboarding_set(&vault_path);
    }

    #[test]
    fn database_reset_preserves_attachment_storage() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        let asset_bytes = b"attachment bytes";
        let hash = Sha256::digest(asset_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let asset_path = vault
            .path()
            .join(".yonalist/notes-assets")
            .join(format!("{hash}.png"));
        fs::create_dir_all(asset_path.parent().expect("asset parent"))
            .expect("create asset storage");
        fs::write(&asset_path, asset_bytes).expect("write valid hash asset");
        let _database = acquire_notes_connection(&vault_path).expect("create fixture database");

        rebuild_notes_storage(&vault_path, NotesMaintenanceMode::ResetDatabase)
            .expect("reset database");

        assert_eq!(fs::read(asset_path).expect("read asset"), asset_bytes);
    }

    #[test]
    fn full_delete_removes_sync_cleanup_storage() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        let staging_path = vault
            .path()
            .join(".yonalist/sync-cleanup")
            .join(format!("{}.pending", "a".repeat(64)));
        fs::create_dir_all(staging_path.parent().expect("staging parent"))
            .expect("create sync cleanup storage");
        fs::write(&staging_path, b"app-owned staging").expect("write staging file");

        rebuild_notes_storage(&vault_path, NotesMaintenanceMode::DeleteAll)
            .expect("delete all Notes storage");

        assert!(
            !staging_path.exists(),
            "app-owned staging file must be removed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn full_delete_rejects_a_sync_file_replacement_before_removal() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        let topic_path = vault.path().join("Imported.11111111.md");
        fs::write(
            &topic_path,
            render_topic_doc(&topic("Imported")).expect("render topic"),
        )
        .expect("write topic");
        reconcile_startup(&vault_path).expect("initialize fixture database");
        let topic_for_hook = topic_path.clone();
        let replacement = b"ordinary replacement".to_vec();
        let replacement_for_hook = replacement.clone();
        inject_before_sync_file_removal_once(move || {
            fs::remove_file(&topic_for_hook).expect("remove classified topic");
            fs::write(&topic_for_hook, &replacement_for_hook).expect("write replacement");
        });

        let result = rebuild_notes_storage(&vault_path, NotesMaintenanceMode::DeleteAll);

        assert!(result.is_err(), "replaced topic unexpectedly deleted");
        assert_eq!(fs::read(topic_path).expect("read replacement"), replacement);
    }

    #[cfg(unix)]
    #[test]
    fn full_delete_rejects_a_cleanup_staging_replacement_before_removal() {
        let vault = tempfile::tempdir().expect("create vault");
        let vault_path = vault_path(&vault);
        let staging_path = vault
            .path()
            .join(".yonalist/sync-cleanup")
            .join(format!("{}.pending", "b".repeat(64)));
        fs::create_dir_all(staging_path.parent().expect("staging parent"))
            .expect("create sync cleanup storage");
        fs::write(&staging_path, b"app-owned staging").expect("write staging file");
        let staging_for_hook = staging_path.clone();
        let replacement = b"ordinary replacement".to_vec();
        let replacement_for_hook = replacement.clone();
        inject_before_sync_cleanup_removal_once(move || {
            fs::remove_file(&staging_for_hook).expect("remove held staging file");
            fs::write(&staging_for_hook, &replacement_for_hook).expect("write replacement");
        });

        let result = rebuild_notes_storage(&vault_path, NotesMaintenanceMode::DeleteAll);

        assert!(
            result.is_err(),
            "replaced staging file unexpectedly deleted"
        );
        assert_eq!(
            fs::read(staging_path).expect("read replacement"),
            replacement
        );
    }

    #[cfg(unix)]
    #[test]
    fn full_delete_rejects_a_vault_path_swap_before_cleanup() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().expect("create sandbox");
        let vault = sandbox.path().join("vault");
        let displaced_vault = sandbox.path().join("displaced-vault");
        let outside = sandbox.path().join("outside");
        let staging_name = format!("{}.pending", "c".repeat(64));
        let staging_path = vault.join(".yonalist/sync-cleanup").join(&staging_name);
        let outside_staging = outside.join(".yonalist/sync-cleanup").join(&staging_name);
        fs::create_dir_all(staging_path.parent().expect("staging parent"))
            .expect("create vault sync cleanup storage");
        fs::create_dir_all(outside_staging.parent().expect("outside staging parent"))
            .expect("create outside sync cleanup storage");
        fs::write(&staging_path, b"owned staging").expect("write vault staging");
        fs::write(&outside_staging, b"outside staging").expect("write outside staging");
        let vault_path = vault.to_string_lossy().into_owned();
        let vault_for_hook = vault.clone();
        let displaced_for_hook = displaced_vault.clone();
        let outside_for_hook = outside.clone();
        inject_before_sync_cleanup_open_once(move || {
            fs::rename(&vault_for_hook, &displaced_for_hook).expect("relocate held vault");
            symlink(&outside_for_hook, &vault_for_hook).expect("redirect vault path");
        });

        let result = rebuild_notes_storage(&vault_path, NotesMaintenanceMode::DeleteAll);

        assert!(result.is_err(), "vault path swap unexpectedly succeeded");

        assert!(
            displaced_vault
                .join(".yonalist/sync-cleanup")
                .join(&staging_name)
                .exists(),
            "the displaced vault staging must remain after identity revalidation fails"
        );
        assert_eq!(
            fs::read(outside_staging).expect("read outside staging"),
            b"outside staging"
        );
    }

    #[test]
    fn database_reset_removes_blocking_legacy_v1_without_attachment_initialization() {
        const CHILD_ENV: &str = "YONALIST_MAINTENANCE_LEGACY_V1_CHILD";
        const TEST_NAME: &str = "notes::sync::maintenance::tests::database_reset_removes_blocking_legacy_v1_without_attachment_initialization";

        if std::env::var_os(CHILD_ENV).is_some() {
            let sandbox = std::env::current_dir().expect("isolated child cwd");
            crate::NOTES_DATA_ROOT
                .set(sandbox.join("app-data/notes"))
                .expect("set isolated production Notes root");
            let vault = sandbox.join("legacy-vault");
            let metadata = vault.join(".yonalist");
            fs::create_dir_all(&metadata).expect("create legacy metadata");
            let legacy_path = metadata.join("notes.sqlite");
            let legacy = Connection::open(&legacy_path).expect("create legacy database");
            legacy
                .pragma_update(None, "user_version", 1_i64)
                .expect("set legacy v1");
            drop(legacy);
            let vault_path = vault.to_string_lossy().into_owned();

            rebuild_notes_storage(&vault_path, NotesMaintenanceMode::ResetDatabase)
                .expect("reset blocking legacy database");

            assert!(!legacy_path.exists(), "legacy database must be removed");
            let app_local_database = notes_db_path(&vault_path);
            assert!(
                app_local_database.exists(),
                "app-local database must be created"
            );
            let connection =
                Connection::open(&app_local_database).expect("open app-local database");
            assert_eq!(
                connection
                    .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                    .expect("read app-local schema version"),
                2
            );
            drop(connection);
            assert_one_onboarding_set(&vault_path);
            assert!(
                !metadata.join("notes-assets").exists(),
                "reset must not initialize attachment storage"
            );
            assert!(
                !metadata.join(".notes-assets.lock").exists(),
                "reset must not initialize the attachment lock"
            );
            return;
        }

        let isolated = tempfile::tempdir().expect("isolated app-local child cwd");
        let output = std::process::Command::new(std::env::current_exe().expect("current test exe"))
            .arg(TEST_NAME)
            .arg("--exact")
            .arg("--nocapture")
            .env(CHILD_ENV, "1")
            .current_dir(isolated.path())
            .output()
            .expect("run isolated legacy reset regression");
        assert!(
            output.status.success(),
            "isolated legacy reset regression failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}
