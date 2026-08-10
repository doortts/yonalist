use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, OpenOptions};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Identity {
    device: u64,
    file: u64,
}

fn identity(metadata: &cap_std::fs::Metadata) -> Identity {
    Identity {
        device: MetadataExt::dev(metadata),
        file: MetadataExt::ino(metadata),
    }
}

pub(super) struct HeldFile {
    file: File,
    identity: Identity,
}

impl HeldFile {
    pub(super) fn open(parent: &Dir, name: &Path) -> io::Result<Self> {
        let file = open_held_file(parent, name)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || MetadataExt::nlink(&metadata) != 1
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Export files must be regular, single-link files.",
            ));
        }
        Ok(Self {
            identity: identity(&metadata),
            file,
        })
    }

    pub(super) fn verify_at(&self, parent: &Dir, name: &Path) -> io::Result<()> {
        let current = Self::open(parent, name)?;
        if current.identity != self.identity {
            return Err(identity_changed());
        }
        Ok(())
    }

    pub(super) fn identity(&self) -> Identity {
        self.identity
    }

    pub(super) fn has_identity(&self, expected: Identity) -> bool {
        self.identity == expected
    }

    pub(super) fn read_bounded(&self, limit: usize) -> io::Result<Vec<u8>> {
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Export ownership marker is too large.",
            ));
        }
        Ok(bytes)
    }

    pub(super) fn remove_verified(self, parent: &Dir, name: &Path) -> io::Result<()> {
        self.verify_at(parent, name)?;
        parent.remove_file(name)
    }
}

#[cfg(not(windows))]
fn open_held_file(parent: &Dir, name: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    parent.open_with(name, &options)
}

#[cfg(windows)]
fn open_held_file(parent: &Dir, name: &Path) -> io::Result<File> {
    use cap_std::fs::OpenOptionsExt as CapOpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut options = OpenOptions::new();
    options.follow(FollowSymlinks::No);
    CapOpenOptionsExt::access_mode(&mut options, FILE_READ_DATA | FILE_READ_ATTRIBUTES);
    CapOpenOptionsExt::share_mode(
        &mut options,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    );
    CapOpenOptionsExt::custom_flags(&mut options, FILE_FLAG_OPEN_REPARSE_POINT);
    parent.open_with(name, &options)
}

pub(super) struct HeldDirectory {
    pub(super) directory: Dir,
    identity: Identity,
}

impl HeldDirectory {
    pub(super) fn open_ambient(path: &Path) -> io::Result<Self> {
        Self::from_dir(open_ambient_directory(path)?)
    }

    pub(super) fn from_dir(directory: Dir) -> io::Result<Self> {
        let metadata = directory.dir_metadata()?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Export directories must be regular directories.",
            ));
        }
        Ok(Self {
            identity: identity(&metadata),
            directory,
        })
    }

    pub(super) fn open(parent: &Dir, name: &Path) -> io::Result<Self> {
        let held = Self::from_dir(open_child_directory(parent, name)?)?;
        held.verify_at(parent, name)?;
        Ok(held)
    }

    pub(super) fn verify_held(&self) -> io::Result<()> {
        if identity(&self.directory.dir_metadata()?) != self.identity {
            return Err(identity_changed());
        }
        Ok(())
    }

    pub(super) fn identity(&self) -> Identity {
        self.identity
    }

    pub(super) fn has_identity(&self, expected: Identity) -> bool {
        self.identity == expected
    }

    pub(super) fn has_same_identity(&self, other: &Self) -> bool {
        self.identity == other.identity
    }

    pub(super) fn verify_at(&self, parent: &Dir, name: &Path) -> io::Result<()> {
        self.verify_held()?;
        let current = Self::from_dir(open_child_directory(parent, name)?)?;
        if current.identity != self.identity {
            return Err(identity_changed());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
fn open_ambient_directory(path: &Path) -> io::Result<Dir> {
    use cap_std::ambient_authority;

    Dir::open_ambient_dir(path, ambient_authority())
}

#[cfg(windows)]
fn open_ambient_directory(path: &Path) -> io::Result<Dir> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;

    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, DELETE, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_DELETE_CHILD,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            DELETE
                | FILE_READ_ATTRIBUTES
                | FILE_LIST_DIRECTORY
                | FILE_ADD_FILE
                | FILE_ADD_SUBDIRECTORY
                | FILE_DELETE_CHILD,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { std::fs::File::from_raw_handle(handle) };
    Ok(Dir::from_std_file(file))
}

#[cfg(not(windows))]
fn open_child_directory(parent: &Dir, name: &Path) -> io::Result<Dir> {
    use cap_fs_ext::DirExt;
    parent.open_dir_nofollow(name)
}

#[cfg(windows)]
fn open_child_directory(parent: &Dir, name: &Path) -> io::Result<Dir> {
    use cap_std::fs::OpenOptionsExt as CapOpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_DELETE_CHILD,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut options = OpenOptions::new();
    options.follow(FollowSymlinks::No);
    CapOpenOptionsExt::access_mode(
        &mut options,
        DELETE
            | FILE_READ_ATTRIBUTES
            | FILE_LIST_DIRECTORY
            | FILE_ADD_FILE
            | FILE_ADD_SUBDIRECTORY
            | FILE_DELETE_CHILD,
    );
    CapOpenOptionsExt::share_mode(
        &mut options,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    );
    CapOpenOptionsExt::custom_flags(
        &mut options,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
    );
    parent
        .open_with(name, &options)
        .map(|file| Dir::from_std_file(file.into_std()))
}

pub(super) fn write_new(parent: &Dir, name: &Path, bytes: &[u8]) -> io::Result<HeldFile> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut file = parent.open_with(name, &options)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    HeldFile::open(parent, name)
}

pub(super) fn rename_noreplace(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
) -> io::Result<()> {
    rename_noreplace_platform(from_parent, from, to_parent, to)
}

#[cfg(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "redox"
))]
fn rename_noreplace_platform(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
) -> io::Result<()> {
    rustix::fs::renameat_with(
        from_parent,
        from,
        to_parent,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(io::Error::from)
}

#[cfg(windows)]
fn rename_noreplace_platform(
    from_parent: &Dir,
    from: &Path,
    to_parent: &Dir,
    to: &Path,
) -> io::Result<()> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::io::AsRawHandle;

    use cap_std::fs::OpenOptionsExt as CapOpenOptionsExt;
    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_RENAME_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileRenameInfo,
        GetFinalPathNameByHandleW, SetFileInformationByHandle,
    };

    if !is_single_name(from) || !is_single_name(to) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Export moves require single-component names.",
        ));
    }
    let held_path = |directory: &Dir| -> io::Result<std::path::PathBuf> {
        let handle = directory.as_raw_handle() as HANDLE;
        let required = unsafe { GetFinalPathNameByHandleW(handle, std::ptr::null_mut(), 0, 0) };
        if required == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0_u16; required as usize + 1];
        let written = unsafe {
            GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
        };
        if written == 0 || written as usize >= buffer.len() {
            return Err(io::Error::last_os_error());
        }
        buffer.truncate(written as usize);
        Ok(std::path::PathBuf::from(std::ffi::OsString::from_wide(
            &buffer,
        )))
    };
    let mut options = OpenOptions::new();
    options.follow(FollowSymlinks::No);
    CapOpenOptionsExt::access_mode(&mut options, DELETE | FILE_READ_ATTRIBUTES);
    CapOpenOptionsExt::share_mode(
        &mut options,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    );
    CapOpenOptionsExt::custom_flags(
        &mut options,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    );
    let source = from_parent.open_with(from, &options)?;
    let destination = held_path(to_parent)?.join(to);
    let file_name = destination.as_os_str().encode_wide().collect::<Vec<_>>();
    let file_name_bytes = u32::try_from(file_name.len() * size_of::<u16>())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Export name is too long."))?;
    let header_len = size_of::<FILE_RENAME_INFO>() - size_of::<u16>();
    let buffer_len = header_len
        .checked_add(file_name_bytes as usize)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Export name is too long."))?;
    let mut buffer = vec![0_usize; buffer_len.div_ceil(size_of::<usize>())];
    let rename_info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    let renamed = unsafe {
        (*rename_info).Anonymous.Flags = 0;
        (*rename_info).RootDirectory = std::ptr::null_mut();
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
            u32::try_from(buffer_len).unwrap(),
        )
    };
    if renamed != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if matches!(error.raw_os_error().map(|code| code as u32), Some(code)
        if code == ERROR_ALREADY_EXISTS || code == ERROR_FILE_EXISTS)
    {
        Err(io::Error::new(io::ErrorKind::AlreadyExists, error))
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
fn rename_noreplace_platform(
    _from_parent: &Dir,
    _from: &Path,
    _to_parent: &Dir,
    _to: &Path,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Atomic no-replace export moves are unsupported.",
    ))
}

/// Windows resolves the rename through a full path it rebuilds by hand, so a
/// multi-component name there would move the wrong file. The other platforms
/// hand the name straight to `renameat`, which is already anchored to the
/// directory descriptor, so only this branch needs the check.
#[cfg(windows)]
fn is_single_name(path: &Path) -> bool {
    let mut components = path.components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

fn identity_changed() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Export path identity changed during publication.",
    )
}
