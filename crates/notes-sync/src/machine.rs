//! What this machine calls itself, in bytes.
//!
//! The bytes never leave this module: `hlc::device_seed` hashes them together
//! with the database's location and keeps four hexadecimal characters. Every
//! file in the vault carries those characters, and a vault is something people
//! put in a shared folder, so the identifier itself must not travel.
//!
//! The two Apple platforms answer the question differently. macOS asks the
//! kernel. iOS has no such call, so the app draws the value once and keeps it
//! in the keychain, which is the only store on the platform that outlives
//! deleting the app — and outliving that matters, because the vault in iCloud
//! does too. A device that came back with a new identity would meet its own
//! older stamps and read them as another device's.

#[cfg(test)]
mod tests;

/// The value stored, provisioned on the first ask.
///
/// `read` answers what the store already holds, `write` puts a fresh value
/// there and says whether it landed, and `fresh` draws one. Split out from the
/// platform calls so the branching is testable where no keychain exists.
///
/// A stored value of the wrong width is treated as absent and replaced: the
/// only way to hold one is for something other than this code to have written
/// under the same name, and guessing at what it meant is worse than starting
/// over.
///
/// A write that does not land answers `None` rather than the drawn value.
/// Returning it anyway would hand out an identity that changes on the next
/// launch, which is the failure this whole module exists to avoid.
// Only iOS provisions a value; every other platform reads one the system
// already keeps. The tests exercise it everywhere, which is the point of
// having it apart from the keychain calls.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn provision(
    read: impl Fn() -> Option<Vec<u8>>,
    write: impl FnOnce(&[u8]) -> bool,
    fresh: impl FnOnce() -> [u8; 16],
) -> Option<[u8; 16]> {
    if let Some(stored) = read().and_then(|bytes| <[u8; 16]>::try_from(bytes).ok()) {
        return Some(stored);
    }
    let drawn = fresh();
    if !write(&drawn) {
        // Something else may have written between the read and the write; that
        // value is the identity, not this one.
        return read().and_then(|bytes| <[u8; 16]>::try_from(bytes).ok());
    }
    Some(drawn)
}

/// The bytes this machine is known by, or `None` when it will not say.
///
/// A `None` is not a failure to paper over: the caller refuses to provision a
/// database rather than stamp it with an identity that changes underneath the
/// vault.
pub(crate) fn machine_seed() -> Option<[u8; 16]> {
    platform::seed()
}

/// `gethostuuid` reads the same value as `IOPlatformUUID` from the same kernel
/// data, without the subprocess and the IOKit start-up that reading the
/// registry costs.
#[cfg(target_os = "macos")]
mod platform {
    pub(super) fn seed() -> Option<[u8; 16]> {
        let mut id = [0_u8; 16];
        let timeout = libc::timespec {
            tv_sec: 5,
            tv_nsec: 0,
        };
        // SAFETY: the call fills exactly sixteen bytes — `uuid_t` — and both
        // pointers name locals that outlive it.
        let outcome = unsafe { libc::gethostuuid(id.as_mut_ptr(), &timeout) };
        (outcome == 0).then_some(id)
    }
}

/// iOS has no `gethostuuid`, so the value is drawn once and kept in the
/// keychain. Keychain Services is the same C API on both Apple platforms,
/// which is why this needs no Swift.
///
/// Two attributes carry the whole meaning and neither is the default:
///
/// - **Not synchronized.** An item that reached iCloud Keychain would hand two
///   phones one identity, and every stamp either of them wrote would look like
///   the other's. That is the exact confusion the identity exists to prevent,
///   so both the read and the write name the local store explicitly rather
///   than relying on the attribute's default.
/// - **`AfterFirstUnlockThisDeviceOnly`.** `ThisDeviceOnly` keeps the item out
///   of backups, so restoring one backup onto two phones gives two identities
///   instead of one shared between them; a restored phone starting fresh is
///   the same as a new install, which the vault already handles.
///   `AfterFirstUnlock` rather than `WhenUnlocked` so a launch while the screen
///   is locked can still read it.
#[cfg(target_os = "ios")]
mod platform {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{generic_password, set_generic_password_options};
    use security_framework::passwords_options::PasswordOptions;

    /// Stable across releases: renaming either half would look like a machine
    /// that forgot which machine it was.
    const SERVICE: &str = "com.doortts.yonalist.device";
    const ACCOUNT: &str = "machine-seed";

    fn options() -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(SERVICE, ACCOUNT);
        options.set_access_synchronized(Some(false));
        if let Ok(control) = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
            0,
        ) {
            options.set_access_control(control);
        }
        options
    }

    pub(super) fn seed() -> Option<[u8; 16]> {
        super::provision(
            || generic_password(options()).ok(),
            |bytes| set_generic_password_options(bytes, options()).is_ok(),
            || *uuid::Uuid::new_v4().as_bytes(),
        )
    }
}

/// Everywhere else the question has no answer, and the caller treats that as
/// the refusal it is.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod platform {
    pub(super) fn seed() -> Option<[u8; 16]> {
        None
    }
}
