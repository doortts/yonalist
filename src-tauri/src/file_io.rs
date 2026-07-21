use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt as CapMetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions as CapOpenOptions};
use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(unix)]
use tempfile::Builder;
use tempfile::NamedTempFile;

/// Canonical message for a no-overwrite conflict, shared by every atomic write
/// and export destination check. The Notes IPC boundary maps this exact text to
/// [`crate::notes::error::NotesErrorCode::DestinationExists`], so all producers
/// must use this constant rather than an inline literal.
pub(crate) const DESTINATION_EXISTS_MESSAGE: &str = "Destination already exists.";
static CAPABILITY_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    static INJECT_CAPABILITY_AFTER_BACKUP: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECT_CAPABILITY_AFTER_CLEANUP_VERIFY: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECT_CAPABILITY_AFTER_CLEANUP_QUARANTINE_VERIFY: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECT_CAPABILITY_AFTER_RECOVERY_COPY: std::cell::RefCell<Option<Box<dyn FnOnce(&Path)>>> =
        std::cell::RefCell::new(None);
    static INJECT_CAPABILITY_AFTER_FALLBACK_LINK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
fn inject_capability_after_backup_once(action: impl FnOnce() + 'static) {
    INJECT_CAPABILITY_AFTER_BACKUP.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn inject_capability_after_cleanup_verify_once(action: impl FnOnce() + 'static) {
    INJECT_CAPABILITY_AFTER_CLEANUP_VERIFY.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn inject_capability_after_cleanup_quarantine_verify_once(action: impl FnOnce() + 'static) {
    INJECT_CAPABILITY_AFTER_CLEANUP_QUARANTINE_VERIFY.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn inject_capability_after_recovery_copy_once(action: impl FnOnce(&Path) + 'static) {
    INJECT_CAPABILITY_AFTER_RECOVERY_COPY.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn inject_capability_after_fallback_link_once(action: impl FnOnce() + 'static) {
    INJECT_CAPABILITY_AFTER_FALLBACK_LINK.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn maybe_inject_capability_after_backup() {
    INJECT_CAPABILITY_AFTER_BACKUP.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn maybe_inject_capability_after_cleanup_verify() {
    INJECT_CAPABILITY_AFTER_CLEANUP_VERIFY.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn maybe_inject_capability_after_cleanup_quarantine_verify() {
    INJECT_CAPABILITY_AFTER_CLEANUP_QUARANTINE_VERIFY.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn maybe_inject_capability_after_recovery_copy(path: &Path) {
    INJECT_CAPABILITY_AFTER_RECOVERY_COPY.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action(path);
        }
    });
}

#[cfg(test)]
fn clear_capability_after_fallback_link_injection() {
    INJECT_CAPABILITY_AFTER_FALLBACK_LINK.with(|injected| {
        injected.borrow_mut().take();
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CapabilityFileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(any(windows, test))]
const WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

#[cfg(any(windows, test))]
fn windows_file_attributes_include_reparse_point(attributes: u32) -> bool {
    attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(windows)]
fn capability_metadata_is_reparse_point(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt as CapStdWindowsMetadataExt;

    windows_file_attributes_include_reparse_point(metadata.file_attributes())
}

#[cfg(not(windows))]
fn capability_metadata_is_reparse_point(_metadata: &cap_std::fs::Metadata) -> bool {
    false
}

struct HeldCapabilityFile {
    file: cap_std::fs::File,
    identity: CapabilityFileIdentity,
}

struct HeldCapabilitySymlink {
    identity: CapabilityFileIdentity,
}

enum HeldCapabilityEntry {
    File(HeldCapabilityFile),
    Symlink(HeldCapabilitySymlink),
}

pub(crate) fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_destination_is_available(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(DESTINATION_EXISTS_MESSAGE.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn create_temp_file(parent: &Path) -> Result<NamedTempFile, String> {
    #[cfg(unix)]
    let temp_file = {
        use std::os::unix::fs::PermissionsExt;

        let mut builder = Builder::new();
        // Match File::create's requested mode and let the OS umask restrict it.
        builder.permissions(fs::Permissions::from_mode(0o666));
        builder.tempfile_in(parent)
    };

    #[cfg(not(unix))]
    let temp_file = NamedTempFile::new_in(parent);

    temp_file.map_err(|error| error.to_string())
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

fn write_atomic_file_with_parent_sync_and_revalidation(
    path: &Path,
    bytes: &[u8],
    overwrite: bool,
    mut revalidate: impl FnMut() -> Result<(), String>,
    sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    revalidate()?;
    ensure_parent(path)?;
    path.file_name()
        .ok_or_else(|| "File path must name a file.".to_string())?;
    if !overwrite {
        ensure_destination_is_available(path)?;
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut temp_file = create_temp_file(parent)?;
    temp_file
        .write_all(bytes)
        .map_err(|error| error.to_string())?;
    temp_file
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    revalidate()?;

    let result = if overwrite {
        temp_file.persist(path)
    } else {
        temp_file.persist_noclobber(path)
    };

    match result {
        Ok(_) => {
            let _ = sync_parent(parent);
            Ok(())
        }
        Err(error) if !overwrite && error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(DESTINATION_EXISTS_MESSAGE.to_string())
        }
        Err(error) => Err(error.error.to_string()),
    }
}

fn write_atomic_file_with_parent_sync(
    path: &Path,
    bytes: &[u8],
    overwrite: bool,
    sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    write_atomic_file_with_parent_sync_and_revalidation(
        path,
        bytes,
        overwrite,
        || Ok(()),
        sync_parent,
    )
}

pub(crate) fn write_atomic_file(path: &Path, bytes: &[u8], overwrite: bool) -> Result<(), String> {
    write_atomic_file_with_parent_sync(path, bytes, overwrite, sync_parent_directory)
}

fn remove_file_durable_with_parent_sync(
    path: &Path,
    sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<bool, String> {
    path.file_name()
        .ok_or_else(|| "File path must name a file.".to_string())?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let removed = match fs::remove_file(path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.to_string()),
    };
    sync_parent(parent).map_err(|error| error.to_string())?;
    Ok(removed)
}

pub(crate) fn remove_file_durable(path: &Path) -> Result<bool, String> {
    remove_file_durable_with_parent_sync(path, sync_parent_directory)
}

fn capability_path_exists(parent: &Dir, name: &Path) -> Result<bool, String> {
    match parent.symlink_metadata(name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn capability_file_identity(metadata: &cap_std::fs::Metadata) -> CapabilityFileIdentity {
    CapabilityFileIdentity {
        device: CapMetadataExt::dev(metadata),
        inode: CapMetadataExt::ino(metadata),
    }
}

fn capability_file_identity_at(
    parent: &Dir,
    name: &Path,
) -> Result<CapabilityFileIdentity, String> {
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = parent
        .open_with(name, &options)
        .map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if capability_metadata_is_reparse_point(&metadata) {
        return Err("Notes export rollback target must not be a reparse point.".to_string());
    }
    if !metadata.is_file() {
        return Err("Notes export rollback target is not a regular file.".to_string());
    }
    Ok(capability_file_identity(&metadata))
}

impl HeldCapabilityFile {
    fn open_at(parent: &Dir, name: &Path) -> Result<Self, String> {
        let mut options = CapOpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let file = parent
            .open_with(name, &options)
            .map_err(|error| error.to_string())?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if capability_metadata_is_reparse_point(&metadata) {
            return Err("Notes export destination must not be a reparse point.".to_string());
        }
        if !metadata.is_file() {
            return Err("Notes export destination must be a regular file.".to_string());
        }
        let held = Self {
            identity: capability_file_identity(&metadata),
            file,
        };
        held.verify_at(
            parent,
            name,
            "Notes export destination identity changed while opened",
        )?;
        Ok(held)
    }

    fn verify_at(&self, parent: &Dir, name: &Path, context: &str) -> Result<(), String> {
        let held_metadata = self
            .file
            .metadata()
            .map_err(|error| format!("{context}: {error}"))?;
        if capability_metadata_is_reparse_point(&held_metadata) {
            return Err(format!("{context}; the held file became a reparse point."));
        }
        let held_identity = capability_file_identity(&held_metadata);
        if held_identity != self.identity
            || capability_file_identity_at(parent, name)
                .map_err(|error| format!("{context}: {error}"))?
                != self.identity
        {
            return Err(format!("{context}."));
        }
        Ok(())
    }

    fn preserve_copy_in(&self, parent: &Dir, prefix: &str) -> Result<String, String> {
        let name = unique_capability_name(parent, prefix)?;
        let mut source = self.file.try_clone().map_err(|error| error.to_string())?;
        source
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let mut options = CapOpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut destination = parent
            .open_with(&name, &options)
            .map_err(|error| error.to_string())?;
        let destination_identity =
            capability_file_identity(&destination.metadata().map_err(|error| error.to_string())?);
        std::io::copy(&mut source, &mut destination).map_err(|error| error.to_string())?;
        destination.sync_all().map_err(|error| error.to_string())?;
        #[cfg(test)]
        maybe_inject_capability_after_recovery_copy(Path::new(&name));
        HeldCapabilityFile {
            file: destination,
            identity: destination_identity,
        }
        .verify_at(
            parent,
            Path::new(&name),
            "Notes export recovery file identity changed before reporting",
        )?;
        Ok(name)
    }
}

impl HeldCapabilitySymlink {
    fn capture_at(
        parent: &Dir,
        name: &Path,
        metadata: &cap_std::fs::Metadata,
    ) -> Result<Self, String> {
        let held = Self {
            identity: capability_file_identity(metadata),
        };
        held.verify_at(
            parent,
            name,
            "Notes export destination identity changed while captured",
        )?;
        Ok(held)
    }

    fn verify_at(&self, parent: &Dir, name: &Path, context: &str) -> Result<(), String> {
        let metadata = parent
            .symlink_metadata(name)
            .map_err(|error| format!("{context}: {error}"))?;
        if !metadata.file_type().is_symlink()
            || capability_file_identity(&metadata) != self.identity
        {
            return Err(format!("{context}."));
        }
        Ok(())
    }
}

impl HeldCapabilityEntry {
    fn verify_at(&self, parent: &Dir, name: &Path, context: &str) -> Result<(), String> {
        match self {
            Self::File(file) => file.verify_at(parent, name, context),
            Self::Symlink(symlink) => symlink.verify_at(parent, name, context),
        }
    }

    fn recovery_message(&self, parent: &Dir, current_path: &Path) -> String {
        match self {
            Self::File(file) => match file.preserve_copy_in(parent, ".yonalist-notes-old-file-") {
                Ok(path) => {
                    format!("the original file was preserved at {path} in the export directory")
                }
                Err(error) => {
                    format!("the original file could not be copied to recovery: {error}")
                }
            },
            Self::Symlink(symlink) => {
                if symlink
                    .verify_at(
                        parent,
                        current_path,
                        "Notes export original symlink identity changed",
                    )
                    .is_ok()
                {
                    format!(
                        "the original symlink was preserved at {} in the export directory",
                        current_path.display()
                    )
                } else {
                    "the original symlink could not be independently recovered after its identity changed"
                        .to_string()
                }
            }
        }
    }
}

fn existing_capability_entry(
    parent: &Dir,
    name: &Path,
) -> Result<Option<HeldCapabilityEntry>, String> {
    match parent.symlink_metadata(name) {
        Ok(metadata) if metadata.is_file() => HeldCapabilityFile::open_at(parent, name)
            .map(HeldCapabilityEntry::File)
            .map(Some),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            HeldCapabilitySymlink::capture_at(parent, name, &metadata)
                .map(HeldCapabilityEntry::Symlink)
                .map(Some)
        }
        Ok(_) => Err("Notes export destination must be a regular file or symlink.".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn unique_capability_name(parent: &Dir, prefix: &str) -> Result<String, String> {
    for _ in 0..128 {
        let sequence = CAPABILITY_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = format!("{prefix}{:x}-{sequence:x}", std::process::id());
        if !capability_path_exists(parent, Path::new(&name))? {
            return Ok(name);
        }
    }
    Err("Could not allocate a Notes export staging path.".to_string())
}

#[cfg(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "redox"
))]
pub(crate) fn rename_noreplace(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
) -> std::io::Result<()> {
    rustix::fs::renameat_with(
        from_parent,
        from,
        to_parent,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(std::io::Error::from)
}

#[cfg(windows)]
fn open_for_delete_nofollow_with_flags(
    parent: &Dir,
    path: &Path,
    desired_access: u32,
    custom_flags: u32,
) -> std::io::Result<cap_std::fs::File> {
    use cap_std::fs::OpenOptionsExt as CapOpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut options = CapOpenOptions::new();
    options.follow(FollowSymlinks::No);
    CapOpenOptionsExt::access_mode(&mut options, desired_access | DELETE | FILE_READ_ATTRIBUTES);
    CapOpenOptionsExt::share_mode(
        &mut options,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    );
    CapOpenOptionsExt::custom_flags(&mut options, custom_flags);
    parent.open_with(path, &options)
}

#[cfg(windows)]
pub(crate) fn open_for_delete_nofollow(
    parent: &Dir,
    path: &Path,
    desired_access: u32,
) -> std::io::Result<cap_std::fs::File> {
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

    let file = open_for_delete_nofollow_with_flags(
        parent,
        path,
        desired_access,
        FILE_FLAG_BACKUP_SEMANTICS,
    )?;
    if capability_metadata_is_reparse_point(&file.metadata()?) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Notes held paths must not be reparse points.",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_rename_source_nofollow(parent: &Dir, path: &Path) -> std::io::Result<cap_std::fs::File> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    open_for_delete_nofollow_with_flags(
        parent,
        path,
        0,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
    )
}

#[cfg(windows)]
pub(crate) fn rename_noreplace(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::{
        FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO,
    };

    let is_single_name = |path: &Path| {
        let mut components = path.components();
        matches!(components.next(), Some(std::path::Component::Normal(_)))
            && components.next().is_none()
    };
    if !is_single_name(from) || !is_single_name(to) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "A no-replace move requires single-component source and destination names.",
        ));
    }

    let file_name = to.as_os_str().encode_wide().collect::<Vec<_>>();
    let file_name_bytes = file_name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "A no-replace destination name is too long.",
            )
        })?;
    let buffer_len = std::mem::size_of::<FILE_RENAME_INFO>()
        .checked_add(file_name_bytes as usize)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "A no-replace destination name is too long.",
            )
        })?;
    let word_size = std::mem::size_of::<usize>();
    let word_count = buffer_len
        .checked_add(word_size - 1)
        .map(|length| length / word_size)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "A no-replace destination name is too long.",
            )
        })?;
    let mut buffer = vec![0_usize; word_count];
    let rename_info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    let buffer_len = u32::try_from(buffer_len).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "A no-replace destination name is too long.",
        )
    })?;

    let source = open_rename_source_nofollow(from_parent, from)?;
    let renamed = unsafe {
        (*rename_info).Anonymous.ReplaceIfExists = false;
        (*rename_info).RootDirectory = to_parent.as_raw_handle() as HANDLE;
        (*rename_info).FileNameLength = file_name_bytes;
        std::ptr::copy_nonoverlapping(
            file_name.as_ptr(),
            std::ptr::addr_of_mut!((*rename_info).FileName).cast::<u16>(),
            file_name.len(),
        );
        SetFileInformationByHandle(
            source.as_raw_handle() as HANDLE,
            FileRenameInfo,
            rename_info.cast(),
            buffer_len,
        )
    };
    if renamed != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if matches!(error.raw_os_error().map(|code| code as u32), Some(code) if code == ERROR_ALREADY_EXISTS || code == ERROR_FILE_EXISTS)
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            error,
        ))
    } else {
        Err(error)
    }
}

#[cfg(not(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "redox",
    windows
)))]
pub(crate) fn rename_noreplace(
    _from_parent: &Dir,
    _from: &Path,
    _to_parent: &Dir,
    _to: &Path,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Atomic no-replace moves are unsupported on this platform.",
    ))
}

fn capability_rename_noreplace(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
) -> Result<(), String> {
    rename_noreplace(from_parent, from, to_parent, to).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            DESTINATION_EXISTS_MESSAGE.to_string()
        } else {
            error.to_string()
        }
    })
}

#[cfg(test)]
fn capability_rename_noreplace_fallback(
    _from_parent: &Dir,
    _from: &Path,
    _to_parent: &Dir,
    _to: &Path,
) -> Result<(), String> {
    Err("Notes export atomic no-replace rename is unsupported on this platform.".to_string())
}

#[cfg(test)]
fn capability_rename_noreplace_windows(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
) -> Result<(), String> {
    capability_rename_noreplace(from_parent, from, to_parent, to)
}

#[cfg(unix)]
fn sync_capability_parent(parent: &Dir) -> Result<(), String> {
    match parent
        .try_clone()
        .and_then(|parent| parent.into_std_file().sync_all())
    {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(unix))]
fn sync_capability_parent(_parent: &Dir) -> Result<(), String> {
    Ok(())
}

fn remove_capability_file_if_present(parent: &Dir, name: &Path) -> Result<(), String> {
    match parent.remove_file_or_symlink(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn cleanup_held_capability_file(
    parent: &Dir,
    name: &Path,
    held: &HeldCapabilityFile,
    context: &str,
) -> Result<(), String> {
    held.verify_at(parent, name, context)?;
    remove_capability_file_if_present(parent, name)
}

fn restore_original_capability_file(
    parent: &Dir,
    backup_path: &Path,
    file_name: &Path,
    original: &HeldCapabilityEntry,
) -> Result<(), String> {
    if let Err(error) = original.verify_at(
        parent,
        backup_path,
        "Notes export original backup identity changed before rollback",
    ) {
        return Err(format!(
            "{error}; {}.",
            original.recovery_message(parent, backup_path)
        ));
    }
    if let Err(error) = capability_rename_noreplace(parent, backup_path, parent, file_name) {
        return Err(format!(
            "Notes export incomplete rollback: the destination remained occupied; the original file backup was preserved at {} in the export directory: {error}",
            backup_path.display()
        ));
    }
    original
        .verify_at(
            parent,
            file_name,
            "Notes export original file identity changed during rollback",
        )
        .map_err(|error| format!("{error}; {}.", original.recovery_message(parent, file_name)))
}

fn fail_and_restore_original_capability_file(
    parent: &Dir,
    backup_path: &Path,
    file_name: &Path,
    original: &HeldCapabilityEntry,
    failure: String,
) -> Result<(), String> {
    match restore_original_capability_file(parent, backup_path, file_name, original) {
        Ok(()) => Err(failure),
        Err(restore_error) => Err(format!("{failure}; {restore_error}")),
    }
}

fn reject_displaced_capability_replacement(
    parent: &Dir,
    backup_path: &Path,
    file_name: &Path,
    original: &HeldCapabilityEntry,
    identity_error: String,
) -> String {
    let replacement = match capability_rename_noreplace(parent, backup_path, parent, file_name) {
        Ok(()) => "the unrelated replacement was restored".to_string(),
        Err(error) => format!(
            "the unrelated replacement was preserved at {} in the export directory because restore failed: {error}",
            backup_path.display()
        ),
    };
    format!(
        "{identity_error}; {replacement}; {}.",
        original.recovery_message(parent, file_name)
    )
}

fn cleanup_original_capability_file(
    parent: &Dir,
    backup_path: &Path,
    original: &HeldCapabilityEntry,
) -> Result<(), String> {
    if let Err(error) = original.verify_at(
        parent,
        backup_path,
        "Notes export original backup identity changed before cleanup",
    ) {
        return Err(format!(
            "{error}; {}.",
            original.recovery_message(parent, backup_path)
        ));
    }
    #[cfg(test)]
    maybe_inject_capability_after_cleanup_verify();

    let quarantine_name =
        unique_capability_name(parent, ".yonalist-notes-cleanup-file-").map_err(|error| {
            format!(
                "Could not allocate a Notes export cleanup quarantine: {error}; {}.",
                original.recovery_message(parent, backup_path)
            )
        })?;
    let quarantine_path = Path::new(&quarantine_name);
    if let Err(error) = capability_rename_noreplace(parent, backup_path, parent, quarantine_path) {
        return Err(format!(
            "Could not quarantine the Notes export original backup at {} before cleanup: {error}; {}.",
            backup_path.display(),
            original.recovery_message(parent, backup_path)
        ));
    }

    if let Err(error) = original.verify_at(
        parent,
        quarantine_path,
        "Notes export original backup identity changed during cleanup quarantine",
    ) {
        return Err(reject_displaced_capability_replacement(
            parent,
            quarantine_path,
            backup_path,
            original,
            error,
        ));
    }
    #[cfg(test)]
    maybe_inject_capability_after_cleanup_quarantine_verify();
    if let Err(error) = original.verify_at(
        parent,
        quarantine_path,
        "Notes export original backup identity changed before cleanup removal",
    ) {
        return Err(reject_displaced_capability_replacement(
            parent,
            quarantine_path,
            backup_path,
            original,
            error,
        ));
    }
    remove_capability_file_if_present(parent, quarantine_path).map_err(|error| {
        format!(
            "Could not remove the verified Notes export original backup; it was preserved at {} in the export directory: {error}",
            quarantine_path.display()
        )
    })
}

fn rollback_published_capability_file(
    parent: &Dir,
    file_name: &Path,
    staged_path: &Path,
    published_identity: CapabilityFileIdentity,
) -> (Result<(), String>, bool) {
    let current_identity = match capability_file_identity_at(parent, file_name) {
        Ok(identity) => identity,
        Err(error) => {
            return (
                Err(format!(
                    "Could not verify the published Notes export before rollback: {error}"
                )),
                false,
            )
        }
    };
    if current_identity != published_identity {
        return (
            Err("Notes export published file identity changed before rollback.".to_string()),
            false,
        );
    }
    if let Err(error) = capability_rename_noreplace(parent, file_name, parent, staged_path) {
        return (Err(error), false);
    }

    match capability_file_identity_at(parent, staged_path) {
        Ok(identity) if identity == published_identity => (Ok(()), true),
        identity_result => {
            let identity_error = match identity_result {
                Ok(_) => {
                    "Notes export published file identity changed during rollback.".to_string()
                }
                Err(error) => {
                    format!("Could not verify the published Notes export during rollback: {error}")
                }
            };
            let preservation = capability_rename_noreplace(parent, staged_path, parent, file_name);
            let preservation = match preservation {
                Ok(()) => "the mismatched replacement was restored".to_string(),
                Err(error) => {
                    format!("the mismatched replacement remains preserved in staging: {error}")
                }
            };
            (Err(format!("{identity_error} {preservation}.")), false)
        }
    }
}

fn rollback_capability_publication(
    parent: &Dir,
    file_name: &Path,
    staged_path: &Path,
    staged_identity: CapabilityFileIdentity,
    backup_path: Option<&Path>,
    original: Option<&HeldCapabilityEntry>,
    failure: String,
) -> (Result<(), String>, bool) {
    let (rollback_new, rollback_owns_staged_path) =
        rollback_published_capability_file(parent, file_name, staged_path, staged_identity);
    let rollback_old = if rollback_new.is_ok() {
        match (backup_path, original) {
            (Some(backup_path), Some(original)) => {
                restore_original_capability_file(parent, backup_path, file_name, original)
            }
            _ => Ok(()),
        }
    } else {
        match (backup_path, original) {
            (Some(backup_path), Some(original)) => match original.verify_at(
                parent,
                backup_path,
                "Notes export original backup identity changed while rollback was blocked",
            ) {
                Ok(()) => Err(format!(
                    "the original file backup was retained at {} in the export directory",
                    backup_path.display()
                )),
                Err(identity_error) => Err(format!(
                    "{identity_error}; {}.",
                    original.recovery_message(parent, backup_path)
                )),
            },
            _ => Ok(()),
        }
    };
    let result = match (rollback_new, rollback_old) {
        (Ok(()), Ok(())) => Err(failure),
        (new_result, old_result) => Err(format!(
            "{failure}; Notes export rollback failed: new={}; old={}",
            new_result.err().unwrap_or_else(|| "ok".to_string()),
            old_result.err().unwrap_or_else(|| "ok".to_string())
        )),
    };
    (result, rollback_owns_staged_path)
}

pub(crate) fn write_atomic_file_in_guarded_parent(
    parent: &Dir,
    file_name: &Path,
    bytes: &[u8],
    overwrite: bool,
    mut revalidate: impl FnMut() -> Result<(), String>,
    after_final_revalidation: impl FnOnce(),
) -> Result<(), String> {
    if file_name.components().count() != 1 {
        return Err("File path must name one file in the held export directory.".to_string());
    }
    revalidate()?;
    let original = if overwrite {
        existing_capability_entry(parent, file_name)?
    } else {
        if capability_path_exists(parent, file_name)? {
            return Err(DESTINATION_EXISTS_MESSAGE.to_string());
        }
        None
    };

    let staged_name = unique_capability_name(parent, ".yonalist-notes-file-")?;
    let staged_path = Path::new(&staged_name);
    let mut options = CapOpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut staged = parent
        .open_with(staged_path, &options)
        .map_err(|error| error.to_string())?;
    let staged_identity =
        capability_file_identity(&staged.metadata().map_err(|error| error.to_string())?);
    let stage_result = staged
        .write_all(bytes)
        .and_then(|()| staged.sync_all())
        .map_err(|error| error.to_string());
    let staged = HeldCapabilityFile {
        file: staged,
        identity: staged_identity,
    };

    let mut staged_path_is_owned = true;
    let operation_result = (|| {
        stage_result?;
        let backup_name = if original.is_some() {
            Some(unique_capability_name(
                parent,
                ".yonalist-notes-replaced-file-",
            )?)
        } else {
            None
        };
        let backup_path = backup_name.as_deref().map(Path::new);
        revalidate()?;
        after_final_revalidation();
        staged.verify_at(
            parent,
            staged_path,
            "Notes export staged file identity changed before publication",
        )?;

        if let (Some(backup_path), Some(original)) = (backup_path, original.as_ref()) {
            capability_rename_noreplace(parent, file_name, parent, backup_path)?;
            if let Err(error) = original.verify_at(
                parent,
                backup_path,
                "Notes export destination identity changed before overwrite displacement",
            ) {
                return Err(reject_displaced_capability_replacement(
                    parent,
                    backup_path,
                    file_name,
                    original,
                    error,
                ));
            }
            #[cfg(test)]
            maybe_inject_capability_after_backup();
        }
        if let Err(error) = staged.verify_at(
            parent,
            staged_path,
            "Notes export staged file identity changed during publication",
        ) {
            if let (Some(backup_path), Some(original)) = (backup_path, original.as_ref()) {
                return fail_and_restore_original_capability_file(
                    parent,
                    backup_path,
                    file_name,
                    original,
                    error,
                );
            }
            return Err(error);
        }
        if let Err(error) = capability_rename_noreplace(parent, staged_path, parent, file_name) {
            if let (Some(backup_path), Some(original)) = (backup_path, original.as_ref()) {
                return fail_and_restore_original_capability_file(
                    parent,
                    backup_path,
                    file_name,
                    original,
                    error,
                );
            }
            return Err(error);
        }
        staged_path_is_owned = false;
        if let Err(error) = staged.verify_at(
            parent,
            file_name,
            "Notes export staged file identity changed after publication",
        ) {
            let (rollback, rollback_owns_staged_path) = rollback_capability_publication(
                parent,
                file_name,
                staged_path,
                staged_identity,
                backup_path,
                original.as_ref(),
                error,
            );
            staged_path_is_owned = rollback_owns_staged_path;
            return rollback;
        }
        if let Err(error) = revalidate() {
            let (rollback, rollback_owns_staged_path) = rollback_capability_publication(
                parent,
                file_name,
                staged_path,
                staged_identity,
                backup_path,
                original.as_ref(),
                error,
            );
            staged_path_is_owned = rollback_owns_staged_path;
            return rollback;
        }
        if let (Some(backup_path), Some(original)) = (backup_path, original.as_ref()) {
            cleanup_original_capability_file(parent, backup_path, original)?;
        }
        Ok(())
    })();

    let staged_cleanup = if staged_path_is_owned {
        cleanup_held_capability_file(
            parent,
            staged_path,
            &staged,
            "Notes export staged file identity changed before cleanup",
        )
    } else {
        Ok(())
    };
    let result = match (operation_result, staged_cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(cleanup_error)) => Err(cleanup_error),
        (Err(error), Err(cleanup_error)) => Err(format!(
            "{error}; Notes export staged cleanup failed: {cleanup_error}"
        )),
    };
    if result.is_ok() {
        let _ = sync_capability_parent(parent);
    }
    result
}

/// Preserves the vault writer's existing overwrite behavior while sharing the
/// byte-oriented atomic output path used by exports.
pub(crate) fn write_text_file_inner(path: &Path, contents: &str) -> Result<(), String> {
    write_atomic_file(path, contents.as_bytes(), true)
}

#[cfg(test)]
mod tests {
    use super::{
        capability_rename_noreplace_fallback, capability_rename_noreplace_windows,
        clear_capability_after_fallback_link_injection, ensure_destination_is_available,
        inject_capability_after_backup_once,
        inject_capability_after_cleanup_quarantine_verify_once,
        inject_capability_after_cleanup_verify_once, inject_capability_after_fallback_link_once,
        inject_capability_after_recovery_copy_once, remove_file_durable_with_parent_sync,
        windows_file_attributes_include_reparse_point, write_atomic_file,
        write_atomic_file_in_guarded_parent, write_atomic_file_with_parent_sync,
        HeldCapabilityFile,
    };
    use std::cell::Cell;
    use std::fs;

    #[test]
    fn write_atomic_file_writes_binary_bytes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("nested/export.bin");
        let bytes = [0, 0x9f, 0x92, 0x96, 0xff];

        write_atomic_file(&destination, &bytes, false).expect("write");

        assert_eq!(fs::read(&destination).expect("read destination"), bytes);
        assert!(!destination.with_file_name("export.bin.tmp").exists());
    }

    #[test]
    fn durable_remove_unlinks_then_syncs_the_parent_even_on_absent_retry() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("topic.md");
        fs::write(&destination, b"topic").unwrap();
        let syncs = Cell::new(0);

        assert!(remove_file_durable_with_parent_sync(&destination, |_| {
            syncs.set(syncs.get() + 1);
            Ok(())
        })
        .unwrap());
        assert!(!destination.exists());
        assert!(!remove_file_durable_with_parent_sync(&destination, |_| {
            syncs.set(syncs.get() + 1);
            Ok(())
        })
        .unwrap());
        assert_eq!(syncs.get(), 2);
    }

    #[test]
    fn durable_remove_retry_can_finish_parent_sync_after_post_unlink_failure() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("topic.md");
        fs::write(&destination, b"topic").unwrap();

        let error = remove_file_durable_with_parent_sync(&destination, |_| {
            Err(std::io::Error::other("injected parent sync failure"))
        })
        .expect_err("parent sync must fail");
        assert!(error.contains("injected parent sync failure"));
        assert!(!destination.exists());
        assert!(!remove_file_durable_with_parent_sync(&destination, |_| Ok(())).unwrap());
    }

    #[test]
    fn notes_export_atomic_file_syncs_parent_after_successful_persist() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.pdf");
        let sync_calls = Cell::new(0);

        write_atomic_file_with_parent_sync(&destination, b"%PDF-export", false, |parent| {
            sync_calls.set(sync_calls.get() + 1);
            assert_eq!(parent, temp_dir.path());
            assert_eq!(
                fs::read(&destination).expect("published before sync"),
                b"%PDF-export"
            );
            Ok(())
        })
        .expect("write and sync");

        assert_eq!(sync_calls.get(), 1);
    }

    #[test]
    fn notes_export_atomic_file_keeps_success_after_hard_parent_sync_failure() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let sync_calls = Cell::new(0);

        write_atomic_file_with_parent_sync(&destination, b"markdown", false, |_| {
            sync_calls.set(sync_calls.get() + 1);
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected hard parent sync failure",
            ))
        })
        .expect("committed file remains successful");

        assert_eq!(sync_calls.get(), 1);
        assert_eq!(fs::read(&destination).expect("committed file"), b"markdown");
    }

    #[test]
    fn no_overwrite_preflight_rejects_regular_files_and_directories() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let regular_file = temp_dir.path().join("export.md");
        let directory = temp_dir.path().join("export-directory");
        fs::write(&regular_file, b"old").expect("seed regular file");
        fs::create_dir(&directory).expect("seed directory");

        for occupied_path in [&regular_file, &directory] {
            let error = ensure_destination_is_available(occupied_path).expect_err("conflict");
            assert_eq!(error, "Destination already exists.");
        }
    }

    #[cfg(unix)]
    #[test]
    fn no_overwrite_preflight_rejects_dangling_symlinks() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        symlink("missing-target", &destination).expect("seed dangling symlink");

        let error = ensure_destination_is_available(&destination).expect_err("conflict");

        assert_eq!(error, "Destination already exists.");
    }

    #[test]
    fn write_atomic_file_leaves_an_existing_sibling_temp_file_untouched_after_success() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let sibling_temp = temp_dir.path().join("export.md.tmp");
        fs::write(&sibling_temp, b"owned by another writer").expect("seed sibling temp");

        write_atomic_file(&destination, b"new", false).expect("write");

        assert_eq!(fs::read(&destination).expect("read destination"), b"new");
        assert_eq!(
            fs::read(&sibling_temp).expect("read sibling temp"),
            b"owned by another writer"
        );
    }

    #[test]
    fn write_atomic_file_rejects_an_existing_destination_without_changing_it() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        fs::write(&destination, b"old").expect("seed destination");

        let error = write_atomic_file(&destination, b"new", false).expect_err("conflict");

        assert_eq!(error, "Destination already exists.");
        assert_eq!(fs::read(&destination).expect("read destination"), b"old");
        assert!(!temp_dir.path().join("export.md.tmp").exists());
    }

    #[test]
    fn write_atomic_file_replaces_an_existing_destination_when_allowed() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        fs::write(&destination, b"old").expect("seed destination");

        write_atomic_file(&destination, b"new", true).expect("overwrite");

        assert_eq!(fs::read(&destination).expect("read destination"), b"new");
        assert!(!temp_dir.path().join("export.md.tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_file_matches_file_create_permissions() {
        use std::os::unix::fs::MetadataExt;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let reference = temp_dir.path().join("reference.md");
        let destination = temp_dir.path().join("export.md");
        fs::File::create(&reference).expect("create reference");

        write_atomic_file(&destination, b"contents", false).expect("write");

        let reference_mode = fs::metadata(reference).expect("reference metadata").mode() & 0o777;
        let destination_mode = fs::metadata(destination)
            .expect("destination metadata")
            .mode()
            & 0o777;
        assert_eq!(destination_mode, reference_mode);
    }

    #[test]
    fn write_atomic_file_removes_its_temp_file_when_rename_fails() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        fs::create_dir(&destination).expect("seed destination directory");

        write_atomic_file(&destination, b"new", true).expect_err("rename failure");

        assert!(destination.is_dir());
        let entries: Vec<_> = fs::read_dir(temp_dir.path())
            .expect("read temp dir")
            .map(|entry| entry.expect("directory entry").file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("export.md")]);
    }

    #[test]
    fn write_atomic_file_leaves_an_existing_sibling_temp_file_untouched_after_failure() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let sibling_temp = temp_dir.path().join("export.md.tmp");
        fs::create_dir(&destination).expect("seed destination directory");
        fs::write(&sibling_temp, b"owned by another writer").expect("seed sibling temp");

        write_atomic_file(&destination, b"new", true).expect_err("rename failure");

        assert!(destination.is_dir());
        assert_eq!(
            fs::read(&sibling_temp).expect("read sibling temp"),
            b"owned by another writer"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_file_treats_a_dangling_symlink_as_an_existing_destination() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        symlink("missing-target", &destination).expect("seed dangling symlink");

        let error = write_atomic_file(&destination, b"new", false).expect_err("conflict");

        assert_eq!(error, "Destination already exists.");
        assert_eq!(
            fs::read_link(&destination).expect("read destination symlink"),
            std::path::PathBuf::from("missing-target")
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_overwrite_replaces_a_dangling_symlink_without_following_it() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        symlink("missing-target", &destination).expect("seed dangling symlink");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");

        write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            true,
            || Ok(()),
            || {},
        )
        .expect("replace dangling symlink");

        assert!(fs::symlink_metadata(&destination)
            .expect("destination metadata")
            .is_file());
        assert_eq!(fs::read(&destination).expect("read export"), b"new export");
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_overwrite_rejects_a_replacement_of_a_captured_symlink() {
        use std::os::unix::fs::symlink;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let displaced_original = temp_dir.path().join("displaced-original.md");
        symlink("missing-target", &destination).expect("seed dangling symlink");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            true,
            || Ok(()),
            || {
                fs::rename(&destination, &displaced_original).expect("displace original symlink");
                fs::write(&destination, b"unrelated replacement").expect("replace destination");
            },
        )
        .expect_err("replacement must fail the identity check");

        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            fs::read(&destination).expect("replacement survives"),
            b"unrelated replacement"
        );
        assert_eq!(
            fs::read_link(&displaced_original).expect("original symlink survives"),
            std::path::PathBuf::from("missing-target")
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_publish_rejects_a_replacement_of_the_staged_file() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let displaced_stage = temp_dir.path().join("displaced-staged-export.md");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let mut staging_path = None;

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            false,
            || Ok(()),
            || {
                let staged = fs::read_dir(temp_dir.path())
                    .expect("read export parent")
                    .filter_map(Result::ok)
                    .find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".yonalist-notes-file-")
                    })
                    .expect("find staged export")
                    .path();
                fs::rename(&staged, &displaced_stage).expect("displace staged export");
                fs::write(&staged, b"unrelated replacement").expect("replace staging path");
                staging_path = Some(staged);
            },
        )
        .expect_err("replacement must fail the staged identity check");

        assert!(error.contains("staged file identity changed"), "{error}");
        assert!(!destination.exists(), "replacement must not be published");
        assert_eq!(
            fs::read(staging_path.expect("captured staging path"))
                .expect("staging replacement survives"),
            b"unrelated replacement"
        );
        assert_eq!(
            fs::read(displaced_stage).expect("displaced staged export survives"),
            b"new export"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_staged_identity_failure_after_backup_restores_the_original() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let displaced_stage = temp_dir.path().join("displaced-staged-export.md");
        fs::write(&destination, b"old export").expect("seed destination");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let export_parent = temp_dir.path().to_path_buf();
        let raced_stage = displaced_stage.clone();
        inject_capability_after_backup_once(move || {
            let staged = fs::read_dir(&export_parent)
                .expect("read export parent")
                .filter_map(Result::ok)
                .find(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".yonalist-notes-file-")
                })
                .expect("find staged export")
                .path();
            fs::rename(&staged, &raced_stage).expect("displace staged export after backup");
            fs::write(staged, b"unrelated replacement").expect("replace staging path");
        });

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            true,
            || Ok(()),
            || {},
        )
        .expect_err("staged identity race must fail publication");

        assert!(error.contains("staged file identity changed"), "{error}");
        assert_eq!(
            fs::read(&destination).expect("original restored"),
            b"old export"
        );
        assert_eq!(
            fs::read(displaced_stage).expect("staged export survives displacement"),
            b"new export"
        );
        let backups = fs::read_dir(temp_dir.path())
            .expect("read export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-replaced-file-")
            })
            .collect::<Vec<_>>();
        assert!(backups.is_empty(), "restored backup must not be retained");
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_staged_identity_failure_reports_a_blocked_original_backup() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let displaced_stage = temp_dir.path().join("displaced-staged-export.md");
        fs::write(&destination, b"old export").expect("seed destination");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let export_parent = temp_dir.path().to_path_buf();
        let raced_destination = destination.clone();
        let raced_stage = displaced_stage.clone();
        inject_capability_after_backup_once(move || {
            let staged = fs::read_dir(&export_parent)
                .expect("read export parent")
                .filter_map(Result::ok)
                .find(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".yonalist-notes-file-")
                })
                .expect("find staged export")
                .path();
            fs::rename(&staged, &raced_stage).expect("displace staged export after backup");
            fs::write(staged, b"unrelated staged replacement").expect("replace staging path");
            fs::write(raced_destination, b"unrelated destination").expect("block original restore");
        });

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            true,
            || Ok(()),
            || {},
        )
        .expect_err("staged identity race and blocked restore must fail");

        assert_eq!(
            fs::read(&destination).expect("unrelated destination survives"),
            b"unrelated destination"
        );
        let backups = fs::read_dir(temp_dir.path())
            .expect("read export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-replaced-file-")
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1, "{error}");
        assert_eq!(
            fs::read(backups[0].path()).expect("original backup survives"),
            b"old export"
        );
        let backup_name = backups[0].file_name().to_string_lossy().into_owned();
        assert!(
            error.contains(&backup_name),
            "retained backup path missing from error: {error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_second_revalidation_failure_cleans_the_staged_file() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let revalidations = Cell::new(0);

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            false,
            || {
                revalidations.set(revalidations.get() + 1);
                if revalidations.get() == 2 {
                    Err("injected second validation failure".to_string())
                } else {
                    Ok(())
                }
            },
            || {},
        )
        .expect_err("second validation must fail");

        assert!(
            error.contains("injected second validation failure"),
            "{error}"
        );
        let staged = fs::read_dir(temp_dir.path())
            .expect("read export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-file-")
            })
            .collect::<Vec<_>>();
        assert!(staged.is_empty(), "staged export leaked after failure");
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_cleanup_preserves_a_replacement_of_the_staged_file() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let displaced_stage = temp_dir.path().join("displaced-staged-export.md");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let mut staging_path = None;

        write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            false,
            || Ok(()),
            || {
                let staged = fs::read_dir(temp_dir.path())
                    .expect("read export parent")
                    .filter_map(Result::ok)
                    .find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".yonalist-notes-file-")
                    })
                    .expect("find staged export")
                    .path();
                fs::rename(&staged, &displaced_stage).expect("displace staged export");
                fs::write(&staged, b"unrelated replacement").expect("replace staging path");
                fs::write(&destination, b"unrelated destination").expect("block publication");
                staging_path = Some(staged);
            },
        )
        .expect_err("publication must fail");

        assert_eq!(
            fs::read(&destination).expect("unrelated destination survives"),
            b"unrelated destination"
        );
        assert_eq!(
            fs::read(staging_path.expect("captured staging path"))
                .expect("staging replacement survives cleanup"),
            b"unrelated replacement"
        );
        assert_eq!(
            fs::read(displaced_stage).expect("displaced staged export survives"),
            b"new export"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_rollback_preserves_a_replacement_of_the_published_file() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let displaced_export = temp_dir.path().join("published-export.md");
        fs::write(&destination, b"old export").expect("seed destination");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let revalidations = Cell::new(0);

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            true,
            || {
                let revalidation = revalidations.get() + 1;
                revalidations.set(revalidation);
                if revalidation == 3 {
                    fs::rename(&destination, &displaced_export).expect("displace published export");
                    fs::write(&destination, b"unrelated replacement")
                        .expect("replace published export");
                    return Err("injected post-publication validation failure".to_string());
                }
                Ok(())
            },
            || {},
        )
        .expect_err("post-publication revalidation must fail");

        assert!(
            error.contains("injected post-publication validation failure"),
            "{error}"
        );
        assert_eq!(
            fs::read(&destination).expect("replacement survives rollback"),
            b"unrelated replacement"
        );
        assert_eq!(
            fs::read(&displaced_export).expect("published export survives displacement"),
            b"new export"
        );
        let old_backups = fs::read_dir(temp_dir.path())
            .expect("read export parent")
            .filter_map(|entry| {
                let entry = entry.ok()?;
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-replaced-file-")
                    .then_some(entry.path())
            })
            .collect::<Vec<_>>();
        assert_eq!(old_backups.len(), 1, "original backup must be retained");
        assert_eq!(
            fs::read(&old_backups[0]).expect("read original backup"),
            b"old export"
        );
        let backup_name = old_backups[0]
            .file_name()
            .expect("backup file name")
            .to_string_lossy();
        assert!(
            error.contains(backup_name.as_ref()),
            "retained backup path missing from error: {error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_rollback_recovers_original_when_published_and_backup_paths_change() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let displaced_export = temp_dir.path().join("published-export.md");
        let displaced_original = temp_dir.path().join("displaced-original.md");
        fs::write(&destination, b"old export").expect("seed destination");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let revalidations = Cell::new(0);
        let mut raced_backup = None;

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            true,
            || {
                let revalidation = revalidations.get() + 1;
                revalidations.set(revalidation);
                if revalidation == 3 {
                    let backup = fs::read_dir(temp_dir.path())
                        .expect("read export parent")
                        .filter_map(Result::ok)
                        .find(|entry| {
                            entry
                                .file_name()
                                .to_string_lossy()
                                .starts_with(".yonalist-notes-replaced-file-")
                        })
                        .expect("find original backup")
                        .path();
                    fs::rename(&destination, &displaced_export).expect("displace published export");
                    fs::write(&destination, b"unrelated published replacement")
                        .expect("replace published path");
                    fs::rename(&backup, &displaced_original).expect("displace original backup");
                    fs::write(&backup, b"unrelated backup replacement")
                        .expect("replace backup path");
                    raced_backup = Some(backup);
                    return Err("injected post-publication validation failure".to_string());
                }
                Ok(())
            },
            || {},
        )
        .expect_err("post-publication validation and rollback must fail");

        assert_eq!(
            fs::read(&destination).expect("published replacement survives"),
            b"unrelated published replacement"
        );
        assert_eq!(
            fs::read(raced_backup.expect("captured backup path"))
                .expect("backup replacement survives"),
            b"unrelated backup replacement"
        );
        assert_eq!(
            fs::read(displaced_export).expect("published export survives displacement"),
            b"new export"
        );
        assert_eq!(
            fs::read(displaced_original).expect("original survives displacement"),
            b"old export"
        );
        let recoveries = fs::read_dir(temp_dir.path())
            .expect("read export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-old-file-")
            })
            .collect::<Vec<_>>();
        assert_eq!(
            recoveries.len(),
            1,
            "held original was not recovered: {error}"
        );
        assert_eq!(
            fs::read(recoveries[0].path()).expect("read original recovery"),
            b"old export"
        );
        let recovery_name = recoveries[0].file_name().to_string_lossy().into_owned();
        assert!(
            error.contains(&recovery_name),
            "recovery path missing from error: {error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_overwrite_rejects_a_replacement_before_displacement() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let displaced_original = temp_dir.path().join("displaced-original.md");
        fs::write(&destination, b"old export").expect("seed destination");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            true,
            || Ok(()),
            || {
                fs::rename(&destination, &displaced_original).expect("displace original");
                fs::write(&destination, b"unrelated replacement").expect("replace destination");
            },
        )
        .expect_err("replacement must fail the identity check");

        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            fs::read(&destination).expect("replacement survives"),
            b"unrelated replacement"
        );
        assert_eq!(
            fs::read(&displaced_original).expect("original survives"),
            b"old export"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_overwrite_reports_original_backup_when_restore_is_blocked() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        fs::write(&destination, b"old export").expect("seed destination");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let raced_destination = destination.clone();
        inject_capability_after_backup_once(move || {
            fs::write(raced_destination, b"unrelated replacement")
                .expect("occupy destination after backup");
        });

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            true,
            || Ok(()),
            || {},
        )
        .expect_err("publication and restoration must fail");

        assert_eq!(
            fs::read(&destination).expect("replacement survives"),
            b"unrelated replacement"
        );
        let original_backups = fs::read_dir(temp_dir.path())
            .expect("read export parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-replaced-file-")
            })
            .collect::<Vec<_>>();
        assert_eq!(original_backups.len(), 1, "{error}");
        assert_eq!(
            fs::read(original_backups[0].path()).expect("read original backup"),
            b"old export"
        );
        let backup_name = original_backups[0]
            .file_name()
            .to_string_lossy()
            .into_owned();
        assert!(
            error.contains(&backup_name),
            "recovery path missing from error: {error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_cleanup_preserves_a_replacement_after_backup_verification() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let displaced_original = temp_dir.path().join("displaced-original.md");
        fs::write(&destination, b"old export").expect("seed destination");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let captured_backup = Rc::new(RefCell::new(None));
        let injected_backup = captured_backup.clone();
        let export_parent = temp_dir.path().to_path_buf();
        let raced_original = displaced_original.clone();
        inject_capability_after_cleanup_verify_once(move || {
            let backup = fs::read_dir(&export_parent)
                .expect("read export parent")
                .filter_map(Result::ok)
                .find(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".yonalist-notes-replaced-file-")
                })
                .expect("find verified backup")
                .path();
            fs::rename(&backup, &raced_original).expect("displace verified original backup");
            fs::write(&backup, b"unrelated replacement").expect("replace verified backup");
            *injected_backup.borrow_mut() = Some(backup);
        });

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            true,
            || Ok(()),
            || {},
        )
        .expect_err("cleanup identity race must be reported");

        assert_eq!(
            fs::read(&destination).expect("published export survives"),
            b"new export"
        );
        assert_eq!(
            fs::read(&displaced_original).expect("original survives"),
            b"old export"
        );
        let backup = captured_backup.borrow().clone().expect("captured backup");
        assert_eq!(
            fs::read(&backup).expect("replacement survives"),
            b"unrelated replacement"
        );
        let recoveries = fs::read_dir(temp_dir.path())
            .expect("read recoveries")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-old-file-")
            })
            .collect::<Vec<_>>();
        assert_eq!(recoveries.len(), 1, "{error}");
        assert_eq!(
            fs::read(recoveries[0].path()).expect("read original recovery"),
            b"old export"
        );
        let recovery_name = recoveries[0].file_name().to_string_lossy().into_owned();
        assert!(
            error.contains(&recovery_name),
            "recovery path missing from error: {error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_atomic_cleanup_preserves_a_replacement_after_quarantine_verification() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir.path().join("export.md");
        let displaced_original = temp_dir.path().join("displaced-original.md");
        fs::write(&destination, b"old export").expect("seed destination");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let captured_quarantine = Rc::new(RefCell::new(None));
        let injected_quarantine = captured_quarantine.clone();
        let export_parent = temp_dir.path().to_path_buf();
        let raced_original = displaced_original.clone();
        inject_capability_after_cleanup_quarantine_verify_once(move || {
            let quarantine = fs::read_dir(&export_parent)
                .expect("read export parent")
                .filter_map(Result::ok)
                .find(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".yonalist-notes-cleanup-file-")
                })
                .expect("find verified cleanup quarantine")
                .path();
            fs::rename(&quarantine, &raced_original).expect("displace quarantined original");
            fs::write(&quarantine, b"unrelated replacement").expect("replace cleanup quarantine");
            *injected_quarantine.borrow_mut() = Some(quarantine);
        });

        let error = write_atomic_file_in_guarded_parent(
            &parent,
            std::path::Path::new("export.md"),
            b"new export",
            true,
            || Ok(()),
            || {},
        )
        .expect_err("cleanup quarantine identity race must be reported");

        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            fs::read(&destination).expect("published export survives"),
            b"new export"
        );
        assert_eq!(
            fs::read(&displaced_original).expect("original survives displacement"),
            b"old export"
        );
        let quarantine = captured_quarantine
            .borrow()
            .clone()
            .expect("captured cleanup quarantine");
        let unrelated_survives = fs::read_dir(temp_dir.path())
            .expect("read export parent")
            .filter_map(Result::ok)
            .any(|entry| {
                fs::read(entry.path()).ok().as_deref() == Some(b"unrelated replacement".as_slice())
            });
        assert!(
            unrelated_survives,
            "replacement at {} was deleted",
            quarantine.display()
        );
    }

    #[test]
    fn held_file_recovery_rejects_a_replacement_after_copy() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let original_path = temp_dir.path().join("original.md");
        let displaced_recovery = temp_dir.path().join("displaced-recovery.md");
        fs::write(&original_path, b"old export").expect("seed original");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");
        let original = HeldCapabilityFile::open_at(&parent, std::path::Path::new("original.md"))
            .expect("hold original");
        let export_parent = temp_dir.path().to_path_buf();
        let raced_recovery = displaced_recovery.clone();
        inject_capability_after_recovery_copy_once(move |name| {
            let recovery = export_parent.join(name);
            fs::rename(&recovery, &raced_recovery).expect("displace completed recovery");
            fs::write(&recovery, b"unrelated replacement").expect("replace recovery path");
        });

        let error = original
            .preserve_copy_in(&parent, ".yonalist-notes-old-file-")
            .expect_err("replacement must fail recovery identity verification");

        assert!(error.contains("recovery file identity changed"), "{error}");
        assert_eq!(
            fs::read(&displaced_recovery).expect("completed recovery survives displacement"),
            b"old export"
        );
        let reported_path_replacement = fs::read_dir(temp_dir.path())
            .expect("read export parent")
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".yonalist-notes-old-file-")
            })
            .expect("find replacement at recovery path");
        assert_eq!(
            fs::read(reported_path_replacement.path()).expect("replacement survives"),
            b"unrelated replacement"
        );
    }

    #[test]
    fn unsupported_rename_fallback_fails_closed_before_a_source_swap() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let source = temp_dir.path().join("source.md");
        let destination = temp_dir.path().join("destination.md");
        let displaced_source = temp_dir.path().join("displaced-source.md");
        fs::write(&source, b"original source").expect("seed source");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open parent");
        let raced_source = source.clone();
        let raced_displaced_source = displaced_source.clone();
        inject_capability_after_fallback_link_once(move || {
            fs::rename(&raced_source, &raced_displaced_source).expect("displace linked source");
            fs::write(&raced_source, b"unrelated replacement").expect("replace source path");
        });

        let result = capability_rename_noreplace_fallback(
            &parent,
            std::path::Path::new("source.md"),
            &parent,
            std::path::Path::new("destination.md"),
        );
        clear_capability_after_fallback_link_injection();
        let error = result.expect_err("unsupported fallback must fail closed");

        assert!(error.contains("unsupported"), "{error}");
        assert_eq!(
            fs::read(&source).expect("source survives"),
            b"original source"
        );
        assert!(!destination.exists(), "destination must not be created");
        assert!(
            !displaced_source.exists(),
            "fallback must not begin a link/remove sequence"
        );
    }

    #[test]
    fn windows_rename_noreplace_contract_accepts_vacant_file_and_directory_destinations() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open parent");
        fs::write(temp_dir.path().join("staged.md"), b"staged export").expect("seed file");
        fs::create_dir(temp_dir.path().join("staged-assets")).expect("seed directory");
        fs::write(
            temp_dir.path().join("staged-assets/0001.png"),
            b"staged asset",
        )
        .expect("seed directory content");

        capability_rename_noreplace_windows(
            &parent,
            std::path::Path::new("staged.md"),
            &parent,
            std::path::Path::new("export.md"),
        )
        .expect("vacant file destination accepts publication");
        capability_rename_noreplace_windows(
            &parent,
            std::path::Path::new("staged-assets"),
            &parent,
            std::path::Path::new("export_assets"),
        )
        .expect("vacant directory destination accepts publication");

        assert!(!temp_dir.path().join("staged.md").exists());
        assert_eq!(
            fs::read(temp_dir.path().join("export.md")).expect("published file"),
            b"staged export"
        );
        assert!(!temp_dir.path().join("staged-assets").exists());
        assert_eq!(
            fs::read(temp_dir.path().join("export_assets/0001.png"))
                .expect("published directory content"),
            b"staged asset"
        );
    }

    #[test]
    fn windows_rename_noreplace_preserves_a_competing_publication_destination() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let staged = temp_dir.path().join("staged.md");
        let destination = temp_dir.path().join("export.md");
        let staged_assets = temp_dir.path().join("staged-assets");
        let destination_assets = temp_dir.path().join("export_assets");
        fs::write(&staged, b"staged export").expect("seed staged export");
        fs::write(&destination, b"competing destination").expect("seed competitor");
        fs::create_dir(&staged_assets).expect("seed staged assets");
        fs::write(staged_assets.join("0001.png"), b"staged asset").expect("seed staged asset");
        fs::create_dir(&destination_assets).expect("seed competing assets");
        fs::write(destination_assets.join("owned.txt"), b"competing asset")
            .expect("seed competing asset");
        let parent =
            cap_std::fs::Dir::open_ambient_dir(temp_dir.path(), cap_std::ambient_authority())
                .expect("open export parent");

        let error = capability_rename_noreplace_windows(
            &parent,
            std::path::Path::new("staged.md"),
            &parent,
            std::path::Path::new("export.md"),
        )
        .expect_err("publication must fail when a competitor owns the destination");
        let directory_error = capability_rename_noreplace_windows(
            &parent,
            std::path::Path::new("staged-assets"),
            &parent,
            std::path::Path::new("export_assets"),
        )
        .expect_err("directory publication must preserve a competing destination");

        assert_eq!(error, "Destination already exists.");
        assert_eq!(directory_error, "Destination already exists.");
        assert_eq!(
            fs::read(&destination).expect("competitor survives"),
            b"competing destination"
        );
        assert_eq!(
            fs::read(&staged).expect("staged export remains unpublished"),
            b"staged export"
        );
        assert_eq!(
            fs::read(destination_assets.join("owned.txt")).expect("competing asset survives"),
            b"competing asset"
        );
        assert_eq!(
            fs::read(staged_assets.join("0001.png")).expect("staged asset remains unpublished"),
            b"staged asset"
        );
    }

    #[test]
    fn windows_reparse_attribute_predicate_rejects_every_reparse_tag_shape() {
        assert!(!windows_file_attributes_include_reparse_point(0));
        assert!(windows_file_attributes_include_reparse_point(0x0000_0400));
        assert!(windows_file_attributes_include_reparse_point(
            0x0000_0400 | 0x0000_0010 | 0x0000_0020
        ));
    }

    #[test]
    fn windows_noreplace_source_contract_is_shared_by_exports_and_attachments() {
        let file_io = include_str!("file_io.rs");
        let export = include_str!("notes/export.rs");
        let attachments = include_str!("notes/attachments.rs");
        let set_information = ["SetFileInformation", "ByHandle"].concat();
        let replace = ["ReplaceIf", "Exists = false"].concat();
        let root = ["Root", "Directory ="].concat();
        let backup = ["FILE_FLAG_BACKUP", "_SEMANTICS"].concat();
        let unsupported = ["atomic no-replace rename is unsupported", " on Windows"].concat();
        let delete_open = ["open_for_delete_", "nofollow"].concat();
        let rename_source_open = ["open_rename_source_", "nofollow"].concat();
        let reparse_source_flags = [
            "FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_",
            "SEMANTICS",
        ]
        .concat();
        let delete_share = ["FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_", "DELETE"].concat();
        let strips_delete_share = ["maybe_dir", "(true)"].concat();

        assert!(file_io.contains(&set_information));
        assert!(file_io.contains(&replace));
        assert!(file_io.contains(&root));
        assert!(file_io.contains(&backup));
        assert!(file_io.contains(&delete_open));
        assert!(file_io.contains(&rename_source_open));
        assert!(file_io.contains(&reparse_source_flags));
        assert!(file_io.contains(&format!("let source = {rename_source_open}(")));
        assert!(file_io.contains(&delete_share));
        assert!(!file_io.contains(&strips_delete_share));
        assert!(export.contains("crate::file_io::rename_noreplace"));
        assert!(export.matches(&delete_open).count() >= 2);
        assert!(attachments.contains("crate::file_io::rename_noreplace"));
        assert!(!attachments.contains(&set_information));
        assert!(!export.contains(&unsupported));
        assert!(!export.contains(
            "#[cfg(not(windows))]\nuse cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};"
        ));
    }

    // Darwin rejects malformed UTF-8 filename bytes before the persistence call,
    // so Apple targets cannot exercise this behavior.
    #[cfg(all(unix, not(target_vendor = "apple")))]
    #[test]
    fn write_atomic_file_supports_a_non_utf8_output_filename() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let temp_dir = tempfile::tempdir().expect("temp dir");
        let destination = temp_dir
            .path()
            .join(OsString::from_vec(b"export-\xff.md".to_vec()));

        write_atomic_file(&destination, b"contents", false).expect("write");

        assert_eq!(
            fs::read(destination).expect("read destination"),
            b"contents"
        );
    }
}
