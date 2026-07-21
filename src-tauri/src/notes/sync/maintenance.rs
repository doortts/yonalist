use crate::file_io::{
    capability_file_link_count, hold_capability_regular_file_bounded_nofollow,
    HeldBoundedCapabilityFile,
};
use crate::notes::markdown_import::MAX_MARKDOWN_BYTES;
use crate::notes::sync::topic_file::TopicFile;
use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

const METADATA_DIRECTORY: &str = ".yonalist";
const SYNC_CLEANUP_DIRECTORY: &str = "sync-cleanup";

#[cfg(test)]
thread_local! {
    static BEFORE_SYNC_FILE_REMOVAL_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static BEFORE_SYNC_CLEANUP_OPEN_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static BEFORE_SYNC_CLEANUP_REMOVAL_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
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
    let owned_files = match mode {
        NotesMaintenanceMode::ResetDatabase => None,
        NotesMaintenanceMode::DeleteAll => Some(collect_owned_sync_files(vault_path)?),
    };
    // Reset must remain callable while legacy v1 blocks attachment storage.
    let storage = match mode {
        NotesMaintenanceMode::ResetDatabase => None,
        NotesMaintenanceMode::DeleteAll => Some(
            crate::notes::attachments::AttachmentStorageLease::acquire(vault_path)?,
        ),
    };
    let deletion_guard = crate::notes::connection::begin_notes_database_deletion(vault_path)?;
    crate::notes::repository::delete_database(vault_path)?;
    crate::notes::repository::delete_legacy_database(vault_path)?;
    if let Some(owned_files) = owned_files {
        let vault = remove_owned_sync_files(owned_files)?;
        remove_owned_sync_cleanup_files(&vault)?;
    }
    let attachment_cleanup_failed =
        storage.is_some_and(|storage| storage.delete_attachment_files().is_err());
    drop(deletion_guard);
    crate::notes::sync::bootstrap::reconcile_startup(vault_path)?;
    Ok(NotesMaintenanceOutcome {
        attachment_cleanup_failed,
    })
}

fn collect_owned_sync_files(vault_path: &str) -> Result<OwnedSyncFiles, String> {
    let vault_root = crate::expand_vault_path(vault_path);
    let vault = Dir::open_ambient_dir(&vault_root, ambient_authority())
        .map_err(|error| format!("Could not open the Notes vault for maintenance: {error}"))?;
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

fn remove_owned_sync_files(owned_files: OwnedSyncFiles) -> Result<Dir, String> {
    let OwnedSyncFiles { vault, files } = owned_files;
    for OwnedSyncFile { name, held } in files {
        maybe_inject_before_sync_file_removal();
        retire_verified_regular_file(&vault, &name, held, "Notes sync file")?;
    }
    Ok(vault)
}

fn remove_owned_sync_cleanup_files(vault: &Dir) -> Result<(), String> {
    maybe_inject_before_sync_cleanup_open();
    let metadata = match vault.open_dir_nofollow(METADATA_DIRECTORY) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "The Notes metadata directory must be an owned directory, not a symlink: {error}"
            ))
        }
    };
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
        inject_before_sync_cleanup_open_once, inject_before_sync_cleanup_removal_once,
        inject_before_sync_file_removal_once, rebuild_notes_storage, NotesMaintenanceMode,
    };
    use crate::notes::connection::acquire_notes_connection;
    use crate::notes::repository::notes_db_path;
    use crate::notes::sync::bootstrap::reconcile_startup;
    use crate::notes::sync::topic_file::{
        render_topic_doc, TopicContent, TopicDoc, TopicNode, TopicRoot,
    };
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};
    use std::fs;

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
    fn full_delete_cleanup_uses_the_held_vault_after_a_vault_path_swap() {
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
            !displaced_vault
                .join(".yonalist/sync-cleanup")
                .join(&staging_name)
                .exists(),
            "held vault staging must be removed"
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
