//! The three file operations the vault needs, and nothing else.
//!
//! Every one of them holds a rule the spec states as a safety contract: a
//! reader never follows a symbolic link out of the vault, a write is never
//! observable half-done, and a move never silently replaces what it lands on.

use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// A document the parser would refuse anyway; reading stops here so a runaway
/// file cannot be pulled into memory first.
pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

/// Writes through a temporary file in the same directory and renames it into
/// place, then flushes the directory itself. A reader — including the cloud
/// client watching the folder — sees the old bytes or the new ones, never a
/// prefix of the new ones.
pub fn write_atomic(vault_root: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    let resolved = resolve_inside(vault_root, path)?;
    let parent = resolved
        .parent()
        .ok_or("A vault path must name a directory.")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".yonalist-")
        .tempfile_in(parent)
        .map_err(|error| format!("Could not open a temporary file: {error}"))?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("Could not write the temporary file: {error}"))?;
    temporary
        .persist(&resolved)
        .map_err(|error| format!("Could not put the file in place: {error}"))?;
    sync_directory(parent)
}

/// The rename is only durable once the directory entry is, so the parent is
/// flushed too — otherwise a power cut can leave the old name pointing nowhere.
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not flush the directory: {error}"))
}

/// Resolves everything above the file and refuses a result that left the vault.
/// All three operations run through it, so a link planted in the folder cannot
/// redirect a read, a write, or a move past the root.
fn resolve_inside(vault_root: &Path, path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("{} does not name a file.", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no directory.", path.display()))?;
    let root = fs::canonicalize(vault_root)
        .map_err(|error| format!("Could not resolve the vault: {error}"))?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Could not resolve {}: {error}", parent.display()))?;
    if !parent.starts_with(&root) {
        return Err(format!("{} is outside the vault.", path.display()));
    }
    Ok(parent.join(name))
}

/// Reads a regular file that lives inside the vault, refusing anything past the
/// cap.
///
/// Confinement is two moves, because one is not enough. The parent is resolved
/// first and checked to still land under the vault: a symbolic link anywhere
/// along the way resolves out, and the check catches it. Refusing every link on
/// the path instead would be wrong — the vault itself commonly sits behind one
/// (`/var` is a link on macOS). The leaf is then guarded by the open flag
/// rather than a prior `stat`, since checking and then opening leaves a window.
/// What remains is narrow: `open` re-walks the resolved path, so a directory
/// swapped for a link between the two calls is still followed. That needs local
/// code running as this user, which could read the file directly anyway; the
/// escape this closes is the one someone leaves lying in the folder.
/// `O_NONBLOCK` is there so a fifo planted at a vault path fails instead of
/// parking the worker on the open.
pub fn read_regular_bounded(
    vault_root: &Path,
    path: &Path,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let resolved = resolve_inside(vault_root, path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&resolved)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file.", path.display()));
    }
    // One byte past the cap, so a file exactly at it still reads and anything
    // larger is caught without loading the rest of it.
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "{} is larger than {max_bytes} bytes.",
            path.display()
        ));
    }
    Ok(bytes)
}

/// Moves a file only onto free ground, in one step. A link-then-unlink pair
/// would leave both names alive if the unlink never ran, and the cloud client
/// replicates each of them as its own document; hard links are also absent on
/// some of the folders this has to work in. `RENAME_EXCL` gives the whole move
/// atomically and fails when the destination is taken.
///
/// The source has to be a regular file: `rename` moves a symbolic link as
/// itself, which would plant one under a vault name by the app's own hand.
pub fn move_no_replace(vault_root: &Path, from: &Path, to: &Path) -> Result<(), String> {
    let from = resolve_inside(vault_root, from)?;
    let to = resolve_inside(vault_root, to)?;
    if !fs::symlink_metadata(&from)
        .map_err(|error| format!("Could not inspect {}: {error}", from.display()))?
        .is_file()
    {
        return Err(format!("{} is not a regular file.", from.display()));
    }
    rename_no_replace(&from, &to)?;
    // Both ends, because this is the one operation whose two names live in
    // different directories: a flush of only the destination can let a power
    // cut resurrect the source and leave the file under both names.
    let from_parent = from.parent().ok_or("A vault path must name a directory.")?;
    let to_parent = to.parent().ok_or("A vault path must name a directory.")?;
    sync_directory(to_parent)?;
    if from_parent != to_parent {
        sync_directory(from_parent)?;
    }
    Ok(())
}

fn rename_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    let from_c = c_path(from)?;
    let to_c = c_path(to)?;
    // SAFETY: both paths are NUL-terminated and live across the call, and the
    // fds are the "resolve relative to cwd" sentinel with absolute paths.
    let outcome = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            from_c.as_ptr(),
            libc::AT_FDCWD,
            to_c.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if outcome == 0 {
        return Ok(());
    }
    // Read before the formatting below allocates, which is not guaranteed to
    // leave errno alone.
    let error = std::io::Error::last_os_error();
    Err(format!(
        "Could not move {} to {}: {error}",
        from.display(),
        to.display()
    ))
}

fn c_path(path: &Path) -> Result<CString, String> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("{} contains a NUL byte.", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temporary directory")
    }

    #[test]
    fn a_read_refuses_to_follow_a_symlink_out_of_the_vault() {
        let directory = dir();
        let outside = directory.path().join("secret");
        std::fs::write(&outside, b"not yours").expect("write");
        let inside = directory.path().join("README.md");
        std::os::unix::fs::symlink(&outside, &inside).expect("symlink");

        assert!(
            read_regular_bounded(directory.path(), &inside, MAX_FILE_BYTES).is_err(),
            "a link is how a vault path reaches a file that is not in the vault"
        );
    }

    #[test]
    fn a_write_refuses_a_symlinked_directory_on_the_way() {
        let directory = dir();
        let vault = directory.path().join("vault");
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(&vault).expect("vault");
        std::fs::create_dir_all(&outside).expect("outside");
        std::os::unix::fs::symlink(&outside, vault.join("page")).expect("symlink");

        assert!(
            write_atomic(&vault, &vault.join("page/README.md"), b"# Mine\n").is_err(),
            "the write side of the same escape plants a document outside the vault"
        );
        assert!(!outside.join("README.md").exists());
    }

    #[test]
    fn a_move_refuses_a_destination_outside_the_vault() {
        let directory = dir();
        let vault = directory.path().join("vault");
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(&vault).expect("vault");
        std::fs::create_dir_all(&outside).expect("outside");
        std::os::unix::fs::symlink(&outside, vault.join("page")).expect("symlink");
        let from = vault.join("source.md");
        std::fs::write(&from, b"mine").expect("write");

        assert!(move_no_replace(&vault, &from, &vault.join("page/moved.md")).is_err());
        assert!(!outside.join("moved.md").exists());
    }

    #[test]
    fn a_read_refuses_a_symlinked_directory_on_the_way() {
        let directory = dir();
        let vault = directory.path().join("vault");
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(&vault).expect("vault");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(outside.join("README.md"), b"not yours").expect("write");
        std::os::unix::fs::symlink(&outside, vault.join("page")).expect("symlink");

        assert!(
            read_regular_bounded(&vault, &vault.join("page/README.md"), MAX_FILE_BYTES).is_err(),
            "a link anywhere along the path reaches outside the vault, not just at the end"
        );
    }

    #[test]
    fn a_no_replace_move_refuses_a_source_that_is_not_a_regular_file() {
        let directory = dir();
        let outside = directory.path().join("secret");
        std::fs::write(&outside, b"not yours").expect("write");
        let link = directory.path().join("source.md");
        std::os::unix::fs::symlink(&outside, &link).expect("symlink");

        assert!(
            move_no_replace(directory.path(), &link, &directory.path().join("moved.md")).is_err(),
            "moving a link would transplant it under a vault name"
        );
    }

    #[test]
    fn a_read_refuses_anything_that_is_not_a_regular_file() {
        let directory = dir();

        assert!(read_regular_bounded(directory.path(), directory.path(), MAX_FILE_BYTES).is_err());
    }

    #[test]
    fn a_bounded_read_takes_the_cap_and_refuses_one_byte_more() {
        let directory = dir();
        let path = directory.path().join("README.md");
        std::fs::write(&path, vec![b'a'; 64]).expect("write");

        assert_eq!(
            read_regular_bounded(directory.path(), &path, 64)
                .expect("at the cap")
                .len(),
            64
        );
        assert!(read_regular_bounded(directory.path(), &path, 63).is_err());
    }

    #[test]
    fn a_no_replace_move_refuses_an_occupied_destination() {
        let directory = dir();
        let from = directory.path().join("source.md");
        let onto = directory.path().join("taken.md");
        std::fs::write(&from, b"mine").expect("write");
        std::fs::write(&onto, b"theirs").expect("write");

        assert!(move_no_replace(directory.path(), &from, &onto).is_err());
        assert_eq!(std::fs::read(&onto).expect("read"), b"theirs");
        assert!(from.exists(), "a refused move leaves the source alone");

        let free = directory.path().join("free.md");
        move_no_replace(directory.path(), &from, &free).expect("move");
        assert_eq!(std::fs::read(&free).expect("read"), b"mine");
        assert!(!from.exists());
    }

    #[test]
    fn write_atomic_file_round_trips_bytes_without_leaving_temp_files() {
        let directory = dir();
        let path = directory.path().join("README.md");

        write_atomic(directory.path(), &path, b"# Projects\n").expect("write");
        write_atomic(directory.path(), &path, b"# Renamed\n").expect("overwrite");

        assert_eq!(std::fs::read(&path).expect("read"), b"# Renamed\n");
        let leftovers = std::fs::read_dir(directory.path())
            .expect("list")
            .map(|entry| entry.expect("entry").file_name())
            .filter(|name| name != "README.md")
            .count();
        assert_eq!(leftovers, 0, "a half-written file must never survive");
    }
}
