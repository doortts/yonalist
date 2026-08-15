//! The three file operations the vault needs, and nothing else.
//!
//! Every one of them holds a rule the spec states as a safety contract: a
//! reader never follows a symbolic link out of the vault, a write is never
//! observable half-done, and a move never silently replaces what it lands on.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// A document the parser would refuse anyway; reading stops here so a runaway
/// file cannot be pulled into memory first.
pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

/// Writes through a temporary file in the same directory and renames it into
/// place, then flushes the directory itself. A reader — including the cloud
/// client watching the folder — sees the old bytes or the new ones, never a
/// prefix of the new ones.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("A vault path must name a directory.")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".yonalist-")
        .tempfile_in(parent)
        .map_err(|error| format!("Could not open a temporary file: {error}"))?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("Could not write the temporary file: {error}"))?;
    temporary
        .persist(path)
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

/// Reads a regular file without following a symbolic link, refusing anything
/// past the cap. The link check is the open flag rather than a prior `stat`:
/// checking and then opening leaves a window for the path to change underneath.
pub fn read_regular_bounded(path: &Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let metadata = File::metadata(&file)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file.", path.display()));
    }
    // One byte past the cap, so a file exactly at it still reads and anything
    // larger is caught without loading the rest of it.
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(max_bytes as u64 + 1)
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

/// Moves a file only onto free ground. `rename` would overwrite whatever sits
/// at the destination, so the link is made first — that fails when the name is
/// taken — and the original is dropped only once the new name holds the same
/// bytes.
pub fn move_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    fs::hard_link(from, to).map_err(|error| {
        format!(
            "Could not move {} to {}: {error}",
            from.display(),
            to.display()
        )
    })?;
    fs::remove_file(from)
        .map_err(|error| format!("Could not drop {} after moving it: {error}", from.display()))?;
    let parent = to.parent().ok_or("A vault path must name a directory.")?;
    sync_directory(parent)
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
            read_regular_bounded(&inside, MAX_FILE_BYTES).is_err(),
            "a link is how a vault path reaches a file that is not in the vault"
        );
    }

    #[test]
    fn a_read_refuses_anything_that_is_not_a_regular_file() {
        let directory = dir();

        assert!(read_regular_bounded(directory.path(), MAX_FILE_BYTES).is_err());
    }

    #[test]
    fn a_bounded_read_takes_the_cap_and_refuses_one_byte_more() {
        let directory = dir();
        let path = directory.path().join("README.md");
        std::fs::write(&path, vec![b'a'; 64]).expect("write");

        assert_eq!(
            read_regular_bounded(&path, 64).expect("at the cap").len(),
            64
        );
        assert!(read_regular_bounded(&path, 63).is_err());
    }

    #[test]
    fn a_no_replace_move_refuses_an_occupied_destination() {
        let directory = dir();
        let from = directory.path().join("source.md");
        let onto = directory.path().join("taken.md");
        std::fs::write(&from, b"mine").expect("write");
        std::fs::write(&onto, b"theirs").expect("write");

        assert!(move_no_replace(&from, &onto).is_err());
        assert_eq!(std::fs::read(&onto).expect("read"), b"theirs");
        assert!(from.exists(), "a refused move leaves the source alone");

        let free = directory.path().join("free.md");
        move_no_replace(&from, &free).expect("move");
        assert_eq!(std::fs::read(&free).expect("read"), b"mine");
        assert!(!from.exists());
    }

    #[test]
    fn write_atomic_file_round_trips_bytes_without_leaving_temp_files() {
        let directory = dir();
        let path = directory.path().join("README.md");

        write_atomic(&path, b"# Projects\n").expect("write");
        write_atomic(&path, b"# Renamed\n").expect("overwrite");

        assert_eq!(std::fs::read(&path).expect("read"), b"# Renamed\n");
        let leftovers = std::fs::read_dir(directory.path())
            .expect("list")
            .map(|entry| entry.expect("entry").file_name())
            .filter(|name| name != "README.md")
            .count();
        assert_eq!(leftovers, 0, "a half-written file must never survive");
    }
}
