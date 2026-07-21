use crate::file_io::{
    capability_file_identity, capability_metadata_is_reparse_point,
    hold_capability_regular_file_bounded_nofollow, rename_noreplace,
};
use crate::notes::attachments::{AttachmentStorageLease, MAX_ATTACHMENT_BYTES};
use crate::notes::connection::{acquire_notes_connection, lock_notes_connection};
use crate::notes::error::{NotesError, NotesErrorCode};
use crate::notes::repository::validate_vault_path;
use crate::notes::types::NoteAttachment;
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
#[cfg(unix)]
use cap_std::fs::DirBuilderExt;
use cap_std::fs::{Dir, DirBuilder, OpenOptions};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const COPY_CHUNK_BYTES: usize = 1024 * 1024;
const STAGING_DIRECTORY_PREFIX: &str = ".asset-gc-staging-";
const RETIRED_DIRECTORY_PREFIX: &str = ".asset-gc-retired-";
const PRIVATE_ASSET_PAYLOAD: &str = "payload";
const PRIVATE_ASSET_PRESERVE_MARKER: &str = "preserve";

#[cfg(test)]
thread_local! {
    static INJECTED_SYNC_FAILURE_AFTER: std::cell::Cell<Option<usize>> = const {
        std::cell::Cell::new(None)
    };
    static INJECTED_BEFORE_OWNED_FILE_REMOVE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECT_COPY_ABORT_AFTER_WRITE: std::cell::Cell<bool> = const {
        std::cell::Cell::new(false)
    };
    static INJECTED_BEFORE_OWNED_FILE_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_OWNED_FILE_READ: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_GC_FILE_MUTATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_AFTER_GC_FILE_MUTATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_GC_ROW_DELETE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECTED_BEFORE_ISOLATED_RESTORE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECT_ISOLATED_DELETE_FAILURE: std::cell::Cell<bool> = const {
        std::cell::Cell::new(false)
    };
}

#[cfg(test)]
fn inject_sync_failure_after(successful_calls: usize) {
    INJECTED_SYNC_FAILURE_AFTER.with(|remaining| remaining.set(Some(successful_calls)));
}

#[cfg(test)]
fn maybe_inject_sync_failure() -> Result<(), String> {
    INJECTED_SYNC_FAILURE_AFTER.with(|remaining| match remaining.get() {
        Some(0) => {
            remaining.set(None);
            Err("Injected Notes asset directory sync failure.".to_string())
        }
        Some(calls) => {
            remaining.set(Some(calls - 1));
            Ok(())
        }
        None => Ok(()),
    })
}

#[cfg(test)]
fn inject_before_owned_file_remove_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_OWNED_FILE_REMOVE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_owned_file_remove() {
    INJECTED_BEFORE_OWNED_FILE_REMOVE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_owned_file_remove() {}

#[cfg(test)]
fn inject_copy_abort_after_write_once() {
    INJECT_COPY_ABORT_AFTER_WRITE.with(|injected| injected.set(true));
}

#[cfg(test)]
fn maybe_inject_copy_abort_after_write() {
    INJECT_COPY_ABORT_AFTER_WRITE.with(|injected| {
        if injected.replace(false) {
            panic!("Injected abrupt Notes asset copy termination.");
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_copy_abort_after_write() {}

#[cfg(test)]
fn inject_before_owned_file_open_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_OWNED_FILE_OPEN.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_owned_file_open() {
    INJECTED_BEFORE_OWNED_FILE_OPEN.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_owned_file_open() {}

#[cfg(test)]
fn inject_before_owned_file_read_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_OWNED_FILE_READ.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_owned_file_read() {
    INJECTED_BEFORE_OWNED_FILE_READ.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_owned_file_read() {}

#[cfg(test)]
fn inject_before_gc_file_mutation_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_GC_FILE_MUTATION.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_gc_file_mutation() {
    INJECTED_BEFORE_GC_FILE_MUTATION.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_gc_file_mutation() {}

#[cfg(test)]
fn inject_after_gc_file_mutation_once(action: impl FnOnce() + 'static) {
    INJECTED_AFTER_GC_FILE_MUTATION.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_after_gc_file_mutation() {
    INJECTED_AFTER_GC_FILE_MUTATION.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_after_gc_file_mutation() {}

#[cfg(test)]
fn inject_before_gc_row_delete_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_GC_ROW_DELETE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_gc_row_delete() {
    INJECTED_BEFORE_GC_ROW_DELETE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_gc_row_delete() {}

#[cfg(test)]
fn inject_before_isolated_restore_once(action: impl FnOnce() + 'static) {
    INJECTED_BEFORE_ISOLATED_RESTORE.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_before_isolated_restore() {
    INJECTED_BEFORE_ISOLATED_RESTORE.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_before_isolated_restore() {}

#[cfg(test)]
fn inject_isolated_delete_failure_once() {
    INJECT_ISOLATED_DELETE_FAILURE.with(|injected| injected.set(true));
}

#[cfg(test)]
fn maybe_inject_isolated_delete_failure() -> Result<(), String> {
    INJECT_ISOLATED_DELETE_FAILURE.with(|injected| {
        if injected.replace(false) {
            Err("Injected isolated Notes asset delete failure.".to_string())
        } else {
            Ok(())
        }
    })
}

#[cfg(not(test))]
fn maybe_inject_isolated_delete_failure() -> Result<(), String> {
    Ok(())
}

#[cfg(not(test))]
fn maybe_inject_sync_failure() -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AssetGcConfig {
    pub(crate) asset_trash_retention_days: u16,
    pub(crate) asset_trash_large_file_days: u16,
    pub(crate) asset_large_file_threshold_mb: u16,
}

impl Default for AssetGcConfig {
    fn default() -> Self {
        Self {
            asset_trash_retention_days: 7,
            asset_trash_large_file_days: 2,
            asset_large_file_threshold_mb: 5,
        }
    }
}

impl AssetGcConfig {
    pub(crate) fn validate(self) -> Result<Self, String> {
        if self.asset_trash_retention_days > 365
            || self.asset_trash_large_file_days > 365
            || self.asset_large_file_threshold_mb > 365
        {
            return Err("Notes asset GC settings must be integers between 0 and 365.".to_string());
        }
        Ok(self)
    }

    fn retention_days(self, byte_size: u64) -> u16 {
        let threshold = u64::from(self.asset_large_file_threshold_mb) * 1024 * 1024;
        if byte_size >= threshold {
            self.asset_trash_large_file_days
        } else {
            self.asset_trash_retention_days
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PurgeReport {
    pub(crate) count: u32,
    pub(crate) total_bytes: u64,
}

#[derive(Clone, Default)]
pub(crate) struct AssetPurgePreviewState(Arc<Mutex<HashMap<String, String>>>);

#[derive(Debug, Clone)]
struct AssetFile {
    content_hash: String,
    extension: String,
    name: PathBuf,
    byte_size: u64,
}

fn parse_asset_name(name: &Path) -> Option<(String, String)> {
    let name = name.to_str()?;
    let (content_hash, extension) = name.split_once('.')?;
    if content_hash.len() != 64
        || !content_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        || !matches!(extension, "png" | "jpg" | "webp" | "gif")
    {
        return None;
    }
    Some((content_hash.to_string(), extension.to_string()))
}

fn list_assets(directory: &Dir) -> Result<Vec<AssetFile>, String> {
    let mut assets = Vec::new();
    for entry in directory
        .entries()
        .map_err(|error| format!("Could not inspect Notes assets: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not inspect a Notes asset: {error}"))?;
        let name = PathBuf::from(entry.file_name());
        let Some((content_hash, extension)) = parse_asset_name(&name) else {
            continue;
        };
        let metadata = directory
            .symlink_metadata(&name)
            .map_err(|error| format!("Could not inspect Notes asset {name:?}: {error}"))?;
        if !metadata.is_file() || metadata.is_symlink() || metadata.nlink() != 1 {
            return Err(format!(
                "The Notes asset {name:?} must be an owned regular file."
            ));
        }
        assets.push(AssetFile {
            content_hash,
            extension,
            name,
            byte_size: metadata.len(),
        });
    }
    assets.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(assets)
}

fn has_references(connection: &Connection, content_hash: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_attachments WHERE content_hash = ?1)",
            [content_hash],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not derive the Notes asset refcount: {error}"))
}

fn path_exists(directory: &Dir, name: &Path) -> Result<bool, String> {
    match directory.symlink_metadata(name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not inspect Notes asset {name:?}: {error}")),
    }
}

fn owned_file_matches_hash(
    directory: &Dir,
    name: &Path,
    expected_hash: &str,
) -> Result<bool, String> {
    maybe_inject_before_owned_file_open();
    let held = hold_capability_regular_file_bounded_nofollow(directory, name, MAX_ATTACHMENT_BYTES)
        .map_err(|error| format!("Could not securely open Notes asset {name:?}: {error}"))?;
    let metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {name:?}: {error}"))?;
    if metadata.nlink() != 1 {
        return Err(format!(
            "The Notes asset {name:?} must be an owned regular file."
        ));
    }
    maybe_inject_before_owned_file_read();
    let mut file = held
        .reader_from_start()
        .map_err(|error| format!("Could not retain Notes asset {name:?}: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_CHUNK_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash Notes asset {name:?}: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    held.verify_at(directory, name).map_err(|error| {
        format!("The Notes asset {name:?} changed while it was hashed: {error}")
    })?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        == expected_hash)
}

#[cfg(unix)]
fn sync_directory(directory: &Dir) -> Result<(), String> {
    maybe_inject_sync_failure()?;
    directory
        .try_clone()
        .and_then(|directory| directory.into_std_file().sync_all())
        .map_err(|error| format!("Could not sync a Notes asset directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Dir) -> Result<(), String> {
    maybe_inject_sync_failure()?;
    Ok(())
}

fn validate_private_directory_security(
    name: &Path,
    metadata: &cap_std::fs::Metadata,
) -> Result<(), String> {
    if capability_metadata_is_reparse_point(metadata) || !metadata.is_dir() {
        return Err(format!(
            "The private Notes asset directory {name:?} must be an owned directory."
        ));
    }
    #[cfg(unix)]
    if cap_std::fs::MetadataExt::uid(metadata) != rustix::process::geteuid().as_raw()
        || cap_std::fs::MetadataExt::mode(metadata) & 0o777 != 0o700
    {
        return Err(format!(
            "The private Notes asset directory {name:?} must be private to its owner."
        ));
    }
    Ok(())
}

fn create_private_directory(
    parent: &Dir,
    prefix: &str,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(Dir, PathBuf, (u64, u64)), String> {
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    for _ in 0..128 {
        let name = PathBuf::from(format!("{prefix}{}", Uuid::new_v4()));
        validate_directories()?;
        match parent.create_dir_with(&name, &builder) {
            Ok(()) => {
                validate_directories()?;
                let directory = parent.open_dir_nofollow(&name).map_err(|error| {
                    format!("Could not hold private Notes asset directory {name:?}: {error}")
                })?;
                let metadata = directory.dir_metadata().map_err(|error| {
                    format!("Could not inspect private Notes asset directory {name:?}: {error}")
                })?;
                validate_private_directory_security(&name, &metadata)?;
                let identity = capability_file_identity(&metadata).map_err(|error| {
                    format!("Could not identify private Notes asset directory {name:?}: {error}")
                })?;
                revalidate_private_directory(parent, &name, identity)?;
                return Ok((directory, name, identity));
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create the private Notes asset directory {name:?}: {error}"
                ))
            }
        }
    }
    Err("Could not allocate a private Notes asset directory.".to_string())
}

fn revalidate_private_directory(
    parent: &Dir,
    name: &Path,
    identity: (u64, u64),
) -> Result<(), String> {
    let current_directory = parent.open_dir_nofollow(name).map_err(|error| {
        format!("Could not revalidate private Notes asset directory {name:?}: {error}")
    })?;
    let current = current_directory.dir_metadata().map_err(|error| {
        format!("Could not inspect private Notes asset directory {name:?}: {error}")
    })?;
    validate_private_directory_security(name, &current)?;
    if capability_file_identity(&current).map_err(|error| {
        format!("Could not identify private Notes asset directory {name:?}: {error}")
    })? != identity
    {
        return Err(format!(
            "The private Notes asset directory {name:?} identity changed."
        ));
    }
    Ok(())
}

fn is_private_directory_name(name: &Path) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    [STAGING_DIRECTORY_PREFIX, RETIRED_DIRECTORY_PREFIX]
        .into_iter()
        .find_map(|prefix| name.strip_prefix(prefix))
        .is_some_and(|suffix| Uuid::parse_str(suffix).is_ok())
}

fn remove_private_directory(
    parent: &Dir,
    name: &Path,
    directory: Dir,
    identity: (u64, u64),
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    revalidate_private_directory(parent, name, identity)?;
    sync_directory(&directory)?;
    validate_directories()?;
    drop(directory);
    parent.remove_dir(name).map_err(|error| {
        format!("Could not remove private Notes asset directory {name:?}: {error}")
    })?;
    validate_directories()?;
    sync_directory(parent)
}

fn cleanup_private_directories_with_validation(
    parent: &Dir,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let mut names = parent
        .entries()
        .map_err(|error| format!("Could not inspect private Notes asset recovery: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| PathBuf::from(entry.file_name()))
                .map_err(|error| format!("Could not inspect a private Notes asset entry: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    for name in names
        .into_iter()
        .filter(|name| is_private_directory_name(name))
    {
        let directory = parent.open_dir_nofollow(&name).map_err(|error| {
            format!("Could not recover private Notes asset directory {name:?}: {error}")
        })?;
        let metadata = directory.dir_metadata().map_err(|error| {
            format!("Could not inspect private Notes asset directory {name:?}: {error}")
        })?;
        validate_private_directory_security(&name, &metadata)?;
        let identity = capability_file_identity(&metadata).map_err(|error| {
            format!("Could not identify private Notes asset directory {name:?}: {error}")
        })?;
        revalidate_private_directory(parent, &name, identity)?;
        let entries = directory
            .entries()
            .map_err(|error| format!("Could not inspect private Notes asset payload: {error}"))?
            .map(|entry| {
                entry
                    .map(|entry| PathBuf::from(entry.file_name()))
                    .map_err(|error| {
                        format!("Could not inspect private Notes asset payload: {error}")
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if entries
            .iter()
            .any(|entry| entry == Path::new(PRIVATE_ASSET_PRESERVE_MARKER))
        {
            continue;
        }
        for entry in entries {
            if entry != Path::new(PRIVATE_ASSET_PAYLOAD) {
                return Err(format!(
                    "The private Notes asset directory {name:?} contains an unexpected entry."
                ));
            }
            let held = hold_capability_regular_file_bounded_nofollow(
                &directory,
                &entry,
                MAX_ATTACHMENT_BYTES,
            )
            .map_err(|error| format!("Could not recover private Notes asset payload: {error}"))?;
            let payload_metadata = held.metadata().map_err(|error| {
                format!("Could not inspect private Notes asset payload: {error}")
            })?;
            if payload_metadata.nlink() != 1 {
                return Err(
                    "A private Notes asset payload must be an owned regular file.".to_string(),
                );
            }
            held.verify_at(&directory, &entry).map_err(|error| {
                format!("The private Notes asset payload changed during recovery: {error}")
            })?;
            validate_directories()?;
            directory.remove_file(&entry).map_err(|error| {
                format!("Could not recover private Notes asset payload: {error}")
            })?;
            validate_directories()?;
        }
        remove_private_directory(parent, &name, directory, identity, validate_directories)?;
    }
    Ok(())
}

fn copy_owned_asset_with_validation(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
    retire_source: bool,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    validate_directories()?;
    cleanup_private_directories_with_validation(to_parent, validate_directories)?;
    validate_directories()?;
    let held_source =
        hold_capability_regular_file_bounded_nofollow(from_parent, from, MAX_ATTACHMENT_BYTES)
            .map_err(|error| format!("Could not securely open Notes asset {from:?}: {error}"))?;
    let source_metadata = held_source
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {from:?}: {error}"))?;
    if source_metadata.nlink() != 1 {
        return Err(format!(
            "The Notes asset {from:?} must be an owned regular file."
        ));
    }
    let source_byte_size = held_source.byte_size();
    let mut source = held_source
        .reader_from_start()
        .map_err(|error| format!("Could not retain Notes asset {from:?}: {error}"))?;
    validate_directories()?;
    let (staging, staging_directory_name, staging_identity) =
        create_private_directory(to_parent, STAGING_DIRECTORY_PREFIX, validate_directories)?;
    validate_directories()?;
    let staging_name = PathBuf::from(PRIVATE_ASSET_PAYLOAD);
    let mut write_options = OpenOptions::new();
    write_options
        .read(true)
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    validate_directories()?;
    let mut destination = staging
        .open_with(&staging_name, &write_options)
        .map_err(|error| format!("Could not create staged Notes asset {to:?}: {error}"))?;
    validate_directories()?;
    let destination_metadata = destination
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {to:?}: {error}"))?;
    let destination_identity = capability_file_identity(&destination_metadata)
        .map_err(|error| format!("Could not identify staged Notes asset {to:?}: {error}"))?;
    let copy_result = (|| {
        let mut buffer = vec![0_u8; COPY_CHUNK_BYTES];
        let mut copied = 0_u64;
        let mut copied_hash = Sha256::new();
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| format!("Could not read Notes asset {from:?}: {error}"))?;
            if read == 0 {
                break;
            }
            copied = copied
                .checked_add(
                    u64::try_from(read)
                        .map_err(|_| "The Notes asset copy byte count overflowed.".to_string())?,
                )
                .ok_or_else(|| "The Notes asset copy byte count overflowed.".to_string())?;
            if copied > source_byte_size {
                return Err(format!(
                    "The Notes asset {from:?} changed while it was copied."
                ));
            }
            copied_hash.update(&buffer[..read]);
            destination
                .write_all(&buffer[..read])
                .map_err(|error| format!("Could not copy Notes asset {to:?}: {error}"))?;
            maybe_inject_copy_abort_after_write();
        }
        if copied != source_byte_size
            || copied_hash
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
                != expected_hash
        {
            return Err(format!(
                "The Notes asset {from:?} does not match its content hash."
            ));
        }
        destination
            .sync_all()
            .map_err(|error| format!("Could not sync Notes asset {to:?}: {error}"))?;
        destination
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("Could not seek Notes asset {to:?}: {error}"))?;
        let mut destination_hash = Sha256::new();
        let mut destination_bytes = 0_u64;
        loop {
            let read = destination
                .read(&mut buffer)
                .map_err(|error| format!("Could not verify Notes asset {to:?}: {error}"))?;
            if read == 0 {
                break;
            }
            destination_bytes = destination_bytes
                .checked_add(u64::try_from(read).map_err(|_| {
                    "The Notes asset verification byte count overflowed.".to_string()
                })?)
                .ok_or_else(|| "The Notes asset verification byte count overflowed.".to_string())?;
            if destination_bytes > source_byte_size {
                return Err(format!(
                    "The copied Notes asset {to:?} exceeds its verified byte size."
                ));
            }
            destination_hash.update(&buffer[..read]);
        }
        if destination_bytes != source_byte_size
            || destination_hash
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
                != expected_hash
        {
            return Err(format!(
                "The copied Notes asset {to:?} does not match its content hash."
            ));
        }
        source = held_source
            .reader_from_start()
            .map_err(|error| format!("Could not re-open Notes asset {from:?}: {error}"))?;
        let mut source_hash = Sha256::new();
        let mut observed = 0_u64;
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| format!("Could not re-read Notes asset {from:?}: {error}"))?;
            if read == 0 {
                break;
            }
            observed = observed
                .checked_add(u64::try_from(read).map_err(|_| {
                    "The Notes asset verification byte count overflowed.".to_string()
                })?)
                .ok_or_else(|| "The Notes asset verification byte count overflowed.".to_string())?;
            source_hash.update(&buffer[..read]);
        }
        if observed != source_byte_size
            || source_hash
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
                != expected_hash
        {
            return Err(format!(
                "The Notes asset {from:?} changed while it was copied."
            ));
        }
        held_source.verify_at(from_parent, from).map_err(|error| {
            format!("The Notes asset {from:?} changed while it was moved: {error}")
        })?;
        let destination_path_metadata = staging
            .symlink_metadata(&staging_name)
            .map_err(|error| format!("Could not revalidate staged Notes asset {to:?}: {error}"))?;
        if !destination_path_metadata.is_file()
            || destination_path_metadata.nlink() != 1
            || destination_path_metadata.len() != source_byte_size
            || capability_file_identity(&destination_path_metadata)
                .map_err(|error| format!("Could not identify staged Notes asset {to:?}: {error}"))?
                != destination_identity
        {
            return Err(format!(
                "The staged Notes asset {to:?} changed while it was copied."
            ));
        }
        revalidate_private_directory(to_parent, &staging_directory_name, staging_identity)?;
        sync_directory(&staging)?;
        drop(destination);
        validate_directories()?;
        let published_staged = match rename_noreplace(&staging, &staging_name, to_parent, to) {
            Ok(()) => {
                validate_directories()?;
                true
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if !owned_file_matches_hash(to_parent, to, expected_hash)? {
                    return Err(format!(
                        "The existing published Notes asset {to:?} does not match its content hash."
                    ));
                }
                validate_directories()?;
                staging.remove_file(&staging_name).map_err(|remove_error| {
                    format!("Could not discard staged Notes asset {to:?}: {remove_error}")
                })?;
                validate_directories()?;
                false
            }
            Err(error) => {
                return Err(format!(
                    "Could not publish copied Notes asset {to:?} atomically: {error}"
                ))
            }
        };
        let published_metadata = to_parent.symlink_metadata(to).map_err(|error| {
            format!("Could not revalidate published Notes asset {to:?}: {error}")
        })?;
        if !published_metadata.is_file()
            || published_metadata.nlink() != 1
            || published_metadata.len() != source_byte_size
            || (published_staged
                && capability_file_identity(&published_metadata).map_err(|error| {
                    format!("Could not identify published Notes asset {to:?}: {error}")
                })? != destination_identity)
            || (!published_staged && !owned_file_matches_hash(to_parent, to, expected_hash)?)
        {
            return Err(format!(
                "The published Notes asset {to:?} changed after its atomic publication."
            ));
        }
        validate_directories()?;
        remove_private_directory(
            to_parent,
            &staging_directory_name,
            staging,
            staging_identity,
            validate_directories,
        )?;
        validate_directories()?;
        sync_directory(to_parent)?;
        if retire_source {
            remove_owned_file_with_validation(from_parent, from, validate_directories)?;
        }
        Ok(())
    })();
    if let Err(error) = copy_result {
        validate_directories()?;
        return match cleanup_private_directories_with_validation(to_parent, validate_directories) {
            Ok(()) => {
                validate_directories()?;
                Err(error)
            }
            Err(cleanup_error) => Err(format!(
                "{error} Private Notes asset cleanup also failed: {cleanup_error}"
            )),
        };
    }
    Ok(())
}

fn copy_owned_asset(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
    retire_source: bool,
) -> Result<(), String> {
    copy_owned_asset_with_validation(
        from_parent,
        from,
        to_parent,
        to,
        expected_hash,
        retire_source,
        &mut || Ok(()),
    )
}

fn copy_then_remove(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
) -> Result<(), String> {
    copy_owned_asset(from_parent, from, to_parent, to, expected_hash, true)
}

fn move_noreplace_with_validation(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    validate_directories()?;
    match rename_noreplace(from_parent, from, to_parent, to) {
        Ok(()) => {
            validate_directories()?;
            sync_directory(from_parent)?;
            sync_directory(to_parent)
        }
        Err(error) if error.kind() == ErrorKind::CrossesDevices => {
            copy_owned_asset_with_validation(
                from_parent,
                from,
                to_parent,
                to,
                expected_hash,
                true,
                validate_directories,
            )
        }
        Err(error) => Err(format!("Could not move Notes asset {from:?}: {error}")),
    }
}

fn restore_verified_trash_asset(
    trash: &Dir,
    assets: &Dir,
    name: &Path,
    expected_hash: &str,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    if !owned_file_matches_hash(trash, name, expected_hash)? {
        return Err(format!(
            "The quarantined Notes asset {name:?} did not match its content hash."
        ));
    }
    validate_directories()?;
    copy_owned_asset_with_validation(
        trash,
        name,
        assets,
        name,
        expected_hash,
        false,
        validate_directories,
    )?;
    validate_directories()?;
    match owned_file_matches_hash(assets, name, expected_hash) {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!(
            "The restored Notes asset {name:?} did not match its content hash; the trash backup was preserved."
        )),
        Err(error) => Err(format!(
            "Could not verify the restored Notes asset {name:?}: {error} The trash backup was preserved."
        )),
    }
}

pub(crate) fn retain_reconciliation_asset(
    connection: &Connection,
    assets: &Dir,
    quarantined_name: &Path,
    trash: &Dir,
    canonical_name: &Path,
    expected_hash: &str,
    byte_size: u64,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    validate_directories()?;
    let (parsed_hash, extension) = parse_asset_name(canonical_name)
        .ok_or_else(|| "A retained Notes asset must have a canonical file name.".to_string())?;
    if parsed_hash != expected_hash {
        return Err("A retained Notes asset file name did not match its content hash.".to_string());
    }
    let source_matches = owned_file_matches_hash(assets, quarantined_name, expected_hash)?;
    if path_exists(trash, canonical_name)? {
        if !source_matches || !owned_file_matches_hash(trash, canonical_name, expected_hash)? {
            return Err(format!(
                "The retained Notes asset {canonical_name:?} conflicts with bytes that do not match its content hash; both files were preserved."
            ));
        }
    } else if !source_matches {
        return Ok(());
    } else {
        validate_directories()?;
        copy_owned_asset_with_validation(
            assets,
            quarantined_name,
            trash,
            canonical_name,
            expected_hash,
            false,
            validate_directories,
        )?;
        validate_directories()?;
    }
    let retention_days = AssetGcConfig::default().retention_days(byte_size);
    let byte_size = i64::try_from(byte_size)
        .map_err(|_| "The retained Notes asset byte size is too large.".to_string())?;
    validate_directories()?;
    connection
        .execute(
            "INSERT INTO asset_trash(content_hash, extension, byte_size, quarantined_at, delete_after) \
             VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d days', ?4))) \
             ON CONFLICT(content_hash) DO NOTHING",
            params![expected_hash, extension, byte_size, retention_days],
        )
        .map_err(|error| format!("Could not retain a reconciled Notes asset: {error}"))?;
    validate_directories()
}

fn replay_asset_name(attachment: &NoteAttachment) -> Result<PathBuf, String> {
    let expected_extension = match attachment.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return Err("A replayed Notes attachment has an unsupported MIME type.".to_string()),
    };
    let expected_name = format!("{}.{}", attachment.content_hash, expected_extension);
    if attachment.relative_path != format!("notes-assets/{expected_name}")
        || parse_asset_name(Path::new(&expected_name))
            != Some((
                attachment.content_hash.clone(),
                expected_extension.to_string(),
            ))
    {
        return Err("A replayed Notes attachment has an unsafe owned path.".to_string());
    }
    Ok(PathBuf::from(expected_name))
}

pub(crate) fn validate_attachment_for_replay(
    storage: &AttachmentStorageLease,
    attachment: &NoteAttachment,
) -> Result<(), String> {
    let name = replay_asset_name(attachment)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    storage.validate_asset_gc_directories(&assets, &trash)?;
    let live_exists = path_exists(&assets, &name)?;
    let trash_exists = path_exists(&trash, &name)?;
    if live_exists {
        if !owned_file_matches_hash(&assets, &name, &attachment.content_hash)? {
            return Err(format!(
                "The live Notes asset {name:?} did not match its content hash; replay preserved all copies."
            ));
        }
        if trash_exists {
            if !owned_file_matches_hash(&trash, &name, &attachment.content_hash)? {
                return Err(format!(
                    "The quarantined Notes asset {name:?} did not match its content hash; replay preserved all copies."
                ));
            }
        }
    } else if trash_exists {
        if !owned_file_matches_hash(&trash, &name, &attachment.content_hash)? {
            return Err(format!(
                "The quarantined Notes asset {name:?} did not match its content hash."
            ));
        }
    } else {
        return Err(format!(
            "The Notes attachment asset {name:?} is missing from live storage and trash."
        ));
    }
    storage.validate_asset_gc_directories(&assets, &trash)
}

pub(crate) fn restore_attachment_for_replay(
    connection: &Connection,
    storage: &AttachmentStorageLease,
    attachment: &NoteAttachment,
) -> Result<bool, String> {
    let name = replay_asset_name(attachment)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    storage.validate_asset_gc_directories(&assets, &trash)?;
    let live_exists = path_exists(&assets, &name)?;
    let trash_exists = path_exists(&trash, &name)?;
    let created_live = if live_exists {
        if !owned_file_matches_hash(&assets, &name, &attachment.content_hash)? {
            return Err(format!(
                "The live Notes asset {name:?} did not match its content hash; replay preserved all copies."
            ));
        }
        if trash_exists && !owned_file_matches_hash(&trash, &name, &attachment.content_hash)? {
            return Err(format!(
                "The quarantined Notes asset {name:?} did not match its content hash; replay preserved all copies."
            ));
        }
        false
    } else if trash_exists {
        if !owned_file_matches_hash(&trash, &name, &attachment.content_hash)? {
            return Err(format!(
                "The quarantined Notes asset {name:?} did not match its content hash."
            ));
        }
        storage.validate_asset_gc_directories(&assets, &trash)?;
        copy_owned_asset_with_validation(
            &trash,
            &name,
            &assets,
            &name,
            &attachment.content_hash,
            false,
            &mut || storage.validate_asset_gc_directories(&assets, &trash),
        )?;
        storage.validate_asset_gc_directories(&assets, &trash)?;
        if !owned_file_matches_hash(&assets, &name, &attachment.content_hash)? {
            return Err(format!(
                "The staged Notes replay asset {name:?} did not match its content hash."
            ));
        }
        true
    } else {
        return Err(format!(
            "The Notes attachment asset {name:?} is missing from live storage and trash."
        ));
    };
    storage.validate_asset_gc_directories(&assets, &trash)?;
    if let Err(error) = connection
        .execute(
            "DELETE FROM asset_trash WHERE content_hash = ?1",
            [&attachment.content_hash],
        )
        .map_err(|error| format!("Could not clear replayed Notes asset trash: {error}"))
    {
        if created_live && owned_file_matches_hash(&assets, &name, &attachment.content_hash)? {
            storage.validate_asset_gc_directories(&assets, &trash)?;
            remove_owned_file_with_validation(&assets, &name, &mut || {
                storage.validate_asset_gc_directories(&assets, &trash)
            })?;
            storage.validate_asset_gc_directories(&assets, &trash)?;
        }
        return Err(error);
    }
    storage.validate_asset_gc_directories(&assets, &trash)?;
    Ok(created_live)
}

pub(crate) fn rollback_attachment_for_replay(
    storage: &AttachmentStorageLease,
    attachment: &NoteAttachment,
    created_live: bool,
) -> Result<(), String> {
    if !created_live {
        return Ok(());
    }
    let name = replay_asset_name(attachment)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    storage.validate_asset_gc_directories(&assets, &trash)?;
    if !path_exists(&assets, &name)? {
        return Ok(());
    }
    if !owned_file_matches_hash(&assets, &name, &attachment.content_hash)? {
        return Err(format!(
            "The staged Notes replay asset {name:?} changed before rollback; it was preserved."
        ));
    }
    storage.validate_asset_gc_directories(&assets, &trash)?;
    remove_owned_file_with_validation(&assets, &name, &mut || {
        storage.validate_asset_gc_directories(&assets, &trash)
    })?;
    storage.validate_asset_gc_directories(&assets, &trash)
}

pub(crate) fn finalize_attachment_for_replay(
    storage: &AttachmentStorageLease,
    attachment: &NoteAttachment,
) -> Result<(), String> {
    let name = replay_asset_name(attachment)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    storage.validate_asset_gc_directories(&assets, &trash)?;
    if !path_exists(&trash, &name)? {
        return Ok(());
    }
    if !path_exists(&assets, &name)?
        || !owned_file_matches_hash(&assets, &name, &attachment.content_hash)?
        || !owned_file_matches_hash(&trash, &name, &attachment.content_hash)?
    {
        return Err(format!(
            "The replayed Notes asset {name:?} could not retire its trash backup; both copies were preserved."
        ));
    }
    storage.validate_asset_gc_directories(&assets, &trash)?;
    remove_owned_file_with_validation(&trash, &name, &mut || {
        storage.validate_asset_gc_directories(&assets, &trash)
    })?;
    storage.validate_asset_gc_directories(&assets, &trash)
}

fn remove_owned_file_with_validation(
    directory: &Dir,
    name: &Path,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    validate_directories()?;
    cleanup_private_directories_with_validation(directory, validate_directories)?;
    validate_directories()?;
    let held = hold_capability_regular_file_bounded_nofollow(directory, name, MAX_ATTACHMENT_BYTES)
        .map_err(|error| format!("Could not securely open Notes asset {name:?}: {error}"))?;
    let metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {name:?}: {error}"))?;
    if metadata.nlink() != 1 {
        return Err(format!(
            "The Notes asset {name:?} must be an owned regular file."
        ));
    }
    held.verify_at(directory, name)
        .map_err(|error| format!("The Notes asset {name:?} changed before deletion: {error}"))?;
    maybe_inject_before_owned_file_remove();
    validate_directories()?;
    let (retired, retired_directory_name, retired_identity) =
        create_private_directory(directory, RETIRED_DIRECTORY_PREFIX, validate_directories)?;
    validate_directories()?;
    let retired_name = PathBuf::from(PRIVATE_ASSET_PAYLOAD);
    let preserve_marker_name = PathBuf::from(PRIVATE_ASSET_PRESERVE_MARKER);
    let mut preserve_options = OpenOptions::new();
    preserve_options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    validate_directories()?;
    let preserve_marker = retired
        .open_with(&preserve_marker_name, &preserve_options)
        .map_err(|error| format!("Could not mark private Notes asset preservation: {error}"))?;
    preserve_marker
        .sync_all()
        .map_err(|error| format!("Could not sync private Notes asset preservation: {error}"))?;
    drop(preserve_marker);
    sync_directory(&retired)?;
    validate_directories()?;
    rename_noreplace(directory, name, &retired, &retired_name)
        .map_err(|error| format!("Could not isolate Notes asset {name:?}: {error}"))?;
    validate_directories()?;
    let moved_validation: Result<(), String> = (|| {
        held.verify_at(&retired, &retired_name).map_err(|error| {
            format!("Could not revalidate isolated Notes asset {name:?}: {error}")
        })?;
        revalidate_private_directory(directory, &retired_directory_name, retired_identity)
            .map_err(|error| {
                format!("The Notes asset {name:?} changed during logical isolation: {error}")
            })?;
        Ok(())
    })();
    if let Err(error) = moved_validation {
        validate_directories()?;
        maybe_inject_before_isolated_restore();
        return match rename_noreplace(&retired, &retired_name, directory, name) {
            Ok(()) => {
                validate_directories()?;
                retired.remove_file(&preserve_marker_name).map_err(|remove_error| {
                    format!("Could not clear restored Notes asset preservation: {remove_error}")
                })?;
                validate_directories()?;
                remove_private_directory(
                    directory,
                    &retired_directory_name,
                    retired,
                    retired_identity,
                    validate_directories,
                )?;
                Err(format!("{error} The isolated entry was restored."))
            }
            Err(restore_error) => Err(format!(
                "{error} The unverified isolated entry was preserved because restore failed: {restore_error}."
            )),
        };
    }
    validate_directories()?;
    retired
        .remove_file(&preserve_marker_name)
        .map_err(|error| format!("Could not authorize isolated Notes asset cleanup: {error}"))?;
    validate_directories()?;
    sync_directory(&retired)?;
    maybe_inject_isolated_delete_failure()?;
    validate_directories()?;
    retired
        .remove_file(&retired_name)
        .map_err(|error| format!("Could not delete isolated Notes asset {name:?}: {error}"))?;
    validate_directories()?;
    remove_private_directory(
        directory,
        &retired_directory_name,
        retired,
        retired_identity,
        validate_directories,
    )?;
    validate_directories()
}

fn remove_owned_file(directory: &Dir, name: &Path) -> Result<(), String> {
    remove_owned_file_with_validation(directory, name, &mut || Ok(()))
}

fn trash_rows(connection: &Connection) -> Result<Vec<AssetFile>, String> {
    let mut statement = connection
        .prepare("SELECT content_hash, extension, byte_size FROM asset_trash ORDER BY content_hash")
        .map_err(|error| format!("Could not prepare Notes asset trash: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let content_hash: String = row.get(0)?;
            let extension: String = row.get(1)?;
            let byte_size =
                u64::try_from(row.get::<_, i64>(2)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let name = PathBuf::from(format!("{content_hash}.{extension}"));
            if parse_asset_name(&name).as_ref() != Some(&(content_hash.clone(), extension.clone()))
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(AssetFile {
                name,
                content_hash,
                extension,
                byte_size,
            })
        })
        .map_err(|error| format!("Could not load Notes asset trash: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read Notes asset trash: {error}"))?;
    Ok(rows)
}

pub(crate) fn run_asset_gc(vault_path: &str, config: AssetGcConfig) -> Result<(), String> {
    let config = config.validate()?;
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    let shared = acquire_notes_connection(vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    let now: String = connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Could not read the Notes asset GC clock: {error}"))?;
    let mut validate_directories = || storage.validate_asset_gc_directories(&assets, &trash);
    run_asset_gc_in_with_validation(
        &connection,
        &assets,
        &trash,
        config,
        &now,
        &mut validate_directories,
    )
}

fn run_asset_gc_in(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    config: AssetGcConfig,
    now: &str,
) -> Result<(), String> {
    run_asset_gc_in_with_validation(connection, assets, trash, config, now, &mut || Ok(()))
}

fn run_asset_gc_in_with_validation(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    config: AssetGcConfig,
    now: &str,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    validate_directories()?;
    cleanup_private_directories_with_validation(assets, validate_directories)?;
    validate_directories()?;
    cleanup_private_directories_with_validation(trash, validate_directories)?;
    validate_directories()?;
    for record in trash_rows(connection)? {
        validate_directories()?;
        let retention_days = config.retention_days(record.byte_size);
        validate_directories()?;
        connection
            .execute(
                "UPDATE asset_trash SET delete_after = \
                   strftime('%Y-%m-%dT%H:%M:%fZ', quarantined_at, printf('+%d days', ?2)) \
                 WHERE content_hash = ?1",
                params![record.content_hash, retention_days],
            )
            .map_err(|error| {
                format!("Could not update a quarantined Notes asset deadline: {error}")
            })?;
        validate_directories()?;
        if has_references(connection, &record.content_hash)? {
            let trash_exists = path_exists(trash, &record.name)?;
            let live_exists = path_exists(assets, &record.name)?;
            if trash_exists {
                if live_exists {
                    if !owned_file_matches_hash(assets, &record.name, &record.content_hash)?
                        || !owned_file_matches_hash(trash, &record.name, &record.content_hash)?
                    {
                        return Err(format!(
                            "The colliding Notes asset {:?} did not match its content hash; both files were preserved.",
                            record.name
                        ));
                    }
                } else {
                    validate_directories()?;
                    restore_verified_trash_asset(
                        trash,
                        assets,
                        &record.name,
                        &record.content_hash,
                        validate_directories,
                    )?;
                    validate_directories()?;
                }
            } else if live_exists {
                if !owned_file_matches_hash(assets, &record.name, &record.content_hash)? {
                    return Err(format!(
                        "The live Notes asset {:?} did not match its content hash; its tracked trash row was preserved.",
                        record.name
                    ));
                }
            } else {
                return Err(format!(
                    "The tracked Notes asset {:?} was missing from both live storage and trash.",
                    record.name
                ));
            }
            validate_directories()?;
            connection
                .execute(
                    "DELETE FROM asset_trash WHERE content_hash = ?1",
                    [&record.content_hash],
                )
                .map_err(|error| format!("Could not clear restored Notes asset trash: {error}"))?;
            validate_directories()?;
            if trash_exists {
                validate_directories()?;
                remove_owned_file_with_validation(trash, &record.name, validate_directories)?;
                validate_directories()?;
            }
        }
    }

    validate_directories()?;
    for asset in list_assets(assets)? {
        validate_directories()?;
        if has_references(connection, &asset.content_hash)? {
            continue;
        }
        maybe_inject_before_gc_file_mutation();
        validate_directories()?;
        if path_exists(trash, &asset.name)? {
            if !owned_file_matches_hash(assets, &asset.name, &asset.content_hash)?
                || !owned_file_matches_hash(trash, &asset.name, &asset.content_hash)?
            {
                return Err(format!(
                    "The colliding zero-ref Notes asset {:?} did not match its content hash; both files were preserved.",
                    asset.name
                ));
            }
            validate_directories()?;
            remove_owned_file_with_validation(assets, &asset.name, validate_directories)?;
        } else {
            validate_directories()?;
            move_noreplace_with_validation(
                assets,
                &asset.name,
                trash,
                &asset.name,
                &asset.content_hash,
                validate_directories,
            )?;
        }
        maybe_inject_after_gc_file_mutation();
        validate_directories()?;
        let retention_days = config.retention_days(asset.byte_size);
        let byte_size = i64::try_from(asset.byte_size)
            .map_err(|_| "The Notes asset byte size is too large.".to_string())?;
        validate_directories()?;
        connection
            .execute(
                "INSERT INTO asset_trash(content_hash, extension, byte_size, quarantined_at, delete_after) \
                 VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', ?4, printf('+%d days', ?5))) \
                 ON CONFLICT(content_hash) DO UPDATE SET extension=excluded.extension, \
                   byte_size=excluded.byte_size",
                params![asset.content_hash, asset.extension, byte_size, now, retention_days],
            )
            .map_err(|error| format!("Could not record quarantined Notes asset: {error}"))?;
        validate_directories()?;
    }

    validate_directories()?;
    for asset in list_assets(trash)? {
        validate_directories()?;
        let existing: Option<String> = connection
            .query_row(
                "SELECT content_hash FROM asset_trash WHERE content_hash = ?1",
                [&asset.content_hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Could not inspect Notes asset trash row: {error}"))?;
        if existing.is_none() {
            if has_references(connection, &asset.content_hash)? {
                if path_exists(assets, &asset.name)? {
                    if !owned_file_matches_hash(assets, &asset.name, &asset.content_hash)?
                        || !owned_file_matches_hash(trash, &asset.name, &asset.content_hash)?
                    {
                        return Err(format!(
                            "The colliding Notes asset {:?} did not match its content hash; both files were preserved.",
                            asset.name
                        ));
                    }
                } else {
                    validate_directories()?;
                    restore_verified_trash_asset(
                        trash,
                        assets,
                        &asset.name,
                        &asset.content_hash,
                        validate_directories,
                    )?;
                    validate_directories()?;
                }
                validate_directories()?;
                remove_owned_file_with_validation(trash, &asset.name, validate_directories)?;
                validate_directories()?;
                continue;
            }
            let retention_days = config.retention_days(asset.byte_size);
            let byte_size = i64::try_from(asset.byte_size)
                .map_err(|_| "The Notes asset byte size is too large.".to_string())?;
            validate_directories()?;
            connection
                .execute(
                    "INSERT INTO asset_trash(content_hash, extension, byte_size, quarantined_at, delete_after) \
                     VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', ?4, printf('+%d days', ?5)))",
                    params![asset.content_hash, asset.extension, byte_size, now, retention_days],
                )
                .map_err(|error| format!("Could not recover Notes asset trash row: {error}"))?;
            validate_directories()?;
        }
    }

    validate_directories()?;
    let mut expired = connection
        .prepare(
            "SELECT content_hash, extension FROM asset_trash WHERE delete_after <= ?1 \
             AND NOT EXISTS(SELECT 1 FROM notes_attachments \
               WHERE notes_attachments.content_hash = asset_trash.content_hash) \
             ORDER BY content_hash",
        )
        .map_err(|error| format!("Could not prepare expired Notes assets: {error}"))?
        .query_map([now], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not load expired Notes assets: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read expired Notes assets: {error}"))?;
    expired.sort();
    for (content_hash, extension) in expired {
        validate_directories()?;
        let name = PathBuf::from(format!("{content_hash}.{extension}"));
        if parse_asset_name(&name).as_ref() != Some(&(content_hash.clone(), extension.clone())) {
            return Err("The Notes asset trash row contains an unsafe file name.".to_string());
        }
        if path_exists(trash, &name)? {
            validate_directories()?;
            remove_owned_file_with_validation(trash, &name, validate_directories)?;
            validate_directories()?;
        }
        maybe_inject_before_gc_row_delete();
        validate_directories()?;
        connection
            .execute(
                "DELETE FROM asset_trash WHERE content_hash = ?1",
                [&content_hash],
            )
            .map_err(|error| format!("Could not delete expired Notes asset trash row: {error}"))?;
        validate_directories()?;
    }
    Ok(())
}

pub(crate) fn purge_unused_assets(
    vault_path: &str,
    preview_state: &AssetPurgePreviewState,
    confirm: bool,
) -> Result<PurgeReport, String> {
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    let shared = acquire_notes_connection(vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    let vault_scope = crate::notes::repository::vault_key(vault_path);
    let mut validate_directories = || storage.validate_asset_gc_directories(&assets, &trash);
    purge_unused_assets_in_with_preview_and_validation(
        &connection,
        &assets,
        &trash,
        &vault_scope,
        preview_state,
        confirm,
        &mut validate_directories,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_purge_unused_assets(
    vault_path: String,
    confirm: bool,
    preview_state: tauri::State<'_, AssetPurgePreviewState>,
) -> Result<PurgeReport, NotesError> {
    validate_vault_path(&vault_path).map_err(NotesError::from)?;
    let preview_state = preview_state.inner().clone();
    match tauri::async_runtime::spawn_blocking(move || {
        purge_unused_assets(&vault_path, &preview_state, confirm)
    })
    .await
    {
        Ok(result) => result.map_err(NotesError::from),
        Err(error) => Err(NotesError::new(
            NotesErrorCode::Internal,
            format!("Notes asset purge background task failed: {error}"),
        )),
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum AssetLocation {
    Live,
    Trash,
}

impl AssetLocation {
    fn directory<'a>(self, assets: &'a Dir, trash: &'a Dir) -> &'a Dir {
        match self {
            Self::Live => assets,
            Self::Trash => trash,
        }
    }

    fn digest_tag(self) -> u8 {
        match self {
            Self::Live => 0,
            Self::Trash => 1,
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct UnusedAssetPath {
    location: AssetLocation,
    name: PathBuf,
}

#[derive(Clone, Debug)]
struct UnusedAsset {
    byte_size: u64,
    paths: Vec<UnusedAssetPath>,
}

type UnusedAssets = BTreeMap<String, UnusedAsset>;

fn collect_unused_assets(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<UnusedAssets, String> {
    let mut unused = UnusedAssets::new();
    for (location, directory) in [(AssetLocation::Live, assets), (AssetLocation::Trash, trash)] {
        validate_directories()?;
        for asset in list_assets(directory)? {
            validate_directories()?;
            if !has_references(connection, &asset.content_hash)? {
                let entry = unused.entry(asset.content_hash).or_insert(UnusedAsset {
                    byte_size: asset.byte_size,
                    paths: Vec::new(),
                });
                entry.byte_size = entry.byte_size.max(asset.byte_size);
                entry.paths.push(UnusedAssetPath {
                    location,
                    name: asset.name,
                });
            }
        }
    }
    validate_directories()?;
    Ok(unused)
}

fn unused_assets_report(unused: &UnusedAssets) -> Result<PurgeReport, String> {
    let report = PurgeReport {
        count: u32::try_from(unused.len())
            .map_err(|_| "The Notes unused asset count is too large.".to_string())?,
        total_bytes: unused.values().try_fold(0_u64, |total, asset| {
            total
                .checked_add(asset.byte_size)
                .ok_or_else(|| "The Notes unused asset byte count is too large.".to_string())
        })?,
    };
    Ok(report)
}

fn unused_assets_membership_digest(unused: &UnusedAssets) -> String {
    let mut hasher = Sha256::new();
    for (content_hash, asset) in unused {
        hasher.update(content_hash.as_bytes());
        hasher.update(asset.byte_size.to_le_bytes());
        let mut paths = asset.paths.clone();
        paths.sort();
        for path in paths {
            hasher.update([path.location.digest_tag()]);
            let name = path.name.as_os_str().to_string_lossy();
            hasher.update((name.len() as u64).to_le_bytes());
            hasher.update(name.as_bytes());
        }
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn purge_unused_assets_in_with_preview_and_validation(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    vault_scope: &str,
    preview_state: &AssetPurgePreviewState,
    confirm: bool,
    validate_directories: &mut impl FnMut() -> Result<(), String>,
) -> Result<PurgeReport, String> {
    validate_directories()?;
    cleanup_private_directories_with_validation(assets, validate_directories)?;
    validate_directories()?;
    cleanup_private_directories_with_validation(trash, validate_directories)?;
    validate_directories()?;
    let unused = collect_unused_assets(connection, assets, trash, validate_directories)?;
    let report = unused_assets_report(&unused)?;
    let digest = unused_assets_membership_digest(&unused);
    if !confirm {
        preview_state
            .0
            .lock()
            .map_err(|_| "Could not lock the Notes asset purge preview.".to_string())?
            .insert(vault_scope.to_string(), digest);
        return Ok(report);
    }
    let expected = preview_state
        .0
        .lock()
        .map_err(|_| "Could not lock the Notes asset purge preview.".to_string())?
        .remove(vault_scope)
        .ok_or_else(|| {
            "The Notes asset purge has no current preview; run a new dry-run before confirming."
                .to_string()
        })?;
    if expected != digest {
        return Err(
            "The Notes asset purge membership changed; run a new dry-run before confirming."
                .to_string(),
        );
    }
    validate_directories()?;
    for (content_hash, asset) in unused {
        for path in asset.paths {
            validate_directories()?;
            remove_owned_file_with_validation(
                path.location.directory(assets, trash),
                &path.name,
                validate_directories,
            )?;
            validate_directories()?;
        }
        validate_directories()?;
        connection
            .execute(
                "DELETE FROM asset_trash WHERE content_hash = ?1",
                [&content_hash],
            )
            .map_err(|error| format!("Could not clear purged Notes asset trash: {error}"))?;
        validate_directories()?;
    }
    validate_directories()?;
    connection
        .execute(
            "DELETE FROM asset_trash WHERE NOT EXISTS(SELECT 1 FROM notes_attachments \
             WHERE notes_attachments.content_hash = asset_trash.content_hash)",
            [],
        )
        .map_err(|error| format!("Could not clear stale Notes asset trash rows: {error}"))?;
    validate_directories()?;
    Ok(report)
}

fn purge_unused_assets_in_with_preview(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    vault_scope: &str,
    preview_state: &AssetPurgePreviewState,
    confirm: bool,
) -> Result<PurgeReport, String> {
    purge_unused_assets_in_with_preview_and_validation(
        connection,
        assets,
        trash,
        vault_scope,
        preview_state,
        confirm,
        &mut || Ok(()),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        copy_owned_asset, copy_then_remove, inject_after_gc_file_mutation_once,
        inject_before_gc_file_mutation_once, inject_before_gc_row_delete_once,
        inject_before_isolated_restore_once, inject_before_owned_file_open_once,
        inject_before_owned_file_read_once, inject_before_owned_file_remove_once,
        inject_copy_abort_after_write_once, inject_isolated_delete_failure_once,
        inject_sync_failure_after, owned_file_matches_hash, purge_unused_assets_in_with_preview,
        remove_owned_file, run_asset_gc_in, run_asset_gc_in_with_validation, AssetGcConfig,
        AssetPurgePreviewState, PurgeReport, PRIVATE_ASSET_PAYLOAD,
    };
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;
    use rusqlite::{params, Connection};
    use sha2::{Digest, Sha256};
    use std::fs;

    fn fixture() -> (tempfile::TempDir, Dir, Dir, Connection) {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("assets")).unwrap();
        fs::create_dir(root.path().join("trash")).unwrap();
        let assets =
            Dir::open_ambient_dir(root.path().join("assets"), ambient_authority()).unwrap();
        let trash = Dir::open_ambient_dir(root.path().join("trash"), ambient_authority()).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE notes_attachments(content_hash TEXT NOT NULL); \
                 CREATE TABLE asset_trash(content_hash TEXT PRIMARY KEY, extension TEXT NOT NULL, \
                   byte_size INTEGER NOT NULL, quarantined_at TEXT NOT NULL, delete_after TEXT NOT NULL);",
            )
            .unwrap();
        (root, assets, trash, connection)
    }

    fn private_gc_entries(directory: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut entries = fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".asset-gc-")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }

    #[test]
    fn gc_quarantines_by_derived_refcount_and_retention_tier() {
        let (root, assets, trash, connection) = fixture();
        let small = "a".repeat(64);
        let large = "b".repeat(64);
        fs::write(root.path().join("assets").join(format!("{small}.png")), [1]).unwrap();
        fs::write(
            root.path().join("assets").join(format!("{large}.png")),
            vec![2; 6 * 1024 * 1024],
        )
        .unwrap();

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap();

        assert!(!root
            .path()
            .join("assets")
            .join(format!("{small}.png"))
            .exists());
        assert!(root
            .path()
            .join("trash")
            .join(format!("{small}.png"))
            .exists());
        let rows = connection
            .prepare("SELECT content_hash, delete_after FROM asset_trash ORDER BY content_hash")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (small, "2026-07-28T00:00:00.000Z".to_string()),
                (large, "2026-07-23T00:00:00.000Z".to_string())
            ]
        );
    }

    #[test]
    fn gc_recalculates_existing_deadlines_from_the_current_retention_settings() {
        let (_root, assets, trash, connection) = fixture();
        let content_hash = "8".repeat(64);
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 1, '2026-07-20T00:00:00.000Z', '2026-07-27T00:00:00.000Z')",
                [&content_hash],
            )
            .unwrap();

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig {
                asset_trash_retention_days: 30,
                ..AssetGcConfig::default()
            },
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap();

        assert_eq!(
            connection
                .query_row(
                    "SELECT delete_after FROM asset_trash WHERE content_hash = ?1",
                    [&content_hash],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "2026-08-19T00:00:00.000Z"
        );
    }

    #[test]
    fn gc_restores_rereferenced_assets_and_deletes_expired_assets() {
        let (root, assets, trash, connection) = fixture();
        let restored_bytes = [1_u8];
        let restored = Sha256::digest(restored_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let expired = "d".repeat(64);
        fs::write(
            root.path().join("trash").join(format!("{restored}.png")),
            restored_bytes,
        )
        .unwrap();
        fs::write(
            root.path().join("trash").join(format!("{expired}.png")),
            [2],
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                [&restored],
            )
            .unwrap();
        for hash in [&restored, &expired] {
            connection
                .execute(
                    "INSERT INTO asset_trash VALUES (?1, 'png', 1, '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')",
                    [hash],
                )
                .unwrap();
        }

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap();

        assert!(root
            .path()
            .join("assets")
            .join(format!("{restored}.png"))
            .exists());
        assert!(!root
            .path()
            .join("trash")
            .join(format!("{expired}.png"))
            .exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn gc_rejects_corrupt_tracked_and_untracked_trash_before_restore() {
        for tracked in [true, false] {
            let (root, assets, trash, connection) = fixture();
            let content_hash = Sha256::digest(b"expected bytes")
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let name = format!("{content_hash}.png");
            fs::write(root.path().join("trash").join(&name), b"corrupt bytes").unwrap();
            connection
                .execute(
                    "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                    [&content_hash],
                )
                .unwrap();
            if tracked {
                connection
                    .execute(
                        "INSERT INTO asset_trash VALUES (?1, 'png', 13, '2026-07-20T00:00:00.000Z', '2026-07-27T00:00:00.000Z')",
                        [&content_hash],
                    )
                    .unwrap();
            }

            let error = run_asset_gc_in(
                &connection,
                &assets,
                &trash,
                AssetGcConfig::default(),
                "2026-07-21T00:00:00.000Z",
            )
            .expect_err("corrupt trash must not be promoted");

            assert!(error.contains("content hash"), "{error}");
            assert!(!root.path().join("assets").join(&name).exists());
            assert!(root.path().join("trash").join(&name).exists());
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                i64::from(tracked)
            );
        }
    }

    #[test]
    fn gc_preserves_a_tracked_row_when_only_corrupt_live_bytes_remain() {
        let (root, assets, trash, connection) = fixture();
        let content_hash = Sha256::digest(b"expected bytes")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), b"corrupt bytes").unwrap();
        connection
            .execute(
                "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                [&content_hash],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 13, '2026-07-20T00:00:00.000Z', '2026-07-27T00:00:00.000Z')",
                [&content_hash],
            )
            .unwrap();

        let error = run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .expect_err("corrupt live fallback must not clear tracked trash metadata");

        assert!(error.contains("content hash"), "{error}");
        assert!(root.path().join("assets").join(&name).exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn gc_preserves_live_and_trash_collision_unless_both_match_the_content_hash() {
        let (root, assets, trash, connection) = fixture();
        let valid = [1_u8, 2, 3];
        let content_hash = Sha256::digest(valid)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), b"corrupt").unwrap();
        fs::write(root.path().join("trash").join(&name), valid).unwrap();
        connection
            .execute(
                "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                [&content_hash],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 3, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
                [&content_hash],
            )
            .unwrap();

        let error = run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap_err();

        assert!(error.contains("content hash"), "{error}");
        assert!(root.path().join("assets").join(&name).exists());
        assert!(root.path().join("trash").join(&name).exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn gc_collapses_verified_zero_ref_duplicates_without_extending_expired_retention() {
        let (root, assets, trash, connection) = fixture();
        let bytes = [1_u8, 2, 3];
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        fs::write(root.path().join("trash").join(&name), bytes).unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 3, '2026-07-01T00:00:00.000Z', '2026-07-08T00:00:00.000Z')",
                [&content_hash],
            )
            .unwrap();

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap();

        assert!(!root.path().join("assets").join(&name).exists());
        assert!(!root.path().join("trash").join(&name).exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn gc_restores_rereferenced_untracked_trash_in_the_same_pass() {
        let (root, assets, trash, connection) = fixture();
        let restored_bytes = [1_u8];
        let restored = Sha256::digest(restored_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{restored}.png");
        fs::write(root.path().join("trash").join(&name), restored_bytes).unwrap();
        connection
            .execute(
                "INSERT INTO notes_attachments(content_hash) VALUES (?1)",
                [&restored],
            )
            .unwrap();

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .unwrap();

        assert!(root.path().join("assets").join(&name).exists());
        assert!(!root.path().join("trash").join(&name).exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn cross_device_copy_keeps_destination_after_source_retirement() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = [1_u8, 2, 3];
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        inject_sync_failure_after(6);

        let error = copy_then_remove(
            &assets,
            std::path::Path::new(&name),
            &trash,
            std::path::Path::new(&name),
            &expected,
        )
        .unwrap_err();

        assert!(error.contains("Injected Notes asset directory sync failure"));
        assert!(!root.path().join("assets").join(&name).exists());
        assert!(root.path().join("trash").join(&name).exists());
    }

    #[test]
    fn cross_device_copy_rejects_bytes_that_do_not_match_the_asset_hash() {
        let (root, assets, trash, _connection) = fixture();
        let expected = Sha256::digest(b"expected")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), b"changed").unwrap();

        let error = copy_then_remove(
            &assets,
            std::path::Path::new(&name),
            &trash,
            std::path::Path::new(&name),
            &expected,
        )
        .unwrap_err();

        assert!(error.contains("content hash"), "{error}");
        assert!(root.path().join("assets").join(&name).exists());
        assert!(!root.path().join("trash").join(&name).exists());
    }

    #[test]
    fn interrupted_copy_never_exposes_a_partial_canonical_asset() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"complete asset bytes";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        inject_copy_abort_after_write_once();

        let aborted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            copy_owned_asset(
                &assets,
                std::path::Path::new(&name),
                &trash,
                std::path::Path::new(&name),
                &expected,
                false,
            )
        }));

        assert!(aborted.is_err(), "the fault must interrupt the copy");
        assert!(root.path().join("assets").join(&name).exists());
        assert!(
            !root.path().join("trash").join(&name).exists(),
            "an interrupted copy must not expose its final name"
        );

        copy_owned_asset(
            &assets,
            std::path::Path::new(&name),
            &trash,
            std::path::Path::new(&name),
            &expected,
            false,
        )
        .expect("retry must clean the interrupted staging entry and publish exact bytes");
        assert_eq!(
            fs::read(root.path().join("trash").join(&name)).unwrap(),
            bytes
        );
        assert!(
            private_gc_entries(&root.path().join("trash")).is_empty(),
            "retry must reclaim every stranded staging entry"
        );
    }

    #[test]
    fn private_asset_operations_never_trust_precreated_fixed_names() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"private operation asset";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        fs::write(root.path().join("assets/.asset-gc-retired"), b"external").unwrap();
        fs::write(root.path().join("trash/.asset-gc-staging"), b"external").unwrap();

        copy_owned_asset(
            &assets,
            std::path::Path::new(&name),
            &trash,
            std::path::Path::new(&name),
            &expected,
            false,
        )
        .expect("copy must use a newly created unpredictable private capability");
        remove_owned_file(&assets, std::path::Path::new(&name))
            .expect("delete must use a newly created unpredictable private capability");

        assert_eq!(
            fs::read(root.path().join("assets/.asset-gc-retired")).unwrap(),
            b"external"
        );
        assert_eq!(
            fs::read(root.path().join("trash/.asset-gc-staging")).unwrap(),
            b"external"
        );
    }

    #[test]
    fn retired_asset_bytes_are_reclaimed_after_an_unlink_failure() {
        let (root, assets, trash, connection) = fixture();
        let bytes = b"retired recovery asset";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        inject_isolated_delete_failure_once();

        let error = remove_owned_file(&assets, std::path::Path::new(&name))
            .expect_err("fault must strand the logically retired bytes");
        assert!(error.contains("Injected isolated"), "{error}");
        assert!(!private_gc_entries(&root.path().join("assets")).is_empty());

        run_asset_gc_in(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
        )
        .expect("the next pass must recover private retired entries");
        assert!(private_gc_entries(&root.path().join("assets")).is_empty());
    }

    #[test]
    fn cross_device_copy_retry_retires_source_after_completed_publication() {
        let (root, assets, trash, _connection) = fixture();
        let bytes = b"complete asset bytes";
        let expected = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{expected}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        fs::write(root.path().join("trash").join(&name), bytes).unwrap();

        copy_then_remove(
            &assets,
            std::path::Path::new(&name),
            &trash,
            std::path::Path::new(&name),
            &expected,
        )
        .expect("a retry must accept the already published exact destination");

        assert!(!root.path().join("assets").join(&name).exists());
        assert_eq!(
            fs::read(root.path().join("trash").join(&name)).unwrap(),
            bytes
        );
    }

    #[test]
    fn asset_hashing_rejects_files_over_the_attachment_limit() {
        let (root, assets, _trash, _connection) = fixture();
        let name = "b".repeat(64) + ".png";
        fs::write(
            root.path().join("assets").join(&name),
            vec![7_u8; 20 * 1024 * 1024 + 1],
        )
        .unwrap();

        let error = owned_file_matches_hash(&assets, std::path::Path::new(&name), &"b".repeat(64))
            .expect_err("oversized GC inputs must fail before unbounded hashing");

        assert!(error.contains("byte limit"), "{error}");
    }

    #[test]
    fn asset_hashing_rejects_growth_past_the_limit_after_open() {
        let (root, assets, _trash, _connection) = fixture();
        let name = "d".repeat(64) + ".png";
        let canonical = root.path().join("assets").join(&name);
        fs::write(&canonical, b"initial").unwrap();
        inject_before_owned_file_read_once(move || {
            fs::OpenOptions::new()
                .write(true)
                .open(&canonical)
                .unwrap()
                .set_len(20 * 1024 * 1024 + 1)
                .unwrap();
        });

        let error = owned_file_matches_hash(&assets, std::path::Path::new(&name), &"d".repeat(64))
            .expect_err("post-open growth must remain bounded");

        assert!(error.contains("byte limit"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn asset_hashing_rejects_a_fifo_replacement_without_blocking() {
        use std::sync::mpsc;
        use std::time::Duration;

        let (root, assets, _trash, _connection) = fixture();
        let name = "c".repeat(64) + ".png";
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-fifo-source.png");
        fs::write(&canonical, b"regular bytes").unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let canonical_for_hook = canonical.clone();
            let displaced_for_hook = displaced.clone();
            inject_before_owned_file_open_once(move || {
                fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
                let status = std::process::Command::new("mkfifo")
                    .arg(&canonical_for_hook)
                    .status()
                    .unwrap();
                assert!(status.success());
            });
            let result =
                owned_file_matches_hash(&assets, std::path::Path::new(&name), &"c".repeat(64));
            let _ = sender.send(result);
        });

        let result = receiver
            .recv_timeout(Duration::from_millis(500))
            .expect("a FIFO replacement must not block the GC worker");
        let error = result.expect_err("a FIFO replacement must fail closed");
        assert!(error.contains("regular file"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn gc_rejects_a_rebound_trash_directory_before_recording_the_move() {
        use std::os::unix::fs::MetadataExt as StdMetadataExt;

        let (root, assets, trash, connection) = fixture();
        let bytes = b"directory-bound asset";
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        let trash_path = root.path().join("trash");
        let displaced_trash = root.path().join("displaced-trash");
        let expected = fs::metadata(&trash_path).unwrap();
        let expected_identity = (expected.dev(), expected.ino());
        let trash_for_hook = trash_path.clone();
        let displaced_for_hook = displaced_trash.clone();
        inject_after_gc_file_mutation_once(move || {
            fs::rename(&trash_for_hook, &displaced_for_hook).unwrap();
            fs::create_dir(&trash_for_hook).unwrap();
        });
        let mut validate = || {
            let current = fs::symlink_metadata(&trash_path)
                .map_err(|error| format!("Could not revalidate test trash: {error}"))?;
            if (current.dev(), current.ino()) != expected_identity {
                return Err("The Notes asset trash directory identity changed.".to_string());
            }
            Ok(())
        };

        let error = run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            &mut validate,
        )
        .expect_err("a rebound trash basename must stop before SQL records the move");

        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(displaced_trash.join(&name).exists());
    }

    #[cfg(unix)]
    #[test]
    fn gc_rejects_a_rebound_assets_directory_immediately_before_file_mutation() {
        use std::os::unix::fs::MetadataExt as StdMetadataExt;

        let (root, assets, trash, connection) = fixture();
        let bytes = b"assets-directory-bound asset";
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), bytes).unwrap();
        let assets_path = root.path().join("assets");
        let displaced_assets = root.path().join("displaced-assets");
        let expected = fs::metadata(&assets_path).unwrap();
        let expected_identity = (expected.dev(), expected.ino());
        let assets_for_hook = assets_path.clone();
        let displaced_for_hook = displaced_assets.clone();
        inject_before_gc_file_mutation_once(move || {
            fs::rename(&assets_for_hook, &displaced_for_hook).unwrap();
            fs::create_dir(&assets_for_hook).unwrap();
        });
        let mut validate = || {
            let current = fs::symlink_metadata(&assets_path)
                .map_err(|error| format!("Could not revalidate test assets: {error}"))?;
            if (current.dev(), current.ino()) != expected_identity {
                return Err("The Notes asset directory identity changed.".to_string());
            }
            Ok(())
        };

        let error = run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            &mut validate,
        )
        .expect_err("a rebound assets basename must stop before moving the held file");

        assert!(error.contains("identity changed"), "{error}");
        assert!(displaced_assets.join(&name).exists());
        assert!(!root.path().join("trash").join(&name).exists());
    }

    #[cfg(unix)]
    #[test]
    fn gc_rejects_a_rebound_trash_directory_immediately_before_row_deletion() {
        use std::os::unix::fs::MetadataExt as StdMetadataExt;

        let (root, assets, trash, connection) = fixture();
        let content_hash = "9".repeat(64);
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("trash").join(&name), b"expired").unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 7, '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')",
                [&content_hash],
            )
            .unwrap();
        let trash_path = root.path().join("trash");
        let displaced_trash = root.path().join("displaced-expired-trash");
        let expected = fs::metadata(&trash_path).unwrap();
        let expected_identity = (expected.dev(), expected.ino());
        let trash_for_hook = trash_path.clone();
        let displaced_for_hook = displaced_trash.clone();
        inject_before_gc_row_delete_once(move || {
            fs::rename(&trash_for_hook, &displaced_for_hook).unwrap();
            fs::create_dir(&trash_for_hook).unwrap();
        });
        let mut validate = || {
            let current = fs::symlink_metadata(&trash_path)
                .map_err(|error| format!("Could not revalidate test trash: {error}"))?;
            if (current.dev(), current.ino()) != expected_identity {
                return Err("The Notes asset trash directory identity changed.".to_string());
            }
            Ok(())
        };

        let error = run_asset_gc_in_with_validation(
            &connection,
            &assets,
            &trash,
            AssetGcConfig::default(),
            "2026-07-21T00:00:00.000Z",
            &mut validate,
        )
        .expect_err("a rebound trash basename must stop before deleting its row");

        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn owned_file_delete_never_unlinks_a_replacement_after_validation() {
        let (root, assets, _trash, _connection) = fixture();
        let name = "a".repeat(64) + ".png";
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-original.png");
        fs::write(&canonical, b"verified original").unwrap();
        let canonical_for_hook = canonical.clone();
        let displaced_for_hook = displaced.clone();
        inject_before_owned_file_remove_once(move || {
            fs::rename(&canonical_for_hook, &displaced_for_hook).unwrap();
            fs::write(&canonical_for_hook, b"external replacement").unwrap();
        });

        let error = remove_owned_file(&assets, std::path::Path::new(&name))
            .expect_err("a replaced canonical path must fail closed");

        assert!(error.contains("changed"), "{error}");
        assert_eq!(fs::read(&canonical).unwrap(), b"external replacement");
        assert_eq!(fs::read(&displaced).unwrap(), b"verified original");
    }

    #[test]
    fn failed_isolated_validation_is_never_reclaimed_as_verified_retirement() {
        let (root, assets, _trash, _connection) = fixture();
        let name = "6".repeat(64) + ".png";
        let canonical = root.path().join("assets").join(&name);
        let displaced = root.path().join("displaced-preserved-original.png");
        fs::write(&canonical, b"verified original").unwrap();
        let canonical_for_swap = canonical.clone();
        let displaced_for_swap = displaced.clone();
        inject_before_owned_file_remove_once(move || {
            fs::rename(&canonical_for_swap, &displaced_for_swap).unwrap();
            fs::write(&canonical_for_swap, b"external replacement").unwrap();
        });
        let canonical_for_blocker = canonical.clone();
        inject_before_isolated_restore_once(move || {
            fs::write(&canonical_for_blocker, b"restore blocker").unwrap();
        });

        let error = remove_owned_file(&assets, std::path::Path::new(&name))
            .expect_err("failed isolation validation must preserve the unverified payload");
        assert!(error.contains("preserved"), "{error}");

        let second_name = "7".repeat(64) + ".png";
        fs::write(root.path().join("assets").join(&second_name), b"second").unwrap();
        remove_owned_file(&assets, std::path::Path::new(&second_name))
            .expect("a later cleanup pass must skip the preserved directory");

        let preserved = private_gc_entries(&root.path().join("assets"))
            .into_iter()
            .map(|directory| directory.join(PRIVATE_ASSET_PAYLOAD))
            .any(|payload| fs::read(payload).is_ok_and(|bytes| bytes == b"external replacement"));
        assert!(
            preserved,
            "unverified replacement must never become cleanup-eligible"
        );
        assert_eq!(fs::read(&canonical).unwrap(), b"restore blocker");
        assert_eq!(fs::read(&displaced).unwrap(), b"verified original");
    }

    #[test]
    fn purge_report_serializes_the_fixed_wire_contract() {
        assert_eq!(
            serde_json::to_value(PurgeReport {
                count: 2,
                total_bytes: 4096,
            })
            .unwrap(),
            serde_json::json!({ "count": 2, "totalBytes": 4096 })
        );
    }

    #[test]
    fn asset_gc_directory_binding_uses_cross_platform_capability_contracts() {
        let attachments = include_str!("../attachments.rs");
        let validator = attachments
            .split("pub(crate) fn validate_asset_gc_directories")
            .nth(1)
            .and_then(|source| source.split("pub(crate) fn acquire").next())
            .expect("asset GC directory validator source");
        let file_io = include_str!("../../file_io.rs");
        let private_directory_removal = include_str!("asset_gc.rs")
            .split("fn remove_private_directory")
            .nth(1)
            .and_then(|source| {
                source
                    .split("fn cleanup_private_directories_with_validation")
                    .next()
            })
            .expect("private directory removal source");

        assert!(
            validator
                .matches("capability_metadata_is_reparse_point")
                .count()
                >= 4
        );
        assert!(validator.matches("capability_file_identity").count() >= 4);
        assert!(validator.contains("open_dir_nofollow(\"notes-assets\")"));
        assert!(validator.contains("open_dir_nofollow(\"asset-trash\")"));
        assert!(
            file_io.contains("#[cfg(windows)]\npub(crate) fn capability_metadata_is_reparse_point")
        );
        assert!(file_io.contains("try_capability_file_identity(metadata)"));
        let close = private_directory_removal
            .find("drop(directory)")
            .expect("the held directory must close explicitly");
        let remove = private_directory_removal
            .find("parent.remove_dir")
            .expect("the private directory path must be removed");
        assert!(
            close < remove,
            "Windows requires closing the held directory first"
        );
    }

    #[test]
    fn purge_dry_run_reports_then_confirm_deletes_live_and_quarantined_assets() {
        let (root, assets, trash, connection) = fixture();
        let previews = AssetPurgePreviewState::default();
        let live = "e".repeat(64);
        let quarantined = "f".repeat(64);
        fs::write(
            root.path().join("assets").join(format!("{live}.png")),
            [1, 2],
        )
        .unwrap();
        fs::write(
            root.path().join("trash").join(format!("{quarantined}.png")),
            [3, 4, 5],
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO asset_trash VALUES (?1, 'png', 3, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')",
                params![quarantined],
            )
            .unwrap();

        assert_eq!(
            purge_unused_assets_in_with_preview(
                &connection,
                &assets,
                &trash,
                "test-vault",
                &previews,
                false,
            )
            .unwrap(),
            PurgeReport {
                count: 2,
                total_bytes: 5
            }
        );
        assert!(root
            .path()
            .join("assets")
            .join(format!("{live}.png"))
            .exists());

        assert_eq!(
            purge_unused_assets_in_with_preview(
                &connection,
                &assets,
                &trash,
                "test-vault",
                &previews,
                true,
            )
            .unwrap(),
            PurgeReport {
                count: 2,
                total_bytes: 5
            }
        );
        assert!(!root
            .path()
            .join("assets")
            .join(format!("{live}.png"))
            .exists());
        assert!(!root
            .path()
            .join("trash")
            .join(format!("{quarantined}.png"))
            .exists());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_trash", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn purge_confirm_rejects_membership_added_after_the_preview() {
        let (root, assets, trash, connection) = fixture();
        let first = "1".repeat(64);
        let second = "2".repeat(64);
        let first_name = format!("{first}.png");
        let second_name = format!("{second}.png");
        fs::write(root.path().join("assets").join(&first_name), b"first").unwrap();
        let previews = AssetPurgePreviewState::default();

        assert_eq!(
            purge_unused_assets_in_with_preview(
                &connection,
                &assets,
                &trash,
                "vault-a",
                &previews,
                false,
            )
            .unwrap(),
            PurgeReport {
                count: 1,
                total_bytes: 5,
            }
        );
        fs::write(root.path().join("trash").join(&second_name), b"second").unwrap();

        let error = purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-a",
            &previews,
            true,
        )
        .expect_err("confirm must reject membership that differs from the preview");

        assert!(error.contains("new dry-run"), "{error}");
        assert!(root.path().join("assets").join(&first_name).exists());
        assert!(root.path().join("trash").join(&second_name).exists());
    }

    #[test]
    fn purge_confirm_rejects_membership_removed_after_the_preview() {
        let (root, assets, trash, connection) = fixture();
        let first = "3".repeat(64);
        let second = "4".repeat(64);
        let first_name = format!("{first}.png");
        let second_name = format!("{second}.png");
        fs::write(root.path().join("assets").join(&first_name), b"first").unwrap();
        fs::write(root.path().join("trash").join(&second_name), b"second").unwrap();
        let previews = AssetPurgePreviewState::default();

        purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-a",
            &previews,
            false,
        )
        .unwrap();
        fs::remove_file(root.path().join("trash").join(&second_name)).unwrap();

        let error = purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-a",
            &previews,
            true,
        )
        .expect_err("confirm must reject membership removed since the preview");

        assert!(error.contains("new dry-run"), "{error}");
        assert!(root.path().join("assets").join(&first_name).exists());
    }

    #[test]
    fn purge_preview_is_scoped_to_one_vault() {
        let (root, assets, trash, connection) = fixture();
        let content_hash = "5".repeat(64);
        let name = format!("{content_hash}.png");
        fs::write(root.path().join("assets").join(&name), b"unused").unwrap();
        let previews = AssetPurgePreviewState::default();

        purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-a",
            &previews,
            false,
        )
        .unwrap();
        let error = purge_unused_assets_in_with_preview(
            &connection,
            &assets,
            &trash,
            "vault-b",
            &previews,
            true,
        )
        .expect_err("one vault must never consume another vault's preview");

        assert!(error.contains("new dry-run"), "{error}");
        assert!(root.path().join("assets").join(&name).exists());
    }
}
