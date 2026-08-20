//! Holding a claim on a vault file while it is read or written.
//!
//! A vault folder is shared ground: on macOS the cloud daemon replaces files in
//! it whenever it likes, and the only way to be sure it is not doing that
//! mid-read is to ask the system for the file first. That is what
//! `NSFileCoordinator` is — the same protocol the daemon itself waits on — and
//! it is also how the system learns a write happened.
//!
//! Everywhere else these are the closures themselves, called with the path they
//! were given. The seam exists so no other platform pays for a claim it has no
//! daemon to make.
//!
//! One rule for callers: a claim never goes inside another claim. Two on the
//! same thread deadlock — the inner one waits for the outer one to let go, and
//! the outer one is waiting for the closure the inner one is in. Nothing in this
//! crate does that today, and nothing should start.

use std::path::Path;

/// Reads under a claim, then hands the closure the file the claim is on.
#[cfg(target_os = "macos")]
pub fn coordinated_read<T>(
    path: &Path,
    read: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    mac::under_claim(path, mac::Claim::Read, read)
}

/// Writes under a claim, then hands the closure the file the claim is on.
#[cfg(target_os = "macos")]
pub fn coordinated_write<T>(
    path: &Path,
    write: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    mac::under_claim(path, mac::Claim::Write, write)
}

#[cfg(not(target_os = "macos"))]
pub fn coordinated_read<T>(
    path: &Path,
    read: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    read(path)
}

#[cfg(not(target_os = "macos"))]
pub fn coordinated_write<T>(
    path: &Path,
    write: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    write(path)
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::StackBlock;
    use objc2::rc::Retained;
    use objc2_foundation::{
        NSFileCoordinator, NSFileCoordinatorReadingOptions, NSFileCoordinatorWritingOptions,
        NSString, NSURL,
    };
    use std::cell::RefCell;
    use std::path::Path;
    use std::ptr::NonNull;

    pub(super) enum Claim {
        Read,
        Write,
    }

    /// Foundation names a file by URL, so every call in here starts by making
    /// one. A path is bytes and a `NSString` is text; the lossy conversion is
    /// what Foundation itself does with such a name anyway.
    pub(super) fn file_url(path: &Path) -> Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
    }

    /// One coordinator per claim, with no file presenter: Apple's rule is that a
    /// reused instance or a shared presenter stops claims excluding each other,
    /// which is the whole thing we came for.
    ///
    /// The accessor is a `Fn` block the system calls once, and the work is an
    /// `FnOnce` returning a value — so each crosses in a `RefCell<Option<…>>`,
    /// taken out on the way in and left behind on the way out. If the coordinator
    /// reports an error the block never ran and there is nothing behind.
    pub(super) fn under_claim<T>(
        path: &Path,
        claim: Claim,
        body: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        let url = file_url(path);
        let body = RefCell::new(Some(body));
        let outcome = RefCell::new(None);
        let mut failure = None;
        let accessor = StackBlock::new(|claimed: NonNull<NSURL>| {
            // SAFETY: the coordinator hands the accessor a live URL for the
            // length of the call, and this block is only ever called from there.
            let claimed = unsafe { claimed.as_ref() };
            let Some(body) = body.borrow_mut().take() else {
                return;
            };
            *outcome.borrow_mut() = Some(match claimed.path() {
                // The URL the coordinator hands back, not the one we asked
                // about: it substitutes one whenever the item has moved.
                Some(at) => body(Path::new(&at.to_string())),
                None => Err(format!("{} came back without a path.", path.display())),
            });
        });
        let coordinator = NSFileCoordinator::new();
        match claim {
            Claim::Read => coordinator.coordinateReadingItemAtURL_options_error_byAccessor(
                &url,
                NSFileCoordinatorReadingOptions::empty(),
                Some(&mut failure),
                &accessor,
            ),
            // `write_atomic` really does put a different file in place, and
            // Apple says to say so whether or not anything is in the way.
            Claim::Write => coordinator.coordinateWritingItemAtURL_options_error_byAccessor(
                &url,
                NSFileCoordinatorWritingOptions::ForReplacing,
                Some(&mut failure),
                &accessor,
            ),
        }
        if let Some(failure) = failure {
            return Err(format!(
                "Could not claim {}: {}",
                path.display(),
                failure.localizedDescription()
            ));
        }
        outcome
            .into_inner()
            .unwrap_or_else(|| Err(format!("Nothing claimed {}.", path.display())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temporary directory")
    }

    #[test]
    fn a_coordinated_write_lands_its_bytes_and_hands_back_what_it_wrote() {
        let directory = dir();
        let path = directory.path().join("README.md");

        let written = coordinated_write(&path, |at| {
            std::fs::write(at, b"# Projects\n").map_err(|error| error.to_string())?;
            Ok(b"# Projects\n".len())
        })
        .expect("write under a claim");

        assert_eq!(written, 11);
        assert_eq!(std::fs::read(&path).expect("read"), b"# Projects\n");
    }

    #[test]
    fn a_coordinated_read_returns_the_bytes_a_coordinated_write_left() {
        let directory = dir();
        let path = directory.path().join("README.md");
        coordinated_write(&path, |at| {
            std::fs::write(at, b"# Renamed\n").map_err(|error| error.to_string())
        })
        .expect("write under a claim");

        let bytes = coordinated_read(&path, |at| {
            std::fs::read(at).map_err(|error| error.to_string())
        })
        .expect("read under a claim");

        assert_eq!(bytes, b"# Renamed\n");
    }

    #[test]
    fn a_closure_that_fails_under_a_claim_fails_the_call() {
        let directory = dir();
        let path = directory.path().join("README.md");

        assert_eq!(
            coordinated_read(&path, |_| Err::<(), _>("no".to_owned())),
            Err("no".to_owned()),
            "the claim is around the work, not instead of its answer"
        );
    }
}
