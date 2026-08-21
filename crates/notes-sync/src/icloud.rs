//! Where the vault sits on iOS, and how a file that is not here yet is asked
//! for.
//!
//! An iOS app cannot keep reading a folder the user picked out of iCloud
//! Drive — there is no folder picker that grants that, and the permission a
//! document picker does grant is not one a background sync can rely on. What
//! an app always reaches is its own ubiquity container, and that container
//! also appears in iCloud Drive on the Mac, which is how the desktop is
//! pointed at the same files.

#[cfg(test)]
mod tests;

use std::path::PathBuf;

/// Where the vault ended up, and whether anyone else can see it.
///
/// Told apart rather than reduced to a path because the two are different
/// promises: a `Local` vault is this device's alone, and handing it back as if
/// it were the shared one would look like iCloud right up until a second
/// device failed to agree with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultPlace {
    /// The app's iCloud container, which other devices reach too.
    Shared(PathBuf),
    /// This device only — iCloud is off, or signed out.
    Local(PathBuf),
}

impl VaultPlace {
    pub fn path(&self) -> &PathBuf {
        match self {
            Self::Shared(path) | Self::Local(path) => path,
        }
    }
}

/// The folder the vault's Markdown lives in.
///
/// `Documents` inside the container rather than its root: that subfolder is
/// the one `NSUbiquitousContainerIsDocumentScopePublic` exposes in the Files
/// app, so the same choice is what lets somebody open, back up or repair the
/// vault without this app's help.
///
/// `container` is asked once. Foundation's answer blocks the first time while
/// it sets the container up, which is why it is not asked again per file.
pub fn vault_root(
    container: impl FnOnce() -> Option<PathBuf>,
    local: impl FnOnce() -> PathBuf,
) -> VaultPlace {
    match container() {
        Some(root) => VaultPlace::Shared(root.join("Documents")),
        None => VaultPlace::Local(local()),
    }
}

/// This app's ubiquity container, or `None` when iCloud has nothing to give —
/// switched off, signed out, or the entitlement absent.
///
/// Blocks the first time it is called while the system sets the container up,
/// so it is asked once at startup and off the thread that draws.
#[cfg(target_os = "ios")]
pub fn container() -> Option<PathBuf> {
    use objc2_foundation::NSFileManager;

    // `None` asks for the first container the entitlement lists, which is the
    // only one this app declares. Naming it here as well would be a second
    // place for the identifier to drift from the entitlement.
    let url = NSFileManager::defaultManager().URLForUbiquityContainerIdentifier(None)?;
    let path = url.path()?;
    Some(PathBuf::from(path.to_string()))
}

/// Asks iCloud to bring a file down.
///
/// On macOS reading an evicted file is what fetches it; iOS does not do that,
/// and a read of a file that has not arrived returns its absence rather than
/// waiting. So the download is asked for explicitly, and the answer is only
/// that the asking was accepted — the file arrives later, and the watcher is
/// what notices.
#[cfg(target_os = "ios")]
pub fn fetch(path: &std::path::Path) -> bool {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let Some(text) = path.to_str() else {
        return false;
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(text));
    NSFileManager::defaultManager()
        .startDownloadingUbiquitousItemAtURL_error(&url)
        .is_ok()
}

/// Off iOS there is no ubiquity container to ask about: macOS reaches iCloud
/// Drive as an ordinary folder the user picked, and the other platforms do not
/// reach it at all.
#[cfg(not(target_os = "ios"))]
pub fn container() -> Option<PathBuf> {
    None
}

/// Nothing to fetch where nothing is evicted behind a name.
#[cfg(not(target_os = "ios"))]
pub fn fetch(_path: &std::path::Path) -> bool {
    false
}
