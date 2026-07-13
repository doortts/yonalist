use std::fs;
use std::io::Write;
use std::path::Path;
#[cfg(unix)]
use tempfile::Builder;
use tempfile::NamedTempFile;

pub(crate) fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_destination_is_available(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err("Destination already exists.".to_string()),
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

fn write_atomic_file_with_parent_sync(
    path: &Path,
    bytes: &[u8],
    overwrite: bool,
    sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
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
            Err("Destination already exists.".to_string())
        }
        Err(error) => Err(error.error.to_string()),
    }
}

pub(crate) fn write_atomic_file(path: &Path, bytes: &[u8], overwrite: bool) -> Result<(), String> {
    write_atomic_file_with_parent_sync(path, bytes, overwrite, sync_parent_directory)
}

/// Preserves the vault writer's existing overwrite behavior while sharing the
/// byte-oriented atomic output path used by exports.
pub(crate) fn write_text_file_inner(path: &Path, contents: &str) -> Result<(), String> {
    write_atomic_file(path, contents.as_bytes(), true)
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_destination_is_available, write_atomic_file, write_atomic_file_with_parent_sync,
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
