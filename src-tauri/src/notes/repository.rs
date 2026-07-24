use crate::notes::date_index::{
    find_note_date_matches, parse_note_date_expression, LocalDate, LocalTodayProvider,
    SystemLocalTodayProvider, WeekStartsOn,
};
use crate::notes::error::UNSUPPORTED_SCHEMA_VERSION_PREFIX;
use crate::notes::github_notifications::{
    compare_github_notification_timestamps, github_date_node_id, github_notification_node_id,
    parse_github_plugin_meta_storage, serialize_github_plugin_meta_storage,
    GithubNotificationsPluginMeta, GithubNotificationsPluginState, GITHUB_NOTIFICATIONS_ROOT_ID,
    GITHUB_NOTIFICATIONS_TITLE,
};
use crate::notes::history;
use crate::notes::image_atom::{ImageAtomAttachmentMutation, ImageAtomEditPlan};
use crate::notes::schema::CURRENT_NOTES_SCHEMA_VERSION;
use crate::notes::tags::{
    add_exact_tag_to_title, extract_note_tags, is_canonical_tag_body, normalize_tag_identity,
    remove_exact_tag_tokens, tokenize_note_text,
};
use crate::notes::types::{
    validate_import_nodes, validate_note_id, ApplyBatchInput, ApplyImageAtomPasteInput, BatchOp,
    CreateNodeInput, DeleteNodesInput, DeleteNodesOutcome, ExportAttachment, ExportDateSpan,
    ExportNode, GithubNotificationSnapshotInput, ImageAtomFocusResult, ImageAtomPasteFragmentItem,
    ImageAtomPasteTargetAuthority, ImageTargetAuthority, ImportNode, ImportSubtreeInput,
    MarkGithubNotificationReadInput, MaterializeGithubNotificationReparentInput,
    MaterializeGithubNotificationSiblingInput, MoveNodeInput, NoteAttachment, NoteId,
    NoteLayoutMode, NoteMarkerKind, NoteNode, NoteNodeKind, NoteSearchMatchedField,
    NoteSearchResult, NoteSearchScope, NoteSearchTag, NoteStructuredSearchQuery, NoteTagFilter,
    NoteTagPrefix, NoteTagSummary, NotesExportSnapshot, NotesHistoryResetInput,
    NotesMutationResult, NotesWorkspace, NotesWorkspaceScope, RefreshGithubNotificationsInput,
    SetGithubGroupCollapsedInput, SplitNodeInput, UpdateNodeInput, MAX_IMAGE_NODE_IMPORT_ITEMS,
    MAX_NOTES_EXPORT_ATTACHMENTS, MAX_NOTE_ATTACHMENTS_PER_NODE, MAX_NOTE_ATTACHMENTS_PER_VAULT,
};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt as CapMetadataExt, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions as CapOpenOptions};
use rusqlite::{
    params, params_from_iter, Connection, Error, ErrorCode, OpenFlags, OptionalExtension, Params,
    Row, Transaction, TransactionBehavior,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(test)]
use std::cell::{Cell, RefCell};
#[cfg(test)]
use std::sync::mpsc::Sender;

const NOTES_ONBOARDING_TITLE: &str = "Yonalist Notes 시작하기";
const NOTES_DEVELOPMENT_SCHEMA_REJECTION: &str =
    "개발 단계 DB — .yonalist/notes.sqlite 삭제 후 재실행";
const EXCLUDE_PLUGIN_OWNED_SQL: &str = "(plugin_meta IS NULL AND id <> ?1)";
const NOTES_ONBOARDING_NOTE: &str = "이 노트는 자유롭게 수정하거나 삭제할 수 있어요.";
const NOTES_ONBOARDING_CHILDREN: [&str; 6] = [
    "Enter — 새 항목 만들기",
    "Tab / Shift+Tab — 들여쓰기 / 내어쓰기",
    "Shift+Enter — 설명 입력하기",
    "⌘/Ctrl+Enter — 완료 표시",
    "↑/↓ — 항목 사이 이동",
    "불릿을 드래그해 순서와 계층 바꾸기",
];
const NOTE_SEARCH_MAX_TEXT_UTF8_BYTES: usize = 4096;
const NOTE_SEARCH_MAX_UNIQUE_TAG_ALTERNATIVES: usize = 64;
const NOTE_SEARCH_MAX_OR_GROUPS: usize = 16;
const NOTE_SEARCH_MAX_ALTERNATIVES_PER_OR_GROUP: usize = 16;
const SQLITE_HEADER_MAGIC: &[u8; 16] = b"SQLite format 3\0";
/// Bounds the structural allocations used to assemble and render one export.
pub(crate) const MAX_NOTES_EXPORT_NODES: usize = 20_000;
/// Counts the root as level one and keeps recursive export work stack-safe.
pub(crate) const MAX_NOTES_EXPORT_DEPTH: usize = 128;
pub(crate) const SORT_KEY_STEP: i64 = 1024;
// Keep every dynamic ancestor query below SQLite's legacy 999-variable limit,
// even though current bundled SQLite builds allow more.
const ANCESTOR_CLOSURE_CHUNK_SIZE: usize = 400;
pub(crate) const MIN_ATTACHMENT_DISPLAY_WIDTH: i64 = 160;
const NOTES_BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);
const NOTES_BUSY_RETRY_DELAY: Duration = Duration::from_millis(10);

#[cfg(test)]
struct InitializationBusyObservation {
    sender: Sender<usize>,
    worker_id: usize,
}

#[cfg(test)]
thread_local! {
    static NEXT_INITIALIZATION_BUSY_OBSERVATION: RefCell<Option<InitializationBusyObservation>> =
        const { RefCell::new(None) };
    static NODE_BY_ID_LOOKUP_COUNT: Cell<usize> = const { Cell::new(0) };
    static ANCESTOR_CLOSURE_QUERY_COUNT: Cell<usize> = const { Cell::new(0) };
    static READONLY_DESCENDANT_QUERY_COUNT: Cell<usize> = const { Cell::new(0) };
    static READONLY_DESCENDANT_VISITED_ROW_COUNT: Cell<usize> = const { Cell::new(0) };
    static SEARCH_PARENT_TRAIL_QUERY_COUNT: Cell<usize> = const { Cell::new(0) };
    static GITHUB_NOTIFICATION_LOOKUP_QUERY_COUNT: Cell<usize> = const { Cell::new(0) };
    static GITHUB_NOTIFICATION_VISITED_ROW_COUNT: Cell<usize> = const { Cell::new(0) };
    static SIBLING_ORDER_QUERY_COUNT: Cell<usize> = const { Cell::new(0) };
    static SIBLING_ORDER_VISITED_ROW_COUNT: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
thread_local! {
    static NOTES_DATABASE_AFTER_HOLD_HOOK: RefCell<Option<Box<dyn FnOnce()>>> =
        const { RefCell::new(None) };
    static NOTES_DATABASE_AFTER_SQLITE_OPEN_HOOK: RefCell<Option<Box<dyn FnOnce()>>> =
        const { RefCell::new(None) };
    static DELETE_DATABASE_AFTER_HOLD_HOOK: RefCell<Option<Box<dyn FnOnce()>>> =
        const { RefCell::new(None) };
    static DELETE_DATABASE_BEFORE_FILE_MUTATION_HOOK: RefCell<Option<DeleteDatabaseFileMutationHook>> =
        const { RefCell::new(None) };
}

#[cfg(test)]
struct DeleteDatabaseFileMutationHook {
    remaining_calls: usize,
    action: Box<dyn FnOnce(&str)>,
}

#[cfg(test)]
fn inject_notes_database_after_hold_once(action: impl FnOnce() + 'static) {
    NOTES_DATABASE_AFTER_HOLD_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

fn maybe_inject_notes_database_after_hold() {
    #[cfg(test)]
    if let Some(action) = NOTES_DATABASE_AFTER_HOLD_HOOK.with(|slot| slot.borrow_mut().take()) {
        action();
    }
}

#[cfg(test)]
fn inject_notes_database_after_sqlite_open_once(action: impl FnOnce() + 'static) {
    NOTES_DATABASE_AFTER_SQLITE_OPEN_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

fn maybe_inject_notes_database_after_sqlite_open() {
    #[cfg(test)]
    if let Some(action) =
        NOTES_DATABASE_AFTER_SQLITE_OPEN_HOOK.with(|slot| slot.borrow_mut().take())
    {
        action();
    }
}

#[cfg(test)]
fn inject_delete_database_after_hold_once(action: impl FnOnce() + 'static) {
    DELETE_DATABASE_AFTER_HOLD_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(action)));
}

fn maybe_inject_delete_database_after_hold() {
    #[cfg(test)]
    if let Some(action) = DELETE_DATABASE_AFTER_HOLD_HOOK.with(|slot| slot.borrow_mut().take()) {
        action();
    }
}

#[cfg(test)]
pub(crate) fn inject_delete_database_before_file_mutation_once(
    remaining_calls: usize,
    action: impl FnOnce(&str) + 'static,
) {
    DELETE_DATABASE_BEFORE_FILE_MUTATION_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(DeleteDatabaseFileMutationHook {
            remaining_calls,
            action: Box::new(action),
        });
    });
}

fn maybe_inject_delete_database_before_file_mutation(name: &str) {
    #[cfg(test)]
    DELETE_DATABASE_BEFORE_FILE_MUTATION_HOOK.with(|slot| {
        let Some(mut hook) = slot.borrow_mut().take() else {
            return;
        };
        if hook.remaining_calls == 0 {
            (hook.action)(name);
        } else {
            hook.remaining_calls -= 1;
            *slot.borrow_mut() = Some(hook);
        }
    });
    #[cfg(not(test))]
    let _ = name;
}

#[cfg(test)]
fn observe_next_initialization_busy(sender: Sender<usize>, worker_id: usize) {
    NEXT_INITIALIZATION_BUSY_OBSERVATION.with(|observation| {
        let previous =
            observation.replace(Some(InitializationBusyObservation { sender, worker_id }));
        assert!(
            previous.is_none(),
            "initialization busy observer already installed"
        );
    });
}

#[cfg(test)]
fn initialization_busy_observer(_attempt: i32) -> bool {
    NEXT_INITIALIZATION_BUSY_OBSERVATION.with(|observation| {
        if let Some(observation) = observation.take() {
            let _ = observation.sender.send(observation.worker_id);
        }
    });
    true
}

#[cfg(test)]
fn reset_node_by_id_lookup_count() {
    NODE_BY_ID_LOOKUP_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn node_by_id_lookup_count() -> usize {
    NODE_BY_ID_LOOKUP_COUNT.with(Cell::get)
}

#[cfg(test)]
fn reset_github_notification_lookup_stats() {
    GITHUB_NOTIFICATION_LOOKUP_QUERY_COUNT.with(|count| count.set(0));
    GITHUB_NOTIFICATION_VISITED_ROW_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn github_notification_lookup_stats() -> (usize, usize) {
    (
        GITHUB_NOTIFICATION_LOOKUP_QUERY_COUNT.with(Cell::get),
        GITHUB_NOTIFICATION_VISITED_ROW_COUNT.with(Cell::get),
    )
}

#[cfg(test)]
fn reset_sibling_order_stats() {
    SIBLING_ORDER_QUERY_COUNT.with(|count| count.set(0));
    SIBLING_ORDER_VISITED_ROW_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn sibling_order_stats() -> (usize, usize) {
    (
        SIBLING_ORDER_QUERY_COUNT.with(Cell::get),
        SIBLING_ORDER_VISITED_ROW_COUNT.with(Cell::get),
    )
}

#[cfg(test)]
fn reset_ancestor_closure_query_count() {
    ANCESTOR_CLOSURE_QUERY_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn ancestor_closure_query_count() -> usize {
    ANCESTOR_CLOSURE_QUERY_COUNT.with(Cell::get)
}

#[cfg(test)]
fn reset_readonly_descendant_scan_stats() {
    READONLY_DESCENDANT_QUERY_COUNT.with(|count| count.set(0));
    READONLY_DESCENDANT_VISITED_ROW_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn readonly_descendant_scan_stats() -> (usize, usize) {
    (
        READONLY_DESCENDANT_QUERY_COUNT.with(Cell::get),
        READONLY_DESCENDANT_VISITED_ROW_COUNT.with(Cell::get),
    )
}

#[cfg(test)]
fn reset_search_parent_trail_query_count() {
    SEARCH_PARENT_TRAIL_QUERY_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn search_parent_trail_query_count() -> usize {
    SEARCH_PARENT_TRAIL_QUERY_COUNT.with(Cell::get)
}

#[cfg(test)]
fn install_initialization_busy_observer(connection: &Connection) -> Result<(), String> {
    let observation_is_pending =
        NEXT_INITIALIZATION_BUSY_OBSERVATION.with(|observation| observation.borrow().is_some());
    if observation_is_pending {
        connection
            .busy_handler(Some(initialization_busy_observer))
            .map_err(|error| format!("Could not observe the Notes initialization lock: {error}"))?;
    }
    Ok(())
}

pub(crate) fn validate_vault_path(vault_path: &str) -> Result<(), String> {
    if vault_path.trim().is_empty() {
        return Err("Vault path must not be empty.".to_string());
    }
    Ok(())
}

pub(crate) fn notes_db_path(vault_path: &str) -> PathBuf {
    match crate::NOTES_DATA_ROOT.get() {
        Some(root) => notes_db_path_with_root(vault_path, root),
        // ponytail: Unit tests intentionally keep the legacy vault-local path so
        // the process-wide production OnceLock cannot leak storage across cases.
        None => crate::metadata_dir(vault_path).join("notes.sqlite"),
    }
}

/// Rejects an existing unsupported Notes database before callers create any
/// attachment-storage or application-lock artifacts. This deliberately uses
/// only pathname metadata and SQLite's read-only open mode: it is the early,
/// side-effect-free guard, while the held-file preflights below revalidate the
/// same database after the vault lock is held.
pub(crate) fn preflight_notes_schema_before_attachment_storage(
    vault_path: &str,
) -> Result<(), String> {
    validate_vault_path(vault_path)?;

    let active_database_path = notes_db_path(vault_path);
    if preflight_existing_notes_database_path(&active_database_path, "Notes database")? {
        return Ok(());
    }

    if crate::NOTES_DATA_ROOT.get().is_some() {
        let legacy_database_path = crate::metadata_dir(vault_path).join("notes.sqlite");
        preflight_existing_notes_database_path(&legacy_database_path, "legacy Notes database")?;
    }

    Ok(())
}

fn preflight_existing_notes_database_path(
    database_path: &Path,
    description: &str,
) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(database_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Could not inspect the {description} before attachment storage: {error}"
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "The {description} must be a regular file before attachment storage."
        ));
    }

    let connection = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| {
        format!("Could not open the {description} before attachment storage: {error}")
    })?;
    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| {
            format!("Could not read the {description} schema version before attachment storage: {error}")
        })?;
    drop(connection);
    reject_existing_notes_schema_version(user_version)?;
    Ok(true)
}

pub(crate) fn vault_key(vault_path: &str) -> String {
    let expanded = crate::expand_vault_path(vault_path);
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from(std::path::MAIN_SEPARATOR_STR))
            .join(expanded)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    let digest = Sha256::digest(normalized.to_string_lossy().as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn notes_storage_dir_with_root(vault_path: &str, root: &Path) -> PathBuf {
    root.join(vault_key(vault_path))
}

fn notes_db_path_with_root(vault_path: &str, root: &Path) -> PathBuf {
    notes_storage_dir_with_root(vault_path, root).join("notes.sqlite")
}

struct LocalNotesStorageDirectory {
    directory: Dir,
    path: PathBuf,
    identity: NotesFileIdentity,
}

impl LocalNotesStorageDirectory {
    fn revalidate_path(&self) -> Result<(), String> {
        let path_metadata = fs::symlink_metadata(&self.path)
            .map_err(|error| format!("Could not inspect the Notes data directory: {error}"))?;
        if !path_metadata.file_type().is_dir() || path_metadata.file_type().is_symlink() {
            return Err(
                "The Notes data directory must not be a symlink or reparse point.".to_string(),
            );
        }
        let held_metadata = self
            .directory
            .dir_metadata()
            .map_err(|error| format!("Could not inspect the held Notes data directory: {error}"))?;
        if notes_file_identity(&path_metadata) != self.identity
            || notes_capability_identity(&held_metadata) != self.identity
        {
            return Err("The Notes data directory identity changed.".to_string());
        }
        Ok(())
    }
}

fn open_local_notes_storage_directory(
    database_path: &Path,
    create: bool,
) -> Result<LocalNotesStorageDirectory, String> {
    try_open_local_notes_storage_directory(database_path, create)?
        .ok_or_else(|| "The keyed Notes data directory does not exist.".to_string())
}

fn try_open_local_notes_storage_directory(
    database_path: &Path,
    create: bool,
) -> Result<Option<LocalNotesStorageDirectory>, String> {
    let path = database_path
        .parent()
        .ok_or_else(|| "Could not resolve the Notes data directory.".to_string())?
        .to_path_buf();
    let root_path = path
        .parent()
        .ok_or_else(|| "Could not resolve the Notes data root.".to_string())?;
    let directory_name = path
        .file_name()
        .ok_or_else(|| "Could not resolve the keyed Notes data directory.".to_string())?;
    if create {
        fs::create_dir_all(root_path)
            .map_err(|error| format!("Could not create the Notes data root: {error}"))?;
    }
    let root_metadata = match fs::symlink_metadata(root_path) {
        Ok(metadata) => metadata,
        Err(error) if !create && error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not inspect the Notes data root: {error}")),
    };
    if !root_metadata.file_type().is_dir() || root_metadata.file_type().is_symlink() {
        return Err("The Notes data root must not be a symlink or reparse point.".to_string());
    }
    let root_identity = notes_file_identity(&root_metadata);
    let root = Dir::open_ambient_dir(root_path, ambient_authority())
        .map_err(|error| format!("Could not open the Notes data root safely: {error}"))?;
    let held_root_metadata = root
        .dir_metadata()
        .map_err(|error| format!("Could not inspect the held Notes data root: {error}"))?;
    if notes_capability_identity(&held_root_metadata) != root_identity {
        return Err("The Notes data root identity changed.".to_string());
    }
    if create {
        match root.create_dir(directory_name) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "Could not create the keyed Notes data directory: {error}"
                ))
            }
        }
    }
    let path_metadata = match root.symlink_metadata(directory_name) {
        Ok(metadata) => metadata,
        Err(error) if !create && error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect the Notes data directory: {error}"
            ))
        }
    };
    if !path_metadata.file_type().is_dir() || path_metadata.file_type().is_symlink() {
        return Err("The Notes data directory must not be a symlink or reparse point.".to_string());
    }
    let identity = notes_capability_identity(&path_metadata);
    let directory = root
        .open_dir(directory_name)
        .map_err(|error| format!("Could not open the Notes data directory safely: {error}"))?;
    let held = LocalNotesStorageDirectory {
        directory,
        path,
        identity,
    };
    held.revalidate_path()?;
    if create {
        match held.directory.create_dir("asset-trash") {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "Could not create the Notes asset trash directory: {error}"
                ))
            }
        }
        let asset_trash_metadata = held
            .directory
            .symlink_metadata("asset-trash")
            .map_err(|error| format!("Could not inspect the Notes asset trash: {error}"))?;
        if !asset_trash_metadata.file_type().is_dir()
            || asset_trash_metadata.file_type().is_symlink()
        {
            return Err(
                "The Notes asset trash directory must not be a symlink or reparse point."
                    .to_string(),
            );
        }
    }
    Ok(Some(held))
}

fn app_local_notes_database_exists(database_path: &Path) -> Result<bool, String> {
    let Some(storage) = try_open_local_notes_storage_directory(database_path, false)? else {
        return Ok(false);
    };
    storage.revalidate_path()?;
    match storage.directory.symlink_metadata("notes.sqlite") {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not inspect Notes storage: {error}")),
    }
}

enum NotesStorageDirectoryKind {
    Vault(Dir),
    Local(LocalNotesStorageDirectory),
}

pub(crate) struct NotesStorageDirectory {
    kind: NotesStorageDirectoryKind,
}

impl NotesStorageDirectory {
    pub(crate) fn open(
        app_lock: &crate::notes::connection::VaultAppLockGuard,
        database_path: &Path,
        create: bool,
    ) -> Result<Self, String> {
        if crate::NOTES_DATA_ROOT.get().is_some() {
            open_local_notes_storage_directory(database_path, create).map(|storage| Self {
                kind: NotesStorageDirectoryKind::Local(storage),
            })
        } else {
            app_lock.try_clone_metadata().map(|directory| Self {
                kind: NotesStorageDirectoryKind::Vault(directory),
            })
        }
    }

    pub(crate) fn directory(&self) -> &Dir {
        match &self.kind {
            NotesStorageDirectoryKind::Vault(directory) => directory,
            NotesStorageDirectoryKind::Local(storage) => &storage.directory,
        }
    }

    pub(crate) fn revalidate_path(&self) -> Result<(), String> {
        match &self.kind {
            NotesStorageDirectoryKind::Vault(_) => Ok(()),
            NotesStorageDirectoryKind::Local(storage) => storage.revalidate_path(),
        }
    }
}

fn sqlite_companion_path(database_path: &PathBuf, suffix: &str) -> PathBuf {
    let mut path = database_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NotesFileIdentity {
    device: u64,
    inode: u64,
}

fn notes_file_identity(metadata: &fs::Metadata) -> NotesFileIdentity {
    NotesFileIdentity {
        device: CapMetadataExt::dev(metadata),
        inode: CapMetadataExt::ino(metadata),
    }
}

fn notes_capability_identity(metadata: &cap_std::fs::Metadata) -> NotesFileIdentity {
    NotesFileIdentity {
        device: CapMetadataExt::dev(metadata),
        inode: CapMetadataExt::ino(metadata),
    }
}

fn validate_notes_owned_file_metadata(
    metadata: &fs::Metadata,
    description: &str,
) -> Result<NotesFileIdentity, String> {
    if !metadata.file_type().is_file() {
        return Err(format!("The {description} must be a regular file."));
    }
    if CapMetadataExt::nlink(metadata) != 1 {
        return Err(format!(
            "The {description} must not have multiple hard links."
        ));
    }
    Ok(notes_file_identity(metadata))
}

fn validate_notes_owned_capability_metadata(
    metadata: &cap_std::fs::Metadata,
    description: &str,
) -> Result<NotesFileIdentity, String> {
    if !metadata.file_type().is_file() {
        return Err(format!("The {description} must be a regular file."));
    }
    if CapMetadataExt::nlink(metadata) != 1 {
        return Err(format!(
            "The {description} must not have multiple hard links."
        ));
    }
    Ok(notes_capability_identity(metadata))
}

#[cfg(windows)]
fn windows_notes_database_share_mode() -> u32 {
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    FILE_SHARE_READ | FILE_SHARE_WRITE
}

#[cfg(all(test, not(windows)))]
fn windows_notes_database_share_mode() -> u32 {
    0x1 | 0x2
}

#[cfg(windows)]
fn open_notes_file_nofollow(
    _directory: &Dir,
    _name: &Path,
    absolute_path: &Path,
    writable: bool,
    create_new: bool,
) -> std::io::Result<fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, CREATE_NEW,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, OPEN_EXISTING,
    };

    let path = absolute_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | if writable { GENERIC_WRITE } else { 0 },
            windows_notes_database_share_mode(),
            std::ptr::null(),
            if create_new {
                CREATE_NEW
            } else {
                OPEN_EXISTING
            },
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let file = unsafe { fs::File::from_raw_handle(handle) };
    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Notes database files must not be reparse points.",
        ));
    }
    Ok(file)
}

#[cfg(not(windows))]
fn open_notes_file_nofollow(
    directory: &Dir,
    name: &Path,
    _absolute_path: &Path,
    writable: bool,
    create_new: bool,
) -> std::io::Result<fs::File> {
    let mut options = CapOpenOptions::new();
    options
        .read(true)
        .write(writable)
        .create_new(create_new)
        .follow(FollowSymlinks::No);
    directory
        .open_with(name, &options)
        .map(cap_std::fs::File::into_std)
}

struct HeldNotesFile {
    path: PathBuf,
    name: PathBuf,
    file: fs::File,
    identity: NotesFileIdentity,
    description: &'static str,
}

impl HeldNotesFile {
    fn open_existing(
        directory: &Dir,
        name: &Path,
        path: &Path,
        writable: bool,
        description: &'static str,
    ) -> Result<Self, String> {
        let path_metadata = directory
            .symlink_metadata(name)
            .map_err(|error| format!("Could not inspect the {description}: {error}"))?;
        if path_metadata.file_type().is_symlink() {
            return Err(format!(
                "The {description} must not be a symlink or reparse point."
            ));
        }
        let path_identity = validate_notes_owned_capability_metadata(&path_metadata, description)?;
        let file = open_notes_file_nofollow(directory, name, path, writable, false)
            .map_err(|error| format!("Could not open the {description} safely: {error}"))?;
        let identity = validate_notes_owned_file_metadata(
            &file
                .metadata()
                .map_err(|error| format!("Could not inspect the held {description}: {error}"))?,
            description,
        )?;
        if identity != path_identity {
            return Err(format!(
                "The {description} identity changed while it was acquired."
            ));
        }
        Ok(Self {
            path: path.to_path_buf(),
            name: name.to_path_buf(),
            file,
            identity,
            description,
        })
    }

    fn create_new(
        directory: &Dir,
        name: &Path,
        path: &Path,
        description: &'static str,
    ) -> Result<Self, String> {
        let file = open_notes_file_nofollow(directory, name, path, true, true)
            .map_err(|error| format!("Could not create the {description} safely: {error}"))?;
        let identity = validate_notes_owned_file_metadata(
            &file
                .metadata()
                .map_err(|error| format!("Could not inspect the held {description}: {error}"))?,
            description,
        )?;
        Ok(Self {
            path: path.to_path_buf(),
            name: name.to_path_buf(),
            file,
            identity,
            description,
        })
    }

    fn verify_at(&self, directory: &Dir) -> Result<(), String> {
        let held_identity = validate_notes_owned_file_metadata(
            &self.file.metadata().map_err(|error| {
                format!("Could not inspect the held {}: {error}", self.description)
            })?,
            self.description,
        )?;
        if held_identity != self.identity {
            return Err(format!(
                "The {} held identity changed during acquisition.",
                self.description
            ));
        }
        let reopened =
            Self::open_existing(directory, &self.name, &self.path, false, self.description)?;
        if reopened.identity != self.identity {
            return Err(format!(
                "The {} identity changed during acquisition.",
                self.description
            ));
        }
        Ok(())
    }

    fn verify_sqlite_connection(
        &self,
        connection: &Connection,
        metadata: &Dir,
    ) -> Result<(), String> {
        #[cfg(not(windows))]
        let _ = connection;
        #[cfg(windows)]
        let opened_path = connection
            .path()
            .ok_or_else(|| "Could not identify the database file opened by SQLite.".to_string())?;
        #[cfg(windows)]
        let opened_path = Path::new(opened_path);
        #[cfg(windows)]
        let name = opened_path
            .file_name()
            .ok_or_else(|| "Could not identify the database file opened by SQLite.".to_string())?;
        #[cfg(windows)]
        let opened = Self::open_existing(
            metadata,
            Path::new(name),
            opened_path,
            false,
            self.description,
        )?;
        #[cfg(not(windows))]
        let opened =
            Self::open_existing(metadata, &self.name, &self.path, false, self.description)?;
        if opened.identity != self.identity {
            return Err(format!(
                "The {} identity opened by SQLite did not match the safely held file.",
                self.description
            ));
        }
        Ok(())
    }

    fn read_header(&self) -> Result<[u8; 64], String> {
        let mut file = self
            .file
            .try_clone()
            .map_err(|error| format!("Could not inspect Notes storage: {error}"))?;
        let mut header = [0_u8; 64];
        match file.read_exact(&mut header) {
            Ok(()) => Ok(header),
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => Ok([0_u8; 64]),
            Err(error) => Err(format!("Could not inspect Notes storage: {error}")),
        }
    }
}

fn read_held_notes_file_at(
    file: &fs::File,
    buffer: &mut [u8],
    offset: u64,
) -> std::io::Result<usize> {
    #[cfg(unix)]
    {
        std::os::unix::fs::FileExt::read_at(file, buffer, offset)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::FileExt::seek_read(file, buffer, offset)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let mut source = file.try_clone()?;
        std::io::Seek::seek(&mut source, std::io::SeekFrom::Start(offset))?;
        source.read(buffer)
    }
}

fn digest_held_notes_file_with(
    file: &HeldNotesFile,
    mut consume: impl FnMut(&[u8]) -> std::io::Result<()>,
) -> Result<[u8; 32], String> {
    let mut digest = Sha256::new();
    let mut offset = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = read_held_notes_file_at(&file.file, &mut buffer, offset).map_err(|error| {
            format!(
                "Could not read the held {} for inspection: {error}",
                file.description
            )
        })?;
        if read == 0 {
            break;
        }
        consume(&buffer[..read]).map_err(|error| {
            format!(
                "Could not snapshot the held {} for inspection: {error}",
                file.description
            )
        })?;
        digest.update(&buffer[..read]);
        offset = offset
            .checked_add(read as u64)
            .ok_or_else(|| format!("The held {} is too large to inspect.", file.description))?;
    }
    Ok(digest.finalize().into())
}

fn digest_held_notes_file(file: &HeldNotesFile) -> Result<[u8; 32], String> {
    digest_held_notes_file_with(file, |_| Ok(()))
}

struct HeldNotesSnapshot {
    _directory: tempfile::TempDir,
    database_path: PathBuf,
    digests: Vec<(PathBuf, [u8; 32])>,
}

impl HeldNotesSnapshot {
    fn capture(database: &HeldNotesFile, companions: &[HeldNotesFile]) -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("yonalist-notes-preflight-")
            .tempdir()
            .map_err(|error| {
                format!("Could not create a private Notes inspection directory: {error}")
            })?;
        let database_path = directory.path().join(&database.name);
        let mut digests = Vec::with_capacity(1 + companions.len());
        for file in std::iter::once(database).chain(companions) {
            let snapshot_path = directory.path().join(&file.name);
            let mut snapshot = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&snapshot_path)
                .map_err(|error| {
                    format!("Could not create a private Notes inspection file: {error}")
                })?;
            let digest = digest_held_notes_file_with(file, |bytes| snapshot.write_all(bytes))?;
            snapshot.flush().map_err(|error| {
                format!("Could not flush a private Notes inspection file: {error}")
            })?;
            digests.push((file.name.clone(), digest));
        }
        let snapshot = Self {
            _directory: directory,
            database_path,
            digests,
        };
        snapshot.verify_source_contents(database, companions)?;
        Ok(snapshot)
    }

    fn verify_source_contents(
        &self,
        database: &HeldNotesFile,
        companions: &[HeldNotesFile],
    ) -> Result<(), String> {
        let files = std::iter::once(database).chain(companions);
        for (file, (expected_name, expected_digest)) in files.zip(&self.digests) {
            if &file.name != expected_name || digest_held_notes_file(file)? != *expected_digest {
                return Err(format!(
                    "The held {} content changed during inspection.",
                    file.description
                ));
            }
        }
        Ok(())
    }
}

fn hold_existing_notes_companions(
    metadata: &Dir,
    database_path: &PathBuf,
) -> Result<Vec<HeldNotesFile>, String> {
    let mut companions = Vec::new();
    for suffix in ["-wal", "-shm", "-journal"] {
        let path = sqlite_companion_path(database_path, suffix);
        let name = Path::new(path.file_name().expect("companion file name"));
        match metadata.symlink_metadata(name) {
            Ok(_) => companions.push(HeldNotesFile::open_existing(
                metadata,
                name,
                &path,
                false,
                "Notes database companion",
            )?),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Could not inspect the Notes database companion: {error}"
                ))
            }
        }
    }
    Ok(companions)
}

fn verify_held_notes_files(
    metadata: &Dir,
    database: &HeldNotesFile,
    companions: &[HeldNotesFile],
) -> Result<(), String> {
    database.verify_at(metadata)?;
    for companion in companions {
        companion.verify_at(metadata)?;
    }
    Ok(())
}

fn verify_notes_companion_set_stable(
    metadata: &Dir,
    database_path: &PathBuf,
    expected: &[HeldNotesFile],
) -> Result<(), String> {
    let current = hold_existing_notes_companions(metadata, database_path)?;
    if current.len() != expected.len()
        || current.iter().any(|file| {
            !expected.iter().any(|expected_file| {
                expected_file.path == file.path && expected_file.identity == file.identity
            })
        })
    {
        return Err(
            "The Notes database companion identity set changed during acquisition.".to_string(),
        );
    }
    Ok(())
}

#[cfg(unix)]
fn sync_notes_metadata_directory(metadata: &Dir) -> Result<(), String> {
    metadata
        .try_clone()
        .and_then(|metadata| metadata.into_std_file().sync_all())
        .map_err(|error| format!("Could not sync the Notes metadata directory: {error}"))
}

#[cfg(not(unix))]
fn sync_notes_metadata_directory(_metadata: &Dir) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
pub(crate) fn delete_database(vault_path: &str) -> Result<(), String> {
    validate_vault_path(vault_path)?;
    let app_lock = crate::notes::connection::acquire_vault_app_lock(vault_path)?;
    delete_database_with_app_lock(vault_path, &app_lock)
}

pub(crate) fn delete_database_with_app_lock(
    vault_path: &str,
    app_lock: &crate::notes::connection::VaultAppLockGuard,
) -> Result<(), String> {
    validate_vault_path(vault_path)?;
    app_lock.revalidate_vault_path()?;
    maybe_inject_delete_database_after_hold();
    let database_path = notes_db_path(vault_path);
    let storage = NotesStorageDirectory::open(&app_lock, &database_path, true)?;
    app_lock.revalidate_vault_path()?;
    storage.revalidate_path()?;
    let mut validate = || {
        app_lock.revalidate_vault_path()?;
        storage.revalidate_path()
    };
    delete_database_from_metadata(storage.directory(), &mut validate)
}

pub(crate) fn delete_legacy_database_with_app_lock(
    vault_path: &str,
    app_lock: &crate::notes::connection::VaultAppLockGuard,
) -> Result<(), String> {
    validate_vault_path(vault_path)?;
    app_lock.revalidate_vault_path()?;
    let metadata = app_lock.try_clone_metadata()?;
    app_lock.revalidate_vault_path()?;
    delete_database_from_metadata(&metadata, &mut || app_lock.revalidate_vault_path())
}

fn delete_database_from_metadata(
    metadata: &Dir,
    validate: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let owned_names = [
        "notes.sqlite",
        "notes.sqlite-wal",
        "notes.sqlite-shm",
        "notes.sqlite-journal",
    ];
    let mut failures = Vec::new();
    for name in owned_names {
        validate()?;
        maybe_inject_delete_database_before_file_mutation(name);
        validate()?;
        let removal = metadata.remove_file_or_symlink(name);
        validate()?;
        if let Err(error) = removal {
            if error.kind() != ErrorKind::NotFound {
                failures.push(format!("{name}: {error}"));
            }
        }
    }
    if !failures.is_empty() {
        return Err(format!(
            "Could not delete Notes storage: {}",
            failures.join("; ")
        ));
    }
    validate()?;
    sync_notes_metadata_directory(metadata)?;
    validate()
}

pub(crate) fn connect_notes_db(vault_path: &str) -> Result<Connection, String> {
    validate_vault_path(vault_path)?;
    let app_lock = crate::notes::connection::acquire_vault_app_lock(vault_path)?;

    let database_path = notes_db_path(vault_path);
    preflight_app_local_notes_storage_before_creation(vault_path, &app_lock, &database_path)?;
    let storage = NotesStorageDirectory::open(&app_lock, &database_path, true)?;
    let metadata = storage.directory();
    let database_name = Path::new("notes.sqlite");
    let (database, created) = match metadata.symlink_metadata(database_name) {
        Ok(_) => (
            HeldNotesFile::open_existing(
                metadata,
                database_name,
                &database_path,
                true,
                "Notes database",
            )?,
            false,
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => (
            HeldNotesFile::create_new(metadata, database_name, &database_path, "Notes database")?,
            true,
        ),
        Err(error) => return Err(format!("Could not inspect Notes storage: {error}")),
    };
    let mut companions = hold_existing_notes_companions(metadata, &database_path)?;
    if !created {
        preflight_existing_notes_schema_with_holds(
            &database_path,
            metadata,
            &database,
            &companions,
        )?;
        companions = hold_existing_notes_companions(metadata, &database_path)?;
    }
    verify_held_notes_files(metadata, &database, &companions)?;
    maybe_inject_notes_database_after_hold();
    verify_notes_companion_set_stable(metadata, &database_path, &companions)?;
    app_lock.revalidate_metadata_path()?;
    storage.revalidate_path()?;
    let mut connection = Connection::open(&database_path)
        .map_err(|error| format!("Could not open Notes storage: {error}"))?;
    app_lock.revalidate_metadata_path()?;
    storage.revalidate_path()?;
    database.verify_sqlite_connection(&connection, metadata)?;
    verify_held_notes_files(metadata, &database, &companions)?;
    initialize_notes_db(&mut connection)?;
    history::install_session_history(&connection)?;
    app_lock.revalidate_metadata_path()?;
    storage.revalidate_path()?;
    database.verify_sqlite_connection(&connection, metadata)?;
    verify_held_notes_files(metadata, &database, &companions)?;
    Ok(connection)
}

pub(crate) fn preflight_app_local_notes_storage_before_creation(
    vault_path: &str,
    app_lock: &crate::notes::connection::VaultAppLockGuard,
    database_path: &Path,
) -> Result<(), String> {
    if crate::NOTES_DATA_ROOT.get().is_none() {
        return Ok(());
    }
    if app_local_notes_database_exists(database_path)? {
        return Ok(());
    }
    let metadata = app_lock.try_clone_metadata()?;
    let database_name = Path::new("notes.sqlite");
    match metadata.symlink_metadata(database_name) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not inspect the legacy Notes database: {error}"
            ))
        }
    }
    let database_path = crate::metadata_dir(vault_path).join(database_name);
    let database = HeldNotesFile::open_existing(
        &metadata,
        database_name,
        &database_path,
        false,
        "legacy Notes database",
    )?;
    let companions = hold_existing_notes_companions(&metadata, &database_path)?;
    verify_held_notes_files(&metadata, &database, &companions)?;
    verify_notes_companion_set_stable(&metadata, &database_path, &companions)?;
    app_lock.revalidate_metadata_path()?;
    maybe_inject_notes_database_after_hold();

    let snapshot = HeldNotesSnapshot::capture(&database, &companions)?;
    let connection =
        Connection::open_with_flags(&snapshot.database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| {
                format!("Could not open the legacy Notes database for inspection: {error}")
            })?;
    maybe_inject_notes_database_after_sqlite_open();
    verify_held_notes_files(&metadata, &database, &companions)?;
    snapshot.verify_source_contents(&database, &companions)?;
    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Could not read the legacy Notes schema version: {error}"))?;
    verify_held_notes_files(&metadata, &database, &companions)?;
    snapshot.verify_source_contents(&database, &companions)?;
    verify_notes_companion_set_stable(&metadata, &database_path, &companions)?;
    app_lock.revalidate_metadata_path()?;
    drop(connection);

    reject_existing_notes_schema_version(user_version)
}

fn preflight_existing_notes_schema_with_holds(
    database_path: &PathBuf,
    metadata: &Dir,
    database: &HeldNotesFile,
    companions: &[HeldNotesFile],
) -> Result<(), String> {
    verify_held_notes_files(metadata, database, companions)?;
    preflight_notes_schema_header(database)?;
    verify_notes_companion_set_stable(metadata, database_path, companions)?;

    let snapshot = HeldNotesSnapshot::capture(database, companions)?;
    let connection =
        Connection::open_with_flags(&snapshot.database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Could not open Notes storage for inspection: {error}"))?;
    verify_held_notes_files(metadata, database, companions)?;
    snapshot.verify_source_contents(database, companions)?;
    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Could not read the Notes schema version: {error}"))?;
    verify_held_notes_files(metadata, database, companions)?;
    snapshot.verify_source_contents(database, companions)?;
    verify_notes_companion_set_stable(metadata, database_path, companions)?;
    drop(connection);
    reject_existing_notes_schema_version(user_version)?;
    verify_held_notes_files(metadata, database, companions)?;
    snapshot.verify_source_contents(database, companions)
}

fn preflight_notes_schema_header(database: &HeldNotesFile) -> Result<(), String> {
    let header = database.read_header()?;
    if &header[..SQLITE_HEADER_MAGIC.len()] != SQLITE_HEADER_MAGIC {
        return Ok(());
    }

    let user_version = u32::from_be_bytes([header[60], header[61], header[62], header[63]]);
    if user_version != 0 {
        reject_existing_notes_schema_version(i64::from(user_version))?;
    }
    Ok(())
}

pub(crate) fn open_notes_export_db(vault_path: &str) -> Result<Connection, String> {
    validate_vault_path(vault_path)?;

    let database_path = notes_db_path(vault_path);
    let Some(app_lock) = crate::notes::connection::try_acquire_existing_vault_app_lock(vault_path)?
    else {
        return Err("Notes database does not exist.".to_string());
    };
    let storage = NotesStorageDirectory::open(&app_lock, &database_path, false)
        .map_err(|error| format!("Could not open Notes storage for export: {error}"))?;
    let metadata = storage.directory();
    match metadata.symlink_metadata("notes.sqlite") {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err("Notes database does not exist.".to_string());
        }
        Err(error) => return Err(format!("Could not inspect Notes storage: {error}")),
    }
    let database = HeldNotesFile::open_existing(
        metadata,
        Path::new("notes.sqlite"),
        &database_path,
        false,
        "Notes database",
    )?;
    let companions = hold_existing_notes_companions(metadata, &database_path)?;
    verify_held_notes_files(metadata, &database, &companions)?;
    maybe_inject_notes_database_after_hold();
    verify_notes_companion_set_stable(metadata, &database_path, &companions)?;

    app_lock.revalidate_metadata_path()?;
    storage.revalidate_path()?;
    let connection = Connection::open_with_flags(&database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Could not open Notes storage for export: {error}"))?;
    app_lock.revalidate_metadata_path()?;
    storage.revalidate_path()?;
    database.verify_sqlite_connection(&connection, metadata)?;
    verify_held_notes_files(metadata, &database, &companions)?;
    let user_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Could not read the Notes schema version: {error}"))?;
    reject_existing_notes_schema_version(user_version)?;
    app_lock.revalidate_metadata_path()?;
    storage.revalidate_path()?;
    database.verify_sqlite_connection(&connection, metadata)?;
    verify_held_notes_files(metadata, &database, &companions)?;
    Ok(connection)
}

fn initialize_notes_db(connection: &mut Connection) -> Result<(), String> {
    crate::notes::schema::install_notes_sql_functions(connection)?;
    let preflight_version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Could not read the Notes schema version: {error}"))?;
    let has_notes_schema: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'notes_nodes')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect the Notes schema: {error}"))?;
    if preflight_version != 0 {
        reject_existing_notes_schema_version(preflight_version)?;
    } else if has_notes_schema {
        return Err(format!(
            "{UNSUPPORTED_SCHEMA_VERSION_PREFIX} {preflight_version}."
        ));
    }

    connection
        .busy_timeout(NOTES_BUSY_TIMEOUT)
        .map_err(|error| format!("Could not configure the Notes busy timeout: {error}"))?;
    enable_wal_with_busy_retry(connection)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("Could not configure Notes storage: {error}"))?;
    #[cfg(test)]
    install_initialization_busy_observer(connection)?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start Notes storage initialization: {error}"))?;
    let created = crate::notes::schema::create_if_missing(&transaction)?;
    crate::notes::schema::install_current_sync_triggers(&transaction)?;
    if created {
        transaction
            .pragma_update(None, "user_version", CURRENT_NOTES_SCHEMA_VERSION)
            .map_err(|error| format!("Could not record the Notes schema version: {error}"))?;
    }
    let stored_schema_version = transaction
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| format!("Could not inspect the Notes schema version: {error}"))?;
    if stored_schema_version != CURRENT_NOTES_SCHEMA_VERSION {
        return Err(format!(
            "{UNSUPPORTED_SCHEMA_VERSION_PREFIX} {stored_schema_version}."
        ));
    }

    if created {
        seed_vault_generation(&transaction)?;
        seed_sync_meta(&transaction)?;
    }
    crate::notes::hlc::restore_clock(&transaction)?;
    crate::notes::hlc::persist_clock(&transaction)?;
    crate::notes::hlc::register_hlc_function(&transaction)?;
    if created {
        seed_notes_onboarding(&transaction)?;
        let node_ids = {
            let mut statement = transaction
                .prepare("SELECT id FROM notes_nodes ORDER BY id")
                .map_err(|error| format!("Could not prepare Notes bootstrap rows: {error}"))?;
            let node_ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("Could not load Notes bootstrap rows: {error}"))?
                .collect::<Result<BTreeSet<_>, _>>()
                .map_err(|error| format!("Could not read Notes bootstrap rows: {error}"))?;
            node_ids
        };
        let today = SystemLocalTodayProvider.local_today(&transaction)?;
        rebuild_derived_for_nodes_at(&transaction, &node_ids, today)?;
    }

    validate_persisted_id_namespace(&transaction)?;

    transaction
        .commit()
        .map_err(|error| format!("Could not finish Notes storage initialization: {error}"))
}

fn reject_development_schema(schema_version: i64) -> Result<(), String> {
    if (1..CURRENT_NOTES_SCHEMA_VERSION).contains(&schema_version) {
        return Err(NOTES_DEVELOPMENT_SCHEMA_REJECTION.to_string());
    }
    Ok(())
}

fn reject_existing_notes_schema_version(schema_version: i64) -> Result<(), String> {
    reject_development_schema(schema_version)?;
    if schema_version != CURRENT_NOTES_SCHEMA_VERSION {
        return Err(format!(
            "{UNSUPPORTED_SCHEMA_VERSION_PREFIX} {schema_version}."
        ));
    }
    Ok(())
}

fn seed_vault_generation(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO notes_metadata(id, vault_generation) VALUES (1, ?1)",
            [Uuid::new_v4().to_string()],
        )
        .map_err(|error| format!("Could not record the Notes vault generation: {error}"))?;
    Ok(())
}

fn seed_sync_meta(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO sync_meta(id, device_id, vault_uuid) VALUES (1, ?1, ?2)",
            params![Uuid::new_v4().to_string(), Uuid::new_v4().to_string()],
        )
        .map_err(|error| format!("Could not record Notes sync identity metadata: {error}"))?;
    Ok(())
}

pub(crate) fn notes_vault_generation(connection: &Connection) -> Result<String, String> {
    let generation = connection
        .query_row(
            "SELECT vault_generation FROM notes_metadata WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Could not read the Notes vault generation: {error}"))?;
    validate_note_id(&generation)
        .map_err(|error| format!("The Notes vault generation is invalid: {error}"))?;
    Ok(generation)
}

fn validate_persisted_id_namespace(connection: &Connection) -> Result<(), String> {
    let collision = connection
        .query_row(
            "WITH namespace(id, kind) AS (\
               SELECT id, 'node' FROM notes_nodes \
               UNION ALL \
               SELECT id, 'attachment' FROM notes_attachments\
             ) \
             SELECT id FROM namespace \
             GROUP BY id HAVING COUNT(DISTINCT kind) > 1 \
             ORDER BY id LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not validate the Notes ID namespace: {error}"))?;
    if let Some(id) = collision {
        return Err(format!(
            "The Notes ID namespace contains a node/attachment collision for {id}."
        ));
    }
    Ok(())
}

fn seed_notes_onboarding(transaction: &Transaction<'_>) -> Result<(), String> {
    let root_id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT INTO notes_nodes (\
               id, parent_id, sort_key, title, note, created_at, updated_at\
             ) VALUES (\
               ?1, NULL, ?2, ?3, ?4, \
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
             )",
            params![
                &root_id,
                SORT_KEY_STEP,
                NOTES_ONBOARDING_TITLE,
                NOTES_ONBOARDING_NOTE
            ],
        )
        .map_err(|error| format!("Could not create the Notes onboarding page: {error}"))?;

    for (index, title) in NOTES_ONBOARDING_CHILDREN.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 )",
                params![
                    Uuid::new_v4().to_string(),
                    &root_id,
                    (index as i64 + 1) * SORT_KEY_STEP,
                    title
                ],
            )
            .map_err(|error| format!("Could not create Notes onboarding guidance: {error}"))?;
    }
    Ok(())
}

/// Builds a benchmark node's title/note. Titles are `"Bench <path index>"`;
/// every 10th node carries a `#bench` tag and every 5th node gets a one-line
/// note, so the derived tag/date indexes see realistic-but-sparse content.
#[cfg(debug_assertions)]
fn bench_node_content(path_index: u32) -> (String, String) {
    let title = if path_index % 10 == 0 {
        format!("Bench {path_index} #bench")
    } else {
        format!("Bench {path_index}")
    };
    let note = if path_index % 5 == 0 {
        format!("bench note {path_index}")
    } else {
        String::new()
    };
    (title, note)
}

/// Dev-only fixture: seeds a three-level bullet tree of `roots ×
/// (1 + children_per_root × (1 + grandchildren_per_child))` nodes in a single
/// transaction, for outliner latency benchmarking. Nodes are inserted with an
/// empty `hlc`, so the `notes_nodes_hlc_ai` trigger issues each HLC and marks
/// the row dirty; the derived tag/date indexes are rebuilt inside the same
/// transaction. The total is capped at [`MAX_NOTES_EXPORT_NODES`].
#[cfg(debug_assertions)]
pub(crate) fn seed_bench_nodes(
    connection: &mut Connection,
    roots: u32,
    children_per_root: u32,
    grandchildren_per_child: u32,
) -> Result<u32, String> {
    let total = u128::from(roots)
        * (1 + u128::from(children_per_root) * (1 + u128::from(grandchildren_per_child)));
    if total > MAX_NOTES_EXPORT_NODES as u128 {
        return Err(format!(
            "Could not seed benchmark Notes: {total} nodes exceeds the \
             {MAX_NOTES_EXPORT_NODES}-node limit."
        ));
    }

    let today = SystemLocalTodayProvider.local_today(connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start benchmark Notes seeding: {error}"))?;

    let mut ids: BTreeSet<String> = BTreeSet::new();
    let mut path_index: u32 = 0;
    {
        let mut insert = transaction
            .prepare(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, hlc, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, ?5, '', \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 )",
            )
            .map_err(|error| format!("Could not prepare benchmark Notes seeding: {error}"))?;

        for root_index in 0..roots {
            let root_id = Uuid::new_v4().to_string();
            let (title, note) = bench_node_content(path_index);
            insert
                .execute(params![
                    &root_id,
                    Option::<&str>::None,
                    (root_index as i64 + 1) * SORT_KEY_STEP,
                    title,
                    note
                ])
                .map_err(|error| format!("Could not seed benchmark Notes: {error}"))?;
            path_index += 1;

            for child_index in 0..children_per_root {
                let child_id = Uuid::new_v4().to_string();
                let (title, note) = bench_node_content(path_index);
                insert
                    .execute(params![
                        &child_id,
                        Some(&root_id),
                        (child_index as i64 + 1) * SORT_KEY_STEP,
                        title,
                        note
                    ])
                    .map_err(|error| format!("Could not seed benchmark Notes: {error}"))?;
                path_index += 1;

                for grandchild_index in 0..grandchildren_per_child {
                    let grandchild_id = Uuid::new_v4().to_string();
                    let (title, note) = bench_node_content(path_index);
                    insert
                        .execute(params![
                            &grandchild_id,
                            Some(&child_id),
                            (grandchild_index as i64 + 1) * SORT_KEY_STEP,
                            title,
                            note
                        ])
                        .map_err(|error| format!("Could not seed benchmark Notes: {error}"))?;
                    path_index += 1;
                    ids.insert(grandchild_id);
                }
                ids.insert(child_id);
            }
            ids.insert(root_id);
        }
    }

    rebuild_derived_for_nodes_at(&transaction, &ids, today)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not finish benchmark Notes seeding: {error}"))?;

    Ok(path_index)
}

fn enable_wal_with_busy_retry(connection: &Connection) -> Result<(), String> {
    let deadline = Instant::now() + NOTES_BUSY_TIMEOUT;
    loop {
        match connection.execute_batch("PRAGMA journal_mode = WAL;") {
            Ok(()) => return Ok(()),
            Err(error) if is_database_busy(&error) && Instant::now() < deadline => {
                // Journal-mode changes can bypass SQLite's configured busy handler.
                std::thread::sleep(NOTES_BUSY_RETRY_DELAY);
            }
            Err(error) => {
                return Err(format!("Could not configure Notes storage: {error}"));
            }
        }
    }
}

fn is_database_busy(error: &Error) -> bool {
    matches!(
        error,
        Error::SqliteFailure(details, _)
            if matches!(details.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

#[derive(Clone)]
struct StoredNode {
    id: String,
    parent_id: Option<String>,
    sort_key: i64,
    title: String,
    note: String,
    image_offset_utf16: i64,
    markdown_image_width: Option<i64>,
    layout_mode: String,
    is_collapsed: bool,
    is_starred: bool,
    completed_at: Option<String>,
    deleted_at: Option<String>,
    deleted_batch_id: Option<String>,
    archived_at: Option<String>,
    archive_root_id: Option<String>,
    node_kind: NoteNodeKind,
    marker_kind: NoteMarkerKind,
    #[allow(dead_code)]
    is_readonly: Option<bool>,
    #[allow(dead_code)]
    plugin_state: Option<GithubNotificationsPluginState>,
    #[allow(dead_code)]
    plugin_meta: Option<GithubNotificationsPluginMeta>,
}

fn stored_node_from_row(row: &Row<'_>) -> rusqlite::Result<StoredNode> {
    let id = row.get::<_, String>(0)?;
    let is_readonly = readonly_from_row(row, 17)?;
    let plugin_state = plugin_state_from_row(row, 18)?;
    let plugin_meta = plugin_meta_from_row(row, 19)?;
    validate_plugin_storage(&id, is_readonly, &plugin_state, &plugin_meta, 17)?;
    Ok(StoredNode {
        id,
        parent_id: row.get(1)?,
        sort_key: row.get(2)?,
        title: row.get(3)?,
        note: row.get(4)?,
        image_offset_utf16: row.get(14)?,
        markdown_image_width: row.get(16)?,
        layout_mode: row.get(5)?,
        is_collapsed: row.get::<_, i64>(6)? != 0,
        is_starred: row.get::<_, i64>(7)? != 0,
        completed_at: row.get(8)?,
        deleted_at: row.get(9)?,
        deleted_batch_id: row.get(10)?,
        archived_at: row.get(11)?,
        archive_root_id: row.get(12)?,
        node_kind: note_node_kind_from_row(row, 13)?,
        marker_kind: note_marker_kind_from_row(row, 15)?,
        is_readonly,
        plugin_state,
        plugin_meta,
    })
}

fn note_node_kind_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<NoteNodeKind> {
    let value: String = row.get(index)?;
    match value.as_str() {
        "text" => Ok(NoteNodeKind::Text),
        "image" => Ok(NoteNodeKind::Image),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Unsupported Notes node kind: {value}"),
            )),
        )),
    }
}

fn note_marker_kind_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<NoteMarkerKind> {
    let value: String = row.get(index)?;
    match value.as_str() {
        "bullet" => Ok(NoteMarkerKind::Bullet),
        "todo" => Ok(NoteMarkerKind::Todo),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Unsupported Notes marker kind: {value}"),
            )),
        )),
    }
}

fn invalid_row(index: usize, message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message.into(),
        )),
    )
}

fn readonly_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<bool>> {
    match row.get::<_, Option<i64>>(index)? {
        None => Ok(None),
        Some(0) => Ok(Some(false)),
        Some(1) => Ok(Some(true)),
        Some(value) => Err(invalid_row(
            index,
            format!("Unsupported Notes readonly value: {value}"),
        )),
    }
}

fn plugin_state_from_json(
    value: Option<String>,
    index: usize,
) -> rusqlite::Result<Option<GithubNotificationsPluginState>> {
    value
        .map(|value| {
            serde_json::from_str::<Vec<String>>(&value)
                .and_then(|collapsed_groups| {
                    let state = GithubNotificationsPluginState { collapsed_groups };
                    state.is_valid().then_some(state).ok_or_else(|| {
                        serde_json::Error::io(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "plugin groups must be sorted unique calendar dates",
                        ))
                    })
                })
                .map_err(|error| invalid_row(index, format!("Invalid Notes plugin state: {error}")))
        })
        .transpose()
}

fn plugin_state_from_row(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<GithubNotificationsPluginState>> {
    plugin_state_from_json(row.get(index)?, index)
}

fn plugin_meta_from_json(
    value: Option<String>,
    index: usize,
) -> rusqlite::Result<Option<GithubNotificationsPluginMeta>> {
    value
        .map(|value| {
            parse_github_plugin_meta_storage(&value)
                .and_then(|metadata| {
                    metadata.is_valid().then_some(metadata).ok_or_else(|| {
                        serde_json::Error::io(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "plugin metadata is not canonical",
                        ))
                    })
                })
                .map_err(|error| {
                    invalid_row(index, format!("Invalid Notes plugin metadata: {error}"))
                })
        })
        .transpose()
}

fn plugin_meta_from_row(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<GithubNotificationsPluginMeta>> {
    plugin_meta_from_json(row.get(index)?, index)
}

fn validate_plugin_storage(
    id: &str,
    is_readonly: Option<bool>,
    plugin_state: &Option<GithubNotificationsPluginState>,
    plugin_meta: &Option<GithubNotificationsPluginMeta>,
    index: usize,
) -> rusqlite::Result<()> {
    let plugin_owned = id == GITHUB_NOTIFICATIONS_ROOT_ID || plugin_meta.is_some();
    if plugin_owned == is_readonly.is_some()
        || (id == GITHUB_NOTIFICATIONS_ROOT_ID) != plugin_state.is_some()
        || (plugin_state.is_some() && plugin_meta.is_some())
    {
        return Err(invalid_row(index, "Invalid Notes plugin/readonly storage."));
    }
    Ok(())
}

fn note_node_from_row(row: &Row<'_>) -> rusqlite::Result<NoteNode> {
    let layout_mode: String = row.get(5)?;
    let layout_mode = match layout_mode.as_str() {
        "bullets" => NoteLayoutMode::Bullets,
        value => {
            return Err(invalid_row(
                5,
                format!("Unsupported Notes layout mode: {value}"),
            ))
        }
    };
    let id: String = row.get(0)?;
    let is_readonly = readonly_from_row(row, 18)?;
    let plugin_state = plugin_state_from_row(row, 19)?;
    let plugin_meta = plugin_meta_from_row(row, 20)?;
    validate_plugin_storage(&id, is_readonly, &plugin_state, &plugin_meta, 18)?;
    Ok(NoteNode {
        id,
        node_kind: note_node_kind_from_row(row, 14)?,
        marker_kind: note_marker_kind_from_row(row, 16)?,
        parent_id: row.get(1)?,
        sort_key: row.get(2)?,
        title: row.get(3)?,
        note: row.get(4)?,
        image_offset_utf16: row.get(15)?,
        markdown_image_width: row.get(17)?,
        layout_mode,
        is_collapsed: row.get::<_, i64>(6)? != 0,
        is_starred: row.get::<_, i64>(7)? != 0,
        completed_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        deleted_at: row.get(11)?,
        archived_at: row.get(12)?,
        archive_root_id: row.get(13)?,
        is_readonly,
        plugin_state,
        plugin_meta,
    })
}

/// Column projection of a `notes_nodes` row as it is captured in the history
/// audit `after_json`/`before_json` payloads (storage-shaped keys plus the
/// `nodeKind` wire discriminator, with integer booleans).
fn deserialize_required_audit_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Deserialize)]
struct AuditNodeRow {
    id: String,
    #[serde(rename = "nodeKind")]
    node_kind: NoteNodeKind,
    #[serde(rename = "markerKind")]
    marker_kind: NoteMarkerKind,
    parent_id: Option<String>,
    sort_key: i64,
    title: String,
    note: String,
    image_offset_utf16: i64,
    markdown_image_width: Option<i64>,
    layout_mode: String,
    is_collapsed: i64,
    is_starred: i64,
    completed_at: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    archived_at: Option<String>,
    archive_root_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_audit_option")]
    is_readonly: Option<i64>,
    #[serde(deserialize_with = "deserialize_required_audit_option")]
    plugin_state: Option<String>,
    #[serde(deserialize_with = "deserialize_required_audit_option")]
    plugin_meta: Option<String>,
}

/// Decode a history-audit node payload (see `history::NODE_JSON_NEW`) into a
/// `NoteNode`. Unknown columns such as `deleted_batch_id` are ignored so the
/// audit trail can carry storage-only fields the workspace projection omits.
pub(crate) fn note_node_from_audit_json(after_json: &str) -> Result<NoteNode, String> {
    let row: AuditNodeRow = serde_json::from_str(after_json)
        .map_err(|error| format!("Could not decode an audited Notes node: {error}"))?;
    let layout_mode = match row.layout_mode.as_str() {
        "bullets" => NoteLayoutMode::Bullets,
        value => return Err(format!("Unsupported Notes layout mode: {value}")),
    };
    let is_readonly = match row.is_readonly {
        None => None,
        Some(0) => Some(false),
        Some(1) => Some(true),
        Some(value) => return Err(format!("Unsupported Notes readonly value: {value}")),
    };
    let plugin_state = plugin_state_from_json(row.plugin_state, 0)
        .map_err(|error| format!("Could not decode an audited Notes plugin state: {error}"))?;
    let plugin_meta = plugin_meta_from_json(row.plugin_meta, 0)
        .map_err(|error| format!("Could not decode audited Notes plugin metadata: {error}"))?;
    validate_plugin_storage(&row.id, is_readonly, &plugin_state, &plugin_meta, 0)
        .map_err(|error| format!("Could not decode audited Notes plugin storage: {error}"))?;
    Ok(NoteNode {
        id: row.id,
        node_kind: row.node_kind,
        marker_kind: row.marker_kind,
        parent_id: row.parent_id,
        sort_key: row.sort_key,
        title: row.title,
        note: row.note,
        image_offset_utf16: row.image_offset_utf16,
        markdown_image_width: row.markdown_image_width,
        layout_mode,
        is_collapsed: row.is_collapsed != 0,
        is_starred: row.is_starred != 0,
        completed_at: row.completed_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at,
        archived_at: row.archived_at,
        archive_root_id: row.archive_root_id,
        is_readonly,
        plugin_state,
        plugin_meta,
    })
}

fn note_attachment_from_row(row: &Row<'_>) -> rusqlite::Result<NoteAttachment> {
    Ok(NoteAttachment {
        id: row.get(0)?,
        node_id: row.get(1)?,
        sort_key: row.get(2)?,
        relative_path: row.get(3)?,
        content_hash: row.get(4)?,
        original_name: row.get(5)?,
        mime_type: row.get(6)?,
        byte_size: row.get(7)?,
        intrinsic_width: row.get(8)?,
        intrinsic_height: row.get(9)?,
        display_width: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn attachments_for_nodes(
    connection: &Connection,
    nodes: &[NoteNode],
) -> Result<BTreeMap<String, Vec<NoteAttachment>>, String> {
    if nodes.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut by_node_id = BTreeMap::<String, Vec<NoteAttachment>>::new();
    for chunk in nodes.chunks(500) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let mut statement = connection
            .prepare(&format!(
                "SELECT id, node_id, sort_key, relative_path, content_hash, original_name, \
                        mime_type, byte_size, intrinsic_width, intrinsic_height, display_width, \
                        created_at, updated_at \
                 FROM notes_attachments WHERE node_id IN ({placeholders}) \
                 ORDER BY node_id, sort_key, id"
            ))
            .map_err(|error| format!("Could not prepare Notes attachments: {error}"))?;
        let attachments = statement
            .query_map(
                params_from_iter(chunk.iter().map(|node| node.id.as_str())),
                note_attachment_from_row,
            )
            .map_err(|error| format!("Could not load Notes attachments: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not read Notes attachments: {error}"))?;
        for attachment in attachments {
            by_node_id
                .entry(attachment.node_id.clone())
                .or_default()
                .push(attachment);
        }
    }
    Ok(by_node_id)
}

/// Loads a single node's attachment metadata rows in stored order. Used by
/// `duplicate_node_at` to clone attachment rows onto the copied nodes.
fn node_attachments(connection: &Connection, node_id: &str) -> Result<Vec<NoteAttachment>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, node_id, sort_key, relative_path, content_hash, original_name, \
                    mime_type, byte_size, intrinsic_width, intrinsic_height, display_width, \
                    created_at, updated_at \
             FROM notes_attachments WHERE node_id = ?1 ORDER BY sort_key, id",
        )
        .map_err(|error| format!("Could not prepare a node's Notes attachments: {error}"))?;
    let attachments = statement
        .query_map([node_id], note_attachment_from_row)
        .map_err(|error| format!("Could not load a node's Notes attachments: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read a node's Notes attachments: {error}"))?;
    Ok(attachments)
}

fn query_workspace<P: Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> Result<NotesWorkspace, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Could not prepare the Notes workspace: {error}"))?;
    let nodes = statement
        .query_map(params, note_node_from_row)
        .map_err(|error| format!("Could not load the Notes workspace: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Notes workspace: {error}"))?;
    let attachments_by_node_id = attachments_for_nodes(connection, &nodes)?;
    Ok(NotesWorkspace {
        nodes,
        attachments_by_node_id,
    })
}

struct StoredExportNode {
    id: String,
    parent_id: Option<String>,
    sort_key: i64,
    node_kind: NoteNodeKind,
    marker_kind: NoteMarkerKind,
    title: String,
    note: String,
    image_offset_utf16: i64,
    title_date_spans: Vec<ExportDateSpan>,
    note_date_spans: Vec<ExportDateSpan>,
    completed_at: Option<String>,
}

struct StoredExportDate {
    field: String,
    start_utf16: i64,
    end_utf16: i64,
    normalized_start: String,
    normalized_end: String,
}

fn validate_export_subtree_budget(node_count: usize, max_depth: usize) -> Result<(), String> {
    if node_count > MAX_NOTES_EXPORT_NODES {
        return Err(format!(
            "Notes export must contain at most {MAX_NOTES_EXPORT_NODES} nodes."
        ));
    }
    if max_depth > MAX_NOTES_EXPORT_DEPTH {
        return Err(format!(
            "Notes export cannot nest deeper than {MAX_NOTES_EXPORT_DEPTH} levels."
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExportSnapshotRowCounts {
    pub(crate) node_rows: usize,
    pub(crate) date_rows: usize,
}

#[cfg(test)]
thread_local! {
    static INJECT_EXPORT_SNAPSHOT_QUERY_BOUNDARY: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn inject_export_snapshot_query_boundary_once(action: impl FnOnce() + 'static) {
    INJECT_EXPORT_SNAPSHOT_QUERY_BOUNDARY.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

fn maybe_inject_export_snapshot_query_boundary() {
    #[cfg(test)]
    INJECT_EXPORT_SNAPSHOT_QUERY_BOUNDARY.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

pub(crate) fn load_export_snapshot(
    connection: &Connection,
    root_node_id: &str,
) -> Result<NotesExportSnapshot, String> {
    load_export_snapshot_inner(connection, root_node_id).map(|(snapshot, _)| snapshot)
}

#[cfg(test)]
pub(crate) fn load_export_snapshot_with_row_counts(
    connection: &Connection,
    root_node_id: &str,
) -> Result<(NotesExportSnapshot, ExportSnapshotRowCounts), String> {
    load_export_snapshot_inner(connection, root_node_id)
}

fn load_export_snapshot_inner(
    connection: &Connection,
    root_node_id: &str,
) -> Result<(NotesExportSnapshot, ExportSnapshotRowCounts), String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Could not start the Notes export read transaction: {error}"))?;
    let snapshot = load_export_snapshot_queries(&transaction, root_node_id)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not finish the Notes export read transaction: {error}"))?;
    Ok(snapshot)
}

fn load_export_snapshot_queries(
    connection: &Connection,
    root_node_id: &str,
) -> Result<(NotesExportSnapshot, ExportSnapshotRowCounts), String> {
    validate_note_id(root_node_id)?;
    let mut statement = connection
        .prepare(
            "WITH RECURSIVE \
             export_context(exported_at) AS (\
               SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
             ), \
             subtree(id, path, cycle, depth) AS (\
               SELECT id, '|' || id || '|', 0, 1 FROM notes_nodes \
               WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL \
               UNION ALL \
               SELECT child.id, subtree.path || child.id || '|', \
                      instr(subtree.path, '|' || child.id || '|') > 0, \
                      subtree.depth + 1 \
               FROM notes_nodes child \
               JOIN subtree ON child.parent_id = subtree.id \
               WHERE child.deleted_at IS NULL AND child.archived_at IS NULL \
                 AND subtree.cycle = 0 AND subtree.depth <= ?2 \
               LIMIT ?3\
             ) \
             SELECT node.id, node.parent_id, node.sort_key, node.node_kind, node.marker_kind, node.title, node.note, \
                    node.image_offset_utf16, node.completed_at, subtree.cycle, export_context.exported_at, subtree.depth \
             FROM subtree \
             JOIN notes_nodes node ON node.id = subtree.id \
             CROSS JOIN export_context \
             ORDER BY node.id",
        )
        .map_err(|error| format!("Could not prepare the Notes export snapshot: {error}"))?;
    let rows = statement
        .query_map(
            params![
                root_node_id,
                i64::try_from(MAX_NOTES_EXPORT_DEPTH).expect("export depth limit fits i64"),
                i64::try_from(MAX_NOTES_EXPORT_NODES + 1)
                    .expect("export node probe limit fits i64"),
            ],
            |row| {
                Ok((
                    StoredExportNode {
                        id: row.get(0)?,
                        parent_id: row.get(1)?,
                        sort_key: row.get(2)?,
                        node_kind: note_node_kind_from_row(row, 3)?,
                        marker_kind: note_marker_kind_from_row(row, 4)?,
                        title: row.get(5)?,
                        note: row.get(6)?,
                        image_offset_utf16: row.get(7)?,
                        title_date_spans: Vec::new(),
                        note_date_spans: Vec::new(),
                        completed_at: row.get(8)?,
                    },
                    row.get::<_, i64>(9)? != 0,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)?,
                ))
            },
        )
        .map_err(|error| format!("Could not load the Notes export snapshot: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Notes export snapshot: {error}"))?;

    if rows.is_empty() {
        return Err(format!(
            "Note node {root_node_id} is missing, deleted, or archived and cannot be exported."
        ));
    }
    if rows.iter().any(|(_, cycle, _, _)| *cycle) {
        return Err("The Notes tree contains a cycle and cannot be exported.".to_string());
    }

    let node_rows = rows.len();
    let max_depth = rows
        .iter()
        .try_fold(0usize, |max_depth, (_, _, _, depth)| {
            let depth = usize::try_from(*depth)
                .map_err(|_| "The Notes export subtree depth is invalid.".to_string())?;
            if depth == 0 {
                return Err("The Notes export subtree depth is invalid.".to_string());
            }
            Ok(max_depth.max(depth))
        })?;
    validate_export_subtree_budget(node_rows, max_depth)?;
    let exported_at = rows[0].2.clone();
    let mut by_id = HashMap::new();
    for (node, _, _, _) in rows {
        if by_id.insert(node.id.clone(), node).is_some() {
            return Err("The Notes export subtree contains duplicate nodes.".to_string());
        }
    }
    maybe_inject_export_snapshot_query_boundary();

    let mut date_statement = connection
        .prepare(
            "WITH RECURSIVE subtree(id, path, cycle) AS (\
               SELECT id, '|' || id || '|', 0 FROM notes_nodes \
               WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL \
               UNION ALL \
               SELECT child.id, subtree.path || child.id || '|', \
                      instr(subtree.path, '|' || child.id || '|') > 0 \
               FROM notes_nodes child \
               JOIN subtree ON child.parent_id = subtree.id \
               WHERE child.deleted_at IS NULL AND child.archived_at IS NULL \
                 AND subtree.cycle = 0\
             ) \
             SELECT date.node_id, date.field, date.start_utf16, date.end_utf16, \
                    date.normalized_start, date.normalized_end \
             FROM notes_dates date \
             JOIN subtree ON subtree.id = date.node_id \
             WHERE subtree.cycle = 0 \
             ORDER BY date.node_id, date.field, date.start_utf16, date.end_utf16",
        )
        .map_err(|error| format!("Could not prepare Notes export dates: {error}"))?;
    let date_rows = date_statement
        .query_map([root_node_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                StoredExportDate {
                    field: row.get(1)?,
                    start_utf16: row.get(2)?,
                    end_utf16: row.get(3)?,
                    normalized_start: row.get(4)?,
                    normalized_end: row.get(5)?,
                },
            ))
        })
        .map_err(|error| format!("Could not load Notes export dates: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes export dates: {error}"))?;
    let date_row_count = date_rows.len();
    for (node_id, indexed_date) in date_rows {
        let stored = by_id.get_mut(&node_id).ok_or_else(|| {
            format!("Note node {node_id} has an indexed date outside the export subtree.")
        })?;
        let start_utf16 = usize::try_from(indexed_date.start_utf16)
            .map_err(|_| format!("Note node {node_id} has an invalid export date start offset."))?;
        let end_utf16 = usize::try_from(indexed_date.end_utf16)
            .map_err(|_| format!("Note node {node_id} has an invalid export date end offset."))?;
        if start_utf16 >= end_utf16 {
            return Err(format!(
                "Note node {node_id} has an invalid export date span."
            ));
        }
        let normalized_start = LocalDate::parse_iso(&indexed_date.normalized_start)
            .ok_or_else(|| format!("Note node {node_id} has an invalid normalized start date."))?;
        let normalized_end = LocalDate::parse_iso(&indexed_date.normalized_end)
            .ok_or_else(|| format!("Note node {node_id} has an invalid normalized end date."))?;
        if normalized_start > normalized_end {
            return Err(format!(
                "Note node {node_id} has a reversed normalized export date range."
            ));
        }
        let span = ExportDateSpan {
            start_utf16,
            end_utf16,
            normalized_start: indexed_date.normalized_start,
            normalized_end: indexed_date.normalized_end,
        };
        match indexed_date.field.as_str() {
            "title" => stored.title_date_spans.push(span),
            "note" => stored.note_date_spans.push(span),
            _ => {
                return Err(format!(
                    "Note node {node_id} has an unsupported export date field."
                ))
            }
        }
    }
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for node in by_id.values() {
        if node.id == root_node_id {
            continue;
        }
        let parent_id = node
            .parent_id
            .as_ref()
            .ok_or_else(|| format!("Note node {} has no parent in the export subtree.", node.id))?;
        if !by_id.contains_key(parent_id) {
            return Err(format!(
                "Note node {} has a missing parent in the export subtree.",
                node.id
            ));
        }
        children
            .entry(parent_id.clone())
            .or_default()
            .push(node.id.clone());
    }
    for child_ids in children.values_mut() {
        child_ids.sort_by(|left, right| {
            let left_node = &by_id[left];
            let right_node = &by_id[right];
            left_node
                .sort_key
                .cmp(&right_node.sort_key)
                .then_with(|| left.cmp(right))
        });
    }

    let attachment_count: i64 = connection
        .query_row(
            "WITH RECURSIVE subtree(id, path, cycle) AS (\
               SELECT id, '|' || id || '|', 0 FROM notes_nodes \
               WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL \
               UNION ALL \
               SELECT child.id, subtree.path || child.id || '|', \
                      instr(subtree.path, '|' || child.id || '|') > 0 \
               FROM notes_nodes child \
               JOIN subtree ON child.parent_id = subtree.id \
               WHERE child.deleted_at IS NULL AND child.archived_at IS NULL \
                 AND subtree.cycle = 0\
             ) \
             SELECT COUNT(*) FROM notes_attachments attachment \
             JOIN subtree ON subtree.id = attachment.node_id \
             WHERE subtree.cycle = 0",
            [root_node_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not count Notes export attachments: {error}"))?;
    let attachment_count = usize::try_from(attachment_count)
        .map_err(|_| "The Notes export attachment count is invalid.".to_string())?;
    if attachment_count > MAX_NOTES_EXPORT_ATTACHMENTS {
        return Err(format!(
            "Notes export must contain at most {MAX_NOTES_EXPORT_ATTACHMENTS} image attachments."
        ));
    }

    let mut attachments_by_node_id: HashMap<String, Vec<ExportAttachment>> = HashMap::new();
    let mut attachment_statement = connection
        .prepare(
            "WITH RECURSIVE subtree(id, path, cycle) AS (\
               SELECT id, '|' || id || '|', 0 FROM notes_nodes \
               WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL \
               UNION ALL \
               SELECT child.id, subtree.path || child.id || '|', \
                      instr(subtree.path, '|' || child.id || '|') > 0 \
               FROM notes_nodes child \
               JOIN subtree ON child.parent_id = subtree.id \
               WHERE child.deleted_at IS NULL AND child.archived_at IS NULL \
                 AND subtree.cycle = 0\
             ) \
             SELECT attachment.id, attachment.node_id, attachment.relative_path, \
                    attachment.content_hash, attachment.original_name, attachment.mime_type, \
                    attachment.byte_size, attachment.intrinsic_width, \
                    attachment.intrinsic_height, attachment.display_width \
             FROM notes_attachments attachment \
             JOIN subtree ON subtree.id = attachment.node_id \
             WHERE subtree.cycle = 0 \
             ORDER BY attachment.node_id, attachment.sort_key, attachment.id",
        )
        .map_err(|error| format!("Could not prepare Notes export attachments: {error}"))?;
    let attachment_rows = attachment_statement
        .query_map([root_node_id], |row| {
            Ok((
                row.get::<_, String>(1)?,
                ExportAttachment {
                    id: row.get(0)?,
                    relative_path: row.get(2)?,
                    content_hash: row.get(3)?,
                    original_name: row.get(4)?,
                    mime_type: row.get(5)?,
                    byte_size: row.get(6)?,
                    intrinsic_width: row.get(7)?,
                    intrinsic_height: row.get(8)?,
                    display_width: row.get(9)?,
                    bytes: None,
                },
            ))
        })
        .map_err(|error| format!("Could not load Notes export attachments: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes export attachments: {error}"))?;
    for (node_id, attachment) in attachment_rows {
        attachments_by_node_id
            .entry(node_id)
            .or_default()
            .push(attachment);
    }

    fn build_node(
        node_id: &str,
        by_id: &mut HashMap<String, StoredExportNode>,
        children: &HashMap<String, Vec<String>>,
        attachments_by_node_id: &mut HashMap<String, Vec<ExportAttachment>>,
        visited: &mut HashSet<String>,
    ) -> Result<ExportNode, String> {
        if !visited.insert(node_id.to_string()) {
            return Err("The Notes tree contains a cycle and cannot be exported.".to_string());
        }
        let node = by_id.remove(node_id).ok_or_else(|| {
            format!("Note node {node_id} disappeared while building the export snapshot.")
        })?;
        let child_ids = children.get(node_id).cloned().unwrap_or_default();
        let child_nodes = child_ids
            .iter()
            .map(|child_id| build_node(child_id, by_id, children, attachments_by_node_id, visited))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ExportNode {
            id: node.id,
            node_kind: node.node_kind,
            marker_kind: node.marker_kind,
            title: node.title,
            note: node.note,
            image_offset_utf16: node.image_offset_utf16,
            title_date_spans: node.title_date_spans,
            note_date_spans: node.note_date_spans,
            completed: node.completed_at.is_some(),
            attachments: attachments_by_node_id.remove(node_id).unwrap_or_default(),
            children: child_nodes,
        })
    }

    let root = build_node(
        root_node_id,
        &mut by_id,
        &children,
        &mut attachments_by_node_id,
        &mut HashSet::new(),
    )?;
    if !by_id.is_empty() {
        return Err("The Notes export subtree could not be assembled safely.".to_string());
    }
    if !attachments_by_node_id.is_empty() {
        return Err("The Notes export attachments could not be assembled safely.".to_string());
    }
    root.validate_for_export()?;

    Ok((
        NotesExportSnapshot {
            root_node_id: root_node_id.to_string(),
            title: root.title.clone(),
            exported_at,
            root,
        },
        ExportSnapshotRowCounts {
            node_rows,
            date_rows: date_row_count,
        },
    ))
}

pub(crate) fn load_workspace(
    connection: &Connection,
    scope: NotesWorkspaceScope,
) -> Result<NotesWorkspace, String> {
    const COLUMNS: &str = "node.id, CASE WHEN node.parent_id IS NULL OR EXISTS (\
           SELECT 1 FROM included parent WHERE parent.id = node.parent_id\
         ) THEN node.parent_id ELSE NULL END, \
         node.sort_key, node.title, node.note, node.layout_mode, node.is_collapsed, \
         node.is_starred, node.completed_at, node.created_at, node.updated_at, \
         node.deleted_at, node.archived_at, node.archive_root_id, node.node_kind, \
         node.image_offset_utf16, node.marker_kind, node.markdown_image_width, \
         node.is_readonly, node.plugin_state, node.plugin_meta";
    const ACTIVE_SQL: &str =
        "SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                is_starred, completed_at, created_at, updated_at, deleted_at, \
                archived_at, archive_root_id, node_kind, image_offset_utf16, \
                marker_kind, markdown_image_width, \
                is_readonly, plugin_state, plugin_meta \
         FROM notes_nodes WHERE deleted_at IS NULL AND archived_at IS NULL \
         ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, parent_id, sort_key, id";
    let empty = || NotesWorkspace {
        nodes: Vec::new(),
        attachments_by_node_id: BTreeMap::new(),
    };
    if matches!(&scope, NotesWorkspaceScope::Tags { tags } if tags.is_empty()) {
        return Ok(empty());
    }

    let ancestor_predicate = match &scope {
        NotesWorkspaceScope::Archive => {
            "parent.deleted_at IS NULL AND parent.archived_at IS NOT NULL"
        }
        NotesWorkspaceScope::Trash => "parent.deleted_at IS NOT NULL",
        NotesWorkspaceScope::Active
        | NotesWorkspaceScope::Starred
        | NotesWorkspaceScope::Recent
        | NotesWorkspaceScope::Tag { .. }
        | NotesWorkspaceScope::Tags { .. } => {
            "parent.deleted_at IS NULL AND parent.archived_at IS NULL"
        }
    };
    let (match_sql, parameters): (String, Vec<String>) = match scope {
        NotesWorkspaceScope::Active => {
            return query_workspace(connection, ACTIVE_SQL, []);
        }
        NotesWorkspaceScope::Starred => (
            "SELECT id, parent_id FROM user_nodes \
             WHERE deleted_at IS NULL AND archived_at IS NULL AND is_starred = 1"
                .to_string(),
            vec![GITHUB_NOTIFICATIONS_ROOT_ID.to_string()],
        ),
        NotesWorkspaceScope::Recent => (
            "SELECT id, parent_id FROM user_nodes \
             WHERE deleted_at IS NULL AND archived_at IS NULL \
             ORDER BY updated_at DESC, id LIMIT 100"
                .to_string(),
            vec![GITHUB_NOTIFICATIONS_ROOT_ID.to_string()],
        ),
        NotesWorkspaceScope::Tag { tag } => {
            let normalized_tag = normalize_tag_identity(tag.trim().trim_start_matches('#'));
            if normalized_tag.is_empty() {
                return Ok(empty());
            }
            (
                "SELECT node.id, node.parent_id FROM user_nodes node \
                 JOIN notes_tags tag ON tag.node_id = node.id \
                 WHERE node.deleted_at IS NULL AND node.archived_at IS NULL \
                   AND tag.prefix = '#' AND tag.normalized_tag = ?2"
                    .to_string(),
                vec![GITHUB_NOTIFICATIONS_ROOT_ID.to_string(), normalized_tag],
            )
        }
        NotesWorkspaceScope::Tags { tags } => {
            return load_tag_workspace(connection, tags);
        }
        NotesWorkspaceScope::Archive => (
            "SELECT id, parent_id FROM user_nodes \
             WHERE deleted_at IS NULL AND archived_at IS NOT NULL \
               AND archive_root_id IS NOT NULL"
                .to_string(),
            vec![GITHUB_NOTIFICATIONS_ROOT_ID.to_string()],
        ),
        NotesWorkspaceScope::Trash => (
            "SELECT id, parent_id FROM user_nodes WHERE deleted_at IS NOT NULL".to_string(),
            vec![GITHUB_NOTIFICATIONS_ROOT_ID.to_string()],
        ),
    };
    let sql = format!(
        "WITH RECURSIVE user_nodes AS (\
           SELECT * FROM notes_nodes WHERE {EXCLUDE_PLUGIN_OWNED_SQL}\
         ), matched(id, parent_id) AS ({match_sql}), included(id, parent_id) AS (\
           SELECT id, parent_id FROM matched \
           UNION \
           SELECT parent.id, parent.parent_id FROM user_nodes parent \
           JOIN included child ON child.parent_id = parent.id \
           WHERE {ancestor_predicate}\
         ) \
         SELECT {COLUMNS} \
         FROM user_nodes node JOIN included ON included.id = node.id \
         ORDER BY CASE WHEN node.parent_id IS NULL OR NOT EXISTS (\
                    SELECT 1 FROM included parent WHERE parent.id = node.parent_id\
                  ) THEN 0 ELSE 1 END, node.parent_id, node.sort_key, node.id"
    );
    query_workspace(connection, &sql, params_from_iter(parameters.iter()))
}

fn load_tag_workspace(
    connection: &Connection,
    tags: Vec<NoteTagFilter>,
) -> Result<NotesWorkspace, String> {
    validate_note_tag_filters(&tags)?;
    let tags = tags
        .into_iter()
        .map(|tag| (tag.prefix, tag.normalized_tag))
        .collect::<BTreeSet<_>>();
    if tags.is_empty() {
        return Ok(NotesWorkspace {
            nodes: Vec::new(),
            attachments_by_node_id: BTreeMap::new(),
        });
    }
    let mut parameters = vec![GITHUB_NOTIFICATIONS_ROOT_ID.to_string()];
    let mut required = Vec::with_capacity(tags.len());
    for (prefix, normalized_tag) in tags {
        parameters.push(prefix.as_str().to_string());
        let prefix_parameter = parameters.len();
        parameters.push(normalized_tag);
        let tag_parameter = parameters.len();
        required.push(format!(
            "EXISTS (SELECT 1 FROM notes_tags tag \
             WHERE tag.node_id = node.id AND tag.prefix = ?{prefix_parameter} \
               AND tag.normalized_tag = ?{tag_parameter})"
        ));
    }
    let sql = format!(
        "WITH RECURSIVE user_nodes AS (\
           SELECT * FROM notes_nodes WHERE {EXCLUDE_PLUGIN_OWNED_SQL}\
         ), matched(id, parent_id) AS (\
           SELECT node.id, node.parent_id FROM user_nodes node \
           WHERE node.deleted_at IS NULL AND node.archived_at IS NULL AND {}\
         ), included(id, parent_id) AS (\
           SELECT id, parent_id FROM matched \
           UNION \
           SELECT parent.id, parent.parent_id FROM user_nodes parent \
           JOIN included child ON child.parent_id = parent.id \
           WHERE parent.deleted_at IS NULL AND parent.archived_at IS NULL\
         ) \
         SELECT node.id, CASE WHEN node.parent_id IS NULL OR EXISTS (\
                  SELECT 1 FROM included parent WHERE parent.id = node.parent_id\
                ) THEN node.parent_id ELSE NULL END, \
                node.sort_key, node.title, node.note, node.layout_mode, node.is_collapsed, \
                node.is_starred, node.completed_at, node.created_at, node.updated_at, \
                node.deleted_at, node.archived_at, node.archive_root_id, node.node_kind, \
                node.image_offset_utf16, node.marker_kind, node.markdown_image_width, \
                node.is_readonly, node.plugin_state, node.plugin_meta \
         FROM user_nodes node JOIN included ON included.id = node.id \
         ORDER BY CASE WHEN node.parent_id IS NULL OR NOT EXISTS (\
                    SELECT 1 FROM included parent WHERE parent.id = node.parent_id\
                  ) THEN 0 ELSE 1 END, node.parent_id, node.sort_key, node.id",
        required.join(" AND ")
    );
    query_workspace(connection, &sql, params_from_iter(parameters.iter()))
}

pub(crate) fn validate_note_tag_filters(tags: &[NoteTagFilter]) -> Result<(), String> {
    if tags
        .iter()
        .any(|tag| !is_canonical_tag_body(&tag.normalized_tag))
    {
        return Err(
            "Structured Notes search tag normalizedTag must be a canonical tag body.".to_string(),
        );
    }
    Ok(())
}

pub(crate) fn list_tags(connection: &Connection) -> Result<Vec<String>, String> {
    let sql = format!(
        "WITH user_nodes AS (\
           SELECT * FROM notes_nodes WHERE {EXCLUDE_PLUGIN_OWNED_SQL}\
         ) \
         SELECT DISTINCT tag.normalized_tag FROM notes_tags tag \
         JOIN user_nodes node ON node.id = tag.node_id \
         WHERE node.deleted_at IS NULL AND node.archived_at IS NULL \
           AND tag.prefix = '#' \
         ORDER BY tag.normalized_tag"
    );
    connection
        .prepare(&sql)
        .map_err(|error| format!("Could not prepare the v3 Notes tag list: {error}"))?
        .query_map([GITHUB_NOTIFICATIONS_ROOT_ID], |row| row.get(0))
        .map_err(|error| format!("Could not load the v3 Notes tag list: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the v3 Notes tag list: {error}"))
}

fn note_tag_prefix_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<NoteTagPrefix> {
    let prefix: String = row.get(index)?;
    match prefix.as_str() {
        "#" => Ok(NoteTagPrefix::Hash),
        "@" => Ok(NoteTagPrefix::Mention),
        value => Err(invalid_row(
            index,
            format!("Unsupported Notes tag prefix: {value}"),
        )),
    }
}

pub(crate) fn list_tags_with_counts(
    connection: &Connection,
) -> Result<Vec<NoteTagSummary>, String> {
    let sql = format!(
        "WITH user_nodes AS (\
           SELECT * FROM notes_nodes WHERE {EXCLUDE_PLUGIN_OWNED_SQL}\
         ), live_tags AS (\
           SELECT tag.prefix, tag.normalized_tag, tag.tag, \
                  row_number() OVER (\
                    PARTITION BY tag.prefix, tag.normalized_tag \
                    ORDER BY node.created_at, node.id\
                  ) AS display_rank \
           FROM notes_tags tag JOIN user_nodes node ON node.id = tag.node_id \
           WHERE node.deleted_at IS NULL AND node.archived_at IS NULL\
         ) \
         SELECT prefix, normalized_tag, \
                max(CASE WHEN display_rank = 1 THEN tag END), count(*) \
         FROM live_tags GROUP BY prefix, normalized_tag ORDER BY prefix, normalized_tag"
    );
    connection
        .prepare(&sql)
        .map_err(|error| format!("Could not prepare counted v3 Notes tags: {error}"))?
        .query_map([GITHUB_NOTIFICATIONS_ROOT_ID], |row| {
            Ok(NoteTagSummary {
                prefix: note_tag_prefix_from_row(row, 0)?,
                normalized_tag: row.get(1)?,
                display_tag: row.get(2)?,
                count: row.get(3)?,
            })
        })
        .map_err(|error| format!("Could not load counted v3 Notes tags: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read counted v3 Notes tags: {error}"))
}

fn fts_match_expression(query: &str) -> Option<String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    for character in query.trim().chars() {
        if character.is_alphanumeric() || character == '_' {
            token.push(character);
        } else if !token.is_empty() {
            tokens.push(std::mem::take(&mut token));
        }
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    if tokens.is_empty() {
        return None;
    }

    Some(
        tokens
            .into_iter()
            .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

fn image_primary_segments(title: &str, image_offset_utf16: i64) -> Result<(&str, &str), String> {
    let byte_offset = crate::notes::schema::validate_image_offset_utf16(
        title,
        NoteNodeKind::Image,
        image_offset_utf16,
    )?;
    Ok(title.split_at(byte_offset))
}

fn primary_title_segments(
    node_kind: NoteNodeKind,
    title: &str,
    image_offset_utf16: i64,
) -> Result<Vec<(&str, i64)>, String> {
    match node_kind {
        NoteNodeKind::Text => Ok(vec![(title, 0)]),
        NoteNodeKind::Image => {
            let (before, after) = image_primary_segments(title, image_offset_utf16)?;
            Ok(vec![(before, 0), (after, image_offset_utf16)])
        }
    }
}

fn note_display_label(
    node_kind: NoteNodeKind,
    title: &str,
    image_offset_utf16: i64,
    attachment_name: Option<&str>,
) -> Result<String, String> {
    match node_kind {
        NoteNodeKind::Text => Ok(title.trim().to_string()),
        NoteNodeKind::Image => {
            let (before, after) = image_primary_segments(title, image_offset_utf16)?;
            let primary = [before.trim(), after.trim()]
                .into_iter()
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            Ok(if primary.is_empty() {
                attachment_name.unwrap_or_default().to_string()
            } else {
                primary
            })
        }
    }
}

fn exact_image_attachment_name_sql(node: &str) -> String {
    format!(
        "CASE WHEN {node}.node_kind = 'image' \
         AND 1 = (SELECT COUNT(*) FROM notes_attachments WHERE node_id = {node}.id) \
         THEN (SELECT original_name FROM notes_attachments WHERE node_id = {node}.id) \
         ELSE NULL END"
    )
}

fn extract_tags_for_node(
    node_kind: NoteNodeKind,
    title: &str,
    image_offset_utf16: i64,
    note: &str,
) -> Result<BTreeMap<(NoteTagPrefix, String), String>, String> {
    if node_kind == NoteNodeKind::Text {
        return Ok(extract_note_tags(title, note));
    }
    let mut tags = BTreeMap::new();
    for source in primary_title_segments(node_kind, title, image_offset_utf16)?
        .into_iter()
        .map(|(source, _)| source)
        .chain(std::iter::once(note))
    {
        for token in tokenize_note_text(source) {
            tags.entry((token.prefix, token.normalized))
                .or_insert(token.display);
        }
    }
    Ok(tags)
}

fn primary_title_contains_tag(
    node_kind: NoteNodeKind,
    title: &str,
    image_offset_utf16: i64,
    tags: &BTreeSet<(NoteTagPrefix, String)>,
) -> Result<bool, String> {
    Ok(
        primary_title_segments(node_kind, title, image_offset_utf16)?
            .into_iter()
            .flat_map(|(source, _)| tokenize_note_text(source))
            .any(|tag| tags.contains(&(tag.prefix, tag.normalized))),
    )
}

/// Resolve the ancestor title trail for each search hit with a recursive CTE
/// scoped to the LIMITed result set, instead of loading every
/// `(id, parent_id, title, node_kind)` row in the vault into a map on every
/// search.
///
/// The walk only follows ancestors that satisfy the same scope predicate as the
/// match set, so an out-of-scope ancestor (for example a live parent above a
/// trashed node) terminates the trail exactly like the previous map lookup did.
/// Each returned trail is ordered root-first. Node trees are acyclic by
/// construction; the depth bound is a defensive guard against a corrupt cycle.
#[derive(Clone, Default)]
struct SearchParentTrail {
    titles: Vec<String>,
    kinds: Vec<NoteNodeKind>,
}

fn search_parent_trails_impl(
    connection: &Connection,
    scope: NoteSearchScope,
    node_ids: &[&str],
) -> Result<HashMap<String, SearchParentTrail>, String> {
    const MAX_TRAIL_DEPTH: i64 = 10_000;
    let mut trails: HashMap<String, SearchParentTrail> = HashMap::new();
    if node_ids.is_empty() {
        return Ok(trails);
    }
    let scope_predicate = search_scope_predicate(scope);
    let unique_ids = node_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    for chunk in unique_ids.chunks(ANCESTOR_CLOSURE_CHUNK_SIZE) {
        #[cfg(test)]
        SEARCH_PARENT_TRAIL_QUERY_COUNT.with(|count| count.set(count.get() + 1));
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let attachment_name = exact_image_attachment_name_sql("ancestor_trail");
        let visible_nodes = format!(
            "visible_nodes AS (\
               SELECT * FROM notes_nodes WHERE {EXCLUDE_PLUGIN_OWNED_SQL}\
             ), "
        );
        let sql = format!(
            "WITH RECURSIVE {visible_nodes}ancestor_trail(match_id, id, parent_id, title, node_kind, image_offset_utf16, depth) AS (\
               SELECT child.id, node.id, node.parent_id, node.title, node.node_kind, \
                      node.image_offset_utf16, 0 \
               FROM visible_nodes child \
               JOIN visible_nodes node ON node.id = child.parent_id \
               WHERE child.id IN ({placeholders}) AND {scope_predicate} \
               UNION ALL \
               SELECT ancestor_trail.match_id, node.id, node.parent_id, node.title, node.node_kind, \
                      node.image_offset_utf16, ancestor_trail.depth + 1 \
               FROM ancestor_trail \
               JOIN visible_nodes node ON node.id = ancestor_trail.parent_id \
               WHERE ancestor_trail.depth < {MAX_TRAIL_DEPTH} AND {scope_predicate}\
             ) \
             SELECT match_id, title, node_kind, image_offset_utf16, {attachment_name}, depth \
             FROM ancestor_trail \
             ORDER BY match_id, depth DESC"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("Could not prepare Notes search ancestors: {error}"))?;
        let mut parameters = Vec::with_capacity(chunk.len() + 1);
        parameters.push(GITHUB_NOTIFICATIONS_ROOT_ID);
        parameters.extend_from_slice(chunk);
        let rows = statement
            .query_map(params_from_iter(parameters), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    note_node_kind_from_row(row, 2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|error| format!("Could not load Notes search ancestors: {error}"))?;
        for row in rows {
            let (match_id, title, kind, image_offset_utf16, attachment_name) =
                row.map_err(|error| format!("Could not read Notes search ancestors: {error}"))?;
            let trail = trails.entry(match_id).or_default();
            trail.titles.push(note_display_label(
                kind,
                &title,
                image_offset_utf16,
                attachment_name.as_deref(),
            )?);
            trail.kinds.push(kind);
        }
    }
    Ok(trails)
}

#[cfg(test)]
pub(crate) fn search_nodes(
    connection: &Connection,
    query: &str,
) -> Result<Vec<NoteSearchResult>, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    search_nodes_at(connection, query, NoteSearchScope::Active, today)
}

fn search_scope_predicate(scope: NoteSearchScope) -> &'static str {
    match scope {
        NoteSearchScope::Active => "node.deleted_at IS NULL AND node.archived_at IS NULL",
        NoteSearchScope::Archive => "node.deleted_at IS NULL AND node.archived_at IS NOT NULL",
        NoteSearchScope::Trash => "node.deleted_at IS NOT NULL",
    }
}

fn search_parent_trails(
    connection: &Connection,
    scope: NoteSearchScope,
    node_ids: &[&str],
) -> Result<HashMap<String, SearchParentTrail>, String> {
    search_parent_trails_impl(connection, scope, node_ids)
}

pub(crate) fn search_nodes_at(
    connection: &Connection,
    query: &str,
    scope: NoteSearchScope,
    today: LocalDate,
) -> Result<Vec<NoteSearchResult>, String> {
    let attachment_name = exact_image_attachment_name_sql("node");
    let (sql, parameters, matched_field) =
        if let Some(range) = parse_note_date_expression(query, today, WeekStartsOn::Monday) {
            (
                format!(
                    "WITH user_nodes AS (\
                       SELECT * FROM notes_nodes WHERE {EXCLUDE_PLUGIN_OWNED_SQL}\
                     ) \
                     SELECT DISTINCT node.id, node.title, node.node_kind, \
                            node.image_offset_utf16, {attachment_name}, 0, 0 \
                     FROM notes_dates date INDEXED BY notes_dates_range \
                     JOIN user_nodes node ON node.id = date.node_id \
                     WHERE date.normalized_start <= ?2 AND date.normalized_end >= ?3 \
                       AND {} \
                     ORDER BY node.updated_at DESC, node.id LIMIT 100",
                    search_scope_predicate(scope)
                ),
                vec![
                    GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                    range.end.to_iso(),
                    range.start.to_iso(),
                ],
                Some(NoteSearchMatchedField::Date),
            )
        } else {
            let Some(expression) = fts_match_expression(query) else {
                return Ok(Vec::new());
            };
            let search_table = match scope {
                NoteSearchScope::Active => "notes_search",
                NoteSearchScope::Archive | NoteSearchScope::Trash => "notes_search_lifecycle",
            };
            (
                format!(
                    "WITH user_nodes AS (\
                       SELECT * FROM notes_nodes WHERE {EXCLUDE_PLUGIN_OWNED_SQL}\
                     ) \
                     SELECT {search_table}.node_id, node.title, node.node_kind, \
                            node.image_offset_utf16, {attachment_name}, \
                            highlight({search_table}, 1, '<notes-match>', '</notes-match>') \
                              <> {search_table}.title, \
                            highlight({search_table}, 2, '<notes-match>', '</notes-match>') \
                              <> {search_table}.note \
                     FROM {search_table} \
                     JOIN user_nodes node ON node.id = {search_table}.node_id \
                     WHERE {search_table} MATCH ?2 AND {} \
                     ORDER BY bm25({search_table}, 0.0, 10.0, 1.0, 0.1), \
                              node.updated_at DESC, node.id LIMIT 100",
                    search_scope_predicate(scope)
                ),
                vec![GITHUB_NOTIFICATIONS_ROOT_ID.to_string(), expression],
                None,
            )
        };
    let matches = connection
        .prepare(&sql)
        .map_err(|error| format!("Could not prepare the v3 Notes search: {error}"))?
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                note_node_kind_from_row(row, 2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, bool>(5)?,
                row.get::<_, bool>(6)?,
            ))
        })
        .map_err(|error| format!("Could not search v3 Notes: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read v3 Notes search results: {error}"))?;
    let node_ids = matches
        .iter()
        .map(|(id, _, _, _, _, _, _)| id.as_str())
        .collect::<Vec<_>>();
    let trails = search_parent_trails(connection, scope, &node_ids)?;
    matches
        .into_iter()
        .map(
            |(
                node_id,
                title,
                node_kind,
                image_offset_utf16,
                attachment_name,
                matched_title,
                matched_note,
            )| {
                let trail = trails.get(&node_id).cloned().unwrap_or_default();
                Ok(NoteSearchResult {
                    parent_trail: trail.titles,
                    parent_trail_kinds: trail.kinds,
                    node_id,
                    node_kind,
                    display_label: note_display_label(
                        node_kind,
                        &title,
                        image_offset_utf16,
                        attachment_name.as_deref(),
                    )?,
                    title,
                    image_offset_utf16,
                    attachment_name,
                    matched_field: matched_field.unwrap_or_else(|| {
                        if matched_title {
                            NoteSearchMatchedField::Title
                        } else if matched_note {
                            NoteSearchMatchedField::Note
                        } else {
                            NoteSearchMatchedField::Attachment
                        }
                    }),
                })
            },
        )
        .collect()
}

fn canonical_search_tag(tag: &NoteSearchTag) -> (NoteTagPrefix, String) {
    (tag.prefix, tag.normalized_tag.clone())
}

type NormalizedNoteTag = (NoteTagPrefix, String);

struct CanonicalSearchFilters {
    required: BTreeSet<NormalizedNoteTag>,
    excluded: BTreeSet<NormalizedNoteTag>,
    or_groups: BTreeSet<Vec<NormalizedNoteTag>>,
}

fn canonical_search_filters(query: &NoteStructuredSearchQuery) -> CanonicalSearchFilters {
    let mut required = query
        .required_tags
        .iter()
        .map(canonical_search_tag)
        .collect::<BTreeSet<_>>();
    let excluded = query
        .excluded_tags
        .iter()
        .map(canonical_search_tag)
        .collect::<BTreeSet<_>>();
    let mut groups = BTreeSet::new();
    for group in &query.or_groups {
        let alternatives = group
            .iter()
            .map(canonical_search_tag)
            .collect::<BTreeSet<_>>();
        if alternatives.len() == 1 {
            required.extend(alternatives);
        } else if !alternatives.is_empty() {
            groups.insert(alternatives.into_iter().collect());
        }
    }
    CanonicalSearchFilters {
        required,
        excluded,
        or_groups: groups,
    }
}

pub(crate) fn validate_structured_search_query_input(
    query: &NoteStructuredSearchQuery,
) -> Result<(), String> {
    if query.text.len() > NOTE_SEARCH_MAX_TEXT_UTF8_BYTES {
        return Err("Structured Notes search text exceeds 4096 UTF-8 bytes.".to_string());
    }
    if query.or_groups.len() > NOTE_SEARCH_MAX_OR_GROUPS {
        return Err("Structured Notes search has more than 16 OR groups.".to_string());
    }
    if query
        .or_groups
        .iter()
        .any(|group| group.len() > NOTE_SEARCH_MAX_ALTERNATIVES_PER_OR_GROUP)
    {
        return Err("Structured Notes search OR group has more than 16 alternatives.".to_string());
    }

    let tags = query
        .required_tags
        .iter()
        .chain(query.excluded_tags.iter())
        .chain(query.or_groups.iter().flatten());
    if tags
        .into_iter()
        .any(|tag| !is_canonical_tag_body(&tag.normalized_tag))
    {
        return Err(
            "Structured Notes search tag normalizedTag must be a canonical tag body.".to_string(),
        );
    }

    let filters = canonical_search_filters(query);
    let unique_tags = filters
        .required
        .iter()
        .chain(filters.excluded.iter())
        .chain(filters.or_groups.iter().flatten())
        .collect::<BTreeSet<_>>();
    if unique_tags.len() > NOTE_SEARCH_MAX_UNIQUE_TAG_ALTERNATIVES {
        return Err(
            "Structured Notes search has more than 64 unique tag alternatives.".to_string(),
        );
    }
    Ok(())
}

fn validate_structured_search_query(
    query: &NoteStructuredSearchQuery,
) -> Result<CanonicalSearchFilters, String> {
    validate_structured_search_query_input(query)?;
    Ok(canonical_search_filters(query))
}

fn push_tag_parameters(
    parameters: &mut Vec<String>,
    prefix: NoteTagPrefix,
    normalized_tag: &str,
) -> (usize, usize) {
    parameters.push(prefix.as_str().to_string());
    let prefix_parameter = parameters.len();
    parameters.push(normalized_tag.to_string());
    (prefix_parameter, parameters.len())
}

pub(crate) fn search_nodes_structured(
    connection: &Connection,
    query: &NoteStructuredSearchQuery,
) -> Result<Vec<NoteSearchResult>, String> {
    let CanonicalSearchFilters {
        required,
        excluded,
        or_groups,
    } = validate_structured_search_query(query)?;
    let match_expression = fts_match_expression(&query.text);
    if match_expression.is_none()
        && required.is_empty()
        && excluded.is_empty()
        && or_groups.is_empty()
    {
        return Ok(Vec::new());
    }
    let positive_tags = required
        .iter()
        .cloned()
        .chain(or_groups.iter().flatten().cloned())
        .collect::<BTreeSet<_>>();
    let mut parameters = vec![GITHUB_NOTIFICATIONS_ROOT_ID.to_string()];
    let mut predicates = Vec::new();
    if let Some(expression) = &match_expression {
        parameters.push(expression.clone());
        predicates.push(format!("notes_search MATCH ?{}", parameters.len()));
    }
    for (prefix, normalized_tag) in required {
        let (prefix_parameter, tag_parameter) =
            push_tag_parameters(&mut parameters, prefix, &normalized_tag);
        predicates.push(format!(
            "EXISTS (SELECT 1 FROM notes_tags tag \
             WHERE tag.node_id = node.id AND tag.prefix = ?{prefix_parameter} \
               AND tag.normalized_tag = ?{tag_parameter})"
        ));
    }
    for (prefix, normalized_tag) in excluded {
        let (prefix_parameter, tag_parameter) =
            push_tag_parameters(&mut parameters, prefix, &normalized_tag);
        predicates.push(format!(
            "NOT EXISTS (SELECT 1 FROM notes_tags tag \
             WHERE tag.node_id = node.id AND tag.prefix = ?{prefix_parameter} \
               AND tag.normalized_tag = ?{tag_parameter})"
        ));
    }
    for group in or_groups {
        let alternatives = group
            .into_iter()
            .map(|(prefix, normalized_tag)| {
                let (prefix_parameter, tag_parameter) =
                    push_tag_parameters(&mut parameters, prefix, &normalized_tag);
                format!(
                    "(tag.prefix = ?{prefix_parameter} AND tag.normalized_tag = ?{tag_parameter})"
                )
            })
            .collect::<Vec<_>>();
        predicates.push(format!(
            "EXISTS (SELECT 1 FROM notes_tags tag WHERE tag.node_id = node.id AND ({}))",
            alternatives.join(" OR ")
        ));
    }
    let predicates = predicates.join(" AND ");
    let attachment_name = exact_image_attachment_name_sql("node");
    let sql = if match_expression.is_some() {
        format!(
            "WITH user_nodes AS (\
               SELECT * FROM notes_nodes WHERE {EXCLUDE_PLUGIN_OWNED_SQL}\
             ) \
             SELECT notes_search.node_id, node.title, node.node_kind, \
                    node.image_offset_utf16, {attachment_name}, \
                    highlight(notes_search, 1, '<notes-match>', '</notes-match>') \
                      <> notes_search.title, \
                    highlight(notes_search, 2, '<notes-match>', '</notes-match>') \
                      <> notes_search.note \
             FROM notes_search JOIN user_nodes node ON node.id = notes_search.node_id \
             WHERE node.deleted_at IS NULL AND node.archived_at IS NULL \
               AND {predicates} \
             ORDER BY bm25(notes_search, 0.0, 10.0, 1.0, 0.1), \
                      node.updated_at DESC, node.id LIMIT 100"
        )
    } else {
        format!(
            "WITH user_nodes AS (\
               SELECT * FROM notes_nodes WHERE {EXCLUDE_PLUGIN_OWNED_SQL}\
             ) \
             SELECT node.id, node.title, node.node_kind, node.image_offset_utf16, \
                    {attachment_name}, 1, 0 \
             FROM user_nodes node \
             WHERE node.deleted_at IS NULL AND node.archived_at IS NULL \
               AND {predicates} \
             ORDER BY node.updated_at DESC, node.id LIMIT 100"
        )
    };
    let matches = connection
        .prepare(&sql)
        .map_err(|error| format!("Could not prepare structured v3 Notes search: {error}"))?
        .query_map(params_from_iter(parameters.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                note_node_kind_from_row(row, 2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, bool>(5)?,
                row.get::<_, bool>(6)?,
            ))
        })
        .map_err(|error| format!("Could not search structured v3 Notes: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read structured v3 Notes search: {error}"))?;
    let node_ids = matches
        .iter()
        .map(|(id, _, _, _, _, _, _)| id.as_str())
        .collect::<Vec<_>>();
    let trails = search_parent_trails(connection, NoteSearchScope::Active, &node_ids)?;
    matches
        .into_iter()
        .map(
            |(
                node_id,
                title,
                node_kind,
                image_offset_utf16,
                attachment_name,
                matched_title,
                matched_note,
            )|
             -> Result<_, String> {
                let matched_field = if match_expression.is_some() {
                    if matched_title {
                        NoteSearchMatchedField::Title
                    } else if matched_note {
                        NoteSearchMatchedField::Note
                    } else {
                        NoteSearchMatchedField::Attachment
                    }
                } else if positive_tags.is_empty()
                    || primary_title_contains_tag(
                        node_kind,
                        &title,
                        image_offset_utf16,
                        &positive_tags,
                    )?
                {
                    NoteSearchMatchedField::Title
                } else {
                    NoteSearchMatchedField::Note
                };
                let trail = trails.get(&node_id).cloned().unwrap_or_default();
                Ok(NoteSearchResult {
                    parent_trail: trail.titles,
                    parent_trail_kinds: trail.kinds,
                    node_id,
                    node_kind,
                    display_label: note_display_label(
                        node_kind,
                        &title,
                        image_offset_utf16,
                        attachment_name.as_deref(),
                    )?,
                    title,
                    image_offset_utf16,
                    attachment_name,
                    matched_field,
                })
            },
        )
        .collect()
}

fn with_workspace_transaction(
    connection: &mut Connection,
    operation: impl FnOnce(&Transaction<'_>) -> Result<(), String>,
) -> Result<NotesWorkspace, String> {
    let journaled = history::has_active_context(connection)?;
    // Every workspace mutation runs in an IMMEDIATE transaction, including the
    // non-journaled branch. A DEFERRED transaction starts read-only and only
    // upgrades to a write lock on its first mutation; under WAL that deferred
    // read->write upgrade can fail with SQLITE_BUSY_SNAPSHOT, which our busy
    // handler does not retry. Taking the write lock up front avoids that race.
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes transaction: {error}"))?;
    operation(&transaction)?;
    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    if journaled {
        history::finalize_transaction(&transaction)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes transaction: {error}"))?;
    Ok(workspace)
}

fn node_by_id(transaction: &Transaction<'_>, node_id: &str) -> Result<Option<StoredNode>, String> {
    #[cfg(test)]
    NODE_BY_ID_LOOKUP_COUNT.with(|count| count.set(count.get() + 1));
    transaction
        .query_row(
            "SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                    is_starred, completed_at, deleted_at, deleted_batch_id, archived_at, \
                    archive_root_id, node_kind, image_offset_utf16, marker_kind, \
                    markdown_image_width, is_readonly, \
                    plugin_state, plugin_meta \
             FROM notes_nodes WHERE id = ?1",
            [node_id],
            stored_node_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not read Note node {node_id}: {error}"))
}

fn require_live_node(transaction: &Transaction<'_>, node_id: &str) -> Result<StoredNode, String> {
    match node_by_id(transaction, node_id)? {
        Some(node) if node.deleted_at.is_none() => Ok(node),
        Some(_) => Err(format!("Note node {node_id} is in the trash.")),
        None => Err(format!("Note node {node_id} does not exist.")),
    }
}

fn require_active_node(transaction: &Transaction<'_>, node_id: &str) -> Result<StoredNode, String> {
    match require_live_node(transaction, node_id)? {
        node if node.archived_at.is_none() => Ok(node),
        _ => Err(format!("Note node {node_id} is archived.")),
    }
}

fn plugin_owned(node: &StoredNode) -> bool {
    node.id == GITHUB_NOTIFICATIONS_ROOT_ID
        || node.plugin_state.is_some()
        || node.plugin_meta.is_some()
}

/// Content protection is intentionally centralized at the repository boundary.
fn require_content_mutable(node: &StoredNode) -> Result<(), String> {
    if plugin_owned(node) {
        return Err("This Note node is managed by a plugin and cannot be modified.".to_string());
    }
    if node.is_readonly == Some(true) {
        return Err("This Note node is read-only and cannot be modified.".to_string());
    }
    Ok(())
}

fn require_provider_mutable(node: &StoredNode) -> Result<(), String> {
    if plugin_owned(node) {
        return Err("This Note node is managed by a plugin and cannot be modified.".to_string());
    }
    Ok(())
}

fn require_sortable_node(node: &StoredNode) -> Result<(), String> {
    if node.is_readonly == Some(true) || plugin_owned(node) {
        return Err("A read-only or plugin-managed Note subtree cannot be reordered.".to_string());
    }
    Ok(())
}

fn require_collapse_target(transaction: &Transaction<'_>, node_id: &str) -> Result<bool, String> {
    if node_id == GITHUB_NOTIFICATIONS_ROOT_ID {
        return Ok(true);
    }
    let plugin_owned = transaction
        .query_row(
            "WITH RECURSIVE subtree(id) AS (\
               SELECT id FROM notes_nodes WHERE id = ?1 AND deleted_at IS NULL \
                 AND archived_at IS NULL \
               UNION \
               SELECT child.id FROM notes_nodes child \
               JOIN subtree parent ON child.parent_id = parent.id \
               WHERE child.deleted_at IS NULL AND child.archived_at IS NULL\
             ) \
             SELECT EXISTS(\
               SELECT 1 FROM notes_nodes \
               WHERE id IN subtree \
                 AND (id = ?2 OR plugin_state IS NOT NULL OR plugin_meta IS NOT NULL)\
             )",
            params![node_id, GITHUB_NOTIFICATIONS_ROOT_ID],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect the collapsible Note subtree: {error}"))?;
    if plugin_owned {
        return Err("A plugin-managed Note subtree cannot be collapsed.".to_string());
    }
    Ok(false)
}

/// User structure changes cannot carry a readonly node in the moving subtree.
/// Plugin roots are provider-owned and are handled by their own reorder path;
/// provider children still reject generic user moves.
fn require_subtree_movable(transaction: &Transaction<'_>, node_id: &str) -> Result<(), String> {
    if node_id == GITHUB_NOTIFICATIONS_ROOT_ID {
        // The provider owns the GN descendants, but the ordinary outline
        // reorder of its top-level root remains an allowed user operation.
        return Ok(());
    }
    let subtree = active_subtree(transaction, node_id)?;
    for node in subtree {
        if node.is_readonly == Some(true) {
            return Err("A read-only Note subtree cannot be moved.".to_string());
        }
        if plugin_owned(&node) && node.id != GITHUB_NOTIFICATIONS_ROOT_ID {
            return Err("A plugin-managed Note subtree cannot be moved.".to_string());
        }
    }
    Ok(())
}

fn normalize_delete_roots(
    transaction: &Transaction<'_>,
    node_ids: &[String],
) -> Result<Vec<String>, String> {
    for node_id in node_ids {
        require_live_node(transaction, node_id)?;
    }
    let selected = node_ids.iter().map(String::as_str).collect::<BTreeSet<_>>();
    selection_roots(transaction, node_ids, &selected)
}

/// Returns the exact, sorted set of ordinary readonly descendants for a
/// deletion forest. Roots themselves are deliberately excluded so direct
/// readonly deletion remains an unconditional rejection.
fn readonly_descendants(
    transaction: &Transaction<'_>,
    roots: &[NoteId],
) -> Result<Vec<NoteId>, String> {
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let root_set = roots.iter().collect::<BTreeSet<_>>();
    let mut ids = BTreeSet::new();
    for chunk in roots.chunks(ANCESTOR_CLOSURE_CHUNK_SIZE) {
        #[cfg(test)]
        READONLY_DESCENDANT_QUERY_COUNT.with(|count| count.set(count.get() + 1));
        let placeholders = (1..=chunk.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            r#"WITH RECURSIVE subtree(id, root_id, archived_context) AS (
                 SELECT id, id, CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END
                 FROM notes_nodes WHERE id IN ({placeholders}) AND deleted_at IS NULL
                 UNION
                 SELECT child.id, subtree.root_id, subtree.archived_context
                 FROM notes_nodes child JOIN subtree ON child.parent_id = subtree.id
                 WHERE child.deleted_at IS NULL AND (
                   (subtree.archived_context = 1 AND child.archive_root_id = subtree.root_id)
                   OR (subtree.archived_context = 0 AND child.archived_at IS NULL)
                 )
               )
               SELECT subtree.id, node.is_readonly FROM subtree
               JOIN notes_nodes node ON node.id = subtree.id"#
        );
        let mut statement = transaction
            .prepare(&sql)
            .map_err(|error| format!("Could not prepare readonly descendant scan: {error}"))?;
        let rows = statement
            .query_map(params_from_iter(chunk.iter()), |row| {
                Ok((row.get::<_, NoteId>(0)?, row.get::<_, Option<i64>>(1)?))
            })
            .map_err(|error| format!("Could not read readonly descendants: {error}"))?;
        for row in rows {
            let (id, is_readonly) =
                row.map_err(|error| format!("Could not decode readonly descendant: {error}"))?;
            #[cfg(test)]
            READONLY_DESCENDANT_VISITED_ROW_COUNT.with(|count| count.set(count.get() + 1));
            if is_readonly == Some(1) && !root_set.contains(&id) {
                ids.insert(id);
            }
        }
    }
    Ok(ids.into_iter().collect())
}

fn mark_topic_dirty(transaction: &Transaction<'_>, node_id: &str) -> Result<(), String> {
    let topic_id = resolve_active_topic_id(transaction, node_id)?;
    transaction
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
             ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
            [topic_id],
        )
        .map_err(|error| format!("Could not mark the Notes topic dirty: {error}"))?;
    Ok(())
}

fn require_deleted_node(
    transaction: &Transaction<'_>,
    node_id: &str,
) -> Result<StoredNode, String> {
    match node_by_id(transaction, node_id)? {
        Some(node) if node.deleted_at.is_some() => Ok(node),
        Some(_) => Err(format!("Note node {node_id} is not in the trash.")),
        None => Err(format!("Note node {node_id} does not exist.")),
    }
}

fn id_namespace_in_use(transaction: &Transaction<'_>, id: &str) -> Result<bool, String> {
    transaction
        .query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM notes_nodes WHERE id = ?1 \
               UNION ALL \
               SELECT 1 FROM notes_attachments WHERE id = ?1 \
               UNION ALL \
               SELECT 1 FROM notes_history_changes \
               WHERE row_id = ?1 AND table_name IN ('notes_nodes', 'notes_attachments')\
             )",
            [id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not validate the Notes ID namespace: {error}"))
}

fn ensure_fresh_id(transaction: &Transaction<'_>, node_id: &str) -> Result<(), String> {
    if id_namespace_in_use(transaction, node_id)? {
        Err(format!("Note ID {node_id} is already in use."))
    } else {
        Ok(())
    }
}

fn ensure_generic_parent_allowed(parent_id: Option<&str>) -> Result<(), String> {
    if parent_id == Some(GITHUB_NOTIFICATIONS_ROOT_ID) {
        return Err(
            "Generic Notes placement under the Github Notifications root is provider-owned."
                .to_string(),
        );
    }
    Ok(())
}

fn ensure_live_parent(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
) -> Result<(), String> {
    ensure_generic_parent_allowed(parent_id)?;
    if let Some(parent_id) = parent_id {
        require_active_node(transaction, parent_id)?;
        ensure_child_within_depth(transaction, parent_id)?;
    }
    Ok(())
}

/// Rejects create/move/indent commands that would nest a new child beyond the
/// export depth cap. This is the single shared parent-decision guard for local
/// mutations; the sync exporter's pre-render cap and the merger's over-depth
/// parking cover any depth that appears through file merges instead.
fn ensure_child_within_depth(transaction: &Transaction<'_>, parent_id: &str) -> Result<(), String> {
    // A freshly created child adds exactly one level below the parent.
    ensure_within_depth(transaction, Some(parent_id), 1)
}

/// 1-based depth of `node_id` measured from its topic root (root = 1). Bounded
/// by the export cap so a corrupt ancestor cycle cannot loop forever.
fn node_depth(transaction: &Transaction<'_>, node_id: &str) -> Result<i64, String> {
    let max_depth = i64::try_from(MAX_NOTES_EXPORT_DEPTH).unwrap_or(i64::MAX);
    transaction
        .query_row(
            "WITH RECURSIVE ancestors(id, parent_id, depth) AS (\
               SELECT id, parent_id, 1 FROM notes_nodes WHERE id = ?1 \
               UNION ALL \
               SELECT parent.id, parent.parent_id, ancestors.depth + 1 \
               FROM notes_nodes parent JOIN ancestors ON ancestors.parent_id = parent.id \
               WHERE ancestors.depth <= ?2\
             ) \
             SELECT max(depth) FROM ancestors",
            params![node_id, max_depth],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not measure Note nesting depth: {error}"))
}

/// Height (level count) of `node_id`'s active subtree — the node itself is 1.
/// R5: the moving payload's own height must be counted, not just the target
/// depth, or a tall subtree could breach the cap through a move/indent. Probed
/// one level past the cap so an over-tall subtree is still detected as such.
fn subtree_height(transaction: &Transaction<'_>, node_id: &str) -> Result<i64, String> {
    let probe = i64::try_from(MAX_NOTES_EXPORT_DEPTH).unwrap_or(i64::MAX);
    let height: Option<i64> = transaction
        .query_row(
            "WITH RECURSIVE subtree(id, depth) AS (\
               SELECT id, 1 FROM notes_nodes WHERE id = ?1 \
               UNION ALL \
               SELECT child.id, subtree.depth + 1 FROM notes_nodes child \
               JOIN subtree ON child.parent_id = subtree.id \
               WHERE child.deleted_at IS NULL AND child.archived_at IS NULL \
                 AND subtree.depth <= ?2\
             ) \
             SELECT max(depth) FROM subtree",
            params![node_id, probe],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not measure Note subtree height: {error}"))?;
    Ok(height.unwrap_or(1))
}

/// Rejects a placement whose destination depth plus the payload height would
/// breach the export depth cap. `height` is 1 for a fresh single node, or the
/// moving/imported subtree's height for a reparent.
fn ensure_within_depth(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    height: i64,
) -> Result<(), String> {
    let max_depth = i64::try_from(MAX_NOTES_EXPORT_DEPTH).unwrap_or(i64::MAX);
    let parent_depth = match parent_id {
        Some(parent_id) => node_depth(transaction, parent_id)?,
        None => 0,
    };
    if parent_depth.saturating_add(height) > max_depth {
        return Err(format!(
            "A Note cannot nest deeper than {MAX_NOTES_EXPORT_DEPTH} levels."
        ));
    }
    Ok(())
}

/// Guard for reparenting an EXISTING subtree: the destination parent must be
/// live and the moving subtree's own height must fit under the export depth cap
/// (R5). Shared by move_node and every batch reparent (move/indent/outdent).
fn ensure_reparent_target(
    transaction: &Transaction<'_>,
    node_id: &str,
    parent_id: Option<&str>,
) -> Result<(), String> {
    ensure_generic_parent_allowed(parent_id)?;
    if let Some(parent_id) = parent_id {
        require_active_node(transaction, parent_id)?;
    }
    ensure_within_depth(
        transaction,
        parent_id,
        subtree_height(transaction, node_id)?,
    )
}

fn sibling_keys(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    excluded_id: Option<&str>,
) -> Result<Vec<(String, i64)>, String> {
    #[cfg(test)]
    SIBLING_ORDER_QUERY_COUNT.with(|count| count.set(count.get() + 1));
    let mut statement = transaction
        .prepare(
            "SELECT id, sort_key FROM notes_nodes \
             WHERE parent_id IS ?1 AND deleted_at IS NULL AND archived_at IS NULL \
               AND (?2 IS NULL OR id <> ?2) \
             ORDER BY sort_key, id",
        )
        .map_err(|error| format!("Could not prepare sibling ordering: {error}"))?;
    let siblings = statement
        .query_map(params![parent_id, excluded_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|error| format!("Could not read sibling ordering: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect sibling ordering: {error}"))?;
    #[cfg(test)]
    SIBLING_ORDER_VISITED_ROW_COUNT.with(|count| count.set(count.get() + siblings.len()));
    Ok(siblings)
}

fn rebalance_siblings(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    excluded_id: Option<&str>,
) -> Result<(), String> {
    let siblings = sibling_keys(transaction, parent_id, excluded_id)?;
    for (index, (node_id, _)) in siblings.iter().enumerate() {
        let sort_key = i64::try_from(index + 1)
            .ok()
            .and_then(|position| position.checked_mul(SORT_KEY_STEP))
            .ok_or_else(|| "The Notes sibling ordering is too large to rebalance.".to_string())?;
        transaction
            .execute(
                "UPDATE notes_nodes \
                 SET sort_key = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?2",
                params![sort_key, node_id],
            )
            .map_err(|error| format!("Could not rebalance Note siblings: {error}"))?;
    }
    Ok(())
}

fn next_sort_key(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    after_id: Option<&str>,
) -> Result<i64, String> {
    next_sort_key_excluding(transaction, parent_id, after_id, None, None)
}

pub(crate) fn next_root_sort_key(transaction: &Transaction<'_>) -> Result<i64, String> {
    next_sort_key(transaction, None, None)
}

fn next_sort_key_excluding(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    before_id: Option<&str>,
    excluded_id: Option<&str>,
) -> Result<i64, String> {
    let siblings = sibling_keys(transaction, parent_id, excluded_id)?;
    let calculate = |siblings: &[(String, i64)]| -> Result<Option<i64>, String> {
        if after_id.is_some() && before_id.is_some() {
            return Err("A node move cannot specify both afterId and beforeId.".to_string());
        }
        if let Some(before_id) = before_id {
            let index = siblings
                .iter()
                .position(|(node_id, _)| node_id == before_id)
                .ok_or_else(|| {
                    "The requested beforeId must identify a live sibling under the target parent."
                        .to_string()
                })?;
            let right = siblings[index].1;
            return match index.checked_sub(1).and_then(|index| siblings.get(index)) {
                Some((_, left)) => {
                    let gap = i128::from(right) - i128::from(*left);
                    if gap > 1 {
                        Ok(Some((i128::from(*left) + gap / 2) as i64))
                    } else {
                        Ok(None)
                    }
                }
                None => Ok(right.checked_sub(SORT_KEY_STEP)),
            };
        }
        let Some(after_id) = after_id else {
            return match siblings.last() {
                Some((_, sort_key)) => Ok(sort_key.checked_add(SORT_KEY_STEP)),
                None => Ok(Some(SORT_KEY_STEP)),
            };
        };
        let index = siblings
            .iter()
            .position(|(node_id, _)| node_id == after_id)
            .ok_or_else(|| {
                "The requested afterId must identify a live sibling under the target parent."
                    .to_string()
            })?;
        let left = siblings[index].1;
        match siblings.get(index + 1) {
            Some((_, right)) => {
                let gap = i128::from(*right) - i128::from(left);
                if gap > 1 {
                    Ok(Some((i128::from(left) + gap / 2) as i64))
                } else {
                    Ok(None)
                }
            }
            None => Ok(left.checked_add(SORT_KEY_STEP)),
        }
    };

    if let Some(sort_key) = calculate(&siblings)? {
        return Ok(sort_key);
    }

    rebalance_siblings(transaction, parent_id, excluded_id)?;
    let rebalanced = sibling_keys(transaction, parent_id, excluded_id)?;
    calculate(&rebalanced)?.ok_or_else(|| {
        "Could not allocate a sparse Note sort key after rebalancing siblings.".to_string()
    })
}

fn replace_tags(
    transaction: &Transaction<'_>,
    node_id: &str,
    node_kind: NoteNodeKind,
    title: &str,
    image_offset_utf16: i64,
    note: &str,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM notes_tags WHERE node_id = ?1", [node_id])
        .map_err(|error| format!("Could not clear Note tags: {error}"))?;
    for ((prefix, normalized_tag), tag) in
        extract_tags_for_node(node_kind, title, image_offset_utf16, note)?
    {
        transaction
            .execute(
                "INSERT INTO notes_tags (node_id, prefix, tag, normalized_tag) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![node_id, prefix.as_str(), tag, normalized_tag],
            )
            .map_err(|error| format!("Could not store Note tags: {error}"))?;
    }
    Ok(())
}

// Relative phrases are derived data: every content rebuild resolves them against
// the command's single injected local `today` value.
fn replace_dates(
    transaction: &Transaction<'_>,
    node_id: &str,
    node_kind: NoteNodeKind,
    title: &str,
    image_offset_utf16: i64,
    note: &str,
    today: LocalDate,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM notes_dates WHERE node_id = ?1", [node_id])
        .map_err(|error| format!("Could not clear Note dates: {error}"))?;
    let sources = primary_title_segments(node_kind, title, image_offset_utf16)?
        .into_iter()
        .map(|(source, offset)| ("title", source, offset))
        .chain(std::iter::once(("note", note, 0)));
    for (field, source, base_utf16) in sources {
        for date in find_note_date_matches(source, today, WeekStartsOn::Monday) {
            let start_utf16 = i64::try_from(date.start_utf16)
                .map_err(|_| "A Note date offset exceeds SQLite integer range.".to_string())?
                .checked_add(base_utf16)
                .ok_or_else(|| "A Note date offset exceeds SQLite integer range.".to_string())?;
            let end_utf16 = i64::try_from(date.end_utf16)
                .map_err(|_| "A Note date offset exceeds SQLite integer range.".to_string())?
                .checked_add(base_utf16)
                .ok_or_else(|| "A Note date offset exceeds SQLite integer range.".to_string())?;
            transaction
                .execute(
                    "INSERT INTO notes_dates (\
                       node_id, field, start_utf16, end_utf16, normalized_start, \
                       normalized_end, token_text\
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        node_id,
                        field,
                        start_utf16,
                        end_utf16,
                        date.start.to_iso(),
                        date.end.unwrap_or(date.start).to_iso(),
                        date.raw
                    ],
                )
                .map_err(|error| format!("Could not store Note dates: {error}"))?;
        }
    }
    Ok(())
}

fn replace_derived_content(
    transaction: &Transaction<'_>,
    node_id: &str,
    node_kind: NoteNodeKind,
    title: &str,
    image_offset_utf16: i64,
    note: &str,
    today: LocalDate,
) -> Result<(), String> {
    replace_tags(
        transaction,
        node_id,
        node_kind,
        title,
        image_offset_utf16,
        note,
    )?;
    replace_dates(
        transaction,
        node_id,
        node_kind,
        title,
        image_offset_utf16,
        note,
        today,
    )
}

pub(crate) fn rebuild_derived_for_nodes_at(
    transaction: &Transaction<'_>,
    node_ids: &BTreeSet<String>,
    today: LocalDate,
) -> Result<(), String> {
    for node_id in node_ids {
        let content = transaction
            .query_row(
                "SELECT title, note, node_kind, image_offset_utf16 FROM notes_nodes WHERE id = ?1",
                [node_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        note_node_kind_from_row(row, 2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| {
                format!("Could not read Note content after history replay: {error}")
            })?;
        if let Some((title, note, node_kind, image_offset_utf16)) = content {
            replace_derived_content(
                transaction,
                node_id,
                node_kind,
                &title,
                image_offset_utf16,
                &note,
                today,
            )?;
        } else {
            transaction
                .execute("DELETE FROM notes_tags WHERE node_id = ?1", [node_id])
                .map_err(|error| {
                    format!("Could not clear Note tags after history replay: {error}")
                })?;
            transaction
                .execute("DELETE FROM notes_dates WHERE node_id = ?1", [node_id])
                .map_err(|error| {
                    format!("Could not clear Note dates after history replay: {error}")
                })?;
        }
    }
    Ok(())
}

#[derive(Clone)]
struct GithubStoredRow {
    node: StoredNode,
    has_attachments: bool,
}

#[derive(Default)]
struct GithubCandidateRows {
    by_id: BTreeMap<String, GithubStoredRow>,
    by_key: BTreeMap<String, String>,
}

fn github_stored_row_from_row(row: &Row<'_>) -> rusqlite::Result<GithubStoredRow> {
    Ok(GithubStoredRow {
        node: stored_node_from_row(row)?,
        has_attachments: row.get(20)?,
    })
}

fn github_metadata_key<'a>(
    metadata: &'a GithubNotificationsPluginMeta,
    kind: &str,
) -> Option<&'a str> {
    match (kind, metadata) {
        ("date", GithubNotificationsPluginMeta::Date { date_key }) => Some(date_key),
        (
            "notification",
            GithubNotificationsPluginMeta::Notification {
                notification_key, ..
            },
        ) => Some(notification_key),
        _ => None,
    }
}

fn load_github_candidate_rows(
    transaction: &Transaction<'_>,
    expected: &[(String, String)],
    kind: &str,
    key_field: &str,
    observe_notification_work: bool,
) -> Result<GithubCandidateRows, String> {
    let mut loaded = GithubCandidateRows::default();
    for chunk in expected.chunks(ANCESTOR_CLOSURE_CHUNK_SIZE) {
        if observe_notification_work {
            #[cfg(test)]
            GITHUB_NOTIFICATION_LOOKUP_QUERY_COUNT.with(|count| count.set(count.get() + 1));
        }
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT n.id, n.parent_id, n.sort_key, n.title, n.note, n.layout_mode, \
                    n.is_collapsed, n.is_starred, n.completed_at, n.deleted_at, \
                    n.deleted_batch_id, n.archived_at, n.archive_root_id, n.node_kind, \
                    n.image_offset_utf16, n.marker_kind, n.markdown_image_width, \
                    n.is_readonly, n.plugin_state, n.plugin_meta, \
                    EXISTS(SELECT 1 FROM notes_attachments a WHERE a.node_id = n.id) \
             FROM notes_nodes n \
             WHERE n.id IN ({placeholders}) \
                OR (n.plugin_meta IS NOT NULL \
                    AND CASE WHEN json_valid(n.plugin_meta) THEN \
                      CASE WHEN json_extract(n.plugin_meta, '$.kind') = '{kind}' \
                        THEN json_extract(n.plugin_meta, '$.{key_field}') \
                      END \
                    END IN ({placeholders})) \
             ORDER BY n.id"
        );
        let mut parameters = chunk.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>();
        parameters.extend(chunk.iter().map(|(_, key)| key.as_str()));
        let mut statement = transaction
            .prepare(&sql)
            .map_err(|error| format!("Could not prepare GitHub provider rows: {error}"))?;
        let rows = statement
            .query_map(params_from_iter(parameters), github_stored_row_from_row)
            .map_err(|error| format!("Could not query GitHub provider rows: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not decode GitHub provider rows: {error}"))?;
        if observe_notification_work {
            #[cfg(test)]
            GITHUB_NOTIFICATION_VISITED_ROW_COUNT.with(|count| count.set(count.get() + rows.len()));
        }
        for row in rows {
            if let Some(key) = row
                .node
                .plugin_meta
                .as_ref()
                .and_then(|metadata| github_metadata_key(metadata, kind))
            {
                if loaded
                    .by_key
                    .insert(key.to_string(), row.node.id.clone())
                    .is_some()
                {
                    return Err("A GitHub metadata key has conflicting ownership.".to_string());
                }
            }
            if loaded.by_id.insert(row.node.id.clone(), row).is_some() {
                return Err("A GitHub provider row was loaded more than once.".to_string());
            }
        }
    }
    Ok(loaded)
}

fn load_github_rows_by_id(
    transaction: &Transaction<'_>,
    node_ids: &BTreeSet<String>,
) -> Result<BTreeMap<String, GithubStoredRow>, String> {
    let mut rows = BTreeMap::new();
    for chunk in node_ids
        .iter()
        .collect::<Vec<_>>()
        .chunks(ANCESTOR_CLOSURE_CHUNK_SIZE)
    {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT n.id, n.parent_id, n.sort_key, n.title, n.note, n.layout_mode, \
                    n.is_collapsed, n.is_starred, n.completed_at, n.deleted_at, \
                    n.deleted_batch_id, n.archived_at, n.archive_root_id, n.node_kind, \
                    n.image_offset_utf16, n.marker_kind, n.markdown_image_width, \
                    n.is_readonly, n.plugin_state, n.plugin_meta, \
                    EXISTS(SELECT 1 FROM notes_attachments a WHERE a.node_id = n.id) \
             FROM notes_nodes n WHERE n.id IN ({placeholders}) ORDER BY n.id"
        );
        let mut statement = transaction
            .prepare(&sql)
            .map_err(|error| format!("Could not prepare GitHub parent rows: {error}"))?;
        let loaded = statement
            .query_map(
                params_from_iter(chunk.iter().map(|node_id| node_id.as_str())),
                github_stored_row_from_row,
            )
            .map_err(|error| format!("Could not query GitHub parent rows: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not decode GitHub parent rows: {error}"))?;
        for row in loaded {
            rows.insert(row.node.id.clone(), row);
        }
    }
    Ok(rows)
}

fn validate_github_common_row(row: &GithubStoredRow) -> bool {
    let node = &row.node;
    node.node_kind == NoteNodeKind::Text
        && node.image_offset_utf16 == 0
        && node.layout_mode == "bullets"
        && !node.is_starred
        && node.completed_at.is_none()
        && node.deleted_at.is_none()
        && node.deleted_batch_id.is_none()
        && node.archived_at.is_none()
        && node.archive_root_id.is_none()
        && node.is_readonly.is_none()
        && !row.has_attachments
}

fn validate_loaded_github_date(row: &GithubStoredRow, date_key: &str) -> Result<(), String> {
    let node = &row.node;
    if node.id != github_date_node_id(date_key)?
        || !validate_github_common_row(row)
        || node.parent_id.as_deref() != Some(GITHUB_NOTIFICATIONS_ROOT_ID)
        || node.title != date_key
        || !node.note.is_empty()
        || node.is_collapsed
        || node.plugin_state.is_some()
        || node.plugin_meta
            != Some(GithubNotificationsPluginMeta::Date {
                date_key: date_key.to_string(),
            })
    {
        return Err("A GitHub date anchor has invalid ownership.".to_string());
    }
    Ok(())
}

fn validate_loaded_github_notification(
    row: &GithubStoredRow,
    notification_key: &str,
) -> Result<(), String> {
    let node = &row.node;
    if node.id != github_notification_node_id(notification_key)?
        || !validate_github_common_row(row)
        || node.is_collapsed
        || node.plugin_state.is_some()
        || !matches!(
            node.plugin_meta.as_ref(),
            Some(GithubNotificationsPluginMeta::Notification {
                notification_key: stored_key,
                ..
            }) if stored_key == notification_key
        )
    {
        return Err("A GitHub notification has invalid ownership.".to_string());
    }
    Ok(())
}

fn exact_github_candidate<'a>(
    candidates: &'a GithubCandidateRows,
    expected_id: &str,
    expected_key: &str,
) -> Result<Option<&'a GithubStoredRow>, String> {
    let by_id = candidates.by_id.get(expected_id);
    let by_key = candidates.by_key.get(expected_key);
    match (by_id, by_key) {
        (None, None) => Ok(None),
        (Some(row), Some(owner_id)) if owner_id == expected_id => Ok(Some(row)),
        _ => Err("A GitHub metadata key has conflicting ownership.".to_string()),
    }
}

fn require_github_notifications_root(
    transaction: &Transaction<'_>,
    root_id: &str,
) -> Result<StoredNode, String> {
    if root_id != GITHUB_NOTIFICATIONS_ROOT_ID {
        return Err("The GitHub notification root ID is invalid.".to_string());
    }
    let root = require_active_node(transaction, root_id)?;
    if !github_provider_row_has_canonical_common_shape(transaction, &root)?
        || root.parent_id.is_some()
        || root.title != GITHUB_NOTIFICATIONS_TITLE
        || !root.note.is_empty()
        || root.is_readonly.is_some()
        || root
            .plugin_state
            .as_ref()
            .is_none_or(|state| !state.is_valid())
        || root.plugin_meta.is_some()
    {
        return Err("The GitHub Notifications root ownership is invalid.".to_string());
    }
    Ok(root)
}

fn github_provider_row_has_canonical_common_shape(
    transaction: &Transaction<'_>,
    node: &StoredNode,
) -> Result<bool, String> {
    let has_attachments = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_attachments WHERE node_id = ?1)",
            [&node.id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect GitHub row attachments: {error}"))?;
    Ok(node.node_kind == NoteNodeKind::Text
        && node.image_offset_utf16 == 0
        && node.layout_mode == "bullets"
        && !node.is_starred
        && node.completed_at.is_none()
        && node.deleted_at.is_none()
        && node.deleted_batch_id.is_none()
        && node.archived_at.is_none()
        && node.archive_root_id.is_none()
        && node.is_readonly.is_none()
        && !has_attachments)
}

fn ensure_unique_github_metadata_key(
    transaction: &Transaction<'_>,
    kind: &str,
    key_field: &str,
    key: &str,
    expected_id: &str,
) -> Result<(), String> {
    let sql = format!(
        "SELECT id FROM notes_nodes \
         WHERE plugin_meta IS NOT NULL \
           AND CASE WHEN json_valid(plugin_meta) THEN \
             CASE WHEN json_extract(plugin_meta, '$.kind') = '{kind}' \
               THEN json_extract(plugin_meta, '$.{key_field}') \
             END \
           END = ?1 \
         ORDER BY id"
    );
    let mut statement = transaction
        .prepare(&sql)
        .map_err(|error| format!("Could not prepare GitHub metadata ownership: {error}"))?;
    let owners = statement
        .query_map([key], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not inspect GitHub metadata ownership: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect GitHub metadata ownership: {error}"))?;
    if owners
        .iter()
        .any(|owner_id| owner_id.as_str() != expected_id)
        || owners.len() > 1
    {
        return Err("A GitHub metadata key has conflicting ownership.".to_string());
    }
    Ok(())
}

fn validate_github_date_row(
    transaction: &Transaction<'_>,
    node: &StoredNode,
    date_key: &str,
) -> Result<(), String> {
    if node.id != github_date_node_id(date_key)?
        || !github_provider_row_has_canonical_common_shape(transaction, node)?
        || node.parent_id.as_deref() != Some(GITHUB_NOTIFICATIONS_ROOT_ID)
        || node.title != date_key
        || !node.note.is_empty()
        || node.is_collapsed
        || node.plugin_state.is_some()
        || node.plugin_meta
            != Some(GithubNotificationsPluginMeta::Date {
                date_key: date_key.to_string(),
            })
    {
        return Err("A GitHub date anchor has invalid ownership.".to_string());
    }
    ensure_unique_github_metadata_key(transaction, "date", "date_key", date_key, &node.id)
}

fn validate_github_notification_chain(
    transaction: &Transaction<'_>,
    node: &StoredNode,
    notification_key: &str,
    expected_date_key: Option<&str>,
) -> Result<String, String> {
    if node.id != github_notification_node_id(notification_key)?
        || !github_provider_row_has_canonical_common_shape(transaction, node)?
        || node.is_collapsed
        || node.plugin_state.is_some()
        || !matches!(
            node.plugin_meta.as_ref(),
            Some(GithubNotificationsPluginMeta::Notification {
                notification_key: stored_key,
                ..
            }) if stored_key == notification_key
        )
    {
        return Err("A GitHub notification has invalid ownership.".to_string());
    }
    ensure_unique_github_metadata_key(
        transaction,
        "notification",
        "notification_key",
        notification_key,
        &node.id,
    )?;
    let date_id = node
        .parent_id
        .as_deref()
        .ok_or_else(|| "A GitHub notification has no date anchor.".to_string())?;
    let date = require_active_node(transaction, date_id)?;
    let date_key = match date.plugin_meta.as_ref() {
        Some(GithubNotificationsPluginMeta::Date { date_key }) => date_key.as_str(),
        _ => return Err("A GitHub notification has an invalid date anchor.".to_string()),
    };
    if expected_date_key.is_some_and(|expected| expected != date_key) {
        return Err("A GitHub notification has an unexpected date anchor.".to_string());
    }
    validate_github_date_row(transaction, &date, date_key)?;
    Ok(date_key.to_string())
}

fn preflight_github_snapshot_chain(
    transaction: &Transaction<'_>,
    snapshot: &GithubNotificationSnapshotInput,
) -> Result<(), String> {
    let date_id = github_date_node_id(&snapshot.date_key)?;
    let date_candidates = load_github_candidate_rows(
        transaction,
        &[(date_id.clone(), snapshot.date_key.clone())],
        "date",
        "date_key",
        false,
    )?;
    let date = exact_github_candidate(&date_candidates, &date_id, &snapshot.date_key)?;
    if let Some(date) = date {
        validate_loaded_github_date(date, &snapshot.date_key)?;
    }

    let notification_id = github_notification_node_id(&snapshot.notification_key)?;
    let notification_candidates = load_github_candidate_rows(
        transaction,
        &[(notification_id.clone(), snapshot.notification_key.clone())],
        "notification",
        "notification_key",
        false,
    )?;
    if let Some(notification) = exact_github_candidate(
        &notification_candidates,
        &notification_id,
        &snapshot.notification_key,
    )? {
        validate_loaded_github_notification(notification, &snapshot.notification_key)?;
        if notification.node.parent_id.as_deref() != Some(&date_id) || date.is_none() {
            return Err("A GitHub notification has an invalid date anchor.".to_string());
        }
    }
    Ok(())
}

fn insert_github_date_anchor_if_missing(
    transaction: &Transaction<'_>,
    date_key: &str,
) -> Result<String, String> {
    let date_id = github_date_node_id(date_key)?;
    if transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
            [&date_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect a preflighted GitHub date anchor: {error}"))?
    {
        return Ok(date_id);
    }
    let sort_key = next_sort_key(transaction, Some(GITHUB_NOTIFICATIONS_ROOT_ID), None)?;
    let metadata = serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Date {
        date_key: date_key.to_string(),
    })
    .expect("GitHub date metadata serializes");
    transaction
        .execute(
            "INSERT INTO notes_nodes(\
               id, parent_id, sort_key, title, note, is_readonly, plugin_state, plugin_meta, \
               created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, '', NULL, NULL, ?5, \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![
                date_id,
                GITHUB_NOTIFICATIONS_ROOT_ID,
                sort_key,
                date_key,
                metadata
            ],
        )
        .map_err(|error| format!("Could not materialize a GitHub date anchor: {error}"))?;
    Ok(date_id)
}

fn next_github_notification_sort_key(
    transaction: &Transaction<'_>,
    date_id: &str,
) -> Result<i64, String> {
    next_sort_key(transaction, Some(date_id), None)
}

fn insert_github_notification_if_missing(
    transaction: &Transaction<'_>,
    date_id: &str,
    snapshot: &GithubNotificationSnapshotInput,
) -> Result<String, String> {
    let notification_id = github_notification_node_id(&snapshot.notification_key)?;
    if transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
            [&notification_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect a preflighted GitHub notification: {error}"))?
    {
        return Ok(notification_id);
    }
    let sort_key = next_github_notification_sort_key(transaction, date_id)?;
    let metadata =
        serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Notification {
            notification_key: snapshot.notification_key.clone(),
            notification_type: snapshot.notification_type.clone(),
            url: snapshot.url.clone(),
            updated_at: snapshot.updated_at.clone(),
            unread: snapshot.unread,
        })
        .expect("GitHub notification metadata serializes");
    transaction
        .execute(
            "INSERT INTO notes_nodes(\
               id, parent_id, sort_key, title, note, is_readonly, plugin_state, plugin_meta, \
               created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![
                notification_id,
                date_id,
                sort_key,
                snapshot.title,
                snapshot.note,
                metadata
            ],
        )
        .map_err(|error| format!("Could not materialize a GitHub notification: {error}"))?;
    Ok(notification_id)
}

pub(crate) fn materialize_github_notification_and_create_sibling(
    connection: &mut Connection,
    input: MaterializeGithubNotificationSiblingInput,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        require_github_notifications_root(transaction, &input.root_id)?;
        preflight_github_snapshot_chain(transaction, &input.snapshot)?;
        let existing_sibling = if let Some(existing) = node_by_id(transaction, &input.sibling_id)? {
            let date_id = github_date_node_id(&input.snapshot.date_key)?;
            if existing.parent_id.as_deref() != Some(&date_id)
                || !existing.title.is_empty()
                || !existing.note.is_empty()
                || existing.is_readonly != Some(false)
                || existing.plugin_state.is_some()
                || existing.plugin_meta.is_some()
                || existing.deleted_at.is_some()
                || existing.archived_at.is_some()
            {
                return Err(
                    "The requested GitHub notification sibling ID is already in use.".to_string(),
                );
            }
            true
        } else {
            ensure_fresh_id(transaction, &input.sibling_id)?;
            false
        };
        let date_id = insert_github_date_anchor_if_missing(transaction, &input.snapshot.date_key)?;
        let notification_id =
            insert_github_notification_if_missing(transaction, &date_id, &input.snapshot)?;
        if existing_sibling {
            return Ok(());
        }
        let sort_key = next_sort_key(transaction, Some(&date_id), Some(&notification_id))?;
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, note, is_readonly, plugin_state, plugin_meta, \
                   created_at, updated_at\
                 ) VALUES (?1, ?2, ?3, '', '', 0, NULL, NULL, \
                           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![input.sibling_id, date_id, sort_key],
            )
            .map_err(|error| format!("Could not create a GitHub notification sibling: {error}"))?;
        Ok(())
    })
}

pub(crate) fn materialize_github_notification_and_import_children(
    connection: &mut Connection,
    root_id: NoteId,
    snapshot: GithubNotificationSnapshotInput,
    nodes: Vec<ImportNode>,
    today: LocalDate,
) -> Result<(NotesWorkspace, Vec<NoteId>), String> {
    validate_note_id(&root_id)?;
    if root_id != GITHUB_NOTIFICATIONS_ROOT_ID {
        return Err("The GitHub notification root ID is invalid.".to_string());
    }
    snapshot.validate()?;
    validate_import_nodes(&nodes)?;
    let mut imported_root_ids = Vec::new();
    let workspace = with_workspace_transaction(connection, |transaction| {
        require_github_notifications_root(transaction, &root_id)?;
        preflight_github_snapshot_chain(transaction, &snapshot)?;
        let date_id = insert_github_date_anchor_if_missing(transaction, &snapshot.date_key)?;
        let notification_id =
            insert_github_notification_if_missing(transaction, &date_id, &snapshot)?;
        imported_root_ids =
            insert_import_forest(transaction, Some(&notification_id), None, &nodes, today)?;
        Ok(())
    })?;
    Ok((workspace, imported_root_ids))
}

pub(crate) fn materialize_github_notification_and_reparent(
    connection: &mut Connection,
    input: MaterializeGithubNotificationReparentInput,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        require_github_notifications_root(transaction, &input.root_id)?;
        require_subtree_movable(transaction, &input.node_id)?;
        preflight_github_snapshot_chain(transaction, &input.snapshot)?;
        let date_id = insert_github_date_anchor_if_missing(transaction, &input.snapshot.date_key)?;
        let notification_id =
            insert_github_notification_if_missing(transaction, &date_id, &input.snapshot)?;
        let source = require_active_node(transaction, &input.node_id)?;
        if source.parent_id.as_deref() == Some(&notification_id) {
            return Ok(());
        }
        move_node_within_transaction(
            transaction,
            &input.node_id,
            Some(&notification_id),
            None,
            None,
        )
    })
}

fn checked_github_sort_block(base: i64, count: usize) -> Option<Vec<i64>> {
    let count = i64::try_from(count).ok()?;
    base.checked_add(count.checked_mul(SORT_KEY_STEP)?)?;
    (1..=count)
        .map(|offset| base.checked_add(offset.checked_mul(SORT_KEY_STEP)?))
        .collect()
}

fn reserve_github_sort_block(
    transaction: &Transaction<'_>,
    parent_id: &str,
    initial_base: i64,
    count: usize,
) -> Result<Vec<i64>, String> {
    if let Some(keys) = checked_github_sort_block(initial_base, count) {
        return Ok(keys);
    }
    rebalance_siblings(transaction, Some(parent_id), None)?;
    let rebalanced_base = transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_key), 0) FROM notes_nodes \
             WHERE parent_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
            [parent_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Could not inspect rebalanced GitHub ordering: {error}"))?;
    checked_github_sort_block(rebalanced_base, count).ok_or_else(|| {
        "Could not allocate a GitHub provider sort block after rebalancing.".to_string()
    })
}

pub(crate) fn refresh_materialized_github_notifications(
    connection: &mut Connection,
    mut input: RefreshGithubNotificationsInput,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    input
        .notifications
        .sort_by(|left, right| left.notification_key.cmp(&right.notification_key));
    with_workspace_transaction(connection, |transaction| {
        require_github_notifications_root(transaction, &input.root_id)?;

        let expected_notifications = input
            .notifications
            .iter()
            .map(|snapshot| {
                Ok((
                    github_notification_node_id(&snapshot.notification_key)?,
                    snapshot.notification_key.clone(),
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let notification_candidates = load_github_candidate_rows(
            transaction,
            &expected_notifications,
            "notification",
            "notification_key",
            true,
        )?;
        let mut materialized = BTreeMap::<String, GithubStoredRow>::new();
        let mut old_date_ids = BTreeSet::new();
        for (notification_id, notification_key) in &expected_notifications {
            let Some(row) = exact_github_candidate(
                &notification_candidates,
                notification_id,
                notification_key,
            )?
            else {
                continue;
            };
            validate_loaded_github_notification(row, notification_key)?;
            let parent_id = row
                .node
                .parent_id
                .as_ref()
                .ok_or_else(|| "A GitHub notification has no date anchor.".to_string())?;
            old_date_ids.insert(parent_id.clone());
            materialized.insert(notification_key.clone(), row.clone());
        }

        let old_dates_by_id = load_github_rows_by_id(transaction, &old_date_ids)?;
        let mut expected_old_dates = BTreeMap::<String, String>::new();
        for old_date_id in &old_date_ids {
            let date = old_dates_by_id
                .get(old_date_id)
                .ok_or_else(|| "A GitHub notification has a missing date anchor.".to_string())?;
            let date_key = match date.node.plugin_meta.as_ref() {
                Some(GithubNotificationsPluginMeta::Date { date_key }) => date_key,
                _ => return Err("A GitHub notification has an invalid date anchor.".to_string()),
            };
            expected_old_dates.insert(old_date_id.clone(), date_key.clone());
        }
        let expected_old_date_rows = expected_old_dates
            .iter()
            .map(|(date_id, date_key)| (date_id.clone(), date_key.clone()))
            .collect::<Vec<_>>();
        let old_date_candidates = load_github_candidate_rows(
            transaction,
            &expected_old_date_rows,
            "date",
            "date_key",
            false,
        )?;
        for (notification_key, notification) in &materialized {
            let parent_id = notification
                .node
                .parent_id
                .as_ref()
                .expect("materialized notification parent was collected");
            let date_key = expected_old_dates
                .get(parent_id)
                .expect("old GitHub date key was collected");
            let date = exact_github_candidate(&old_date_candidates, parent_id, date_key)?
                .ok_or_else(|| "A GitHub notification has a missing date anchor.".to_string())?;
            validate_loaded_github_date(date, date_key)?;
            if notification.node.id != github_notification_node_id(notification_key)? {
                return Err(
                    "A materialized GitHub notification key does not match its ID.".to_string(),
                );
            }
        }

        #[derive(Clone, Copy, PartialEq, Eq)]
        enum ChangeKind {
            MarkRead,
            Newer,
        }
        struct Change {
            snapshot_index: usize,
            notification_id: String,
            old_date_id: String,
            destination_date_id: String,
            kind: ChangeKind,
        }

        let mut changes = Vec::new();
        let mut destination_dates = BTreeMap::<String, String>::new();
        for (snapshot_index, snapshot) in input.notifications.iter().enumerate() {
            let Some(notification) = materialized.get(&snapshot.notification_key) else {
                continue;
            };
            let Some(GithubNotificationsPluginMeta::Notification {
                updated_at, unread, ..
            }) = notification.node.plugin_meta.as_ref()
            else {
                return Err("A materialized GitHub notification has invalid metadata.".to_string());
            };
            let Some(order) =
                compare_github_notification_timestamps(&snapshot.updated_at, updated_at)
            else {
                return Err("A GitHub notification timestamp is invalid.".to_string());
            };
            if order == std::cmp::Ordering::Less
                || (order == std::cmp::Ordering::Equal && (!*unread || snapshot.unread))
            {
                continue;
            }
            if order == std::cmp::Ordering::Equal {
                changes.push(Change {
                    snapshot_index,
                    notification_id: notification.node.id.clone(),
                    old_date_id: notification
                        .node
                        .parent_id
                        .clone()
                        .expect("validated notification parent"),
                    destination_date_id: notification
                        .node
                        .parent_id
                        .clone()
                        .expect("validated notification parent"),
                    kind: ChangeKind::MarkRead,
                });
                continue;
            }
            let old_date_id = notification.node.parent_id.clone().ok_or_else(|| {
                "A materialized GitHub notification has no date anchor.".to_string()
            })?;
            let destination_date_id = github_date_node_id(&snapshot.date_key)?;
            if old_date_id != destination_date_id {
                destination_dates.insert(snapshot.date_key.clone(), destination_date_id.clone());
            }
            changes.push(Change {
                snapshot_index,
                notification_id: notification.node.id.clone(),
                old_date_id,
                destination_date_id,
                kind: ChangeKind::Newer,
            });
        }

        let expected_dates = destination_dates
            .iter()
            .map(|(date_key, date_id)| (date_id.clone(), date_key.clone()))
            .collect::<Vec<_>>();
        let destination_candidates =
            load_github_candidate_rows(transaction, &expected_dates, "date", "date_key", false)?;
        let mut missing_dates = Vec::<(String, String)>::new();
        for (date_id, date_key) in &expected_dates {
            if let Some(row) = exact_github_candidate(&destination_candidates, date_id, date_key)? {
                validate_loaded_github_date(row, date_key)?;
            } else {
                missing_dates.push((date_key.clone(), date_id.clone()));
            }
        }

        let root_sort_keys = if missing_dates.is_empty() {
            Vec::new()
        } else {
            let root_base = transaction
                .query_row(
                    "SELECT COALESCE(MAX(sort_key), 0) FROM notes_nodes \
                     WHERE parent_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| format!("Could not inspect GitHub date order: {error}"))?;
            reserve_github_sort_block(
                transaction,
                GITHUB_NOTIFICATIONS_ROOT_ID,
                root_base,
                missing_dates.len(),
            )?
        };
        for ((date_key, date_id), sort_key) in missing_dates.iter().zip(root_sort_keys) {
            let metadata =
                serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Date {
                    date_key: date_key.clone(),
                })
                .expect("GitHub date metadata serializes");
            transaction
                .execute(
                    "INSERT INTO notes_nodes(\
                       id, parent_id, sort_key, title, note, is_readonly, plugin_state, plugin_meta, \
                       created_at, updated_at\
                     ) VALUES (?1, ?2, ?3, ?4, '', NULL, NULL, ?5, \
                               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                    params![
                        date_id,
                        GITHUB_NOTIFICATIONS_ROOT_ID,
                        sort_key,
                        date_key,
                        metadata
                    ],
                )
                .map_err(|error| format!("Could not create a GitHub date anchor: {error}"))?;
        }

        let mut moves_by_destination = BTreeMap::<String, Vec<String>>::new();
        for change in &changes {
            if change.kind == ChangeKind::Newer && change.old_date_id != change.destination_date_id
            {
                moves_by_destination
                    .entry(change.destination_date_id.clone())
                    .or_default()
                    .push(change.notification_id.clone());
            }
        }
        let destination_ids = moves_by_destination.keys().collect::<Vec<_>>();
        let mut destination_maximums = BTreeMap::<String, i64>::new();
        for chunk in destination_ids.chunks(ANCESTOR_CLOSURE_CHUNK_SIZE) {
            let placeholders = std::iter::repeat("?")
                .take(chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT parent_id, COALESCE(MAX(sort_key), 0) FROM notes_nodes \
                 WHERE parent_id IN ({placeholders}) \
                   AND deleted_at IS NULL AND archived_at IS NULL \
                 GROUP BY parent_id ORDER BY parent_id"
            );
            let mut statement = transaction
                .prepare(&sql)
                .map_err(|error| format!("Could not prepare GitHub destination order: {error}"))?;
            let rows = statement
                .query_map(
                    params_from_iter(chunk.iter().map(|node_id| node_id.as_str())),
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .map_err(|error| format!("Could not inspect GitHub destination order: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Could not collect GitHub destination order: {error}"))?;
            destination_maximums.extend(rows);
        }
        let mut move_sort_keys = BTreeMap::<String, i64>::new();
        for (destination_id, notification_ids) in &moves_by_destination {
            let base = destination_maximums
                .get(destination_id)
                .copied()
                .unwrap_or(0);
            let sort_keys = reserve_github_sort_block(
                transaction,
                destination_id,
                base,
                notification_ids.len(),
            )?;
            for (notification_id, sort_key) in notification_ids.iter().zip(sort_keys) {
                move_sort_keys.insert(notification_id.clone(), sort_key);
            }
        }

        let mut cleanup_candidates = BTreeSet::new();
        for change in &changes {
            let snapshot = &input.notifications[change.snapshot_index];
            let notification = materialized
                .get(&snapshot.notification_key)
                .expect("planned materialized notification");
            let Some(GithubNotificationsPluginMeta::Notification {
                notification_key,
                notification_type,
                url,
                updated_at,
                ..
            }) = notification.node.plugin_meta.as_ref()
            else {
                return Err("A materialized GitHub notification has invalid metadata.".to_string());
            };
            if change.kind == ChangeKind::MarkRead {
                let metadata = serialize_github_plugin_meta_storage(
                    &GithubNotificationsPluginMeta::Notification {
                        notification_key: notification_key.clone(),
                        notification_type: notification_type.clone(),
                        url: url.clone(),
                        updated_at: updated_at.clone(),
                        unread: false,
                    },
                )
                .expect("GitHub notification metadata serializes");
                transaction
                    .execute(
                        "UPDATE notes_nodes SET plugin_meta = ?1, \
                            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                         WHERE id = ?2",
                        params![metadata, change.notification_id],
                    )
                    .map_err(|error| {
                        format!("Could not preserve GitHub notification read state: {error}")
                    })?;
                continue;
            }
            let sort_key = if change.old_date_id == change.destination_date_id {
                notification.node.sort_key
            } else {
                cleanup_candidates.insert(change.old_date_id.clone());
                *move_sort_keys
                    .get(&change.notification_id)
                    .expect("planned GitHub move order")
            };
            let metadata = serialize_github_plugin_meta_storage(
                &GithubNotificationsPluginMeta::Notification {
                    notification_key: snapshot.notification_key.clone(),
                    notification_type: snapshot.notification_type.clone(),
                    url: snapshot.url.clone(),
                    updated_at: snapshot.updated_at.clone(),
                    unread: snapshot.unread,
                },
            )
            .expect("GitHub notification metadata serializes");
            transaction
                .execute(
                    "UPDATE notes_nodes SET parent_id = ?1, sort_key = ?2, title = ?3, note = ?4, \
                        plugin_meta = ?5, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                     WHERE id = ?6 AND deleted_at IS NULL AND archived_at IS NULL",
                    params![
                        change.destination_date_id,
                        sort_key,
                        snapshot.title,
                        snapshot.note,
                        metadata,
                        change.notification_id
                    ],
                )
                .map_err(|error| {
                    format!("Could not refresh a materialized GitHub notification: {error}")
                })?;
        }

        let mut removed_anchor = false;
        for chunk in cleanup_candidates
            .iter()
            .collect::<Vec<_>>()
            .chunks(ANCESTOR_CLOSURE_CHUNK_SIZE)
        {
            let placeholders = std::iter::repeat("?")
                .take(chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let inspect_sql = format!(
                "SELECT candidate.id FROM notes_nodes candidate \
                 WHERE candidate.id IN ({placeholders}) \
                   AND NOT EXISTS(SELECT 1 FROM notes_nodes child \
                                  WHERE child.parent_id = candidate.id) \
                 ORDER BY candidate.id"
            );
            let mut statement = transaction
                .prepare(&inspect_sql)
                .map_err(|error| format!("Could not prepare GitHub anchor cleanup: {error}"))?;
            let empty = statement
                .query_map(
                    params_from_iter(chunk.iter().map(|node_id| node_id.as_str())),
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| format!("Could not inspect GitHub anchor cleanup: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Could not collect GitHub anchor cleanup: {error}"))?;
            if empty.is_empty() {
                continue;
            }
            let empty_placeholders = std::iter::repeat("?")
                .take(empty.len())
                .collect::<Vec<_>>()
                .join(",");
            transaction
                .execute(
                    &format!("DELETE FROM notes_nodes WHERE id IN ({empty_placeholders})"),
                    params_from_iter(empty.iter()),
                )
                .map_err(|error| format!("Could not remove empty GitHub date anchors: {error}"))?;
            transaction
                .execute(
                    &format!(
                        "DELETE FROM sync_dirty_nodes WHERE node_id IN ({empty_placeholders})"
                    ),
                    params_from_iter(empty.iter()),
                )
                .map_err(|error| {
                    format!("Could not clear removed GitHub date dirtiness: {error}")
                })?;
            removed_anchor = true;
        }
        if removed_anchor {
            transaction
                .execute(
                    "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
                     ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                )
                .map_err(|error| {
                    format!("Could not dirty the GitHub Notifications root: {error}")
                })?;
        }
        Ok(())
    })
}

pub(crate) fn mark_materialized_github_notification_read(
    connection: &mut Connection,
    input: MarkGithubNotificationReadInput,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        require_github_notifications_root(transaction, &input.root_id)?;
        let notification_id = github_notification_node_id(&input.notification_key)?;
        let notification = require_active_node(transaction, &notification_id)?;
        validate_github_notification_chain(
            transaction,
            &notification,
            &input.notification_key,
            None,
        )?;
        let Some(GithubNotificationsPluginMeta::Notification {
            notification_key,
            notification_type,
            url,
            updated_at,
            unread,
        }) = notification.plugin_meta
        else {
            return Err("The GitHub notification read target is not provider-owned.".to_string());
        };
        if notification_key != input.notification_key
            || compare_github_notification_timestamps(&input.updated_at, &updated_at)
                != Some(std::cmp::Ordering::Equal)
        {
            return Err("The GitHub notification read target is stale.".to_string());
        }
        if !unread {
            return Ok(());
        }
        let metadata =
            serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Notification {
                notification_key,
                notification_type,
                url,
                updated_at,
                unread: false,
            })
            .expect("GitHub notification metadata serializes");
        transaction
            .execute(
                "UPDATE notes_nodes SET plugin_meta = ?1, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                params![metadata, notification_id],
            )
            .map_err(|error| format!("Could not mark a GitHub notification read: {error}"))?;
        Ok(())
    })
}

pub(crate) fn set_github_group_collapsed(
    connection: &mut Connection,
    input: SetGithubGroupCollapsedInput,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        let root = require_github_notifications_root(transaction, &input.root_id)?;
        let state = root
            .plugin_state
            .ok_or_else(|| "The GitHub Notifications root has no plugin state.".to_string())?;
        let mut groups = state.collapsed_groups.into_iter().collect::<BTreeSet<_>>();
        let changed = if input.collapsed {
            groups.insert(input.group_key.clone())
        } else {
            groups.remove(&input.group_key)
        };
        if !changed {
            return Ok(());
        }
        let groups = groups.into_iter().collect::<Vec<_>>();
        let plugin_state =
            serde_json::to_string(&groups).expect("GitHub collapsed groups serialize");
        transaction
            .execute(
                "UPDATE notes_nodes SET plugin_state = ?1, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                params![plugin_state, input.root_id],
            )
            .map_err(|error| format!("Could not update GitHub group collapse: {error}"))?;
        Ok(())
    })
}

#[cfg(test)]
pub(crate) fn create_node(
    connection: &mut Connection,
    input: CreateNodeInput,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    create_node_at(connection, input, today)
}

pub(crate) fn create_node_at(
    connection: &mut Connection,
    input: CreateNodeInput,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    create_node_with_placement_at(connection, input, None, today)
}

pub(crate) fn create_node_before_at(
    connection: &mut Connection,
    input: CreateNodeInput,
    before_id: &str,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    validate_note_id(before_id)?;
    create_node_with_placement_at(connection, input, Some(before_id), today)
}

fn create_node_with_placement_at(
    connection: &mut Connection,
    input: CreateNodeInput,
    before_id: Option<&str>,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        ensure_fresh_id(transaction, &input.id)?;
        ensure_live_parent(transaction, input.parent_id.as_deref())?;
        let sort_key = next_sort_key_excluding(
            transaction,
            input.parent_id.as_deref(),
            input.after_id.as_deref(),
            before_id,
            None,
        )?;
        transaction
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, node_kind, marker_kind, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, ?5, 'text', ?6, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 )",
                params![
                    input.id,
                    input.parent_id,
                    sort_key,
                    input.title,
                    input.note,
                    input.marker_kind.as_str()
                ],
            )
            .map_err(|error| format!("Could not create the Note node: {error}"))?;
        replace_derived_content(
            transaction,
            &input.id,
            NoteNodeKind::Text,
            &input.title,
            0,
            &input.note,
            today,
        )
    })
}

#[cfg(test)]
pub(crate) fn update_node(
    connection: &mut Connection,
    input: UpdateNodeInput,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    update_node_at(connection, input, today)
}

pub(crate) fn update_node_at(
    connection: &mut Connection,
    input: UpdateNodeInput,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_active_node(transaction, &input.id)?;
        require_content_mutable(&source)?;
        crate::notes::schema::validate_image_offset_utf16(
            &input.title,
            source.node_kind,
            input.image_offset_utf16,
        )?;
        transaction
            .execute(
                "UPDATE notes_nodes SET title = ?1, note = ?2, image_offset_utf16 = ?3, marker_kind = ?4, markdown_image_width = ?5, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?6 AND deleted_at IS NULL AND archived_at IS NULL",
                params![
                    input.title,
                    input.note,
                    input.image_offset_utf16,
                    input.marker_kind.as_str(),
                    input.markdown_image_width,
                    input.id
                ],
            )
            .map_err(|error| format!("Could not update the Note node: {error}"))?;
        replace_derived_content(
            transaction,
            &input.id,
            source.node_kind,
            &input.title,
            input.image_offset_utf16,
            &input.note,
            today,
        )
    })
}

pub(crate) fn set_readonly_at(
    connection: &mut Connection,
    node_id: NoteId,
    is_readonly: bool,
    _today: LocalDate,
) -> Result<NotesWorkspace, String> {
    validate_note_id(&node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_active_node(transaction, &node_id)?;
        if plugin_owned(&source) {
            return Err(
                "This Note node is managed by a plugin and cannot be modified.".to_string(),
            );
        }
        let current = source.is_readonly.unwrap_or(false);
        if current == is_readonly {
            return Ok(());
        }
        transaction
            .execute(
                "UPDATE notes_nodes SET is_readonly = ?1, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?2 AND deleted_at IS NULL AND archived_at IS NULL",
                rusqlite::params![i64::from(is_readonly), node_id],
            )
            .map_err(|error| format!("Could not update the Note readonly state: {error}"))?;
        mark_topic_dirty(transaction, &node_id)
    })
}

fn batch_soft_delete_unchecked(
    transaction: &Transaction<'_>,
    node_ids: &[String],
) -> Result<(), String> {
    let deletion_batch_id = fresh_deletion_batch_id(transaction)?;
    // Snapshot every selected root's archive context before the first update.
    // An ancestor+descendant selection is legal; after the ancestor is moved,
    // querying the descendant would otherwise see a deleted row and abort the
    // whole transaction.
    let archive_root_ids = node_ids
        .iter()
        .map(|node_id| {
            transaction
                .query_row(
                    "SELECT archive_root_id FROM notes_nodes WHERE id = ?1 AND deleted_at IS NULL",
                    [node_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(|error| format!("Could not inspect the Note archive state: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    for (node_id, archive_root_id) in node_ids.iter().zip(archive_root_ids) {
        transaction
            .execute(
                "WITH RECURSIVE subtree(id) AS (\
                   SELECT id FROM notes_nodes \
                   WHERE id = ?1 AND deleted_at IS NULL AND archive_root_id IS ?3 \
                   UNION ALL \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id \
                   WHERE child.deleted_at IS NULL AND child.archive_root_id IS ?3\
                 ) \
                 UPDATE notes_nodes SET \
                   deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   deleted_batch_id = ?2, \
                   archived_at = NULL, \
                   archive_root_id = NULL, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id IN subtree",
                rusqlite::params![node_id, deletion_batch_id, archive_root_id],
            )
            .map_err(|error| format!("Could not move the Note selection to trash: {error}"))?;
    }
    Ok(())
}

pub(crate) fn delete_nodes(
    connection: &mut Connection,
    mut input: DeleteNodesInput,
) -> Result<DeleteNodesOutcome, String> {
    input.validate()?;
    let journaled = history::has_active_context(connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes delete transaction: {error}"))?;
    validate_delete_authority(&transaction, &input.node_ids)?;
    input.node_ids = normalize_delete_roots(&transaction, &input.node_ids)?;
    validate_delete_targets(&transaction, &input)?;
    let readonly_ids = readonly_descendants(&transaction, &input.node_ids)?;
    match input.expected_readonly_descendant_ids {
        None if !readonly_ids.is_empty() => {
            transaction
                .rollback()
                .map_err(|error| format!("Could not finish the Notes delete preflight: {error}"))?;
            return Ok(DeleteNodesOutcome::NeedsReadonlyConfirmation {
                readonly_descendant_ids: readonly_ids,
            });
        }
        Some(mut expected) => {
            expected.sort();
            if expected != readonly_ids {
                return Err("Notes readonly delete confirmation is stale.".to_string());
            }
        }
        None => {}
    }
    batch_soft_delete_unchecked(&transaction, &input.node_ids)?;
    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    if journaled {
        history::finalize_transaction(&transaction)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes delete transaction: {error}"))?;
    Ok(DeleteNodesOutcome::Deleted(NotesMutationResult {
        workspace,
        // Legacy delete has no history context and no delta, so there is nothing
        // to reconstruct from — the full workspace stays on the wire.
        serialize_workspace: true,
        history_entry_id: None,
        state: crate::notes::types::NotesHistoryState::default(),
        changed_nodes: None,
        removed_node_ids: None,
        changed_attachments: None,
        imported_root_ids: None,
        duplicated_root_ids: None,
    }))
}

fn validate_delete_targets(
    transaction: &Transaction<'_>,
    input: &DeleteNodesInput,
) -> Result<(), String> {
    for node_id in &input.node_ids {
        let node = require_live_node(transaction, node_id)?;
        if input.expected_readonly_descendant_ids.is_some() && node.is_readonly == Some(true) {
            return Err("Notes readonly delete confirmation is stale.".to_string());
        }
        if node.archived_at.is_some() && node.archive_root_id.as_deref() != Some(node_id) {
            return Err("Only an archive root can be moved to trash.".to_string());
        }
        require_content_mutable(&node)?;
    }
    Ok(())
}

fn validate_delete_authority(
    transaction: &Transaction<'_>,
    node_ids: &[String],
) -> Result<(), String> {
    for node_id in node_ids {
        let node = require_live_node(transaction, node_id)?;
        require_content_mutable(&node)?;
    }
    Ok(())
}

/// Performs the delete authorization scan without creating a history context
/// or changing any row. A confirmed empty set is handled by `delete_nodes` in
/// the normal history wrapper after this read-only pass.
pub(crate) fn delete_nodes_preflight(
    connection: &mut Connection,
    input: &DeleteNodesInput,
) -> Result<Vec<NoteId>, String> {
    input.validate()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes delete preflight: {error}"))?;
    validate_delete_authority(&transaction, &input.node_ids)?;
    let normalized_input = DeleteNodesInput {
        node_ids: normalize_delete_roots(&transaction, &input.node_ids)?,
        expected_readonly_descendant_ids: input.expected_readonly_descendant_ids.clone(),
    };
    validate_delete_targets(&transaction, &normalized_input)?;
    let readonly_ids = readonly_descendants(&transaction, &normalized_input.node_ids)?;
    transaction
        .rollback()
        .map_err(|error| format!("Could not finish the Notes delete preflight: {error}"))?;
    Ok(readonly_ids)
}

#[cfg(test)]
pub(crate) fn split_node(
    connection: &mut Connection,
    input: SplitNodeInput,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    split_node_at(connection, input, today)
}

pub(crate) fn split_node_at(
    connection: &mut Connection,
    input: SplitNodeInput,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_active_node(transaction, &input.id)?;
        require_content_mutable(&source)?;
        ensure_generic_parent_allowed(source.parent_id.as_deref())?;
        if source.node_kind == NoteNodeKind::Image {
            return Err("An image node cannot be split.".to_string());
        }
        ensure_fresh_id(transaction, &input.new_node_id)?;
        let sort_key = next_sort_key(
            transaction,
            source.parent_id.as_deref(),
            Some(source.id.as_str()),
        )?;
        transaction
            .execute(
                "UPDATE notes_nodes SET title = ?1, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?2 AND deleted_at IS NULL AND archived_at IS NULL",
                params![input.prefix, source.id],
            )
            .map_err(|error| format!("Could not update the split Note node: {error}"))?;
        replace_derived_content(
            transaction,
            &source.id,
            NoteNodeKind::Text,
            &input.prefix,
            0,
            &source.note,
            today,
        )?;
        transaction
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, node_kind, marker_kind, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, 'text', ?5, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 )",
                params![
                    input.new_node_id,
                    source.parent_id,
                    sort_key,
                    input.suffix,
                    source.marker_kind.as_str()
                ],
            )
            .map_err(|error| format!("Could not create the split Note node: {error}"))?;
        replace_derived_content(
            transaction,
            &input.new_node_id,
            NoteNodeKind::Text,
            &input.suffix,
            0,
            "",
            today,
        )?;
        Ok(())
    })
}

fn revalidate_image_atom_target(
    transaction: &Transaction<'_>,
    target: &ImageTargetAuthority,
) -> Result<StoredNode, String> {
    let source = require_active_node(transaction, &target.node_id)?;
    if source.node_kind != NoteNodeKind::Image {
        return Err(
            "The requested Notes image atom target is no longer an image node.".to_string(),
        );
    }
    let updated_at: String = transaction
        .query_row(
            "SELECT updated_at FROM notes_nodes WHERE id = ?1",
            [&target.node_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not revalidate the Notes image atom target: {error}"))?;
    if updated_at != target.expected_updated_at
        || source.title != target.expected_title
        || source.image_offset_utf16 != target.expected_image_offset_utf16
    {
        return Err("The Notes image atom target is stale.".to_string());
    }
    let attachment_ids = transaction
        .prepare("SELECT id FROM notes_attachments WHERE node_id = ?1 ORDER BY sort_key, id")
        .map_err(|error| format!("Could not inspect Notes image atom ownership: {error}"))?
        .query_map([&target.node_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not inspect Notes image atom ownership: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes image atom ownership: {error}"))?;
    if attachment_ids.len() != 1 {
        return Err(
            "The Notes image atom target must own exactly one primary attachment.".to_string(),
        );
    }
    if attachment_ids[0] != target.expected_primary_attachment_id {
        return Err("The Notes image atom primary attachment authority is stale.".to_string());
    }
    Ok(source)
}

fn reject_existing_image_atom_history_entry(
    transaction: &Transaction<'_>,
    operation_id: &str,
) -> Result<(), String> {
    let exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_history_entries WHERE id = ?1)",
            [operation_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| {
            format!("Could not inspect the Notes image atom history entry: {error}")
        })?;
    if exists {
        return Err(
            "A fresh Notes image atom operation cannot reuse an existing history entry."
                .to_string(),
        );
    }
    Ok(())
}

/// Applies the precomputed image-atom edit and finalizes its active history
/// context in one IMMEDIATE transaction. The receipt hook deliberately runs
/// after history finalization and before commit so a response-loss retry can
/// never observe live rows without their matching receipt/history entry.
pub(crate) fn apply_image_atom_edit_plan(
    connection: &mut Connection,
    operation_id: &str,
    target: &ImageTargetAuthority,
    plan: &ImageAtomEditPlan,
    today: LocalDate,
    record_receipt: impl FnOnce(&Transaction<'_>, &NotesWorkspace) -> Result<(), String>,
) -> Result<NotesWorkspace, String> {
    if !history::has_active_context(connection)? {
        return Err("Notes image atom edits require a history context.".to_string());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes image atom transaction: {error}"))?;
    reject_existing_image_atom_history_entry(&transaction, operation_id)?;
    let source = revalidate_image_atom_target(&transaction, target)?;
    require_content_mutable(&source)?;
    ensure_generic_parent_allowed(source.parent_id.as_deref())?;
    if let Some(sibling) = &plan.sibling {
        ensure_fresh_id(&transaction, &sibling.id)?;
    }
    crate::notes::schema::validate_image_offset_utf16(
        &plan.source_title,
        plan.source_node_kind,
        plan.source_image_offset_utf16,
    )?;
    let source_changed = source.node_kind != plan.source_node_kind
        || source.title != plan.source_title
        || source.image_offset_utf16 != plan.source_image_offset_utf16;
    if source_changed {
        transaction
            .execute(
                "UPDATE notes_nodes SET title = ?1, node_kind = ?2, image_offset_utf16 = ?3, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?4 AND deleted_at IS NULL AND archived_at IS NULL",
                params![
                    &plan.source_title,
                    plan.source_node_kind.as_str(),
                    plan.source_image_offset_utf16,
                    &source.id,
                ],
            )
            .map_err(|error| format!("Could not update the Notes image atom source: {error}"))?;
        replace_derived_content(
            &transaction,
            &source.id,
            plan.source_node_kind,
            &plan.source_title,
            plan.source_image_offset_utf16,
            &source.note,
            today,
        )?;
    }

    if let Some(sibling) = &plan.sibling {
        crate::notes::schema::validate_image_offset_utf16(
            &sibling.title,
            sibling.node_kind,
            sibling.image_offset_utf16,
        )?;
        let sort_key = next_sort_key(
            &transaction,
            source.parent_id.as_deref(),
            Some(source.id.as_str()),
        )?;
        transaction
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, image_offset_utf16, node_kind, marker_kind, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, '', ?5, ?6, ?7, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 )",
                params![
                    &sibling.id,
                    &source.parent_id,
                    sort_key,
                    &sibling.title,
                    sibling.image_offset_utf16,
                    sibling.node_kind.as_str(),
                    source.marker_kind.as_str(),
                ],
            )
            .map_err(|error| format!("Could not create the Notes image atom sibling: {error}"))?;
        replace_derived_content(
            &transaction,
            &sibling.id,
            sibling.node_kind,
            &sibling.title,
            sibling.image_offset_utf16,
            "",
            today,
        )?;
    }

    match &plan.attachment_mutation {
        ImageAtomAttachmentMutation::Remove => {
            transaction
                .execute(
                    "DELETE FROM notes_attachments WHERE id = ?1 AND node_id = ?2",
                    params![&target.expected_primary_attachment_id, &source.id],
                )
                .map_err(|error| {
                    format!("Could not remove the Notes image atom attachment: {error}")
                })?;
        }
        ImageAtomAttachmentMutation::MoveTo(node_id) => {
            transaction
                .execute(
                    "UPDATE notes_attachments SET node_id = ?1, \
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                     WHERE id = ?2 AND node_id = ?3",
                    params![node_id, &target.expected_primary_attachment_id, &source.id],
                )
                .map_err(|error| {
                    format!("Could not move the Notes image atom attachment: {error}")
                })?;
        }
        ImageAtomAttachmentMutation::Keep => {}
    }

    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    history::finalize_transaction(&transaction)?;
    record_receipt(&transaction, &workspace)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes image atom edit: {error}"))?;
    Ok(workspace)
}

pub(crate) struct ImageAtomPasteApplication {
    pub(crate) workspace: NotesWorkspace,
    pub(crate) affected_root_ids: Vec<String>,
    pub(crate) focus: ImageAtomFocusResult,
}

fn paste_utf16_len(value: &str) -> Result<i64, String> {
    i64::try_from(value.encode_utf16().count())
        .map_err(|_| "The Notes image atom paste title is too long.".to_string())
}

fn paste_raw_byte_offset(
    title: &str,
    node_kind: NoteNodeKind,
    image_offset_utf16: i64,
    logical_offset: i64,
) -> Result<usize, String> {
    let raw_offset = if node_kind == NoteNodeKind::Image && logical_offset > image_offset_utf16 {
        logical_offset
            .checked_sub(1)
            .ok_or_else(|| "The Notes image atom paste selection is invalid.".to_string())?
    } else {
        logical_offset
    };
    crate::notes::schema::validate_image_offset_utf16(
        title,
        if node_kind == NoteNodeKind::Text {
            // Text nodes store zero as their image offset, but their selected
            // raw title ranges still need the same UTF-16 scalar-boundary check.
            NoteNodeKind::Image
        } else {
            node_kind
        },
        raw_offset,
    )
}

fn paste_selection(
    target: &ImageAtomPasteTargetAuthority,
    selection: &crate::notes::types::LogicalSelection,
) -> Result<(i64, i64), String> {
    crate::notes::schema::validate_image_offset_utf16(
        &target.expected_title,
        target.expected_node_kind,
        target.expected_image_offset_utf16,
    )?;
    let raw_len = paste_utf16_len(&target.expected_title)?;
    let logical_len = if target.expected_node_kind == NoteNodeKind::Image {
        raw_len
            .checked_add(1)
            .ok_or_else(|| "The Notes image atom paste title is too long.".to_string())?
    } else {
        raw_len
    };
    let anchor = selection.anchor_utf16.clamp(0, logical_len);
    let focus = selection.focus_utf16.clamp(0, logical_len);
    let (start, end) = if anchor <= focus {
        (anchor, focus)
    } else {
        (focus, anchor)
    };
    paste_raw_byte_offset(
        &target.expected_title,
        target.expected_node_kind,
        target.expected_image_offset_utf16,
        start,
    )?;
    paste_raw_byte_offset(
        &target.expected_title,
        target.expected_node_kind,
        target.expected_image_offset_utf16,
        end,
    )?;
    Ok((start, end))
}

fn revalidate_image_atom_paste_target(
    transaction: &Transaction<'_>,
    target: &ImageAtomPasteTargetAuthority,
) -> Result<(StoredNode, Vec<String>), String> {
    let source = require_active_node(transaction, &target.node_id)?;
    if source.node_kind != target.expected_node_kind {
        return Err("The requested Notes image atom paste target kind is stale.".to_string());
    }
    let updated_at: String = transaction
        .query_row(
            "SELECT updated_at FROM notes_nodes WHERE id = ?1",
            [&target.node_id],
            |row| row.get(0),
        )
        .map_err(|error| {
            format!("Could not revalidate the Notes image atom paste target: {error}")
        })?;
    if updated_at != target.expected_updated_at
        || source.title != target.expected_title
        || source.image_offset_utf16 != target.expected_image_offset_utf16
    {
        return Err("The Notes image atom paste target is stale.".to_string());
    }
    let attachment_ids = transaction
        .prepare("SELECT id FROM notes_attachments WHERE node_id = ?1 ORDER BY sort_key, id")
        .map_err(|error| format!("Could not inspect Notes image atom paste ownership: {error}"))?
        .query_map([&target.node_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not inspect Notes image atom paste ownership: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes image atom paste ownership: {error}"))?;
    match (
        target.expected_node_kind,
        target.expected_primary_attachment_id.as_deref(),
    ) {
        (NoteNodeKind::Text, None) => Ok((source, attachment_ids)),
        (NoteNodeKind::Image, Some(expected))
            if attachment_ids.len() == 1 && attachment_ids[0] == expected =>
        {
            Ok((source, attachment_ids))
        }
        (NoteNodeKind::Image, _) => Err(
            "The Notes image atom paste target must own its expected primary attachment."
                .to_string(),
        ),
        (NoteNodeKind::Text, Some(_)) => Err(
            "A text Notes image atom paste target cannot name a primary attachment.".to_string(),
        ),
    }
}

type ImageAtomPasteFragmentImages = Vec<(String, NewAttachment)>;

fn paste_fragment_parts(
    input: &ApplyImageAtomPasteInput,
    attachments: Vec<NewAttachment>,
) -> Result<(Vec<String>, ImageAtomPasteFragmentImages), String> {
    let mut text_parts = vec![String::new()];
    let mut image_ids = Vec::new();
    for item in &input.fragment {
        match item {
            ImageAtomPasteFragmentItem::Text { text } => text_parts
                .last_mut()
                .expect("image atom paste always has a text part")
                .push_str(text),
            ImageAtomPasteFragmentItem::Image {
                node_id,
                attachment_id,
                ..
            } => {
                image_ids.push((node_id.clone(), attachment_id.clone()));
                text_parts.push(String::new());
            }
        }
    }
    if image_ids.is_empty() || image_ids.len() != attachments.len() {
        return Err(
            "Notes image atom paste metadata does not match its validated images.".to_string(),
        );
    }
    let mut images = Vec::with_capacity(image_ids.len());
    for ((node_id, attachment_id), attachment) in image_ids.into_iter().zip(attachments) {
        if attachment.id != attachment_id {
            return Err("Notes image atom paste attachment identity is invalid.".to_string());
        }
        images.push((node_id, attachment));
    }
    Ok((text_parts, images))
}

fn paste_node_title(before: &str, after: &str) -> Result<(String, i64), String> {
    let mut title = String::with_capacity(before.len().saturating_add(after.len()));
    title.push_str(before);
    title.push_str(after);
    Ok((title, paste_utf16_len(before)?))
}

struct ImageAtomPasteRowPlan {
    source: StoredNode,
    existing_attachment_ids: Vec<String>,
    atom_selected: bool,
    in_place: bool,
    prepared_nodes: Vec<(String, String, i64, NewAttachment)>,
}

fn plan_image_atom_paste(
    transaction: &Transaction<'_>,
    input: &ApplyImageAtomPasteInput,
    attachments: Vec<NewAttachment>,
) -> Result<ImageAtomPasteRowPlan, String> {
    let (text_parts, images) = paste_fragment_parts(input, attachments)?;
    let (selection_start, selection_end) = paste_selection(&input.target, &input.selection)?;
    let (source, existing_attachment_ids) =
        revalidate_image_atom_paste_target(transaction, &input.target)?;
    require_content_mutable(&source)?;
    ensure_generic_parent_allowed(source.parent_id.as_deref())?;
    let atom_selected = source.node_kind == NoteNodeKind::Image
        && selection_start <= source.image_offset_utf16
        && selection_end > source.image_offset_utf16;
    let source_is_clean_text =
        source.node_kind == NoteNodeKind::Text && existing_attachment_ids.is_empty();
    let in_place = source_is_clean_text || atom_selected;
    if in_place && images[0].0 != source.id {
        return Err(
            "The first in-place Notes image atom paste image must reuse the target node ID."
                .to_string(),
        );
    }
    if !in_place && images.iter().any(|(node_id, _)| node_id == &source.id) {
        return Err(
            "A sibling Notes image atom paste image cannot reuse the target node ID.".to_string(),
        );
    }
    let additional_attachment_count = i64::try_from(images.len())
        .map_err(|_| "Could not measure the Notes image atom paste images.".to_string())?
        - if atom_selected { 1 } else { 0 };
    let vault_attachment_count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not inspect Notes image atom paste capacity: {error}"))?;
    if vault_attachment_count
        .checked_add(additional_attachment_count)
        .is_none_or(|count| count > MAX_NOTE_ATTACHMENTS_PER_VAULT)
    {
        return Err(format!(
            "A Notes vault can contain at most {MAX_NOTE_ATTACHMENTS_PER_VAULT} attachments."
        ));
    }
    let (prefix, suffix) = if in_place {
        let start = paste_raw_byte_offset(
            &source.title,
            source.node_kind,
            source.image_offset_utf16,
            selection_start,
        )?;
        let end = paste_raw_byte_offset(
            &source.title,
            source.node_kind,
            source.image_offset_utf16,
            selection_end,
        )?;
        (
            source.title[..start].to_string(),
            source.title[end..].to_string(),
        )
    } else {
        (String::new(), String::new())
    };
    let image_len = images.len();
    let mut prepared_nodes = Vec::with_capacity(image_len);
    for (index, (node_id, mut attachment)) in images.into_iter().enumerate() {
        let mut before = String::new();
        if index == 0 {
            before.push_str(&prefix);
            before.push_str(&text_parts[0]);
        }
        let mut after = text_parts[index + 1].clone();
        if index + 1 == image_len {
            after.push_str(&suffix);
        }
        let (_, image_offset_utf16) = paste_node_title(&before, &after)?;
        attachment.node_id = if in_place && index == 0 {
            source.id.clone()
        } else {
            node_id.clone()
        };
        validate_new_attachment(&attachment)?;
        if id_namespace_in_use(transaction, &attachment.id)? {
            return Err(format!(
                "Notes attachment ID {} is already in use.",
                attachment.id
            ));
        }
        if !(in_place && index == 0) {
            ensure_fresh_id(transaction, &node_id)?;
        }
        crate::notes::schema::validate_image_offset_utf16(
            &format!("{before}{after}"),
            NoteNodeKind::Image,
            image_offset_utf16,
        )?;
        prepared_nodes.push((
            node_id,
            format!("{before}{after}"),
            image_offset_utf16,
            attachment,
        ));
    }
    Ok(ImageAtomPasteRowPlan {
        source,
        existing_attachment_ids,
        atom_selected,
        in_place,
        prepared_nodes,
    })
}

/// Validates every database-dependent paste precondition before byte
/// publication. The authoritative IMMEDIATE transaction repeats this exact
/// planning helper after publication, closing the race without drifting from
/// the preflight rules.
pub(crate) fn preflight_image_atom_paste_plan(
    connection: &mut Connection,
    operation_id: &str,
    input: &ApplyImageAtomPasteInput,
    attachments: &[NewAttachment],
) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|error| {
        format!("Could not start the Notes image atom paste preflight: {error}")
    })?;
    reject_existing_image_atom_history_entry(&transaction, operation_id)?;
    let plan = plan_image_atom_paste(&transaction, input, attachments.to_vec())?;
    // Read sibling ordering now so a malformed parent/anchor is rejected before
    // publication. The IMMEDIATE phase performs the actual allocation.
    sibling_keys(&transaction, plan.source.parent_id.as_deref(), None)?;
    transaction
        .rollback()
        .map_err(|error| format!("Could not finish the Notes image atom paste preflight: {error}"))
}

/// Applies a fully byte-validated image fragment in one immediate transaction.
/// Publication is intentionally performed by the caller before this function;
/// this function only writes metadata after revalidating the complete target
/// authority and all stable IDs.
pub(crate) fn apply_image_atom_paste_plan(
    connection: &mut Connection,
    operation_id: &str,
    input: &ApplyImageAtomPasteInput,
    attachments: Vec<NewAttachment>,
    today: LocalDate,
    record_receipt: impl FnOnce(
        &Transaction<'_>,
        &NotesWorkspace,
        &ImageAtomPasteApplication,
    ) -> Result<(), String>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<ImageAtomPasteApplication, String> {
    if !history::has_active_context(connection)? {
        return Err("Notes image atom pastes require a history context.".to_string());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            format!("Could not start the Notes image atom paste transaction: {error}")
        })?;
    reject_existing_image_atom_history_entry(&transaction, operation_id)?;
    let ImageAtomPasteRowPlan {
        source,
        existing_attachment_ids,
        atom_selected,
        in_place,
        mut prepared_nodes,
    } = plan_image_atom_paste(&transaction, input, attachments)?;

    let mut affected_root_ids = Vec::new();
    if in_place {
        let (_, title, image_offset_utf16, attachment) = prepared_nodes.remove(0);
        transaction
            .execute(
                "UPDATE notes_nodes SET title = ?1, node_kind = 'image', image_offset_utf16 = ?2, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?3",
                params![title, image_offset_utf16, &source.id],
            )
            .map_err(|error| {
                format!("Could not update the Notes image atom paste target: {error}")
            })?;
        replace_derived_content(
            &transaction,
            &source.id,
            NoteNodeKind::Image,
            &transaction
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [&source.id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| {
                    format!("Could not load the Notes image atom paste title: {error}")
                })?,
            image_offset_utf16,
            &source.note,
            today,
        )?;
        if atom_selected {
            transaction
                .execute(
                    "DELETE FROM notes_attachments WHERE id = ?1 AND node_id = ?2",
                    params![&existing_attachment_ids[0], &source.id],
                )
                .map_err(|error| {
                    format!("Could not replace the Notes image atom attachment: {error}")
                })?;
        }
        insert_new_attachment_at_sort_key(&transaction, attachment, SORT_KEY_STEP)?;
        affected_root_ids.push(source.id.clone());
    }

    let mut after_id = source.id.clone();
    for (node_id, title, image_offset_utf16, attachment) in prepared_nodes {
        let sort_key = next_sort_key(&transaction, source.parent_id.as_deref(), Some(&after_id))?;
        transaction
            .execute(
                "INSERT INTO notes_nodes (id, parent_id, sort_key, title, note, image_offset_utf16, node_kind, marker_kind, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, '', ?5, 'image', ?6, \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![
                    &node_id,
                    &source.parent_id,
                    sort_key,
                    &title,
                    image_offset_utf16,
                    source.marker_kind.as_str()
                ],
            )
            .map_err(|error| format!("Could not create a Notes image atom paste sibling: {error}"))?;
        replace_derived_content(
            &transaction,
            &node_id,
            NoteNodeKind::Image,
            &title,
            image_offset_utf16,
            "",
            today,
        )?;
        insert_new_attachment_at_sort_key(&transaction, attachment, SORT_KEY_STEP)?;
        affected_root_ids.push(node_id.clone());
        after_id = node_id;
    }
    if affected_root_ids.is_empty() {
        return Err("The Notes image atom paste did not create an affected root.".to_string());
    }
    let focus_node_id = affected_root_ids[0].clone();
    let (focus_title, focus_offset): (String, i64) = transaction
        .query_row(
            "SELECT title, image_offset_utf16 FROM notes_nodes WHERE id = ?1",
            [&focus_node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Could not load the Notes image atom paste focus: {error}"))?;
    crate::notes::schema::validate_image_offset_utf16(
        &focus_title,
        NoteNodeKind::Image,
        focus_offset,
    )?;
    let focus = ImageAtomFocusResult {
        node_id: focus_node_id,
        anchor_utf16: focus_offset,
        focus_utf16: focus_offset + 1,
    };
    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    let application = ImageAtomPasteApplication {
        workspace,
        affected_root_ids,
        focus,
    };
    history::finalize_transaction(&transaction)?;
    record_receipt(&transaction, &application.workspace, &application)?;
    before_commit()?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes image atom paste: {error}"))?;
    Ok(application)
}

fn live_descendant_exists(
    transaction: &Transaction<'_>,
    node_id: &str,
    candidate_id: &str,
) -> Result<bool, String> {
    transaction
        .query_row(
            "WITH RECURSIVE descendants(id) AS (\
               SELECT id FROM notes_nodes WHERE parent_id = ?1 AND deleted_at IS NULL \
                 AND archived_at IS NULL \
               UNION ALL \
               SELECT child.id FROM notes_nodes child \
               JOIN descendants parent ON child.parent_id = parent.id \
               WHERE child.deleted_at IS NULL AND child.archived_at IS NULL\
             ) \
             SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
            params![node_id, candidate_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not validate the Note move: {error}"))
}

pub(crate) fn move_node(
    connection: &mut Connection,
    input: MoveNodeInput,
) -> Result<NotesWorkspace, String> {
    input.validate()?;
    with_workspace_transaction(connection, |transaction| {
        let node = require_active_node(transaction, &input.id)?;
        require_subtree_movable(transaction, &input.id)?;
        if input.id == GITHUB_NOTIFICATIONS_ROOT_ID && input.parent_id.is_some() {
            return Err(
                "The Github Notifications root can only be reordered at the top level.".to_string(),
            );
        }
        // A topic root is always a Text node (spec §4.3, remediation A3); refuse
        // to promote an image node to a root, which would leave the merger unable
        // to preserve its kind/attachment.
        if input.parent_id.is_none() && node.node_kind == NoteNodeKind::Image {
            return Err("An image Note cannot become a topic root.".to_string());
        }
        // R5: count the moving subtree's own height, not just the target depth.
        ensure_reparent_target(transaction, &input.id, input.parent_id.as_deref())?;
        if let Some(parent_id) = input.parent_id.as_deref() {
            if live_descendant_exists(transaction, &input.id, parent_id)? {
                return Err("A Note node cannot be moved under a live descendant.".to_string());
            }
        }
        let sort_key = next_sort_key_excluding(
            transaction,
            input.parent_id.as_deref(),
            input.after_id.as_deref(),
            input.before_id.as_deref(),
            Some(&input.id),
        )?;
        mark_former_topic_dirty_for_move(transaction, &input.id, input.parent_id.as_deref())?;
        transaction
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1, sort_key = ?2, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?3 AND deleted_at IS NULL AND archived_at IS NULL",
                params![input.parent_id, sort_key, input.id],
            )
            .map_err(|error| format!("Could not move the Note node: {error}"))?;
        Ok(())
    })
}

pub(crate) fn toggle_complete(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let node = require_active_node(transaction, node_id)?;
        require_provider_mutable(&node)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET \
                   completed_at = CASE WHEN completed_at IS NULL \
                     THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not toggle Note completion: {error}"))?;
        Ok(())
    })
}

pub(crate) fn toggle_collapsed(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        require_active_node(transaction, node_id)?;
        require_collapse_target(transaction, node_id)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET is_collapsed = CASE is_collapsed WHEN 0 THEN 1 ELSE 0 END, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not toggle Note collapse: {error}"))?;
        Ok(())
    })
}

fn ensure_active_subtree_is_acyclic(
    transaction: &Transaction<'_>,
    root_id: &str,
) -> Result<(), String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, parent_id FROM notes_nodes \
             WHERE deleted_at IS NULL AND archived_at IS NULL AND parent_id IS NOT NULL",
        )
        .map_err(|error| format!("Could not prepare Note tree validation: {error}"))?;
    let edges = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not read Note tree validation: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not collect Note tree validation: {error}"))?;
    let mut children = HashMap::<String, Vec<String>>::new();
    for (node_id, parent_id) in edges {
        children.entry(parent_id).or_default().push(node_id);
    }

    let mut pending = vec![root_id.to_string()];
    let mut visited = HashSet::new();
    while let Some(node_id) = pending.pop() {
        if !visited.insert(node_id.clone()) {
            return Err(
                "The Notes tree contains a cycle and cannot be expanded or collapsed.".to_string(),
            );
        }
        if let Some(child_ids) = children.get(&node_id) {
            pending.extend(child_ids.iter().cloned());
        }
    }
    Ok(())
}

fn set_subtree_collapsed(
    connection: &mut Connection,
    node_id: &str,
    is_collapsed: bool,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        require_active_node(transaction, node_id)?;
        let is_plugin_root = require_collapse_target(transaction, node_id)?;
        if is_plugin_root {
            transaction
                .execute(
                    "UPDATE notes_nodes SET is_collapsed = ?2, \
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                     WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL \
                       AND is_collapsed <> ?2",
                    params![node_id, is_collapsed],
                )
                .map_err(|error| format!("Could not update the Note collapse state: {error}"))?;
            return Ok(());
        }
        ensure_active_subtree_is_acyclic(transaction, node_id)?;
        transaction
            .execute(
                "WITH RECURSIVE subtree(id) AS (\
                   SELECT id FROM notes_nodes WHERE id = ?1 AND deleted_at IS NULL \
                     AND archived_at IS NULL \
                   UNION \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id \
                   WHERE child.deleted_at IS NULL AND child.archived_at IS NULL\
                 ) \
                 UPDATE notes_nodes SET is_collapsed = ?2, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id IN subtree AND is_collapsed <> ?2 \
                   AND EXISTS (\
                     SELECT 1 FROM notes_nodes child \
                     WHERE child.parent_id = notes_nodes.id \
                       AND child.deleted_at IS NULL AND child.archived_at IS NULL\
                   )",
                params![node_id, is_collapsed],
            )
            .map_err(|error| {
                format!("Could not update the Note subtree collapse state: {error}")
            })?;
        Ok(())
    })
}

pub(crate) fn expand_all(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    set_subtree_collapsed(connection, node_id, false)
}

pub(crate) fn collapse_all(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    set_subtree_collapsed(connection, node_id, true)
}

fn normalized_display_title(title: &str) -> String {
    let title = title.trim();
    let display_title = if title.is_empty() { "Untitled" } else { title };
    display_title.chars().flat_map(char::to_lowercase).collect()
}

#[derive(Clone, Copy)]
enum SubtreeSortDirection {
    Ascending,
    Descending,
}

fn sort_subtree(
    connection: &mut Connection,
    node_id: &str,
    direction: SubtreeSortDirection,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let root = require_active_node(transaction, node_id)?;
        require_sortable_node(&root)?;
        let mut statement = transaction
            .prepare(
                "SELECT id, parent_id, sort_key, title, \
                        COALESCE(is_readonly, 0) = 1 OR id = ?1 \
                          OR plugin_state IS NOT NULL OR plugin_meta IS NOT NULL \
                 FROM notes_nodes \
                 WHERE deleted_at IS NULL AND archived_at IS NULL \
                 ORDER BY parent_id, sort_key, id",
            )
            .map_err(|error| format!("Could not prepare the Note subtree sort: {error}"))?;
        let rows = statement
            .query_map([GITHUB_NOTIFICATIONS_ROOT_ID], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            })
            .map_err(|error| format!("Could not read the Note subtree sort: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not collect the Note subtree sort: {error}"))?;
        drop(statement);

        let mut children: HashMap<String, Vec<(String, i64, String, bool)>> = HashMap::new();
        for (id, parent_id, sort_key, title, is_protected) in rows {
            if let Some(parent_id) = parent_id {
                children.entry(parent_id).or_default().push((
                    id,
                    sort_key,
                    normalized_display_title(&title),
                    is_protected,
                ));
            }
        }
        let mut groups = Vec::new();
        let mut pending = vec![node_id.to_string()];
        let mut visited = HashSet::new();
        while let Some(parent_id) = pending.pop() {
            if !visited.insert(parent_id.clone()) {
                return Err("The Notes tree contains a cycle and cannot be sorted.".to_string());
            }
            if let Some(siblings) = children.remove(&parent_id) {
                if siblings.iter().any(|(_, _, _, is_protected)| *is_protected) {
                    return Err(
                        "A read-only or plugin-managed Note subtree cannot be reordered."
                            .to_string(),
                    );
                }
                pending.extend(siblings.iter().map(|(id, _, _, _)| id.clone()));
                groups.push(siblings);
            }
        }
        let mut desired_order = Vec::new();
        for siblings in &mut groups {
            let original_ids = siblings
                .iter()
                .map(|(id, _, _, _)| id.clone())
                .collect::<Vec<_>>();
            siblings.sort_by(|left, right| match direction {
                SubtreeSortDirection::Ascending => left.2.cmp(&right.2),
                SubtreeSortDirection::Descending => right.2.cmp(&left.2),
            });
            if siblings
                .iter()
                .map(|(id, _, _, _)| id)
                .eq(original_ids.iter())
            {
                continue;
            }
            for (index, (id, current_sort_key, _, _)) in siblings.iter().enumerate() {
                let sort_key = i64::try_from(index + 1)
                    .ok()
                    .and_then(|position| position.checked_mul(SORT_KEY_STEP))
                    .ok_or_else(|| {
                        "The Notes sibling ordering is too large to sort.".to_string()
                    })?;
                if *current_sort_key == sort_key {
                    continue;
                }
                desired_order.push((id, sort_key));
            }
        }
        if !desired_order.is_empty() {
            let desired_order = serde_json::to_string(&desired_order)
                .map_err(|error| format!("Could not encode the Note subtree sort: {error}"))?;
            transaction
                .execute_batch(
                    "CREATE TEMP TABLE IF NOT EXISTS notes_subtree_desired_order (\
                       id TEXT PRIMARY KEY, sort_key INTEGER NOT NULL\
                     ) WITHOUT ROWID; \
                     DELETE FROM notes_subtree_desired_order;",
                )
                .map_err(|error| format!("Could not prepare the Note subtree order: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO notes_subtree_desired_order(id, sort_key) \
                     SELECT \
                       json_extract(value, '$[0]'), \
                       CAST(json_extract(value, '$[1]') AS INTEGER) \
                     FROM json_each(?1)",
                    [desired_order],
                )
                .map_err(|error| format!("Could not stage the Note subtree order: {error}"))?;
            transaction
                .execute(
                    "UPDATE notes_nodes AS node SET \
                       sort_key = (\
                         SELECT desired.sort_key FROM notes_subtree_desired_order desired \
                         WHERE desired.id = node.id\
                       ), \
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                     WHERE node.id IN (SELECT id FROM notes_subtree_desired_order) \
                       AND node.deleted_at IS NULL AND node.archived_at IS NULL \
                       AND node.sort_key <> (\
                         SELECT desired.sort_key FROM notes_subtree_desired_order desired \
                         WHERE desired.id = node.id\
                       )",
                    [],
                )
                .map_err(|error| format!("Could not sort Note siblings: {error}"))?;
            transaction
                .execute("DELETE FROM notes_subtree_desired_order", [])
                .map_err(|error| format!("Could not clear the Note subtree order: {error}"))?;
        }
        Ok(())
    })
}

pub(crate) fn sort_subtree_ascending(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    sort_subtree(connection, node_id, SubtreeSortDirection::Ascending)
}

pub(crate) fn sort_subtree_descending(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    sort_subtree(connection, node_id, SubtreeSortDirection::Descending)
}

pub(crate) fn toggle_star(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let node = require_active_node(transaction, node_id)?;
        require_provider_mutable(&node)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET is_starred = CASE is_starred WHEN 0 THEN 1 ELSE 0 END, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not toggle Note star: {error}"))?;
        Ok(())
    })
}

fn active_subtree(transaction: &Transaction<'_>, root_id: &str) -> Result<Vec<StoredNode>, String> {
    let query = "WITH RECURSIVE subtree(id) AS (\
       SELECT id FROM notes_nodes WHERE id = ?1 AND deleted_at IS NULL \
         AND archived_at IS NULL \
       UNION \
       SELECT child.id FROM notes_nodes child \
       JOIN subtree parent ON child.parent_id = parent.id \
       WHERE child.deleted_at IS NULL AND child.archived_at IS NULL\
     ) \
     SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
            is_starred, completed_at, deleted_at, deleted_batch_id, archived_at, \
            archive_root_id, node_kind, image_offset_utf16, marker_kind, \
            markdown_image_width, is_readonly, \
            plugin_state, plugin_meta \
     FROM notes_nodes WHERE id IN subtree";
    let mut statement = transaction
        .prepare(query)
        .map_err(|error| format!("Could not prepare the Note subtree: {error}"))?;
    let nodes = statement
        .query_map([root_id], stored_node_from_row)
        .map_err(|error| format!("Could not load the Note subtree: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the Note subtree: {error}"))?;

    let mut by_id = nodes
        .into_iter()
        .map(|node| (node.id.clone(), node))
        .collect::<HashMap<_, _>>();
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for node in by_id.values() {
        if node.id != root_id {
            if let Some(parent_id) = &node.parent_id {
                children
                    .entry(parent_id.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }
    }
    for child_ids in children.values_mut() {
        child_ids.sort_by(|left, right| {
            let left_node = &by_id[left];
            let right_node = &by_id[right];
            left_node
                .sort_key
                .cmp(&right_node.sort_key)
                .then_with(|| left.cmp(right))
        });
    }

    let mut visited = HashSet::new();
    let mut ordered = Vec::with_capacity(by_id.len());
    let mut stack = vec![root_id.to_string()];
    while let Some(node_id) = stack.pop() {
        if !visited.insert(node_id.clone()) {
            return Err("The Notes tree contains a cycle and cannot be duplicated.".to_string());
        }
        let node = by_id
            .remove(&node_id)
            .ok_or_else(|| format!("Note node {node_id} disappeared while duplicating."))?;
        if let Some(child_ids) = children.get(&node_id) {
            for child_id in child_ids.iter().rev() {
                stack.push(child_id.clone());
            }
        }
        ordered.push(node);
    }
    if !by_id.is_empty() {
        return Err("The Note subtree could not be assembled safely.".to_string());
    }
    Ok(ordered)
}

fn generate_uuid_v4(transaction: &Transaction<'_>) -> Result<String, String> {
    let id: String = transaction
        .query_row(
            "SELECT lower(\
               hex(randomblob(4)) || '-' || hex(randomblob(2)) || \
               '-4' || substr(hex(randomblob(2)), 2) || '-' || \
               substr('89ab', (random() & 3) + 1, 1) || \
               substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))\
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not generate a Note ID: {error}"))?;
    validate_note_id(&id)?;
    Ok(id)
}

fn fresh_uuid_v4(
    transaction: &Transaction<'_>,
    reserved: &HashSet<String>,
) -> Result<String, String> {
    for _ in 0..16 {
        let id = generate_uuid_v4(transaction)?;
        if !reserved.contains(&id) && !id_namespace_in_use(transaction, &id)? {
            return Ok(id);
        }
    }
    Err("Could not generate a unique Note ID.".to_string())
}

fn fresh_attachment_id(
    transaction: &Transaction<'_>,
    reserved: &HashSet<String>,
) -> Result<String, String> {
    for _ in 0..16 {
        let id = generate_uuid_v4(transaction)?;
        if !reserved.contains(&id) && !id_namespace_in_use(transaction, &id)? {
            return Ok(id);
        }
    }
    Err("Could not generate a unique Notes attachment ID.".to_string())
}

#[cfg(test)]
pub(crate) fn duplicate_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    duplicate_node_at(connection, node_id, today)
}

pub(crate) fn duplicate_node_at(
    connection: &mut Connection,
    node_id: &str,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    let submitted_ids = vec![node_id.to_string()];
    with_workspace_transaction(connection, |transaction| {
        let copied_root_ids = duplicate_forest_in_transaction(transaction, &submitted_ids, today)?;
        if copied_root_ids.len() != 1 {
            return Err("Could not identify the duplicated Note root.".to_string());
        }
        Ok(())
    })
}

/// Copies normalized active selection roots inside the caller's transaction.
/// All validation, source loading, and attachment-capacity checks happen before
/// the first write (including a possible sort-key rebalance). Returned ids are
/// copied roots in authoritative stored sibling order.
fn duplicate_forest_in_transaction(
    transaction: &Transaction<'_>,
    submitted_ids: &[NoteId],
    today: LocalDate,
) -> Result<Vec<NoteId>, String> {
    let node_ids = dedup_preserving_order(submitted_ids);
    if node_ids.is_empty() {
        return Err("A duplicate operation requires at least one node.".to_string());
    }
    for node_id in &node_ids {
        validate_note_id(node_id)?;
        require_active_node(transaction, node_id)?;
    }

    let selected: BTreeSet<&str> = node_ids.iter().map(String::as_str).collect();
    let normalized_roots = selection_roots(transaction, &node_ids, &selected)?;
    let first_root = normalized_roots
        .first()
        .ok_or_else(|| "Could not identify any active duplicate roots.".to_string())?;
    let common_parent_id = require_active_node(transaction, first_root)?.parent_id;
    ensure_generic_parent_allowed(common_parent_id.as_deref())?;
    for root_id in &normalized_roots[1..] {
        if require_active_node(transaction, root_id)?.parent_id != common_parent_id {
            return Err("Batch duplicate roots must share the same parent.".to_string());
        }
    }

    let root_set = normalized_roots
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let ordered_root_ids = sibling_keys(transaction, common_parent_id.as_deref(), None)?
        .into_iter()
        .filter_map(|(node_id, _)| root_set.contains(node_id.as_str()).then_some(node_id))
        .collect::<Vec<_>>();
    if ordered_root_ids.len() != normalized_roots.len() {
        return Err("Could not order every active duplicate root.".to_string());
    }

    let mut forests = Vec::with_capacity(ordered_root_ids.len());
    let mut original_ids = HashSet::new();
    let mut attachment_copy_count = 0_i64;
    for root_id in &ordered_root_ids {
        let mut forest = Vec::new();
        for original in active_subtree(transaction, root_id)? {
            if plugin_owned(&original) {
                return Err("A plugin-managed Note subtree cannot be duplicated.".to_string());
            }
            if !original_ids.insert(original.id.clone()) {
                return Err("Duplicate source subtrees must not overlap.".to_string());
            }
            let attachments = node_attachments(transaction, &original.id)?;
            let attachment_count = i64::try_from(attachments.len())
                .map_err(|_| "Could not measure duplicated Notes attachments.".to_string())?;
            if attachment_count > MAX_NOTE_ATTACHMENTS_PER_NODE {
                return Err(format!(
                    "A Note node can contain at most {MAX_NOTE_ATTACHMENTS_PER_NODE} attachments."
                ));
            }
            attachment_copy_count = attachment_copy_count
                .checked_add(attachment_count)
                .ok_or_else(|| "Could not measure duplicated Notes attachments.".to_string())?;
            forest.push((original, attachments));
        }
        forests.push(forest);
    }

    if attachment_copy_count > 0 {
        let vault_attachment_count: i64 = transaction
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .map_err(|error| {
                format!("Could not inspect duplicated Notes attachment capacity: {error}")
            })?;
        if vault_attachment_count
            .checked_add(attachment_copy_count)
            .map_or(true, |count| count > MAX_NOTE_ATTACHMENTS_PER_VAULT)
        {
            return Err(format!(
                "A Notes vault can contain at most {MAX_NOTE_ATTACHMENTS_PER_VAULT} attachments."
            ));
        }
    }

    let mut reserved = HashSet::new();
    let mut copied_ids = HashMap::with_capacity(original_ids.len());
    for forest in &forests {
        for (original, _) in forest {
            let copied_id = fresh_uuid_v4(transaction, &reserved)?;
            reserved.insert(copied_id.clone());
            copied_ids.insert(original.id.clone(), copied_id);
        }
    }
    let mut copied_attachment_ids = HashMap::new();
    for forest in &forests {
        for (_, attachments) in forest {
            for source in attachments {
                let copied_id = fresh_attachment_id(transaction, &reserved)?;
                reserved.insert(copied_id.clone());
                copied_attachment_ids.insert(source.id.clone(), copied_id);
            }
        }
    }

    let mut copied_root_ids = Vec::with_capacity(forests.len());
    let mut previous_root_id = ordered_root_ids.last().cloned();
    for forest in &forests {
        let (source_root, _) = forest
            .first()
            .ok_or_else(|| "Could not load a duplicate source subtree.".to_string())?;
        let root_sort_key = next_sort_key(
            transaction,
            common_parent_id.as_deref(),
            previous_root_id.as_deref(),
        )?;
        let copied_root_id = copied_ids
            .get(&source_root.id)
            .expect("every duplicated root has a generated ID")
            .clone();

        for (original, _) in forest {
            let copied_id = copied_ids
                .get(&original.id)
                .expect("every duplicated node has a generated ID");
            let copied_parent_id = if original.id == source_root.id {
                common_parent_id.as_deref()
            } else {
                original
                    .parent_id
                    .as_ref()
                    .and_then(|parent_id| copied_ids.get(parent_id))
                    .map(String::as_str)
            };
            let sort_key = if original.id == source_root.id {
                root_sort_key
            } else {
                original.sort_key
            };
            let plugin_state = original
                .plugin_state
                .as_ref()
                .map(|state| serde_json::to_string(&state.collapsed_groups))
                .transpose()
                .map_err(|error| format!("Could not encode duplicated plugin state: {error}"))?;
            let plugin_meta = original
                .plugin_meta
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| format!("Could not encode duplicated plugin metadata: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO notes_nodes (\
                       id, parent_id, sort_key, title, note, image_offset_utf16, markdown_image_width, layout_mode, is_collapsed, \
                       is_starred, completed_at, node_kind, marker_kind, is_readonly, plugin_state, plugin_meta, created_at, updated_at\
                     ) VALUES (\
                       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, \
                       ?14, ?15, ?16, \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                     )",
                    params![
                        copied_id,
                        copied_parent_id,
                        sort_key,
                        original.title,
                        original.note,
                        original.image_offset_utf16,
                        original.markdown_image_width,
                        original.layout_mode,
                        original.is_collapsed,
                        original.is_starred,
                        original.completed_at,
                        original.node_kind.as_str(),
                        original.marker_kind.as_str(),
                        original.is_readonly.map(i64::from),
                        plugin_state,
                        plugin_meta,
                    ],
                )
                .map_err(|error| format!("Could not duplicate the Note subtree: {error}"))?;
            replace_derived_content(
                transaction,
                copied_id,
                original.node_kind,
                &original.title,
                original.image_offset_utf16,
                &original.note,
                today,
            )?;
        }

        copied_root_ids.push(copied_root_id.clone());
        previous_root_id = Some(copied_root_id);
    }

    // Attachments are content-addressed. Copies get fresh metadata ids while
    // retaining the source path/hash, so no file bytes are copied or published.
    for forest in forests {
        for (original, attachments) in forest {
            let copied_node_id = copied_ids
                .get(&original.id)
                .expect("every duplicated node has a generated ID")
                .clone();
            for source in attachments {
                let attachment_id = copied_attachment_ids
                    .remove(&source.id)
                    .expect("every duplicated attachment has a generated ID");
                let sort_key = source.sort_key;
                insert_new_attachment_at_sort_key(
                    transaction,
                    NewAttachment {
                        id: attachment_id,
                        node_id: copied_node_id.clone(),
                        relative_path: source.relative_path,
                        content_hash: source.content_hash,
                        original_name: source.original_name,
                        mime_type: source.mime_type,
                        byte_size: source.byte_size,
                        intrinsic_width: source.intrinsic_width,
                        intrinsic_height: source.intrinsic_height,
                        display_width: source.display_width,
                    },
                    sort_key,
                )?;
            }
        }
    }

    Ok(copied_root_ids)
}

// ---- Paste import (nested subtree) -------------------------------------------
//
// `import_subtree_at` inserts a caller-supplied forest of *new* nodes as one
// contiguous block under `parentId`, right after `afterId`. It mirrors
// `duplicate_node_at`'s discipline: one `with_workspace_transaction` (so a
// history context records exactly ONE entry and a single undo removes every
// imported node), backend-generated ids (the store stays authoritative), and
// sparse sort keys. Any failure rolls the whole transaction back — nothing is
// inserted and no history entry is written.
//
// Ids are never taken from the client. The forest is inserted iteratively (an
// explicit work stack, never recursion) so a deep payload cannot overflow the
// stack; the depth/size/field bounds are enforced in `ImportSubtreeInput::
// validate`. The generated root ids are returned in caller order so the command
// can surface them to the frontend for focus.
fn insert_import_node(
    transaction: &Transaction<'_>,
    id: &str,
    parent_id: Option<&str>,
    sort_key: i64,
    node: &ImportNode,
    today: LocalDate,
) -> Result<(), String> {
    let note = node.note.as_deref().unwrap_or("");
    transaction
        .execute(
            "INSERT INTO notes_nodes (\
               id, parent_id, sort_key, title, note, node_kind, marker_kind, created_at, updated_at\
             ) VALUES (\
               ?1, ?2, ?3, ?4, ?5, 'text', ?6, \
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
             )",
            params![
                id,
                parent_id,
                sort_key,
                node.title,
                note,
                node.marker_kind.as_str()
            ],
        )
        .map_err(|error| format!("Could not create an imported Note node: {error}"))?;
    replace_derived_content(
        transaction,
        id,
        NoteNodeKind::Text,
        &node.title,
        0,
        note,
        today,
    )
}

fn reserve_import_append_sort_block(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    count: usize,
) -> Result<Vec<i64>, String> {
    let maximum = transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_key), 0) FROM notes_nodes \
             WHERE parent_id IS ?1 AND deleted_at IS NULL AND archived_at IS NULL",
            [parent_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Could not inspect imported Note ordering: {error}"))?;
    if let Some(keys) = checked_github_sort_block(maximum, count) {
        return Ok(keys);
    }
    rebalance_siblings(transaction, parent_id, None)?;
    let rebalanced_maximum = transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_key), 0) FROM notes_nodes \
             WHERE parent_id IS ?1 AND deleted_at IS NULL AND archived_at IS NULL",
            [parent_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Could not inspect rebalanced imported Note ordering: {error}"))?;
    checked_github_sort_block(rebalanced_maximum, count).ok_or_else(|| {
        "Could not allocate a sparse imported Note sort block after rebalancing.".to_string()
    })
}

fn insert_import_forest(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    nodes: &[ImportNode],
    today: LocalDate,
) -> Result<Vec<NoteId>, String> {
    let mut imported_root_ids: Vec<NoteId> = Vec::with_capacity(nodes.len());
    // Reserving generated ids guards against the (astronomically unlikely)
    // case of drawing the same UUID twice before it is queryable, matching
    // `duplicate_node_at`.
    let mut reserved: HashSet<String> = HashSet::new();
    // Each root is placed right after the previous imported root (the first
    // after `afterId`), so `next_sort_key` keeps the whole block contiguous
    // between `afterId` and its former next sibling under `parentId`.
    let mut previous_root = after_id.map(str::to_string);
    let append_sort_keys = if after_id.is_none() {
        Some(reserve_import_append_sort_block(
            transaction,
            parent_id,
            nodes.len(),
        )?)
    } else {
        None
    };

    for (root_index, root) in nodes.iter().enumerate() {
        let root_id = fresh_uuid_v4(transaction, &reserved)?;
        reserved.insert(root_id.clone());
        let root_sort_key = match &append_sort_keys {
            Some(keys) => keys[root_index],
            None => next_sort_key(transaction, parent_id, previous_root.as_deref())?,
        };
        insert_import_node(transaction, &root_id, parent_id, root_sort_key, root, today)?;

        // Insert descendants iteratively. Each freshly-created parent starts
        // empty, so children get sparse sort keys by their position — no
        // existing siblings to reconcile against.
        let mut stack: Vec<(String, &Vec<ImportNode>)> = vec![(root_id.clone(), &root.children)];
        while let Some((nested_parent_id, children)) = stack.pop() {
            for (index, child) in children.iter().enumerate() {
                let child_id = fresh_uuid_v4(transaction, &reserved)?;
                reserved.insert(child_id.clone());
                let child_sort_key = i64::try_from(index + 1)
                    .ok()
                    .and_then(|position| position.checked_mul(SORT_KEY_STEP))
                    .ok_or_else(|| {
                        "The imported subtree has too many siblings to order.".to_string()
                    })?;
                insert_import_node(
                    transaction,
                    &child_id,
                    Some(&nested_parent_id),
                    child_sort_key,
                    child,
                    today,
                )?;
                if !child.children.is_empty() {
                    stack.push((child_id, &child.children));
                }
            }
        }

        imported_root_ids.push(root_id.clone());
        previous_root = Some(root_id);
    }
    Ok(imported_root_ids)
}

pub(crate) fn import_subtree_at(
    connection: &mut Connection,
    input: ImportSubtreeInput,
    today: LocalDate,
) -> Result<(NotesWorkspace, Vec<NoteId>), String> {
    input.validate()?;
    let mut imported_root_ids = Vec::new();
    let workspace = with_workspace_transaction(connection, |transaction| {
        ensure_live_parent(transaction, input.parent_id.as_deref())?;
        imported_root_ids = insert_import_forest(
            transaction,
            input.parent_id.as_deref(),
            input.after_id.as_deref(),
            &input.nodes,
            today,
        )?;
        Ok(())
    })?;
    Ok((workspace, imported_root_ids))
}

pub(crate) fn remove_empty_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_active_node(transaction, node_id)?;
        require_provider_mutable(&source)?;
        require_content_mutable(&source)?;
        ensure_generic_parent_allowed(source.parent_id.as_deref())?;
        if !readonly_descendants(transaction, &[node_id.to_string()])?.is_empty() {
            return Err(
                "Deleting a Note subtree containing readonly nodes requires explicit confirmation."
                    .to_string(),
            );
        }
        let has_attachments: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notes_attachments WHERE node_id = ?1)",
                [node_id],
                |row| row.get(0),
            )
            .map_err(|error| {
                format!("Could not inspect attachments on the empty Note node: {error}")
            })?;
        if !source.title.trim().is_empty() || !source.note.trim().is_empty() || has_attachments {
            return Err("Only an empty Note node can be removed.".to_string());
        }
        let children = sibling_keys(transaction, Some(node_id), None)?;
        if !children.is_empty() {
            let siblings = sibling_keys(transaction, source.parent_id.as_deref(), None)?;
            let mut desired_order = Vec::with_capacity(siblings.len() - 1 + children.len());
            for (sibling_id, _) in siblings {
                if sibling_id == node_id {
                    desired_order.extend(children.iter().map(|(child_id, _)| child_id.clone()));
                } else {
                    desired_order.push(sibling_id);
                }
            }
            for (index, sibling_id) in desired_order.iter().enumerate() {
                let sort_key = i64::try_from(index + 1)
                    .ok()
                    .and_then(|position| position.checked_mul(SORT_KEY_STEP))
                    .ok_or_else(|| {
                        "The Notes sibling ordering is too large to rewrite.".to_string()
                    })?;
                transaction
                    .execute(
                        "UPDATE notes_nodes SET parent_id = ?1, sort_key = ?2, \
                            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                         WHERE id = ?3 AND deleted_at IS NULL AND archived_at IS NULL",
                        params![source.parent_id, sort_key, sibling_id],
                    )
                    .map_err(|error| {
                        format!("Could not reparent children of the empty Note node: {error}")
                    })?;
            }
        }
        let deletion_batch_id = fresh_deletion_batch_id(transaction)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET \
                   deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   deleted_batch_id = ?2, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                params![node_id, deletion_batch_id],
            )
            .map_err(|error| format!("Could not remove the empty Note node: {error}"))?;
        Ok(())
    })
}

fn fresh_deletion_batch_id(transaction: &Transaction<'_>) -> Result<String, String> {
    let batch_id: String = transaction
        .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
        .map_err(|error| format!("Could not create a Notes deletion batch: {error}"))?;
    validate_deleted_batch_id(&batch_id)
        .map_err(|error| format!("Could not create a Notes deletion batch: {error}"))?;
    Ok(batch_id)
}

fn validate_deleted_batch_id(value: &str) -> Result<(), String> {
    if value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err("Notes deletion batch IDs must be 32 lowercase hexadecimal characters.".to_string())
    }
}

pub(crate) fn archive_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_active_node(transaction, node_id)?;
        require_provider_mutable(&source)?;
        if source.parent_id.is_some() {
            return Err("Only a root Note node can be archived.".to_string());
        }
        transaction
            .execute(
                "WITH RECURSIVE \
                 archive_context(archived_at) AS (\
                   SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 ), \
                 subtree(id) AS (\
                   SELECT id FROM notes_nodes \
                   WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL \
                   UNION ALL \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id \
                   WHERE child.deleted_at IS NULL AND child.archived_at IS NULL\
                 ) \
                 UPDATE notes_nodes SET \
                   archived_at = (SELECT archived_at FROM archive_context), \
                   archive_root_id = ?1, \
                   updated_at = (SELECT archived_at FROM archive_context) \
                 WHERE id IN subtree",
                [node_id],
            )
            .map_err(|error| format!("Could not archive the Note subtree: {error}"))?;
        Ok(())
    })
}

pub(crate) fn unarchive_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = node_by_id(transaction, node_id)?
            .ok_or_else(|| format!("Note node {node_id} does not exist."))?;
        require_provider_mutable(&source)?;
        if source.deleted_at.is_some() {
            return Err(format!("Note node {node_id} is in the trash."));
        }
        if source.archived_at.is_none() {
            return Err(format!("Note node {node_id} is not archived."));
        }
        if source.parent_id.is_some() || source.archive_root_id.as_deref() != Some(node_id) {
            return Err("Only an archive root can be unarchived.".to_string());
        }

        resolve_restore_sort_collision(transaction, &source)?;
        let changed = transaction
            .execute(
                "UPDATE notes_nodes SET archived_at = NULL, archive_root_id = NULL, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE archive_root_id = ?1 AND deleted_at IS NULL",
                [node_id],
            )
            .map_err(|error| format!("Could not unarchive the Note subtree: {error}"))?;
        if changed == 0 {
            return Err(format!("Archive root {node_id} owns no live Note nodes."));
        }
        Ok(())
    })
}

pub(crate) fn soft_delete_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_live_node(transaction, node_id)?;
        require_content_mutable(&source)?;
        let readonly = readonly_descendants(transaction, &[node_id.to_string()])?;
        if !readonly.is_empty() {
            return Err(
                "Deleting a Note subtree containing readonly nodes requires explicit confirmation."
                    .to_string(),
            );
        }
        if source.archived_at.is_some()
            && (source.parent_id.is_some() || source.archive_root_id.as_deref() != Some(node_id))
        {
            return Err("Only an archive root can be moved to trash.".to_string());
        }
        let deletion_batch_id = fresh_deletion_batch_id(transaction)?;
        transaction
            .execute(
                "WITH RECURSIVE subtree(id) AS (\
                   SELECT id FROM notes_nodes \
                   WHERE id = ?1 AND deleted_at IS NULL AND archive_root_id IS ?3 \
                   UNION ALL \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id \
                   WHERE child.deleted_at IS NULL AND child.archive_root_id IS ?3\
                 ) \
                 UPDATE notes_nodes SET \
                   deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   deleted_batch_id = ?2, \
                   archived_at = NULL, \
                   archive_root_id = NULL, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id IN subtree",
                params![node_id, deletion_batch_id, source.archive_root_id],
            )
            .map_err(|error| format!("Could not move the Note subtree to trash: {error}"))?;
        Ok(())
    })
}

fn resolve_restore_sort_collision(
    transaction: &Transaction<'_>,
    source: &StoredNode,
) -> Result<(), String> {
    let siblings = sibling_keys(transaction, source.parent_id.as_deref(), None)?;
    if !siblings
        .iter()
        .any(|(_, sort_key)| *sort_key == source.sort_key)
    {
        return Ok(());
    }

    let insert_at = siblings
        .iter()
        .position(|(_, sort_key)| *sort_key >= source.sort_key)
        .unwrap_or(siblings.len());
    let mut ordered_ids = siblings
        .into_iter()
        .map(|(node_id, _)| node_id)
        .collect::<Vec<_>>();
    ordered_ids.insert(insert_at, source.id.clone());
    for (index, node_id) in ordered_ids.iter().enumerate() {
        let sort_key = i64::try_from(index + 1)
            .ok()
            .and_then(|position| position.checked_mul(SORT_KEY_STEP))
            .ok_or_else(|| "The Notes sibling ordering is too large to restore.".to_string())?;
        transaction
            .execute(
                "UPDATE notes_nodes SET sort_key = ?1, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?2",
                params![sort_key, node_id],
            )
            .map_err(|error| format!("Could not reorder restored Note siblings: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn restore_node(
    connection: &mut Connection,
    node_id: &str,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    restore_node_at(connection, node_id, today)
}

pub(crate) fn restore_node_at(
    connection: &mut Connection,
    node_id: &str,
    today: LocalDate,
) -> Result<NotesWorkspace, String> {
    validate_note_id(node_id)?;
    with_workspace_transaction(connection, |transaction| {
        let source = require_deleted_node(transaction, node_id)?;
        require_provider_mutable(&source)?;
        let deletion_batch_id = source
            .deleted_batch_id
            .as_deref()
            .ok_or_else(|| format!("Deleted Note node {node_id} has no deletion batch."))?;
        let parent_is_live = match source.parent_id.as_deref() {
            Some(parent_id) => node_by_id(transaction, parent_id)?
                .is_some_and(|parent| parent.deleted_at.is_none() && parent.archived_at.is_none()),
            None => true,
        };
        if !parent_is_live {
            // R4: a topic root is always Text (spec §4.3). Restoring an image
            // whose parent is gone must not promote it to a root; place it under
            // the recovery topic instead so the restore still succeeds. Text
            // orphans keep the original behavior (promotion to a top-level root).
            let (new_parent, sort_key) = if source.node_kind == NoteNodeKind::Image {
                let recovery_id = crate::notes::sync::merger::ensure_recovery_topic(transaction)
                    .map_err(|error| error.to_string())?;
                let sort_key = next_sort_key(transaction, Some(&recovery_id), None)?;
                (Some(recovery_id), sort_key)
            } else {
                (None, next_sort_key(transaction, None, None)?)
            };
            transaction
                .execute(
                    "UPDATE notes_nodes SET parent_id = ?1, sort_key = ?2 \
                     WHERE id = ?3 AND deleted_at IS NOT NULL",
                    params![new_parent, sort_key, node_id],
                )
                .map_err(|error| {
                    format!("Could not restore the Note subtree at the root: {error}")
                })?;
        } else {
            resolve_restore_sort_collision(transaction, &source)?;
        }
        transaction
            .execute(
                "WITH RECURSIVE subtree(id) AS (\
                   SELECT id FROM notes_nodes WHERE id = ?1 AND deleted_batch_id = ?2 \
                   UNION ALL \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id \
                   WHERE child.deleted_batch_id = ?2\
                 ) \
                 UPDATE notes_nodes SET deleted_at = NULL, deleted_batch_id = NULL, \
                   archived_at = NULL, archive_root_id = NULL, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id IN subtree AND deleted_batch_id = ?2",
                params![node_id, deletion_batch_id],
            )
            .map_err(|error| format!("Could not restore the Note subtree: {error}"))?;
        let restored_node_ids = active_subtree(transaction, node_id)?
            .into_iter()
            .map(|node| node.id)
            .collect::<BTreeSet<_>>();
        rebuild_derived_for_nodes_at(transaction, &restored_node_ids, today)?;
        Ok(())
    })
}

// ---- Batch (multi-select) operations -----------------------------------------
//
// `apply_batch_at` applies ONE operation to a SET of selected nodes.
// Everything runs inside a single `with_workspace_transaction`, so when a
// history context is active `finalize_transaction` records exactly ONE history
// entry from the audit rows every mutation in the batch accumulates — the whole
// batch is one all-or-nothing undo step. If any node or op is invalid the
// closure returns `Err`, the transaction is rolled back, and the vault is left
// untouched (no history entry, no partial changes). This mirrors the atomic
// multi-image ingest's transaction+history discipline.

#[cfg(test)]
pub(crate) fn apply_batch(
    connection: &mut Connection,
    input: ApplyBatchInput,
) -> Result<NotesWorkspace, String> {
    let today = SystemLocalTodayProvider.local_today(connection)?;
    apply_batch_at(connection, input, today).map(|(workspace, _)| workspace)
}

pub(crate) fn apply_batch_at(
    connection: &mut Connection,
    input: ApplyBatchInput,
    today: LocalDate,
) -> Result<(NotesWorkspace, Option<Vec<NoteId>>), String> {
    input.validate()?;
    let node_ids = dedup_preserving_order(&input.node_ids);
    let mut duplicated_root_ids = None;
    let workspace = with_workspace_transaction(connection, |transaction| match &input.op {
        BatchOp::Complete { completed } => batch_set_completed(transaction, &node_ids, *completed),
        BatchOp::Delete => batch_soft_delete(transaction, &node_ids),
        BatchOp::Move {
            parent_id,
            after_id,
            before_id,
        } => batch_move(
            transaction,
            &node_ids,
            parent_id.as_deref(),
            after_id.as_deref(),
            before_id.as_deref(),
        ),
        BatchOp::Indent => batch_indent(transaction, &node_ids),
        BatchOp::Outdent => batch_outdent(transaction, &node_ids),
        BatchOp::Duplicate => {
            duplicated_root_ids = Some(duplicate_forest_in_transaction(
                transaction,
                &node_ids,
                today,
            )?);
            Ok(())
        }
        BatchOp::AddTag { tag } => batch_add_tag(transaction, &node_ids, tag, today),
        BatchOp::RemoveTag { tag } => batch_remove_tag(transaction, &node_ids, tag, today),
    })?;
    Ok((workspace, duplicated_root_ids))
}

fn dedup_preserving_order(ids: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut result = Vec::with_capacity(ids.len());
    for id in ids {
        if seen.insert(id.as_str()) {
            result.push(id.clone());
        }
    }
    result
}

fn apply_batch_content_updates(
    transaction: &Transaction<'_>,
    updates: Vec<(NoteId, String, String, NoteNodeKind, i64)>,
    today: LocalDate,
) -> Result<(), String> {
    for (node_id, title, note, node_kind, image_offset_utf16) in updates {
        let node = require_active_node(transaction, &node_id)?;
        require_content_mutable(&node)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET title = ?1, note = ?2, image_offset_utf16 = ?3, \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?4 AND deleted_at IS NULL AND archived_at IS NULL",
                params![title, note, image_offset_utf16, node_id],
            )
            .map_err(|error| format!("Could not update Note content in batch: {error}"))?;
        replace_derived_content(
            transaction,
            &node_id,
            node_kind,
            &title,
            image_offset_utf16,
            &note,
            today,
        )?;
    }
    Ok(())
}

fn batch_add_tag(
    transaction: &Transaction<'_>,
    node_ids: &[NoteId],
    tag: &NoteSearchTag,
    today: LocalDate,
) -> Result<(), String> {
    let mut updates = Vec::new();
    for node_id in node_ids {
        let node = require_active_node(transaction, node_id)?;
        require_content_mutable(&node)?;
        if node.node_kind == NoteNodeKind::Image {
            let identity = BTreeSet::from([(tag.prefix, tag.normalized_tag.clone())]);
            let contains_tag = primary_title_contains_tag(
                node.node_kind,
                &node.title,
                node.image_offset_utf16,
                &identity,
            )? || tokenize_note_text(&node.note)
                .into_iter()
                .any(|token| token.prefix == tag.prefix && token.normalized == tag.normalized_tag);
            if !contains_tag {
                let (before, after) = image_primary_segments(&node.title, node.image_offset_utf16)?;
                let after = add_exact_tag_to_title(after, "", tag)?.expect(
                    "a tag absent from every image segment must append to the after segment",
                );
                updates.push((
                    node.id,
                    format!("{before}{after}"),
                    node.note,
                    node.node_kind,
                    node.image_offset_utf16,
                ));
            }
        } else if let Some(title) = add_exact_tag_to_title(&node.title, &node.note, tag)? {
            updates.push((node.id, title, node.note, node.node_kind, 0));
        }
    }
    apply_batch_content_updates(transaction, updates, today)
}

fn batch_remove_tag(
    transaction: &Transaction<'_>,
    node_ids: &[NoteId],
    tag: &NoteTagFilter,
    today: LocalDate,
) -> Result<(), String> {
    let mut updates = Vec::new();
    for node_id in node_ids {
        let node = require_active_node(transaction, node_id)?;
        require_content_mutable(&node)?;
        if node.node_kind == NoteNodeKind::Image {
            let (before, after) = image_primary_segments(&node.title, node.image_offset_utf16)?;
            let before = remove_exact_tag_tokens(before, tag).unwrap_or_else(|| before.to_string());
            let after = remove_exact_tag_tokens(after, tag).unwrap_or_else(|| after.to_string());
            let note =
                remove_exact_tag_tokens(&node.note, tag).unwrap_or_else(|| node.note.clone());
            let image_offset_utf16 = i64::try_from(before.encode_utf16().count())
                .map_err(|_| "A Notes image offset is too large.".to_string())?;
            let title = format!("{before}{after}");
            if title != node.title || note != node.note {
                updates.push((node.id, title, note, node.node_kind, image_offset_utf16));
            }
        } else {
            let title = remove_exact_tag_tokens(&node.title, tag);
            let note = remove_exact_tag_tokens(&node.note, tag);
            if title.is_some() || note.is_some() {
                updates.push((
                    node.id,
                    title.unwrap_or(node.title),
                    note.unwrap_or(node.note),
                    node.node_kind,
                    0,
                ));
            }
        }
    }
    apply_batch_content_updates(transaction, updates, today)
}

/// Sets the completion state of every selected node to `completed`. Validation
/// and mutation are interleaved: each node is required active immediately before
/// it is updated, so a later invalid node rolls back the completions already
/// applied to earlier nodes in the same transaction (all-or-nothing). Nodes
/// already in the target state are skipped so no spurious history rows appear.
fn batch_set_completed(
    transaction: &Transaction<'_>,
    node_ids: &[String],
    completed: bool,
) -> Result<(), String> {
    let statement = if completed {
        "UPDATE notes_nodes SET \
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1 AND completed_at IS NULL \
           AND deleted_at IS NULL AND archived_at IS NULL"
    } else {
        "UPDATE notes_nodes SET \
           completed_at = NULL, \
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE id = ?1 AND completed_at IS NOT NULL \
           AND deleted_at IS NULL AND archived_at IS NULL"
    };
    for node_id in node_ids {
        let node = require_active_node(transaction, node_id)?;
        require_provider_mutable(&node)?;
        transaction
            .execute(statement, [node_id])
            .map_err(|error| format!("Could not set Note completion in batch: {error}"))?;
    }
    Ok(())
}

/// Soft-deletes every selected node as ONE trash batch: they all receive the
/// same fresh `deleted_batch_id`, so the trash view groups them and a single
/// undo restores the whole batch. Every selected node is required live up
/// front (a snapshot before any mutation); archived selections must be archive
/// roots. Nested selections are normalized before mutation, so once an
/// ancestor's subtree is trashed there is no descendant re-query to fail.
fn batch_soft_delete(transaction: &Transaction<'_>, node_ids: &[String]) -> Result<(), String> {
    validate_delete_authority(transaction, node_ids)?;
    let roots = normalize_delete_roots(transaction, node_ids)?;
    let normalized_input = DeleteNodesInput {
        node_ids: roots.clone(),
        expected_readonly_descendant_ids: None,
    };
    validate_delete_targets(transaction, &normalized_input)?;
    if !readonly_descendants(transaction, &roots)?.is_empty() {
        return Err(
            "Deleting a Note tree with read-only descendants requires explicit confirmation."
                .to_string(),
        );
    }
    batch_soft_delete_unchecked(transaction, &roots)
}

/// Loads the union of every submitted node's parent chain with a bounded number
/// of recursive SQL queries. `UNION` (rather than `UNION ALL`) guarantees that a
/// corrupt cycle reaches a fixed point; the in-memory walk below remains the
/// authority that reports the cycle using the existing error contract.
fn load_ancestor_parent_map(
    transaction: &Transaction<'_>,
    node_ids: &[String],
) -> Result<HashMap<String, Option<String>>, String> {
    let mut parents = HashMap::new();
    for chunk in node_ids.chunks(ANCESTOR_CLOSURE_CHUNK_SIZE) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders = (1..=chunk.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "WITH RECURSIVE ancestors(id, parent_id) AS (\
               SELECT id, parent_id FROM notes_nodes WHERE id IN ({placeholders}) \
               UNION \
               SELECT parent.id, parent.parent_id FROM notes_nodes parent \
               JOIN ancestors child ON parent.id = child.parent_id\
             ) \
             SELECT id, parent_id FROM ancestors"
        );
        let mut statement = transaction.prepare(&sql).map_err(|error| {
            format!("Could not prepare the Notes batch ancestor closure: {error}")
        })?;
        #[cfg(test)]
        ANCESTOR_CLOSURE_QUERY_COUNT.with(|count| count.set(count.get() + 1));
        let rows = statement
            .query_map(params_from_iter(chunk.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|error| format!("Could not load the Notes batch ancestor closure: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not read the Notes batch ancestor closure: {error}"))?;
        parents.extend(rows);
    }
    Ok(parents)
}

/// Returns whether any ancestor of `node_id` is itself selected. Successful
/// paths are memoized as "this node or an ancestor is selected", so shared deep
/// ancestry is traversed once in memory rather than once per submitted row.
fn has_selected_ancestor_in_map(
    node_id: &str,
    parents: &HashMap<String, Option<String>>,
    selected: &BTreeSet<&str>,
    contains_selected_memo: &mut HashMap<String, bool>,
) -> Result<bool, String> {
    let Some(mut current_id) = parents.get(node_id).and_then(Clone::clone) else {
        return Ok(false);
    };
    let mut path = Vec::new();
    let mut path_ids = HashSet::from([node_id.to_string()]);
    let mut contains_selected = loop {
        if let Some(cached) = contains_selected_memo.get(&current_id) {
            break *cached;
        }
        if !path_ids.insert(current_id.clone()) {
            return Err(
                "The Notes tree contains a cycle and cannot be changed in a batch.".to_string(),
            );
        }
        path.push(current_id.clone());
        let Some(parent_id) = parents.get(&current_id).and_then(Clone::clone) else {
            break false;
        };
        current_id = parent_id;
    };
    for ancestor_id in path.into_iter().rev() {
        contains_selected = selected.contains(ancestor_id.as_str()) || contains_selected;
        contains_selected_memo.insert(ancestor_id, contains_selected);
    }
    Ok(contains_selected)
}

fn selection_roots(
    transaction: &Transaction<'_>,
    node_ids: &[String],
    selected: &BTreeSet<&str>,
) -> Result<Vec<String>, String> {
    let parents = load_ancestor_parent_map(transaction, node_ids)?;
    let mut contains_selected_memo = HashMap::new();
    let mut roots = Vec::new();
    for node_id in node_ids {
        if !has_selected_ancestor_in_map(node_id, &parents, selected, &mut contains_selected_memo)?
        {
            roots.push(node_id.clone());
        }
    }
    Ok(roots)
}

/// Moves a single node within the current transaction. A thin wrapper over
/// `next_sort_key_excluding` used to place batch-moved nodes one after another.
fn move_node_within_transaction(
    transaction: &Transaction<'_>,
    node_id: &str,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    before_id: Option<&str>,
) -> Result<(), String> {
    require_subtree_movable(transaction, node_id)?;
    if node_id == GITHUB_NOTIFICATIONS_ROOT_ID && parent_id.is_some() {
        return Err(
            "The Github Notifications root can only be reordered at the top level.".to_string(),
        );
    }
    // R4: a topic root is always Text (spec §4.3); refuse to promote an image
    // node to a root through batch outdent/move, matching move_node's guard.
    if parent_id.is_none() {
        let node = require_active_node(transaction, node_id)?;
        if node.node_kind == NoteNodeKind::Image {
            return Err("An image Note cannot become a topic root.".to_string());
        }
    }
    // R5: the shared reparent path for batch move/indent/outdent — the
    // subtree-height-aware depth guard lives here so batch_indent no longer
    // bypasses it and a tall subtree cannot breach the depth cap.
    ensure_reparent_target(transaction, node_id, parent_id)?;
    let sort_key =
        next_sort_key_excluding(transaction, parent_id, after_id, before_id, Some(node_id))?;
    mark_former_topic_dirty_for_move(transaction, node_id, parent_id)?;
    transaction
        .execute(
            "UPDATE notes_nodes SET parent_id = ?1, sort_key = ?2, \
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
             WHERE id = ?3 AND deleted_at IS NULL AND archived_at IS NULL",
            params![parent_id, sort_key, node_id],
        )
        .map_err(|error| format!("Could not move a Note node in batch: {error}"))?;
    Ok(())
}

pub(crate) fn mark_former_topic_dirty_for_move(
    transaction: &Transaction<'_>,
    node_id: &str,
    new_parent_id: Option<&str>,
) -> Result<(), String> {
    let former_topic = resolve_active_topic_id(transaction, node_id)?;
    let destination_topic = match new_parent_id {
        Some(parent_id) => resolve_active_topic_id(transaction, parent_id)?,
        None => node_id.to_string(),
    };
    if destination_topic == node_id {
        transaction
            .execute(
                "DELETE FROM sync_dirty_nodes WHERE node_id = ?1",
                [format!(
                    "{}{}",
                    crate::notes::schema::SYNC_REMOVE_TOPIC_PREFIX,
                    node_id
                )],
            )
            .map_err(|error| {
                format!("Could not cancel a stale Notes topic removal after a move: {error}")
            })?;
    }
    if former_topic == destination_topic {
        return Ok(());
    }
    if former_topic == node_id
        && !crate::notes::sync::topic_metadata_exists(transaction, &former_topic)
            .map_err(|error| format!("Could not inspect former Notes topic metadata: {error}"))?
    {
        return Ok(());
    }
    let marker = if former_topic == node_id {
        format!(
            "{}{}",
            crate::notes::schema::SYNC_REMOVE_TOPIC_PREFIX,
            former_topic
        )
    } else {
        former_topic
    };
    transaction
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
             ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
            [marker],
        )
        .map_err(|error| format!("Could not dirty a former Notes topic after a move: {error}"))?;
    Ok(())
}

fn resolve_active_topic_id(transaction: &Transaction<'_>, node_id: &str) -> Result<String, String> {
    transaction
        .query_row(
            "WITH RECURSIVE ancestors(id, parent_id, depth) AS (\
               SELECT id, parent_id, 0 FROM notes_nodes \
               WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL \
               UNION ALL \
               SELECT parent.id, parent.parent_id, ancestors.depth + 1 \
               FROM notes_nodes parent JOIN ancestors ON ancestors.parent_id = parent.id \
               WHERE parent.deleted_at IS NULL AND parent.archived_at IS NULL \
                 AND ancestors.depth < 10000\
             ) \
             SELECT id FROM ancestors WHERE parent_id IS NULL \
             ORDER BY depth DESC LIMIT 1",
            [node_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not resolve an active Notes topic for a move: {error}"))
}

/// Moves the selected nodes as a contiguous block under `parent_id`, positioned
/// after `after_id` or before `before_id`. Only the roots of the selection move
/// (descendants travel with their root); they are placed in the order they
/// appear in `node_ids` (the caller passes them in outline order). All
/// self/descendant/anchor guards run up front so an illegal target rolls the
/// whole batch back before any row moves.
fn batch_move(
    transaction: &Transaction<'_>,
    node_ids: &[String],
    parent_id: Option<&str>,
    after_id: Option<&str>,
    before_id: Option<&str>,
) -> Result<(), String> {
    if after_id.is_some() && before_id.is_some() {
        return Err("A batch move cannot specify both afterId and beforeId.".to_string());
    }
    ensure_live_parent(transaction, parent_id)?;
    for node_id in node_ids {
        require_active_node(transaction, node_id)?;
    }
    let selected: BTreeSet<&str> = node_ids.iter().map(String::as_str).collect();
    if let Some(after_id) = after_id {
        if selected.contains(after_id) {
            return Err(
                "A batch move cannot be anchored after a node in the selection.".to_string(),
            );
        }
    }
    if let Some(before_id) = before_id {
        if selected.contains(before_id) {
            return Err(
                "A batch move cannot be anchored before a node in the selection.".to_string(),
            );
        }
    }
    let roots = selection_roots(transaction, node_ids, &selected)?;
    if let Some(before_id) = before_id {
        for root in &roots {
            if live_descendant_exists(transaction, root, before_id)? {
                return Err(
                    "A batch move cannot be anchored before a descendant of the selection."
                        .to_string(),
                );
            }
        }
    }
    for root in &roots {
        if parent_id == Some(root.as_str()) {
            return Err("A Note node cannot be moved under itself.".to_string());
        }
        if let Some(parent_id) = parent_id {
            if live_descendant_exists(transaction, root, parent_id)? {
                return Err("A Note node cannot be moved under a live descendant.".to_string());
            }
        }
    }

    // Validate the anchor against the target parent's complete live sibling
    // order before any row moves. The same projection lets an already
    // satisfied placement remain a true no-op (no updated_at/history churn).
    let current_order = sibling_keys(transaction, parent_id, None)?
        .into_iter()
        .map(|(node_id, _)| node_id)
        .collect::<Vec<_>>();
    let root_set = roots.iter().map(String::as_str).collect::<BTreeSet<_>>();
    let mut desired_order = current_order
        .iter()
        .filter(|node_id| !root_set.contains(node_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let insertion_index = if let Some(before_id) = before_id {
        desired_order
            .iter()
            .position(|node_id| node_id == before_id)
            .ok_or_else(|| {
                "The requested beforeId must identify a live sibling under the target parent."
                    .to_string()
            })?
    } else if let Some(after_id) = after_id {
        desired_order
            .iter()
            .position(|node_id| node_id == after_id)
            .map(|index| index + 1)
            .ok_or_else(|| {
                "The requested afterId must identify a live sibling under the target parent."
                    .to_string()
            })?
    } else {
        desired_order.len()
    };
    desired_order.splice(insertion_index..insertion_index, roots.iter().cloned());
    if desired_order == current_order {
        return Ok(());
    }

    // The first root honors the submitted placement. Every later root chains
    // after the prior moved root, keeping the block contiguous and ordered.
    let mut previous_root: Option<String> = None;
    for root in &roots {
        let first = previous_root.is_none();
        move_node_within_transaction(
            transaction,
            root,
            parent_id,
            if first {
                after_id
            } else {
                previous_root.as_deref()
            },
            if first { before_id } else { None },
        )?;
        previous_root = Some(root.clone());
    }
    Ok(())
}

/// Indents each eligible selection root. DOCUMENTED SEMANTICS: a root becomes
/// the last child of the nearest preceding sibling (under its current parent)
/// that is NOT itself in the selection. A root with no such sibling (it is the
/// first child, or every preceding sibling is selected) is ineligible and stays
/// in place — e.g. indenting every child of a parent is a no-op. Targets are
/// computed from the pre-mutation snapshot; nodes moving under the same target
/// are appended in their original sibling order, so the result is independent
/// of the order the batch is applied.
fn batch_indent(transaction: &Transaction<'_>, node_ids: &[String]) -> Result<(), String> {
    for node_id in node_ids {
        require_active_node(transaction, node_id)?;
    }
    let selected: BTreeSet<&str> = node_ids.iter().map(String::as_str).collect();
    let roots = selection_roots(transaction, node_ids, &selected)?;
    // (new_parent_id, original_sibling_index, node_id)
    let mut plans: Vec<(String, usize, String)> = Vec::new();
    for root in &roots {
        let node = node_by_id(transaction, root)?
            .ok_or_else(|| format!("Note node {root} does not exist."))?;
        let siblings = sibling_keys(transaction, node.parent_id.as_deref(), None)?;
        let Some(index) = siblings.iter().position(|(id, _)| id == root) else {
            continue;
        };
        let target = siblings[..index]
            .iter()
            .rev()
            .map(|(id, _)| id)
            .find(|id| !selected.contains(id.as_str()));
        if let Some(target) = target {
            plans.push((target.clone(), index, root.clone()));
        }
        // else: no eligible prior sibling -> ineligible, leave in place.
    }
    // Group by target parent and append in original order so siblings moving
    // under the same parent keep their relative order regardless of input order.
    plans.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    for (new_parent, _, node_id) in &plans {
        move_node_within_transaction(transaction, node_id, Some(new_parent), None, None)?;
    }
    Ok(())
}

/// Outdents each eligible selection root. DOCUMENTED SEMANTICS: a root that has
/// a parent moves up one level — its new parent is its grandparent (may be the
/// root level), positioned immediately after its old parent. A root already at
/// the top level (no parent) is ineligible and stays in place. When several
/// selected siblings outdent from the same parent they are chained after that
/// parent in original order, so the block stays contiguous and ordered. Plans
/// are computed from the pre-mutation snapshot for order-independence.
fn batch_outdent(transaction: &Transaction<'_>, node_ids: &[String]) -> Result<(), String> {
    for node_id in node_ids {
        require_active_node(transaction, node_id)?;
    }
    let selected: BTreeSet<&str> = node_ids.iter().map(String::as_str).collect();
    let roots = selection_roots(transaction, node_ids, &selected)?;
    struct OutdentPlan {
        parent_id: String,
        grandparent_id: Option<String>,
        index: usize,
        node_id: String,
    }
    let mut plans: Vec<OutdentPlan> = Vec::new();
    for root in &roots {
        let node = node_by_id(transaction, root)?
            .ok_or_else(|| format!("Note node {root} does not exist."))?;
        let Some(parent_id) = node.parent_id.clone() else {
            continue; // already at the top level -> ineligible.
        };
        let parent = node_by_id(transaction, &parent_id)?
            .ok_or_else(|| format!("Note node {parent_id} does not exist."))?;
        let grandparent_id = parent.parent_id.clone();
        let siblings = sibling_keys(transaction, Some(&parent_id), None)?;
        let index = siblings
            .iter()
            .position(|(id, _)| id == root)
            .ok_or_else(|| format!("Note node {root} is not a live child of its parent."))?;
        plans.push(OutdentPlan {
            parent_id,
            grandparent_id,
            index,
            node_id: root.clone(),
        });
    }
    // Emit each parent-group in document order; the first node of a group lands
    // right after its old parent, and subsequent nodes chain after the previous.
    plans.sort_by(|a, b| a.parent_id.cmp(&b.parent_id).then(a.index.cmp(&b.index)));
    let mut current_parent: Option<&str> = None;
    let mut anchor: Option<String> = None;
    for plan in &plans {
        if current_parent != Some(plan.parent_id.as_str()) {
            current_parent = Some(plan.parent_id.as_str());
            anchor = Some(plan.parent_id.clone());
        }
        move_node_within_transaction(
            transaction,
            &plan.node_id,
            plan.grandparent_id.as_deref(),
            anchor.as_deref(),
            None,
        )?;
        anchor = Some(plan.node_id.clone());
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct NewAttachment {
    pub(crate) id: String,
    pub(crate) node_id: String,
    pub(crate) relative_path: String,
    pub(crate) content_hash: String,
    pub(crate) original_name: String,
    pub(crate) mime_type: String,
    pub(crate) byte_size: i64,
    pub(crate) intrinsic_width: i64,
    pub(crate) intrinsic_height: i64,
    pub(crate) display_width: i64,
}

pub(crate) fn attachment_matches_new_attachment(
    existing: &NoteAttachment,
    expected: &NewAttachment,
) -> bool {
    existing.id == expected.id
        && existing.node_id == expected.node_id
        && existing.relative_path == expected.relative_path
        && existing.content_hash == expected.content_hash
        && existing.original_name == expected.original_name
        && existing.mime_type == expected.mime_type
        && existing.byte_size == expected.byte_size
        && existing.intrinsic_width == expected.intrinsic_width
        && existing.intrinsic_height == expected.intrinsic_height
        && existing.display_width == expected.display_width
}

pub(crate) struct NewImageNode {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) attachment: NewAttachment,
}

/// A fully planned Markdown import tree. IDs are generated by the command
/// boundary after source parsing/asset preparation and are revalidated against
/// the database here immediately before publication and again before commit.
pub(crate) struct MarkdownImportNode {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) note: String,
    pub(crate) image_offset_utf16: i64,
    pub(crate) completed: bool,
    pub(crate) attachment: Option<NewAttachment>,
    pub(crate) children: Vec<MarkdownImportNode>,
}

fn validate_attachment_display_width(
    display_width: i64,
    intrinsic_width: i64,
) -> Result<(), String> {
    let minimum = intrinsic_width.min(MIN_ATTACHMENT_DISPLAY_WIDTH);
    if intrinsic_width <= 0 || display_width < minimum || display_width > intrinsic_width {
        return Err(format!(
            "A Notes attachment display width must be between {minimum} and {intrinsic_width} pixels."
        ));
    }
    Ok(())
}

fn validate_initial_attachment_display_width(
    display_width: i64,
    intrinsic_width: i64,
) -> Result<(), String> {
    if intrinsic_width <= 0 || display_width <= 0 || display_width > intrinsic_width {
        return Err(format!(
            "A Notes attachment initial display width must be between 1 and {intrinsic_width} pixels."
        ));
    }
    Ok(())
}

pub(crate) fn attachment_by_id(
    connection: &Connection,
    attachment_id: &str,
) -> Result<Option<NoteAttachment>, String> {
    validate_note_id(attachment_id)
        .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
    connection
        .query_row(
            "SELECT id, node_id, sort_key, relative_path, content_hash, original_name, \
                    mime_type, byte_size, intrinsic_width, intrinsic_height, display_width, \
                    created_at, updated_at \
             FROM notes_attachments WHERE id = ?1",
            [attachment_id],
            note_attachment_from_row,
        )
        .optional()
        .map_err(|error| format!("Could not read Notes attachment {attachment_id}: {error}"))
}

fn validate_new_attachment(attachment: &NewAttachment) -> Result<(), String> {
    validate_note_id(&attachment.id)
        .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
    validate_note_id(&attachment.node_id)?;
    validate_initial_attachment_display_width(
        attachment.display_width,
        attachment.intrinsic_width,
    )?;
    if attachment.intrinsic_height <= 0 || attachment.byte_size <= 0 {
        return Err(
            "A Notes attachment must have positive decoded dimensions and byte size.".to_string(),
        );
    }
    if attachment.original_name.trim().is_empty() || attachment.original_name.len() > 1024 {
        return Err("A Notes attachment original name must contain 1 to 1024 bytes.".to_string());
    }
    Ok(())
}

fn validate_attachment_capacity(
    transaction: &Transaction<'_>,
    node_id: &str,
) -> Result<(), String> {
    let owner = require_active_node(transaction, node_id)?;
    require_content_mutable(&owner)?;
    if owner.node_kind == NoteNodeKind::Image {
        return Err("A generic Notes attachment cannot be added to an image node.".to_string());
    }
    let (node_count, vault_count): (i64, i64) = transaction
        .query_row(
            "SELECT \
               (SELECT COUNT(*) FROM notes_attachments WHERE node_id = ?1), \
               (SELECT COUNT(*) FROM notes_attachments)",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Could not inspect Notes attachment capacity: {error}"))?;
    if node_count >= MAX_NOTE_ATTACHMENTS_PER_NODE {
        return Err(format!(
            "A Note node can contain at most {MAX_NOTE_ATTACHMENTS_PER_NODE} attachments."
        ));
    }
    if vault_count >= MAX_NOTE_ATTACHMENTS_PER_VAULT {
        return Err(format!(
            "A Notes vault can contain at most {MAX_NOTE_ATTACHMENTS_PER_VAULT} attachments."
        ));
    }
    Ok(())
}

fn validate_attachment_batch_capacity(
    transaction: &Transaction<'_>,
    node_id: &str,
    batch_len: usize,
) -> Result<(), String> {
    let owner = require_active_node(transaction, node_id)?;
    require_content_mutable(&owner)?;
    if owner.node_kind == NoteNodeKind::Image {
        return Err("A generic Notes attachment cannot be added to an image node.".to_string());
    }
    let batch_len = i64::try_from(batch_len)
        .map_err(|_| "Could not measure the Notes attachment batch.".to_string())?;
    let (node_count, vault_count): (i64, i64) = transaction
        .query_row(
            "SELECT \
               (SELECT COUNT(*) FROM notes_attachments WHERE node_id = ?1), \
               (SELECT COUNT(*) FROM notes_attachments)",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Could not inspect Notes attachment capacity: {error}"))?;
    if node_count
        .checked_add(batch_len)
        .map_or(true, |count| count > MAX_NOTE_ATTACHMENTS_PER_NODE)
    {
        return Err(format!(
            "A Note node can contain at most {MAX_NOTE_ATTACHMENTS_PER_NODE} attachments."
        ));
    }
    if vault_count
        .checked_add(batch_len)
        .map_or(true, |count| count > MAX_NOTE_ATTACHMENTS_PER_VAULT)
    {
        return Err(format!(
            "A Notes vault can contain at most {MAX_NOTE_ATTACHMENTS_PER_VAULT} attachments."
        ));
    }
    Ok(())
}

fn insert_new_attachment_at_sort_key(
    transaction: &Transaction<'_>,
    attachment: NewAttachment,
    sort_key: i64,
) -> Result<(), String> {
    if id_namespace_in_use(transaction, &attachment.id)? {
        return Err(format!(
            "Notes attachment ID {} is already in use.",
            attachment.id
        ));
    }
    transaction
        .execute(
            "INSERT INTO notes_attachments(\
               id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
               byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![
                attachment.id,
                attachment.node_id,
                sort_key,
                attachment.relative_path,
                attachment.content_hash,
                attachment.original_name,
                attachment.mime_type,
                attachment.byte_size,
                attachment.intrinsic_width,
                attachment.intrinsic_height,
                attachment.display_width,
            ],
        )
        .map_err(|error| format!("Could not create the Notes attachment metadata: {error}"))?;
    Ok(())
}

#[cfg(test)]
fn insert_new_attachment(
    transaction: &Transaction<'_>,
    attachment: NewAttachment,
) -> Result<(), String> {
    validate_attachment_capacity(transaction, &attachment.node_id)?;
    if id_namespace_in_use(transaction, &attachment.id)? {
        return Err(format!(
            "Notes attachment ID {} is already in use.",
            attachment.id
        ));
    }
    let sort_key: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_key), 0) FROM notes_attachments WHERE node_id = ?1",
            [&attachment.node_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Could not inspect Notes attachment ordering: {error}"))?
        .checked_add(SORT_KEY_STEP)
        .ok_or_else(|| "The Notes attachment ordering is too large.".to_string())?;
    insert_new_attachment_at_sort_key(transaction, attachment, sort_key)
}

#[cfg(test)]
pub(crate) fn create_attachment(
    connection: &mut Connection,
    attachment: NewAttachment,
) -> Result<NotesWorkspace, String> {
    validate_new_attachment(&attachment)?;
    with_workspace_transaction(connection, |transaction| {
        insert_new_attachment(transaction, attachment)
    })
}

fn create_attachment_coordinated_inner(
    connection: &mut Connection,
    capacity_preflight: Option<(&str, usize)>,
    prepare: impl FnOnce() -> Result<(String, Vec<NewAttachment>), String>,
    publish: impl FnOnce() -> Result<(), String>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<NotesWorkspace, String> {
    let journaled = history::has_active_context(connection)?;

    // Phase 1 — validate the batch and reserve its ordering inside a short
    // read-only transaction. Every check here only reads the DB (node/vault
    // capacity, ID uniqueness, sort keys) and the transaction is rolled back
    // when this block ends. Publication MUST come after these checks so a
    // rejected batch never touches the filesystem (the `*_before_publication`
    // contract tests pin this).
    let (attachments, sort_keys) = {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Could not start the Notes attachment validation: {error}"))?;
        if let Some((node_id, batch_len)) = capacity_preflight {
            validate_attachment_batch_capacity(&transaction, node_id, batch_len)?;
        }
        let (node_id, attachments) = prepare()?;
        validate_attachment_batch_capacity(&transaction, &node_id, attachments.len())?;

        let mut ids = HashSet::with_capacity(attachments.len());
        for attachment in &attachments {
            validate_new_attachment(attachment)?;
            if attachment.node_id != node_id {
                return Err("Prepared Notes attachment targets an unexpected node.".to_string());
            }
            if !ids.insert(attachment.id.as_str()) {
                return Err(format!(
                    "Notes attachment ID {} is already in use.",
                    attachment.id
                ));
            }
            if id_namespace_in_use(&transaction, &attachment.id)? {
                return Err(format!(
                    "Notes attachment ID {} is already in use.",
                    attachment.id
                ));
            }
        }

        let mut sort_key: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sort_key), 0) FROM notes_attachments WHERE node_id = ?1",
                [&node_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not inspect Notes attachment ordering: {error}"))?;
        let mut sort_keys = Vec::with_capacity(attachments.len());
        for _ in &attachments {
            sort_key = sort_key
                .checked_add(SORT_KEY_STEP)
                .ok_or_else(|| "The Notes attachment ordering is too large.".to_string())?;
            sort_keys.push(sort_key);
        }
        (attachments, sort_keys)
    };

    // Phase 2 — publish the files with NO transaction (and so no write lock)
    // held, keeping the slow temp-write + fsync + rename + dir-fsync out of the
    // metadata transaction. We publish *before* committing the metadata
    // (file-before-commit): `reconcile_attachment_files`/`reconcile_attachment_candidates`
    // only *remove* files that no DB row references — they can never restore a
    // missing one — so a committed row must never outlive its bytes. If the
    // phase 3 transaction fails, the freshly published files are unreferenced
    // orphans that the caller's marker/reconcile path (e.g.
    // `reconcile_failed_attachment_batch`) sweeps.
    publish()?;

    // Phase 3 — insert the metadata rows and commit inside an IMMEDIATE write
    // transaction. Note commands are serialized per vault on a single managed
    // connection behind the attachment storage lease, so no other writer slips
    // between phase 1's validation snapshot and this commit.
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes attachment transaction: {error}"))?;
    for (attachment, sort_key) in attachments.into_iter().zip(sort_keys) {
        insert_new_attachment_at_sort_key(&transaction, attachment, sort_key)?;
    }
    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    if journaled {
        history::finalize_transaction(&transaction)?;
    }
    before_commit()?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes attachment transaction: {error}"))?;
    Ok(workspace)
}

pub(crate) fn create_attachments_coordinated_for_node(
    connection: &mut Connection,
    node_id: &str,
    attachments: Vec<NewAttachment>,
    publish: impl FnOnce() -> Result<(), String>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<NotesWorkspace, String> {
    let batch_len = attachments.len();
    create_attachment_coordinated_inner(
        connection,
        Some((node_id, batch_len)),
        || Ok((node_id.to_string(), attachments)),
        publish,
        before_commit,
    )
}

fn validate_image_node_batch_preflight(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    nodes: &[NewImageNode],
) -> Result<(), String> {
    if nodes.is_empty() || nodes.len() > MAX_IMAGE_NODE_IMPORT_ITEMS {
        return Err(format!(
            "A Notes image node batch must contain between 1 and {MAX_IMAGE_NODE_IMPORT_ITEMS} images."
        ));
    }
    ensure_live_parent(transaction, parent_id)?;
    if let Some(after_id) = after_id {
        let anchor = require_active_node(transaction, after_id)?;
        if anchor.parent_id.as_deref() != parent_id {
            return Err(
                "The requested afterId must identify a live sibling under the target parent."
                    .to_string(),
            );
        }
    }

    let batch_len = i64::try_from(nodes.len())
        .map_err(|_| "Could not measure the Notes image node batch.".to_string())?;
    let vault_count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not inspect Notes attachment capacity: {error}"))?;
    if vault_count
        .checked_add(batch_len)
        .map_or(true, |count| count > MAX_NOTE_ATTACHMENTS_PER_VAULT)
    {
        return Err(format!(
            "A Notes vault can contain at most {MAX_NOTE_ATTACHMENTS_PER_VAULT} attachments."
        ));
    }

    let mut node_ids = HashSet::with_capacity(nodes.len());
    let mut attachment_ids = HashSet::with_capacity(nodes.len());
    for node in nodes {
        validate_note_id(&node.id)?;
        if !node_ids.insert(node.id.as_str()) {
            return Err(format!(
                "A Notes image node batch contains duplicate node ID {}.",
                node.id
            ));
        }
        ensure_fresh_id(transaction, &node.id)?;
        validate_new_attachment(&node.attachment)?;
        if node.attachment.node_id != node.id {
            return Err(
                "A Notes image node attachment must belong to its new image node.".to_string(),
            );
        }
        if !attachment_ids.insert(node.attachment.id.as_str()) {
            return Err(format!(
                "A Notes image node batch contains duplicate attachment ID {}.",
                node.attachment.id
            ));
        }
        let overlapping_id = if attachment_ids.contains(node.id.as_str()) {
            Some(node.id.as_str())
        } else if node_ids.contains(node.attachment.id.as_str()) {
            Some(node.attachment.id.as_str())
        } else {
            None
        };
        if let Some(overlapping_id) = overlapping_id {
            return Err(format!(
                "A Notes image node batch contains ID {overlapping_id} used as both a node and attachment ID."
            ));
        }
        if id_namespace_in_use(transaction, &node.attachment.id)? {
            return Err(format!(
                "Notes attachment ID {} is already in use.",
                node.attachment.id
            ));
        }
    }
    Ok(())
}

fn first_image_node_sort_key(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    after_id: Option<&str>,
) -> Result<i64, String> {
    if after_id.is_some() {
        return next_sort_key(transaction, parent_id, after_id);
    }
    let first_sibling = sibling_keys(transaction, parent_id, None)?
        .into_iter()
        .next()
        .map(|(id, _)| id);
    next_sort_key_excluding(transaction, parent_id, None, first_sibling.as_deref(), None)
}

pub(crate) fn create_image_nodes_coordinated(
    connection: &mut Connection,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    nodes: Vec<NewImageNode>,
    publish: impl FnOnce() -> Result<(), String>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<NotesWorkspace, String> {
    let journaled = history::has_active_context(connection)?;

    {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Could not start the Notes image node validation: {error}"))?;
        validate_image_node_batch_preflight(&transaction, parent_id, after_id, &nodes)?;
        transaction.rollback().map_err(|error| {
            format!("Could not finish the Notes image node validation: {error}")
        })?;
    }

    publish()?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes image node transaction: {error}"))?;
    validate_image_node_batch_preflight(&transaction, parent_id, after_id, &nodes)?;
    let mut previous_id = after_id.map(str::to_string);
    for (index, node) in nodes.into_iter().enumerate() {
        let sort_key = if index == 0 {
            first_image_node_sort_key(&transaction, parent_id, after_id)?
        } else {
            next_sort_key(&transaction, parent_id, previous_id.as_deref())?
        };
        transaction
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, image_offset_utf16, node_kind, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, '', 0, 'image', \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
                 )",
                params![node.id, parent_id, sort_key, node.title],
            )
            .map_err(|error| format!("Could not create the Notes image node: {error}"))?;
        let node_id = node.id;
        insert_new_attachment_at_sort_key(&transaction, node.attachment, SORT_KEY_STEP)?;
        previous_id = Some(node_id);
    }
    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    if journaled {
        history::finalize_transaction(&transaction)?;
    }
    before_commit()?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes image node transaction: {error}"))?;
    Ok(workspace)
}

fn validate_markdown_import_tree_preflight(
    transaction: &Transaction<'_>,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    nodes: &[MarkdownImportNode],
) -> Result<(), String> {
    if nodes.len() != 1 {
        return Err("A Notes Markdown import must contain exactly one root node.".to_string());
    }
    ensure_live_parent(transaction, parent_id)?;
    if let Some(after_id) = after_id {
        let anchor = require_active_node(transaction, after_id)?;
        if anchor.parent_id.as_deref() != parent_id {
            return Err(
                "The requested afterId must identify a live sibling under the target parent."
                    .to_string(),
            );
        }
    }

    let mut ids = HashSet::new();
    let mut attachment_count = 0_i64;
    fn visit(
        transaction: &Transaction<'_>,
        node: &MarkdownImportNode,
        ids: &mut HashSet<String>,
        attachment_count: &mut i64,
    ) -> Result<(), String> {
        validate_note_id(&node.id)?;
        if node.id.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Err(
                "Notes Markdown import IDs must be canonical lowercase UUID v4 values.".to_string(),
            );
        }
        if !ids.insert(node.id.clone()) {
            return Err(format!(
                "Notes Markdown import contains duplicate ID {}.",
                node.id
            ));
        }
        ensure_fresh_id(transaction, &node.id)?;

        let kind = if node.attachment.is_some() {
            NoteNodeKind::Image
        } else {
            NoteNodeKind::Text
        };
        crate::notes::schema::validate_image_offset_utf16(
            &node.title,
            kind,
            node.image_offset_utf16,
        )?;
        if let Some(attachment) = &node.attachment {
            validate_new_attachment(attachment)?;
            if attachment.node_id != node.id {
                return Err("A Notes Markdown image attachment targets the wrong node.".to_string());
            }
            if attachment.id.bytes().any(|byte| byte.is_ascii_uppercase()) {
                return Err(
                    "Notes Markdown import IDs must be canonical lowercase UUID v4 values."
                        .to_string(),
                );
            }
            if !ids.insert(attachment.id.clone()) {
                return Err(format!(
                    "Notes Markdown import contains duplicate ID {}.",
                    attachment.id
                ));
            }
            if id_namespace_in_use(transaction, &attachment.id)? {
                return Err(format!(
                    "Notes attachment ID {} is already in use.",
                    attachment.id
                ));
            }
            *attachment_count = attachment_count
                .checked_add(1)
                .ok_or_else(|| "Could not measure Notes Markdown attachments.".to_string())?;
        }
        for child in &node.children {
            visit(transaction, child, ids, attachment_count)?;
        }
        Ok(())
    }

    for node in nodes {
        visit(transaction, node, &mut ids, &mut attachment_count)?;
    }
    let vault_count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not inspect Notes attachment capacity: {error}"))?;
    if vault_count
        .checked_add(attachment_count)
        .map_or(true, |count| count > MAX_NOTE_ATTACHMENTS_PER_VAULT)
    {
        return Err(format!(
            "A Notes vault can contain at most {MAX_NOTE_ATTACHMENTS_PER_VAULT} attachments."
        ));
    }
    Ok(())
}

/// Performs all database-only Markdown import validation before the command
/// marks reconciliation or publishes any asset bytes.
pub(crate) fn preflight_markdown_import(
    connection: &mut Connection,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    nodes: &[MarkdownImportNode],
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not start the Notes Markdown validation: {error}"))?;
    let result = validate_markdown_import_tree_preflight(&transaction, parent_id, after_id, nodes);
    transaction
        .rollback()
        .map_err(|error| format!("Could not finish the Notes Markdown validation: {error}"))?;
    result
}

fn insert_markdown_import_node(
    transaction: &Transaction<'_>,
    node: MarkdownImportNode,
    parent_id: Option<&str>,
    sort_key: i64,
    today: LocalDate,
) -> Result<(), String> {
    let kind = if node.attachment.is_some() {
        NoteNodeKind::Image
    } else {
        NoteNodeKind::Text
    };
    transaction
        .execute(
            "INSERT INTO notes_nodes (\
               id, parent_id, sort_key, title, note, image_offset_utf16, completed_at, node_kind, created_at, updated_at\
             ) VALUES (\
               ?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?7 <> 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END, ?8, \
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\
            )",
            params![
                &node.id,
                parent_id,
                sort_key,
                &node.title,
                &node.note,
                node.image_offset_utf16,
                i64::from(node.completed),
                kind.as_str(),
            ],
        )
        .map_err(|error| format!("Could not create a Notes Markdown node: {error}"))?;
    replace_derived_content(
        transaction,
        &node.id,
        kind,
        &node.title,
        node.image_offset_utf16,
        &node.note,
        today,
    )?;
    if let Some(attachment) = node.attachment {
        insert_new_attachment_at_sort_key(transaction, attachment, SORT_KEY_STEP)?;
    }

    let node_id = node.id;
    for (index, child) in node.children.into_iter().enumerate() {
        let position = i64::try_from(index + 1)
            .map_err(|_| "The imported Notes Markdown tree has too many siblings.".to_string())?;
        let child_sort_key = position
            .checked_mul(SORT_KEY_STEP)
            .ok_or_else(|| "The imported Notes Markdown tree has too many siblings.".to_string())?;
        insert_markdown_import_node(transaction, child, Some(&node_id), child_sort_key, today)?;
    }
    Ok(())
}

/// Inserts an already preflighted Markdown tree in one IMMEDIATE transaction.
/// The command publishes bytes before calling this helper; the helper therefore
/// repeats preflight under the write lock before metadata can reference them.
pub(crate) fn create_markdown_import_coordinated(
    connection: &mut Connection,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    nodes: Vec<MarkdownImportNode>,
    today: LocalDate,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<(NotesWorkspace, Vec<NoteId>), String> {
    let journaled = history::has_active_context(connection)?;
    let root_ids = nodes.iter().map(|node| node.id.clone()).collect::<Vec<_>>();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes Markdown transaction: {error}"))?;
    validate_markdown_import_tree_preflight(&transaction, parent_id, after_id, &nodes)?;
    let mut previous_id = after_id.map(str::to_string);
    for node in nodes {
        let sort_key = next_sort_key(&transaction, parent_id, previous_id.as_deref())?;
        let node_id = node.id.clone();
        insert_markdown_import_node(&transaction, node, parent_id, sort_key, today)?;
        previous_id = Some(node_id);
    }
    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    if journaled {
        history::finalize_transaction(&transaction)?;
    }
    before_commit()?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes Markdown transaction: {error}"))?;
    Ok((workspace, root_ids))
}

#[cfg(test)]
pub(crate) fn create_attachment_coordinated(
    connection: &mut Connection,
    prepare: impl FnOnce() -> Result<NewAttachment, String>,
    before_commit: impl FnOnce() -> Result<(), String>,
) -> Result<NotesWorkspace, String> {
    create_attachment_coordinated_inner(
        connection,
        None,
        || {
            let attachment = prepare()?;
            let node_id = attachment.node_id.clone();
            Ok((node_id, vec![attachment]))
        },
        || Ok(()),
        before_commit,
    )
}

pub(crate) fn resize_attachment(
    connection: &mut Connection,
    attachment_id: &str,
    display_width: i64,
) -> Result<NotesWorkspace, String> {
    validate_note_id(attachment_id)
        .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
    with_workspace_transaction(connection, |transaction| {
        let attachment = attachment_by_id(transaction, attachment_id)?
            .ok_or_else(|| format!("Notes attachment {attachment_id} does not exist."))?;
        let owner = require_active_node(transaction, &attachment.node_id)?;
        require_content_mutable(&owner)?;
        validate_attachment_display_width(display_width, attachment.intrinsic_width)?;
        transaction
            .execute(
                "UPDATE notes_attachments SET display_width = ?1, \
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                params![display_width, attachment_id],
            )
            .map_err(|error| format!("Could not resize the Notes attachment: {error}"))?;
        Ok(())
    })
}

pub(crate) fn remove_attachment(
    connection: &mut Connection,
    attachment_id: &str,
) -> Result<NotesWorkspace, String> {
    validate_note_id(attachment_id)
        .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
    with_workspace_transaction(connection, |transaction| {
        let attachment = attachment_by_id(transaction, attachment_id)?
            .ok_or_else(|| format!("Notes attachment {attachment_id} does not exist."))?;
        let owner = require_active_node(transaction, &attachment.node_id)?;
        require_content_mutable(&owner)?;
        if owner.node_kind == NoteNodeKind::Image {
            return Err(
                "An image node's owned attachment cannot be removed independently.".to_string(),
            );
        }
        transaction
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [attachment_id],
            )
            .map_err(|error| format!("Could not remove the Notes attachment: {error}"))?;
        Ok(())
    })
}

pub(crate) fn removed_attachment_snapshot(
    connection: &Connection,
    attachment_id: &str,
) -> Result<NoteAttachment, String> {
    validate_note_id(attachment_id)
        .map_err(|_| "A Notes attachment ID must be a canonical UUID v4 string.".to_string())?;
    if attachment_by_id(connection, attachment_id)?.is_some() {
        return Err(format!("Notes attachment {attachment_id} already exists."));
    }
    let snapshot = connection
        .query_row(
            "SELECT change.before_json FROM notes_history_changes change \
             JOIN notes_history_entries entry ON entry.id = change.entry_id \
             WHERE change.table_name = 'notes_attachments' AND change.row_id = ?1 \
               AND change.before_json IS NOT NULL AND change.after_json IS NULL \
             ORDER BY entry.rowid DESC, change.ordinal DESC LIMIT 1",
            [attachment_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not find removed Notes attachment metadata: {error}"))?
        .ok_or_else(|| format!("Removed Notes attachment {attachment_id} is not in history."))?;
    let attachment: NoteAttachment = serde_json::from_str(&snapshot)
        .map_err(|error| format!("Could not decode removed Notes attachment metadata: {error}"))?;
    if attachment.id != attachment_id {
        return Err("A removed Notes attachment snapshot has the wrong ID.".to_string());
    }
    Ok(attachment)
}

pub(crate) fn restore_attachment(
    connection: &mut Connection,
    attachment: NoteAttachment,
) -> Result<NotesWorkspace, String> {
    validate_initial_attachment_display_width(
        attachment.display_width,
        attachment.intrinsic_width,
    )?;
    with_workspace_transaction(connection, |transaction| {
        let owner = require_active_node(transaction, &attachment.node_id)?;
        require_content_mutable(&owner)?;
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(\
                   SELECT 1 FROM notes_nodes WHERE id = ?1 \
                   UNION ALL \
                   SELECT 1 FROM notes_attachments WHERE id = ?1\
                 )",
                [&attachment.id],
                |row| row.get(0),
            )
            .map_err(|error| {
                format!("Could not inspect restored Notes attachment metadata: {error}")
            })?;
        if exists {
            return Err(format!(
                "Notes attachment {} already exists.",
                attachment.id
            ));
        }
        validate_attachment_capacity(transaction, &attachment.node_id)?;
        transaction
            .execute(
                "INSERT INTO notes_attachments(\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    attachment.id,
                    attachment.node_id,
                    attachment.sort_key,
                    attachment.relative_path,
                    attachment.content_hash,
                    attachment.original_name,
                    attachment.mime_type,
                    attachment.byte_size,
                    attachment.intrinsic_width,
                    attachment.intrinsic_height,
                    attachment.display_width,
                    attachment.created_at,
                    attachment.updated_at,
                ],
            )
            .map_err(|error| format!("Could not restore the Notes attachment metadata: {error}"))?;
        Ok(())
    })
}

fn reject_plugin_rows_in_trash(transaction: &Transaction<'_>) -> Result<(), String> {
    let has_plugin_rows: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes \
             WHERE deleted_at IS NOT NULL AND (id = ?1 OR plugin_state IS NOT NULL OR plugin_meta IS NOT NULL))",
            [GITHUB_NOTIFICATIONS_ROOT_ID],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not inspect plugin rows in Notes trash: {error}"))?;
    if has_plugin_rows {
        Err("Plugin-managed Note rows must be purged by their provider.".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn empty_trash(connection: &mut Connection) -> Result<NotesWorkspace, String> {
    with_workspace_transaction(connection, |transaction| {
        reject_plugin_rows_in_trash(transaction)?;
        record_local_purge_evidence(transaction)?;
        transaction
            .execute("DELETE FROM notes_nodes WHERE deleted_at IS NOT NULL", [])
            .map_err(|error| format!("Could not permanently empty Notes trash: {error}"))?;
        history::clear_all_history_in_transaction(transaction)?;
        Ok(())
    })
}

pub(crate) fn empty_trash_with_history_reset(
    connection: &mut Connection,
    input: &NotesHistoryResetInput,
) -> Result<(NotesWorkspace, history::HistoryMaintenanceResult), String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start emptying Notes trash: {error}"))?;
    reject_plugin_rows_in_trash(&transaction)?;
    let history = history::reset_history_in_transaction(&transaction, input)?;
    record_local_purge_evidence(&transaction)?;
    transaction
        .execute("DELETE FROM notes_nodes WHERE deleted_at IS NOT NULL", [])
        .map_err(|error| format!("Could not permanently empty Notes trash: {error}"))?;
    let workspace = load_workspace(&transaction, NotesWorkspaceScope::Active)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit emptied Notes trash: {error}"))?;
    Ok((workspace, history))
}

fn record_local_purge_evidence(transaction: &Transaction<'_>) -> Result<(), String> {
    let deleted_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM notes_nodes WHERE deleted_at IS NOT NULL ORDER BY id")
            .map_err(|error| format!("Could not prepare local Notes purge evidence: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Could not load local Notes purge evidence: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not read local Notes purge evidence: {error}"))?;
        rows
    };
    if deleted_ids.is_empty() {
        return Ok(());
    }
    let deleted_id_refs = deleted_ids.iter().map(String::as_str).collect::<Vec<_>>();
    crate::notes::sync::record_purged_node_ids(transaction, &deleted_id_refs)
}

#[cfg(test)]
mod tests {
    use super::{
        ancestor_closure_query_count, apply_batch, apply_batch_at, archive_node, collapse_all,
        connect_notes_db, create_attachment, create_attachments_coordinated_for_node,
        create_image_nodes_coordinated, create_markdown_import_coordinated, create_node,
        create_node_at, create_node_before_at, delete_database, delete_nodes,
        delete_nodes_preflight, duplicate_node, duplicate_node_at, empty_trash, expand_all,
        github_notification_lookup_stats, import_subtree_at, initialize_notes_db,
        inject_delete_database_after_hold_once, inject_notes_database_after_hold_once,
        inject_notes_database_after_sqlite_open_once, list_tags, list_tags_with_counts,
        load_workspace, mark_materialized_github_notification_read,
        materialize_github_notification_and_create_sibling,
        materialize_github_notification_and_import_children,
        materialize_github_notification_and_reparent, move_node, node_attachments,
        node_by_id_lookup_count, note_node_from_audit_json, notes_db_path, notes_db_path_with_root,
        observe_next_initialization_busy, open_local_notes_storage_directory, open_notes_export_db,
        readonly_descendant_scan_stats, refresh_materialized_github_notifications,
        remove_attachment, remove_empty_node, reset_ancestor_closure_query_count,
        reset_github_notification_lookup_stats, reset_node_by_id_lookup_count,
        reset_readonly_descendant_scan_stats, reset_search_parent_trail_query_count,
        reset_sibling_order_stats, resize_attachment, restore_attachment, restore_node,
        restore_node_at, search_nodes, search_nodes_at, search_nodes_structured,
        search_parent_trail_query_count, seed_notes_onboarding, selection_roots,
        set_github_group_collapsed, set_readonly_at, sibling_order_stats, soft_delete_node,
        sort_subtree_ascending, sort_subtree_descending, split_node, split_node_at,
        sqlite_companion_path, toggle_collapsed, toggle_complete, toggle_star, unarchive_node,
        update_node, update_node_at, vault_key, windows_notes_database_share_mode,
        MarkdownImportNode, NewAttachment, NewImageNode, NoteAttachment,
        ANCESTOR_CLOSURE_CHUNK_SIZE, CURRENT_NOTES_SCHEMA_VERSION,
        NOTES_DEVELOPMENT_SCHEMA_REJECTION, SORT_KEY_STEP,
    };
    use crate::notes::date_index::LocalDate;
    use crate::notes::github_notifications::{
        github_date_node_id, github_notification_node_id, serialize_github_plugin_meta_storage,
        GithubNotificationsPluginMeta, GITHUB_NOTIFICATIONS_FILENAME, GITHUB_NOTIFICATIONS_ROOT_ID,
    };
    use crate::notes::history::{
        history_epoch, install_session_history, redo, undo, with_history_transaction_and_prunes,
    };
    use crate::notes::schema::{
        install_notes_sql_functions, NOTES_SCHEMA_VERSION_V3, V3_SCHEMA_SQL,
    };
    use crate::notes::types::{
        validate_note_id, ApplyBatchInput, BatchOp, CreateNodeInput, DeleteNodesInput,
        DeleteNodesOutcome, GithubNotificationSnapshotInput, ImportNode, ImportSubtreeInput,
        MarkGithubNotificationReadInput, MaterializeGithubNotificationReparentInput,
        MaterializeGithubNotificationSiblingInput, MoveNodeInput, NoteNodeKind,
        NoteSearchMatchedField, NoteSearchScope, NoteSearchTag, NoteStructuredSearchQuery,
        NoteTagFilter, NoteTagPrefix, NotesHistoryContext, NotesWorkspaceScope,
        RefreshGithubNotificationsInput, SetGithubGroupCollapsedInput, SplitNodeInput,
        UpdateNodeInput, MAX_IMPORT_SUBTREE_DEPTH, MAX_IMPORT_SUBTREE_NODES,
        MAX_NOTE_ATTACHMENTS_PER_NODE, MAX_NOTE_ATTACHMENTS_PER_VAULT,
    };
    use rusqlite::{params, Connection};
    use std::collections::{BTreeSet, HashMap};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    const NODE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHILD_ID: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_ID: &str = "33333333-3333-4333-8333-333333333333";
    const FOURTH_ID: &str = "44444444-4444-4444-8444-444444444444";
    const FIFTH_ID: &str = "55555555-5555-4555-8555-555555555555";
    const SIXTH_ID: &str = "66666666-6666-4666-8666-666666666666";
    const SEVENTH_ID: &str = "77777777-7777-4777-8777-777777777777";
    const EIGHTH_ID: &str = "88888888-8888-4888-8888-888888888888";

    fn fixed_today() -> LocalDate {
        LocalDate::new(2026, 7, 11).expect("fixed date")
    }

    fn sqlite_total_changes(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .expect("total SQLite changes")
    }

    fn vault_file_listing(root: &std::path::Path) -> BTreeSet<String> {
        fn collect(
            root: &std::path::Path,
            directory: &std::path::Path,
            files: &mut BTreeSet<String>,
        ) {
            for entry in std::fs::read_dir(directory).expect("read vault directory") {
                let entry = entry.expect("read vault entry");
                let path = entry.path();
                if entry.file_type().expect("inspect vault entry").is_dir() {
                    collect(root, &path, files);
                } else {
                    files.insert(
                        path.strip_prefix(root)
                            .expect("vault-relative path")
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
        }

        let mut files = BTreeSet::new();
        collect(root, root, &mut files);
        files
    }

    fn v3_test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory v3 database");
        install_notes_sql_functions(&connection).expect("install Notes SQL functions");
        connection
            .execute_batch(V3_SCHEMA_SQL)
            .expect("create explicit v3 schema");
        install_session_history(&connection).expect("install v3 session history");
        connection
    }

    #[test]
    fn explicit_v3_schema_has_plugin_and_nullable_readonly_columns() {
        let connection = v3_test_connection();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .expect("v3 schema version"),
            NOTES_SCHEMA_VERSION_V3
        );
        for column in ["plugin_state", "plugin_meta", "is_readonly"] {
            assert!(column_exists(&connection, "notes_nodes", column));
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' \
                     AND name IN ('notes_nodes_github_date_key', \
                                  'notes_nodes_github_notification_key')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("v3 GitHub ownership indexes"),
            2
        );
        assert_eq!(
            table_column_metadata(&connection, "notes_nodes", "is_readonly"),
            Some(("INTEGER".to_string(), 0, Some("0".to_string())))
        );
        let guarded_fts_triggers: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema \
                 WHERE type = 'trigger' \
                   AND name IN (\
                     'notes_nodes_search_insert', 'notes_nodes_search_update', \
                     'notes_nodes_search_delete', 'notes_nodes_lifecycle_search_insert', \
                     'notes_nodes_lifecycle_search_update', 'notes_nodes_lifecycle_search_delete', \
                     'notes_attachments_search_insert', 'notes_attachments_search_update', \
                     'notes_attachments_search_delete'\
                   ) \
                   AND sql LIKE '%plugin_meta%'",
                [],
                |row| row.get(0),
            )
            .expect("guarded v3 FTS triggers");
        assert_eq!(guarded_fts_triggers, 9);
        let guarded_root_fts_triggers: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema \
                 WHERE type = 'trigger' AND name LIKE 'notes_%search_%' \
                   AND sql LIKE '%6983f947-c134-44fc-bf46-db19f68125bf%'",
                [],
                |row| row.get(0),
            )
            .expect("root-guarded v3 FTS triggers");
        assert_eq!(guarded_root_fts_triggers, 9);
    }

    #[test]
    fn generic_placement_rejects_fixed_github_root_but_allows_provider_children() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            "#roadmap",
            "2026-07-11T00:00:01Z",
            None,
            None,
            Some(r#"{"kind":"date","date_key":"2026.07.11"}"#),
        );
        for (id, sort_key) in [(NODE_ID, 2048_i64), (FOURTH_ID, 3072), (SIXTH_ID, 4096)] {
            insert_v3_node(
                &connection,
                id,
                None,
                "ordinary root",
                "2026-07-11T00:00:02Z",
                Some(0),
                None,
                None,
            );
            connection
                .execute(
                    "UPDATE notes_nodes SET sort_key = ?1 WHERE id = ?2",
                    params![sort_key, id],
                )
                .expect("order generic placement fixture roots");
        }

        let before = sqlite_total_changes(&connection);
        let error = create_node_at(
            &mut connection,
            CreateNodeInput {
                id: SEVENTH_ID.to_string(),
                parent_id: Some(GITHUB_NOTIFICATIONS_ROOT_ID.to_string()),
                after_id: None,
                title: "ordinary child".to_string(),
                note: String::new(),
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            },
            fixed_today(),
        )
        .expect_err("generic create below the GN root must be rejected");
        assert!(error.contains("provider-owned"), "{error}");
        assert_eq!(sqlite_total_changes(&connection), before);

        let before = sqlite_total_changes(&connection);
        let error = import_subtree_at(
            &mut connection,
            ImportSubtreeInput {
                parent_id: Some(GITHUB_NOTIFICATIONS_ROOT_ID.to_string()),
                after_id: None,
                nodes: vec![import_leaf("ordinary import")],
            },
            fixed_today(),
        )
        .expect_err("generic subtree import below the GN root must be rejected");
        assert!(error.contains("provider-owned"), "{error}");
        assert_eq!(sqlite_total_changes(&connection), before);

        let before = sqlite_total_changes(&connection);
        let error = create_markdown_import_coordinated(
            &mut connection,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            None,
            vec![MarkdownImportNode {
                id: "99999999-9999-4999-8999-999999999999".to_string(),
                title: "ordinary markdown import".to_string(),
                note: String::new(),
                image_offset_utf16: 0,
                completed: false,
                attachment: None,
                children: Vec::new(),
            }],
            fixed_today(),
            || Ok(()),
        )
        .expect_err("generic Markdown import below the GN root must be rejected");
        assert!(error.contains("provider-owned"), "{error}");
        assert_eq!(sqlite_total_changes(&connection), before);

        let before = sqlite_total_changes(&connection);
        let error = move_node(
            &mut connection,
            MoveNodeInput {
                id: NODE_ID.to_string(),
                parent_id: Some(GITHUB_NOTIFICATIONS_ROOT_ID.to_string()),
                after_id: None,
                before_id: None,
            },
        )
        .expect_err("direct move below the GN root must be rejected");
        assert!(error.contains("provider-owned"), "{error}");
        assert_eq!(sqlite_total_changes(&connection), before);

        let before = sqlite_total_changes(&connection);
        let error = apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![FOURTH_ID.to_string()],
                op: BatchOp::Move {
                    parent_id: Some(GITHUB_NOTIFICATIONS_ROOT_ID.to_string()),
                    after_id: None,
                    before_id: None,
                },
            },
        )
        .expect_err("batch move below the GN root must be rejected");
        assert!(error.contains("provider-owned"), "{error}");
        assert_eq!(sqlite_total_changes(&connection), before);

        let before = sqlite_total_changes(&connection);
        let error = apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![
                    NODE_ID.to_string(),
                    FOURTH_ID.to_string(),
                    SIXTH_ID.to_string(),
                ],
                op: BatchOp::Indent,
            },
        )
        .expect_err("batch indent below the GN root must be rejected");
        assert!(error.contains("provider-owned"), "{error}");
        assert_eq!(sqlite_total_changes(&connection), before);

        insert_v3_node(
            &connection,
            EIGHTH_ID,
            Some(CHILD_ID),
            "ordinary child",
            "2026-07-11T00:00:03Z",
            Some(0),
            None,
            None,
        );
        let before = sqlite_total_changes(&connection);
        let error = apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![EIGHTH_ID.to_string()],
                op: BatchOp::Outdent,
            },
        )
        .expect_err("batch outdent into the GN root must be rejected");
        assert!(error.contains("provider-owned"), "{error}");
        assert_eq!(sqlite_total_changes(&connection), before);

        create_node_at(
            &mut connection,
            CreateNodeInput {
                id: SEVENTH_ID.to_string(),
                parent_id: Some(CHILD_ID.to_string()),
                after_id: None,
                title: "ordinary child under date".to_string(),
                note: String::new(),
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            },
            fixed_today(),
        )
        .expect("ordinary user children under provider date rows remain allowed");
        assert_eq!(
            node_shape(&connection, SEVENTH_ID).0,
            Some(CHILD_ID.to_string())
        );
    }

    fn insert_v3_node(
        connection: &Connection,
        id: &str,
        parent_id: Option<&str>,
        title: &str,
        updated_at: &str,
        is_readonly: Option<i64>,
        plugin_state: Option<&str>,
        plugin_meta: Option<&str>,
    ) {
        let note = if id == GITHUB_NOTIFICATIONS_ROOT_ID
            || plugin_meta.is_some_and(|metadata| metadata.contains(r#""kind":"date""#))
        {
            ""
        } else {
            title
        };
        connection
            .execute(
                "INSERT INTO notes_nodes (\
                   id, parent_id, sort_key, title, note, created_at, updated_at, \
                   is_readonly, plugin_state, plugin_meta\
                 ) VALUES (?1, ?2, 1024, ?3, ?4, ?5, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    parent_id,
                    title,
                    note,
                    updated_at,
                    is_readonly,
                    plugin_state,
                    plugin_meta
                ],
            )
            .expect("insert v3 node");
    }

    fn github_snapshot(date_key: &str, updated_at: &str) -> GithubNotificationSnapshotInput {
        GithubNotificationSnapshotInput {
            date_key: date_key.to_string(),
            notification_key:
                "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]"
                    .to_string(),
            title: "Fix inline caret #42".to_string(),
            note: "acme/yonalist, 9h ago, seen 6h ago".to_string(),
            notification_type: "Issue".to_string(),
            url: "https://github.com/acme/yonalist/issues/42".to_string(),
            updated_at: updated_at.to_string(),
            unread: true,
        }
    }

    fn github_snapshot_for(index: usize) -> GithubNotificationSnapshotInput {
        let notification_key =
            format!(r#"["github","[\"https://api.github.com\",\"account-7\"]","{index}"]"#);
        GithubNotificationSnapshotInput {
            date_key: "2026.07.21".to_string(),
            notification_key,
            title: format!("Notification {index}"),
            note: "acme/yonalist, 9h ago".to_string(),
            notification_type: "Issue".to_string(),
            url: format!("https://github.com/acme/yonalist/issues/{index}"),
            updated_at: "2026-07-21T10:00:00.000Z".to_string(),
            unread: true,
        }
    }

    #[test]
    fn github_refresh_notification_lookup_work_is_chunk_bounded() {
        for expected_count in [1usize, 400, 401, 1_000, 10_000] {
            let mut connection = v3_test_connection();
            insert_v3_node(
                &connection,
                GITHUB_NOTIFICATIONS_ROOT_ID,
                None,
                "Github Notifications",
                "2026-07-11T00:00:00Z",
                None,
                Some("[]"),
                None,
            );
            let date_key = "2026.07.21";
            let date_id = github_date_node_id(date_key).unwrap();
            let date_metadata =
                serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Date {
                    date_key: date_key.to_string(),
                })
                .unwrap();
            insert_v3_node(
                &connection,
                &date_id,
                Some(GITHUB_NOTIFICATIONS_ROOT_ID),
                date_key,
                "2026-07-11T00:00:01Z",
                None,
                None,
                Some(&date_metadata),
            );
            let mut snapshots = Vec::with_capacity(expected_count);
            for index in 0..expected_count {
                let snapshot = github_snapshot_for(index);
                let notification_id =
                    github_notification_node_id(&snapshot.notification_key).unwrap();
                let metadata = serialize_github_plugin_meta_storage(
                    &GithubNotificationsPluginMeta::Notification {
                        notification_key: snapshot.notification_key.clone(),
                        notification_type: snapshot.notification_type.clone(),
                        url: snapshot.url.clone(),
                        updated_at: snapshot.updated_at.clone(),
                        unread: true,
                    },
                )
                .unwrap();
                insert_v3_node(
                    &connection,
                    &notification_id,
                    Some(&date_id),
                    &snapshot.title,
                    "2026-07-11T00:00:02Z",
                    None,
                    None,
                    Some(&metadata),
                );
                snapshots.push(snapshot);
            }
            reset_github_notification_lookup_stats();

            refresh_materialized_github_notifications(
                &mut connection,
                RefreshGithubNotificationsInput {
                    root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                    notifications: snapshots,
                },
            )
            .expect("refresh a bounded provider batch");

            let (queries, visited) = github_notification_lookup_stats();
            assert_eq!(
                queries,
                expected_count.div_ceil(ANCESTOR_CLOSURE_CHUNK_SIZE)
            );
            assert_eq!(visited, expected_count);
        }
    }

    #[test]
    fn github_refresh_is_independent_of_caller_batch_order() {
        fn setup() -> (Connection, Vec<GithubNotificationSnapshotInput>) {
            let connection = v3_test_connection();
            insert_v3_node(
                &connection,
                GITHUB_NOTIFICATIONS_ROOT_ID,
                None,
                "Github Notifications",
                "2026-07-11T00:00:00Z",
                None,
                Some("[]"),
                None,
            );
            let mut incoming = Vec::new();
            for (index, old_date_key) in [(1usize, "2026.07.20"), (2, "2026.07.21")] {
                let old_date_id = github_date_node_id(old_date_key).unwrap();
                let date_metadata =
                    serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Date {
                        date_key: old_date_key.to_string(),
                    })
                    .unwrap();
                insert_v3_node(
                    &connection,
                    &old_date_id,
                    Some(GITHUB_NOTIFICATIONS_ROOT_ID),
                    old_date_key,
                    "2026-07-11T00:00:01Z",
                    None,
                    None,
                    Some(&date_metadata),
                );
                let mut snapshot = github_snapshot_for(index);
                snapshot.date_key = old_date_key.to_string();
                let metadata = serialize_github_plugin_meta_storage(
                    &GithubNotificationsPluginMeta::Notification {
                        notification_key: snapshot.notification_key.clone(),
                        notification_type: snapshot.notification_type.clone(),
                        url: snapshot.url.clone(),
                        updated_at: snapshot.updated_at.clone(),
                        unread: true,
                    },
                )
                .unwrap();
                insert_v3_node(
                    &connection,
                    &github_notification_node_id(&snapshot.notification_key).unwrap(),
                    Some(&old_date_id),
                    &snapshot.title,
                    "2026-07-11T00:00:02Z",
                    None,
                    None,
                    Some(&metadata),
                );
                snapshot.date_key = "2026.07.22".to_string();
                snapshot.updated_at = "2026-07-21T11:00:00.000Z".to_string();
                snapshot.title = format!("Newer {index}");
                incoming.push(snapshot);
            }
            let destination_id = github_date_node_id("2026.07.22").unwrap();
            let destination_metadata =
                serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Date {
                    date_key: "2026.07.22".to_string(),
                })
                .unwrap();
            insert_v3_node(
                &connection,
                &destination_id,
                Some(GITHUB_NOTIFICATIONS_ROOT_ID),
                "2026.07.22",
                "2026-07-11T00:00:03Z",
                None,
                None,
                Some(&destination_metadata),
            );
            insert_v3_node(
                &connection,
                FOURTH_ID,
                Some(&destination_id),
                "saved destination sibling",
                "2026-07-11T00:00:04Z",
                Some(0),
                None,
                None,
            );
            connection
                .execute(
                    "UPDATE notes_nodes SET sort_key = ?1 WHERE id = ?2",
                    params![i64::MAX, FOURTH_ID],
                )
                .unwrap();
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();
            (connection, incoming)
        }

        fn provider_fingerprint(
            connection: &Connection,
        ) -> (
            Vec<(String, Option<String>, i64, String, String, String)>,
            Vec<String>,
            Vec<String>,
        ) {
            let mut rows = connection
                .prepare(
                    "SELECT id, parent_id, sort_key, title, note, plugin_meta \
                     FROM notes_nodes WHERE plugin_meta IS NOT NULL ORDER BY id",
                )
                .unwrap();
            let provider_rows = rows
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            let mut dirty = connection
                .prepare("SELECT node_id FROM sync_dirty_nodes ORDER BY node_id")
                .unwrap();
            let dirty = dirty
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            let mut hlc_order = connection
                .prepare(
                    "SELECT id FROM notes_nodes \
                     WHERE json_extract(plugin_meta, '$.kind') = 'notification' \
                     ORDER BY hlc, id",
                )
                .unwrap();
            let hlc_order = hlc_order
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (provider_rows, dirty, hlc_order)
        }

        let (mut forward, snapshots) = setup();
        let mut reversed_snapshots = snapshots.clone();
        reversed_snapshots.reverse();
        let (mut reversed, _) = setup();

        refresh_materialized_github_notifications(
            &mut forward,
            RefreshGithubNotificationsInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notifications: snapshots,
            },
        )
        .unwrap();
        refresh_materialized_github_notifications(
            &mut reversed,
            RefreshGithubNotificationsInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notifications: reversed_snapshots,
            },
        )
        .unwrap();

        assert_eq!(
            provider_fingerprint(&forward),
            provider_fingerprint(&reversed)
        );
    }

    #[test]
    fn github_materialize_creates_authoritative_rows_and_an_unlocked_sibling() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");

        materialize_github_notification_and_create_sibling(
            &mut connection,
            MaterializeGithubNotificationSiblingInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                sibling_id: FOURTH_ID.to_string(),
                snapshot: snapshot.clone(),
            },
        )
        .expect("materialize GitHub notification and sibling");

        let date_id = github_date_node_id(&snapshot.date_key).unwrap();
        let notification_id = github_notification_node_id(&snapshot.notification_key).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, title, note, is_readonly, plugin_meta \
                     FROM notes_nodes WHERE id = ?1",
                    [&date_id],
                    |row| Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    )),
                )
                .unwrap(),
            (
                Some(GITHUB_NOTIFICATIONS_ROOT_ID.to_string()),
                "2026.07.21".to_string(),
                String::new(),
                None,
                Some(r#"{"kind":"date","date_key":"2026.07.21"}"#.to_string()),
            )
        );
        let notification = connection
            .query_row(
                "SELECT parent_id, title, note, is_readonly, plugin_meta, sort_key \
                 FROM notes_nodes WHERE id = ?1",
                [&notification_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(notification.0, Some(date_id.clone()));
        assert_eq!(notification.1, snapshot.title);
        assert_eq!(notification.2, snapshot.note);
        assert_eq!(notification.3, None);
        assert_eq!(
            crate::notes::github_notifications::parse_github_plugin_meta_storage(
                notification.4.as_deref().unwrap(),
            )
            .unwrap(),
            crate::notes::github_notifications::GithubNotificationsPluginMeta::Notification {
                notification_key: snapshot.notification_key.clone(),
                notification_type: snapshot.notification_type.clone(),
                url: snapshot.url.clone(),
                updated_at: snapshot.updated_at.clone(),
                unread: true,
            }
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, title, note, is_readonly, plugin_meta, sort_key \
                     FROM notes_nodes WHERE id = ?1",
                    [FOURTH_ID],
                    |row| Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                    )),
                )
                .unwrap(),
            (
                Some(date_id),
                String::new(),
                String::new(),
                Some(0),
                None,
                notification.5 + SORT_KEY_STEP,
            )
        );
    }

    #[test]
    fn github_materialize_imports_nested_children_without_a_blank_sibling() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");

        materialize_github_notification_and_import_children(
            &mut connection,
            GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
            snapshot.clone(),
            vec![
                ImportNode {
                    title: "first".to_string(),
                    note: None,
                    marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                    children: vec![ImportNode {
                        title: "nested".to_string(),
                        note: None,
                        marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                        children: vec![],
                    }],
                },
                ImportNode {
                    title: "second".to_string(),
                    note: None,
                    marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                    children: vec![],
                },
            ],
            fixed_today(),
        )
        .expect("materialize notification and imported children");

        let date_id = github_date_node_id(&snapshot.date_key).unwrap();
        let notification_id = github_notification_node_id(&snapshot.notification_key).unwrap();
        let date_children = connection
            .prepare(
                "SELECT title FROM notes_nodes WHERE parent_id = ?1 \
                 ORDER BY sort_key, id",
            )
            .unwrap()
            .query_map([&date_id], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(date_children, vec![snapshot.title]);
        let imported = connection
            .prepare(
                "SELECT id, title FROM notes_nodes WHERE parent_id = ?1 \
                 ORDER BY sort_key, id",
            )
            .unwrap()
            .query_map([&notification_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            imported.iter().map(|(_, title)| title).collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE parent_id = ?1",
                    [&imported[0].0],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "nested"
        );
    }

    #[test]
    fn github_materialize_appends_imported_children_and_returns_only_new_roots() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");

        let (_, first_roots) = materialize_github_notification_and_import_children(
            &mut connection,
            GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
            snapshot.clone(),
            vec![import_leaf("existing child")],
            fixed_today(),
        )
        .expect("first imported child");
        let (_, appended_roots) = materialize_github_notification_and_import_children(
            &mut connection,
            GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
            snapshot.clone(),
            vec![ImportNode {
                title: "appended child".to_string(),
                note: Some("supporting note".to_string()),
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                children: vec![],
            }],
            fixed_today(),
        )
        .expect("appended imported child");

        let notification_id = github_notification_node_id(&snapshot.notification_key).unwrap();
        let children = connection
            .prepare(
                "SELECT id, title, note, is_readonly, plugin_state, plugin_meta \
                 FROM notes_nodes WHERE parent_id = ?1 ORDER BY sort_key, id",
            )
            .unwrap()
            .query_map([&notification_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            children
                .iter()
                .map(|row| row.1.as_str())
                .collect::<Vec<_>>(),
            vec!["existing child", "appended child"]
        );
        assert_eq!(appended_roots, vec![children[1].0.clone()]);
        assert_ne!(first_roots, appended_roots);
        assert_eq!(children[1].2, "supporting note");
        assert_eq!(children[1].3, Some(0));
        assert_eq!(children[1].4, None);
        assert_eq!(children[1].5, None);
    }

    #[test]
    fn github_materialize_flat_import_ordering_work_is_linear_at_the_node_cap() {
        for node_count in [1usize, 400, MAX_IMPORT_SUBTREE_NODES] {
            let mut connection = v3_test_connection();
            insert_v3_node(
                &connection,
                GITHUB_NOTIFICATIONS_ROOT_ID,
                None,
                "Github Notifications",
                "2026-07-11T00:00:00Z",
                None,
                Some("[]"),
                None,
            );
            let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");
            let nodes = (0..node_count)
                .map(|index| import_leaf(&format!("child {index}")))
                .collect::<Vec<_>>();
            reset_sibling_order_stats();

            let (_, imported_root_ids) = materialize_github_notification_and_import_children(
                &mut connection,
                GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                snapshot,
                nodes,
                fixed_today(),
            )
            .expect("bounded flat materialize import");

            let (queries, visited_rows) = sibling_order_stats();
            assert_eq!(imported_root_ids.len(), node_count);
            assert!(
                queries <= 2,
                "{node_count} imported roots performed {queries} sibling-order queries"
            );
            assert!(
                visited_rows <= 2,
                "{node_count} imported roots revisited {visited_rows} sibling rows"
            );
        }
    }

    #[test]
    fn github_materialize_enforces_import_depth_and_count_caps_before_writes() {
        fn chain(depth: usize) -> ImportNode {
            let mut node = import_leaf(&format!("level {depth}"));
            for level in (1..depth).rev() {
                node = ImportNode {
                    title: format!("level {level}"),
                    note: None,
                    marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                    children: vec![node],
                };
            }
            node
        }

        let mut accepted = v3_test_connection();
        insert_v3_node(
            &accepted,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        materialize_github_notification_and_import_children(
            &mut accepted,
            GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
            github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z"),
            vec![chain(MAX_IMPORT_SUBTREE_DEPTH)],
            fixed_today(),
        )
        .expect("the exact depth cap is accepted");
        assert_eq!(
            accepted
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id != ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            (MAX_IMPORT_SUBTREE_DEPTH + 2) as i64,
        );

        for invalid_nodes in [
            vec![chain(MAX_IMPORT_SUBTREE_DEPTH + 1)],
            (0..=MAX_IMPORT_SUBTREE_NODES)
                .map(|index| import_leaf(&format!("child {index}")))
                .collect(),
        ] {
            let mut rejected = v3_test_connection();
            insert_v3_node(
                &rejected,
                GITHUB_NOTIFICATIONS_ROOT_ID,
                None,
                "Github Notifications",
                "2026-07-11T00:00:00Z",
                None,
                Some("[]"),
                None,
            );
            rejected
                .execute("DELETE FROM sync_dirty_nodes", [])
                .unwrap();

            materialize_github_notification_and_import_children(
                &mut rejected,
                GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z"),
                invalid_nodes,
                fixed_today(),
            )
            .expect_err("an import beyond a hard cap must be rejected");

            assert_eq!(
                rejected
                    .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row
                        .get::<_, i64>(0),)
                    .unwrap(),
                1
            );
            assert_eq!(
                rejected
                    .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| row
                        .get::<_, i64>(0),)
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn github_materialize_import_is_one_history_entry_with_undo_redo() {
        let mut connection = v3_test_connection();
        connection
            .execute(
                "INSERT INTO sync_meta(id, device_id, vault_uuid) VALUES (1, ?1, ?2)",
                params![NODE_ID, CHILD_ID],
            )
            .unwrap();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");
        let context = import_context("import");
        let mut imported_root_ids = Vec::new();

        let result =
            with_history_transaction_and_prunes(&mut connection, Some(&context), |connection| {
                let (workspace, root_ids) = materialize_github_notification_and_import_children(
                    connection,
                    GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                    snapshot.clone(),
                    vec![
                        import_leaf("first"),
                        ImportNode {
                            title: "second".to_string(),
                            note: None,
                            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                            children: vec![import_leaf("nested")],
                        },
                    ],
                    fixed_today(),
                )?;
                imported_root_ids = root_ids;
                Ok(workspace)
            })
            .expect("tracked materialize import");

        assert_eq!(
            result.history_entry_id.as_deref(),
            Some(context.entry_id.as_str())
        );
        assert_eq!(history_entry_count(&connection), 1);
        assert_eq!(imported_root_ids.len(), 2);
        let notification_id = github_notification_node_id(&snapshot.notification_key).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE parent_id = ?1",
                    [&notification_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );

        undo(
            &mut connection,
            &context.session_id,
            NotesWorkspaceScope::Active,
        )
        .expect("undo materialize import");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id != ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );

        redo(
            &mut connection,
            &context.session_id,
            NotesWorkspaceScope::Active,
        )
        .expect("redo materialize import");
        for id in &imported_root_ids {
            assert!(connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
                    [id],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap());
        }
        assert_eq!(history_entry_count(&connection), 1);
    }

    #[test]
    fn github_materialize_import_failure_rolls_back_provider_rows_children_dirty_and_history() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        connection
            .execute_batch(
                "CREATE TEMP TRIGGER fail_second_github_import \
                 BEFORE INSERT ON notes_nodes \
                 WHEN NEW.title = 'explode' \
                 BEGIN SELECT RAISE(ABORT, 'injected GitHub import failure'); END;",
            )
            .unwrap();
        let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");
        let context = import_context("import");

        let error =
            with_history_transaction_and_prunes(&mut connection, Some(&context), |connection| {
                materialize_github_notification_and_import_children(
                    connection,
                    GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                    snapshot.clone(),
                    vec![import_leaf("first"), import_leaf("explode")],
                    fixed_today(),
                )
                .map(|(workspace, _)| workspace)
            })
            .err()
            .expect("injected failure must roll back");

        assert!(error.contains("injected GitHub import failure"), "{error}");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id != ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(history_entry_count(&connection), 0);
    }

    #[test]
    fn github_first_materialization_appends_after_existing_saved_user_siblings() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");
        let date_id = github_date_node_id(&snapshot.date_key).unwrap();
        let date_metadata =
            serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Date {
                date_key: snapshot.date_key.clone(),
            })
            .unwrap();
        insert_v3_node(
            &connection,
            &date_id,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            &snapshot.date_key,
            "2026-07-11T00:00:01Z",
            None,
            None,
            Some(&date_metadata),
        );
        insert_v3_node(
            &connection,
            NODE_ID,
            Some(&date_id),
            "saved user sibling",
            "2026-07-11T00:00:02Z",
            Some(0),
            None,
            None,
        );

        materialize_github_notification_and_create_sibling(
            &mut connection,
            MaterializeGithubNotificationSiblingInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                sibling_id: FOURTH_ID.to_string(),
                snapshot: snapshot.clone(),
            },
        )
        .unwrap();

        let notification_id = github_notification_node_id(&snapshot.notification_key).unwrap();
        let ordered = connection
            .prepare(
                "SELECT id FROM notes_nodes WHERE parent_id = ?1 \
                 AND deleted_at IS NULL AND archived_at IS NULL ORDER BY sort_key, id",
            )
            .unwrap()
            .query_map([&date_id], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            ordered,
            vec![NODE_ID.to_string(), notification_id, FOURTH_ID.to_string()]
        );
    }

    #[test]
    fn github_provider_commands_reject_a_notification_outside_its_canonical_chain() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "ordinary root",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");
        materialize_github_notification_and_create_sibling(
            &mut connection,
            MaterializeGithubNotificationSiblingInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                sibling_id: FOURTH_ID.to_string(),
                snapshot: snapshot.clone(),
            },
        )
        .expect("materialize canonical notification");
        let notification_id =
            github_notification_node_id(&snapshot.notification_key).expect("notification ID");
        connection
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1 WHERE id = ?2",
                params![NODE_ID, notification_id],
            )
            .expect("detach notification from its date");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear corruption dirtiness");
        let before: String = connection
            .query_row(
                "SELECT plugin_meta FROM notes_nodes WHERE id = ?1",
                [&notification_id],
                |row| row.get(0),
            )
            .unwrap();

        assert!(mark_materialized_github_notification_read(
            &mut connection,
            MarkGithubNotificationReadInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notification_key: snapshot.notification_key,
                updated_at: snapshot.updated_at,
            },
        )
        .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT plugin_meta FROM notes_nodes WHERE id = ?1",
                    [&notification_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            before
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn github_materialize_rejects_key_ownership_at_the_wrong_id_before_dml() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");
        let metadata =
            serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Notification {
                notification_key: snapshot.notification_key.clone(),
                notification_type: snapshot.notification_type.clone(),
                url: snapshot.url.clone(),
                updated_at: snapshot.updated_at.clone(),
                unread: true,
            })
            .unwrap();
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            &snapshot.title,
            "2026-07-11T00:00:01Z",
            None,
            None,
            Some(&metadata),
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let before = sqlite_total_changes(&connection);

        let error = materialize_github_notification_and_create_sibling(
            &mut connection,
            MaterializeGithubNotificationSiblingInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                sibling_id: FOURTH_ID.to_string(),
                snapshot: snapshot.clone(),
            },
        )
        .expect_err("a canonical key at another ID must reject");

        assert!(error.contains("conflicting ownership"), "{error}");
        assert_eq!(sqlite_total_changes(&connection), before);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1 OR id = ?2",
                    params![
                        github_date_node_id(&snapshot.date_key).unwrap(),
                        github_notification_node_id(&snapshot.notification_key).unwrap()
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn github_materialize_retry_deduplicates_with_one_history_entry() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let input = MaterializeGithubNotificationSiblingInput {
            root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
            sibling_id: FOURTH_ID.to_string(),
            snapshot: github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z"),
        };
        let context = import_context("materializeGithubNotification");

        let result =
            with_history_transaction_and_prunes(&mut connection, Some(&context), |connection| {
                materialize_github_notification_and_create_sibling(connection, input.clone())
            })
            .expect("track materialization");
        assert_eq!(
            result.history_entry_id.as_deref(),
            Some(context.entry_id.as_str())
        );
        assert_eq!(history_entry_count(&connection), 1);
        let notification_id =
            github_notification_node_id(&input.snapshot.notification_key).unwrap();
        let fingerprint = connection
            .query_row(
                "SELECT hlc, parent_id, sort_key FROM notes_nodes WHERE id = ?1",
                [&notification_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .unwrap();

        let retry_context = NotesHistoryContext {
            entry_id: "99999999-9999-4999-8999-999999999999".to_string(),
            command_kind: "materializeGithubNotificationRetry".to_string(),
            ..context
        };
        let retry = with_history_transaction_and_prunes(
            &mut connection,
            Some(&retry_context),
            |connection| {
                materialize_github_notification_and_create_sibling(connection, input.clone())
            },
        )
        .expect("retry materialization");
        assert_eq!(retry.history_entry_id, None);
        assert_eq!(history_entry_count(&connection), 1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT hlc, parent_id, sort_key FROM notes_nodes WHERE id = ?1",
                    [&notification_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .unwrap(),
            fingerprint
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE plugin_meta IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
    }

    #[test]
    fn github_materialize_reparents_one_ordinary_subtree_atomically() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "ordinary root",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            "ordinary child",
            "2026-07-11T00:00:02Z",
            Some(0),
            None,
            None,
        );
        let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");

        materialize_github_notification_and_reparent(
            &mut connection,
            MaterializeGithubNotificationReparentInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                node_id: NODE_ID.to_string(),
                snapshot: snapshot.clone(),
            },
        )
        .expect("materialize and reparent ordinary subtree");

        let notification_id = github_notification_node_id(&snapshot.notification_key).unwrap();
        assert_eq!(
            node_shape(&connection, NODE_ID).0,
            Some(notification_id.clone())
        );
        assert_eq!(
            node_shape(&connection, CHILD_ID).0,
            Some(NODE_ID.to_string())
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1 OR id = ?2",
                    params![
                        github_date_node_id(&snapshot.date_key).unwrap(),
                        notification_id
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
    }

    #[test]
    fn github_refresh_moves_newer_snapshot_with_readonly_descendants_and_cleans_empty_anchor() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "ordinary root",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        let original = github_snapshot("2026.07.21", "2026-07-21T10:00:00.0001Z");
        materialize_github_notification_and_reparent(
            &mut connection,
            MaterializeGithubNotificationReparentInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                node_id: NODE_ID.to_string(),
                snapshot: original.clone(),
            },
        )
        .unwrap();
        let notification_id = github_notification_node_id(&original.notification_key).unwrap();
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(&notification_id),
            "readonly context",
            "2026-07-11T00:00:02Z",
            Some(1),
            None,
            None,
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let old_date_id = github_date_node_id(&original.date_key).unwrap();
        let mut newer = original.clone();
        newer.date_key = "2026.07.22".to_string();
        newer.updated_at = "2026-07-21T10:00:00.0009Z".to_string();
        newer.title = "Newer provider title #42".to_string();
        newer.note = "newer provider note".to_string();
        newer.notification_type = "PullRequest".to_string();
        newer.url = "https://github.com/acme/yonalist/pull/42".to_string();
        newer.unread = false;

        refresh_materialized_github_notifications(
            &mut connection,
            RefreshGithubNotificationsInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notifications: vec![newer.clone()],
            },
        )
        .expect("refresh newer materialized notification");

        let new_date_id = github_date_node_id(&newer.date_key).unwrap();
        assert_eq!(
            node_shape(&connection, &notification_id).0,
            Some(new_date_id)
        );
        assert_eq!(
            node_shape(&connection, CHILD_ID).0,
            Some(notification_id.clone())
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT is_readonly FROM notes_nodes WHERE id = ?1",
                    [CHILD_ID],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .unwrap(),
            Some(1)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [&old_date_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [&old_date_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        let (title, note, metadata) = connection
            .query_row(
                "SELECT title, note, plugin_meta FROM notes_nodes WHERE id = ?1",
                [&notification_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(title, newer.title);
        assert_eq!(note, newer.note);
        assert_eq!(
            crate::notes::github_notifications::parse_github_plugin_meta_storage(&metadata)
                .unwrap(),
            crate::notes::github_notifications::GithubNotificationsPluginMeta::Notification {
                notification_key: newer.notification_key,
                notification_type: newer.notification_type,
                url: newer.url,
                updated_at: newer.updated_at,
                unread: false,
            }
        );
    }

    #[test]
    fn github_refresh_keeps_an_old_anchor_pinned_by_an_inactive_child() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "ordinary root",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        let original = github_snapshot("2026.07.21", "2026-07-21T10:00:00.0001Z");
        materialize_github_notification_and_reparent(
            &mut connection,
            MaterializeGithubNotificationReparentInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                node_id: NODE_ID.to_string(),
                snapshot: original.clone(),
            },
        )
        .unwrap();
        let old_date_id = github_date_node_id(&original.date_key).unwrap();
        insert_v3_node(
            &connection,
            FOURTH_ID,
            Some(&old_date_id),
            "inactive context",
            "2026-07-11T00:00:02Z",
            Some(0),
            None,
            None,
        );
        connection
            .execute(
                "UPDATE notes_nodes SET archived_at = '2026-07-11T00:00:03Z' WHERE id = ?1",
                [FOURTH_ID],
            )
            .unwrap();
        let mut newer = original;
        newer.date_key = "2026.07.22".to_string();
        newer.updated_at = "2026-07-21T11:00:00.000Z".to_string();

        refresh_materialized_github_notifications(
            &mut connection,
            RefreshGithubNotificationsInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notifications: vec![newer],
            },
        )
        .expect("move notification while preserving inactive child parentage");

        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [&old_date_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [FOURTH_ID],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap(),
            Some(old_date_id)
        );
    }

    #[test]
    fn github_refresh_rebalances_root_once_when_a_new_date_block_overflows() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "ordinary root",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        let original = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");
        materialize_github_notification_and_reparent(
            &mut connection,
            MaterializeGithubNotificationReparentInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                node_id: NODE_ID.to_string(),
                snapshot: original.clone(),
            },
        )
        .unwrap();
        let old_date_id = github_date_node_id(&original.date_key).unwrap();
        connection
            .execute(
                "UPDATE notes_nodes SET sort_key = ?1 WHERE id = ?2",
                params![i64::MAX, old_date_id],
            )
            .unwrap();
        let mut newer = original;
        newer.date_key = "2026.07.22".to_string();
        newer.updated_at = "2026-07-21T11:00:00.000Z".to_string();

        refresh_materialized_github_notifications(
            &mut connection,
            RefreshGithubNotificationsInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notifications: vec![newer.clone()],
            },
        )
        .expect("one root rebalance should recover date allocation");

        let new_date_id = github_date_node_id(&newer.date_key).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT sort_key FROM notes_nodes WHERE id = ?1",
                    [&new_date_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            SORT_KEY_STEP * 2
        );
    }

    #[test]
    fn github_refresh_rebalances_destination_once_when_a_move_block_overflows() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "ordinary root",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        let original = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");
        materialize_github_notification_and_reparent(
            &mut connection,
            MaterializeGithubNotificationReparentInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                node_id: NODE_ID.to_string(),
                snapshot: original.clone(),
            },
        )
        .unwrap();
        let destination_key = "2026.07.22";
        let destination_id = github_date_node_id(destination_key).unwrap();
        let destination_metadata =
            serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Date {
                date_key: destination_key.to_string(),
            })
            .unwrap();
        insert_v3_node(
            &connection,
            &destination_id,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            destination_key,
            "2026-07-11T00:00:02Z",
            None,
            None,
            Some(&destination_metadata),
        );
        insert_v3_node(
            &connection,
            FOURTH_ID,
            Some(&destination_id),
            "saved destination sibling",
            "2026-07-11T00:00:03Z",
            Some(0),
            None,
            None,
        );
        connection
            .execute(
                "UPDATE notes_nodes SET sort_key = ?1 WHERE id = ?2",
                params![i64::MAX, FOURTH_ID],
            )
            .unwrap();
        let mut newer = original;
        newer.date_key = destination_key.to_string();
        newer.updated_at = "2026-07-21T11:00:00.000Z".to_string();

        refresh_materialized_github_notifications(
            &mut connection,
            RefreshGithubNotificationsInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notifications: vec![newer.clone()],
            },
        )
        .expect("one destination rebalance should recover move allocation");

        let notification_id = github_notification_node_id(&newer.notification_key).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT sort_key FROM notes_nodes WHERE id = ?1",
                    [FOURTH_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            SORT_KEY_STEP
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, sort_key FROM notes_nodes WHERE id = ?1",
                    [&notification_id],
                    |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?,)),
                )
                .unwrap(),
            (Some(destination_id), SORT_KEY_STEP * 2)
        );
    }

    #[test]
    fn github_refresh_failure_rolls_back_snapshot_anchor_subtree_dirty_and_history() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "ordinary root",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        let original = github_snapshot("2026.07.21", "2026-07-21T10:00:00.0001Z");
        materialize_github_notification_and_reparent(
            &mut connection,
            MaterializeGithubNotificationReparentInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                node_id: NODE_ID.to_string(),
                snapshot: original.clone(),
            },
        )
        .unwrap();
        let notification_id = github_notification_node_id(&original.notification_key).unwrap();
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let before_notification = connection
            .query_row(
                "SELECT parent_id, sort_key, title, note, hlc, plugin_meta \
                 FROM notes_nodes WHERE id = ?1",
                [&notification_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        let mut newer = original.clone();
        newer.date_key = "2026.07.22".to_string();
        newer.updated_at = "2026-07-21T10:00:00.0009Z".to_string();
        newer.title = "must roll back".to_string();
        connection
            .execute_batch(&format!(
                "CREATE TEMP TRIGGER fail_github_refresh \
                 BEFORE UPDATE OF parent_id ON notes_nodes \
                 WHEN OLD.id = '{notification_id}' \
                 BEGIN SELECT RAISE(ABORT, 'injected GitHub refresh failure'); END;"
            ))
            .unwrap();

        assert!(refresh_materialized_github_notifications(
            &mut connection,
            RefreshGithubNotificationsInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notifications: vec![newer.clone()],
            },
        )
        .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, sort_key, title, note, hlc, plugin_meta \
                     FROM notes_nodes WHERE id = ?1",
                    [&notification_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                        ))
                    },
                )
                .unwrap(),
            before_notification
        );
        assert_eq!(node_shape(&connection, NODE_ID).0, Some(notification_id));
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [github_date_node_id(&newer.date_key).unwrap()],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(history_entry_count(&connection), 0);
    }

    #[test]
    fn github_refresh_validates_the_whole_batch_before_updating_any_row() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        let date_key = "2026.07.21";
        let date_id = github_date_node_id(date_key).unwrap();
        let date_metadata =
            serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Date {
                date_key: date_key.to_string(),
            })
            .unwrap();
        insert_v3_node(
            &connection,
            &date_id,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            date_key,
            "2026-07-11T00:00:01Z",
            None,
            None,
            Some(&date_metadata),
        );
        let mut snapshots = [github_snapshot_for(1), github_snapshot_for(2)];
        for snapshot in &snapshots {
            let metadata = serialize_github_plugin_meta_storage(
                &GithubNotificationsPluginMeta::Notification {
                    notification_key: snapshot.notification_key.clone(),
                    notification_type: snapshot.notification_type.clone(),
                    url: snapshot.url.clone(),
                    updated_at: snapshot.updated_at.clone(),
                    unread: true,
                },
            )
            .unwrap();
            insert_v3_node(
                &connection,
                &github_notification_node_id(&snapshot.notification_key).unwrap(),
                Some(&date_id),
                &snapshot.title,
                "2026-07-11T00:00:02Z",
                None,
                None,
                Some(&metadata),
            );
        }
        let first_id = github_notification_node_id(&snapshots[0].notification_key).unwrap();
        let second_id = github_notification_node_id(&snapshots[1].notification_key).unwrap();
        connection
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1 WHERE id = ?2",
                params![GITHUB_NOTIFICATIONS_ROOT_ID, second_id],
            )
            .unwrap();
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let first_before = connection
            .query_row(
                "SELECT title, plugin_meta, hlc FROM notes_nodes WHERE id = ?1",
                [&first_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        snapshots[0].updated_at = "2026-07-21T11:00:00.000Z".to_string();
        snapshots[0].title = "must not be written".to_string();

        assert!(refresh_materialized_github_notifications(
            &mut connection,
            RefreshGithubNotificationsInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notifications: snapshots.into_iter().collect(),
            },
        )
        .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT title, plugin_meta, hlc FROM notes_nodes WHERE id = ?1",
                    [&first_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .unwrap(),
            first_before
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn github_refresh_rejects_duplicate_old_date_key_ownership_before_dml() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        let original = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");
        materialize_github_notification_and_create_sibling(
            &mut connection,
            MaterializeGithubNotificationSiblingInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                sibling_id: FOURTH_ID.to_string(),
                snapshot: original.clone(),
            },
        )
        .unwrap();
        connection
            .execute("DROP INDEX notes_nodes_github_date_key", [])
            .unwrap();
        let duplicate_metadata =
            serialize_github_plugin_meta_storage(&GithubNotificationsPluginMeta::Date {
                date_key: original.date_key.clone(),
            })
            .unwrap();
        insert_v3_node(
            &connection,
            NODE_ID,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            &original.date_key,
            "2026-07-11T00:00:03Z",
            None,
            None,
            Some(&duplicate_metadata),
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let notification_id = github_notification_node_id(&original.notification_key).unwrap();
        let before = connection
            .query_row(
                "SELECT title, plugin_meta, hlc FROM notes_nodes WHERE id = ?1",
                [&notification_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        let total_changes = sqlite_total_changes(&connection);
        let mut newer = original;
        newer.updated_at = "2026-07-21T11:00:00.000Z".to_string();
        newer.title = "must not be written".to_string();

        let error = refresh_materialized_github_notifications(
            &mut connection,
            RefreshGithubNotificationsInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notifications: vec![newer],
            },
        )
        .expect_err("duplicate old date ownership must reject");

        assert!(error.contains("conflicting ownership"), "{error}");
        assert_eq!(sqlite_total_changes(&connection), total_changes);
        assert_eq!(
            connection
                .query_row(
                    "SELECT title, plugin_meta, hlc FROM notes_nodes WHERE id = ?1",
                    [&notification_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .unwrap(),
            before
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn github_mark_read_is_monotonic_and_retry_is_a_noop() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        let snapshot = github_snapshot("2026.07.21", "2026-07-21T10:00:00.000Z");
        materialize_github_notification_and_create_sibling(
            &mut connection,
            MaterializeGithubNotificationSiblingInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                sibling_id: FOURTH_ID.to_string(),
                snapshot: snapshot.clone(),
            },
        )
        .unwrap();
        let notification_id = github_notification_node_id(&snapshot.notification_key).unwrap();
        let before_hlc = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [&notification_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        mark_materialized_github_notification_read(
            &mut connection,
            MarkGithubNotificationReadInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notification_key: snapshot.notification_key.clone(),
                updated_at: "2026-07-21T10:00:00Z".to_string(),
            },
        )
        .expect("mark materialized notification read");
        let (after_hlc, metadata, completed_at) = connection
            .query_row(
                "SELECT hlc, plugin_meta, completed_at FROM notes_nodes WHERE id = ?1",
                [&notification_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_ne!(after_hlc, before_hlc);
        assert_eq!(completed_at, None);
        assert!(matches!(
            crate::notes::github_notifications::parse_github_plugin_meta_storage(&metadata)
                .unwrap(),
            crate::notes::github_notifications::GithubNotificationsPluginMeta::Notification {
                unread: false,
                ..
            }
        ));

        mark_materialized_github_notification_read(
            &mut connection,
            MarkGithubNotificationReadInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notification_key: snapshot.notification_key.clone(),
                updated_at: snapshot.updated_at.clone(),
            },
        )
        .expect("retry mark read");
        assert_eq!(
            connection
                .query_row(
                    "SELECT hlc FROM notes_nodes WHERE id = ?1",
                    [&notification_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            after_hlc
        );

        let mut stale = snapshot.clone();
        stale.title = "stale title must not win".to_string();
        refresh_materialized_github_notifications(
            &mut connection,
            RefreshGithubNotificationsInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                notifications: vec![stale],
            },
        )
        .unwrap();
        let (title, metadata) = connection
            .query_row(
                "SELECT title, plugin_meta FROM notes_nodes WHERE id = ?1",
                [&notification_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(title, snapshot.title);
        assert!(metadata.contains(r#""unread":false"#));
    }

    #[test]
    fn github_group_collapse_is_an_explicit_sorted_idempotent_set() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();

        for group_key in ["2026.07.22", "2026.07.21"] {
            set_github_group_collapsed(
                &mut connection,
                SetGithubGroupCollapsedInput {
                    root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                    group_key: group_key.to_string(),
                    collapsed: true,
                },
            )
            .unwrap();
        }
        let (hlc, state) = connection
            .query_row(
                "SELECT hlc, plugin_state FROM notes_nodes WHERE id = ?1",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(state, r#"["2026.07.21","2026.07.22"]"#);

        set_github_group_collapsed(
            &mut connection,
            SetGithubGroupCollapsedInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                group_key: "2026.07.21".to_string(),
                collapsed: true,
            },
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT hlc FROM notes_nodes WHERE id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            hlc
        );

        set_github_group_collapsed(
            &mut connection,
            SetGithubGroupCollapsedInput {
                root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                group_key: "2026.07.21".to_string(),
                collapsed: false,
            },
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT plugin_state FROM notes_nodes WHERE id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            r#"["2026.07.22"]"#
        );
    }

    #[test]
    fn github_group_collapse_uses_one_history_entry_and_undo_redo() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        let before_hlc = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let context = import_context("setGithubGroupCollapsed");

        let result =
            with_history_transaction_and_prunes(&mut connection, Some(&context), |connection| {
                set_github_group_collapsed(
                    connection,
                    SetGithubGroupCollapsedInput {
                        root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                        group_key: "2026.07.21".to_string(),
                        collapsed: true,
                    },
                )
            })
            .expect("track GitHub group collapse");
        assert_eq!(
            result.history_entry_id.as_deref(),
            Some(context.entry_id.as_str())
        );
        assert_eq!(history_entry_count(&connection), 1);
        let after_hlc = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert!(after_hlc > before_hlc);
        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_dirty_nodes WHERE node_id = ?1)",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());

        undo(
            &mut connection,
            &context.session_id,
            NotesWorkspaceScope::Active,
        )
        .expect("undo GitHub group collapse");
        assert_eq!(
            connection
                .query_row(
                    "SELECT plugin_state FROM notes_nodes WHERE id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "[]"
        );
        redo(
            &mut connection,
            &context.session_id,
            NotesWorkspaceScope::Active,
        )
        .expect("redo GitHub group collapse");
        assert_eq!(
            connection
                .query_row(
                    "SELECT plugin_state FROM notes_nodes WHERE id = ?1",
                    [GITHUB_NOTIFICATIONS_ROOT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            r#"["2026.07.21"]"#
        );

        let retry_context = NotesHistoryContext {
            entry_id: "99999999-9999-4999-8999-999999999999".to_string(),
            command_kind: "setGithubGroupCollapsedRetry".to_string(),
            ..context
        };
        let retry = with_history_transaction_and_prunes(
            &mut connection,
            Some(&retry_context),
            |connection| {
                set_github_group_collapsed(
                    connection,
                    SetGithubGroupCollapsedInput {
                        root_id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                        group_key: "2026.07.21".to_string(),
                        collapsed: true,
                    },
                )
            },
        )
        .expect("same GitHub group state is a tracked no-op");
        assert_eq!(retry.history_entry_id, None);
        assert_eq!(history_entry_count(&connection), 1);
    }

    #[test]
    fn readonly_content_and_structure_guards_are_repository_authoritative() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            "locked",
            "2026-07-11T00:00:01Z",
            Some(1),
            None,
            None,
        );

        let update = update_node_at(
            &mut connection,
            UpdateNodeInput {
                id: CHILD_ID.to_string(),
                title: "changed".to_string(),
                note: String::new(),
                image_offset_utf16: 0,
                markdown_image_width: None,
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            },
            fixed_today(),
        );
        assert!(update.is_err(), "readonly content must be blocked");

        let move_result = move_node(
            &mut connection,
            MoveNodeInput {
                id: CHILD_ID.to_string(),
                parent_id: None,
                after_id: None,
                before_id: None,
            },
        );
        assert!(
            move_result.is_err(),
            "readonly subtree move must be blocked"
        );

        assert!(toggle_complete(&mut connection, CHILD_ID).is_ok());
        assert!(toggle_star(&mut connection, CHILD_ID).is_ok());
        assert!(toggle_collapsed(&mut connection, CHILD_ID).is_ok());

        let duplicate = duplicate_node_at(&mut connection, CHILD_ID, fixed_today());
        assert!(duplicate.is_ok(), "readonly duplication preserves the flag");
        let duplicate_workspace = duplicate.expect("duplicate workspace");
        let duplicate = duplicate_workspace
            .nodes
            .iter()
            .find(|node| node.id != CHILD_ID && node.title == "locked")
            .expect("duplicated readonly node");
        assert_ne!(duplicate.id, CHILD_ID);
        assert_eq!(duplicate.is_readonly, Some(true));
    }

    #[test]
    fn readonly_mutations_reject_attachment_and_delete_paths_without_writes() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            "locked",
            "2026-07-11T00:00:01Z",
            Some(1),
            None,
            None,
        );
        assert!(delete_nodes(
            &mut connection,
            DeleteNodesInput {
                node_ids: vec![CHILD_ID.to_string()],
                expected_readonly_descendant_ids: None,
            },
        )
        .is_err());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(remove_empty_node(&mut connection, CHILD_ID).is_err());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![CHILD_ID.to_string()],
                op: BatchOp::Delete,
            },
        )
        .is_err());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );

        assert!(create_attachments_coordinated_for_node(
            &mut connection,
            CHILD_ID,
            vec![test_new_attachment(701, CHILD_ID)],
            || Ok(()),
            || Ok(()),
        )
        .is_err());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );

        let attachment_id = insert_test_attachment(&connection, 702, CHILD_ID);
        assert!(resize_attachment(&mut connection, &attachment_id, 120).is_err());
        assert!(remove_attachment(&mut connection, &attachment_id).is_err());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }

    #[test]
    fn nested_selection_delete_preloads_archive_context_for_direct_and_batch_delete() {
        let mut direct = v3_test_connection();
        insert_v3_node(
            &direct,
            NODE_ID,
            None,
            "root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &direct,
            CHILD_ID,
            Some(NODE_ID),
            "child",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        assert!(matches!(
            delete_nodes(
                &mut direct,
                DeleteNodesInput {
                    node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                    expected_readonly_descendant_ids: Some(Vec::new()),
                },
            )
            .expect("nested direct delete"),
            DeleteNodesOutcome::Deleted(_)
        ));
        assert_eq!(
            direct
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
        assert_eq!(
            direct
                .query_row(
                    "SELECT COUNT(DISTINCT deleted_batch_id) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        let mut batch = v3_test_connection();
        insert_v3_node(
            &batch,
            NODE_ID,
            None,
            "root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &batch,
            CHILD_ID,
            Some(NODE_ID),
            "child",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        apply_batch(
            &mut batch,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                op: BatchOp::Delete,
            },
        )
        .expect("nested batch delete");
        assert_eq!(
            batch
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
        assert_eq!(
            batch
                .query_row(
                    "SELECT COUNT(DISTINCT deleted_batch_id) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        let mut archived = v3_test_connection();
        insert_v3_node(
            &archived,
            NODE_ID,
            None,
            "archived root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &archived,
            CHILD_ID,
            Some(NODE_ID),
            "archived child",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        archive_node(&mut archived, NODE_ID).expect("archive nested tree");
        assert!(matches!(
            delete_nodes(
                &mut archived,
                DeleteNodesInput {
                    node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                    expected_readonly_descendant_ids: Some(Vec::new()),
                },
            )
            .expect("nested archived direct delete"),
            DeleteNodesOutcome::Deleted(_)
        ));
        assert_eq!(
            archived
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
        assert_eq!(
            archived
                .query_row(
                    "SELECT COUNT(DISTINCT deleted_batch_id) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        let mut archived_batch = v3_test_connection();
        insert_v3_node(
            &archived_batch,
            NODE_ID,
            None,
            "archived root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &archived_batch,
            CHILD_ID,
            Some(NODE_ID),
            "archived child",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        archive_node(&mut archived_batch, NODE_ID).expect("archive batch tree");
        assert!(delete_nodes(
            &mut archived_batch,
            DeleteNodesInput {
                node_ids: vec![CHILD_ID.to_string()],
                expected_readonly_descendant_ids: Some(Vec::new()),
            },
        )
        .is_err());
        apply_batch(
            &mut archived_batch,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                op: BatchOp::Delete,
            },
        )
        .expect("nested archived batch delete");
        assert_eq!(
            archived_batch
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
        assert_eq!(
            archived_batch
                .query_row(
                    "SELECT COUNT(DISTINCT deleted_batch_id) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn explicit_readonly_delete_selection_is_rejected_before_forest_normalization() {
        for archived in [false, true] {
            let mut connection = v3_test_connection();
            insert_v3_node(
                &connection,
                NODE_ID,
                None,
                "root",
                "2026-07-11T00:00:00Z",
                Some(0),
                None,
                None,
            );
            insert_v3_node(
                &connection,
                CHILD_ID,
                Some(NODE_ID),
                "readonly child",
                "2026-07-11T00:00:01Z",
                Some(1),
                None,
                None,
            );
            if archived {
                archive_node(&mut connection, NODE_ID).expect("archive readonly tree");
            }

            let snapshot = |connection: &Connection| {
                let hlc = connection
                    .prepare("SELECT id, hlc FROM notes_nodes WHERE id IN (?1, ?2) ORDER BY id")
                    .expect("prepare delete HLC snapshot")
                    .query_map(params![NODE_ID, CHILD_ID], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .expect("query delete HLC snapshot")
                    .collect::<Result<Vec<_>, _>>()
                    .expect("collect delete HLC snapshot");
                let dirty: i64 = connection
                    .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                        row.get(0)
                    })
                    .expect("dirty snapshot");
                let trash: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                        [],
                        |row| row.get(0),
                    )
                    .expect("trash snapshot");
                let history: i64 = connection
                    .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                        row.get(0)
                    })
                    .expect("history snapshot");
                (hlc, dirty, trash, history)
            };

            let expected = snapshot(&connection);
            let before_changes = sqlite_total_changes(&connection);
            let input = DeleteNodesInput {
                node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                expected_readonly_descendant_ids: None,
            };
            let error = delete_nodes_preflight(&mut connection, &input)
                .expect_err("readonly selection must fail preflight authorization");
            assert!(error.contains("read-only"), "{error}");
            assert_eq!(sqlite_total_changes(&connection), before_changes);
            assert_eq!(snapshot(&connection), expected);

            let before_changes = sqlite_total_changes(&connection);
            let error = delete_nodes(
                &mut connection,
                DeleteNodesInput {
                    node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                    expected_readonly_descendant_ids: Some(vec![CHILD_ID.to_string()]),
                },
            )
            .expect_err("readonly selection must fail confirmed deletion authorization");
            assert!(error.contains("read-only"), "{error}");
            assert_eq!(sqlite_total_changes(&connection), before_changes);
            assert_eq!(snapshot(&connection), expected);

            let before_changes = sqlite_total_changes(&connection);
            let error = apply_batch(
                &mut connection,
                ApplyBatchInput {
                    node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                    op: BatchOp::Delete,
                },
            )
            .expect_err("readonly selection must fail batch deletion authorization");
            assert!(error.contains("read-only"), "{error}");
            assert_eq!(sqlite_total_changes(&connection), before_changes);
            assert_eq!(snapshot(&connection), expected);
        }
    }

    #[test]
    fn readonly_preflight_scales_with_union_tree_after_selection_normalization() {
        for selected_count in [1_usize, 400, 401, 10_000] {
            let mut connection = v3_test_connection();
            let root_id = format!("10000000-0000-4000-8000-{selected_count:012x}");
            insert_v3_node(
                &connection,
                &root_id,
                None,
                "root",
                "2026-07-11T00:00:00Z",
                Some(0),
                None,
                None,
            );
            let mut selected_ids = vec![root_id.clone()];
            for index in 1..selected_count {
                let child_id = format!("20000000-0000-4000-8000-{index:012x}");
                insert_v3_node(
                    &connection,
                    &child_id,
                    Some(&root_id),
                    "selected",
                    "2026-07-11T00:00:01Z",
                    Some(0),
                    None,
                    None,
                );
                selected_ids.push(child_id);
            }
            let readonly_id = format!("20000000-0000-4000-8000-{:012x}", selected_count);
            insert_v3_node(
                &connection,
                &readonly_id,
                Some(&root_id),
                "readonly",
                "2026-07-11T00:00:02Z",
                Some(1),
                None,
                None,
            );

            reset_readonly_descendant_scan_stats();
            let readonly_ids = delete_nodes_preflight(
                &mut connection,
                &DeleteNodesInput {
                    node_ids: selected_ids,
                    expected_readonly_descendant_ids: None,
                },
            )
            .expect("readonly preflight");
            assert_eq!(readonly_ids, vec![readonly_id]);
            assert_eq!(
                readonly_descendant_scan_stats(),
                (1, selected_count + 1),
                "overlapping selection of {selected_count} rows must scan the normalized union once"
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn readonly_setter_and_delete_confirmation_are_atomic() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            "child",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );

        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear dirty markers before readonly setter");
        let before_hlc: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("readonly HLC before setter");
        let context = import_context("setReadonly");
        let set_result =
            with_history_transaction_and_prunes(&mut connection, Some(&context), |connection| {
                set_readonly_at(connection, CHILD_ID.to_string(), true, fixed_today())
            })
            .expect("set readonly with history");
        assert_eq!(
            set_result.history_entry_id.as_deref(),
            Some(context.entry_id.as_str())
        );
        let after_hlc: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("readonly HLC after setter");
        assert!(after_hlc > before_hlc);
        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_dirty_nodes WHERE node_id = ?1)",
                [NODE_ID],
                |row| row.get::<_, bool>(0),
            )
            .expect("owning topic dirty marker"));
        assert_eq!(history_entry_count(&connection), 1);
        let readonly: Option<i64> = connection
            .query_row(
                "SELECT is_readonly FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("readonly value");
        assert_eq!(readonly, Some(1));

        let before_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("node count");
        let first = delete_nodes(
            &mut connection,
            DeleteNodesInput {
                node_ids: vec![NODE_ID.to_string()],
                expected_readonly_descendant_ids: None,
            },
        )
        .expect("delete preflight");
        let DeleteNodesOutcome::NeedsReadonlyConfirmation {
            readonly_descendant_ids,
        } = first
        else {
            panic!("expected readonly confirmation");
        };
        assert_eq!(readonly_descendant_ids, vec![CHILD_ID.to_string()]);
        let after_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("node count");
        assert_eq!(before_count, after_count);

        let deleted = delete_nodes(
            &mut connection,
            DeleteNodesInput {
                node_ids: vec![NODE_ID.to_string()],
                expected_readonly_descendant_ids: Some(vec![CHILD_ID.to_string()]),
            },
        )
        .expect("confirmed delete");
        assert!(matches!(deleted, DeleteNodesOutcome::Deleted(_)));
        let restored = restore_node(&mut connection, NODE_ID).expect("restore readonly tree");
        assert_eq!(
            restored
                .nodes
                .iter()
                .find(|node| node.id == CHILD_ID)
                .expect("restored readonly child")
                .is_readonly,
            Some(true)
        );
    }

    #[test]
    fn readonly_setter_matrix_covers_ordinary_root_child_and_plugin_rows() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "ordinary root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            "ordinary child",
            "2026-07-11T00:00:01Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:02Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            THIRD_ID,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            "2026.07.11",
            "2026-07-11T00:00:03Z",
            None,
            None,
            Some(r#"{"kind":"date","date_key":"2026.07.11"}"#),
        );

        let root_hlc_before: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("ordinary root HLC before setter");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear root dirty markers");
        let root_context = NotesHistoryContext {
            session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
            entry_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_string(),
            command_kind: "setReadonlyRoot".to_string(),
        };
        with_history_transaction_and_prunes(&mut connection, Some(&root_context), |connection| {
            set_readonly_at(connection, NODE_ID.to_string(), true, fixed_today())
        })
        .expect("set ordinary root readonly");
        let root_hlc_after: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("ordinary root HLC after setter");
        assert!(root_hlc_after > root_hlc_before);
        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_dirty_nodes WHERE node_id = ?1)",
                [NODE_ID],
                |row| row.get::<_, bool>(0),
            )
            .expect("ordinary root dirty marker"));
        assert_eq!(history_entry_count(&connection), 1);

        let child_hlc_before: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("ordinary child HLC before setter");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear child dirty markers");
        let child_context = NotesHistoryContext {
            session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
            entry_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd".to_string(),
            command_kind: "setReadonlyChild".to_string(),
        };
        with_history_transaction_and_prunes(&mut connection, Some(&child_context), |connection| {
            set_readonly_at(connection, CHILD_ID.to_string(), true, fixed_today())
        })
        .expect("set ordinary child readonly");
        let child_hlc_after: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("ordinary child HLC after setter");
        assert!(child_hlc_after > child_hlc_before);
        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_dirty_nodes WHERE node_id = ?1)",
                [NODE_ID],
                |row| row.get::<_, bool>(0),
            )
            .expect("ordinary child owning topic dirty marker"));
        assert_eq!(history_entry_count(&connection), 2);

        assert!(set_readonly_at(
            &mut connection,
            GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
            true,
            fixed_today()
        )
        .is_err());
        assert!(
            set_readonly_at(&mut connection, THIRD_ID.to_string(), true, fixed_today()).is_err()
        );
        assert_eq!(history_entry_count(&connection), 2);
    }

    #[test]
    fn readonly_delete_preflight_serializes_as_the_untagged_wire_shape() {
        let value = serde_json::to_value(DeleteNodesOutcome::NeedsReadonlyConfirmation {
            readonly_descendant_ids: vec![CHILD_ID.to_string()],
        })
        .expect("serialize readonly preflight");
        assert_eq!(
            value,
            serde_json::json!({"readonlyDescendantIds": [CHILD_ID]})
        );
    }

    #[test]
    fn confirmed_readonly_delete_rolls_back_rows_trash_and_history_on_failure() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            "locked",
            "2026-07-11T00:00:01Z",
            Some(1),
            None,
            None,
        );
        connection
            .execute_batch(&format!(
                "CREATE TRIGGER reject_confirmed_delete \
                 BEFORE UPDATE OF deleted_at ON notes_nodes \
                 WHEN OLD.id = '{CHILD_ID}' \
                 BEGIN SELECT RAISE(ABORT, 'confirmed delete rejected'); END;"
            ))
            .expect("install delete failure");
        let context = import_context("deleteNodes");
        let error = match with_history_transaction_and_prunes(
            &mut connection,
            Some(&context),
            |connection| {
                let outcome = delete_nodes(
                    connection,
                    DeleteNodesInput {
                        node_ids: vec![NODE_ID.to_string()],
                        expected_readonly_descendant_ids: Some(vec![CHILD_ID.to_string()]),
                    },
                )?;
                match outcome {
                    DeleteNodesOutcome::Deleted(result) => Ok(result.workspace),
                    DeleteNodesOutcome::NeedsReadonlyConfirmation { .. } => {
                        Err("unexpected delete preflight".to_string())
                    }
                }
            },
        ) {
            Ok(_) => panic!("injected confirmed delete failure must fail"),
            Err(error) => error,
        };
        assert!(error.contains("confirmed delete rejected"), "{error}");
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
                    "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(history_entry_count(&connection), 0);
    }

    #[test]
    fn generic_commands_reject_plugin_rows_but_github_root_collapse_stays_allowed() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-11T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            "2026.07.11",
            "2026-07-11T00:00:01Z",
            None,
            None,
            Some(r#"{"kind":"date","date_key":"2026.07.11"}"#),
        );

        assert!(toggle_complete(&mut connection, GITHUB_NOTIFICATIONS_ROOT_ID).is_err());
        assert!(toggle_star(&mut connection, CHILD_ID).is_err());
        assert!(archive_node(&mut connection, GITHUB_NOTIFICATIONS_ROOT_ID).is_err());
        assert!(unarchive_node(&mut connection, CHILD_ID).is_err());
        assert!(toggle_collapsed(&mut connection, CHILD_ID).is_err());
        assert!(sort_subtree_ascending(&mut connection, GITHUB_NOTIFICATIONS_ROOT_ID).is_err());
        assert!(
            set_readonly_at(&mut connection, CHILD_ID.to_string(), true, fixed_today()).is_err()
        );

        let before = sqlite_total_changes(&connection);
        assert!(apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![CHILD_ID.to_string()],
                op: BatchOp::AddTag {
                    tag: NoteSearchTag {
                        prefix: NoteTagPrefix::Hash,
                        normalized_tag: "roadmap".to_string(),
                        display_tag: "#roadmap".to_string(),
                    },
                },
            },
        )
        .is_err());
        assert!(apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![CHILD_ID.to_string()],
                op: BatchOp::RemoveTag {
                    tag: NoteTagFilter {
                        prefix: NoteTagPrefix::Hash,
                        normalized_tag: "missing".to_string(),
                    },
                },
            },
        )
        .is_err());
        assert_eq!(sqlite_total_changes(&connection), before);

        collapse_all(&mut connection, GITHUB_NOTIFICATIONS_ROOT_ID).expect("collapse GN root");
        let root_collapsed: i64 = connection
            .query_row(
                "SELECT is_collapsed FROM notes_nodes WHERE id = ?1",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
                |row| row.get(0),
            )
            .expect("read collapsed root");
        assert_eq!(root_collapsed, 1);
        let child_collapsed: i64 = connection
            .query_row(
                "SELECT is_collapsed FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("read collapsed child");
        assert_eq!(child_collapsed, 0);

        assert!(move_node(
            &mut connection,
            MoveNodeInput {
                id: GITHUB_NOTIFICATIONS_ROOT_ID.to_string(),
                parent_id: Some(CHILD_ID.to_string()),
                after_id: None,
                before_id: None,
            }
        )
        .is_err());
        assert!(apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![GITHUB_NOTIFICATIONS_ROOT_ID.to_string()],
                op: BatchOp::Complete { completed: true },
            }
        )
        .is_err());
        assert!(apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![GITHUB_NOTIFICATIONS_ROOT_ID.to_string()],
                op: BatchOp::Move {
                    parent_id: Some(CHILD_ID.to_string()),
                    after_id: None,
                    before_id: None,
                },
            }
        )
        .is_err());
    }

    #[test]
    fn readonly_delete_preflight_includes_archived_root_subtrees_and_confirmed_trash() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "archived root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            "locked child",
            "2026-07-11T00:00:01Z",
            Some(1),
            None,
            None,
        );
        archive_node(&mut connection, NODE_ID).expect("archive root");

        let first = delete_nodes_preflight(
            &mut connection,
            &DeleteNodesInput {
                node_ids: vec![NODE_ID.to_string()],
                expected_readonly_descendant_ids: None,
            },
        )
        .expect("archived preflight");
        assert_eq!(first, vec![CHILD_ID.to_string()]);
        let deleted_before: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("count trash before confirmation");
        assert_eq!(deleted_before, 0);

        delete_nodes(
            &mut connection,
            DeleteNodesInput {
                node_ids: vec![NODE_ID.to_string()],
                expected_readonly_descendant_ids: Some(first),
            },
        )
        .expect("confirmed archived delete");
        let deleted_after: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("count trash after confirmation");
        assert_eq!(deleted_after, 2);
    }

    #[test]
    fn readonly_delete_confirmation_rechecks_added_removed_and_direct_targets() {
        let mut connection = v3_test_connection();
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "root",
            "2026-07-11T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            "locked",
            "2026-07-11T00:00:01Z",
            Some(1),
            None,
            None,
        );
        let input = DeleteNodesInput {
            node_ids: vec![NODE_ID.to_string()],
            expected_readonly_descendant_ids: None,
        };
        let expected = delete_nodes_preflight(&mut connection, &input).expect("preflight");
        assert_eq!(expected, vec![CHILD_ID.to_string()]);

        insert_v3_node(
            &connection,
            THIRD_ID,
            Some(CHILD_ID),
            "new locked",
            "2026-07-11T00:00:02Z",
            Some(1),
            None,
            None,
        );
        let stale_added = delete_nodes(
            &mut connection,
            DeleteNodesInput {
                node_ids: vec![NODE_ID.to_string()],
                expected_readonly_descendant_ids: Some(expected.clone()),
            },
        )
        .expect_err("new readonly descendant must stale the confirmation");
        assert_eq!(stale_added, "Notes readonly delete confirmation is stale.");

        connection
            .execute(
                "UPDATE notes_nodes SET is_readonly = 0 WHERE id = ?1",
                [CHILD_ID],
            )
            .expect("remove readonly child");
        let stale_removed = delete_nodes(
            &mut connection,
            DeleteNodesInput {
                node_ids: vec![NODE_ID.to_string()],
                expected_readonly_descendant_ids: Some(expected),
            },
        )
        .expect_err("removed readonly descendant must stale the confirmation");
        assert_eq!(
            stale_removed,
            "Notes readonly delete confirmation is stale."
        );

        let direct_target = delete_nodes(
            &mut connection,
            DeleteNodesInput {
                node_ids: vec![THIRD_ID.to_string()],
                expected_readonly_descendant_ids: Some(Vec::new()),
            },
        )
        .expect_err("readonly target cannot be confirmed away");
        assert_eq!(
            direct_target,
            "This Note node is read-only and cannot be modified."
        );
    }

    #[test]
    fn v3_rows_decode_strict_plugin_json_and_nullable_readonly() {
        let connection = v3_test_connection();
        insert_v3_node(
            &connection,
            NODE_ID,
            None,
            "ordinary",
            "2026-07-10T00:00:00Z",
            Some(0),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            None,
            "locked",
            "2026-07-10T00:00:01Z",
            Some(1),
            None,
            None,
        );
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-10T00:00:02Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            THIRD_ID,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            "2026.07.10",
            "2026-07-10T00:00:03Z",
            None,
            None,
            Some(r#"{"kind":"date","date_key":"2026.07.10"}"#),
        );

        let workspace =
            load_workspace(&connection, NotesWorkspaceScope::Active).expect("load v3 workspace");
        assert_eq!(
            workspace
                .nodes
                .iter()
                .find(|node| node.id == NODE_ID)
                .expect("ordinary row")
                .is_readonly,
            Some(false)
        );
        assert_eq!(
            workspace
                .nodes
                .iter()
                .find(|node| node.id == CHILD_ID)
                .expect("locked row")
                .is_readonly,
            Some(true)
        );
        let plugin = workspace
            .nodes
            .iter()
            .find(|node| node.id == THIRD_ID)
            .expect("plugin row");
        assert_eq!(plugin.is_readonly, None);
        assert!(plugin.plugin_meta.is_some());

        connection
            .execute(
                "UPDATE notes_nodes SET plugin_state = '[\"2026.07.10\",\"2026.07.10\"]' \
                 WHERE id = ?1",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
            )
            .expect("corrupt plugin state");
        assert!(load_workspace(&connection, NotesWorkspaceScope::Active).is_err());
        connection
            .execute(
                "UPDATE notes_nodes SET plugin_state = '[]' WHERE id = ?1",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
            )
            .expect("restore plugin state");
        connection
            .execute(
                "UPDATE notes_nodes SET plugin_meta = '{\"kind\":\"unknown\"}' WHERE id = ?1",
                [THIRD_ID],
            )
            .expect("corrupt plugin metadata");
        assert!(load_workspace(&connection, NotesWorkspaceScope::Active).is_err());
    }

    #[test]
    fn v3_rows_reject_semantically_invalid_plugin_metadata() {
        let connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications",
            "2026-07-10T00:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            NODE_ID,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            "plugin row",
            "2026-07-10T00:00:01Z",
            None,
            None,
            Some(r#"{"kind":"date","date_key":"2026.07.10"}"#),
        );

        connection
            .execute(
                "UPDATE notes_nodes SET plugin_state = '[\"2026.02.30\"]' WHERE id = ?1",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
            )
            .expect("set impossible collapsed date");
        assert!(load_workspace(&connection, NotesWorkspaceScope::Active).is_err());
        connection
            .execute(
                "UPDATE notes_nodes SET plugin_state = '[]' WHERE id = ?1",
                [GITHUB_NOTIFICATIONS_ROOT_ID],
            )
            .expect("restore plugin state");

        let invalid_metadata = [
            serde_json::json!({
                "kind": "date",
                "date_key": "2026.02.30"
            }),
            serde_json::json!({
                "kind": "date",
                "date_key": "0000.01.01"
            }),
            serde_json::json!({
                "kind": "notification",
                "notification_key": "[\"github\",\"https://api.github.com/1\",\"42\"]",
                "type": "Issue",
                "url": "https://github.com/example/repo/issues/42",
                "updated_at": "2026-07-21T00:00:00Z",
                "unread": true
            }),
            serde_json::json!({
                "kind": "notification",
                "notification_key":
                    "[\"github\",\"[\\\"https://api.github.com/\\\",\\\"account-7\\\"]\",\"42\"]",
                "type": "Issue",
                "url": "https://github.com/example/repo/issues/42",
                "updated_at": "2026-07-21T00:00:00Z",
                "unread": true
            }),
            serde_json::json!({
                "kind": "notification",
                "notification_key":
                    "[\"github\",\"[\\\"https://api.github.com\\\",\\\"\\\"]\",\"42\"]",
                "type": "Issue",
                "url": "https://github.com/example/repo/issues/42",
                "updated_at": "2026-07-21T00:00:00Z",
                "unread": true
            }),
            serde_json::json!({
                "kind": "notification",
                "notification_key":
                    "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]",
                "type": "Issue Type",
                "url": "https://github.com/example/repo/issues/42",
                "updated_at": "2026-07-21T00:00:00Z",
                "unread": true
            }),
            serde_json::json!({
                "kind": "notification",
                "notification_key":
                    "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]",
                "type": "",
                "url": "https://github.com/example/repo/issues/42",
                "updated_at": "2026-07-21T00:00:00Z",
                "unread": true
            }),
            serde_json::json!({
                "kind": "notification",
                "notification_key":
                    "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]",
                "type": "Issue",
                "url": "https:///issues/42",
                "updated_at": "2026-07-21T00:00:00Z",
                "unread": true
            }),
            serde_json::json!({
                "kind": "notification",
                "notification_key":
                    "[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]",
                "type": "Issue",
                "url": "https://github.com/example/repo/issues/42",
                "updated_at": "2026-02-30T00:00:00Z",
                "unread": true
            }),
        ];
        for metadata in invalid_metadata {
            connection
                .execute(
                    "UPDATE notes_nodes SET plugin_meta = ?1 WHERE id = ?2",
                    params![metadata.to_string(), NODE_ID],
                )
                .expect("set invalid plugin metadata");
            assert!(
                load_workspace(&connection, NotesWorkspaceScope::Active).is_err(),
                "accepted invalid plugin metadata shape"
            );
        }
    }

    #[test]
    fn audited_v3_nodes_distinguish_missing_fields_from_explicit_null() {
        let legacy = serde_json::json!({
            "id": NODE_ID,
            "nodeKind": "text",
            "parent_id": null,
            "sort_key": 1024,
            "title": "ordinary",
            "note": "",
            "image_offset_utf16": 0,
            "markerKind": "bullet",
            "markdown_image_width": null,
            "layout_mode": "bullets",
            "is_collapsed": 0,
            "is_starred": 0,
            "completed_at": null,
            "created_at": "2026-07-10T00:00:00Z",
            "updated_at": "2026-07-10T00:00:00Z",
            "deleted_at": null,
            "archived_at": null,
            "archive_root_id": null
        });
        assert!(
            note_node_from_audit_json(&legacy.to_string()).is_err(),
            "v2 audit rows must be rejected because every v3 storage field is required"
        );

        let mut explicit_null = legacy.clone();
        let object = explicit_null.as_object_mut().expect("audit object");
        object.insert("is_readonly".to_string(), serde_json::Value::Null);
        object.insert("plugin_state".to_string(), serde_json::Value::Null);
        object.insert("plugin_meta".to_string(), serde_json::Value::Null);
        assert!(
            note_node_from_audit_json(&explicit_null.to_string()).is_err(),
            "ordinary v3 rows must not decode an explicit NULL readonly field"
        );

        let mut ordinary_v3 = explicit_null;
        ordinary_v3
            .as_object_mut()
            .expect("audit object")
            .insert("is_readonly".to_string(), serde_json::json!(0));
        assert_eq!(
            note_node_from_audit_json(&ordinary_v3.to_string())
                .expect("decode ordinary v3 audit")
                .is_readonly,
            Some(false)
        );

        let mut partial_v3 = legacy;
        partial_v3
            .as_object_mut()
            .expect("audit object")
            .insert("is_readonly".to_string(), serde_json::json!(0));
        assert!(
            note_node_from_audit_json(&partial_v3.to_string()).is_err(),
            "v3 audit storage fields must be present as one projection"
        );
    }

    #[test]
    fn v3_user_scopes_hide_plugin_rows_but_project_user_descendants_as_roots() {
        let connection = v3_test_connection();
        insert_v3_node(
            &connection,
            GITHUB_NOTIFICATIONS_ROOT_ID,
            None,
            "Github Notifications searchable",
            "2026-07-11T10:00:00Z",
            None,
            Some("[]"),
            None,
        );
        insert_v3_node(
            &connection,
            NODE_ID,
            Some(GITHUB_NOTIFICATIONS_ROOT_ID),
            "2026.07.11 searchable",
            "2026-07-11T10:00:01Z",
            None,
            None,
            Some(r#"{"kind":"date","date_key":"2026.07.11"}"#),
        );
        insert_v3_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            "notification searchable",
            "2026-07-11T10:00:02Z",
            None,
            None,
            Some(
                r#"{"kind":"notification","notification_key":"[\"github\",\"[\\\"https://api.github.com\\\",\\\"account-7\\\"]\",\"42\"]","type":"Issue","url":"https://github.com/example/repo/issues/42","updated_at":"2026-07-11T10:00:02Z","unread":true}"#,
            ),
        );
        insert_v3_node(
            &connection,
            THIRD_ID,
            Some(CHILD_ID),
            "searchable user",
            "2026-07-11T10:00:03Z",
            Some(0),
            None,
            None,
        );
        connection
            .execute(
                "UPDATE notes_nodes SET is_starred = 1 WHERE id IN (?1, ?2)",
                params![CHILD_ID, THIRD_ID],
            )
            .expect("star fixture rows");
        connection
            .execute(
                "UPDATE notes_nodes SET note = '#roadmap searchable note' WHERE id = ?1",
                [THIRD_ID],
            )
            .expect("set user note tag");
        connection
            .execute(
                "INSERT INTO notes_tags(node_id, prefix, tag, normalized_tag) \
                 VALUES (?1, '#', 'roadmap', 'roadmap'), (?2, '#', 'roadmap', 'roadmap')",
                params![CHILD_ID, THIRD_ID],
            )
            .expect("tag fixture rows");
        connection
            .execute(
                "INSERT INTO notes_dates(\
                   node_id, field, start_utf16, end_utf16, normalized_start, \
                   normalized_end, token_text\
                 ) VALUES \
                   (?1, 'title', 0, 10, '2026-07-11', '2026-07-11', '07/11/2026'), \
                   (?2, 'title', 0, 10, '2026-07-11', '2026-07-11', '07/11/2026')",
                params![CHILD_ID, THIRD_ID],
            )
            .expect("date fixture rows");

        let active =
            load_workspace(&connection, NotesWorkspaceScope::Active).expect("load active v3");
        assert_eq!(active.nodes.len(), 4);
        for scope in [
            NotesWorkspaceScope::Recent,
            NotesWorkspaceScope::Starred,
            NotesWorkspaceScope::Tag {
                tag: "roadmap".to_string(),
            },
        ] {
            let workspace = load_workspace(&connection, scope).expect("load user-only v3");
            assert_eq!(workspace.nodes.len(), 1);
            assert_eq!(workspace.nodes[0].id, THIRD_ID);
            assert_eq!(workspace.nodes[0].parent_id, None);
        }
        let search = search_nodes_at(
            &connection,
            "searchable",
            NoteSearchScope::Active,
            fixed_today(),
        )
        .expect("search v3");
        assert_eq!(
            search
                .iter()
                .map(|result| result.node_id.as_str())
                .collect::<Vec<_>>(),
            [THIRD_ID]
        );
        let date_search = search_nodes_at(
            &connection,
            "07/11/2026",
            NoteSearchScope::Active,
            fixed_today(),
        )
        .expect("date search v3");
        assert_eq!(date_search.len(), 1);
        assert_eq!(date_search[0].node_id, THIRD_ID);
        let structured = search_nodes_structured(
            &connection,
            &NoteStructuredSearchQuery {
                text: String::new(),
                required_tags: vec![NoteSearchTag {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: "roadmap".to_string(),
                    display_tag: "roadmap".to_string(),
                }],
                excluded_tags: Vec::new(),
                or_groups: Vec::new(),
            },
        )
        .expect("structured v3 search");
        assert_eq!(structured.len(), 1);
        assert_eq!(structured[0].node_id, THIRD_ID);
        assert_eq!(structured[0].matched_field, NoteSearchMatchedField::Note);
        assert_eq!(list_tags(&connection).expect("v3 tags"), ["roadmap"]);
        let tag_counts = list_tags_with_counts(&connection).expect("v3 tag counts");
        assert_eq!(tag_counts.len(), 1);
        assert_eq!(tag_counts[0].count, 1);
    }

    #[test]
    fn v3_archive_and_trash_hide_plugin_rows_and_reroot_user_children() {
        let connection = v3_test_connection();
        for (plugin_id, user_id, date_key, deleted_at, archived_at) in [
            (
                FOURTH_ID,
                FIFTH_ID,
                "2026.07.11",
                None,
                Some("2026-07-11T11:00:00Z"),
            ),
            (
                SIXTH_ID,
                SEVENTH_ID,
                "2026.07.12",
                Some("2026-07-11T12:00:00Z"),
                None,
            ),
        ] {
            let plugin_meta = format!(r#"{{"kind":"date","date_key":"{date_key}"}}"#);
            insert_v3_node(
                &connection,
                plugin_id,
                None,
                "plugin lifecycle searchable",
                "2026-07-11T10:00:00Z",
                None,
                None,
                Some(&plugin_meta),
            );
            insert_v3_node(
                &connection,
                user_id,
                Some(plugin_id),
                "user lifecycle searchable",
                "2026-07-11T10:00:01Z",
                Some(0),
                None,
                None,
            );
            connection
                .execute(
                    "UPDATE notes_nodes SET deleted_at = ?2, archived_at = ?3, \
                       archive_root_id = CASE WHEN ?3 IS NULL THEN NULL ELSE ?1 END \
                     WHERE id IN (?1, ?4)",
                    params![plugin_id, deleted_at, archived_at, user_id],
                )
                .expect("set lifecycle fixture");
        }

        for (scope, expected_id) in [
            (NotesWorkspaceScope::Archive, FIFTH_ID),
            (NotesWorkspaceScope::Trash, SEVENTH_ID),
        ] {
            let workspace = load_workspace(&connection, scope).expect("load v3 lifecycle");
            assert_eq!(workspace.nodes.len(), 1);
            assert_eq!(workspace.nodes[0].id, expected_id);
            assert_eq!(workspace.nodes[0].parent_id, None);
        }

        for (parent_id, child_id, deleted_at, archived_at) in [
            (NODE_ID, CHILD_ID, None, Some("2026-07-11T13:00:00Z")),
            (THIRD_ID, EIGHTH_ID, Some("2026-07-11T14:00:00Z"), None),
        ] {
            insert_v3_node(
                &connection,
                parent_id,
                None,
                "live user parent",
                "2026-07-11T10:00:02Z",
                Some(0),
                None,
                None,
            );
            insert_v3_node(
                &connection,
                child_id,
                Some(parent_id),
                "boundary searchable",
                "2026-07-11T10:00:03Z",
                Some(0),
                None,
                None,
            );
            connection
                .execute(
                    "UPDATE notes_nodes SET deleted_at = ?2, archived_at = ?3, \
                       archive_root_id = CASE WHEN ?3 IS NULL THEN NULL ELSE ?1 END \
                     WHERE id = ?1",
                    params![child_id, deleted_at, archived_at],
                )
                .expect("set out-of-scope parent boundary");
        }

        for (scope, expected_ids) in [
            (NoteSearchScope::Archive, [CHILD_ID, FIFTH_ID]),
            (NoteSearchScope::Trash, [EIGHTH_ID, SEVENTH_ID]),
        ] {
            reset_search_parent_trail_query_count();
            let results = search_nodes_at(&connection, "searchable", scope, fixed_today())
                .expect("search v3 lifecycle");
            assert_eq!(
                results
                    .iter()
                    .map(|result| result.node_id.as_str())
                    .collect::<BTreeSet<_>>(),
                expected_ids.into_iter().collect()
            );
            assert!(results.iter().all(|result| result.parent_trail.is_empty()));
            assert_eq!(
                search_parent_trail_query_count(),
                1,
                "v3 parent trails must load one chunk, not one query per hit"
            );
        }
    }

    #[test]
    fn notes_database_initializes_one_stable_vault_generation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        let connection = connect_notes_db(&vault_path).expect("initialize database");
        let first: String = connection
            .query_row(
                "SELECT vault_generation FROM notes_metadata WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("vault generation metadata");
        validate_note_id(&first).expect("canonical generation UUID");
        drop(connection);

        let connection = connect_notes_db(&vault_path).expect("reopen database");
        let second: String = connection
            .query_row(
                "SELECT vault_generation FROM notes_metadata WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("stable vault generation preference");

        assert_eq!(second, first);
    }

    #[test]
    fn fresh_schema_v5_defines_note_sync_storage_and_stable_identity_metadata() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        let connection = connect_notes_db(&vault_path).expect("initialize database");

        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .expect("schema version"),
            CURRENT_NOTES_SCHEMA_VERSION
        );
        let node_columns = table_columns(&connection, "notes_nodes");
        for column in [
            "hlc",
            "marker_kind",
            "markdown_image_width",
            "plugin_state",
            "plugin_meta",
            "is_readonly",
        ] {
            assert!(
                node_columns.contains(&column.to_string()),
                "missing {column}"
            );
        }
        for table in [
            "sync_meta",
            "sync_topics",
            "sync_dirty_nodes",
            "sync_conflict_log",
            "sync_purged_tombstones",
            "asset_trash",
        ] {
            assert!(table_exists(&connection, "main", table), "missing {table}");
        }
        let first: (String, String) = connection
            .query_row(
                "SELECT device_id, vault_uuid FROM sync_meta WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("sync identity metadata");
        validate_note_id(&first.0).expect("device UUID");
        validate_note_id(&first.1).expect("vault UUID");
        drop(connection);

        let reopened = connect_notes_db(&vault_path).expect("reopen database");
        let second: (String, String) = reopened
            .query_row(
                "SELECT device_id, vault_uuid FROM sync_meta WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("stable sync identity metadata");

        assert_eq!(second, first);
    }

    #[test]
    fn initialization_rejects_existing_v2_before_running_schema_sql() {
        let mut connection = Connection::open_in_memory().expect("in-memory v2 database");
        connection
            .execute_batch(
                "CREATE TABLE notes_nodes(id TEXT PRIMARY KEY); PRAGMA user_version = 2;",
            )
            .expect("seed v2 schema");

        let error = initialize_notes_db(&mut connection).expect_err("v2 must be rejected");

        assert_eq!(error, NOTES_DEVELOPMENT_SCHEMA_REJECTION);
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .expect("unchanged v2 schema version"),
            2
        );
        assert_eq!(table_columns(&connection, "notes_nodes"), ["id"]);
    }

    #[test]
    fn existing_v2_wal_database_is_rejected_before_writable_initialization() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        drop(
            crate::notes::connection::acquire_vault_app_lock(&vault_path)
                .expect("create normal Notes app lock"),
        );
        let database_path = notes_db_path(&vault_path);
        std::fs::create_dir_all(database_path.parent().expect("metadata directory"))
            .expect("create metadata directory");
        let fixture = Connection::open(&database_path).expect("create v2 fixture");
        fixture
            .execute_batch(
                "PRAGMA journal_mode = WAL; \
                 PRAGMA wal_autocheckpoint = 0; \
                 CREATE TABLE notes_nodes(id TEXT PRIMARY KEY); \
                 CREATE TABLE sync_topics(topic_id TEXT PRIMARY KEY, file_name TEXT NOT NULL); \
                 CREATE TABLE sync_dirty_nodes(node_id TEXT PRIMARY KEY); \
                 INSERT INTO sync_topics(topic_id, file_name) VALUES ('root', 'Root.md'); \
                 INSERT INTO sync_dirty_nodes(node_id) VALUES ('root'); \
                 PRAGMA user_version = 2;",
            )
            .expect("seed v2 WAL fixture");

        let wal_path = sqlite_companion_path(&database_path, "-wal");
        let shm_path = sqlite_companion_path(&database_path, "-shm");
        let user_version_before: i64 = fixture
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read v2 schema version");
        let sync_rows_before: Vec<(String, String)> = fixture
            .prepare("SELECT topic_id, file_name FROM sync_topics ORDER BY topic_id")
            .expect("prepare sync rows")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query sync rows")
            .collect::<Result<_, _>>()
            .expect("collect sync rows");
        let main_before = std::fs::read(&database_path).expect("read v2 database");
        let wal_before = std::fs::read(&wal_path).expect("read v2 WAL");
        let shm_before = std::fs::read(&shm_path).expect("read v2 SHM");
        let files_before = vault_file_listing(temp_dir.path());
        assert!(
            !files_before
                .iter()
                .any(|path| path.ends_with(GITHUB_NOTIFICATIONS_FILENAME)),
            "v2 fixture must not have a GitHub Notifications topic file"
        );

        let error = connect_notes_db(&vault_path).expect_err("v2 database must be rejected");

        assert_eq!(error, NOTES_DEVELOPMENT_SCHEMA_REJECTION);
        assert_eq!(
            std::fs::read(&database_path).expect("read unchanged v2 database"),
            main_before
        );
        assert_eq!(
            std::fs::read(&wal_path).expect("read unchanged v2 WAL"),
            wal_before
        );
        assert_eq!(
            std::fs::read(&shm_path).expect("read unchanged v2 SHM"),
            shm_before
        );
        let files_after = vault_file_listing(temp_dir.path());
        assert_eq!(files_after, files_before);
        assert!(
            !files_after
                .iter()
                .any(|path| path.ends_with(GITHUB_NOTIFICATIONS_FILENAME)),
            "v2 rejection must not create a GitHub Notifications topic file"
        );
        assert_eq!(
            fixture
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .expect("read unchanged v2 schema version"),
            user_version_before
        );
        let sync_rows_after: Vec<(String, String)> = fixture
            .prepare("SELECT topic_id, file_name FROM sync_topics ORDER BY topic_id")
            .expect("prepare unchanged sync rows")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query unchanged sync rows")
            .collect::<Result<_, _>>()
            .expect("collect unchanged sync rows");
        assert_eq!(sync_rows_after, sync_rows_before);
    }

    #[test]
    fn app_local_storage_uses_the_vault_key_and_tests_keep_the_legacy_fallback() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let root = temp_dir.path().join("app-data/notes");
        let vault = "/Volumes/Yona/Vault";

        assert_eq!(vault_key(vault), "67a895fc5ce85709");
        assert_eq!(
            notes_db_path_with_root(vault, &root),
            root.join("67a895fc5ce85709/notes.sqlite")
        );
        assert_eq!(
            notes_db_path(vault),
            crate::metadata_dir(vault).join("notes.sqlite")
        );
    }

    #[cfg(unix)]
    #[test]
    fn app_local_storage_rejects_a_symlinked_vault_key_directory() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let outside = temp_dir.path().join("outside");
        std::fs::create_dir(&outside).expect("create outside directory");
        let storage = temp_dir.path().join("notes/vault-key");
        std::fs::create_dir_all(storage.parent().expect("notes root")).expect("create notes root");
        symlink(&outside, &storage).expect("symlink storage directory");

        let error = open_local_notes_storage_directory(&storage.join("notes.sqlite"), true)
            .err()
            .expect("symlinked app-local storage must be rejected");

        assert!(error.contains("symlink"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn app_local_storage_rejects_a_symlinked_notes_root() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let outside = temp_dir.path().join("outside");
        std::fs::create_dir(&outside).expect("create outside directory");
        let notes_root = temp_dir.path().join("notes");
        symlink(&outside, &notes_root).expect("symlink Notes root");

        let error =
            open_local_notes_storage_directory(&notes_root.join("vault-key/notes.sqlite"), true)
                .err()
                .expect("symlinked Notes root must be rejected");

        assert!(error.contains("symlink"), "{error}");
        assert!(!outside.join("vault-key").exists());
    }

    #[test]
    fn opening_app_local_storage_creates_the_asset_trash_directory() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let storage = temp_dir.path().join("notes/vault-key");

        let _held = open_local_notes_storage_directory(&storage.join("notes.sqlite"), true)
            .expect("open app-local storage");

        assert!(storage.join("asset-trash").is_dir());
    }

    #[test]
    fn first_app_local_open_rejects_effective_legacy_wal_v2_without_mutation_but_existing_local_wins(
    ) {
        const CHILD_ENV: &str = "YONALIST_APP_LOCAL_LEGACY_V2_CHILD";
        const TEST_NAME: &str = "notes::repository::tests::first_app_local_open_rejects_effective_legacy_wal_v2_without_mutation_but_existing_local_wins";

        if std::env::var_os(CHILD_ENV).is_some() {
            let sandbox = std::env::current_dir().expect("isolated child cwd");
            let notes_root = sandbox.join("app-data/notes");
            crate::NOTES_DATA_ROOT
                .set(notes_root.clone())
                .expect("set isolated production Notes root");
            assert!(
                !notes_root.exists(),
                "app-local v2 rejection fixture must start without a Notes root"
            );

            let legacy_only = sandbox.join("legacy-only");
            let legacy_metadata = legacy_only.join(".yonalist");
            std::fs::create_dir_all(&legacy_metadata).expect("create legacy metadata");
            let legacy_path = legacy_metadata.join("notes.sqlite");
            let legacy = Connection::open(&legacy_path).expect("create legacy database");
            legacy
                .pragma_update(None, "journal_mode", "WAL")
                .expect("enable legacy WAL");
            legacy
                .pragma_update(None, "wal_autocheckpoint", 0_i64)
                .expect("disable legacy autocheckpoint");
            legacy
                .execute_batch(
                    "BEGIN IMMEDIATE; \
                     CREATE TABLE legacy_probe(id INTEGER PRIMARY KEY); \
                     PRAGMA user_version = 2; \
                     COMMIT;",
                )
                .expect("record effective schema v2 only in WAL");
            std::fs::write(legacy_metadata.join("sentinel"), b"keep")
                .expect("write unrelated metadata sentinel");
            let legacy_wal_path = sqlite_companion_path(&legacy_path, "-wal");
            let legacy_shm_path = sqlite_companion_path(&legacy_path, "-shm");
            let main_before = std::fs::read(&legacy_path).expect("read legacy main before probe");
            let wal_before = std::fs::read(&legacy_wal_path).expect("read legacy WAL before probe");
            assert_eq!(
                u32::from_be_bytes([
                    main_before[60],
                    main_before[61],
                    main_before[62],
                    main_before[63],
                ]),
                0,
                "fixture must keep schema v2 out of the main header"
            );
            assert_eq!(
                legacy
                    .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                    .expect("read effective legacy schema"),
                2
            );
            let shm_before = std::fs::read(&legacy_shm_path).expect("read legacy SHM before probe");
            let legacy_only = legacy_only.to_string_lossy().into_owned();
            let app_local_path = notes_db_path(&legacy_only);

            let error = connect_notes_db(&legacy_only)
                .expect_err("legacy schema v2 must block first app-local creation");

            assert_eq!(error, NOTES_DEVELOPMENT_SCHEMA_REJECTION);
            assert!(!app_local_path.exists(), "a new v3 database was created");
            assert!(
                !notes_root.exists(),
                "legacy rejection created the app-local Notes root"
            );
            assert!(!legacy_metadata.join(".notes-assets.lock").exists());
            assert!(!legacy_metadata.join("notes-assets").exists());
            let lease_error =
                match crate::notes::attachments::AttachmentStorageLease::acquire(&legacy_only) {
                    Ok(_) => panic!("attachment storage must reject the effective legacy v2"),
                    Err(error) => error,
                };
            assert_eq!(lease_error, NOTES_DEVELOPMENT_SCHEMA_REJECTION);
            assert!(
                !notes_root.exists(),
                "attachment preflight created the app-local Notes root"
            );
            assert!(!legacy_metadata.join(".notes-assets.lock").exists());
            assert!(!legacy_metadata.join("notes-assets").exists());
            assert_eq!(
                legacy
                    .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                    .expect("read unchanged legacy schema"),
                2
            );
            assert_eq!(
                std::fs::read(&legacy_path).expect("read legacy main after probe"),
                main_before
            );
            assert_eq!(
                std::fs::read(&legacy_wal_path).expect("read legacy WAL after probe"),
                wal_before
            );
            assert_eq!(
                std::fs::read(&legacy_shm_path).expect("read legacy SHM after probe"),
                shm_before
            );
            assert_eq!(
                std::fs::read(legacy_metadata.join("sentinel")).expect("read sentinel"),
                b"keep"
            );

            let local_first = sandbox.join("local-first");
            std::fs::create_dir_all(&local_first).expect("create second vault");
            let local_first = local_first.to_string_lossy().into_owned();
            let initialized =
                connect_notes_db(&local_first).expect("create current app-local database first");
            assert_eq!(
                initialized
                    .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                    .expect("read app-local schema"),
                crate::notes::schema::CURRENT_NOTES_SCHEMA_VERSION
            );
            drop(initialized);
            let second_legacy_path = crate::metadata_dir(&local_first).join("notes.sqlite");
            let second_legacy = Connection::open(&second_legacy_path)
                .expect("create ignored legacy database after app-local database");
            second_legacy
                .pragma_update(None, "journal_mode", "WAL")
                .expect("enable ignored legacy WAL");
            second_legacy
                .pragma_update(None, "wal_autocheckpoint", 0_i64)
                .expect("disable ignored legacy autocheckpoint");
            second_legacy
                .execute_batch("BEGIN IMMEDIATE; PRAGMA user_version = 2; COMMIT;")
                .expect("set ignored effective legacy schema v2");

            let reopened = connect_notes_db(&local_first)
                .expect("existing app-local database must take precedence over legacy v2");
            assert_eq!(
                reopened
                    .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                    .expect("read reopened app-local schema"),
                crate::notes::schema::CURRENT_NOTES_SCHEMA_VERSION
            );

            #[cfg(unix)]
            {
                use std::os::unix::fs::symlink;

                let symlink_vault = sandbox.join("legacy-symlink");
                let symlink_metadata = symlink_vault.join(".yonalist");
                std::fs::create_dir_all(&symlink_metadata).expect("create symlink metadata");
                let outside = sandbox.join("outside-legacy.sqlite");
                Connection::open(&outside).expect("create outside legacy database");
                symlink(&outside, symlink_metadata.join("notes.sqlite"))
                    .expect("symlink legacy database");
                let symlink_vault = symlink_vault.to_string_lossy().into_owned();
                let keyed_directory = notes_db_path(&symlink_vault)
                    .parent()
                    .expect("symlink vault key directory")
                    .to_path_buf();

                let error = connect_notes_db(&symlink_vault)
                    .expect_err("symlinked legacy database must fail closed");

                assert!(error.to_lowercase().contains("symlink"), "{error}");
                assert!(
                    !keyed_directory.exists(),
                    "symlink rejection created the keyed app-local directory"
                );

                let identity_vault = sandbox.join("legacy-identity-swap");
                let identity_metadata = identity_vault.join(".yonalist");
                std::fs::create_dir_all(&identity_metadata).expect("create identity metadata");
                let identity_database = identity_metadata.join("notes.sqlite");
                let identity_seed = Connection::open(&identity_database)
                    .expect("create identity-swap legacy database");
                identity_seed
                    .pragma_update(None, "user_version", 1_i64)
                    .expect("set identity-swap schema v1");
                drop(identity_seed);
                let original_bytes =
                    std::fs::read(&identity_database).expect("read original identity database");
                let held_database = sandbox.join("held-legacy-identity.sqlite");
                let identity_outside = sandbox.join("outside-legacy-identity.sqlite");
                let outside_seed = Connection::open(&identity_outside)
                    .expect("create identity-swap outside database");
                outside_seed
                    .pragma_update(None, "user_version", 2_i64)
                    .expect("set outside schema v2");
                drop(outside_seed);
                let outside_before =
                    std::fs::read(&identity_outside).expect("read outside identity database");
                let raced_database = identity_database.clone();
                let raced_held = held_database.clone();
                let raced_outside = identity_outside.clone();
                inject_notes_database_after_hold_once(move || {
                    std::fs::rename(&raced_database, &raced_held)
                        .expect("move safely held legacy database");
                    symlink(&raced_outside, &raced_database)
                        .expect("swap legacy database path to symlink");
                });
                let restored_database = identity_database.clone();
                let restored_held = held_database.clone();
                inject_notes_database_after_sqlite_open_once(move || {
                    std::fs::remove_file(&restored_database)
                        .expect("remove substituted legacy symlink");
                    std::fs::rename(&restored_held, &restored_database)
                        .expect("restore safely held legacy database pathname");
                });
                let identity_vault = identity_vault.to_string_lossy().into_owned();
                let identity_keyed_directory = notes_db_path(&identity_vault)
                    .parent()
                    .expect("identity vault key directory")
                    .to_path_buf();

                let error = connect_notes_db(&identity_vault)
                    .expect_err("legacy identity swap must fail closed");

                assert_eq!(
                    error,
                    "개발 단계 DB — .yonalist/notes.sqlite 삭제 후 재실행"
                );
                assert!(
                    !identity_keyed_directory.exists(),
                    "identity rejection created the keyed app-local directory"
                );
                assert_eq!(
                    std::fs::read(&identity_database).expect("read restored legacy database"),
                    original_bytes
                );
                assert!(!held_database.exists());
                assert_eq!(
                    std::fs::read(&identity_outside).expect("read outside identity database"),
                    outside_before
                );
            }
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
            .expect("run isolated app-local legacy regression");
        assert!(
            output.status.success(),
            "isolated app-local legacy regression failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    #[test]
    fn repository_mutation_restamps_hlc_and_marks_the_node_dirty() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "before");
        let before: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("initial HLC");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear initial dirty marker");

        update_node(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "after".to_string(),
                note: String::new(),
                image_offset_utf16: 0,
                markdown_image_width: None,
            },
        )
        .expect("update node through repository");

        let after: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("updated HLC");
        let dirty: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_dirty_nodes WHERE node_id = ?1)",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("dirty marker");

        assert_eq!(before.len(), 17);
        assert!(after > before);
        assert!(dirty);
    }

    #[test]
    fn markdown_image_width_round_trips_and_rejects_invalid_values() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "before");

        update_node(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "![Chart](https://example.com/chart.png)".to_string(),
                note: String::new(),
                image_offset_utf16: 0,
                markdown_image_width: Some(320),
            },
        )
        .expect("persist Markdown image width");

        let workspace =
            load_workspace(&connection, NotesWorkspaceScope::Active).expect("load width workspace");
        assert_eq!(workspace.nodes[0].markdown_image_width, Some(320));

        for invalid_width in [0, 16_385] {
            let error = update_node(
                &mut connection,
                UpdateNodeInput {
                    marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                    id: NODE_ID.to_string(),
                    title: "![Chart](https://example.com/chart.png)".to_string(),
                    note: String::new(),
                    image_offset_utf16: 0,
                    markdown_image_width: Some(invalid_width),
                },
            )
            .expect_err("reject invalid Markdown image width");
            assert!(error.contains("between 1 and 16384"));
        }

        update_node(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "Plain title".to_string(),
                note: String::new(),
                image_offset_utf16: 0,
                markdown_image_width: None,
            },
        )
        .expect("clear stale Markdown image width");
        let stored: Option<i64> = connection
            .query_row(
                "SELECT markdown_image_width FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("read cleared width");
        assert_eq!(stored, None);
    }

    #[test]
    fn node_triggers_stamp_local_inserts_but_preserve_explicit_remote_insert_and_update_hlc() {
        let connection = test_connection();
        let remote_insert_hlc = "0swkd7qz3-01-a3f2";
        let remote_update_hlc = "0swkd7qz3-02-a3f2";
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear onboarding dirty markers");
        connection
            .execute(
                "INSERT INTO notes_nodes (id, parent_id, sort_key, title, created_at, updated_at, hlc) \
                 VALUES (?1, NULL, 1024, 'remote', '2026-07-10T00:00:00.000Z', \
                         '2026-07-10T00:00:00.000Z', ?2)",
                params![NODE_ID, remote_insert_hlc],
            )
            .expect("insert remote node");
        connection
            .execute(
                "UPDATE notes_nodes SET title = 'remote update', hlc = ?2 WHERE id = ?1",
                params![NODE_ID, remote_update_hlc],
            )
            .expect("update remote node with explicit HLC");
        insert_node(&connection, CHILD_ID, None, 2048, "local");

        let remote: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("remote HLC");
        let local: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("local HLC");
        let dirty_ids = connection
            .prepare("SELECT node_id FROM sync_dirty_nodes ORDER BY node_id")
            .expect("prepare dirty IDs")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query dirty IDs")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect dirty IDs");

        assert_eq!(remote, remote_update_hlc);
        assert_eq!(local.len(), 17);
        assert_eq!(dirty_ids, vec![CHILD_ID.to_string()]);
    }

    #[test]
    fn initialization_reinstalls_trash_transition_trigger_for_current_schema() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "existing topic");
        connection
            .execute_batch(
                "DROP TRIGGER notes_nodes_hlc_au;
                 DROP TRIGGER IF EXISTS notes_nodes_trash_dirty_au;
                 CREATE TRIGGER notes_nodes_hlc_au AFTER UPDATE ON notes_nodes
                 WHEN NEW.hlc = OLD.hlc
                 BEGIN
                   UPDATE notes_nodes SET hlc = yona_hlc() WHERE id = NEW.id;
                   INSERT INTO sync_dirty_nodes(node_id) VALUES (NEW.id)
                   ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at;
                 END;",
            )
            .expect("simulate an older current-schema trigger");

        initialize_notes_db(&mut connection).expect("reopen existing schema");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .unwrap();
        connection
            .execute(
                "UPDATE notes_nodes SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ?1",
                [NODE_ID],
            )
            .unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = '__yonalist_trash__'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn attachment_insert_update_and_delete_restamp_and_dirty_the_owner() {
        let connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "owner");
        let mut previous: String = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("owner HLC");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear dirty markers");

        let attachment_id = insert_test_attachment(&connection, 1, NODE_ID);
        for operation in ["insert", "update", "delete"] {
            if operation == "update" {
                connection
                    .execute(
                        "UPDATE notes_attachments SET original_name = 'renamed.png' WHERE id = ?1",
                        [attachment_id.as_str()],
                    )
                    .expect("update attachment");
            } else if operation == "delete" {
                connection
                    .execute(
                        "DELETE FROM notes_attachments WHERE id = ?1",
                        [attachment_id.as_str()],
                    )
                    .expect("delete attachment");
            }
            let current: String = connection
                .query_row(
                    "SELECT hlc FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get(0),
                )
                .expect("restamped owner HLC");
            let dirty: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sync_dirty_nodes WHERE node_id = ?1)",
                    [NODE_ID],
                    |row| row.get(0),
                )
                .expect("owner dirty marker");
            assert!(current > previous, "{operation} must advance the owner HLC");
            assert!(dirty, "{operation} must mark the owner dirty");
            previous = current;
            connection
                .execute("DELETE FROM sync_dirty_nodes", [])
                .expect("clear dirty marker between operations");
        }
    }

    #[test]
    fn deleting_a_node_keeps_a_dirty_marker_for_export() {
        let connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "delete me");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear initial dirty marker");

        connection
            .execute("DELETE FROM notes_nodes WHERE id = ?1", [NODE_ID])
            .expect("delete node");

        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_dirty_nodes WHERE node_id = ?1)",
                [NODE_ID],
                |row| row.get::<_, bool>(0),
            )
            .expect("deleted node dirty marker"));
    }

    fn date_rows(
        connection: &Connection,
        node_id: &str,
    ) -> Vec<(String, i64, i64, String, String, String)> {
        connection
            .prepare(
                "SELECT field, start_utf16, end_utf16, normalized_start, normalized_end, token_text \
                 FROM notes_dates WHERE node_id = ?1 ORDER BY field DESC, start_utf16",
            )
            .expect("prepare date rows")
            .query_map([node_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .expect("query date rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect date rows")
    }

    fn object_exists(connection: &Connection, object_type: &str, name: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2)",
                params![object_type, name],
                |row| row.get(0),
            )
            .expect("schema object query")
    }

    fn table_exists(connection: &Connection, schema: &str, name: &str) -> bool {
        connection
            .query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM {schema}.sqlite_schema \
                     WHERE type = 'table' AND name = ?1)"
                ),
                [name],
                |row| row.get(0),
            )
            .expect("table existence query")
    }

    fn temp_store(connection: &Connection) -> i64 {
        connection
            .pragma_query_value(None, "temp_store", |row| row.get(0))
            .expect("TEMP storage mode")
    }

    fn test_connection() -> Connection {
        let mut connection = Connection::open_in_memory().expect("in-memory notes database");
        initialize_notes_db(&mut connection).expect("initialize notes database");
        install_session_history(&connection).expect("install session history");
        connection
            .execute("DELETE FROM notes_nodes", [])
            .expect("clear onboarding nodes from empty test fixture");
        connection
    }

    #[test]
    fn fresh_current_schema_defines_image_offset_and_attachment_search() {
        let mut connection = test_connection();

        assert!(
            table_columns(&connection, "notes_nodes").contains(&"image_offset_utf16".to_string())
        );
        assert_eq!(
            table_columns(&connection, "notes_search"),
            ["node_id", "title", "note", "attachment_name"]
        );
        assert_eq!(
            table_columns(&connection, "notes_search_lifecycle"),
            ["node_id", "title", "note", "attachment_name"]
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT notes_image_search_title(?1, ?2, ?3)",
                    params!["A😀B", "image", 3i64],
                    |row| row.get::<_, String>(0),
                )
                .expect("image title search scalar"),
            "A😀 B"
        );

        insert_node(&connection, NODE_ID, None, 1024, "First");
        insert_node(&connection, CHILD_ID, None, 2048, "Second");
        let attachment_id = insert_test_attachment(&connection, 1, NODE_ID);
        connection
            .execute(
                "UPDATE notes_attachments SET node_id = ?1 WHERE id = ?2",
                params![CHILD_ID, attachment_id],
            )
            .expect("move attachment");
        for table in ["notes_search", "notes_search_lifecycle"] {
            let source_name: String = connection
                .query_row(
                    &format!("SELECT attachment_name FROM {table} WHERE node_id = ?1"),
                    [NODE_ID],
                    |row| row.get(0),
                )
                .expect("source attachment search name");
            let target_name: String = connection
                .query_row(
                    &format!("SELECT attachment_name FROM {table} WHERE node_id = ?1"),
                    [CHILD_ID],
                    |row| row.get(0),
                )
                .expect("target attachment search name");
            assert_eq!(source_name, "");
            assert_eq!(target_name, "");
        }

        let mut image_attachment = test_new_attachment(2, THIRD_ID);
        image_attachment.original_name = "initialatom.png".to_string();
        let image_attachment_id = image_attachment.id.clone();
        create_image_nodes_coordinated(
            &mut connection,
            None,
            None,
            vec![NewImageNode {
                id: THIRD_ID.to_string(),
                title: String::new(),
                attachment: image_attachment,
            }],
            || Ok(()),
            || Ok(()),
        )
        .expect("create valid image attachment fixture");
        for table in ["notes_search", "notes_search_lifecycle"] {
            let attachment_name: String = connection
                .query_row(
                    &format!("SELECT attachment_name FROM {table} WHERE node_id = ?1"),
                    [THIRD_ID],
                    |row| row.get(0),
                )
                .expect("valid image attachment search name");
            assert_eq!(attachment_name, "initialatom.png");
            let match_count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {table} MATCH ?1"),
                    ["initialatom"],
                    |row| row.get(0),
                )
                .expect("initial filename match");
            assert_eq!(match_count, 1);
        }

        connection
            .execute(
                "UPDATE notes_attachments SET original_name = 'renamed.png' WHERE id = ?1",
                [image_attachment_id.as_str()],
            )
            .expect("rename exact image attachment");
        let renamed = search_nodes(&connection, "renamed").expect("search renamed attachment");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].node_id, THIRD_ID);
        assert_eq!(renamed[0].matched_field, NoteSearchMatchedField::Attachment);
        for table in ["notes_search", "notes_search_lifecycle"] {
            let attachment_name: String = connection
                .query_row(
                    &format!("SELECT attachment_name FROM {table} WHERE node_id = ?1"),
                    [THIRD_ID],
                    |row| row.get(0),
                )
                .expect("renamed image attachment search name");
            assert_eq!(attachment_name, "renamed.png");
            let match_count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {table} MATCH ?1"),
                    ["renamed"],
                    |row| row.get(0),
                )
                .expect("renamed filename match");
            assert_eq!(match_count, 1);
        }

        let second_attachment_id = insert_test_attachment(&connection, 3, THIRD_ID);
        for table in ["notes_search", "notes_search_lifecycle"] {
            let attachment_name: String = connection
                .query_row(
                    &format!("SELECT attachment_name FROM {table} WHERE node_id = ?1"),
                    [THIRD_ID],
                    |row| row.get(0),
                )
                .expect("invalid image attachment search name");
            assert_eq!(attachment_name, "");
        }

        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [second_attachment_id.as_str()],
            )
            .expect("restore exact image attachment count");
        for table in ["notes_search", "notes_search_lifecycle"] {
            let attachment_name: String = connection
                .query_row(
                    &format!("SELECT attachment_name FROM {table} WHERE node_id = ?1"),
                    [THIRD_ID],
                    |row| row.get(0),
                )
                .expect("restored image attachment search name");
            assert_eq!(attachment_name, "renamed.png");
        }

        let fourth_attachment = test_new_attachment(4, FOURTH_ID);
        let fourth_attachment_id = fourth_attachment.id.clone();
        create_image_nodes_coordinated(
            &mut connection,
            None,
            None,
            vec![NewImageNode {
                id: FOURTH_ID.to_string(),
                title: String::new(),
                attachment: fourth_attachment,
            }],
            || Ok(()),
            || Ok(()),
        )
        .expect("create empty image owner");
        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [fourth_attachment_id.as_str()],
            )
            .expect("empty fourth image owner");

        connection
            .execute(
                "UPDATE notes_attachments SET node_id = ?1 WHERE id = ?2",
                params![FOURTH_ID, image_attachment_id],
            )
            .expect("move exact image attachment to new image owner");
        let moved = search_nodes(&connection, "renamed").expect("search moved attachment");
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].node_id, FOURTH_ID);
        for table in ["notes_search", "notes_search_lifecycle"] {
            let old_name: String = connection
                .query_row(
                    &format!("SELECT attachment_name FROM {table} WHERE node_id = ?1"),
                    [THIRD_ID],
                    |row| row.get(0),
                )
                .expect("old image owner search name");
            let new_name: String = connection
                .query_row(
                    &format!("SELECT attachment_name FROM {table} WHERE node_id = ?1"),
                    [FOURTH_ID],
                    |row| row.get(0),
                )
                .expect("new image owner search name");
            assert_eq!(old_name, "");
            assert_eq!(new_name, "renamed.png");
            let match_count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {table} MATCH ?1"),
                    ["renamed"],
                    |row| row.get(0),
                )
                .expect("moved filename match");
            assert_eq!(match_count, 1);
        }

        connection
            .execute(
                "DELETE FROM notes_attachments WHERE id = ?1",
                [image_attachment_id.as_str()],
            )
            .expect("delete final image attachment");
        for table in ["notes_search", "notes_search_lifecycle"] {
            let attachment_name: String = connection
                .query_row(
                    &format!("SELECT attachment_name FROM {table} WHERE node_id = ?1"),
                    [FOURTH_ID],
                    |row| row.get(0),
                )
                .expect("deleted image attachment search name");
            assert_eq!(attachment_name, "");
            let match_count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {table} MATCH ?1"),
                    ["renamed"],
                    |row| row.get(0),
                )
                .expect("deleted filename match");
            assert_eq!(match_count, 0);
        }
    }

    #[test]
    fn notes_search_returns_raw_image_title_after_utf16_index_split() {
        let mut connection = test_connection();
        let attachment = test_new_attachment(96, NODE_ID);
        create_image_nodes_coordinated(
            &mut connection,
            None,
            None,
            vec![NewImageNode {
                id: NODE_ID.to_string(),
                title: String::new(),
                attachment,
            }],
            || Ok(()),
            || Ok(()),
        )
        .expect("create valid image node");
        update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "A😀B".to_string(),
                note: String::new(),
                image_offset_utf16: 3,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .expect("save semantic image title");

        let indexed_title: String = connection
            .query_row(
                "SELECT title FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("read split FTS title");
        assert_eq!(indexed_title, "A😀 B");

        let results = search_nodes(&connection, "B").expect("search image title segment");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].node_id, NODE_ID);
        assert_eq!(results[0].node_kind, NoteNodeKind::Image);
        assert_eq!(results[0].title, "A😀B");
        assert_eq!(results[0].matched_field, NoteSearchMatchedField::Title);
    }

    #[test]
    fn image_atom_search_returns_attachment_match_and_shared_label() {
        let mut connection = test_connection();
        let mut attachment = test_new_attachment(96, NODE_ID);
        attachment.original_name = "priority-shared-diagram.png".to_string();
        create_image_nodes_coordinated(
            &mut connection,
            None,
            None,
            vec![NewImageNode {
                id: NODE_ID.to_string(),
                title: String::new(),
                attachment,
            }],
            || Ok(()),
            || Ok(()),
        )
        .expect("create image search fixture");

        let before = "  Priority  ";
        let title = format!("{before}After");
        update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: title.clone(),
                note: "priority note shared".to_string(),
                image_offset_utf16: before.encode_utf16().count() as i64,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .expect("save image primary segments");

        let title_match = search_nodes(&connection, "priority").expect("title-priority match");
        assert_eq!(title_match[0].matched_field, NoteSearchMatchedField::Title);
        let note_match = search_nodes(&connection, "note").expect("note-priority match");
        assert_eq!(note_match[0].matched_field, NoteSearchMatchedField::Note);
        let shared_match = search_nodes(&connection, "shared").expect("shared match");
        assert_eq!(shared_match[0].matched_field, NoteSearchMatchedField::Note);

        let attachment_match =
            search_nodes(&connection, "diagram").expect("attachment filename match");
        let result = serde_json::to_value(&attachment_match[0]).expect("serialize search result");
        assert_eq!(result["matchedField"], "attachment");
        assert_eq!(result["title"], title);
        assert_eq!(
            result["imageOffsetUtf16"],
            before.encode_utf16().count() as i64
        );
        assert_eq!(result["attachmentName"], "priority-shared-diagram.png");
        assert_eq!(result["displayLabel"], "Priority After");

        let mut fallback_attachment = test_new_attachment(97, THIRD_ID);
        fallback_attachment.original_name = "fallback.png".to_string();
        create_image_nodes_coordinated(
            &mut connection,
            None,
            None,
            vec![NewImageNode {
                id: THIRD_ID.to_string(),
                title: String::new(),
                attachment: fallback_attachment,
            }],
            || Ok(()),
            || Ok(()),
        )
        .expect("create fallback parent");
        create_search_node(&mut connection, FOURTH_ID, Some(THIRD_ID), "child target");

        let child = search_nodes(&connection, "target").expect("search child");
        assert_eq!(child[0].parent_trail, vec!["fallback.png"]);
    }

    #[test]
    fn image_atom_derived_content_keeps_primary_segments_independent() {
        let mut connection = test_connection();
        let mut attachment = test_new_attachment(98, NODE_ID);
        attachment.original_name = "#filename 07/14/2026.png".to_string();
        create_image_nodes_coordinated(
            &mut connection,
            None,
            None,
            vec![NewImageNode {
                id: NODE_ID.to_string(),
                title: String::new(),
                attachment,
            }],
            || Ok(()),
            || Ok(()),
        )
        .expect("create image derived-content fixture");

        update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "#leftright".to_string(),
                note: String::new(),
                image_offset_utf16: "#left".encode_utf16().count() as i64,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .expect("split tag at image atom");
        assert!(search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Hash, "leftright")],
                vec![],
                vec![],
            ),
        )
        .expect("cross-atom tag search")
        .is_empty());
        assert_eq!(
            search_nodes_structured(
                &connection,
                &structured_query(
                    "",
                    vec![search_tag(NoteTagPrefix::Hash, "left")],
                    vec![],
                    vec![],
                ),
            )
            .expect("before-segment tag search")[0]
                .matched_field,
            NoteSearchMatchedField::Title
        );

        update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "07/14/2026".to_string(),
                note: String::new(),
                image_offset_utf16: 3,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .expect("split date at image atom");
        assert!(search_nodes_at(
            &connection,
            "07/14/2026",
            NoteSearchScope::Active,
            fixed_today(),
        )
        .expect("cross-atom date search")
        .is_empty());

        update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "A😀07/14/2026".to_string(),
                note: String::new(),
                image_offset_utf16: 3,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .expect("save after-segment date");
        assert_eq!(
            date_rows(&connection, NODE_ID),
            vec![(
                "title".to_string(),
                3,
                13,
                "2026-07-14".to_string(),
                "2026-07-14".to_string(),
                "07/14/2026".to_string(),
            )]
        );

        update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "#leftright".to_string(),
                note: String::new(),
                image_offset_utf16: "#left".encode_utf16().count() as i64,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .expect("restore split tag fixture");
        apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string()],
                op: BatchOp::AddTag {
                    tag: search_tag(NoteTagPrefix::Hash, "left"),
                },
            },
        )
        .expect("keep existing before-segment tag");
        apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string()],
                op: BatchOp::AddTag {
                    tag: search_tag(NoteTagPrefix::Hash, "new"),
                },
            },
        )
        .expect("append a missing tag to the after segment");
        let added_content: (String, i64) = connection
            .query_row(
                "SELECT title, image_offset_utf16 FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read image title after tag append");
        assert_eq!(added_content, ("#leftright #new".to_string(), 5));
        apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string()],
                op: BatchOp::RemoveTag {
                    tag: NoteTagFilter {
                        prefix: NoteTagPrefix::Hash,
                        normalized_tag: "left".to_string(),
                    },
                },
            },
        )
        .expect("remove before-segment tag");
        let content: (String, i64) = connection
            .query_row(
                "SELECT title, image_offset_utf16 FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read updated image title");
        assert_eq!(content, ("right #new".to_string(), 0));
    }

    #[test]
    fn notes_history_fresh_current_schema_uses_temp_tables_only() {
        let vault = tempfile::tempdir().expect("temp vault");
        let connection = connect_notes_db(vault.path().to_str().expect("vault path"))
            .expect("open fresh current database");

        assert!(table_exists(&connection, "main", "notes_nodes"));
        assert!(!table_exists(&connection, "main", "notes_history_entries"));
        assert!(!table_exists(&connection, "main", "notes_history_changes"));
        assert!(table_exists(&connection, "temp", "notes_history_entries"));
        assert!(table_exists(&connection, "temp", "notes_history_changes"));
        assert_ne!(
            history_epoch(&connection).expect("session history epoch"),
            ""
        );
        assert_eq!(temp_store(&connection), 2);
    }

    #[test]
    fn notes_history_reopening_keeps_live_rows_but_allocates_a_new_temp_epoch() {
        let vault = tempfile::tempdir().expect("temp vault");
        let vault_path = vault.path().to_str().expect("vault path");
        let first = connect_notes_db(vault_path).expect("open current database");
        let first_epoch = history_epoch(&first).expect("first session history epoch");
        first
            .execute("DELETE FROM notes_nodes", [])
            .expect("clear onboarding nodes");
        insert_node(&first, NODE_ID, None, SORT_KEY_STEP, "persisted node");
        drop(first);

        let second = connect_notes_db(vault_path).expect("reopen current database");
        assert_ne!(
            history_epoch(&second).expect("second session history epoch"),
            first_epoch
        );
        assert_eq!(
            load_workspace(&second, NotesWorkspaceScope::Active)
                .expect("load persisted workspace")
                .nodes
                .len(),
            1
        );
    }

    #[test]
    fn notes_history_export_connection_installs_no_temp_history() {
        let vault = tempfile::tempdir().expect("temp vault");
        let vault_path = vault.path().to_str().expect("vault path");
        drop(connect_notes_db(vault_path).expect("create current database"));
        let connection = open_notes_export_db(vault_path).expect("open export database");

        assert!(!table_exists(&connection, "temp", "notes_history_epoch"));
        assert!(!table_exists(&connection, "temp", "notes_history_entries"));
        assert!(!table_exists(&connection, "temp", "notes_history_changes"));
    }

    #[test]
    fn export_open_rejects_a_missing_database_without_creating_notes_storage() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");

        let error = open_notes_export_db(vault_path.to_str().expect("vault path"))
            .expect_err("missing export database");

        assert!(error.contains("does not exist"));
        assert!(!vault_path.join(".yonalist").exists());
        assert!(!notes_db_path(vault_path.to_str().expect("vault path")).exists());
    }

    #[test]
    fn export_open_rejects_a_future_schema_without_file_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let database_path = notes_db_path(vault_path.to_str().expect("vault path"));
        std::fs::create_dir_all(database_path.parent().expect("metadata path"))
            .expect("create metadata fixture");
        let connection = Connection::open(&database_path).expect("create database fixture");
        connection
            .execute_batch("CREATE TABLE future_only (value TEXT); PRAGMA user_version = 99;")
            .expect("seed future schema");
        drop(connection);
        let bytes_before = std::fs::read(&database_path).expect("read database before export open");

        let error = open_notes_export_db(vault_path.to_str().expect("vault path"))
            .expect_err("future schema must be rejected");

        assert_eq!(
            error,
            "This Notes database uses unsupported schema version 99."
        );
        assert_eq!(
            std::fs::read(&database_path).expect("read database after export open"),
            bytes_before
        );
        assert!(!sqlite_companion_path(&database_path, "-wal").exists());
        assert!(!sqlite_companion_path(&database_path, "-shm").exists());
    }

    #[test]
    fn notes_connection_rejects_development_schema_versions_with_cleanup_guidance() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        for version in [1, 2, 3] {
            let vault_path = temp_dir.path().join(format!("vault-v{version}"));
            let database_path = notes_db_path(vault_path.to_str().expect("vault path"));
            std::fs::create_dir_all(database_path.parent().expect("metadata path"))
                .expect("create metadata fixture");
            let connection =
                Connection::open(&database_path).expect("create development database fixture");
            connection
                .execute_batch(&format!(
                    "CREATE TABLE old_only (value TEXT); PRAGMA user_version = {version};"
                ))
                .expect("seed development schema");
            drop(connection);

            let error = connect_notes_db(vault_path.to_str().expect("vault path"))
                .expect_err("old development schema must be rejected");

            assert_eq!(
                error,
                "개발 단계 DB — .yonalist/notes.sqlite 삭제 후 재실행"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn notes_connection_rejects_a_symlinked_database_before_sqlite_mutates_the_target() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let database_path = notes_db_path(vault_path.to_str().expect("vault path"));
        std::fs::create_dir_all(database_path.parent().expect("metadata path"))
            .expect("create metadata directory");
        let outside = temp_dir.path().join("outside.sqlite");
        std::fs::write(&outside, b"").expect("create empty outside target");
        symlink(&outside, &database_path).expect("symlink Notes database");

        let error = connect_notes_db(vault_path.to_str().expect("vault path"))
            .expect_err("symlinked Notes database must be rejected");

        assert!(
            error.contains("symlink") || error.contains("reparse"),
            "{error}"
        );
        assert_eq!(std::fs::read(outside).expect("read outside target"), b"");
        assert!(!sqlite_companion_path(&database_path, "-wal").exists());
        assert!(!sqlite_companion_path(&database_path, "-shm").exists());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn notes_connection_rejects_a_hardlinked_database_before_sqlite_mutates_the_inode() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let database_path = notes_db_path(vault_path.to_str().expect("vault path"));
        std::fs::create_dir_all(database_path.parent().expect("metadata path"))
            .expect("create metadata directory");
        let outside = temp_dir.path().join("outside.sqlite");
        std::fs::write(&outside, b"").expect("create empty outside target");
        std::fs::hard_link(&outside, &database_path).expect("hardlink Notes database");

        let error = connect_notes_db(vault_path.to_str().expect("vault path"))
            .expect_err("hardlinked Notes database must be rejected");

        assert!(error.contains("multiple hard links"), "{error}");
        assert_eq!(std::fs::read(outside).expect("read outside inode"), b"");
        assert!(!sqlite_companion_path(&database_path, "-wal").exists());
        assert!(!sqlite_companion_path(&database_path, "-shm").exists());
    }

    #[cfg(unix)]
    #[test]
    fn export_open_rejects_a_symlinked_notes_database() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let source_path = temp_dir.path().join("source.sqlite");
        let mut source = Connection::open(&source_path).expect("create source database");
        initialize_notes_db(&mut source).expect("initialize source database");
        drop(source);
        let vault_path = temp_dir.path().join("vault");
        let database_path = notes_db_path(vault_path.to_str().expect("vault path"));
        std::fs::create_dir_all(database_path.parent().expect("metadata path"))
            .expect("create metadata directory");
        symlink(&source_path, &database_path).expect("symlink export database");

        let error = open_notes_export_db(vault_path.to_str().expect("vault path"))
            .expect_err("symlinked export database must be rejected");

        assert!(
            error.contains("symlink") || error.contains("reparse"),
            "{error}"
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn export_open_rejects_a_hardlinked_notes_database() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let source_path = temp_dir.path().join("source.sqlite");
        let mut source = Connection::open(&source_path).expect("create source database");
        initialize_notes_db(&mut source).expect("initialize source database");
        drop(source);
        let vault_path = temp_dir.path().join("vault");
        let database_path = notes_db_path(vault_path.to_str().expect("vault path"));
        std::fs::create_dir_all(database_path.parent().expect("metadata path"))
            .expect("create metadata directory");
        std::fs::hard_link(&source_path, &database_path).expect("hardlink export database");

        let error = open_notes_export_db(vault_path.to_str().expect("vault path"))
            .expect_err("hardlinked export database must be rejected");

        assert!(error.contains("multiple hard links"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn notes_connection_rejects_a_database_path_swap_after_safe_file_acquisition() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let database_path = notes_db_path(vault_path.to_str().expect("vault path"));
        std::fs::create_dir_all(database_path.parent().expect("metadata path"))
            .expect("create metadata directory");
        let mut seed = Connection::open(&database_path).expect("create original database");
        initialize_notes_db(&mut seed).expect("initialize original database");
        drop(seed);
        let original_bytes = std::fs::read(&database_path).expect("read original database");
        let moved_database = temp_dir.path().join("held-original.sqlite");
        let outside = temp_dir.path().join("outside.sqlite");
        std::fs::write(&outside, b"").expect("create outside target");
        let raced_database = database_path.clone();
        let raced_moved = moved_database.clone();
        let raced_outside = outside.clone();
        inject_notes_database_after_hold_once(move || {
            std::fs::rename(&raced_database, &raced_moved).expect("move safely held database");
            symlink(&raced_outside, &raced_database).expect("swap database path to symlink");
        });

        let error = connect_notes_db(vault_path.to_str().expect("vault path"))
            .expect_err("database path swap must be rejected before initialization");

        assert!(
            error.contains("identity") || error.contains("symlink"),
            "{error}"
        );
        assert_eq!(std::fs::read(outside).expect("read outside target"), b"");
        assert_eq!(
            std::fs::read(moved_database).expect("read safely held original"),
            original_bytes
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_connection_rejects_metadata_relocation_before_sqlite_open() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let database_path = notes_db_path(vault_path.to_str().expect("vault path"));
        let metadata_path = database_path.parent().expect("metadata path").to_path_buf();
        std::fs::create_dir_all(&metadata_path).expect("create metadata directory");
        let mut seed = Connection::open(&database_path).expect("create original database");
        initialize_notes_db(&mut seed).expect("initialize original database");
        drop(seed);
        let original_bytes = std::fs::read(&database_path).expect("read original database");
        let held_metadata = vault_path.join("held-metadata");
        let attacker_metadata = vault_path.join("attacker-metadata");
        std::fs::create_dir(&attacker_metadata).expect("create attacker metadata");
        let attacker_database = attacker_metadata.join("notes.sqlite");
        std::fs::write(&attacker_database, b"").expect("create attacker database");
        let raced_metadata = metadata_path.clone();
        let raced_held = held_metadata.clone();
        let raced_attacker = attacker_metadata.clone();
        inject_notes_database_after_hold_once(move || {
            std::fs::rename(&raced_metadata, &raced_held).expect("relocate held metadata");
            symlink(&raced_attacker, &raced_metadata).expect("redirect metadata path");
        });

        let error = connect_notes_db(vault_path.to_str().expect("vault path"))
            .expect_err("metadata relocation must be rejected before SQLite initialization");

        assert!(
            error.contains("metadata directory identity changed"),
            "{error}"
        );
        assert_eq!(
            std::fs::read(attacker_database).expect("read attacker database"),
            b""
        );
        assert_eq!(
            std::fs::read(held_metadata.join("notes.sqlite")).expect("read safely held database"),
            original_bytes
        );
    }

    #[cfg(unix)]
    #[test]
    fn notes_connection_rejects_a_companion_symlink_created_after_initial_acquisition() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        let database_path = notes_db_path(vault_path.to_str().expect("vault path"));
        std::fs::create_dir_all(database_path.parent().expect("metadata path"))
            .expect("create metadata directory");
        let mut seed = Connection::open(&database_path).expect("create Notes database");
        initialize_notes_db(&mut seed).expect("initialize Notes database");
        seed.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")
            .expect("close WAL fixtures");
        drop(seed);
        let wal_path = sqlite_companion_path(&database_path, "-wal");
        assert!(!wal_path.exists(), "seed must not leave a WAL file");
        let outside = temp_dir.path().join("outside-wal");
        std::fs::write(&outside, b"").expect("create outside WAL target");
        let raced_wal = wal_path.clone();
        let raced_outside = outside.clone();
        inject_notes_database_after_hold_once(move || {
            symlink(&raced_outside, &raced_wal).expect("inject WAL symlink");
        });

        let error = connect_notes_db(vault_path.to_str().expect("vault path"))
            .expect_err("late WAL symlink must be rejected before SQLite initialization");

        assert!(
            error.contains("companion") || error.contains("symlink"),
            "{error}"
        );
        assert_eq!(
            std::fs::read(outside).expect("read outside WAL target"),
            b""
        );
    }

    #[test]
    fn windows_notes_database_acquisition_source_contract_rejects_reparse_and_delete_races() {
        let source = include_str!("repository.rs");
        let start = source
            .find("#[cfg(windows)]\nfn open_notes_file_nofollow")
            .expect("Windows no-follow database opener");
        let end = source[start..]
            .find("#[cfg(not(windows))]\nfn open_notes_file_nofollow")
            .map(|offset| start + offset)
            .expect("end of Windows database opener");
        let windows_opener = &source[start..end];

        assert!(windows_opener.contains("FILE_FLAG_OPEN_REPARSE_POINT"));
        assert!(windows_opener.contains("FILE_ATTRIBUTE_REPARSE_POINT"));
        assert!(windows_opener.contains("GetFileInformationByHandle"));
        assert_eq!(windows_notes_database_share_mode(), 0x1 | 0x2);
        assert_eq!(windows_notes_database_share_mode() & 0x4, 0);
        assert!(source.contains("CapMetadataExt::nlink(metadata) != 1"));
        assert!(source.contains("must not have multiple hard links"));
    }

    fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
        connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table info")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table columns")
            .iter()
            .any(|name| name == column)
    }

    fn primary_key_columns(connection: &Connection, table: &str) -> Vec<String> {
        let mut columns = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table primary key")
            .query_map([], |row| {
                Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
            })
            .expect("query table primary key")
            .filter_map(|row| {
                let (position, name) = row.expect("read table primary key");
                (position > 0).then_some((position, name))
            })
            .collect::<Vec<_>>();
        columns.sort_by_key(|(position, _)| *position);
        columns.into_iter().map(|(_, name)| name).collect()
    }

    fn table_columns(connection: &Connection, table: &str) -> Vec<String> {
        connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table columns")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table columns")
    }

    fn table_column_metadata(
        connection: &Connection,
        table: &str,
        column: &str,
    ) -> Option<(String, i64, Option<String>)> {
        connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table column metadata")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .expect("query table column metadata")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table column metadata")
            .into_iter()
            .find_map(|(name, column_type, not_null, default_value)| {
                (name == column).then_some((column_type, not_null, default_value))
            })
    }

    fn insert_node(
        connection: &Connection,
        id: &str,
        parent_id: Option<&str>,
        sort_key: i64,
        title: &str,
    ) -> String {
        connection
            .execute(
                "INSERT INTO notes_nodes (id, parent_id, sort_key, title, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                params![id, parent_id, sort_key, title],
            )
            .expect("insert test node");
        id.to_string()
    }

    fn test_node_count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("node count")
    }

    fn remove_onboarding_for_test(connection: &Connection) {
        connection
            .execute("DELETE FROM notes_nodes", [])
            .expect("delete onboarding nodes");
    }

    fn insert_tree(connection: &Connection) -> String {
        let root = insert_node(connection, NODE_ID, None, 1024, "root");
        insert_node(connection, CHILD_ID, Some(&root), 1024, "child");
        root
    }

    fn create_test_node(
        connection: &mut Connection,
        id: &str,
        parent_id: Option<&str>,
        after_id: Option<&str>,
        title: &str,
        note: &str,
    ) {
        create_node(
            connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: id.to_string(),
                parent_id: parent_id.map(str::to_string),
                after_id: after_id.map(str::to_string),
                title: title.to_string(),
                note: note.to_string(),
            },
        )
        .expect("create test node");
    }

    fn active_children(connection: &Connection, parent_id: Option<&str>) -> Vec<(String, i64)> {
        let mut statement = connection
            .prepare(
                "SELECT id, sort_key FROM notes_nodes \
                 WHERE parent_id IS ?1 AND deleted_at IS NULL \
                 ORDER BY sort_key, id",
            )
            .expect("prepare active children");
        statement
            .query_map([parent_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query active children")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect active children")
    }

    #[test]
    fn rejects_creating_or_moving_a_node_below_the_export_depth_cap() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp.path().to_str().expect("utf-8 vault")).expect("open database");
        remove_onboarding_for_test(&connection);
        // Build a live chain exactly MAX_NOTES_EXPORT_DEPTH deep (root = level 1).
        let mut ids = Vec::new();
        let mut parent: Option<String> = None;
        for _ in 0..super::MAX_NOTES_EXPORT_DEPTH {
            let id = uuid::Uuid::new_v4().to_string();
            insert_node(&connection, &id, parent.as_deref(), 1024, "chain");
            parent = Some(id.clone());
            ids.push(id);
        }
        let deepest = ids[super::MAX_NOTES_EXPORT_DEPTH - 1].clone();

        // A child under the deepest node would be one level past the cap.
        let create_error = create_node(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: uuid::Uuid::new_v4().to_string(),
                parent_id: Some(deepest.clone()),
                after_id: None,
                title: "too deep".to_string(),
                note: String::new(),
            },
        )
        .expect_err("a child at the export depth cap + 1 must be rejected");
        assert!(create_error.contains("nest deeper"), "{create_error}");

        // A child under the node one level shallower still sits at the cap.
        create_test_node(
            &mut connection,
            &uuid::Uuid::new_v4().to_string(),
            Some(&ids[super::MAX_NOTES_EXPORT_DEPTH - 2]),
            None,
            "exactly at the cap",
            "",
        );

        // Moving an existing node under the deepest node is rejected too.
        let mover = uuid::Uuid::new_v4().to_string();
        insert_node(&connection, &mover, None, 2048, "mover");
        let move_error = move_node(
            &mut connection,
            MoveNodeInput {
                id: mover,
                parent_id: Some(deepest),
                after_id: None,
                before_id: None,
            },
        )
        .expect_err("a move to the export depth cap + 1 must be rejected");
        assert!(move_error.contains("nest deeper"), "{move_error}");
    }

    #[test]
    fn rejects_promoting_an_image_node_to_a_topic_root() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut connection =
            connect_notes_db(temp.path().to_str().expect("utf-8 vault")).expect("open database");
        remove_onboarding_for_test(&connection);
        let root = uuid::Uuid::new_v4().to_string();
        let image = uuid::Uuid::new_v4().to_string();
        insert_node(&connection, &root, None, 1024, "root");
        insert_node(&connection, &image, Some(&root), 1024, "image child");
        connection
            .execute(
                "UPDATE notes_nodes SET node_kind = 'image', image_offset_utf16 = 0 WHERE id = ?1",
                [&image],
            )
            .expect("mark node as an image");

        let error = move_node(
            &mut connection,
            MoveNodeInput {
                id: image,
                parent_id: None,
                after_id: None,
                before_id: None,
            },
        )
        .expect_err("an image node must not be promoted to a topic root");
        assert!(error.contains("topic root"), "{error}");

        // A text child can still be promoted to a root.
        let text = uuid::Uuid::new_v4().to_string();
        insert_node(&connection, &text, Some(&root), 2048, "text child");
        move_node(
            &mut connection,
            MoveNodeInput {
                id: text,
                parent_id: None,
                after_id: None,
                before_id: None,
            },
        )
        .expect("a text node may be promoted to a root");
    }

    // R4: batch outdent is a side-door for image->root promotion. Outdenting a
    // depth-2 image lands it at the root level; that must be rejected too.
    #[test]
    fn rejects_promoting_an_image_node_to_a_root_via_batch_outdent() {
        let mut connection = test_connection();
        let root = uuid::Uuid::new_v4().to_string();
        let image = uuid::Uuid::new_v4().to_string();
        insert_node(&connection, &root, None, 1024, "root");
        insert_node(&connection, &image, Some(&root), 1024, "image child");
        connection
            .execute(
                "UPDATE notes_nodes SET node_kind = 'image', image_offset_utf16 = 0 WHERE id = ?1",
                [&image],
            )
            .expect("mark node as an image");
        let error = apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![image.clone()],
                op: BatchOp::Outdent,
            },
        )
        .expect_err("outdenting an image to the root level must be rejected");
        assert!(error.contains("topic root"), "{error}");
        assert_eq!(
            node_shape(&connection, &image).0,
            Some(root),
            "the image stays under its parent after the rejected outdent"
        );
    }

    // R4: restoring an image whose parent is gone must not promote it to a root
    // (roots are always Text); it lands under the recovery topic so the restore
    // still succeeds instead of failing.
    #[test]
    fn restores_an_orphaned_image_under_the_recovery_topic() {
        let mut connection = test_connection();
        let root = uuid::Uuid::new_v4().to_string();
        let image = uuid::Uuid::new_v4().to_string();
        insert_node(&connection, &root, None, 1024, "root");
        insert_node(&connection, &image, Some(&root), 1024, "image child");
        connection
            .execute(
                "UPDATE notes_nodes SET node_kind = 'image', image_offset_utf16 = 0 WHERE id = ?1",
                [&image],
            )
            .expect("mark node as an image");
        soft_delete_node(&mut connection, &root).expect("delete the parent");
        restore_node(&mut connection, &image).expect("restore the orphaned image");

        let (parent_id, _, _) = node_shape(&connection, &image);
        let parent_id = parent_id.expect("the restored image has a parent, not a root promotion");
        let parent_title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1 AND deleted_at IS NULL",
                [&parent_id],
                |row| row.get(0),
            )
            .expect("the recovery topic is live");
        assert_eq!(
            parent_title, "복구됨",
            "the image lands under the recovery topic"
        );
        let kind: String = connection
            .query_row(
                "SELECT node_kind FROM notes_nodes WHERE id = ?1",
                [&image],
                |row| row.get(0),
            )
            .expect("kind");
        assert_eq!(kind, "image", "the restored node keeps its image kind");
    }

    // R5: batch indent previously bypassed the depth guard entirely.
    #[test]
    fn rejects_indenting_a_node_past_the_depth_cap() {
        let mut connection = test_connection();
        let mut parent: Option<String> = None;
        for _ in 0..(super::MAX_NOTES_EXPORT_DEPTH - 1) {
            let id = uuid::Uuid::new_v4().to_string();
            insert_node(&connection, &id, parent.as_deref(), 1024, "chain");
            parent = Some(id);
        }
        let deep_parent = parent.expect("chain built");
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        insert_node(&connection, &a, Some(&deep_parent), 1024, "A");
        insert_node(&connection, &b, Some(&deep_parent), 2048, "B");
        let error = apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![b.clone()],
                op: BatchOp::Indent,
            },
        )
        .expect_err("indenting one level past the depth cap must be rejected");
        assert!(error.contains("nest deeper"), "{error}");
        assert_eq!(
            node_shape(&connection, &b).0,
            Some(deep_parent),
            "B stays under its parent after the rejected indent"
        );
    }

    // R5: the depth guard must count the MOVING subtree's own height, not just
    // the target depth — a short mover node with a tall subtree could otherwise
    // slip a deep tail past the cap.
    #[test]
    fn rejects_moving_a_tall_subtree_past_the_depth_cap() {
        let mut connection = test_connection();
        let mut parent: Option<String> = None;
        for _ in 0..100 {
            let id = uuid::Uuid::new_v4().to_string();
            insert_node(&connection, &id, parent.as_deref(), 1024, "target");
            parent = Some(id);
        }
        let target = parent.expect("target chain built");
        // A standalone subtree of height 50 (root plus a 49-deep chain).
        let subtree_root = uuid::Uuid::new_v4().to_string();
        insert_node(&connection, &subtree_root, None, 4096, "subtree root");
        let mut sub_parent = subtree_root.clone();
        for _ in 0..49 {
            let id = uuid::Uuid::new_v4().to_string();
            insert_node(&connection, &id, Some(&sub_parent), 1024, "sub");
            sub_parent = id;
        }
        // 100 (target depth) + 50 (subtree height) = 150 > the 128 cap.
        let error = move_node(
            &mut connection,
            MoveNodeInput {
                id: subtree_root.clone(),
                parent_id: Some(target),
                after_id: None,
                before_id: None,
            },
        )
        .expect_err("moving a tall subtree past the cap must be rejected");
        assert!(error.contains("nest deeper"), "{error}");
        assert_eq!(
            node_shape(&connection, &subtree_root).0,
            None,
            "the subtree stays a root after the rejected move"
        );
    }

    // ---- Paste import (notes_import_subtree) helpers + tests -----------------

    fn import_leaf(title: &str) -> ImportNode {
        ImportNode {
            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            title: title.to_string(),
            note: None,
            children: Vec::new(),
        }
    }

    fn import_context(command_kind: &str) -> NotesHistoryContext {
        NotesHistoryContext {
            session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
            entry_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_string(),
            command_kind: command_kind.to_string(),
        }
    }

    fn import_with_history(
        connection: &mut Connection,
        context: &NotesHistoryContext,
        input: ImportSubtreeInput,
    ) -> Vec<String> {
        let mut roots = Vec::new();
        with_history_transaction_and_prunes(connection, Some(context), |connection| {
            let (workspace, root_ids) = import_subtree_at(connection, input, fixed_today())?;
            roots = root_ids;
            Ok(workspace)
        })
        .expect("import subtree with history");
        roots
    }

    fn active_node_ids(connection: &Connection) -> std::collections::BTreeSet<String> {
        load_workspace(connection, NotesWorkspaceScope::Active)
            .expect("active workspace")
            .nodes
            .into_iter()
            .map(|node| node.id)
            .collect()
    }

    /// `(parent_id, sort_key, title)` for one node — the structural facts an
    /// import must place correctly and undo/redo must restore verbatim.
    fn node_shape(connection: &Connection, id: &str) -> (Option<String>, i64, String) {
        connection
            .query_row(
                "SELECT parent_id, sort_key, title FROM notes_nodes WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("node shape")
    }

    fn history_entry_count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                row.get(0)
            })
            .expect("history entry count")
    }

    #[test]
    fn imports_a_flat_forest_under_the_parent_in_order_with_one_history_entry() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        let context = import_context("importSubtree");

        let roots = import_with_history(
            &mut connection,
            &context,
            ImportSubtreeInput {
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                nodes: vec![
                    import_leaf("first"),
                    import_leaf("second"),
                    import_leaf("third"),
                ],
            },
        );

        assert_eq!(roots.len(), 3);
        let children = active_children(&connection, Some(NODE_ID));
        assert_eq!(
            children
                .iter()
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>(),
            roots,
            "imported roots land under the parent in caller order"
        );
        let titles = children
            .iter()
            .map(|(id, _)| node_shape(&connection, id).2)
            .collect::<Vec<_>>();
        assert_eq!(titles, vec!["first", "second", "third"]);
        assert!(
            children.windows(2).all(|pair| pair[0].1 < pair[1].1),
            "sort keys stay strictly increasing across the imported block"
        );
        assert_eq!(
            history_entry_count(&connection),
            1,
            "the whole import is a single history entry"
        );

        undo(
            &mut connection,
            &context.session_id,
            NotesWorkspaceScope::Active,
        )
        .expect("undo import");
        assert!(
            active_children(&connection, Some(NODE_ID)).is_empty(),
            "one undo removes every imported node"
        );
    }

    #[test]
    fn imports_a_nested_tree_with_correct_structure_and_sort_keys() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        let context = import_context("importSubtree");

        let roots = import_with_history(
            &mut connection,
            &context,
            ImportSubtreeInput {
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                nodes: vec![ImportNode {
                    marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                    title: "root".to_string(),
                    note: Some("body".to_string()),
                    children: vec![
                        ImportNode {
                            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                            title: "child-a".to_string(),
                            note: None,
                            children: vec![import_leaf("grandchild")],
                        },
                        import_leaf("child-b"),
                    ],
                }],
            },
        );

        assert_eq!(roots.len(), 1);
        let root_id = &roots[0];
        let (root_parent, root_sort, root_title) = node_shape(&connection, root_id);
        assert_eq!(root_parent.as_deref(), Some(NODE_ID));
        assert_eq!(root_sort, SORT_KEY_STEP);
        assert_eq!(root_title, "root");

        let root_children = active_children(&connection, Some(root_id));
        assert_eq!(root_children.len(), 2);
        assert_eq!(root_children[0].1, SORT_KEY_STEP);
        assert_eq!(root_children[1].1, 2 * SORT_KEY_STEP);
        let child_a = root_children[0].0.clone();
        assert_eq!(node_shape(&connection, &child_a).2, "child-a");
        assert_eq!(node_shape(&connection, &root_children[1].0).2, "child-b");

        let grandchildren = active_children(&connection, Some(&child_a));
        assert_eq!(grandchildren.len(), 1);
        assert_eq!(grandchildren[0].1, SORT_KEY_STEP);
        assert_eq!(node_shape(&connection, &grandchildren[0].0).2, "grandchild");

        let root_note: String = connection
            .query_row(
                "SELECT note FROM notes_nodes WHERE id = ?1",
                [root_id],
                |row| row.get(0),
            )
            .expect("root note");
        assert_eq!(root_note, "body");
    }

    #[test]
    fn imports_a_block_directly_after_the_requested_sibling() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "existing-x");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 2048, "existing-y");
        let context = import_context("importSubtree");

        let roots = import_with_history(
            &mut connection,
            &context,
            ImportSubtreeInput {
                parent_id: Some(NODE_ID.to_string()),
                after_id: Some(CHILD_ID.to_string()),
                nodes: vec![import_leaf("b1"), import_leaf("b2")],
            },
        );

        let ordered = active_children(&connection, Some(NODE_ID))
            .into_iter()
            .map(|(id, _)| id)
            .collect::<Vec<_>>();
        assert_eq!(
            ordered,
            vec![
                CHILD_ID.to_string(),
                roots[0].clone(),
                roots[1].clone(),
                THIRD_ID.to_string(),
            ],
            "the imported block sits contiguously right after afterId"
        );
    }

    #[test]
    fn rejects_an_empty_subtree_import() {
        let mut connection = test_connection();
        let error = import_subtree_at(
            &mut connection,
            ImportSubtreeInput {
                parent_id: None,
                after_id: None,
                nodes: Vec::new(),
            },
            fixed_today(),
        )
        .expect_err("empty import must be rejected");
        assert!(
            error.contains("at least one node"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn rejects_an_oversized_subtree_import_without_writing_anything() {
        let mut connection = test_connection();
        let nodes = (0..=MAX_IMPORT_SUBTREE_NODES)
            .map(|index| import_leaf(&format!("n{index}")))
            .collect::<Vec<_>>();
        let error = import_subtree_at(
            &mut connection,
            ImportSubtreeInput {
                parent_id: None,
                after_id: None,
                nodes,
            },
            fixed_today(),
        )
        .expect_err("oversized import must be rejected");
        assert!(error.contains("cannot exceed"), "unexpected error: {error}");
        assert!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("workspace")
                .nodes
                .is_empty(),
            "a rejected import writes nothing"
        );
    }

    #[test]
    fn undo_then_redo_restores_the_identical_imported_subtree() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        let context = import_context("importSubtree");

        let before = active_node_ids(&connection);
        import_with_history(
            &mut connection,
            &context,
            ImportSubtreeInput {
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                nodes: vec![ImportNode {
                    marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                    title: "root".to_string(),
                    note: Some("body".to_string()),
                    children: vec![import_leaf("child-a"), import_leaf("child-b")],
                }],
            },
        );
        let after = active_node_ids(&connection);
        let imported = after.difference(&before).cloned().collect::<Vec<_>>();
        assert_eq!(imported.len(), 3);
        let snapshot = imported
            .iter()
            .map(|id| (id.clone(), node_shape(&connection, id)))
            .collect::<Vec<_>>();

        undo(
            &mut connection,
            &context.session_id,
            NotesWorkspaceScope::Active,
        )
        .expect("undo import");
        let after_undo = active_node_ids(&connection);
        assert!(
            imported.iter().all(|id| !after_undo.contains(id)),
            "undo removes every imported node"
        );

        redo(
            &mut connection,
            &context.session_id,
            NotesWorkspaceScope::Active,
        )
        .expect("redo import");
        let restored = imported
            .iter()
            .map(|id| (id.clone(), node_shape(&connection, id)))
            .collect::<Vec<_>>();
        assert_eq!(
            restored, snapshot,
            "redo restores the identical subtree (same ids, parents, sort keys, titles)"
        );
    }

    fn insert_test_attachment(connection: &Connection, index: usize, node_id: &str) -> String {
        let id = format!("{index:08x}-aaaa-4aaa-8aaa-{index:012x}");
        let content_hash = format!("{index:064x}");
        connection
            .execute(
                "INSERT INTO notes_attachments (\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (\
                   ?1, ?2, ?3, ?4, ?5, 'image.png', 'image/png', 1, 160, 160, 160, \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'\
                 )",
                params![
                    id,
                    node_id,
                    i64::try_from(index + 1).expect("attachment sort key") * SORT_KEY_STEP,
                    format!("notes-assets/{content_hash}.png"),
                    content_hash
                ],
            )
            .expect("insert test attachment");
        id
    }

    fn test_new_attachment(index: usize, node_id: &str) -> NewAttachment {
        let content_hash = format!("{index:064x}");
        NewAttachment {
            id: format!("{index:08x}-bbbb-4bbb-8bbb-{index:012x}"),
            node_id: node_id.to_string(),
            relative_path: format!("notes-assets/{content_hash}.png"),
            content_hash,
            original_name: "image.png".to_string(),
            mime_type: "image/png".to_string(),
            byte_size: 1,
            intrinsic_width: 160,
            intrinsic_height: 160,
            display_width: 160,
        }
    }

    fn test_new_image_node(index: usize, node_id: &str, attachment_id: &str) -> NewImageNode {
        let mut attachment = test_new_attachment(index, node_id);
        attachment.id = attachment_id.to_string();
        NewImageNode {
            id: node_id.to_string(),
            title: attachment.original_name.clone(),
            attachment,
        }
    }

    #[test]
    fn image_node_batch_repository_rejects_shared_node_and_attachment_ids_before_publication() {
        for (label, nodes) in [
            ("same item", vec![test_new_image_node(90, NODE_ID, NODE_ID)]),
            (
                "cross item",
                vec![
                    test_new_image_node(91, NODE_ID, CHILD_ID),
                    test_new_image_node(92, CHILD_ID, THIRD_ID),
                ],
            ),
        ] {
            let mut connection = test_connection();
            let mut published = false;

            let error = create_image_nodes_coordinated(
                &mut connection,
                None,
                None,
                nodes,
                || {
                    published = true;
                    Ok(())
                },
                || Ok(()),
            )
            .expect_err(label);

            assert!(
                error.contains("both a node and attachment ID"),
                "{label}: {error}"
            );
            assert!(!published, "{label}: publication must not run");
            let counts: (i64, i64, i64, i64) = connection
                .query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM notes_nodes), \
                       (SELECT COUNT(*) FROM notes_attachments), \
                       (SELECT COUNT(*) FROM notes_history_entries), \
                       (SELECT COUNT(*) FROM notes_history_changes)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("count rejected image node batch rows");
            assert_eq!(counts, (0, 0, 0, 0), "{label}");
        }
    }

    #[test]
    fn image_node_batch_repository_rejects_existing_opposite_table_ids_before_publication() {
        for collision in ["node matches attachment", "attachment matches node"] {
            let mut connection = test_connection();
            insert_node(&connection, NODE_ID, None, 1024, "existing root");
            let nodes = if collision == "node matches attachment" {
                let seeded_attachment = insert_test_attachment(&connection, 93, NODE_ID);
                connection
                    .execute(
                        "UPDATE notes_attachments SET id = ?1 WHERE id = ?2",
                        params![CHILD_ID, seeded_attachment],
                    )
                    .expect("align existing attachment ID with incoming node ID");
                vec![test_new_image_node(94, CHILD_ID, THIRD_ID)]
            } else {
                vec![test_new_image_node(95, CHILD_ID, NODE_ID)]
            };
            let mut published = false;

            let error = create_image_nodes_coordinated(
                &mut connection,
                None,
                Some(NODE_ID),
                nodes,
                || {
                    published = true;
                    Ok(())
                },
                || Ok(()),
            )
            .expect_err(collision);

            assert!(error.contains("already in use"), "{collision}: {error}");
            assert!(!published, "{collision}: publication must not run");
            let counts: (i64, i64, i64, i64) = connection
                .query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM notes_nodes), \
                       (SELECT COUNT(*) FROM notes_attachments), \
                       (SELECT COUNT(*) FROM notes_history_entries), \
                       (SELECT COUNT(*) FROM notes_history_changes)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("count rejected opposite-table collision rows");
            let expected_attachment_count = if collision == "node matches attachment" {
                1
            } else {
                0
            };
            assert_eq!(counts, (1, expected_attachment_count, 0, 0), "{collision}");
        }
    }

    #[test]
    fn image_node_ownership_allows_semantic_content_updates_but_rejects_attachment_mutations() {
        let mut connection = test_connection();
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, sort_key, title, note, node_kind, created_at, updated_at\
                 ) VALUES (?1, 1024, 'image.png', '', 'image', \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                [NODE_ID],
            )
            .expect("seed image node");
        let attachment_id = insert_test_attachment(&connection, 90, NODE_ID);
        connection
            .execute(
                "UPDATE notes_attachments SET intrinsic_width = 320, display_width = 320 \
                 WHERE id = ?1",
                [&attachment_id],
            )
            .expect("seed resizable image attachment");

        let renamed = update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "renamed.png".to_string(),
                note: "description".to_string(),
                image_offset_utf16: 0,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .expect("image content update");
        let renamed_node = renamed
            .nodes
            .iter()
            .find(|node| node.id == NODE_ID)
            .expect("renamed image node");
        assert_eq!(renamed_node.title, "renamed.png");
        assert_eq!(renamed_node.note, "description");
        let unchanged: (String, String) = connection
            .query_row(
                "SELECT title, note FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("updated image node content");
        assert_eq!(
            unchanged,
            ("renamed.png".to_string(), "description".to_string())
        );

        let updated = update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "image.png".to_string(),
                note: "supporting description".to_string(),
                image_offset_utf16: 0,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .expect("image description update");
        let image_node = updated
            .nodes
            .iter()
            .find(|node| node.id == NODE_ID)
            .expect("updated image node");
        assert_eq!(image_node.title, "image.png");
        assert_eq!(image_node.note, "supporting description");

        let split_error = split_node_at(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: CHILD_ID.to_string(),
                prefix: "image".to_string(),
                suffix: ".png".to_string(),
            },
            fixed_today(),
        )
        .expect_err("image nodes cannot be split");
        assert!(split_error.contains("image"), "{split_error}");

        let add_error = create_attachment(&mut connection, test_new_attachment(91, NODE_ID))
            .expect_err("generic attachment add must reject image owner");
        assert!(add_error.contains("image node"), "{add_error}");
        let publish_called = std::cell::Cell::new(false);
        let coordinated_error = create_attachments_coordinated_for_node(
            &mut connection,
            NODE_ID,
            vec![test_new_attachment(92, NODE_ID)],
            || {
                publish_called.set(true);
                Ok(())
            },
            || Ok(()),
        )
        .expect_err("coordinated attachment add must reject image owner");
        assert!(
            coordinated_error.contains("image node"),
            "{coordinated_error}"
        );
        assert!(!publish_called.get());

        let remove_error = remove_attachment(&mut connection, &attachment_id)
            .expect_err("generic attachment removal must reject image owner");
        assert!(remove_error.contains("image node"), "{remove_error}");
        let attachment_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_attachments WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("image attachment remains owned");
        assert_eq!(attachment_count, 1);

        let resized = resize_attachment(&mut connection, &attachment_id, 200)
            .expect("image node attachment resize remains valid");
        assert_eq!(
            resized.attachments_by_node_id[NODE_ID][0].display_width,
            200
        );
    }

    #[test]
    fn attachment_insert_rejects_the_129th_row_for_one_node_transactionally() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        for index in 0..MAX_NOTE_ATTACHMENTS_PER_NODE {
            insert_test_attachment(
                &connection,
                usize::try_from(index).expect("attachment index"),
                NODE_ID,
            );
        }

        let error = create_attachment(&mut connection, test_new_attachment(10_000, NODE_ID))
            .expect_err("129th node attachment");

        assert_eq!(error, "A Note node can contain at most 128 attachments.");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_attachments WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("count node attachments");
        assert_eq!(count, MAX_NOTE_ATTACHMENTS_PER_NODE);
    }

    #[test]
    fn coordinated_attachment_batch_inserts_in_source_order_inside_one_transaction() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        let first = test_new_attachment(30_000, NODE_ID);
        let second = test_new_attachment(30_001, NODE_ID);
        let expected_ids = [first.id.clone(), second.id.clone()];

        let workspace = create_attachments_coordinated_for_node(
            &mut connection,
            NODE_ID,
            vec![first, second],
            || Ok(()),
            || Ok(()),
        )
        .expect("coordinated attachment batch");

        let ids = workspace.attachments_by_node_id[NODE_ID]
            .iter()
            .map(|attachment| attachment.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            expected_ids.iter().map(String::as_str).collect::<Vec<_>>()
        );
    }

    #[test]
    fn coordinated_attachment_batch_rejects_node_capacity_before_publication() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        for index in 0..(MAX_NOTE_ATTACHMENTS_PER_NODE - 1) {
            insert_test_attachment(
                &connection,
                usize::try_from(index).expect("attachment index"),
                NODE_ID,
            );
        }
        let publish_called = std::cell::Cell::new(false);

        let error = create_attachments_coordinated_for_node(
            &mut connection,
            NODE_ID,
            vec![
                test_new_attachment(30_000, NODE_ID),
                test_new_attachment(30_001, NODE_ID),
            ],
            || {
                publish_called.set(true);
                Ok(())
            },
            || Ok(()),
        )
        .expect_err("capacity preflight");

        assert_eq!(error, "A Note node can contain at most 128 attachments.");
        assert!(!publish_called.get(), "capacity must precede publication");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_attachments WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("count node attachments");
        assert_eq!(count, MAX_NOTE_ATTACHMENTS_PER_NODE - 1);
    }

    #[test]
    fn coordinated_attachment_batch_rejects_vault_capacity_before_publication() {
        let mut connection = test_connection();
        for (id, sort_key) in [
            (NODE_ID, 1024),
            (CHILD_ID, 2048),
            (THIRD_ID, 3072),
            (FOURTH_ID, 4096),
            (FIFTH_ID, 5120),
        ] {
            insert_node(&connection, id, None, sort_key, id);
        }
        let populated_nodes = [NODE_ID, CHILD_ID, THIRD_ID, FOURTH_ID];
        for index in 0..(MAX_NOTE_ATTACHMENTS_PER_VAULT - 1) {
            let node_index = usize::try_from(index / MAX_NOTE_ATTACHMENTS_PER_NODE)
                .expect("attachment node index");
            insert_test_attachment(
                &connection,
                usize::try_from(index).expect("attachment index"),
                populated_nodes[node_index],
            );
        }
        let publish_called = std::cell::Cell::new(false);

        let error = create_attachments_coordinated_for_node(
            &mut connection,
            FIFTH_ID,
            vec![
                test_new_attachment(31_000, FIFTH_ID),
                test_new_attachment(31_001, FIFTH_ID),
            ],
            || {
                publish_called.set(true);
                Ok(())
            },
            || Ok(()),
        )
        .expect_err("vault capacity preflight");

        assert_eq!(error, "A Notes vault can contain at most 512 attachments.");
        assert!(!publish_called.get(), "capacity must precede publication");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count vault attachments");
        assert_eq!(count, MAX_NOTE_ATTACHMENTS_PER_VAULT - 1);
    }

    #[test]
    fn coordinated_attachment_batch_rejects_duplicate_ids_before_publication() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        let first = test_new_attachment(32_000, NODE_ID);
        let mut second = test_new_attachment(32_001, NODE_ID);
        second.id = first.id.clone();
        let publish_called = std::cell::Cell::new(false);

        let error = create_attachments_coordinated_for_node(
            &mut connection,
            NODE_ID,
            vec![first, second],
            || {
                publish_called.set(true);
                Ok(())
            },
            || Ok(()),
        )
        .expect_err("duplicate attachment IDs");

        assert!(
            error.contains("already in use"),
            "unexpected error: {error}"
        );
        assert!(
            !publish_called.get(),
            "ID validation must precede publication"
        );
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments");
        assert_eq!(count, 0);
    }

    #[test]
    fn coordinated_attachment_batch_rejects_an_id_used_by_a_node_before_publication() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        let mut attachment = test_new_attachment(32_002, NODE_ID);
        attachment.id = NODE_ID.to_string();
        let publish_called = std::cell::Cell::new(false);

        let error = create_attachments_coordinated_for_node(
            &mut connection,
            NODE_ID,
            vec![attachment],
            || {
                publish_called.set(true);
                Ok(())
            },
            || Ok(()),
        )
        .expect_err("attachment ID already belongs to a node");

        assert!(error.contains("already in use"), "{error}");
        assert!(
            !publish_called.get(),
            "ID validation must precede publication"
        );
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments");
        assert_eq!(count, 0);
    }

    #[test]
    fn coordinated_attachment_batch_publication_failure_leaves_zero_rows() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");

        let error = create_attachments_coordinated_for_node(
            &mut connection,
            NODE_ID,
            vec![
                test_new_attachment(33_000, NODE_ID),
                test_new_attachment(33_001, NODE_ID),
            ],
            || Err("publication failed".to_string()),
            || Ok(()),
        )
        .expect_err("publication failure");

        assert_eq!(error, "publication failed");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments");
        assert_eq!(count, 0);
    }

    #[test]
    fn coordinated_attachment_batch_before_commit_failure_rolls_back_all_rows() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");

        let error = create_attachments_coordinated_for_node(
            &mut connection,
            NODE_ID,
            vec![
                test_new_attachment(34_000, NODE_ID),
                test_new_attachment(34_001, NODE_ID),
            ],
            || Ok(()),
            || Err("identity changed".to_string()),
        )
        .expect_err("before commit failure");

        assert_eq!(error, "identity changed");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments");
        assert_eq!(count, 0);
    }

    #[test]
    fn coordinated_attachment_batch_rejects_sort_key_overflow_before_publication() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        let existing_id = insert_test_attachment(&connection, 35_000, NODE_ID);
        connection
            .execute(
                "UPDATE notes_attachments SET sort_key = ?1 WHERE id = ?2",
                params![i64::MAX - SORT_KEY_STEP, existing_id],
            )
            .expect("move existing attachment near sort-key limit");
        let publish_called = std::cell::Cell::new(false);

        let error = create_attachments_coordinated_for_node(
            &mut connection,
            NODE_ID,
            vec![
                test_new_attachment(35_001, NODE_ID),
                test_new_attachment(35_002, NODE_ID),
            ],
            || {
                publish_called.set(true);
                Ok(())
            },
            || Ok(()),
        )
        .expect_err("sort-key overflow");

        assert_eq!(error, "The Notes attachment ordering is too large.");
        assert!(!publish_called.get(), "ordering must precede publication");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments");
        assert_eq!(count, 1);
    }

    #[test]
    fn coordinated_attachment_batch_without_history_context_creates_no_history_row() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");

        create_attachments_coordinated_for_node(
            &mut connection,
            NODE_ID,
            vec![test_new_attachment(36_000, NODE_ID)],
            || Ok(()),
            || Ok(()),
        )
        .expect("unjournaled attachment batch");

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                row.get(0)
            })
            .expect("count history entries");
        assert_eq!(count, 0);
    }

    #[test]
    fn coordinated_attachment_batch_publishes_before_the_write_transaction() {
        // Pins the file-before-commit ordering from remediation 1.3: `publish`
        // (the file I/O) runs *before* the metadata write transaction opens, so
        // no write lock is held while attachment bytes are written. A second
        // connection must be able to take the single WAL writer slot during
        // `publish`; if a future change moved publication back inside the
        // IMMEDIATE metadata transaction, that probe would see SQLITE_BUSY and
        // this test would fail.
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        let mut connection = connect_notes_db(&vault_path).expect("open notes database");
        insert_node(&connection, NODE_ID, None, 1024, "root");
        let database_path = notes_db_path(&vault_path);

        let observed_writer_slot_free = std::cell::Cell::new(false);
        let workspace = create_attachments_coordinated_for_node(
            &mut connection,
            NODE_ID,
            vec![
                test_new_attachment(38_000, NODE_ID),
                test_new_attachment(38_001, NODE_ID),
            ],
            || {
                let probe = Connection::open(&database_path).expect("second connection");
                probe
                    .busy_timeout(Duration::from_millis(0))
                    .expect("disable probe busy wait");
                probe
                    .execute_batch("BEGIN IMMEDIATE; COMMIT;")
                    .expect("publish must not hold the metadata write transaction");
                observed_writer_slot_free.set(true);
                Ok(())
            },
            || Ok(()),
        )
        .expect("coordinated attachment batch");

        assert!(
            observed_writer_slot_free.get(),
            "publish closure must have run and observed a free writer slot"
        );
        assert_eq!(
            workspace.attachments_by_node_id[NODE_ID].len(),
            2,
            "the metadata rows must still commit after publication"
        );
    }

    #[test]
    fn attachment_insert_rejects_the_513th_persisted_row_across_the_vault() {
        let mut connection = test_connection();
        for (id, sort_key) in [
            (NODE_ID, 1024),
            (CHILD_ID, 2048),
            (THIRD_ID, 3072),
            (FOURTH_ID, 4096),
            (FIFTH_ID, 5120),
        ] {
            insert_node(&connection, id, None, sort_key, id);
        }
        let populated_nodes = [NODE_ID, CHILD_ID, THIRD_ID, FOURTH_ID];
        for index in 0..MAX_NOTE_ATTACHMENTS_PER_VAULT {
            let node_index = usize::try_from(index / MAX_NOTE_ATTACHMENTS_PER_NODE)
                .expect("attachment node index");
            insert_test_attachment(
                &connection,
                usize::try_from(index).expect("attachment index"),
                populated_nodes[node_index],
            );
        }

        let error = create_attachment(&mut connection, test_new_attachment(20_000, FIFTH_ID))
            .expect_err("513th vault attachment");

        assert_eq!(error, "A Notes vault can contain at most 512 attachments.");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count vault attachments");
        assert_eq!(count, MAX_NOTE_ATTACHMENTS_PER_VAULT);
    }

    #[test]
    fn attachment_restore_cannot_bypass_the_persisted_vault_limit() {
        let mut connection = test_connection();
        for (id, sort_key) in [
            (NODE_ID, 1024),
            (CHILD_ID, 2048),
            (THIRD_ID, 3072),
            (FOURTH_ID, 4096),
            (FIFTH_ID, 5120),
        ] {
            insert_node(&connection, id, None, sort_key, id);
        }
        let populated_nodes = [NODE_ID, CHILD_ID, THIRD_ID, FOURTH_ID];
        for index in 0..MAX_NOTE_ATTACHMENTS_PER_VAULT {
            let node_index = usize::try_from(index / MAX_NOTE_ATTACHMENTS_PER_NODE)
                .expect("attachment node index");
            insert_test_attachment(
                &connection,
                usize::try_from(index).expect("attachment index"),
                populated_nodes[node_index],
            );
        }
        let attachment = NoteAttachment {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd".to_string(),
            node_id: FIFTH_ID.to_string(),
            sort_key: 1024,
            relative_path: "notes-assets/restored.png".to_string(),
            content_hash: "d".repeat(64),
            original_name: "restored.png".to_string(),
            mime_type: "image/png".to_string(),
            byte_size: 1,
            intrinsic_width: 160,
            intrinsic_height: 160,
            display_width: 160,
            created_at: "2026-07-10T00:00:00.000Z".to_string(),
            updated_at: "2026-07-10T00:00:00.000Z".to_string(),
        };

        let error = restore_attachment(&mut connection, attachment)
            .expect_err("restore beyond vault limit");

        assert_eq!(error, "A Notes vault can contain at most 512 attachments.");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments after rejected restore");
        assert_eq!(count, MAX_NOTE_ATTACHMENTS_PER_VAULT);
    }

    #[test]
    fn new_node_rejects_an_id_reserved_by_retained_attachment_history() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "owner");
        let attachment = test_new_attachment(20_001, NODE_ID);
        let reserved_id = attachment.id.clone();
        create_attachment(&mut connection, attachment).expect("create attachment");
        let context = NotesHistoryContext {
            session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            history_epoch: crate::notes::types::TEST_CURRENT_HISTORY_EPOCH.to_string(),
            entry_id: "99999999-9999-4999-8999-999999999999".to_string(),
            command_kind: "removeAttachment".to_string(),
        };
        with_history_transaction_and_prunes(&mut connection, Some(&context), |connection| {
            remove_attachment(connection, &reserved_id)
        })
        .expect("remove attachment with retained history");

        let error = create_node(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: reserved_id,
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                title: "must not reuse attachment history ID".to_string(),
                note: String::new(),
            },
        )
        .expect_err("retained attachment history reserves its ID");

        assert!(error.contains("already in use"), "{error}");
        assert_eq!(history_entry_count(&connection), 1);
        assert_eq!(active_children(&connection, None).len(), 1);
    }

    #[test]
    fn restore_attachment_rejects_an_id_used_by_a_live_node() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "owner");
        insert_node(&connection, CHILD_ID, None, 2048, "colliding node");
        let attachment = NoteAttachment {
            id: CHILD_ID.to_string(),
            node_id: NODE_ID.to_string(),
            sort_key: 1024,
            relative_path: "notes-assets/restored.png".to_string(),
            content_hash: "d".repeat(64),
            original_name: "restored.png".to_string(),
            mime_type: "image/png".to_string(),
            byte_size: 1,
            intrinsic_width: 160,
            intrinsic_height: 160,
            display_width: 160,
            created_at: "2026-07-10T00:00:00.000Z".to_string(),
            updated_at: "2026-07-10T00:00:00.000Z".to_string(),
        };

        let error = restore_attachment(&mut connection, attachment)
            .expect_err("restore must preserve the shared ID namespace");

        assert!(error.contains("already exists"), "{error}");
        let attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count restored attachments");
        assert_eq!(attachment_count, 0);
    }

    #[test]
    fn initialization_rejects_existing_node_attachment_id_collisions() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "owner");
        insert_node(&connection, CHILD_ID, None, 2048, "colliding node");
        let content_hash = "e".repeat(64);
        connection
            .execute(
                "INSERT INTO notes_attachments (\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (?1, ?2, 1024, ?3, ?4, 'image.png', 'image/png', 1, 160, 160, 160, \
                   '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')",
                params![
                    CHILD_ID,
                    NODE_ID,
                    format!("notes-assets/{content_hash}.png"),
                    content_hash
                ],
            )
            .expect("seed legacy cross-table collision");

        let error = initialize_notes_db(&mut connection)
            .expect_err("existing cross-table IDs must fail storage validation");

        assert!(error.contains("ID namespace"), "{error}");
    }

    #[test]
    fn initialization_ignores_session_history_when_validating_live_id_namespace() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "live node");
        let entry_id = "99999999-9999-4999-8999-999999999999";
        connection
            .execute(
                "INSERT INTO notes_history_entries(\
                   id, session_id, sequence, is_undone, estimated_bytes, command_kind\
                 ) VALUES (?1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 0, 1, 'legacy')",
                [entry_id],
            )
            .expect("seed retained history entry");
        connection
            .execute(
                "INSERT INTO notes_history_changes(\
                   entry_id, table_name, row_id, ordinal, before_json, after_json\
                 ) VALUES (?1, 'notes_attachments', ?2, 1, NULL, '{}')",
                params![entry_id, NODE_ID],
            )
            .expect("seed retained attachment history");

        initialize_notes_db(&mut connection)
            .expect("initialization validates only persisted live rows");
    }

    #[test]
    fn initialization_ignores_session_history_only_id_collisions() {
        let mut connection = test_connection();
        let entry_id = "99999999-9999-4999-8999-999999999999";
        connection
            .execute(
                "INSERT INTO notes_history_entries(\
                   id, session_id, sequence, is_undone, estimated_bytes, command_kind\
                 ) VALUES (?1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 0, 1, 'legacy')",
                [entry_id],
            )
            .expect("seed retained history entry");
        for (ordinal, table_name) in [(1_i64, "notes_nodes"), (2, "notes_attachments")] {
            connection
                .execute(
                    "INSERT INTO notes_history_changes(\
                       entry_id, table_name, row_id, ordinal, before_json, after_json\
                     ) VALUES (?1, ?2, ?3, ?4, NULL, '{}')",
                    params![entry_id, table_name, CHILD_ID, ordinal],
                )
                .expect("seed cross-kind retained history");
        }

        initialize_notes_db(&mut connection)
            .expect("initialization ignores connection-local history rows");
    }

    #[test]
    fn trashed_attachment_rows_count_until_empty_trash_releases_capacity() {
        let mut connection = test_connection();
        for (id, sort_key) in [
            (NODE_ID, 1024),
            (CHILD_ID, 2048),
            (THIRD_ID, 3072),
            (FOURTH_ID, 4096),
            (FIFTH_ID, 5120),
        ] {
            insert_node(&connection, id, None, sort_key, id);
        }
        let populated_nodes = [NODE_ID, CHILD_ID, THIRD_ID, FOURTH_ID];
        for index in 0..MAX_NOTE_ATTACHMENTS_PER_VAULT {
            let node_index = usize::try_from(index / MAX_NOTE_ATTACHMENTS_PER_NODE)
                .expect("attachment node index");
            insert_test_attachment(
                &connection,
                usize::try_from(index).expect("attachment index"),
                populated_nodes[node_index],
            );
        }
        soft_delete_node(&mut connection, NODE_ID).expect("trash populated root");

        let error = create_attachment(&mut connection, test_new_attachment(40_000, FIFTH_ID))
            .expect_err("trashed metadata still counts");
        assert_eq!(error, "A Notes vault can contain at most 512 attachments.");

        empty_trash(&mut connection).expect("empty populated trash");
        create_attachment(&mut connection, test_new_attachment(40_001, FIFTH_ID))
            .expect("capacity released after empty trash");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments after empty trash");
        assert_eq!(
            count,
            MAX_NOTE_ATTACHMENTS_PER_VAULT - MAX_NOTE_ATTACHMENTS_PER_NODE + 1
        );
    }

    #[test]
    fn collapse_all_updates_only_expandable_nodes_in_the_selected_active_subtree() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "branch");
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "leaf");
        insert_node(&connection, FOURTH_ID, None, 2048, "unrelated root");
        insert_node(
            &connection,
            FIFTH_ID,
            Some(FOURTH_ID),
            1024,
            "unrelated child",
        );
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = '2026-07-10T00:00:00.000Z'",
                [],
            )
            .expect("reset timestamps");

        let workspace = collapse_all(&mut connection, NODE_ID).expect("collapse subtree");

        let state = workspace
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node.is_collapsed))
            .collect::<HashMap<_, _>>();
        assert_eq!(state.get(NODE_ID), Some(&true));
        assert_eq!(state.get(CHILD_ID), Some(&true));
        assert_eq!(state.get(THIRD_ID), Some(&false));
        assert_eq!(state.get(FOURTH_ID), Some(&false));
        let untouched: Vec<String> = connection
            .prepare(
                "SELECT id FROM notes_nodes \
                 WHERE updated_at = '2026-07-10T00:00:00.000Z' ORDER BY id",
            )
            .expect("prepare untouched nodes")
            .query_map([], |row| row.get(0))
            .expect("query untouched nodes")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect untouched nodes");
        assert_eq!(
            untouched,
            vec![
                THIRD_ID.to_string(),
                FOURTH_ID.to_string(),
                FIFTH_ID.to_string()
            ]
        );
    }

    #[test]
    fn expand_all_updates_only_collapsed_branches_in_the_selected_active_subtree() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "branch");
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "leaf");
        insert_node(&connection, FOURTH_ID, None, 2048, "unrelated root");
        insert_node(
            &connection,
            FIFTH_ID,
            Some(FOURTH_ID),
            1024,
            "unrelated child",
        );
        connection
            .execute(
                "UPDATE notes_nodes SET is_collapsed = 1, \
                   updated_at = '2026-07-10T00:00:00.000Z'",
                [],
            )
            .expect("collapse seeded nodes");

        let workspace = expand_all(&mut connection, NODE_ID).expect("expand subtree");

        let state = workspace
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node.is_collapsed))
            .collect::<HashMap<_, _>>();
        assert_eq!(state.get(NODE_ID), Some(&false));
        assert_eq!(state.get(CHILD_ID), Some(&false));
        assert_eq!(state.get(THIRD_ID), Some(&true));
        assert_eq!(state.get(FOURTH_ID), Some(&true));
        let untouched: Vec<String> = connection
            .prepare(
                "SELECT id FROM notes_nodes \
                 WHERE updated_at = '2026-07-10T00:00:00.000Z' ORDER BY id",
            )
            .expect("prepare untouched nodes")
            .query_map([], |row| row.get(0))
            .expect("query untouched nodes")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect untouched nodes");
        assert_eq!(
            untouched,
            vec![
                THIRD_ID.to_string(),
                FOURTH_ID.to_string(),
                FIFTH_ID.to_string()
            ]
        );
    }

    #[test]
    fn collapse_all_rejects_a_two_node_cycle_without_mutation() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        connection
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1 WHERE id = ?2",
                params![CHILD_ID, NODE_ID],
            )
            .expect("create two-node cycle");
        let before = persistent_state(&connection);

        let error = collapse_all(&mut connection, NODE_ID).expect_err("cyclic collapse");

        assert_eq!(
            error,
            "The Notes tree contains a cycle and cannot be expanded or collapsed."
        );
        assert_eq!(persistent_state(&connection), before);
    }

    #[test]
    fn expand_all_rejects_a_deeper_cycle_without_mutation() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "grandchild");
        connection
            .execute("UPDATE notes_nodes SET is_collapsed = 1", [])
            .expect("collapse cyclic branches");
        connection
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1 WHERE id = ?2",
                params![THIRD_ID, NODE_ID],
            )
            .expect("create three-node cycle");
        let before = persistent_state(&connection);

        let error = expand_all(&mut connection, NODE_ID).expect_err("cyclic expand");

        assert_eq!(
            error,
            "The Notes tree contains a cycle and cannot be expanded or collapsed."
        );
        assert_eq!(persistent_state(&connection), before);
    }

    #[test]
    fn sort_subtree_ascending_is_unicode_case_insensitive_stable_and_parent_scoped() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 17, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 71, "beta");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 72, "Alpha");
        insert_node(&connection, FOURTH_ID, Some(NODE_ID), 73, "ALPHA");
        insert_node(&connection, FIFTH_ID, Some(NODE_ID), 74, "한글");
        insert_node(&connection, SIXTH_ID, Some(NODE_ID), 75, "");
        insert_node(&connection, SEVENTH_ID, Some(NODE_ID), 76, "  Untitled  ");
        insert_node(&connection, EIGHTH_ID, None, 16, "unrelated root");
        let nested_later = "99999999-9999-4999-8999-999999999999";
        let nested_first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        insert_node(&connection, nested_later, Some(CHILD_ID), 3, "Zulu");
        insert_node(&connection, nested_first, Some(CHILD_ID), 4, "Able");
        connection
            .execute(
                "UPDATE notes_nodes SET completed_at = '2026-07-10T00:00:00.000Z' \
                 WHERE id = ?1",
                [FOURTH_ID],
            )
            .expect("complete equal-title node");

        let workspace = sort_subtree_ascending(&mut connection, NODE_ID)
            .expect("sort selected subtree ascending");

        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![
                (THIRD_ID.to_string(), 1024),
                (FOURTH_ID.to_string(), 2048),
                (CHILD_ID.to_string(), 3072),
                (SIXTH_ID.to_string(), 4096),
                (SEVENTH_ID.to_string(), 5120),
                (FIFTH_ID.to_string(), 6144),
            ]
        );
        assert_eq!(
            active_children(&connection, Some(CHILD_ID)),
            vec![
                (nested_first.to_string(), 1024),
                (nested_later.to_string(), 2048)
            ]
        );
        assert_eq!(
            active_children(&connection, None),
            vec![(EIGHTH_ID.to_string(), 16), (NODE_ID.to_string(), 17)]
        );
        assert!(workspace
            .nodes
            .iter()
            .find(|node| node.id == FOURTH_ID)
            .expect("completed node")
            .completed_at
            .is_some());
    }

    #[test]
    fn sort_subtree_descending_reverses_titles_without_reversing_equal_groups() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 17, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 71, "beta");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 72, "Alpha");
        insert_node(&connection, FOURTH_ID, Some(NODE_ID), 73, "ALPHA");
        insert_node(&connection, FIFTH_ID, Some(NODE_ID), 74, "한글");
        insert_node(&connection, SIXTH_ID, Some(NODE_ID), 75, "");
        insert_node(&connection, SEVENTH_ID, Some(NODE_ID), 76, "untitled");

        sort_subtree_descending(&mut connection, NODE_ID)
            .expect("sort selected subtree descending");

        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![
                (FIFTH_ID.to_string(), 1024),
                (SIXTH_ID.to_string(), 2048),
                (SEVENTH_ID.to_string(), 3072),
                (CHILD_ID.to_string(), 4096),
                (THIRD_ID.to_string(), 5120),
                (FOURTH_ID.to_string(), 6144),
            ]
        );
    }

    #[test]
    fn sorting_an_ordinary_subtree_rejects_readonly_and_plugin_owned_descendants() {
        for (label, is_readonly, plugin_state, plugin_meta) in [
            ("readonly", Some(1), None, None),
            ("plugin state", None, Some("[]"), None),
            (
                "plugin metadata",
                None,
                None,
                Some(r#"{"kind":"date","date_key":"2026.07.11"}"#),
            ),
        ] {
            let mut connection = v3_test_connection();
            insert_v3_node(
                &connection,
                NODE_ID,
                None,
                "ordinary root",
                "2026-07-11T00:00:00Z",
                Some(0),
                None,
                None,
            );
            insert_v3_node(
                &connection,
                CHILD_ID,
                Some(NODE_ID),
                "Zulu",
                "2026-07-11T00:00:01Z",
                is_readonly,
                plugin_state,
                plugin_meta,
            );
            insert_v3_node(
                &connection,
                THIRD_ID,
                Some(NODE_ID),
                "Alpha",
                "2026-07-11T00:00:02Z",
                Some(0),
                None,
                None,
            );
            connection
                .execute(
                    "UPDATE notes_nodes SET sort_key = 2048 WHERE id = ?1",
                    [THIRD_ID],
                )
                .expect("separate ordinary sibling sort keys");
            let expected = active_children(&connection, Some(NODE_ID));
            let changes_before = sqlite_total_changes(&connection);

            let error = sort_subtree_ascending(&mut connection, NODE_ID)
                .expect_err(&format!("{label} descendant must block sorting"));

            assert_eq!(
                error,
                "A read-only or plugin-managed Note subtree cannot be reordered."
            );
            assert_eq!(active_children(&connection, Some(NODE_ID)), expected);
            assert_eq!(sqlite_total_changes(&connection), changes_before);
        }
    }

    #[test]
    fn sorting_rejects_an_active_cycle_without_mutation() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        connection
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1 WHERE id = ?2",
                params![CHILD_ID, NODE_ID],
            )
            .expect("create sortable cycle");
        let expected = persistent_state(&connection);

        let error =
            sort_subtree_ascending(&mut connection, NODE_ID).expect_err("cyclic subtree sort");

        assert_eq!(
            error,
            "The Notes tree contains a cycle and cannot be sorted."
        );
        assert_eq!(persistent_state(&connection), expected);
    }

    #[test]
    fn collapse_all_handles_a_two_thousand_level_tree_without_rust_recursion() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        let transaction = connection.transaction().expect("deep tree transaction");
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO notes_nodes (\
                       id, parent_id, sort_key, title, created_at, updated_at\
                     ) VALUES (\
                       ?1, ?2, 1024, ?3, \
                       '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'\
                     )",
                )
                .expect("prepare deep tree insert");
            let mut parent_id = NODE_ID.to_string();
            for index in 1..=2_000 {
                let id = format!("{index:08x}-0000-4000-8000-{index:012x}");
                statement
                    .execute(params![id, parent_id, format!("level {index}")])
                    .expect("insert deep tree node");
                parent_id = id;
            }
        }
        transaction.commit().expect("commit deep tree");

        let workspace = collapse_all(&mut connection, NODE_ID).expect("collapse deep tree");

        assert_eq!(workspace.nodes.len(), 2_001);
        assert_eq!(
            workspace
                .nodes
                .iter()
                .filter(|node| node.is_collapsed)
                .count(),
            2_000
        );
        assert!(
            !workspace
                .nodes
                .iter()
                .find(|node| node.title == "level 2000")
                .expect("deep leaf")
                .is_collapsed
        );
    }

    #[test]
    fn sorting_ten_thousand_siblings_completes_with_sparse_deterministic_keys() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        let transaction = connection.transaction().expect("large sibling transaction");
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO notes_nodes (\
                       id, parent_id, sort_key, title, created_at, updated_at\
                     ) VALUES (\
                       ?1, ?2, ?3, ?4, \
                       '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'\
                     )",
                )
                .expect("prepare large sibling insert");
            for index in 0..10_000_i64 {
                let id = format!("{index:08x}-0000-4000-8000-{index:012x}");
                statement
                    .execute(params![
                        id,
                        NODE_ID,
                        index + 1,
                        format!("node {:05}", 9_999 - index)
                    ])
                    .expect("insert sortable sibling");
            }
        }
        transaction.commit().expect("commit large siblings");

        let started = Instant::now();
        let workspace =
            sort_subtree_ascending(&mut connection, NODE_ID).expect("sort large sibling group");
        let elapsed = started.elapsed();

        let children = active_children(&connection, Some(NODE_ID));
        assert_eq!(workspace.nodes.len(), 10_001);
        assert_eq!(children.len(), 10_000);
        assert_eq!(
            children.first(),
            Some(&("0000270f-0000-4000-8000-00000000270f".to_string(), 1024))
        );
        assert_eq!(
            children.last(),
            Some(&(
                "00000000-0000-4000-8000-000000000000".to_string(),
                10_240_000
            ))
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "10k sibling sort took {elapsed:?}"
        );
    }

    #[derive(Debug, PartialEq)]
    struct PersistentNodeState {
        id: String,
        parent_id: Option<String>,
        sort_key: i64,
        title: String,
        note: String,
        layout_mode: String,
        is_collapsed: i64,
        is_starred: i64,
        completed_at: Option<String>,
        created_at: String,
        updated_at: String,
        deleted_at: Option<String>,
        deleted_batch_id: Option<String>,
    }

    #[derive(Debug, PartialEq)]
    struct PersistentState {
        nodes: Vec<PersistentNodeState>,
        search: Vec<(String, String, String)>,
        tags: Vec<(String, String, String)>,
    }

    fn persistent_state(connection: &Connection) -> PersistentState {
        let nodes = connection
            .prepare(
                "SELECT id, parent_id, sort_key, title, note, layout_mode, is_collapsed, \
                        is_starred, completed_at, created_at, updated_at, deleted_at, \
                        deleted_batch_id \
                 FROM notes_nodes ORDER BY id",
            )
            .expect("prepare node state")
            .query_map([], |row| {
                Ok(PersistentNodeState {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    sort_key: row.get(2)?,
                    title: row.get(3)?,
                    note: row.get(4)?,
                    layout_mode: row.get(5)?,
                    is_collapsed: row.get(6)?,
                    is_starred: row.get(7)?,
                    completed_at: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    deleted_at: row.get(11)?,
                    deleted_batch_id: row.get(12)?,
                })
            })
            .expect("query node state")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect node state");
        let search = connection
            .prepare("SELECT node_id, title, note FROM notes_search ORDER BY node_id")
            .expect("prepare search state")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query search state")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect search state");
        let tags = connection
            .prepare(
                "SELECT node_id, tag, normalized_tag FROM notes_tags \
                 ORDER BY node_id, normalized_tag",
            )
            .expect("prepare tag state")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query tag state")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect tag state");
        PersistentState {
            nodes,
            search,
            tags,
        }
    }

    fn install_remove_terminal_failure_trigger(connection: &Connection, node_id: &str) {
        // Keeping the FTS work and failure in one trigger makes their order deterministic.
        // RAISE(FAIL) leaves earlier statement changes for the outer transaction to roll back.
        connection
            .execute_batch(&format!(
                "DROP TRIGGER notes_nodes_search_update; \
                 CREATE TRIGGER notes_nodes_search_update \
                 AFTER UPDATE OF title, note, deleted_at ON notes_nodes \
                 BEGIN \
                   DELETE FROM notes_search WHERE node_id = OLD.id; \
                   INSERT INTO notes_search (node_id, title, note) \
                   SELECT NEW.id, NEW.title, NEW.note WHERE NEW.deleted_at IS NULL; \
                   SELECT RAISE(FAIL, 'remove terminal search deletion rejected') \
                   WHERE OLD.id = '{node_id}' \
                     AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL \
                     AND NOT EXISTS (SELECT 1 FROM notes_search WHERE node_id = NEW.id); \
                 END;"
            ))
            .expect("install terminal remove failure trigger");
    }

    fn install_restore_terminal_failure_trigger(connection: &Connection, node_id: &str) {
        connection
            .execute_batch(&format!(
                "DROP TRIGGER notes_nodes_search_update; \
                 CREATE TRIGGER notes_nodes_search_update \
                 AFTER UPDATE OF title, note, deleted_at ON notes_nodes \
                 BEGIN \
                   DELETE FROM notes_search WHERE node_id = OLD.id; \
                   INSERT INTO notes_search (node_id, title, note) \
                   SELECT NEW.id, NEW.title, NEW.note WHERE NEW.deleted_at IS NULL; \
                   SELECT RAISE(FAIL, 'restore terminal search reinsertion rejected') \
                   WHERE OLD.id = '{node_id}' \
                     AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL \
                     AND 1 = (SELECT COUNT(*) FROM notes_search \
                              WHERE node_id = NEW.id \
                                AND title = NEW.title AND note = NEW.note); \
                 END;"
            ))
            .expect("install terminal restore failure trigger");
    }

    fn assert_tree_invariants(connection: &Connection) {
        let orphan_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes child \
                 LEFT JOIN notes_nodes parent ON parent.id = child.parent_id \
                 WHERE child.deleted_at IS NULL AND child.parent_id IS NOT NULL \
                   AND (parent.id IS NULL OR parent.deleted_at IS NOT NULL)",
                [],
                |row| row.get(0),
            )
            .expect("live orphan count");
        assert_eq!(orphan_count, 0, "live nodes must have live parents");

        let duplicate_sort_keys: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM (\
                   SELECT parent_id, sort_key FROM notes_nodes \
                   WHERE deleted_at IS NULL GROUP BY parent_id, sort_key HAVING COUNT(*) > 1\
                 )",
                [],
                |row| row.get(0),
            )
            .expect("duplicate sibling sort keys");
        assert_eq!(duplicate_sort_keys, 0, "live sibling keys must be unique");

        let unreachable_count: i64 = connection
            .query_row(
                "WITH RECURSIVE reachable(id) AS (\
                   SELECT id FROM notes_nodes \
                   WHERE deleted_at IS NULL AND parent_id IS NULL \
                   UNION \
                   SELECT child.id FROM notes_nodes child \
                   JOIN reachable parent ON child.parent_id = parent.id \
                   WHERE child.deleted_at IS NULL\
                 ) \
                 SELECT COUNT(*) FROM notes_nodes \
                 WHERE deleted_at IS NULL AND id NOT IN reachable",
                [],
                |row| row.get(0),
            )
            .expect("live nodes unreachable from a root");
        assert_eq!(
            unreachable_count, 0,
            "every live node must reach a root without a cycle"
        );
    }

    #[test]
    fn fresh_database_creates_only_the_current_schema() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("path");
        let connection = connect_notes_db(vault_path).expect("connect notes");

        let node_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("nodes table");
        assert_eq!(node_count, 7);
        assert_eq!(
            notes_db_path(vault_path),
            temp_dir.path().join(".yonalist/notes.sqlite")
        );
        assert!(notes_db_path(vault_path).exists());
        assert!(!temp_dir.path().join(".yonalist/index.sqlite").exists());

        for table in [
            "notes_nodes",
            "notes_tags",
            "notes_search",
            "notes_search_lifecycle",
            "notes_dates",
            "notes_attachments",
        ] {
            assert!(
                object_exists(&connection, "table", table),
                "missing table {table}"
            );
        }
        for index in [
            "notes_nodes_active_parent_order",
            "notes_nodes_archive_parent_order",
            "notes_nodes_archive_root_order",
            "notes_tags_normalized_tag",
            "notes_tags_prefix_normalized_tag",
            "notes_dates_range",
            "notes_attachments_node_order",
        ] {
            assert!(
                object_exists(&connection, "index", index),
                "missing index {index}"
            );
        }
        assert!(!table_exists(&connection, "main", "notes_history_entries"));
        assert!(!table_exists(&connection, "main", "notes_history_changes"));
        assert!(table_exists(&connection, "temp", "notes_history_entries"));
        assert!(table_exists(&connection, "temp", "notes_history_changes"));
        let temp_history_index_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM temp.sqlite_schema \
                 WHERE type = 'index' AND name = 'notes_history_session_sequence')",
                [],
                |row| row.get(0),
            )
            .expect("TEMP history index query");
        assert!(temp_history_index_exists);
        assert!(column_exists(&connection, "notes_nodes", "archived_at"));
        assert!(column_exists(&connection, "notes_nodes", "archive_root_id"));
        assert_eq!(
            table_column_metadata(&connection, "notes_nodes", "node_kind"),
            Some(("TEXT".to_string(), 1, Some("'text'".to_string())))
        );
        assert!(column_exists(&connection, "notes_tags", "prefix"));
        assert!(column_exists(&connection, "notes_dates", "start_utf16"));
        assert!(column_exists(&connection, "notes_dates", "end_utf16"));
        assert!(column_exists(
            &connection,
            "notes_history_changes",
            "ordinal"
        ));
        assert_eq!(
            primary_key_columns(&connection, "notes_history_changes"),
            vec!["entry_id", "table_name", "row_id"]
        );
        assert_eq!(
            table_columns(&connection, "notes_history_entries"),
            vec![
                "id",
                "session_id",
                "sequence",
                "is_undone",
                "estimated_bytes",
                "command_kind"
            ]
        );
        assert_eq!(
            table_column_metadata(&connection, "notes_history_entries", "command_kind"),
            Some(("TEXT".to_string(), 1, None))
        );
        assert_eq!(
            table_columns(&connection, "notes_history_changes"),
            vec![
                "entry_id",
                "table_name",
                "row_id",
                "ordinal",
                "before_json",
                "after_json"
            ]
        );
    }

    #[test]
    fn development_schema_rejection_does_not_rebuild_legacy_tag_indexes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("path");
        let mut connection = connect_notes_db(vault_path).expect("connect notes");
        create_test_node(&mut connection, NODE_ID, None, None, "Legacy #Straße", "");
        connection
            .execute(
                "UPDATE notes_tags SET normalized_tag = 'legacy' WHERE node_id = ?1",
                [NODE_ID],
            )
            .expect("simulate a legacy tag index");
        connection
            .pragma_update(None, "user_version", 2)
            .expect("mark development schema v2");
        drop(connection);

        assert_eq!(
            connect_notes_db(vault_path).expect_err("schema v2 must be rejected"),
            NOTES_DEVELOPMENT_SCHEMA_REJECTION
        );
        let connection = Connection::open(notes_db_path(vault_path)).expect("reopen raw database");
        assert_eq!(
            connection
                .query_row(
                    "SELECT normalized_tag FROM notes_tags WHERE node_id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("read untouched legacy tag"),
            "legacy"
        );
    }

    #[test]
    fn current_tag_index_version_skips_repeat_startup_rebuilds() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("path");
        let mut connection = connect_notes_db(vault_path).expect("connect notes");
        create_test_node(&mut connection, NODE_ID, None, None, "Current #tag", "");
        connection
            .execute_batch(
                "CREATE TRIGGER reject_repeat_tag_rebuild \
                 BEFORE DELETE ON notes_tags \
                 BEGIN SELECT RAISE(ABORT, 'unexpected tag rebuild'); END;",
            )
            .expect("install repeat rebuild sentinel");
        drop(connection);

        let connection = connect_notes_db(vault_path).expect("reopen current Notes storage");
        assert_eq!(
            connection
                .query_row(
                    "SELECT normalized_tag FROM notes_tags WHERE node_id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("unchanged current tag index"),
            "tag"
        );
    }

    #[test]
    fn onboarding_seeds_a_fresh_database_once() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("path");
        let mut connection = connect_notes_db(vault_path).expect("connect notes");

        let nodes: Vec<(String, Option<String>, i64, String, String)> = connection
            .prepare(
                "SELECT id, parent_id, sort_key, title, note \
                 FROM notes_nodes ORDER BY parent_id IS NOT NULL, sort_key",
            )
            .expect("prepare onboarding query")
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .expect("query onboarding")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect onboarding");

        assert_eq!(nodes.len(), 7);
        assert_eq!(nodes[0].3, "Yonalist Notes 시작하기");
        assert_eq!(
            nodes[0].4,
            "이 노트는 자유롭게 수정하거나 삭제할 수 있어요."
        );
        assert!(nodes[1..]
            .iter()
            .all(|node| node.1.as_deref() == Some(nodes[0].0.as_str())));
        assert_eq!(
            nodes[1..]
                .iter()
                .map(|node| node.3.as_str())
                .collect::<Vec<_>>(),
            vec![
                "Enter — 새 항목 만들기",
                "Tab / Shift+Tab — 들여쓰기 / 내어쓰기",
                "Shift+Enter — 설명 입력하기",
                "⌘/Ctrl+Enter — 완료 표시",
                "↑/↓ — 항목 사이 이동",
                "불릿을 드래그해 순서와 계층 바꾸기",
            ]
        );
        initialize_notes_db(&mut connection).expect("reinitialize notes");
        assert_eq!(test_node_count(&connection), 7);
    }

    #[test]
    fn onboarding_does_not_modify_an_existing_current_workspace() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("path");
        let mut connection = connect_notes_db(vault_path).expect("connect notes");
        remove_onboarding_for_test(&connection);
        insert_node(&connection, NODE_ID, None, SORT_KEY_STEP, "Existing note");

        initialize_notes_db(&mut connection).expect("reinitialize notes");

        assert_eq!(test_node_count(&connection), 1);
        assert_eq!(
            connection
                .query_row("SELECT title FROM notes_nodes", [], |row| {
                    row.get::<_, String>(0)
                })
                .expect("existing title"),
            "Existing note"
        );
    }

    #[test]
    fn onboarding_does_not_return_after_its_nodes_are_deleted() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("path");
        let mut connection = connect_notes_db(vault_path).expect("connect notes");
        connection
            .execute("DELETE FROM notes_nodes", [])
            .expect("delete onboarding nodes");

        initialize_notes_db(&mut connection).expect("reinitialize notes");

        assert_eq!(test_node_count(&connection), 0);
    }

    #[test]
    fn onboarding_schema_and_nodes_roll_back_together() {
        let mut connection = Connection::open_in_memory().expect("in-memory notes database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable foreign keys");
        crate::notes::schema::install_notes_sql_functions(&connection)
            .expect("install Notes SQL functions");
        let transaction = connection.transaction().expect("begin schema transaction");
        assert!(
            crate::notes::schema::create_if_missing(&transaction).expect("create current schema")
        );
        transaction
            .execute_batch(
                "CREATE TRIGGER reject_onboarding_child \
                 BEFORE INSERT ON notes_nodes \
                 WHEN NEW.parent_id IS NOT NULL \
                 BEGIN SELECT RAISE(ABORT, 'reject onboarding child'); END;",
            )
            .expect("create rejecting trigger");

        let error = seed_notes_onboarding(&transaction).expect_err("seed must fail");

        assert!(error.contains("Could not create Notes onboarding guidance"));
        drop(transaction);
        assert!(!object_exists(&connection, "table", "notes_nodes"));
    }

    #[test]
    fn notes_connection_is_configured_for_the_current_schema() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect notes");

        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign keys");
        let busy_timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy timeout");
        assert_eq!(journal_mode, "wal");
        assert_eq!(foreign_keys, 1);
        assert_eq!(busy_timeout, 5_000);
        assert!(column_exists(
            &connection,
            "notes_nodes",
            "deleted_batch_id"
        ));
        assert!(column_exists(&connection, "notes_nodes", "archived_at"));
        assert!(column_exists(&connection, "notes_nodes", "archive_root_id"));
        assert!(column_exists(&connection, "notes_nodes", "node_kind"));
    }

    #[test]
    fn concurrent_current_schema_open_waits_for_initialization_locks() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_string_lossy().into_owned();
        let path = notes_db_path(&vault_path);
        drop(connect_notes_db(&vault_path).expect("initialize current schema"));
        let blocker = Connection::open(&path).expect("open initialization blocker");
        blocker
            .execute_batch("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE")
            .expect("hold first initialization lock");

        let (busy_sender, busy_receiver) = mpsc::channel();
        let workers = (0..2)
            .map(|worker_id| {
                let vault_path = vault_path.clone();
                let busy_sender = busy_sender.clone();
                thread::spawn(move || {
                    observe_next_initialization_busy(busy_sender, worker_id);
                    connect_notes_db(&vault_path)
                })
            })
            .collect::<Vec<_>>();
        drop(busy_sender);

        let mut workers_at_lock = vec![
            busy_receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("first initializer reached held initialization lock"),
            busy_receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("second initializer reached held initialization lock"),
        ];
        workers_at_lock.sort_unstable();
        assert_eq!(workers_at_lock, vec![0, 1]);
        blocker
            .execute_batch("COMMIT")
            .expect("release initialization lock");

        for worker in workers {
            worker
                .join()
                .expect("initialization worker")
                .expect("concurrent first initialization");
        }

        let connection = Connection::open(&path).expect("reopen initialized database");
        assert!(column_exists(
            &connection,
            "notes_nodes",
            "deleted_batch_id"
        ));
        for (object_type, name) in [
            ("table", "notes_nodes"),
            ("table", "notes_tags"),
            ("table", "notes_search"),
            ("table", "notes_search_lifecycle"),
            ("index", "notes_nodes_active_parent_order"),
            ("index", "notes_nodes_deleted_batch"),
            ("index", "notes_tags_normalized_tag"),
            ("trigger", "notes_nodes_search_insert"),
            ("trigger", "notes_nodes_search_update"),
            ("trigger", "notes_nodes_search_delete"),
            ("trigger", "notes_nodes_lifecycle_search_insert"),
            ("trigger", "notes_nodes_lifecycle_search_update"),
            ("trigger", "notes_nodes_lifecycle_search_delete"),
        ] {
            assert!(
                object_exists(&connection, object_type, name),
                "missing {object_type} {name}"
            );
        }
        let foreign_key_errors: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("foreign key check");
        assert_eq!(foreign_key_errors, 0);
    }

    #[test]
    fn notes_connection_leaves_short_and_corrupt_headers_to_sqlite_diagnostics() {
        for (label, bytes) in [("short", vec![0_u8; 8]), ("corrupt", vec![b'x'; 64])] {
            let temp_dir = tempfile::tempdir().expect("temp dir");
            let path = notes_db_path(temp_dir.path().to_str().expect("path"));
            std::fs::create_dir_all(path.parent().expect("metadata dir")).expect("metadata dir");
            std::fs::write(&path, bytes).expect("write malformed database");

            let error = connect_notes_db(temp_dir.path().to_str().expect("path"))
                .expect_err("SQLite must reject malformed database headers");

            assert!(error.contains("file is not a database"), "{label}: {error}");
        }
    }

    #[test]
    fn notes_search_tracks_active_node_content() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let connection =
            connect_notes_db(temp_dir.path().to_str().expect("path")).expect("connect notes");

        connection
            .execute(
                "INSERT INTO notes_nodes (id, sort_key, title, note, created_at, updated_at) \
                 VALUES (?1, 1024, 'Alpha', 'First note', '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z')",
                [NODE_ID],
            )
            .expect("insert node");
        let indexed_title: String = connection
            .query_row(
                "SELECT title FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("indexed node");
        assert_eq!(indexed_title, "Alpha");

        connection
            .execute(
                "UPDATE notes_nodes SET title = 'Beta', deleted_at = '2026-07-10T01:00:00Z' WHERE id = ?1",
                [NODE_ID],
            )
            .expect("soft delete node");
        let deleted_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("deleted search count");
        assert_eq!(deleted_count, 0);

        connection
            .execute(
                "UPDATE notes_nodes SET deleted_at = NULL WHERE id = ?1",
                [NODE_ID],
            )
            .expect("restore node");
        let restored_title: String = connection
            .query_row(
                "SELECT title FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("restored search node");
        assert_eq!(restored_title, "Beta");

        connection
            .execute("DELETE FROM notes_nodes WHERE id = ?1", [NODE_ID])
            .expect("delete node");
        let removed_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("removed search count");
        assert_eq!(removed_count, 0);
    }

    #[test]
    fn create_appends_or_inserts_after_a_sibling_and_rebalances_exhausted_gaps() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "first");
        insert_node(&connection, CHILD_ID, None, 1025, "second");

        create_node(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                title: "between".to_string(),
                note: String::new(),
            },
        )
        .expect("insert between roots");
        create_node(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: FOURTH_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "last".to_string(),
                note: String::new(),
            },
        )
        .expect("append root");

        assert_eq!(
            active_children(&connection, None),
            vec![
                (NODE_ID.to_string(), 1024),
                (THIRD_ID.to_string(), 1536),
                (CHILD_ID.to_string(), 2048),
                (FOURTH_ID.to_string(), 3072),
            ]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn create_before_places_the_new_node_first_without_changing_append_semantics() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "first");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 2048, "second");

        create_node_before_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: FOURTH_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                title: "new first".to_string(),
                note: String::new(),
            },
            CHILD_ID,
            fixed_today(),
        )
        .expect("create before first child");

        assert_eq!(
            active_children(&connection, Some(NODE_ID))
                .into_iter()
                .map(|(id, _)| id)
                .collect::<Vec<_>>(),
            vec![
                FOURTH_ID.to_string(),
                CHILD_ID.to_string(),
                THIRD_ID.to_string(),
            ]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn invalid_create_input_does_not_mutate_the_tree() {
        let mut connection = test_connection();
        let error = create_node(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: "not-a-uuid".to_string(),
                parent_id: None,
                after_id: None,
                title: "invalid".to_string(),
                note: String::new(),
            },
        )
        .expect_err("invalid ID");

        assert!(error.contains("UUID v4"));
        assert!(load_workspace(&connection, NotesWorkspaceScope::Active)
            .expect("active workspace")
            .nodes
            .is_empty());
    }

    #[test]
    fn projection_failure_rolls_back_the_mutation_that_produced_it() {
        let mut connection = test_connection();
        connection
            .execute_batch(
                "CREATE TRIGGER corrupt_created_node_projection \
                 AFTER INSERT ON notes_nodes \
                 BEGIN \
                   UPDATE notes_nodes SET layout_mode = 'invalid' WHERE id = NEW.id; \
                 END;",
            )
            .expect("projection failure trigger");

        let error = create_node(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "must roll back".to_string(),
                note: String::new(),
            },
        )
        .expect_err("invalid workspace projection");

        assert!(error.contains("Unsupported Notes layout mode: invalid"));
        let node_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("node count after projection failure");
        assert_eq!(node_count, 0);
        let search_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_search", [], |row| row.get(0))
            .expect("search count after projection failure");
        assert_eq!(search_count, 0);
    }

    #[test]
    fn move_places_a_node_before_the_first_root_without_sort_key_overflow() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, i64::MIN, "first root");
        insert_node(&connection, CHILD_ID, None, i64::MIN + 1, "second root");
        insert_node(&connection, THIRD_ID, None, 0, "moving root");

        let workspace = move_node(
            &mut connection,
            MoveNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: None,
                before_id: Some(NODE_ID.to_string()),
            },
        )
        .expect("move before first root");

        assert_eq!(
            active_children(&connection, None),
            vec![
                (THIRD_ID.to_string(), 0),
                (NODE_ID.to_string(), 1024),
                (CHILD_ID.to_string(), 2048),
            ]
        );
        assert_eq!(workspace.nodes[0].id, THIRD_ID);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_places_a_node_before_the_first_child_without_rebalancing() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "first child");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 2048, "second child");

        let workspace = move_node(
            &mut connection,
            MoveNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                before_id: Some(CHILD_ID.to_string()),
            },
        )
        .expect("move before first child");

        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![(THIRD_ID.to_string(), 0), (CHILD_ID.to_string(), 1024)]
        );
        assert_eq!(
            workspace
                .nodes
                .iter()
                .find(|node| node.id == THIRD_ID)
                .expect("moved child")
                .parent_id
                .as_deref(),
            Some(NODE_ID)
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_places_a_node_before_a_middle_sibling() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "first");
        insert_node(&connection, CHILD_ID, None, 2048, "middle");
        insert_node(&connection, THIRD_ID, None, 3072, "moving");

        move_node(
            &mut connection,
            MoveNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: None,
                before_id: Some(CHILD_ID.to_string()),
            },
        )
        .expect("move before middle root");

        assert_eq!(
            active_children(&connection, None),
            vec![
                (NODE_ID.to_string(), 1024),
                (THIRD_ID.to_string(), 1536),
                (CHILD_ID.to_string(), 2048),
            ]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_rejects_cross_parent_and_deleted_before_anchors_without_mutation() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "target parent");
        insert_node(&connection, CHILD_ID, None, 2048, "other parent");
        insert_node(&connection, THIRD_ID, None, 3072, "moving root");
        insert_node(
            &connection,
            FOURTH_ID,
            Some(CHILD_ID),
            1024,
            "cross-parent anchor",
        );
        insert_node(&connection, FIFTH_ID, Some(NODE_ID), 1024, "deleted anchor");
        soft_delete_node(&mut connection, FIFTH_ID).expect("delete anchor");

        for anchor_id in [FOURTH_ID, FIFTH_ID] {
            let before = persistent_state(&connection);
            let error = move_node(
                &mut connection,
                MoveNodeInput {
                    id: THIRD_ID.to_string(),
                    parent_id: Some(NODE_ID.to_string()),
                    after_id: None,
                    before_id: Some(anchor_id.to_string()),
                },
            )
            .expect_err("invalid before anchor");

            assert!(error.contains("beforeId must identify a live sibling under the target parent"));
            assert_eq!(persistent_state(&connection), before);
            assert_tree_invariants(&connection);
        }
    }

    #[test]
    fn move_rejects_a_descendant_as_the_new_parent() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "grandchild");
        insert_node(
            &connection,
            FOURTH_ID,
            Some(THIRD_ID),
            1024,
            "great-grandchild",
        );
        insert_node(&connection, FIFTH_ID, None, 2048, "following root");
        let before = persistent_state(&connection);

        let error = move_node(
            &mut connection,
            MoveNodeInput {
                id: NODE_ID.to_string(),
                parent_id: Some(FOURTH_ID.to_string()),
                after_id: None,
                before_id: None,
            },
        )
        .expect_err("cycle");

        assert!(error.contains("descendant"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_rejects_the_node_itself_as_the_new_parent() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");

        let error = move_node(
            &mut connection,
            MoveNodeInput {
                id: NODE_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                before_id: None,
            },
        )
        .expect_err("self-parent cycle");

        assert!(error.contains("itself"));
        assert_eq!(active_children(&connection, None).len(), 1);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn move_can_reorder_siblings_and_promote_a_node_to_a_root() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root one");
        insert_node(&connection, CHILD_ID, None, 2048, "root two");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 1024, "child");

        move_node(
            &mut connection,
            MoveNodeInput {
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                before_id: None,
            },
        )
        .expect("promote child");
        move_node(
            &mut connection,
            MoveNodeInput {
                id: CHILD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                before_id: None,
            },
        )
        .expect("reorder root");

        let roots = active_children(&connection, None);
        assert_eq!(
            roots.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID, THIRD_ID]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn split_is_atomic_and_places_the_suffix_immediately_after_the_source() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "original");
        insert_node(&connection, CHILD_ID, None, 2048, "following");

        let workspace = split_node(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: THIRD_ID.to_string(),
                prefix: "alpha".to_string(),
                suffix: "beta".to_string(),
            },
        )
        .expect("split");

        assert!(workspace.nodes.iter().any(|node| node.id == THIRD_ID));
        let roots = active_children(&connection, None);
        assert_eq!(
            roots.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec![NODE_ID, THIRD_ID, CHILD_ID]
        );
        let source_title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("source title");
        assert_eq!(source_title, "alpha");

        connection
            .execute_batch(&format!(
                "CREATE TRIGGER reject_split_insert BEFORE INSERT ON notes_nodes \
                 WHEN NEW.id = '{FOURTH_ID}' BEGIN SELECT RAISE(ABORT, 'split rejected'); END;"
            ))
            .expect("rejecting trigger");
        let error = split_node(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: FOURTH_ID.to_string(),
                prefix: "changed".to_string(),
                suffix: "rejected".to_string(),
            },
        )
        .expect_err("split must roll back");
        assert!(error.contains("split rejected"));
        let rolled_back_title: String = connection
            .query_row(
                "SELECT title FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("rolled back title");
        assert_eq!(rolled_back_title, "alpha");
    }

    #[test]
    fn remove_empty_node_reparents_children_at_the_removed_position() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "before");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 2048, " \t ");
        insert_node(&connection, FOURTH_ID, Some(THIRD_ID), 1024, "child one");
        insert_node(&connection, FIFTH_ID, Some(THIRD_ID), 2048, "child two");
        insert_node(&connection, SIXTH_ID, Some(NODE_ID), 3072, "after");

        remove_empty_node(&mut connection, THIRD_ID).expect("remove empty node");

        let children = active_children(&connection, Some(NODE_ID));
        assert_eq!(
            children
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec![CHILD_ID, FOURTH_ID, FIFTH_ID, SIXTH_ID]
        );
        let (removed_deleted_at, removed_batch_id): (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT deleted_at, deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [THIRD_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("removed node");
        assert!(removed_deleted_at.is_some());
        assert!(removed_batch_id.is_some());
        assert_tree_invariants(&connection);
    }

    #[test]
    fn remove_empty_node_rejects_a_non_whitespace_title_without_mutation() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            " keep #Title ",
            " \n ",
        );
        let before = persistent_state(&connection);

        let error = remove_empty_node(&mut connection, NODE_ID).expect_err("non-empty title");

        assert!(error.contains("empty"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn remove_empty_node_rejects_a_non_whitespace_note_without_mutation() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            " \t ",
            " keep #Supporting-Note ",
        );
        let before = persistent_state(&connection);

        let error = remove_empty_node(&mut connection, NODE_ID).expect_err("non-empty note");

        assert!(error.contains("empty"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn split_then_remove_empty_node_preserves_children_and_root_order() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "original");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        insert_node(&connection, THIRD_ID, None, 2048, "following root");

        let workspace = split_node(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: FOURTH_ID.to_string(),
                prefix: "alpha".to_string(),
                suffix: " \t ".to_string(),
            },
        )
        .expect("split before removing empty suffix");
        assert!(workspace.nodes.iter().any(|node| node.id == FOURTH_ID));
        assert_eq!(
            active_children(&connection, None),
            vec![
                (NODE_ID.to_string(), 1024),
                (FOURTH_ID.to_string(), 1536),
                (THIRD_ID.to_string(), 2048),
            ]
        );

        remove_empty_node(&mut connection, FOURTH_ID).expect("remove empty split node");

        assert_eq!(
            active_children(&connection, None),
            vec![(NODE_ID.to_string(), 1024), (THIRD_ID.to_string(), 2048)]
        );
        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![(CHILD_ID.to_string(), 1024)]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn remove_empty_leaf_soft_deletes_only_that_leaf() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "before");
        insert_node(&connection, THIRD_ID, Some(NODE_ID), 2048, " \n\t ");
        insert_node(&connection, FOURTH_ID, Some(NODE_ID), 3072, "after");

        remove_empty_node(&mut connection, THIRD_ID).expect("remove empty leaf");

        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![(CHILD_ID.to_string(), 1024), (FOURTH_ID.to_string(), 3072)]
        );
        let deleted_at: Option<String> = connection
            .query_row(
                "SELECT deleted_at FROM notes_nodes WHERE id = ?1",
                [THIRD_ID],
                |row| row.get(0),
            )
            .expect("removed leaf");
        assert!(deleted_at.is_some());
        assert_tree_invariants(&connection);
    }

    #[test]
    fn duplicate_node_deep_copies_with_fresh_ids_after_the_source_root() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "grandchild");
        insert_node(&connection, FOURTH_ID, None, 2048, "following root");

        let workspace = duplicate_node(&mut connection, NODE_ID).expect("duplicate subtree");
        let copied_root = workspace
            .nodes
            .iter()
            .find(|node| node.parent_id.is_none() && node.id != NODE_ID && node.id != FOURTH_ID)
            .expect("copied root in returned workspace")
            .id
            .clone();

        assert_ne!(copied_root, NODE_ID);
        validate_note_id(&copied_root).expect("copied root UUID");
        let roots = active_children(&connection, None);
        assert_eq!(roots[0].0, NODE_ID);
        assert_eq!(roots[1].0, copied_root);
        assert_eq!(roots[2].0, FOURTH_ID);

        let copied_children = active_children(&connection, Some(&copied_root));
        assert_eq!(copied_children.len(), 1);
        assert_ne!(copied_children[0].0, CHILD_ID);
        validate_note_id(&copied_children[0].0).expect("copied child UUID");
        let copied_grandchildren = active_children(&connection, Some(&copied_children[0].0));
        assert_eq!(copied_grandchildren.len(), 1);
        assert_ne!(copied_grandchildren[0].0, THIRD_ID);
        validate_note_id(&copied_grandchildren[0].0).expect("copied grandchild UUID");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active workspace")
                .nodes
                .len(),
            7
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn duplicate_node_copies_attachment_metadata_onto_the_copy() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "child");
        let first_id = insert_test_attachment(&connection, 1, NODE_ID);
        let second_id = insert_test_attachment(&connection, 2, NODE_ID);

        let source_before = node_attachments(&connection, NODE_ID).expect("source attachments");
        assert_eq!(
            source_before
                .iter()
                .map(|attachment| attachment.id.clone())
                .collect::<Vec<_>>(),
            vec![first_id.clone(), second_id.clone()]
        );
        let total_before: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments before");
        assert_eq!(total_before, 2);

        let workspace = duplicate_node(&mut connection, NODE_ID).expect("duplicate subtree");
        let copied_root = workspace
            .nodes
            .iter()
            .find(|node| node.parent_id.is_none() && node.id != NODE_ID)
            .expect("copied root in returned workspace")
            .id
            .clone();
        assert_ne!(copied_root, NODE_ID);

        // Both attachments land on the copy, in source order, with fresh ids but
        // the same content-addressed file (relative_path / content_hash) and
        // every other field preserved.
        let copied = node_attachments(&connection, &copied_root).expect("copied attachments");
        assert_eq!(copied.len(), 2);
        for (source, copy) in source_before.iter().zip(&copied) {
            assert_ne!(copy.id, first_id, "a copy must not reuse a source id");
            assert_ne!(copy.id, second_id, "a copy must not reuse a source id");
            assert_ne!(copy.id, source.id, "each copy gets a fresh attachment id");
            validate_note_id(&copy.id).expect("copied attachment UUID");
            assert_eq!(copy.node_id, copied_root);
            assert_eq!(copy.relative_path, source.relative_path);
            assert_eq!(copy.content_hash, source.content_hash);
            assert_eq!(copy.original_name, source.original_name);
            assert_eq!(copy.mime_type, source.mime_type);
            assert_eq!(copy.byte_size, source.byte_size);
            assert_eq!(copy.intrinsic_width, source.intrinsic_width);
            assert_eq!(copy.intrinsic_height, source.intrinsic_height);
            assert_eq!(copy.display_width, source.display_width);
            assert_eq!(copy.sort_key, source.sort_key);
        }

        // The originals are untouched and the only new rows are the two copies:
        // because the copies share the source's content-addressed paths, no new
        // asset files exist on disk (the reconcile contract reference-counts the
        // shared path across both nodes).
        assert_eq!(
            node_attachments(&connection, NODE_ID).expect("source attachments after"),
            source_before
        );
        let total_after: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("count attachments after");
        assert_eq!(total_after, 4);
        let distinct_paths: i64 = connection
            .query_row(
                "SELECT COUNT(DISTINCT relative_path) FROM notes_attachments",
                [],
                |row| row.get(0),
            )
            .expect("count distinct paths");
        assert_eq!(
            distinct_paths, 2,
            "duplication must not introduce new asset files"
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn selection_root_normalization_does_not_query_each_selected_ancestor_path() {
        const DEPTH: usize = 8;
        const WIDTH: usize = ANCESTOR_CLOSURE_CHUNK_SIZE * 2 + 1;

        let mut connection = test_connection();
        let mut parent_id: Option<String> = None;
        for index in 0..DEPTH {
            let node_id = format!("10000000-0000-4000-8000-{index:012x}");
            insert_node(
                &connection,
                &node_id,
                parent_id.as_deref(),
                SORT_KEY_STEP,
                "ancestor",
            );
            parent_id = Some(node_id);
        }
        let deepest_parent_id = parent_id.expect("deepest ancestor");
        let selected_ids = (0..WIDTH)
            .map(|index| {
                let node_id = format!("20000000-0000-4000-8000-{index:012x}");
                insert_node(
                    &connection,
                    &node_id,
                    Some(&deepest_parent_id),
                    i64::try_from(index + 1).expect("sibling index") * SORT_KEY_STEP,
                    "selected sibling",
                );
                node_id
            })
            .collect::<Vec<_>>();
        let selected = selected_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        let transaction = connection.transaction().expect("selection transaction");

        reset_node_by_id_lookup_count();
        reset_ancestor_closure_query_count();
        let roots = selection_roots(&transaction, &selected_ids, &selected)
            .expect("normalize wide deep selection");
        let lookup_count = node_by_id_lookup_count();
        let closure_query_count = ancestor_closure_query_count();

        assert_eq!(roots, selected_ids);
        assert_eq!(
            closure_query_count, 3,
            "selection normalization used {closure_query_count} ancestor-closure queries"
        );
        assert_eq!(
            lookup_count, 0,
            "selection normalization performed {lookup_count} per-node ancestor lookups"
        );
    }

    #[test]
    fn batch_duplicate_normalizes_descendants_and_copies_ordered_forest_state() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "parent", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "A #Alpha 2026-07-20",
            "A note #Details",
        );
        create_test_node(
            &mut connection,
            FIFTH_ID,
            Some(CHILD_ID),
            None,
            "A child #Nested",
            "child note",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(NODE_ID),
            Some(CHILD_ID),
            "B #Beta",
            "B note",
        );
        create_test_node(
            &mut connection,
            FOURTH_ID,
            Some(NODE_ID),
            Some(THIRD_ID),
            "C",
            "",
        );
        connection
            .execute(
                "UPDATE notes_nodes SET is_collapsed = 1, is_starred = 1, \
                   completed_at = '2026-07-10T01:00:00.000Z' WHERE id = ?1",
                [CHILD_ID],
            )
            .expect("set source state");
        insert_test_attachment(&connection, 900, CHILD_ID);
        insert_test_attachment(&connection, 901, THIRD_ID);

        // Submission order is deliberately reversed, and A's selected child is
        // deliberately redundant. Normalization must produce roots A then B in
        // stored sibling order, not caller order.
        let workspace = apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![
                    THIRD_ID.to_string(),
                    FIFTH_ID.to_string(),
                    CHILD_ID.to_string(),
                ],
                op: BatchOp::Duplicate,
            },
        )
        .expect("batch duplicate");

        let children = active_children(&connection, Some(NODE_ID));
        assert_eq!(children.len(), 5);
        let copied_a = children[2].0.clone();
        let copied_b = children[3].0.clone();
        assert_eq!(
            children
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec![CHILD_ID, THIRD_ID, &copied_a, &copied_b, FOURTH_ID]
        );
        for copied_id in [&copied_a, &copied_b] {
            validate_note_id(copied_id).expect("fresh copied root id");
            assert!(workspace.nodes.iter().any(|node| &node.id == copied_id));
        }

        let copied_a_state: (String, String, String, i64, i64, Option<String>) = connection
            .query_row(
                "SELECT title, note, layout_mode, is_collapsed, is_starred, completed_at \
                 FROM notes_nodes WHERE id = ?1",
                [&copied_a],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .expect("copied A state");
        assert_eq!(
            copied_a_state,
            (
                "A #Alpha 2026-07-20".to_string(),
                "A note #Details".to_string(),
                "bullets".to_string(),
                1,
                1,
                Some("2026-07-10T01:00:00.000Z".to_string()),
            )
        );
        let copied_a_children = active_children(&connection, Some(&copied_a));
        assert_eq!(copied_a_children.len(), 1);
        assert_ne!(copied_a_children[0].0, FIFTH_ID);
        assert_eq!(
            node_shape(&connection, &copied_a_children[0].0).2,
            "A child #Nested"
        );

        let copied_search: (String, String) = connection
            .query_row(
                "SELECT title, note FROM notes_search WHERE node_id = ?1",
                [&copied_a],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("copied search row");
        assert_eq!(
            copied_search,
            (
                "A #Alpha 2026-07-20".to_string(),
                "A note #Details".to_string()
            )
        );
        let copied_tags = connection
            .prepare(
                "SELECT normalized_tag FROM notes_tags WHERE node_id = ?1 \
                 ORDER BY normalized_tag",
            )
            .expect("prepare copied tags")
            .query_map([&copied_a], |row| row.get::<_, String>(0))
            .expect("query copied tags")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect copied tags");
        assert_eq!(
            copied_tags,
            vec!["alpha".to_string(), "details".to_string()]
        );
        assert_eq!(
            date_rows(&connection, &copied_a),
            date_rows(&connection, CHILD_ID)
        );

        for (source_id, copied_id) in [(CHILD_ID, &copied_a), (THIRD_ID, &copied_b)] {
            let source = node_attachments(&connection, source_id).expect("source attachment");
            let copied = node_attachments(&connection, copied_id).expect("copied attachment");
            assert_eq!(source.len(), 1);
            assert_eq!(copied.len(), 1);
            assert_ne!(copied[0].id, source[0].id);
            validate_note_id(&copied[0].id).expect("fresh copied attachment id");
            assert_eq!(copied[0].relative_path, source[0].relative_path);
            assert_eq!(copied[0].content_hash, source[0].content_hash);
        }
        let distinct_paths: i64 = connection
            .query_row(
                "SELECT COUNT(DISTINCT relative_path) FROM notes_attachments",
                [],
                |row| row.get(0),
            )
            .expect("distinct attachment paths");
        assert_eq!(distinct_paths, 2, "duplication must not copy asset bytes");
        assert_tree_invariants(&connection);
    }

    #[test]
    fn batch_duplicate_accepts_nonconsecutive_same_parent_roots() {
        let mut connection = test_connection();
        for (id, sort_key, title) in [
            (NODE_ID, 1024, "A"),
            (CHILD_ID, 2048, "B"),
            (THIRD_ID, 3072, "C"),
            (FOURTH_ID, 4096, "D"),
        ] {
            insert_node(&connection, id, None, sort_key, title);
        }

        apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![THIRD_ID.to_string(), NODE_ID.to_string()],
                op: BatchOp::Duplicate,
            },
        )
        .expect("nonconsecutive same-parent duplicate");

        let roots = active_children(&connection, None);
        assert_eq!(roots.len(), 6);
        assert_eq!(
            roots
                .iter()
                .map(|(id, _)| node_shape(&connection, id).2)
                .collect::<Vec<_>>(),
            vec!["A", "B", "C", "A", "C", "D"]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn batch_duplicate_rebalances_an_exhausted_placement_gap() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "A");
        insert_node(&connection, CHILD_ID, None, 1025, "B");
        insert_node(&connection, THIRD_ID, None, 1026, "C");

        apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                op: BatchOp::Duplicate,
            },
        )
        .expect("duplicate across an exhausted sort-key gap");

        assert_eq!(
            active_children(&connection, None)
                .iter()
                .map(|(id, _)| node_shape(&connection, id).2)
                .collect::<Vec<_>>(),
            vec!["A", "B", "A", "B", "C"]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn batch_duplicate_rebuilds_relative_dates_from_the_injected_local_day() {
        let mut connection = test_connection();
        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "today".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create relative-date source");
        assert_eq!(date_rows(&connection, NODE_ID)[0].3, "2026-07-11");
        let duplicate_today = LocalDate::new(2026, 8, 20).expect("duplicate local day");

        let (_, duplicated_root_ids) = apply_batch_at(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string()],
                op: BatchOp::Duplicate,
            },
            duplicate_today,
        )
        .expect("dated batch duplicate");
        let copied_root = duplicated_root_ids
            .expect("duplicate root result")
            .into_iter()
            .next()
            .expect("one copied root");

        assert_eq!(date_rows(&connection, &copied_root)[0].3, "2026-08-20");
        assert_eq!(date_rows(&connection, NODE_ID)[0].3, "2026-07-11");
    }

    #[test]
    fn batch_duplicate_rejects_mixed_parent_deleted_archived_and_missing_roots() {
        let mut mixed = test_connection();
        insert_node(&mixed, NODE_ID, None, 1024, "parent");
        insert_node(&mixed, CHILD_ID, Some(NODE_ID), 1024, "child");
        insert_node(&mixed, THIRD_ID, None, 2048, "other root");
        let before = persistent_state(&mixed);
        let error = apply_batch(
            &mut mixed,
            ApplyBatchInput {
                node_ids: vec![CHILD_ID.to_string(), THIRD_ID.to_string()],
                op: BatchOp::Duplicate,
            },
        )
        .expect_err("mixed parents");
        assert!(error.contains("same parent"), "unexpected error: {error}");
        assert_eq!(persistent_state(&mixed), before);

        let mut deleted = test_connection();
        insert_node(&deleted, NODE_ID, None, 1024, "deleted");
        soft_delete_node(&mut deleted, NODE_ID).expect("delete source");
        let before = persistent_state(&deleted);
        let error = apply_batch(
            &mut deleted,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string()],
                op: BatchOp::Duplicate,
            },
        )
        .expect_err("deleted source");
        assert!(error.contains("trash"), "unexpected error: {error}");
        assert_eq!(persistent_state(&deleted), before);

        let mut archived = test_connection();
        insert_node(&archived, NODE_ID, None, 1024, "archived");
        archive_node(&mut archived, NODE_ID).expect("archive source");
        let before = persistent_state(&archived);
        let error = apply_batch(
            &mut archived,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string()],
                op: BatchOp::Duplicate,
            },
        )
        .expect_err("archived source");
        assert!(error.contains("archived"), "unexpected error: {error}");
        assert_eq!(persistent_state(&archived), before);

        let mut missing = test_connection();
        let before = persistent_state(&missing);
        let error = apply_batch(
            &mut missing,
            ApplyBatchInput {
                node_ids: vec![EIGHTH_ID.to_string()],
                op: BatchOp::Duplicate,
            },
        )
        .expect_err("cross-vault source");
        assert!(
            error.contains("does not exist"),
            "unexpected error: {error}"
        );
        assert_eq!(persistent_state(&missing), before);
    }

    #[test]
    fn batch_duplicate_rejects_a_cycle_through_the_selected_root_without_writes() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "cycle root");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "cycle child");
        connection
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1 WHERE id = ?2",
                params![CHILD_ID, NODE_ID],
            )
            .expect("corrupt source into a cycle");
        let before = persistent_state(&connection);

        let error = apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string()],
                op: BatchOp::Duplicate,
            },
        )
        .expect_err("cyclic source must be rejected");

        assert!(error.contains("cycle"), "unexpected error: {error}");
        assert_eq!(persistent_state(&connection), before);
    }

    #[test]
    fn batch_duplicate_rejects_an_ancestor_cycle_above_the_selected_root_without_writes() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "cycle ancestor A");
        insert_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            1024,
            "cycle ancestor B",
        );
        insert_node(
            &connection,
            THIRD_ID,
            Some(NODE_ID),
            2048,
            "selected descendant",
        );
        connection
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1 WHERE id = ?2",
                params![CHILD_ID, NODE_ID],
            )
            .expect("corrupt ancestors into a cycle");
        let before = persistent_state(&connection);

        let error = apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![THIRD_ID.to_string()],
                op: BatchOp::Duplicate,
            },
        )
        .expect_err("an ancestor cycle must be rejected");

        assert!(error.contains("cycle"), "unexpected error: {error}");
        assert_eq!(persistent_state(&connection), before);
    }

    #[test]
    fn batch_duplicate_rejects_selected_ancestor_cycle_without_copying_a_healthy_root() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "healthy selected root");
        insert_node(&connection, CHILD_ID, None, 2048, "selected cycle A");
        insert_node(
            &connection,
            THIRD_ID,
            Some(CHILD_ID),
            1024,
            "selected cycle B",
        );
        connection
            .execute(
                "UPDATE notes_nodes SET parent_id = ?1 WHERE id = ?2",
                params![THIRD_ID, CHILD_ID],
            )
            .expect("corrupt selected ancestors into a cycle");
        let before = persistent_state(&connection);

        let error = apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![
                    NODE_ID.to_string(),
                    CHILD_ID.to_string(),
                    THIRD_ID.to_string(),
                ],
                op: BatchOp::Duplicate,
            },
        )
        .expect_err("a selected ancestor cycle must reject the whole duplicate");

        assert!(error.contains("cycle"), "unexpected error: {error}");
        assert_eq!(persistent_state(&connection), before);
    }

    #[test]
    fn batch_duplicate_rolls_back_an_earlier_root_after_later_index_failure() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "A #Safe", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            None,
            Some(NODE_ID),
            "B #Reject",
            "",
        );
        let before = persistent_state(&connection);
        connection
            .execute_batch(
                "CREATE TRIGGER reject_later_duplicate_tag BEFORE INSERT ON notes_tags \
                 WHEN NEW.normalized_tag = 'reject' \
                 BEGIN SELECT RAISE(ABORT, 'later duplicate index rejected'); END;",
            )
            .expect("later-root index failure trigger");

        let error = apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                op: BatchOp::Duplicate,
            },
        )
        .expect_err("later copied root must roll back the forest");

        assert!(
            error.contains("later duplicate index rejected"),
            "unexpected error: {error}"
        );
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn batch_tag_add_updates_each_explicit_node_once_and_rebuilds_derived_content() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "Parent today",
            "parent note",
        );
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "Child",
            "child note",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(CHILD_ID),
            None,
            "Unselected #Roadmap",
            "nested note",
        );
        connection
            .execute(
                "UPDATE notes_dates SET normalized_start = '2099-01-01', \
                   normalized_end = '2099-01-01' WHERE node_id = ?1",
                [NODE_ID],
            )
            .expect("corrupt selected date projection");
        connection
            .execute_batch(
                "CREATE TEMP TABLE batch_tag_update_count(node_id TEXT NOT NULL); \
                 CREATE TEMP TRIGGER count_batch_tag_content_updates \
                 AFTER UPDATE OF title, note ON notes_nodes \
                 BEGIN INSERT INTO batch_tag_update_count(node_id) VALUES (NEW.id); END;",
            )
            .expect("install batch tag update counter");

        apply_batch_at(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![
                    NODE_ID.to_string(),
                    CHILD_ID.to_string(),
                    NODE_ID.to_string(),
                ],
                op: BatchOp::AddTag {
                    tag: NoteSearchTag {
                        prefix: NoteTagPrefix::Hash,
                        normalized_tag: "roadmap".to_string(),
                        display_tag: "RoadMap".to_string(),
                    },
                },
            },
            fixed_today(),
        )
        .expect("batch add tag");

        let content = connection
            .prepare("SELECT id, title, note FROM notes_nodes ORDER BY id")
            .expect("prepare added content")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .expect("query added content")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect added content");
        assert_eq!(
            content,
            vec![
                (
                    NODE_ID.to_string(),
                    "Parent today #RoadMap".to_string(),
                    "parent note".to_string(),
                ),
                (
                    CHILD_ID.to_string(),
                    "Child #RoadMap".to_string(),
                    "child note".to_string(),
                ),
                (
                    THIRD_ID.to_string(),
                    "Unselected #Roadmap".to_string(),
                    "nested note".to_string(),
                ),
            ]
        );
        let update_counts = connection
            .prepare(
                "SELECT node_id, COUNT(*) FROM batch_tag_update_count \
                 GROUP BY node_id ORDER BY node_id",
            )
            .expect("prepare update counts")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .expect("query update counts")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect update counts");
        assert_eq!(
            update_counts,
            vec![(NODE_ID.to_string(), 1), (CHILD_ID.to_string(), 1)]
        );
        let indexed_tags = connection
            .prepare(
                "SELECT node_id, tag, normalized_tag FROM notes_tags \
                 ORDER BY node_id, normalized_tag",
            )
            .expect("prepare added tag index")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query added tag index")
            .collect::<Result<Vec<(String, String, String)>, _>>()
            .expect("collect added tag index");
        assert_eq!(
            indexed_tags,
            vec![
                (
                    NODE_ID.to_string(),
                    "RoadMap".to_string(),
                    "roadmap".to_string(),
                ),
                (
                    CHILD_ID.to_string(),
                    "RoadMap".to_string(),
                    "roadmap".to_string(),
                ),
                (
                    THIRD_ID.to_string(),
                    "Roadmap".to_string(),
                    "roadmap".to_string(),
                ),
            ]
        );
        assert_eq!(date_rows(&connection, NODE_ID)[0].3, "2026-07-11");
        let indexed_search: (String, String) = connection
            .query_row(
                "SELECT title, note FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read added search projection");
        assert_eq!(
            indexed_search,
            (
                "Parent today #RoadMap".to_string(),
                "parent note".to_string()
            )
        );
    }

    #[test]
    fn batch_tag_remove_updates_title_and_note_but_not_unsubmitted_descendants() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "Plan #ROADMAP today, #Roadmap",
            "#roadmap details @Roadmap",
        );
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "한글 #ROADMAP 끝",
            "메모(#roadmap), 유지",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(CHILD_ID),
            None,
            "Nested #Roadmap",
            "unchanged #roadmap",
        );

        apply_batch_at(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                op: BatchOp::RemoveTag {
                    tag: NoteTagFilter {
                        prefix: NoteTagPrefix::Hash,
                        normalized_tag: "roadmap".to_string(),
                    },
                },
            },
            fixed_today(),
        )
        .expect("batch remove tag");

        for (id, expected_title, expected_note) in [
            (NODE_ID, "Plan today,", "details @Roadmap"),
            (CHILD_ID, "한글 끝", "메모(), 유지"),
            (THIRD_ID, "Nested #Roadmap", "unchanged #roadmap"),
        ] {
            let actual: (String, String) = connection
                .query_row(
                    "SELECT title, note FROM notes_nodes WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read removed content");
            assert_eq!(
                actual,
                (expected_title.to_string(), expected_note.to_string())
            );
        }
        let indexed_tags = connection
            .prepare(
                "SELECT node_id, prefix, normalized_tag FROM notes_tags \
                 ORDER BY node_id, prefix, normalized_tag",
            )
            .expect("prepare remaining tag index")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query remaining tag index")
            .collect::<Result<Vec<(String, String, String)>, _>>()
            .expect("collect remaining tag index");
        assert_eq!(
            indexed_tags,
            vec![
                (NODE_ID.to_string(), "@".to_string(), "roadmap".to_string(),),
                (THIRD_ID.to_string(), "#".to_string(), "roadmap".to_string(),),
            ]
        );
        let date = date_rows(&connection, NODE_ID);
        assert_eq!(date.len(), 1);
        assert_eq!(
            (date[0].0.as_str(), date[0].1, date[0].3.as_str()),
            ("title", 5, "2026-07-11")
        );
        let indexed_search: (String, String) = connection
            .query_row(
                "SELECT title, note FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read removed search projection");
        assert_eq!(
            indexed_search,
            ("Plan today,".to_string(), "details @Roadmap".to_string())
        );
    }

    #[test]
    fn batch_tag_remove_rolls_back_earlier_content_and_indexes_after_later_failure() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "A #Roadmap today #Safe",
            "first #Roadmap",
        );
        create_test_node(
            &mut connection,
            CHILD_ID,
            None,
            Some(NODE_ID),
            "B #Roadmap #Reject",
            "second #Roadmap",
        );
        let before = persistent_state(&connection);
        let before_dates = (
            date_rows(&connection, NODE_ID),
            date_rows(&connection, CHILD_ID),
        );
        connection
            .execute_batch(&format!(
                "CREATE TRIGGER reject_later_batch_tag BEFORE INSERT ON notes_tags \
                 WHEN NEW.node_id = '{CHILD_ID}' AND NEW.normalized_tag = 'reject' \
                 BEGIN SELECT RAISE(ABORT, 'later batch tag index rejected'); END;"
            ))
            .expect("install later tag failure trigger");

        let error = apply_batch_at(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                op: BatchOp::RemoveTag {
                    tag: NoteTagFilter {
                        prefix: NoteTagPrefix::Hash,
                        normalized_tag: "roadmap".to_string(),
                    },
                },
            },
            fixed_today(),
        )
        .expect_err("later index failure must roll back batch tag removal");

        assert!(
            error.contains("later batch tag index rejected"),
            "unexpected error: {error}"
        );
        assert_eq!(persistent_state(&connection), before);
        assert_eq!(
            (
                date_rows(&connection, NODE_ID),
                date_rows(&connection, CHILD_ID)
            ),
            before_dates
        );
    }

    #[test]
    fn duplicate_node_rejects_attachment_vault_overflow_before_any_write() {
        let mut connection = test_connection();
        for (id, sort_key) in [
            (NODE_ID, 1024),
            (CHILD_ID, 2048),
            (THIRD_ID, 3072),
            (FOURTH_ID, 4096),
        ] {
            insert_node(&connection, id, None, sort_key, id);
        }
        let nodes = [NODE_ID, CHILD_ID, THIRD_ID, FOURTH_ID];
        for index in 0..usize::try_from(MAX_NOTE_ATTACHMENTS_PER_VAULT).expect("vault limit") {
            let node_index =
                index / usize::try_from(MAX_NOTE_ATTACHMENTS_PER_NODE).expect("node limit");
            insert_test_attachment(&connection, index, nodes[node_index]);
        }
        let before_nodes = active_node_ids(&connection);
        let before_attachments = connection
            .prepare(
                "SELECT id, node_id, relative_path, content_hash FROM notes_attachments \
                 ORDER BY id",
            )
            .expect("prepare attachment state")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .expect("query attachment state")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect attachment state");
        let context = import_context("duplicate");

        let error = match with_history_transaction_and_prunes(
            &mut connection,
            Some(&context),
            |connection| duplicate_node(connection, NODE_ID),
        ) {
            Ok(_) => panic!("vault attachment overflow must be rejected"),
            Err(error) => error,
        };

        assert_eq!(error, "A Notes vault can contain at most 512 attachments.");
        assert_eq!(active_node_ids(&connection), before_nodes);
        let after_attachments = connection
            .prepare(
                "SELECT id, node_id, relative_path, content_hash FROM notes_attachments \
                 ORDER BY id",
            )
            .expect("prepare attachment state after rejection")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .expect("query attachment state after rejection")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect attachment state after rejection");
        assert_eq!(after_attachments, before_attachments);
        assert_eq!(history_entry_count(&connection), 0);
    }

    #[test]
    fn batch_duplicate_preflights_the_full_forest_attachment_capacity() {
        let mut connection = test_connection();
        for (id, sort_key) in [
            (NODE_ID, 1024),
            (CHILD_ID, 2048),
            (THIRD_ID, 3072),
            (FOURTH_ID, 4096),
            (FIFTH_ID, 5120),
            (SIXTH_ID, 6144),
        ] {
            insert_node(&connection, id, None, sort_key, id);
        }
        insert_test_attachment(&connection, 0, NODE_ID);
        insert_test_attachment(&connection, 1, CHILD_ID);
        let fillers = [THIRD_ID, FOURTH_ID, FIFTH_ID, SIXTH_ID];
        let mut index = 2_usize;
        for (filler_index, node_id) in fillers.into_iter().enumerate() {
            let count = if filler_index < 3 {
                usize::try_from(MAX_NOTE_ATTACHMENTS_PER_NODE).expect("node limit")
            } else {
                125
            };
            for _ in 0..count {
                insert_test_attachment(&connection, index, node_id);
                index += 1;
            }
        }
        assert_eq!(index, 511);
        let before_nodes = active_node_ids(&connection);
        let before_attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("attachment count before overflow");
        let context = import_context("batchDuplicate");

        let error = match with_history_transaction_and_prunes(
            &mut connection,
            Some(&context),
            |connection| {
                apply_batch(
                    connection,
                    ApplyBatchInput {
                        node_ids: vec![CHILD_ID.to_string(), NODE_ID.to_string()],
                        op: BatchOp::Duplicate,
                    },
                )
            },
        ) {
            Ok(_) => panic!("full forest attachment overflow must be rejected"),
            Err(error) => error,
        };

        assert_eq!(error, "A Notes vault can contain at most 512 attachments.");
        assert_eq!(active_node_ids(&connection), before_nodes);
        let after_attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("attachment count after overflow");
        assert_eq!(after_attachment_count, before_attachment_count);
        assert_eq!(history_entry_count(&connection), 0);
    }

    #[test]
    fn batch_duplicate_allows_attachment_copies_at_the_exact_vault_limit() {
        let mut connection = test_connection();
        for (id, sort_key) in [
            (NODE_ID, 1024),
            (CHILD_ID, 2048),
            (THIRD_ID, 3072),
            (FOURTH_ID, 4096),
            (FIFTH_ID, 5120),
            (SIXTH_ID, 6144),
        ] {
            insert_node(&connection, id, None, sort_key, id);
        }
        insert_test_attachment(&connection, 0, NODE_ID);
        insert_test_attachment(&connection, 1, CHILD_ID);
        let fillers = [THIRD_ID, FOURTH_ID, FIFTH_ID, SIXTH_ID];
        let mut index = 2_usize;
        for (filler_index, node_id) in fillers.into_iter().enumerate() {
            let count = if filler_index < 3 {
                usize::try_from(MAX_NOTE_ATTACHMENTS_PER_NODE).expect("node limit")
            } else {
                124
            };
            for _ in 0..count {
                insert_test_attachment(&connection, index, node_id);
                index += 1;
            }
        }
        assert_eq!(index, 510);

        apply_batch(
            &mut connection,
            ApplyBatchInput {
                node_ids: vec![NODE_ID.to_string(), CHILD_ID.to_string()],
                op: BatchOp::Duplicate,
            },
        )
        .expect("exact attachment capacity remains legal");

        let attachment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get(0)
            })
            .expect("attachment count at capacity");
        assert_eq!(attachment_count, MAX_NOTE_ATTACHMENTS_PER_VAULT);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn duplicate_node_rolls_back_nodes_search_and_tags_after_a_mid_copy_failure() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "copy root #Root",
            "root note #Details",
        );
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "copy child #Child",
            "child note #Details",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            None,
            Some(NODE_ID),
            "following #Root",
            "",
        );
        let before = persistent_state(&connection);
        connection
            .execute_batch(
                "CREATE TRIGGER reject_duplicate_child BEFORE INSERT ON notes_nodes \
                 WHEN NEW.parent_id IS NOT NULL AND NEW.title = 'copy child #Child' \
                 BEGIN SELECT RAISE(ABORT, 'duplicate child rejected'); END;",
            )
            .expect("duplicate failure trigger");

        let error = duplicate_node(&mut connection, NODE_ID).expect_err("duplicate rollback");

        assert!(error.contains("duplicate child rejected"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn remove_empty_node_rolls_back_full_state_after_terminal_search_deletion_failure() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "parent #Outline", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "before #Sibling",
            "",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(NODE_ID),
            Some(CHILD_ID),
            " \t ",
            "\n",
        );
        create_test_node(
            &mut connection,
            FOURTH_ID,
            Some(THIRD_ID),
            None,
            "child one #Child",
            "",
        );
        create_test_node(
            &mut connection,
            FIFTH_ID,
            Some(THIRD_ID),
            Some(FOURTH_ID),
            "child two #Child",
            "",
        );
        create_test_node(
            &mut connection,
            SIXTH_ID,
            Some(NODE_ID),
            Some(THIRD_ID),
            "after #Sibling",
            "",
        );
        connection
            .execute(
                "UPDATE notes_nodes SET \
                   is_collapsed = CASE WHEN id IN (?1, ?2) THEN 1 ELSE 0 END, \
                   is_starred = CASE WHEN id IN (?2, ?3) THEN 1 ELSE 0 END, \
                   completed_at = CASE WHEN id IN (?3, ?4) \
                     THEN '2025-01-02T03:04:05.000Z' ELSE NULL END, \
                   created_at = '2024-01-02T03:04:05.000Z', \
                   updated_at = '2025-02-03T04:05:06.000Z'",
                params![THIRD_ID, FOURTH_ID, FIFTH_ID, SIXTH_ID],
            )
            .expect("seed distinctive persisted node state");
        let before = persistent_state(&connection);
        install_remove_terminal_failure_trigger(&connection, THIRD_ID);

        let error = remove_empty_node(&mut connection, THIRD_ID).expect_err("remove rollback");

        assert!(error.contains("remove terminal search deletion rejected"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn deleting_a_node_hides_the_live_subtree_from_workspace_and_search_then_restores_it() {
        let mut connection = test_connection();
        let root = insert_tree(&connection);

        soft_delete_node(&mut connection, &root).expect("delete");
        let root_batch: String = connection
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("root deletion batch");
        let child_batch: String = connection
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("child deletion batch");
        assert_eq!(root_batch, child_batch);
        assert!(load_workspace(&connection, NotesWorkspaceScope::Active)
            .expect("active")
            .nodes
            .is_empty());
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Trash)
                .expect("trash")
                .nodes
                .len(),
            2
        );
        let search_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_search", [], |row| row.get(0))
            .expect("search count after delete");
        assert_eq!(search_count, 0);

        restore_node(&mut connection, &root).expect("restore");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active")
                .nodes
                .len(),
            2
        );
        let restored_search_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_search", [], |row| row.get(0))
            .expect("search count after restore");
        assert_eq!(restored_search_count, 2);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn restoring_an_ancestor_keeps_an_independently_trashed_child_deleted() {
        let mut connection = test_connection();
        let root = insert_tree(&connection);

        soft_delete_node(&mut connection, CHILD_ID).expect("delete child independently");
        let child_batch: String = connection
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("child deletion batch");
        soft_delete_node(&mut connection, &root).expect("delete ancestor later");
        connection
            .execute(
                "UPDATE notes_nodes SET deleted_at = '2026-07-10T09:08:07.006Z' \
                 WHERE id IN (?1, ?2)",
                params![NODE_ID, CHILD_ID],
            )
            .expect("force identical deletion timestamps");
        let (child_deleted_at, child_batch_after): (String, String) = connection
            .query_row(
                "SELECT deleted_at, deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("child deletion provenance");
        let (root_deleted_at, root_batch): (String, String) = connection
            .query_row(
                "SELECT deleted_at, deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("root deletion provenance");
        assert_eq!(child_deleted_at, root_deleted_at);
        assert_eq!(child_batch, child_batch_after);
        assert_ne!(child_batch, root_batch);

        restore_node(&mut connection, &root).expect("restore ancestor");

        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active workspace")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID]
        );
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Trash)
                .expect("trash workspace")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![CHILD_ID]
        );
        let root_provenance: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT deleted_at, deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("restored root provenance");
        assert_eq!(root_provenance, (None, None));
        let retained_child_batch: String = connection
            .query_row(
                "SELECT deleted_batch_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("retained child deletion batch");
        assert_eq!(retained_child_batch, child_batch);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn restoring_a_subtree_uses_the_root_when_its_parent_remains_deleted() {
        let mut connection = test_connection();
        let root = insert_tree(&connection);
        insert_node(&connection, THIRD_ID, Some(CHILD_ID), 1024, "grandchild");
        soft_delete_node(&mut connection, &root).expect("delete tree");

        restore_node(&mut connection, CHILD_ID).expect("restore child subtree");

        let child_parent: Option<String> = connection
            .query_row(
                "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                [CHILD_ID],
                |row| row.get(0),
            )
            .expect("restored child parent");
        assert_eq!(child_parent, None);
        assert_eq!(active_children(&connection, Some(CHILD_ID)).len(), 1);
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Trash)
                .expect("trash")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn restore_rebalances_when_a_live_sibling_occupies_the_original_sort_key() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "parent");
        insert_node(&connection, CHILD_ID, Some(NODE_ID), 1024, "trashed child");
        soft_delete_node(&mut connection, CHILD_ID).expect("delete child");
        create_node(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: THIRD_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                title: "replacement child".to_string(),
                note: String::new(),
            },
        )
        .expect("occupy old sort key");

        restore_node(&mut connection, CHILD_ID).expect("restore child");

        assert_eq!(
            active_children(&connection, Some(NODE_ID)),
            vec![(CHILD_ID.to_string(), 1024), (THIRD_ID.to_string(), 2048)]
        );
        assert_tree_invariants(&connection);
    }

    #[test]
    fn restore_collision_rolls_back_full_state_after_terminal_search_reinsertion_failure() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "parent #Outline", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "trashed child #Restore",
            "restore note #Details",
        );
        soft_delete_node(&mut connection, CHILD_ID).expect("delete child");
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(NODE_ID),
            None,
            "replacement #Restore",
            "",
        );
        connection
            .execute(
                "UPDATE notes_nodes SET \
                   is_collapsed = CASE WHEN id = ?1 THEN 1 ELSE 0 END, \
                   is_starred = CASE WHEN id IN (?1, ?2) THEN 1 ELSE 0 END, \
                   completed_at = CASE WHEN id = ?1 \
                     THEN '2025-03-04T05:06:07.000Z' ELSE NULL END, \
                   created_at = '2024-03-04T05:06:07.000Z', \
                   updated_at = '2025-04-05T06:07:08.000Z'",
                params![CHILD_ID, THIRD_ID],
            )
            .expect("seed distinctive persisted node state");
        let before = persistent_state(&connection);
        install_restore_terminal_failure_trigger(&connection, CHILD_ID);

        let error = restore_node(&mut connection, CHILD_ID).expect_err("restore rollback");

        assert!(error.contains("restore terminal search reinsertion rejected"));
        assert_eq!(persistent_state(&connection), before);
        assert_tree_invariants(&connection);
    }

    #[test]
    fn empty_trash_removes_deleted_rows_and_their_search_and_tags() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "active #Keep", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            None,
            Some(NODE_ID),
            "trash root #Remove",
            "",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(CHILD_ID),
            None,
            "trash child #Remove",
            "",
        );
        soft_delete_node(&mut connection, CHILD_ID).expect("delete subtree");
        let tags_before_emptying: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_tags", [], |row| row.get(0))
            .expect("tags before emptying trash");
        assert_eq!(tags_before_emptying, 3);

        empty_trash(&mut connection).expect("empty trash");

        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("active")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID]
        );
        assert!(load_workspace(&connection, NotesWorkspaceScope::Trash)
            .expect("trash")
            .nodes
            .is_empty());
        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row.get(0))
            .expect("remaining rows");
        assert_eq!(row_count, 1);
        let search_ids = connection
            .prepare("SELECT node_id FROM notes_search ORDER BY node_id")
            .expect("prepare remaining search rows")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query remaining search rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect remaining search rows");
        assert_eq!(search_ids, vec![NODE_ID]);
        let tag_rows = connection
            .prepare("SELECT node_id, normalized_tag FROM notes_tags ORDER BY node_id")
            .expect("prepare remaining tag rows")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query remaining tag rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect remaining tag rows");
        assert_eq!(tag_rows, vec![(NODE_ID.to_string(), "keep".to_string())]);
    }

    #[test]
    fn update_and_toggles_refresh_content_search_tags_and_flags() {
        let mut connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "before");

        update_node(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "After #Project".to_string(),
                note: "Details #project #Next-Step".to_string(),
                image_offset_utf16: 0,
                markdown_image_width: None,
            },
        )
        .expect("update node");
        toggle_complete(&mut connection, NODE_ID).expect("complete node");
        toggle_collapsed(&mut connection, NODE_ID).expect("collapse node");

        let node = load_workspace(&connection, NotesWorkspaceScope::Active)
            .expect("active workspace")
            .nodes
            .pop()
            .expect("updated node");
        assert_eq!(node.title, "After #Project");
        assert!(node.completed_at.is_some());
        assert!(node.is_collapsed);
        let indexed_note: String = connection
            .query_row(
                "SELECT note FROM notes_search WHERE node_id = ?1",
                [NODE_ID],
                |row| row.get(0),
            )
            .expect("indexed note");
        assert_eq!(indexed_note, "Details #project #Next-Step");
        let tags = connection
            .prepare(
                "SELECT normalized_tag FROM notes_tags WHERE node_id = ?1 ORDER BY normalized_tag",
            )
            .expect("prepare tags")
            .query_map([NODE_ID], |row| row.get::<_, String>(0))
            .expect("query tags")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect tags");
        assert_eq!(tags, vec!["next-step", "project"]);
    }

    #[test]
    fn update_indexes_tags_and_fts_content_together() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "Root", "");
        create_test_node(&mut connection, CHILD_ID, Some(NODE_ID), None, "Draft", "");

        update_node(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: CHILD_ID.to_string(),
                title: "#Roadmap search target".to_string(),
                note: "#Offline detail #ROADMAP".to_string(),
                image_offset_utf16: 0,
                markdown_image_width: None,
            },
        )
        .expect("update");

        assert_eq!(
            list_tags(&connection).expect("tags"),
            vec!["offline", "roadmap"]
        );
        let title_results = search_nodes(&connection, "  target  ").expect("title search");
        assert_eq!(title_results.len(), 1);
        assert_eq!(title_results[0].node_id, CHILD_ID);
        assert_eq!(title_results[0].parent_trail, vec!["Root"]);
        assert_eq!(
            title_results[0].matched_field,
            NoteSearchMatchedField::Title
        );

        let note_results = search_nodes(&connection, "detail").expect("note search");
        assert_eq!(note_results.len(), 1);
        assert_eq!(note_results[0].matched_field, NoteSearchMatchedField::Note);
        assert!(search_nodes(&connection, " \n\t ")
            .expect("blank search")
            .is_empty());
        assert!(search_nodes(&connection, "\" OR *")
            .expect("escaped FTS syntax")
            .is_empty());
        assert_eq!(
            search_nodes(&connection, "#Roadmap")
                .expect("tag-like search")
                .len(),
            1
        );
        for literal_query in [
            "target OR missing",
            "NEAR(target detail)",
            "tar\"get",
            "---",
            "#",
        ] {
            assert!(
                search_nodes(&connection, literal_query)
                    .unwrap_or_else(|error| panic!("literal query {literal_query:?}: {error}"))
                    .is_empty(),
                "FTS syntax must not change the meaning of {literal_query:?}"
            );
        }
    }

    #[test]
    fn tag_index_distinguishes_prefixes_and_rejects_embedded_or_url_markers() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "#Same @Same foo#embedded ##double",
            "https://example.test/#fragment valid @Owner",
        );

        let tags = connection
            .prepare(
                "SELECT prefix, normalized_tag FROM notes_tags WHERE node_id = ?1 \
                 ORDER BY prefix, normalized_tag",
            )
            .expect("prepare prefixed tags")
            .query_map([NODE_ID], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query prefixed tags")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect prefixed tags");
        assert_eq!(
            tags,
            vec![
                ("#".to_string(), "same".to_string()),
                ("@".to_string(), "owner".to_string()),
                ("@".to_string(), "same".to_string()),
            ]
        );
    }

    #[test]
    fn notes_tag_index_matches_unicode_and_url_tokenizer_rules() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "😀#Tag #𐐷 #café https://x/?q=#hidden",
            "/path/?q=@hidden #नमस्ते",
        );

        let tags = connection
            .prepare(
                "SELECT prefix, tag, normalized_tag FROM notes_tags WHERE node_id = ?1 \
                 ORDER BY prefix, normalized_tag",
            )
            .expect("prepare Unicode tags")
            .query_map([NODE_ID], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .expect("query Unicode tags")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect Unicode tags");

        assert_eq!(
            tags,
            vec![
                (
                    "#".to_string(),
                    "caf\u{e9}".to_string(),
                    "caf\u{e9}".to_string()
                ),
                ("#".to_string(), "Tag".to_string(), "tag".to_string()),
                ("#".to_string(), "नमस्ते".to_string(), "नमस्ते".to_string()),
                ("#".to_string(), "𐐷".to_string(), "𐐷".to_string()),
            ]
        );
    }

    #[test]
    fn notes_date_index_replaces_title_and_note_rows_for_every_content_copy_path() {
        let mut connection = test_connection();
        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "😀 today #old".to_string(),
                note: "07/12/2026".to_string(),
            },
            fixed_today(),
        )
        .expect("create dated node");
        assert_eq!(
            date_rows(&connection, NODE_ID),
            vec![
                (
                    "title".to_string(),
                    3,
                    8,
                    "2026-07-11".to_string(),
                    "2026-07-11".to_string(),
                    "today".to_string()
                ),
                (
                    "note".to_string(),
                    0,
                    10,
                    "2026-07-12".to_string(),
                    "2026-07-12".to_string(),
                    "07/12/2026".to_string()
                ),
            ]
        );

        update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "#new 07/13/2026".to_string(),
                note: "next week".to_string(),
                image_offset_utf16: 0,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .expect("update dated node");
        assert_eq!(list_tags(&connection).expect("updated tags"), vec!["new"]);
        assert_eq!(
            date_rows(&connection, NODE_ID),
            vec![
                (
                    "title".to_string(),
                    5,
                    15,
                    "2026-07-13".to_string(),
                    "2026-07-13".to_string(),
                    "07/13/2026".to_string()
                ),
                (
                    "note".to_string(),
                    0,
                    9,
                    "2026-07-13".to_string(),
                    "2026-07-19".to_string(),
                    "next week".to_string()
                ),
            ]
        );

        split_node_at(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: CHILD_ID.to_string(),
                prefix: "today".to_string(),
                suffix: "tomorrow".to_string(),
            },
            fixed_today(),
        )
        .expect("split dated node");
        assert_eq!(date_rows(&connection, NODE_ID)[0].5, "today");
        assert_eq!(date_rows(&connection, CHILD_ID)[0].5, "tomorrow");

        let duplicated = duplicate_node_at(&mut connection, NODE_ID, fixed_today())
            .expect("duplicate dated subtree");
        let copied_root = duplicated
            .nodes
            .iter()
            .find(|node| node.id != NODE_ID && node.id != CHILD_ID && node.title == "today")
            .expect("copied root");
        assert_eq!(
            date_rows(&connection, &copied_root.id),
            date_rows(&connection, NODE_ID)
        );

        soft_delete_node(&mut connection, NODE_ID).expect("trash dated subtree");
        connection
            .execute("DELETE FROM notes_dates WHERE node_id = ?1", [NODE_ID])
            .expect("simulate stale derived rows");
        restore_node_at(&mut connection, NODE_ID, fixed_today()).expect("restore dated subtree");
        assert_eq!(date_rows(&connection, NODE_ID)[0].5, "today");
    }

    #[test]
    fn notes_date_and_tag_replacement_rolls_back_with_the_content_transaction() {
        let mut connection = test_connection();
        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "today #old".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("seed dated node");
        connection
            .execute_batch(
                "CREATE TRIGGER fail_date_projection BEFORE INSERT ON notes_dates \
                 WHEN NEW.token_text = 'tomorrow' BEGIN SELECT RAISE(ABORT, 'date failure'); END;",
            )
            .expect("install date failure");

        assert!(update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: "tomorrow #new".to_string(),
                note: String::new(),
                image_offset_utf16: 0,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .is_err());
        assert_eq!(
            list_tags(&connection).expect("rolled back tags"),
            vec!["old"]
        );
        assert_eq!(date_rows(&connection, NODE_ID)[0].5, "today");
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Active)
                .expect("workspace")
                .nodes[0]
                .title,
            "today #old"
        );
    }

    #[test]
    fn notes_date_search_uses_interval_overlap_scopes_limits_and_fts_fallback() {
        let mut connection = test_connection();
        for (id, title) in [
            (NODE_ID, "fallback-target 07/12/2026"),
            (CHILD_ID, "Archived 07/13/2026"),
            (THIRD_ID, "Trashed 07/14/2026"),
        ] {
            create_node_at(
                &mut connection,
                CreateNodeInput {
                    marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                    id: id.to_string(),
                    parent_id: None,
                    after_id: None,
                    title: title.to_string(),
                    note: String::new(),
                },
                fixed_today(),
            )
            .expect("seed date search node");
        }
        archive_node(&mut connection, CHILD_ID).expect("archive fixture");
        soft_delete_node(&mut connection, THIRD_ID).expect("trash fixture");

        let active = search_nodes_at(
            &connection,
            "tomorrow",
            NoteSearchScope::Active,
            fixed_today(),
        )
        .expect("natural date search");
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].node_id, NODE_ID);
        assert_eq!(active[0].matched_field, NoteSearchMatchedField::Date);

        for (scope, expected) in [
            (NoteSearchScope::Active, NODE_ID),
            (NoteSearchScope::Archive, CHILD_ID),
            (NoteSearchScope::Trash, THIRD_ID),
        ] {
            let results =
                search_nodes_at(&connection, "07/12/2026 - 07/14/2026", scope, fixed_today())
                    .expect("scoped range search");
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].node_id, expected);
        }
        assert_eq!(
            search_nodes_at(
                &connection,
                "fallback-target",
                NoteSearchScope::Active,
                fixed_today(),
            )
            .expect("FTS fallback")[0]
                .matched_field,
            NoteSearchMatchedField::Title
        );

        for index in 0..101 {
            let id = format!("{index:08x}-7777-4777-8777-777777777777");
            create_node_at(
                &mut connection,
                CreateNodeInput {
                    marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                    id,
                    parent_id: None,
                    after_id: None,
                    title: "07/12/2026".to_string(),
                    note: String::new(),
                },
                fixed_today(),
            )
            .expect("seed date limit node");
        }
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = '2026-07-11T00:00:00.000Z'",
                [],
            )
            .expect("set deterministic date result order");
        let limited = search_nodes_at(
            &connection,
            "07/12/2026",
            NoteSearchScope::Active,
            fixed_today(),
        )
        .expect("limited date search");
        assert_eq!(
            limited
                .iter()
                .map(|result| result.node_id.clone())
                .collect::<Vec<_>>(),
            (0..100)
                .map(|index| format!("{index:08x}-7777-4777-8777-777777777777"))
                .collect::<Vec<_>>()
        );
        let plan = connection
            .prepare(
                "EXPLAIN QUERY PLAN SELECT node_id FROM notes_dates \
                 WHERE normalized_start <= ?1 AND normalized_end >= ?2",
            )
            .expect("prepare date query plan")
            .query_map(params!["2026-07-12", "2026-07-12"], |row| {
                row.get::<_, String>(3)
            })
            .expect("query date plan")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect date plan")
            .join(" ");
        assert!(plan.contains("notes_dates_range"), "query plan: {plan}");
    }

    #[test]
    fn notes_archive_and_trash_text_search_preserves_matches_order_and_limits() {
        let mut connection = test_connection();
        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Active needle".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create active search control");
        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: CHILD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                title: "Archived needle".to_string(),
                note: "supportdetail".to_string(),
            },
            fixed_today(),
        )
        .expect("create archive search fixture");
        archive_node(&mut connection, CHILD_ID).expect("archive search fixture");
        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: THIRD_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                title: "Trashed needle".to_string(),
                note: "trashextra".to_string(),
            },
            fixed_today(),
        )
        .expect("create trash search fixture");
        soft_delete_node(&mut connection, THIRD_ID).expect("trash search fixture");

        let archived = search_nodes_at(
            &connection,
            "needle",
            NoteSearchScope::Archive,
            fixed_today(),
        )
        .expect("archive text search");
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].node_id, CHILD_ID);
        assert_eq!(archived[0].matched_field, NoteSearchMatchedField::Title);
        assert_eq!(
            search_nodes_at(
                &connection,
                "supportdetail",
                NoteSearchScope::Archive,
                fixed_today(),
            )
            .expect("archive note search")[0]
                .matched_field,
            NoteSearchMatchedField::Note
        );

        let trashed = search_nodes_at(&connection, "needle", NoteSearchScope::Trash, fixed_today())
            .expect("trash text search");
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].node_id, THIRD_ID);
        assert_eq!(
            search_nodes_at(
                &connection,
                "trashextra",
                NoteSearchScope::Trash,
                fixed_today(),
            )
            .expect("trash note search")[0]
                .matched_field,
            NoteSearchMatchedField::Note
        );
        assert_eq!(
            search_nodes_at(
                &connection,
                "needle",
                NoteSearchScope::Active,
                fixed_today(),
            )
            .expect("active FTS control")
            .iter()
            .map(|result| result.node_id.as_str())
            .collect::<Vec<_>>(),
            vec![NODE_ID]
        );

        for index in 0..101 {
            let id = format!("{index:08x}-8888-4888-8888-888888888888");
            connection
                .execute(
                    "INSERT INTO notes_nodes (id, sort_key, title, created_at, updated_at, \
                       archived_at, archive_root_id) \
                     VALUES (?1, ?2, 'lifecyclelimit', '2026-07-11T00:00:00.000Z', \
                             '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', ?1)",
                    params![id, i64::from(index + 1) * 1024],
                )
                .expect("insert archive limit fixture");
        }
        let limited = search_nodes_at(
            &connection,
            "lifecyclelimit",
            NoteSearchScope::Archive,
            fixed_today(),
        )
        .expect("limited archive text search");
        assert_eq!(limited.len(), 100);
        assert_eq!(
            limited
                .iter()
                .map(|result| result.node_id.clone())
                .collect::<Vec<_>>(),
            (0..100)
                .map(|index| format!("{index:08x}-8888-4888-8888-888888888888"))
                .collect::<Vec<_>>()
        );

        for (index, updated_at) in [
            (0, "2026-07-11T01:00:00.000Z"),
            (1, "2026-07-11T03:00:00.000Z"),
            (2, "2026-07-11T02:00:00.000Z"),
        ] {
            let id = format!("{index:08x}-9999-4999-8999-999999999999");
            connection
                .execute(
                    "INSERT INTO notes_nodes (id, sort_key, title, created_at, updated_at, \
                       deleted_at, deleted_batch_id) \
                     VALUES (?1, ?2, 'trashorder', '2026-07-11T00:00:00.000Z', ?3, \
                             '2026-07-11T00:00:00.000Z', 'trash-order')",
                    params![id, i64::from(index + 1) * 1024, updated_at],
                )
                .expect("insert trash order fixture");
        }
        assert_eq!(
            search_nodes_at(
                &connection,
                "trashorder",
                NoteSearchScope::Trash,
                fixed_today(),
            )
            .expect("ordered trash text search")
            .iter()
            .map(|result| result.node_id.clone())
            .collect::<Vec<_>>(),
            vec![
                "00000001-9999-4999-8999-999999999999".to_string(),
                "00000002-9999-4999-8999-999999999999".to_string(),
                "00000000-9999-4999-8999-999999999999".to_string(),
            ]
        );
    }

    #[test]
    fn notes_lifecycle_search_trails_match_trash_rerooting_and_archive_context() {
        let mut connection = test_connection();
        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                parent_id: None,
                after_id: None,
                title: "Live parent".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create live parent");
        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: CHILD_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                title: "Independent trash 07/12/2026".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create independent trash child");
        soft_delete_node(&mut connection, CHILD_ID).expect("trash child only");
        let trash_workspace =
            load_workspace(&connection, NotesWorkspaceScope::Trash).expect("trash workspace");
        assert_eq!(trash_workspace.nodes[0].parent_id, None);
        assert_eq!(
            search_nodes_at(
                &connection,
                "07/12/2026",
                NoteSearchScope::Trash,
                fixed_today(),
            )
            .expect("re-rooted trash search")[0]
                .parent_trail,
            Vec::<String>::new()
        );

        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: THIRD_ID.to_string(),
                parent_id: Some(NODE_ID.to_string()),
                after_id: None,
                title: "Trash subtree root".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create trash subtree root");
        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: FOURTH_ID.to_string(),
                parent_id: Some(THIRD_ID.to_string()),
                after_id: None,
                title: "Nested trash 07/13/2026".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create nested trash child");
        soft_delete_node(&mut connection, THIRD_ID).expect("trash subtree");
        assert_eq!(
            search_nodes_at(
                &connection,
                "07/13/2026",
                NoteSearchScope::Trash,
                fixed_today(),
            )
            .expect("nested trash search")[0]
                .parent_trail,
            vec!["Trash subtree root"]
        );

        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: FIFTH_ID.to_string(),
                parent_id: None,
                after_id: Some(NODE_ID.to_string()),
                title: "Archive root".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create archive root");
        connection
            .execute(
                "UPDATE notes_nodes SET node_kind = 'image' WHERE id = ?1",
                [FIFTH_ID],
            )
            .expect("mark archive root as image");
        create_node_at(
            &mut connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: SIXTH_ID.to_string(),
                parent_id: Some(FIFTH_ID.to_string()),
                after_id: None,
                title: "Archived child 07/14/2026".to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create archive child");
        archive_node(&mut connection, FIFTH_ID).expect("archive subtree");
        let archived = search_nodes_at(
            &connection,
            "07/14/2026",
            NoteSearchScope::Archive,
            fixed_today(),
        )
        .expect("archive context search");
        assert_eq!(archived[0].node_kind, NoteNodeKind::Text);
        assert_eq!(archived[0].parent_trail, vec!["Archive root"]);
        assert_eq!(archived[0].parent_trail_kinds, vec![NoteNodeKind::Image]);
    }

    fn create_search_node(
        connection: &mut Connection,
        id: &str,
        parent_id: Option<&str>,
        title: &str,
    ) {
        create_node_at(
            connection,
            CreateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: id.to_string(),
                parent_id: parent_id.map(str::to_string),
                after_id: None,
                title: title.to_string(),
                note: String::new(),
            },
            fixed_today(),
        )
        .expect("create search fixture node");
    }

    #[test]
    fn search_parent_trails_resolve_nested_root_and_empty_result_sets() {
        let mut connection = test_connection();
        create_search_node(&mut connection, NODE_ID, None, "Alpha");
        create_search_node(&mut connection, CHILD_ID, Some(NODE_ID), "Bravo");
        create_search_node(&mut connection, THIRD_ID, Some(CHILD_ID), "Charlie");
        create_search_node(&mut connection, FOURTH_ID, Some(THIRD_ID), "Delta target");
        connection
            .execute(
                "UPDATE notes_nodes SET node_kind = 'image' WHERE id = ?1",
                [NODE_ID],
            )
            .expect("mark root ancestor as image");

        // Nested result: full ancestor trail, ordered root-first.
        let nested = search_nodes(&connection, "target").expect("nested search");
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0].node_id, FOURTH_ID);
        assert_eq!(nested[0].node_kind, NoteNodeKind::Text);
        assert_eq!(nested[0].parent_trail, vec!["Alpha", "Bravo", "Charlie"]);
        assert_eq!(
            nested[0].parent_trail_kinds,
            vec![NoteNodeKind::Image, NoteNodeKind::Text, NoteNodeKind::Text]
        );

        // Root-level result: no ancestors to resolve.
        let root = search_nodes(&connection, "Alpha").expect("root search");
        assert_eq!(root.len(), 1);
        assert_eq!(root[0].node_id, NODE_ID);
        assert_eq!(root[0].node_kind, NoteNodeKind::Image);
        assert_eq!(root[0].parent_trail, Vec::<String>::new());
        assert_eq!(root[0].parent_trail_kinds, Vec::<NoteNodeKind>::new());

        // Structured search over the same nested leaf resolves the same trail.
        let structured = search_nodes_structured(
            &connection,
            &NoteStructuredSearchQuery {
                text: "target".to_string(),
                required_tags: Vec::new(),
                excluded_tags: Vec::new(),
                or_groups: Vec::new(),
            },
        )
        .expect("structured nested search");
        assert_eq!(structured.len(), 1);
        assert_eq!(structured[0].node_id, FOURTH_ID);
        assert_eq!(
            structured[0].parent_trail,
            vec!["Alpha", "Bravo", "Charlie"]
        );

        // Empty result set: no trails to resolve, no panic.
        assert!(search_nodes(&connection, "missing")
            .expect("empty search")
            .is_empty());
    }

    #[test]
    fn notes_tag_workspace_scope_rejects_noncanonical_body() {
        let connection = test_connection();
        let error = load_workspace(
            &connection,
            NotesWorkspaceScope::Tags {
                tags: vec![NoteTagFilter {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: "##x".to_string(),
                }],
            },
        )
        .expect_err("invalid typed tag workspace scope");

        assert_eq!(
            error,
            "Structured Notes search tag normalizedTag must be a canonical tag body."
        );
    }

    fn search_tag(prefix: NoteTagPrefix, tag: &str) -> NoteSearchTag {
        NoteSearchTag {
            prefix,
            normalized_tag: tag.to_string(),
            display_tag: tag.to_string(),
        }
    }

    fn structured_query(
        text: &str,
        required_tags: Vec<NoteSearchTag>,
        excluded_tags: Vec<NoteSearchTag>,
        or_groups: Vec<Vec<NoteSearchTag>>,
    ) -> NoteStructuredSearchQuery {
        NoteStructuredSearchQuery {
            text: text.to_string(),
            required_tags,
            excluded_tags,
            or_groups,
        }
    }

    #[test]
    fn notes_tag_structured_search_classifies_image_note_tags_without_filename_title() {
        let mut connection = test_connection();
        let filename = "#same #hidden 2026-07-14 image.png";
        let mut attachment = test_new_attachment(99, NODE_ID);
        attachment.original_name = filename.to_string();
        create_image_nodes_coordinated(
            &mut connection,
            None,
            None,
            vec![NewImageNode {
                id: NODE_ID.to_string(),
                title: String::new(),
                attachment,
            }],
            || Ok(()),
            || Ok(()),
        )
        .expect("seed image node");
        update_node_at(
            &mut connection,
            UpdateNodeInput {
                marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
                id: NODE_ID.to_string(),
                title: String::new(),
                note: "Caption #same 07/15/2026".to_string(),
                image_offset_utf16: 0,
                markdown_image_width: None,
            },
            fixed_today(),
        )
        .expect("seed image note projections");

        let filename_fts = search_nodes(&connection, "#same").expect("mixed FTS search");
        assert_eq!(filename_fts.len(), 1);
        assert_eq!(filename_fts[0].node_id, NODE_ID);
        assert_eq!(filename_fts[0].node_kind, NoteNodeKind::Image);
        assert_eq!(filename_fts[0].title, "");
        assert!(filename_fts[0].parent_trail_kinds.is_empty());
        assert_eq!(filename_fts[0].matched_field, NoteSearchMatchedField::Note);

        let attachment_fts = search_nodes(&connection, "hidden").expect("filename FTS search");
        assert_eq!(attachment_fts.len(), 1);
        assert_eq!(
            attachment_fts[0].matched_field,
            NoteSearchMatchedField::Attachment
        );
        assert_eq!(attachment_fts[0].attachment_name.as_deref(), Some(filename));

        let note_tag = search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Hash, "same")],
                vec![],
                vec![],
            ),
        )
        .expect("image note tag structured search");
        assert_eq!(note_tag.len(), 1);
        assert_eq!(note_tag[0].node_id, NODE_ID);
        assert_eq!(note_tag[0].node_kind, NoteNodeKind::Image);
        assert_eq!(note_tag[0].title, "");
        assert!(note_tag[0].parent_trail_kinds.is_empty());
        assert_eq!(note_tag[0].matched_field, NoteSearchMatchedField::Note);

        assert!(search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Hash, "hidden")],
                vec![],
                vec![],
            ),
        )
        .expect("filename-only tag structured search")
        .is_empty());
        assert!(search_nodes_at(
            &connection,
            "07/14/2026",
            NoteSearchScope::Active,
            fixed_today(),
        )
        .expect("filename-only date structured search")
        .is_empty());
        let note_date = search_nodes_at(
            &connection,
            "07/15/2026",
            NoteSearchScope::Active,
            fixed_today(),
        )
        .expect("image note date search");
        assert_eq!(note_date.len(), 1);
        assert_eq!(note_date[0].node_id, NODE_ID);
        assert_eq!(note_date[0].node_kind, NoteNodeKind::Image);
        assert!(note_date[0].parent_trail_kinds.is_empty());
        assert_eq!(note_date[0].matched_field, NoteSearchMatchedField::Date);
    }

    #[test]
    fn notes_tag_structured_search_combines_fts_and_parameterized_filters() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "Home", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "Release #Roadmap @Minji",
            "shipping detail",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(NODE_ID),
            Some(CHILD_ID),
            "Release blocked #Roadmap @Minji #Blocked",
            "",
        );
        create_test_node(
            &mut connection,
            FOURTH_ID,
            Some(NODE_ID),
            Some(THIRD_ID),
            "Platform @Platform #Desktop",
            "release notes",
        );
        create_test_node(
            &mut connection,
            FIFTH_ID,
            Some(NODE_ID),
            Some(FOURTH_ID),
            "Note tag",
            "#Roadmap release notes",
        );
        create_test_node(
            &mut connection,
            SIXTH_ID,
            None,
            Some(NODE_ID),
            "Archived #Roadmap release",
            "",
        );
        archive_node(&mut connection, SIXTH_ID).expect("archive fixture");
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = CASE id \
                   WHEN ?1 THEN '2026-07-10T01:00:00.000Z' \
                   WHEN ?2 THEN '2026-07-10T04:00:00.000Z' \
                   WHEN ?3 THEN '2026-07-10T03:00:00.000Z' \
                   WHEN ?4 THEN '2026-07-10T02:00:00.000Z' \
                   ELSE '2026-07-10T00:00:00.000Z' END",
                params![CHILD_ID, THIRD_ID, FOURTH_ID, FIFTH_ID],
            )
            .expect("set deterministic search order");

        let mixed = search_nodes_structured(
            &connection,
            &structured_query(
                "release",
                vec![
                    search_tag(NoteTagPrefix::Hash, "roadmap"),
                    search_tag(NoteTagPrefix::Mention, "minji"),
                ],
                vec![search_tag(NoteTagPrefix::Hash, "blocked")],
                vec![],
            ),
        )
        .expect("mixed structured search");
        assert_eq!(mixed.len(), 1);
        assert_eq!(mixed[0].node_id, CHILD_ID);
        assert_eq!(mixed[0].parent_trail, vec!["Home"]);
        assert_eq!(mixed[0].matched_field, NoteSearchMatchedField::Title);

        let grouped = search_nodes_structured(
            &connection,
            &structured_query(
                "release notes",
                vec![],
                vec![],
                vec![vec![
                    search_tag(NoteTagPrefix::Hash, "desktop"),
                    search_tag(NoteTagPrefix::Mention, "platform"),
                ]],
            ),
        )
        .expect("OR group search");
        assert_eq!(
            grouped
                .iter()
                .map(|result| result.node_id.as_str())
                .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );

        let tag_only = search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Hash, "roadmap")],
                vec![],
                vec![],
            ),
        )
        .expect("tag-only search");
        assert_eq!(
            tag_only
                .iter()
                .map(|result| (result.node_id.as_str(), result.matched_field))
                .collect::<Vec<_>>(),
            vec![
                (THIRD_ID, NoteSearchMatchedField::Title),
                (FIFTH_ID, NoteSearchMatchedField::Note),
                (CHILD_ID, NoteSearchMatchedField::Title),
            ]
        );

        let exclusion_only = search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![],
                vec![search_tag(NoteTagPrefix::Hash, "blocked")],
                vec![],
            ),
        )
        .expect("exclusion-only search");
        assert_eq!(
            exclusion_only
                .iter()
                .map(|result| (result.node_id.as_str(), result.matched_field))
                .collect::<Vec<_>>(),
            vec![
                (FOURTH_ID, NoteSearchMatchedField::Title),
                (FIFTH_ID, NoteSearchMatchedField::Title),
                (CHILD_ID, NoteSearchMatchedField::Title),
                (NODE_ID, NoteSearchMatchedField::Title),
            ]
        );

        assert!(search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Mention, "roadmap")],
                vec![],
                vec![],
            )
        )
        .expect("prefix-distinct search")
        .is_empty());
        assert_eq!(
            search_nodes_structured(
                &connection,
                &structured_query(
                    "",
                    vec![search_tag(NoteTagPrefix::Hash, "x') OR 1=1 --")],
                    vec![],
                    vec![],
                )
            )
            .expect_err("invalid hostile tag"),
            "Structured Notes search tag normalizedTag must be a canonical tag body."
        );
    }

    fn indexed_search_tags(count: usize) -> Vec<NoteSearchTag> {
        (0..count)
            .map(|index| {
                search_tag(
                    if index % 2 == 0 {
                        NoteTagPrefix::Hash
                    } else {
                        NoteTagPrefix::Mention
                    },
                    &format!("tag-{index}"),
                )
            })
            .collect()
    }

    #[test]
    fn notes_tag_structured_search_enforces_utf8_text_byte_limit() {
        let connection = test_connection();
        let boundary_text = format!("{}a", "가".repeat(1365));
        assert_eq!(boundary_text.len(), 4096);
        assert!(search_nodes_structured(
            &connection,
            &structured_query(&boundary_text, vec![], vec![], vec![])
        )
        .expect("4096-byte structured search")
        .is_empty());

        let error = search_nodes_structured(
            &connection,
            &structured_query(&format!("{boundary_text}b"), vec![], vec![], vec![]),
        )
        .expect_err("4097-byte structured search");
        assert_eq!(
            error,
            "Structured Notes search text exceeds 4096 UTF-8 bytes."
        );
    }

    #[test]
    fn notes_tag_structured_search_enforces_total_unique_tag_limit_before_sql() {
        let connection = test_connection();
        let boundary_tags = indexed_search_tags(64);
        assert!(search_nodes_structured(
            &connection,
            &structured_query("", boundary_tags, vec![], vec![])
        )
        .expect("64 parameterized tag alternatives")
        .is_empty());

        connection
            .execute("DROP TABLE notes_tags", [])
            .expect("remove tag table before over-limit validation");
        let error = search_nodes_structured(
            &connection,
            &structured_query("", indexed_search_tags(65), vec![], vec![]),
        )
        .expect_err("65 unique tag alternatives");
        assert_eq!(
            error,
            "Structured Notes search has more than 64 unique tag alternatives."
        );
    }

    #[test]
    fn notes_tag_structured_search_enforces_raw_or_group_limit() {
        let connection = test_connection();
        let duplicate_group = vec![
            search_tag(NoteTagPrefix::Hash, "one"),
            search_tag(NoteTagPrefix::Mention, "two"),
        ];
        assert!(search_nodes_structured(
            &connection,
            &structured_query("", vec![], vec![], vec![duplicate_group.clone(); 16],)
        )
        .expect("16 OR groups")
        .is_empty());

        let error = search_nodes_structured(
            &connection,
            &structured_query("", vec![], vec![], vec![duplicate_group; 17]),
        )
        .expect_err("17 OR groups");
        assert_eq!(error, "Structured Notes search has more than 16 OR groups.");
    }

    #[test]
    fn notes_tag_structured_search_enforces_raw_alternatives_per_group_limit() {
        let connection = test_connection();
        let duplicate = search_tag(NoteTagPrefix::Hash, "duplicate");
        assert!(search_nodes_structured(
            &connection,
            &structured_query("", vec![], vec![], vec![vec![duplicate.clone(); 16]])
        )
        .expect("16 alternatives in one OR group")
        .is_empty());

        let error = search_nodes_structured(
            &connection,
            &structured_query("", vec![], vec![], vec![vec![duplicate; 17]]),
        )
        .expect_err("17 alternatives in one OR group");
        assert_eq!(
            error,
            "Structured Notes search OR group has more than 16 alternatives."
        );
    }

    #[test]
    fn notes_tag_structured_search_limits_tag_only_results_to_one_hundred() {
        let mut connection = test_connection();
        for index in 0..101 {
            let id = format!("00000000-0000-4000-8000-{index:012x}");
            create_test_node(&mut connection, &id, None, None, "#Bulk", "");
        }
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = '2026-07-10T00:00:00.000Z'",
                [],
            )
            .expect("set equal timestamps");

        let results = search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Hash, "bulk")],
                vec![],
                vec![],
            ),
        )
        .expect("limited tag search");

        assert_eq!(results.len(), 100);
        assert!(results
            .windows(2)
            .all(|pair| pair[0].node_id < pair[1].node_id));
    }

    #[test]
    fn notes_tag_lifecycle_rebuilds_exact_tags_and_cascades_empty_trash() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "#Left middle #Right",
            "",
        );
        split_node(
            &mut connection,
            SplitNodeInput {
                id: NODE_ID.to_string(),
                new_node_id: CHILD_ID.to_string(),
                prefix: "#Left".to_string(),
                suffix: "#Right".to_string(),
            },
        )
        .expect("split tagged node");
        assert_eq!(
            search_nodes_structured(
                &connection,
                &structured_query(
                    "",
                    vec![search_tag(NoteTagPrefix::Hash, "left")],
                    vec![],
                    vec![],
                )
            )
            .expect("left after split")
            .len(),
            1
        );
        assert_eq!(
            search_nodes_structured(
                &connection,
                &structured_query(
                    "",
                    vec![search_tag(NoteTagPrefix::Hash, "right")],
                    vec![],
                    vec![],
                )
            )
            .expect("right after split")
            .len(),
            1
        );

        let workspace = duplicate_node(&mut connection, NODE_ID).expect("duplicate tagged node");
        let duplicate_id = workspace
            .nodes
            .iter()
            .find(|node| node.id != NODE_ID && node.id != CHILD_ID && node.title == "#Left")
            .expect("duplicate tagged node")
            .id
            .clone();
        let left_query = structured_query(
            "",
            vec![search_tag(NoteTagPrefix::Hash, "left")],
            vec![],
            vec![],
        );
        assert_eq!(
            search_nodes_structured(&connection, &left_query)
                .unwrap()
                .len(),
            2
        );

        soft_delete_node(&mut connection, &duplicate_id).expect("trash duplicate");
        assert_eq!(
            search_nodes_structured(&connection, &left_query)
                .unwrap()
                .len(),
            1
        );
        let stored_while_trashed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_tags WHERE node_id = ?1",
                [&duplicate_id],
                |row| row.get(0),
            )
            .expect("trashed tags remain");
        assert_eq!(stored_while_trashed, 1);
        connection
            .execute(
                "UPDATE notes_tags SET tag = 'stale', normalized_tag = 'stale' \
                 WHERE node_id = ?1",
                [&duplicate_id],
            )
            .expect("seed stale trashed tag");

        restore_node(&mut connection, &duplicate_id).expect("restore duplicate");
        assert_eq!(
            search_nodes_structured(&connection, &left_query)
                .unwrap()
                .len(),
            2
        );
        assert!(search_nodes_structured(
            &connection,
            &structured_query(
                "",
                vec![search_tag(NoteTagPrefix::Hash, "stale")],
                vec![],
                vec![],
            )
        )
        .expect("stale tag after restore")
        .is_empty());
        archive_node(&mut connection, &duplicate_id).expect("archive duplicate");
        assert_eq!(
            search_nodes_structured(&connection, &left_query)
                .unwrap()
                .len(),
            1
        );
        unarchive_node(&mut connection, &duplicate_id).expect("unarchive duplicate");
        soft_delete_node(&mut connection, &duplicate_id).expect("trash duplicate again");
        empty_trash(&mut connection).expect("empty trash");
        let stored_after_empty: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_tags WHERE node_id = ?1",
                [&duplicate_id],
                |row| row.get(0),
            )
            .expect("cascaded tags");
        assert_eq!(stored_after_empty, 0);
    }

    #[test]
    fn starred_recent_tag_and_trash_scopes_are_disjoint() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "All", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "Starred",
            "",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(CHILD_ID),
            None,
            "Tagged #Élan",
            "",
        );
        create_test_node(
            &mut connection,
            FOURTH_ID,
            Some(NODE_ID),
            Some(CHILD_ID),
            "Trash #Hidden",
            "",
        );

        let workspace = toggle_star(&mut connection, CHILD_ID).expect("toggle star");
        assert!(
            workspace
                .nodes
                .iter()
                .find(|node| node.id == CHILD_ID)
                .expect("starred node")
                .is_starred
        );
        soft_delete_node(&mut connection, FOURTH_ID).expect("delete trash node");
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = CASE id \
                   WHEN ?1 THEN '2026-07-10T01:00:00.000Z' \
                   WHEN ?2 THEN '2026-07-10T02:00:00.000Z' \
                   WHEN ?3 THEN '2026-07-10T03:00:00.000Z' \
                   ELSE updated_at END",
                params![NODE_ID, CHILD_ID, THIRD_ID],
            )
            .expect("set deterministic recency");

        let starred =
            load_workspace(&connection, NotesWorkspaceScope::Starred).expect("starred workspace");
        assert_eq!(
            starred
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID]
        );
        let recent =
            load_workspace(&connection, NotesWorkspaceScope::Recent).expect("recent workspace");
        assert_eq!(
            recent
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID, THIRD_ID]
        );
        let tagged = load_workspace(
            &connection,
            NotesWorkspaceScope::Tag {
                tag: "#ÉLAN".to_string(),
            },
        )
        .expect("tag workspace");
        assert_eq!(
            tagged
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID, THIRD_ID]
        );
        let trash =
            load_workspace(&connection, NotesWorkspaceScope::Trash).expect("trash workspace");
        assert_eq!(
            trash
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );
        assert_eq!(trash.nodes[0].parent_id, None);
        assert_eq!(list_tags(&connection).expect("live tags"), vec!["élan"]);
    }

    #[test]
    fn legacy_tag_scope_uses_full_unicode_case_fold_identity() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "German #STRASSE", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            None,
            Some(NODE_ID),
            "ASCII #ff",
            "",
        );

        assert_eq!(
            load_workspace(
                &connection,
                NotesWorkspaceScope::Tag {
                    tag: "#Straße".to_string(),
                },
            )
            .expect("legacy sharp-s tag scope")
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
            vec![NODE_ID]
        );
        assert_eq!(
            load_workspace(
                &connection,
                NotesWorkspaceScope::Tag {
                    tag: "#ﬀ".to_string(),
                },
            )
            .expect("legacy ligature tag scope")
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
            vec![CHILD_ID]
        );
    }

    #[test]
    fn archive_marks_one_live_root_subtree_and_excludes_it_from_active_discovery() {
        let mut connection = test_connection();
        create_test_node(
            &mut connection,
            NODE_ID,
            None,
            None,
            "Archived target #Roadmap @Minji",
            "searchable archive detail",
        );
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "Starred child #Roadmap @Minji",
            "",
        );
        create_test_node(
            &mut connection,
            THIRD_ID,
            Some(CHILD_ID),
            None,
            "Grandchild",
            "",
        );
        create_test_node(
            &mut connection,
            FOURTH_ID,
            None,
            Some(NODE_ID),
            "Active #Roadmap @Minji",
            "",
        );
        toggle_star(&mut connection, CHILD_ID).expect("star child");

        let active = archive_node(&mut connection, NODE_ID).expect("archive root");

        assert_eq!(
            active
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );
        let archived =
            load_workspace(&connection, NotesWorkspaceScope::Archive).expect("archive workspace");
        assert_eq!(
            archived
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![NODE_ID, CHILD_ID, THIRD_ID]
        );
        let archived_at = archived.nodes[0]
            .archived_at
            .clone()
            .expect("archive timestamp");
        assert!(archived.nodes.iter().all(|node| {
            node.archived_at.as_deref() == Some(archived_at.as_str())
                && node.archive_root_id.as_deref() == Some(NODE_ID)
                && node.deleted_at.is_none()
        }));
        assert!(load_workspace(&connection, NotesWorkspaceScope::Starred)
            .expect("starred")
            .nodes
            .is_empty());
        assert_eq!(
            load_workspace(&connection, NotesWorkspaceScope::Recent)
                .expect("recent")
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );
        assert_eq!(
            load_workspace(
                &connection,
                NotesWorkspaceScope::Tag {
                    tag: "#roadmap".to_string()
                }
            )
            .expect("legacy tag")
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );
        assert_eq!(
            load_workspace(
                &connection,
                NotesWorkspaceScope::Tags {
                    tags: vec![
                        NoteTagFilter {
                            prefix: NoteTagPrefix::Hash,
                            normalized_tag: "roadmap".to_string(),
                        },
                        NoteTagFilter {
                            prefix: NoteTagPrefix::Mention,
                            normalized_tag: "minji".to_string(),
                        },
                    ]
                }
            )
            .expect("structured tags")
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
            vec![FOURTH_ID]
        );
        assert!(search_nodes(&connection, "searchable")
            .expect("search")
            .is_empty());
        assert!(load_workspace(&connection, NotesWorkspaceScope::Trash)
            .expect("trash")
            .nodes
            .is_empty());
        assert_eq!(
            list_tags_with_counts(&connection).expect("tag summaries"),
            vec![
                crate::notes::types::NoteTagSummary {
                    prefix: NoteTagPrefix::Hash,
                    normalized_tag: "roadmap".to_string(),
                    display_tag: "Roadmap".to_string(),
                    count: 1,
                },
                crate::notes::types::NoteTagSummary {
                    prefix: NoteTagPrefix::Mention,
                    normalized_tag: "minji".to_string(),
                    display_tag: "Minji".to_string(),
                    count: 1,
                },
            ]
        );
    }

    #[test]
    fn archive_rejects_non_roots_and_rolls_back_a_failed_subtree_update() {
        let mut connection = test_connection();
        insert_tree(&connection);
        let error = archive_node(&mut connection, CHILD_ID).expect_err("child archive");
        assert!(error.contains("root"));

        connection
            .execute_batch(&format!(
                "CREATE TRIGGER reject_archive_child \
                 BEFORE UPDATE OF archived_at ON notes_nodes \
                 WHEN OLD.id = '{CHILD_ID}' AND NEW.archived_at IS NOT NULL \
                 BEGIN SELECT RAISE(ABORT, 'archive child rejected'); END;"
            ))
            .expect("install archive failure");
        let error = archive_node(&mut connection, NODE_ID).expect_err("archive rollback");
        assert!(error.contains("archive child rejected"));
        let archived_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE archived_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("archived rows after rollback");
        assert_eq!(archived_count, 0);
    }

    #[test]
    fn unarchive_restores_the_original_root_position_and_archive_ownership_only() {
        let mut connection = test_connection();
        create_test_node(&mut connection, NODE_ID, None, None, "Archived root", "");
        create_test_node(
            &mut connection,
            CHILD_ID,
            Some(NODE_ID),
            None,
            "Archived child",
            "",
        );
        archive_node(&mut connection, NODE_ID).expect("archive root");
        create_test_node(
            &mut connection,
            THIRD_ID,
            None,
            None,
            "Replacement root",
            "",
        );

        let error = unarchive_node(&mut connection, CHILD_ID).expect_err("child unarchive");
        assert!(error.contains("archive root"));
        let active = unarchive_node(&mut connection, NODE_ID).expect("unarchive root");

        assert_eq!(
            active
                .nodes
                .iter()
                .filter(|node| node.parent_id.is_none())
                .map(|node| (node.id.as_str(), node.sort_key))
                .collect::<Vec<_>>(),
            vec![(NODE_ID, 1024), (THIRD_ID, 2048)]
        );
        assert!(active
            .nodes
            .iter()
            .filter(|node| { node.id == NODE_ID || node.id == CHILD_ID })
            .all(|node| node.archived_at.is_none() && node.archive_root_id.is_none()));
        assert!(load_workspace(&connection, NotesWorkspaceScope::Archive)
            .expect("archive")
            .nodes
            .is_empty());
    }

    #[test]
    fn moving_an_archived_root_to_trash_keeps_archive_and_trash_disjoint() {
        let mut connection = test_connection();
        insert_tree(&connection);
        archive_node(&mut connection, NODE_ID).expect("archive root");

        soft_delete_node(&mut connection, NODE_ID).expect("trash archived root");

        assert!(load_workspace(&connection, NotesWorkspaceScope::Archive)
            .expect("archive")
            .nodes
            .is_empty());
        let trash = load_workspace(&connection, NotesWorkspaceScope::Trash).expect("trash");
        assert_eq!(trash.nodes.len(), 2);
        assert!(trash.nodes.iter().all(|node| {
            node.deleted_at.is_some()
                && node.archived_at.is_none()
                && node.archive_root_id.is_none()
        }));
        let restored = restore_node(&mut connection, NODE_ID).expect("restore from trash");
        assert_eq!(restored.nodes.len(), 2);
        assert!(restored.nodes.iter().all(|node| {
            node.deleted_at.is_none()
                && node.archived_at.is_none()
                && node.archive_root_id.is_none()
        }));
    }

    #[test]
    fn archived_descendant_cannot_be_trashed_and_restored_as_an_active_root() {
        let mut connection = test_connection();
        insert_tree(&connection);
        archive_node(&mut connection, NODE_ID).expect("archive root");

        let error = soft_delete_node(&mut connection, CHILD_ID)
            .expect_err("archived descendant trash must be rejected");

        assert!(error.contains("archive root"));
        assert!(load_workspace(&connection, NotesWorkspaceScope::Trash)
            .expect("trash")
            .nodes
            .is_empty());
        assert!(restore_node(&mut connection, CHILD_ID)
            .expect_err("archived child was never trashed")
            .contains("not in the trash"));
        let active = unarchive_node(&mut connection, NODE_ID).expect("unarchive root");
        assert_eq!(active.nodes.len(), 2);
        assert_eq!(
            active
                .nodes
                .iter()
                .find(|node| node.id == CHILD_ID)
                .expect("restored child")
                .parent_id
                .as_deref(),
            Some(NODE_ID)
        );
    }

    #[test]
    fn recent_scope_limits_matches_but_keeps_an_older_live_ancestor() {
        let connection = test_connection();
        insert_node(&connection, NODE_ID, None, 1024, "older ancestor");
        insert_node(
            &connection,
            CHILD_ID,
            Some(NODE_ID),
            1024,
            "recent descendant",
        );
        insert_node(&connection, THIRD_ID, None, 2048, "older unrelated node");
        connection
            .execute(
                "UPDATE notes_nodes SET updated_at = CASE id \
                   WHEN ?1 THEN '2026-07-08T00:00:00.000Z' \
                   WHEN ?2 THEN '2026-07-10T00:00:00.999Z' \
                   WHEN ?3 THEN '2026-07-09T00:00:00.000Z' END \
                 WHERE id IN (?1, ?2, ?3)",
                params![NODE_ID, CHILD_ID, THIRD_ID],
            )
            .expect("set anchor recency");

        let mut recent_peer_ids = Vec::new();
        for index in 0..99 {
            let id = format!("{index:08x}-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
            insert_node(
                &connection,
                &id,
                None,
                i64::from(index + 3) * 1024,
                "recent peer",
            );
            connection
                .execute(
                    "UPDATE notes_nodes SET updated_at = ?1 WHERE id = ?2",
                    params![format!("2026-07-10T00:00:00.{:03}Z", index + 1), id],
                )
                .expect("set peer recency");
            recent_peer_ids.push(id);
        }

        let active =
            load_workspace(&connection, NotesWorkspaceScope::Active).expect("active workspace");
        let recent =
            load_workspace(&connection, NotesWorkspaceScope::Recent).expect("recent workspace");
        let recent_ids = recent
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(active.nodes.len(), 102);
        assert_eq!(recent.nodes.len(), 101);
        assert!(recent_ids.contains(&NODE_ID));
        assert!(recent_ids.contains(&CHILD_ID));
        assert!(!recent_ids.contains(&THIRD_ID));
        assert!(recent_peer_ids
            .iter()
            .all(|id| recent_ids.contains(&id.as_str())));
    }

    #[test]
    fn search_limits_results_to_one_hundred_nodes() {
        let connection = test_connection();
        for index in 0..101 {
            let id = format!("{index:08x}-1111-4111-8111-111111111111");
            insert_node(
                &connection,
                &id,
                None,
                i64::from(index + 1) * 1024,
                "limit-target",
            );
        }

        assert_eq!(
            search_nodes(&connection, "limit-target")
                .expect("limited search")
                .len(),
            100
        );
    }

    #[test]
    fn delete_database_removes_only_notes_owned_sqlite_files() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("vault path");
        let connection = connect_notes_db(vault_path).expect("connect notes");
        let notes_path = notes_db_path(vault_path);
        let metadata_path = notes_path.parent().expect("metadata path");
        let index_path = metadata_path.join("index.sqlite");
        let settings_path = metadata_path.join("settings.json");
        std::fs::write(&index_path, b"index").expect("write index fixture");
        std::fs::write(&settings_path, b"{}").expect("write metadata fixture");
        drop(connection);

        let wal_path = metadata_path.join("notes.sqlite-wal");
        let shm_path = metadata_path.join("notes.sqlite-shm");
        let journal_path = metadata_path.join("notes.sqlite-journal");
        std::fs::write(&wal_path, b"wal").expect("write WAL fixture");
        std::fs::write(&shm_path, b"shm").expect("write SHM fixture");
        std::fs::write(&journal_path, b"journal").expect("write journal fixture");

        delete_database(vault_path).expect("delete Notes database");
        delete_database(vault_path).expect("repeat missing Notes database deletion");

        assert!(!notes_path.exists());
        assert!(!wal_path.exists());
        assert!(!shm_path.exists());
        assert!(!journal_path.exists());
        assert_eq!(std::fs::read(index_path).expect("read index"), b"index");
        assert_eq!(std::fs::read(settings_path).expect("read settings"), b"{}");
        assert!(metadata_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn delete_database_rejects_metadata_relocation_before_deletion() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().join("vault");
        std::fs::create_dir(&vault_path).expect("create vault");
        let vault_path_string = vault_path.to_string_lossy().into_owned();
        let connection = connect_notes_db(&vault_path_string).expect("connect notes");
        drop(connection);

        let metadata = crate::metadata_dir(&vault_path_string);
        let held_metadata = vault_path.join("held-metadata");
        let attacker_metadata = vault_path.join("attacker-metadata");
        std::fs::create_dir(&attacker_metadata).expect("create attacker metadata");
        for name in [
            "notes.sqlite",
            "notes.sqlite-wal",
            "notes.sqlite-shm",
            "notes.sqlite-journal",
        ] {
            std::fs::write(metadata.join(name), format!("held {name}"))
                .expect("seed held database file");
            std::fs::write(attacker_metadata.join(name), format!("attacker {name}"))
                .expect("seed attacker database file");
        }

        let raced_metadata = metadata.clone();
        let raced_held = held_metadata.clone();
        let raced_attacker = attacker_metadata.clone();
        inject_delete_database_after_hold_once(move || {
            std::fs::rename(&raced_metadata, &raced_held).expect("relocate held metadata");
            symlink(&raced_attacker, &raced_metadata).expect("redirect metadata path");
        });

        let error = delete_database(&vault_path_string)
            .expect_err("metadata relocation must abort deletion");
        assert!(error.contains("metadata directory identity changed"));

        for name in [
            "notes.sqlite",
            "notes.sqlite-wal",
            "notes.sqlite-shm",
            "notes.sqlite-journal",
        ] {
            assert!(
                held_metadata.join(name).exists(),
                "held {name} must remain after the identity check fails"
            );
            assert_eq!(
                std::fs::read(attacker_metadata.join(name)).expect("read attacker file"),
                format!("attacker {name}").as_bytes(),
                "redirected {name} must remain untouched"
            );
        }
    }

    #[test]
    fn deleted_database_reinitializes_onboarding_without_changing_other_metadata() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_path = temp_dir.path().to_str().expect("vault path");
        let connection = connect_notes_db(vault_path).expect("connect notes");
        insert_node(&connection, NODE_ID, None, 1024, "stored note");

        let notes_path = notes_db_path(vault_path);
        let metadata_path = notes_path.parent().expect("metadata path");
        let index_path = metadata_path.join("index.sqlite");
        let settings_path = metadata_path.join("settings.json");
        std::fs::write(&index_path, b"index fixture").expect("write index fixture");
        std::fs::write(&settings_path, b"metadata fixture").expect("write metadata fixture");
        drop(connection);

        delete_database(vault_path).expect("delete Notes database");
        let reopened = connect_notes_db(vault_path).expect("reinitialize Notes database");
        let workspace =
            load_workspace(&reopened, NotesWorkspaceScope::Active).expect("load fresh workspace");

        assert_eq!(workspace.nodes.len(), 7);
        assert!(workspace.nodes.iter().any(|node| {
            node.parent_id.is_none() && node.title == "Yonalist Notes 시작하기"
        }));
        assert!(notes_path.exists());
        assert_eq!(
            std::fs::read(index_path).expect("read index fixture"),
            b"index fixture"
        );
        assert_eq!(
            std::fs::read(settings_path).expect("read metadata fixture"),
            b"metadata fixture"
        );
    }
}
