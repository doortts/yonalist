#[cfg(unix)]
use cap_fs_ext::OpenOptionsExt;
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt as CapMetadataExt, OpenOptionsFollowExt};
use cap_std::ambient_authority;
#[cfg(not(windows))]
use cap_std::fs::DirBuilder;
#[cfg(unix)]
use cap_std::fs::DirBuilderExt as CapDirBuilderExt;
use cap_std::fs::{Dir, OpenOptions as CapOpenOptions};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
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

#[cfg(windows)]
pub(crate) const WINDOWS_PRIVATE_DIRECTORY_ACE_FLAGS: u32 =
    windows_sys::Win32::Security::OBJECT_INHERIT_ACE
        | windows_sys::Win32::Security::CONTAINER_INHERIT_ACE;

#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WindowsFileInformation {
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) link_count: u64,
    pub(crate) attributes: u32,
}

#[cfg(windows)]
pub(crate) fn windows_file_information_from_handle(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> std::io::Result<WindowsFileInformation> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(WindowsFileInformation {
        device: u64::from(information.dwVolumeSerialNumber),
        inode: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        link_count: u64::from(information.nNumberOfLinks),
        attributes: information.dwFileAttributes,
    })
}

#[cfg(windows)]
pub(crate) fn windows_file_information_at(path: &Path) -> std::io::Result<WindowsFileInformation> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
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
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    windows_file_information_from_handle(handle.as_raw_handle() as HANDLE)
}

#[cfg(windows)]
struct WindowsPrivateAcl {
    sid: Vec<usize>,
    acl: Vec<usize>,
}

#[cfg(windows)]
fn windows_aligned_buffer(byte_len: u32) -> Vec<usize> {
    let word_size = std::mem::size_of::<usize>();
    vec![0; (byte_len as usize + word_size - 1) / word_size]
}

#[cfg(windows)]
impl WindowsPrivateAcl {
    fn current_user(ace_flags: u32) -> Result<Self, String> {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::Security::{
            AddAccessAllowedAceEx, CopySid, GetLengthSid, GetTokenInformation, InitializeAcl,
            IsValidSid, TokenUser, ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, PSID, TOKEN_USER,
        };
        use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

        const CURRENT_PROCESS_TOKEN: HANDLE = -4_isize as HANDLE;

        let mut token_bytes = 0_u32;
        unsafe {
            GetTokenInformation(
                CURRENT_PROCESS_TOKEN,
                TokenUser,
                std::ptr::null_mut(),
                0,
                &mut token_bytes,
            );
        }
        if token_bytes == 0 {
            return Err(format!(
                "Could not size the current Windows user token: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut token = windows_aligned_buffer(token_bytes);
        if unsafe {
            GetTokenInformation(
                CURRENT_PROCESS_TOKEN,
                TokenUser,
                token.as_mut_ptr().cast(),
                token_bytes,
                &mut token_bytes,
            )
        } == 0
        {
            return Err(format!(
                "Could not read the current Windows user token: {}",
                std::io::Error::last_os_error()
            ));
        }
        let token_user = unsafe { &*(token.as_ptr().cast::<TOKEN_USER>()) };
        if unsafe { IsValidSid(token_user.User.Sid) } == 0 {
            return Err("The current Windows user token contains an invalid SID.".to_string());
        }
        let sid_len = unsafe { GetLengthSid(token_user.User.Sid) };
        if sid_len == 0 {
            return Err("The current Windows user SID has an invalid length.".to_string());
        }
        let mut sid = windows_aligned_buffer(sid_len);
        if unsafe {
            CopySid(
                sid_len,
                sid.as_mut_ptr().cast::<std::ffi::c_void>() as PSID,
                token_user.User.Sid,
            )
        } == 0
        {
            return Err(format!(
                "Could not copy the current Windows user SID: {}",
                std::io::Error::last_os_error()
            ));
        }

        let ace_size = std::mem::size_of::<ACCESS_ALLOWED_ACE>()
            .checked_sub(std::mem::size_of::<u32>())
            .and_then(|size| size.checked_add(sid_len as usize))
            .ok_or_else(|| "The private Windows ACL size overflowed.".to_string())?;
        let acl_size = std::mem::size_of::<ACL>()
            .checked_add(ace_size)
            .ok_or_else(|| "The private Windows ACL size overflowed.".to_string())?;
        let acl_size = u32::try_from(acl_size)
            .map_err(|_| "The private Windows ACL is too large.".to_string())?;
        let mut acl = windows_aligned_buffer(acl_size);
        let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
        if unsafe { InitializeAcl(acl_ptr, acl_size, ACL_REVISION) } == 0
            || unsafe {
                AddAccessAllowedAceEx(
                    acl_ptr,
                    ACL_REVISION,
                    ace_flags,
                    FILE_ALL_ACCESS,
                    sid.as_mut_ptr().cast::<std::ffi::c_void>() as PSID,
                )
            } == 0
        {
            return Err(format!(
                "Could not build the private Windows ACL: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self { sid, acl })
    }

    fn sid_ptr(&self) -> windows_sys::Win32::Security::PSID {
        self.sid.as_ptr().cast::<std::ffi::c_void>() as *mut std::ffi::c_void
    }

    fn acl_ptr(&self) -> *mut windows_sys::Win32::Security::ACL {
        self.acl
            .as_ptr()
            .cast::<windows_sys::Win32::Security::ACL>() as *mut _
    }
}

#[cfg(windows)]
fn windows_security_descriptor(
    handle: windows_sys::Win32::Foundation::HANDLE,
    information: u32,
    context: &str,
) -> Result<Vec<usize>, String> {
    use windows_sys::Win32::Security::GetKernelObjectSecurity;

    let mut bytes = 0_u32;
    unsafe {
        GetKernelObjectSecurity(handle, information, std::ptr::null_mut(), 0, &mut bytes);
    }
    if bytes == 0 {
        return Err(format!(
            "Could not size {context} security information: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut descriptor = windows_aligned_buffer(bytes);
    if unsafe {
        GetKernelObjectSecurity(
            handle,
            information,
            descriptor.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(format!(
            "Could not read {context} security information: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(descriptor)
}

#[cfg(windows)]
pub(crate) fn validate_windows_private_handle(
    handle: windows_sys::Win32::Foundation::HANDLE,
    directory: bool,
    expected_ace_flags: u32,
    context: &str,
) -> Result<(), String> {
    use windows_sys::Win32::Security::{
        AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner,
        ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_AUTO_INHERITED,
        SE_DACL_PROTECTED,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, FileStandardInfo, GetFileInformationByHandleEx, FILE_ALL_ACCESS,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_STANDARD_INFO,
    };

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    let mut attributes = FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            (&mut attributes as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
        || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(format!("{context} must not be a reparse point."));
    }
    let mut standard = FILE_STANDARD_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            (&mut standard as *mut FILE_STANDARD_INFO).cast(),
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    } == 0
        || standard.Directory != directory
        || (!directory && standard.NumberOfLinks != 1)
    {
        return Err(format!("{context} has an unsafe type or link count."));
    }

    let expected = WindowsPrivateAcl::current_user(expected_ace_flags)?;
    let descriptor = windows_security_descriptor(
        handle,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        context,
    )?;
    let descriptor_ptr = descriptor.as_ptr().cast::<std::ffi::c_void>() as PSECURITY_DESCRIPTOR;
    let mut owner: PSID = std::ptr::null_mut();
    let mut owner_defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(descriptor_ptr, &mut owner, &mut owner_defaulted) } == 0
        || owner.is_null()
        || owner_defaulted != 0
        || unsafe { EqualSid(owner, expected.sid_ptr()) } == 0
    {
        return Err(format!("{context} owner does not match the current user."));
    }
    let mut control = 0_u16;
    let mut revision = 0_u32;
    if unsafe { GetSecurityDescriptorControl(descriptor_ptr, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
        || control & SE_DACL_AUTO_INHERITED != 0
    {
        return Err(format!(
            "{context} DACL must be protected from inheritance."
        ));
    }
    let mut dacl_present = 0;
    let mut dacl_defaulted = 0;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    if unsafe {
        GetSecurityDescriptorDacl(
            descriptor_ptr,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        )
    } == 0
        || dacl_present == 0
        || dacl.is_null()
        || dacl_defaulted != 0
        || unsafe { (*dacl).AclRevision } != ACL_REVISION as u8
    {
        return Err(format!("{context} DACL is invalid."));
    }
    let mut acl_info = ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut acl_info as *mut ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
        || acl_info.AceCount != 1
        || acl_info.AclBytesFree != 0
    {
        return Err(format!(
            "{context} DACL must contain exactly one access rule."
        ));
    }
    let mut ace_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    if unsafe { GetAce(dacl, 0, &mut ace_ptr) } == 0 || ace_ptr.is_null() {
        return Err(format!("Could not inspect {context} access rule."));
    }
    let ace = unsafe { &*(ace_ptr.cast::<ACCESS_ALLOWED_ACE>()) };
    let ace_sid = (&ace.SidStart as *const u32).cast::<std::ffi::c_void>() as PSID;
    let expected_ace_size = std::mem::size_of::<ACCESS_ALLOWED_ACE>()
        .checked_sub(std::mem::size_of::<u32>())
        .and_then(|size| unsafe {
            GetLengthSid(expected.sid_ptr())
                .try_into()
                .ok()
                .and_then(|sid_len: usize| size.checked_add(sid_len))
        })
        .ok_or_else(|| format!("{context} access-rule size overflowed."))?;
    if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE
        || ace.Header.AceFlags != expected_ace_flags as u8
        || ace.Header.AceSize as usize != expected_ace_size
        || ace.Mask != FILE_ALL_ACCESS
        || unsafe { EqualSid(ace_sid, expected.sid_ptr()) } == 0
    {
        return Err(format!("{context} DACL grants unexpected access."));
    }
    Ok(())
}

#[cfg(windows)]
fn reopen_windows_directory_security_handle(
    directory: &Dir,
    desired_access: u32,
    context: &str,
) -> Result<std::os::windows::io::OwnedHandle, String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        ReOpenFile, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let handle = unsafe {
        ReOpenFile(
            directory.as_raw_handle() as HANDLE,
            desired_access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Could not reopen {context} security handle: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

#[cfg(windows)]
pub(crate) fn validate_windows_private_directory_security(
    directory: &Dir,
    context: &str,
) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::READ_CONTROL;

    let handle = reopen_windows_directory_security_handle(directory, READ_CONTROL, context)?;
    validate_windows_private_handle(
        handle.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE,
        true,
        WINDOWS_PRIVATE_DIRECTORY_ACE_FLAGS,
        context,
    )
}

#[cfg(windows)]
pub(crate) fn establish_windows_private_directory_security(
    directory: &Dir,
    context: &str,
) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Security::Authorization::{SetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    };
    use windows_sys::Win32::Storage::FileSystem::{READ_CONTROL, WRITE_DAC, WRITE_OWNER};

    let private = WindowsPrivateAcl::current_user(WINDOWS_PRIVATE_DIRECTORY_ACE_FLAGS)?;
    let dacl_handle =
        reopen_windows_directory_security_handle(directory, READ_CONTROL | WRITE_DAC, context)?;
    let result = unsafe {
        SetSecurityInfo(
            dacl_handle.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            private.acl_ptr(),
            std::ptr::null_mut(),
        )
    };
    if result != 0 {
        return Err(format!(
            "Could not protect {context} DACL: {}",
            std::io::Error::from_raw_os_error(result as i32)
        ));
    }
    drop(dacl_handle);

    let owner_handle =
        reopen_windows_directory_security_handle(directory, READ_CONTROL | WRITE_OWNER, context)?;
    let result = unsafe {
        SetSecurityInfo(
            owner_handle.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            private.sid_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result != 0 {
        return Err(format!(
            "Could not set {context} owner: {}",
            std::io::Error::from_raw_os_error(result as i32)
        ));
    }
    validate_windows_private_handle(
        owner_handle.as_raw_handle() as HANDLE,
        true,
        WINDOWS_PRIVATE_DIRECTORY_ACE_FLAGS,
        context,
    )
}

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
    static INJECT_CAPABILITY_AFTER_READ_PARENT_INSPECT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static INJECT_CAPABILITY_AFTER_RETIREMENT_DIRECTORY_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
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
fn inject_capability_after_read_parent_inspect_once(action: impl FnOnce() + 'static) {
    INJECT_CAPABILITY_AFTER_READ_PARENT_INSPECT.with(|injected| {
        *injected.borrow_mut() = Some(Box::new(action));
    });
}

#[cfg(test)]
fn inject_capability_after_retirement_directory_open_once(action: impl FnOnce() + 'static) {
    INJECT_CAPABILITY_AFTER_RETIREMENT_DIRECTORY_OPEN.with(|injected| {
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

#[cfg(test)]
fn maybe_inject_capability_after_read_parent_inspect() {
    INJECT_CAPABILITY_AFTER_READ_PARENT_INSPECT.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(test)]
fn maybe_inject_capability_after_retirement_directory_open() {
    INJECT_CAPABILITY_AFTER_RETIREMENT_DIRECTORY_OPEN.with(|injected| {
        if let Some(action) = injected.borrow_mut().take() {
            action();
        }
    });
}

#[cfg(not(test))]
fn maybe_inject_capability_after_retirement_directory_open() {}

#[cfg(not(test))]
fn maybe_inject_capability_after_read_parent_inspect() {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CapabilityFileIdentity {
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
pub(crate) fn capability_metadata_is_reparse_point(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt as CapStdWindowsMetadataExt;

    windows_file_attributes_include_reparse_point(metadata.file_attributes())
}

#[cfg(not(windows))]
pub(crate) fn capability_metadata_is_reparse_point(_metadata: &cap_std::fs::Metadata) -> bool {
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

fn rollback_guarded_file_removal(
    parent: &Dir,
    backup_path: &Path,
    file_name: &Path,
    original: &HeldCapabilityEntry,
    failure: String,
) -> Result<bool, String> {
    match restore_original_capability_file(parent, backup_path, file_name, original) {
        Ok(()) => match sync_capability_parent(parent) {
            Ok(()) => Err(failure),
            Err(sync_error) => Err(format!(
                "{failure}; Notes removal rollback parent sync failed: {sync_error}"
            )),
        },
        Err(restore_error) => Err(format!(
            "{failure}; Notes removal rollback failed: {restore_error}"
        )),
    }
}

pub(crate) fn remove_file_durable_in_guarded_parent(
    parent: &Dir,
    file_name: &Path,
    held: Option<HeldBoundedCapabilityFile>,
    mut revalidate: impl FnMut() -> Result<(), String>,
    after_isolation: impl FnOnce(),
    commit: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    if file_name.components().count() != 1 {
        return Err("File path must name one file in the held export directory.".to_string());
    }
    revalidate()?;
    let Some(held) = held else {
        match parent.symlink_metadata(file_name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(
                    "Notes removal source appeared after its absence was captured.".to_string(),
                )
            }
            Err(error) => return Err(error.to_string()),
        }
        revalidate()?;
        commit()?;
        return Ok(false);
    };
    let metadata = held
        .metadata()
        .map_err(|error| format!("Could not inspect held Notes removal source: {error}"))?;
    if capability_metadata_is_reparse_point(&metadata) || !metadata.is_file() {
        return Err("Notes removal source must be a regular file.".to_string());
    }
    if capability_file_link_count(&metadata).map_err(|error| error.to_string())? != 1 {
        return Err("Notes removal source must not have multiple hard links.".to_string());
    }
    let original = HeldCapabilityEntry::File(HeldCapabilityFile {
        file: held.file.try_clone().map_err(|error| error.to_string())?,
        identity: held.identity,
    });
    let backup_name = unique_capability_name(parent, ".yonalist-notes-removed-file-")?;
    let backup_path = Path::new(&backup_name);
    revalidate()?;
    original.verify_at(
        parent,
        file_name,
        "Notes removal source identity changed before isolation",
    )?;
    capability_rename_noreplace(parent, file_name, parent, backup_path)?;
    if let Err(error) = original.verify_at(
        parent,
        backup_path,
        "Notes removal source identity changed during isolation",
    ) {
        let restoration = capability_rename_noreplace(parent, backup_path, parent, file_name)
            .map(|()| "the displaced entry was restored".to_string())
            .unwrap_or_else(|restore_error| {
                format!(
                    "the displaced entry was preserved at {} because restore failed: {restore_error}",
                    backup_path.display()
                )
        });
        return Err(format!("{error}; {restoration}."));
    }
    if let Err(error) = sync_capability_parent(parent) {
        return rollback_guarded_file_removal(
            parent,
            backup_path,
            file_name,
            &original,
            format!("Could not durably isolate Notes removal source: {error}"),
        );
    }
    after_isolation();
    if let Err(error) = revalidate() {
        return rollback_guarded_file_removal(parent, backup_path, file_name, &original, error);
    }
    match parent.symlink_metadata(file_name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return rollback_guarded_file_removal(
                parent,
                backup_path,
                file_name,
                &original,
                "Notes removal source path was occupied before commit.".to_string(),
            )
        }
        Err(error) => {
            return rollback_guarded_file_removal(
                parent,
                backup_path,
                file_name,
                &original,
                format!("Could not verify the Notes removal source path before commit: {error}"),
            )
        }
    }
    if let Err(error) = commit() {
        return rollback_guarded_file_removal(parent, backup_path, file_name, &original, error);
    }
    // The database commit makes the source retirement authoritative. Cleanup
    // is best-effort after that boundary; on failure the identity-bound hidden
    // backup remains available for recovery instead of turning a committed
    // operation into a retryable failure.
    let _ = cleanup_original_capability_file(parent, backup_path, &original);
    let _ = sync_capability_parent(parent);
    Ok(true)
}

fn capability_path_exists(parent: &Dir, name: &Path) -> Result<bool, String> {
    match parent.symlink_metadata(name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(any(windows, test))]
fn windows_file_identity_from_optional_fields(
    volume_serial_number: Option<u32>,
    file_index: Option<u64>,
) -> std::io::Result<CapabilityFileIdentity> {
    let device = volume_serial_number.map(u64::from).ok_or_else(|| {
        std::io::Error::other("file metadata does not contain a Windows volume serial number")
    })?;
    let inode = file_index.ok_or_else(|| {
        std::io::Error::other("file metadata does not contain a Windows file index")
    })?;
    Ok(CapabilityFileIdentity { device, inode })
}

#[cfg(any(windows, test))]
fn windows_file_link_count_from_optional_field(
    number_of_links: Option<u32>,
) -> std::io::Result<u64> {
    number_of_links
        .map(u64::from)
        .ok_or_else(|| std::io::Error::other("file metadata does not contain a Windows link count"))
}

pub(crate) trait TryCapabilityFileIdentity {
    fn try_capability_file_identity(&self) -> std::io::Result<CapabilityFileIdentity>;
}

pub(crate) trait TryCapabilityFileLinkCount {
    fn try_capability_file_link_count(&self) -> std::io::Result<u64>;
}

#[cfg(not(windows))]
impl<T: CapMetadataExt> TryCapabilityFileIdentity for T {
    fn try_capability_file_identity(&self) -> std::io::Result<CapabilityFileIdentity> {
        Ok(CapabilityFileIdentity {
            device: CapMetadataExt::dev(self),
            inode: CapMetadataExt::ino(self),
        })
    }
}

#[cfg(not(windows))]
impl<T: CapMetadataExt> TryCapabilityFileLinkCount for T {
    fn try_capability_file_link_count(&self) -> std::io::Result<u64> {
        Ok(CapMetadataExt::nlink(self))
    }
}

#[cfg(windows)]
impl TryCapabilityFileIdentity for cap_std::fs::Metadata {
    fn try_capability_file_identity(&self) -> std::io::Result<CapabilityFileIdentity> {
        Ok(CapabilityFileIdentity {
            device: CapMetadataExt::dev(self),
            inode: CapMetadataExt::ino(self),
        })
    }
}

#[cfg(windows)]
impl TryCapabilityFileLinkCount for cap_std::fs::Metadata {
    fn try_capability_file_link_count(&self) -> std::io::Result<u64> {
        Ok(CapMetadataExt::nlink(self))
    }
}

fn try_capability_file_identity(
    metadata: &impl TryCapabilityFileIdentity,
) -> std::io::Result<CapabilityFileIdentity> {
    metadata.try_capability_file_identity()
}

pub(crate) fn capability_file_identity(
    metadata: &impl TryCapabilityFileIdentity,
) -> std::io::Result<(u64, u64)> {
    try_capability_file_identity(metadata).map(|identity| (identity.device, identity.inode))
}

pub(crate) fn capability_file_link_count(
    metadata: &impl TryCapabilityFileLinkCount,
) -> std::io::Result<u64> {
    metadata.try_capability_file_link_count()
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
    try_capability_file_identity(&metadata).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn ambient_metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    windows_file_attributes_include_reparse_point(metadata.file_attributes())
}

#[cfg(not(windows))]
fn ambient_metadata_is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn inspect_ambient_read_parent(path: &Path) -> std::io::Result<CapabilityFileIdentity> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    for component in absolute.components() {
        if component == Component::ParentDir {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "held read parent must not contain traversal",
            ));
        }
    }
    let metadata = fs::symlink_metadata(&absolute)?;
    if ambient_metadata_is_reparse_point(&metadata) || !metadata.file_type().is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "held read parent must be a real directory",
        ));
    }
    #[cfg(not(windows))]
    {
        try_capability_file_identity(&metadata)
    }
    #[cfg(windows)]
    {
        let information = windows_file_information_at(&absolute)?;
        Ok(CapabilityFileIdentity {
            device: information.device,
            inode: information.inode,
        })
    }
}

struct HeldCapabilityDirectory {
    path: PathBuf,
    dir: Dir,
    identity: CapabilityFileIdentity,
}

impl HeldCapabilityDirectory {
    fn open_ambient(path: &Path) -> std::io::Result<Self> {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()?.join(path)
        };
        let inspected_identity = inspect_ambient_read_parent(&absolute)?;
        maybe_inject_capability_after_read_parent_inspect();
        let dir = Dir::open_ambient_dir(&absolute, ambient_authority())?;
        let metadata = dir.dir_metadata()?;
        let opened_identity = try_capability_file_identity(&metadata)?;
        if capability_metadata_is_reparse_point(&metadata)
            || !metadata.is_dir()
            || opened_identity != inspected_identity
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "held read parent identity changed while opening",
            ));
        }
        let held = Self {
            path: absolute,
            identity: opened_identity,
            dir,
        };
        held.verify_ambient()?;
        Ok(held)
    }

    fn verify_ambient(&self) -> std::io::Result<()> {
        let held_metadata = self.dir.dir_metadata()?;
        let held_identity = try_capability_file_identity(&held_metadata)?;
        if capability_metadata_is_reparse_point(&held_metadata)
            || !held_metadata.is_dir()
            || held_identity != self.identity
        {
            return Err(std::io::Error::other("held read parent identity changed"));
        }
        let current_path_identity = inspect_ambient_read_parent(&self.path)?;
        if current_path_identity != self.identity {
            return Err(std::io::Error::other(
                "held read parent pathname identity changed",
            ));
        }
        let current = Dir::open_ambient_dir(&self.path, ambient_authority())?;
        let current_metadata = current.dir_metadata()?;
        let current_identity = try_capability_file_identity(&current_metadata)?;
        if capability_metadata_is_reparse_point(&current_metadata)
            || !current_metadata.is_dir()
            || current_identity != self.identity
        {
            return Err(std::io::Error::other(
                "held read parent pathname identity changed",
            ));
        }
        Ok(())
    }
}

fn open_capability_read_file_nofollow(
    parent: &Dir,
    name: &Path,
) -> std::io::Result<(cap_std::fs::File, CapabilityFileIdentity)> {
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    let file = parent.open_with(name, &options)?;
    let metadata = file.metadata()?;
    if capability_metadata_is_reparse_point(&metadata) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "held read target must not be a reparse point",
        ));
    }
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "held read target must be a regular file",
        ));
    }
    let identity = try_capability_file_identity(&metadata)?;
    Ok((file, identity))
}

fn verify_capability_read_file_at(
    parent: &Dir,
    name: &Path,
    held: &cap_std::fs::File,
    expected_identity: CapabilityFileIdentity,
) -> std::io::Result<()> {
    let held_metadata = held.metadata()?;
    let held_identity = try_capability_file_identity(&held_metadata)?;
    if capability_metadata_is_reparse_point(&held_metadata)
        || !held_metadata.is_file()
        || held_identity != expected_identity
    {
        return Err(std::io::Error::other("held read target identity changed"));
    }
    let (_current, current_identity) = open_capability_read_file_nofollow(parent, name)?;
    if current_identity != expected_identity {
        return Err(std::io::Error::other("held read pathname identity changed"));
    }
    Ok(())
}

fn verify_capability_directory_at(
    parent: &Dir,
    name: &Path,
    expected_identity: CapabilityFileIdentity,
) -> std::io::Result<()> {
    let current = parent.open_dir_nofollow(name)?;
    let metadata = current.dir_metadata()?;
    let current_identity = try_capability_file_identity(&metadata)?;
    if capability_metadata_is_reparse_point(&metadata)
        || !metadata.is_dir()
        || current_identity != expected_identity
    {
        return Err(std::io::Error::other(
            "held directory pathname identity changed",
        ));
    }
    Ok(())
}

pub(crate) struct HeldBoundedCapabilityFile {
    file: cap_std::fs::File,
    identity: CapabilityFileIdentity,
    byte_size: u64,
    max_bytes: u64,
}

impl HeldBoundedCapabilityFile {
    pub(crate) fn try_clone_held(&self) -> std::io::Result<Self> {
        Ok(Self {
            file: self.file.try_clone()?,
            identity: self.identity,
            byte_size: self.byte_size,
            max_bytes: self.max_bytes,
        })
    }

    #[cfg(test)]
    pub(crate) fn inspect_capability_file(&self, inspect: impl FnOnce(&cap_std::fs::File)) {
        inspect(&self.file);
    }

    pub(crate) fn reader_from_start(&self) -> std::io::Result<BoundedCapabilityReader> {
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        Ok(BoundedCapabilityReader {
            file,
            max_bytes: self.max_bytes,
            consumed: 0,
        })
    }

    pub(crate) fn metadata(&self) -> std::io::Result<cap_std::fs::Metadata> {
        self.file.metadata()
    }

    pub(crate) fn byte_size(&self) -> u64 {
        self.byte_size
    }

    pub(crate) fn identity(&self) -> (u64, u64) {
        (self.identity.device, self.identity.inode)
    }

    pub(crate) fn verify_at(&self, parent: &Dir, name: &Path) -> std::io::Result<()> {
        verify_capability_read_file_at(parent, name, &self.file, self.identity)
    }

    pub(crate) fn truncate_and_sync(self) -> std::io::Result<()> {
        self.file.set_len(0)?;
        self.file.sync_all()
    }
}

pub(crate) fn hold_capability_regular_file_bounded_nofollow(
    parent: &Dir,
    name: &Path,
    max_bytes: u64,
) -> std::io::Result<HeldBoundedCapabilityFile> {
    let (file, identity) = open_capability_read_file_nofollow(parent, name)?;
    let byte_size = file.metadata()?.len();
    if byte_size > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "held read target exceeds its byte limit",
        ));
    }
    verify_capability_read_file_at(parent, name, &file, identity)?;
    Ok(HeldBoundedCapabilityFile {
        file,
        identity,
        byte_size,
        max_bytes,
    })
}

pub(crate) fn hold_capability_regular_file_bounded_nofollow_writable(
    parent: &Dir,
    name: &Path,
    max_bytes: u64,
) -> std::io::Result<HeldBoundedCapabilityFile> {
    let mut options = CapOpenOptions::new();
    options.read(true).write(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    let file = parent.open_with(name, &options)?;
    let metadata = file.metadata()?;
    if capability_metadata_is_reparse_point(&metadata) || !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "held writable target must be an owned regular file",
        ));
    }
    let identity = try_capability_file_identity(&metadata)?;
    let byte_size = metadata.len();
    if byte_size > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "held writable target exceeds its byte limit",
        ));
    }
    verify_capability_read_file_at(parent, name, &file, identity)?;
    Ok(HeldBoundedCapabilityFile {
        file,
        identity,
        byte_size,
        max_bytes,
    })
}

pub(crate) struct BoundedCapabilityReader {
    file: cap_std::fs::File,
    max_bytes: u64,
    consumed: u64,
}

impl Read for BoundedCapabilityReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let remaining = self.max_bytes.saturating_sub(self.consumed);
        let read_limit = usize::try_from(remaining.saturating_add(1))
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let read = self.file.read(&mut buffer[..read_limit])?;
        self.consumed = self
            .consumed
            .checked_add(u64::try_from(read).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "held read target byte count overflowed",
                )
            })?)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "held read target byte count overflowed",
                )
            })?;
        if self.consumed > self.max_bytes {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "held read target exceeds its byte limit",
            ));
        }
        Ok(read)
    }
}

pub(crate) struct HeldRegularFileRead {
    parent: HeldCapabilityDirectory,
    name: PathBuf,
    file: cap_std::fs::File,
    identity: CapabilityFileIdentity,
    bytes: Vec<u8>,
}

impl HeldRegularFileRead {
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    fn verify_source(&self) -> std::io::Result<()> {
        self.parent.verify_ambient()?;
        verify_capability_read_file_at(&self.parent.dir, &self.name, &self.file, self.identity)
    }

    fn verify_at_directory(&self, parent: &Dir, name: &Path) -> std::io::Result<()> {
        verify_capability_read_file_at(parent, name, &self.file, self.identity)
    }

    pub(crate) fn move_noreplace_to(&self, destination: &Path) -> std::io::Result<()> {
        let destination_parent_path = destination.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "held move destination has no parent",
            )
        })?;
        let destination_name = destination.file_name().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "held move destination has no filename",
            )
        })?;
        let destination_parent = HeldCapabilityDirectory::open_ambient(destination_parent_path)
            .map_err(|error| {
                std::io::Error::other(format!("could not hold move parent: {error}"))
            })?;
        self.verify_source()?;
        rename_noreplace(
            &self.parent.dir,
            &self.name,
            &destination_parent.dir,
            Path::new(destination_name),
        )?;
        let moved_validation = self
            .verify_at_directory(&destination_parent.dir, Path::new(destination_name))
            .and_then(|_| self.parent.verify_ambient())
            .and_then(|_| destination_parent.verify_ambient());
        if let Err(error) = moved_validation {
            let restoration = rename_noreplace(
                &destination_parent.dir,
                Path::new(destination_name),
                &self.parent.dir,
                &self.name,
            )
            .map(|_| "the moved replacement was restored".to_string())
            .unwrap_or_else(|restore_error| {
                format!(
                    "the moved replacement remains at {} because restore failed: {restore_error}",
                    destination.display()
                )
            });
            return Err(std::io::Error::other(format!(
                "held cleanup source identity changed during no-replace move: {error}; {restoration}"
            )));
        }
        Ok(())
    }

    pub(crate) fn logically_retire(
        &self,
        directory_name: &Path,
        prefix: &str,
    ) -> Result<PathBuf, String> {
        if !matches!(
            directory_name.components().next(),
            Some(Component::Normal(_))
        ) || directory_name.components().nth(1).is_some()
        {
            return Err("A held retirement directory must be one relative name.".to_string());
        }
        #[cfg(windows)]
        let create_result = self.parent.dir.create_dir(directory_name);
        #[cfg(not(windows))]
        let create_result = {
            let mut builder = DirBuilder::new();
            #[cfg(unix)]
            CapDirBuilderExt::mode(&mut builder, 0o700);
            self.parent.dir.create_dir_with(directory_name, &builder)
        };
        match create_result {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "Could not create the held retirement directory: {error}"
                ))
            }
        }
        let retired_parent = self
            .parent
            .dir
            .open_dir_nofollow(directory_name)
            .map_err(|error| format!("Could not hold the retirement directory: {error}"))?;
        let retired_metadata = retired_parent
            .dir_metadata()
            .map_err(|error| format!("Could not inspect the retirement directory: {error}"))?;
        if capability_metadata_is_reparse_point(&retired_metadata) || !retired_metadata.is_dir() {
            return Err("The held retirement directory must be a real directory.".to_string());
        }
        let retired_identity = try_capability_file_identity(&retired_metadata)
            .map_err(|error| format!("Could not identify the retirement directory: {error}"))?;
        let retired_name = unique_capability_name(&retired_parent, prefix)?;
        self.verify_source()
            .map_err(|error| format!("Held cleanup source identity changed: {error}"))?;
        verify_capability_directory_at(&self.parent.dir, directory_name, retired_identity)
            .map_err(|error| format!("Held retirement directory pathname changed: {error}"))?;
        maybe_inject_capability_after_retirement_directory_open();
        capability_rename_noreplace(
            &self.parent.dir,
            &self.name,
            &retired_parent,
            Path::new(&retired_name),
        )?;
        let moved_validation = self
            .verify_at_directory(&retired_parent, Path::new(&retired_name))
            .and_then(|_| {
                let current = retired_parent.dir_metadata()?;
                let current_identity = try_capability_file_identity(&current)?;
                if capability_metadata_is_reparse_point(&current)
                    || !current.is_dir()
                    || current_identity != retired_identity
                {
                    return Err(std::io::Error::other(
                        "held retirement directory identity changed",
                    ));
                }
                Ok(())
            })
            .and_then(|_| {
                verify_capability_directory_at(&self.parent.dir, directory_name, retired_identity)
            })
            .and_then(|_| self.parent.verify_ambient());
        if let Err(error) = moved_validation {
            let restoration = capability_rename_noreplace(
                &retired_parent,
                Path::new(&retired_name),
                &self.parent.dir,
                &self.name,
            )
            .map(|_| "the moved replacement was restored".to_string())
            .unwrap_or_else(|restore_error| {
                format!(
                    "the moved replacement remains in the retirement directory because restore failed: {restore_error}"
                )
            });
            return Err(format!(
                "Held cleanup source identity changed during logical retirement: {error}; {restoration}."
            ));
        }
        Ok(self.parent.path.join(directory_name).join(retired_name))
    }
}

pub(crate) fn hold_regular_file_bounded_nofollow(
    path: &Path,
    max_bytes: usize,
) -> std::io::Result<HeldRegularFileRead> {
    let parent_path = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "read path has no parent")
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "read path has no filename",
        )
    })?;
    let parent = HeldCapabilityDirectory::open_ambient(parent_path)?;
    let name = PathBuf::from(file_name);
    let (file, identity) = open_capability_read_file_nofollow(&parent.dir, &name)?;
    verify_capability_read_file_at(&parent.dir, &name, &file, identity)?;
    let length = file.metadata()?.len();
    let max_bytes_u64 = u64::try_from(max_bytes).unwrap_or(u64::MAX);
    if length > max_bytes_u64 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "held read target exceeds its byte limit",
        ));
    }
    let mut reader = file.try_clone()?;
    reader.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
    Read::by_ref(&mut reader)
        .take(max_bytes_u64.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "held read target exceeds its byte limit",
        ));
    }
    verify_capability_read_file_at(&parent.dir, &name, &file, identity)?;
    parent.verify_ambient()?;
    Ok(HeldRegularFileRead {
        parent,
        name,
        file,
        identity,
        bytes,
    })
}

/// Reads one regular file relative to a held parent directory without following
/// a final-component link. The same held handle supplies all bytes; pathname
/// reopens are identity checks only and are never used as a data source.
pub(crate) fn read_regular_file_bounded_nofollow(
    path: &Path,
    max_bytes: usize,
) -> std::io::Result<Vec<u8>> {
    hold_regular_file_bounded_nofollow(path, max_bytes).map(HeldRegularFileRead::into_bytes)
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
            identity: try_capability_file_identity(&metadata)
                .map_err(|error| format!("Could not identify Notes export destination: {error}"))?,
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
        let held_identity = try_capability_file_identity(&held_metadata)
            .map_err(|error| format!("{context}: {error}"))?;
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
        let destination_identity = try_capability_file_identity(
            &destination.metadata().map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
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
            identity: try_capability_file_identity(metadata).map_err(|error| error.to_string())?,
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
        let current_identity = try_capability_file_identity(&metadata)
            .map_err(|error| format!("{context}: {error}"))?;
        if !metadata.file_type().is_symlink() || current_identity != self.identity {
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
        try_capability_file_identity(&staged.metadata().map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::{
        capability_rename_noreplace_fallback, capability_rename_noreplace_windows,
        clear_capability_after_fallback_link_injection, ensure_destination_is_available,
        hold_regular_file_bounded_nofollow, inject_capability_after_backup_once,
        inject_capability_after_cleanup_quarantine_verify_once,
        inject_capability_after_cleanup_verify_once, inject_capability_after_fallback_link_once,
        inject_capability_after_read_parent_inspect_once,
        inject_capability_after_recovery_copy_once,
        inject_capability_after_retirement_directory_open_once, read_regular_file_bounded_nofollow,
        remove_file_durable_with_parent_sync, windows_file_attributes_include_reparse_point,
        windows_file_identity_from_optional_fields, windows_file_link_count_from_optional_field,
        write_atomic_file, write_atomic_file_in_guarded_parent, write_atomic_file_with_parent_sync,
        HeldCapabilityFile,
    };
    #[cfg(windows)]
    use super::{windows_file_information_at, windows_file_information_from_handle};
    use std::cell::Cell;
    use std::fs;
    use std::path::Path;

    #[cfg(windows)]
    #[test]
    fn windows_file_information_uses_stable_handle_identity_and_link_count() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::HANDLE;

        let root = tempfile::tempdir().expect("create root");
        let original = root.path().join("original.txt");
        let linked = root.path().join("linked.txt");
        fs::write(&original, b"identity").unwrap();
        let file = fs::File::open(&original).unwrap();

        let before = windows_file_information_from_handle(file.as_raw_handle() as HANDLE).unwrap();
        let by_path = windows_file_information_at(&original).unwrap();
        assert_eq!(
            (before.device, before.inode),
            (by_path.device, by_path.inode)
        );
        assert_eq!(before.link_count, 1);

        fs::hard_link(&original, &linked).unwrap();
        let after = windows_file_information_from_handle(file.as_raw_handle() as HANDLE).unwrap();
        assert_eq!((after.device, after.inode), (before.device, before.inode));
        assert_eq!(after.link_count, 2);
    }

    #[cfg(unix)]
    #[test]
    fn held_reader_rejects_a_parent_swapped_to_an_external_symlink_before_open() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("create root");
        let outside = tempfile::tempdir().expect("create outside");
        let parent = root.path().join("vault");
        let displaced = root.path().join("displaced-vault");
        fs::create_dir(&parent).unwrap();
        fs::write(parent.join("topic.md"), b"inside").unwrap();
        fs::write(outside.path().join("topic.md"), b"outside").unwrap();
        let parent_for_hook = parent.clone();
        let displaced_for_hook = displaced.clone();
        let outside_for_hook = outside.path().to_path_buf();
        inject_capability_after_read_parent_inspect_once(move || {
            fs::rename(&parent_for_hook, &displaced_for_hook).unwrap();
            symlink(&outside_for_hook, &parent_for_hook).unwrap();
        });

        let result = read_regular_file_bounded_nofollow(&parent.join("topic.md"), 1024);

        assert!(
            result.is_err(),
            "outside bytes must not be returned: {result:?}"
        );
        assert_eq!(fs::read(displaced.join("topic.md")).unwrap(), b"inside");
        assert_eq!(
            fs::read(outside.path().join("topic.md")).unwrap(),
            b"outside"
        );
    }

    #[cfg(unix)]
    #[test]
    fn logical_retirement_restores_source_if_directory_basename_is_replaced() {
        let root = tempfile::tempdir().expect("create root");
        let cleanup = root.path().join("sync-cleanup");
        let source = cleanup.join("stage.pending");
        let consumed = cleanup.join("consumed");
        let displaced = cleanup.join("displaced-consumed");
        fs::create_dir(&cleanup).unwrap();
        fs::create_dir(&consumed).unwrap();
        fs::write(&source, b"expected stage").unwrap();
        let consumed_for_hook = consumed.clone();
        let displaced_for_hook = displaced.clone();
        inject_capability_after_retirement_directory_open_once(move || {
            fs::rename(&consumed_for_hook, &displaced_for_hook).unwrap();
            fs::create_dir(&consumed_for_hook).unwrap();
        });
        let held = hold_regular_file_bounded_nofollow(&source, 1024).unwrap();

        let result = held.logically_retire(Path::new("consumed"), ".retired-");

        assert!(
            result.is_err(),
            "a replaced retirement basename must keep cleanup retryable: {result:?}"
        );
        assert_eq!(fs::read(&source).unwrap(), b"expected stage");
        assert!(fs::read_dir(&consumed).unwrap().next().is_none());
        assert!(fs::read_dir(&displaced).unwrap().next().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn held_windows_retirement_directory_denies_rename_while_open() {
        use cap_fs_ext::DirExt;

        let root = tempfile::tempdir().expect("create root");
        let cleanup = root.path().join("sync-cleanup");
        let consumed = cleanup.join("consumed");
        let displaced = cleanup.join("displaced-consumed");
        fs::create_dir(&cleanup).unwrap();
        fs::create_dir(&consumed).unwrap();
        let cleanup_parent =
            cap_std::fs::Dir::open_ambient_dir(&cleanup, cap_std::ambient_authority()).unwrap();
        let held_consumed = cleanup_parent
            .open_dir_nofollow(Path::new("consumed"))
            .unwrap();

        let rename = fs::rename(&consumed, &displaced);

        assert!(
            rename.is_err(),
            "Windows held directories must deny rename/delete sharing"
        );
        assert!(held_consumed.dir_metadata().unwrap().is_dir());
        drop(held_consumed);
        fs::rename(&consumed, &displaced).unwrap();
    }

    #[test]
    fn missing_windows_identity_fields_fail_closed_without_panicking() {
        for (volume, index) in [(None, Some(7)), (Some(7), None), (None, None)] {
            let result = std::panic::catch_unwind(|| {
                windows_file_identity_from_optional_fields(volume, index)
            });
            assert!(result.is_ok(), "missing identity fields must not panic");
            assert!(
                result.unwrap().is_err(),
                "missing identity fields must fail closed"
            );
        }
        assert_eq!(
            windows_file_identity_from_optional_fields(Some(7), Some(11)).unwrap(),
            super::CapabilityFileIdentity {
                device: 7,
                inode: 11,
            }
        );
        for links in [None, Some(0), Some(1)] {
            let result =
                std::panic::catch_unwind(|| windows_file_link_count_from_optional_field(links));
            assert!(result.is_ok(), "missing link counts must not panic");
            match links {
                None => assert!(
                    result.unwrap().is_err(),
                    "missing link counts must fail closed"
                ),
                Some(count) => assert_eq!(result.unwrap().unwrap(), u64::from(count)),
            }
        }
    }

    #[test]
    fn capability_link_counts_have_a_fallible_cross_platform_contract() {
        let source = include_str!("file_io.rs");
        let contract = ["pub(crate) fn capability_file_", "link_count("].concat();
        assert!(
            source.contains(&contract),
            "capability link counts must fail closed when Windows metadata is incomplete"
        );
        assert!(
            !include_str!("notes/attachments.rs").contains(".nlink()")
                && !include_str!("notes/sync/asset_gc.rs").contains(".nlink()"),
            "asset lifecycle code must use the fallible shared link-count contract"
        );
    }

    #[test]
    fn retirement_directory_race_tests_are_platform_scoped() {
        let source = include_str!("file_io.rs");
        let unix_test = [
            "fn logical_retirement_restores_source_",
            "if_directory_basename_is_replaced",
        ]
        .concat();
        let unix_start = source.find(&unix_test).expect("Unix race regression");
        let unix_prefix = &source[unix_start.saturating_sub(80)..unix_start];
        assert!(
            unix_prefix.contains("#[cfg(unix)]"),
            "open-directory rename injection must not run on Windows"
        );
        let windows_test = [
            "fn held_windows_retirement_directory_",
            "denies_rename_while_open",
        ]
        .concat();
        assert!(
            source.contains(&windows_test),
            "Windows must retain its stronger held-directory sharing contract"
        );
    }

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
