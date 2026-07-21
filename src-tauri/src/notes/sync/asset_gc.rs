use crate::file_io::rename_noreplace;
use crate::notes::attachments::AttachmentStorageLease;
use crate::notes::connection::{acquire_notes_connection, lock_notes_connection};
use crate::notes::error::{NotesError, NotesErrorCode};
use crate::notes::repository::validate_vault_path;
use crate::notes::types::NoteAttachment;
use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const COPY_CHUNK_BYTES: usize = 1024 * 1024;

#[cfg(test)]
thread_local! {
    static INJECTED_SYNC_FAILURE_AFTER: std::cell::Cell<Option<usize>> = const {
        std::cell::Cell::new(None)
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
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = directory
        .open_with(name, &options)
        .map_err(|error| format!("Could not open Notes asset {name:?}: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {name:?}: {error}"))?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(format!(
            "The Notes asset {name:?} must be an owned regular file."
        ));
    }
    let identity = (metadata.dev(), metadata.ino());
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
    let path_metadata = directory
        .symlink_metadata(name)
        .map_err(|error| format!("Could not revalidate Notes asset {name:?}: {error}"))?;
    if !path_metadata.is_file()
        || path_metadata.nlink() != 1
        || (path_metadata.dev(), path_metadata.ino()) != identity
    {
        return Err(format!(
            "The Notes asset {name:?} changed while it was hashed."
        ));
    }
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

fn copy_owned_asset(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
    retire_source: bool,
) -> Result<(), String> {
    let mut read_options = OpenOptions::new();
    read_options.read(true).follow(FollowSymlinks::No);
    let mut source = from_parent
        .open_with(from, &read_options)
        .map_err(|error| format!("Could not open Notes asset {from:?}: {error}"))?;
    let source_metadata = source
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {from:?}: {error}"))?;
    if !source_metadata.is_file() || source_metadata.nlink() != 1 {
        return Err(format!(
            "The Notes asset {from:?} must be an owned regular file."
        ));
    }
    let source_identity = (source_metadata.dev(), source_metadata.ino());
    let source_byte_size = source_metadata.len();
    let mut write_options = OpenOptions::new();
    write_options
        .read(true)
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut destination = to_parent
        .open_with(to, &write_options)
        .map_err(|error| format!("Could not create Notes asset {to:?}: {error}"))?;
    let destination_metadata = destination
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {to:?}: {error}"))?;
    let destination_identity = (destination_metadata.dev(), destination_metadata.ino());
    let mut source_retired = false;
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
        source
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("Could not seek Notes asset {from:?}: {error}"))?;
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
        let path_metadata = from_parent
            .symlink_metadata(from)
            .map_err(|error| format!("Could not revalidate Notes asset {from:?}: {error}"))?;
        if !path_metadata.is_file()
            || path_metadata.nlink() != 1
            || (path_metadata.dev(), path_metadata.ino()) != source_identity
        {
            return Err(format!(
                "The Notes asset {from:?} changed while it was moved."
            ));
        }
        let destination_path_metadata = to_parent
            .symlink_metadata(to)
            .map_err(|error| format!("Could not revalidate Notes asset {to:?}: {error}"))?;
        if !destination_path_metadata.is_file()
            || destination_path_metadata.nlink() != 1
            || destination_path_metadata.len() != source_byte_size
            || (
                destination_path_metadata.dev(),
                destination_path_metadata.ino(),
            ) != destination_identity
        {
            return Err(format!(
                "The Notes asset {to:?} changed while it was copied."
            ));
        }
        sync_directory(to_parent)?;
        if retire_source {
            from_parent
                .remove_file(from)
                .map_err(|error| format!("Could not retire Notes asset {from:?}: {error}"))?;
            source_retired = true;
            sync_directory(from_parent)?;
        }
        Ok(())
    })();
    if copy_result.is_err() && !source_retired {
        if to_parent.symlink_metadata(to).is_ok_and(|metadata| {
            metadata.is_file()
                && metadata.nlink() == 1
                && (metadata.dev(), metadata.ino()) == destination_identity
        }) {
            let _ = to_parent.remove_file(to);
        }
    }
    copy_result
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

fn move_noreplace(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
    expected_hash: &str,
) -> Result<(), String> {
    match rename_noreplace(from_parent, from, to_parent, to) {
        Ok(()) => {
            sync_directory(from_parent)?;
            sync_directory(to_parent)
        }
        Err(error) if error.kind() == ErrorKind::CrossesDevices => {
            copy_then_remove(from_parent, from, to_parent, to, expected_hash)
        }
        Err(error) => Err(format!("Could not move Notes asset {from:?}: {error}")),
    }
}

fn restore_verified_trash_asset(
    trash: &Dir,
    assets: &Dir,
    name: &Path,
    expected_hash: &str,
) -> Result<(), String> {
    if !owned_file_matches_hash(trash, name, expected_hash)? {
        return Err(format!(
            "The quarantined Notes asset {name:?} did not match its content hash."
        ));
    }
    copy_owned_asset(trash, name, assets, name, expected_hash, false)?;
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
) -> Result<(), String> {
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
        copy_owned_asset(
            assets,
            quarantined_name,
            trash,
            canonical_name,
            expected_hash,
            false,
        )?;
    }
    let retention_days = AssetGcConfig::default().retention_days(byte_size);
    let byte_size = i64::try_from(byte_size)
        .map_err(|_| "The retained Notes asset byte size is too large.".to_string())?;
    connection
        .execute(
            "INSERT INTO asset_trash(content_hash, extension, byte_size, quarantined_at, delete_after) \
             VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d days', ?4))) \
             ON CONFLICT(content_hash) DO NOTHING",
            params![expected_hash, extension, byte_size, retention_days],
        )
        .map_err(|error| format!("Could not retain a reconciled Notes asset: {error}"))?;
    Ok(())
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
    Ok(())
}

pub(crate) fn restore_attachment_for_replay(
    connection: &Connection,
    storage: &AttachmentStorageLease,
    attachment: &NoteAttachment,
) -> Result<bool, String> {
    let name = replay_asset_name(attachment)?;
    let (assets, trash) = storage.asset_gc_directories()?;
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
        copy_owned_asset(
            &trash,
            &name,
            &assets,
            &name,
            &attachment.content_hash,
            false,
        )?;
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
    if let Err(error) = connection
        .execute(
            "DELETE FROM asset_trash WHERE content_hash = ?1",
            [&attachment.content_hash],
        )
        .map_err(|error| format!("Could not clear replayed Notes asset trash: {error}"))
    {
        if created_live && owned_file_matches_hash(&assets, &name, &attachment.content_hash)? {
            remove_owned_file(&assets, &name)?;
        }
        return Err(error);
    }
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
    let (assets, _) = storage.asset_gc_directories()?;
    if !path_exists(&assets, &name)? {
        return Ok(());
    }
    if !owned_file_matches_hash(&assets, &name, &attachment.content_hash)? {
        return Err(format!(
            "The staged Notes replay asset {name:?} changed before rollback; it was preserved."
        ));
    }
    remove_owned_file(&assets, &name)
}

pub(crate) fn finalize_attachment_for_replay(
    storage: &AttachmentStorageLease,
    attachment: &NoteAttachment,
) -> Result<(), String> {
    let name = replay_asset_name(attachment)?;
    let (assets, trash) = storage.asset_gc_directories()?;
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
    remove_owned_file(&trash, &name)
}

fn remove_owned_file(directory: &Dir, name: &Path) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let held = directory
        .open_with(name, &options)
        .map_err(|error| format!("Could not open Notes asset {name:?}: {error}"))?;
    let metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect Notes asset {name:?}: {error}"))?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(format!(
            "The Notes asset {name:?} must be an owned regular file."
        ));
    }
    let identity = (metadata.dev(), metadata.ino());
    let path_metadata = directory
        .symlink_metadata(name)
        .map_err(|error| format!("Could not revalidate Notes asset {name:?}: {error}"))?;
    if (path_metadata.dev(), path_metadata.ino()) != identity {
        return Err(format!("The Notes asset {name:?} changed before deletion."));
    }
    directory
        .remove_file(name)
        .map_err(|error| format!("Could not delete Notes asset {name:?}: {error}"))?;
    sync_directory(directory)
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
    run_asset_gc_in(&connection, &assets, &trash, config, &now)
}

fn run_asset_gc_in(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    config: AssetGcConfig,
    now: &str,
) -> Result<(), String> {
    for record in trash_rows(connection)? {
        let retention_days = config.retention_days(record.byte_size);
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
                    restore_verified_trash_asset(
                        trash,
                        assets,
                        &record.name,
                        &record.content_hash,
                    )?;
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
            connection
                .execute(
                    "DELETE FROM asset_trash WHERE content_hash = ?1",
                    [&record.content_hash],
                )
                .map_err(|error| format!("Could not clear restored Notes asset trash: {error}"))?;
            if trash_exists {
                remove_owned_file(trash, &record.name)?;
            }
        }
    }

    for asset in list_assets(assets)? {
        if has_references(connection, &asset.content_hash)? {
            continue;
        }
        if path_exists(trash, &asset.name)? {
            if !owned_file_matches_hash(assets, &asset.name, &asset.content_hash)?
                || !owned_file_matches_hash(trash, &asset.name, &asset.content_hash)?
            {
                return Err(format!(
                    "The colliding zero-ref Notes asset {:?} did not match its content hash; both files were preserved.",
                    asset.name
                ));
            }
            remove_owned_file(assets, &asset.name)?;
        } else {
            move_noreplace(assets, &asset.name, trash, &asset.name, &asset.content_hash)?;
        }
        let retention_days = config.retention_days(asset.byte_size);
        let byte_size = i64::try_from(asset.byte_size)
            .map_err(|_| "The Notes asset byte size is too large.".to_string())?;
        connection
            .execute(
                "INSERT INTO asset_trash(content_hash, extension, byte_size, quarantined_at, delete_after) \
                 VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', ?4, printf('+%d days', ?5))) \
                 ON CONFLICT(content_hash) DO UPDATE SET extension=excluded.extension, \
                   byte_size=excluded.byte_size",
                params![asset.content_hash, asset.extension, byte_size, now, retention_days],
            )
            .map_err(|error| format!("Could not record quarantined Notes asset: {error}"))?;
    }

    for asset in list_assets(trash)? {
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
                    restore_verified_trash_asset(trash, assets, &asset.name, &asset.content_hash)?;
                }
                remove_owned_file(trash, &asset.name)?;
                continue;
            }
            let retention_days = config.retention_days(asset.byte_size);
            let byte_size = i64::try_from(asset.byte_size)
                .map_err(|_| "The Notes asset byte size is too large.".to_string())?;
            connection
                .execute(
                    "INSERT INTO asset_trash(content_hash, extension, byte_size, quarantined_at, delete_after) \
                     VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', ?4, printf('+%d days', ?5)))",
                    params![asset.content_hash, asset.extension, byte_size, now, retention_days],
                )
                .map_err(|error| format!("Could not recover Notes asset trash row: {error}"))?;
        }
    }

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
        let name = PathBuf::from(format!("{content_hash}.{extension}"));
        if parse_asset_name(&name).as_ref() != Some(&(content_hash.clone(), extension.clone())) {
            return Err("The Notes asset trash row contains an unsafe file name.".to_string());
        }
        if path_exists(trash, &name)? {
            remove_owned_file(trash, &name)?;
        }
        connection
            .execute(
                "DELETE FROM asset_trash WHERE content_hash = ?1",
                [&content_hash],
            )
            .map_err(|error| format!("Could not delete expired Notes asset trash row: {error}"))?;
    }
    Ok(())
}

pub(crate) fn purge_unused_assets(vault_path: &str, confirm: bool) -> Result<PurgeReport, String> {
    let storage = AttachmentStorageLease::acquire(vault_path)?;
    let (assets, trash) = storage.asset_gc_directories()?;
    let shared = acquire_notes_connection(vault_path)?;
    let connection = lock_notes_connection(&shared)?;
    purge_unused_assets_in(&connection, &assets, &trash, confirm)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn notes_purge_unused_assets(
    vault_path: String,
    confirm: bool,
) -> Result<PurgeReport, NotesError> {
    validate_vault_path(&vault_path).map_err(NotesError::from)?;
    match tauri::async_runtime::spawn_blocking(move || purge_unused_assets(&vault_path, confirm))
        .await
    {
        Ok(result) => result.map_err(NotesError::from),
        Err(error) => Err(NotesError::new(
            NotesErrorCode::Internal,
            format!("Notes asset purge background task failed: {error}"),
        )),
    }
}

fn purge_unused_assets_in(
    connection: &Connection,
    assets: &Dir,
    trash: &Dir,
    confirm: bool,
) -> Result<PurgeReport, String> {
    let mut unused = BTreeMap::<String, (u64, Vec<(bool, PathBuf)>)>::new();
    for (is_trash, directory) in [(false, assets), (true, trash)] {
        for asset in list_assets(directory)? {
            if !has_references(connection, &asset.content_hash)? {
                let entry = unused
                    .entry(asset.content_hash)
                    .or_insert((asset.byte_size, Vec::new()));
                entry.0 = entry.0.max(asset.byte_size);
                entry.1.push((is_trash, asset.name));
            }
        }
    }
    let report = PurgeReport {
        count: u32::try_from(unused.len())
            .map_err(|_| "The Notes unused asset count is too large.".to_string())?,
        total_bytes: unused.values().try_fold(0_u64, |total, (bytes, _)| {
            total
                .checked_add(*bytes)
                .ok_or_else(|| "The Notes unused asset byte count is too large.".to_string())
        })?,
    };
    if !confirm {
        return Ok(report);
    }
    for (content_hash, (_, locations)) in unused {
        for (is_trash, name) in locations {
            remove_owned_file(if is_trash { trash } else { assets }, &name)?;
        }
        connection
            .execute(
                "DELETE FROM asset_trash WHERE content_hash = ?1",
                [&content_hash],
            )
            .map_err(|error| format!("Could not clear purged Notes asset trash: {error}"))?;
    }
    connection
        .execute(
            "DELETE FROM asset_trash WHERE NOT EXISTS(SELECT 1 FROM notes_attachments \
             WHERE notes_attachments.content_hash = asset_trash.content_hash)",
            [],
        )
        .map_err(|error| format!("Could not clear stale Notes asset trash rows: {error}"))?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::{
        copy_then_remove, inject_sync_failure_after, purge_unused_assets_in, run_asset_gc_in,
        AssetGcConfig, PurgeReport,
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
        inject_sync_failure_after(1);

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
    fn purge_dry_run_reports_then_confirm_deletes_live_and_quarantined_assets() {
        let (root, assets, trash, connection) = fixture();
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
            purge_unused_assets_in(&connection, &assets, &trash, false).unwrap(),
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
            purge_unused_assets_in(&connection, &assets, &trash, true).unwrap(),
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
}
