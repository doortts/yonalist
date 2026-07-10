use std::fs;
use std::io::Write;
use std::path::Path;
use tempfile::NamedTempFile;

pub(crate) fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn write_atomic_file(path: &Path, bytes: &[u8], overwrite: bool) -> Result<(), String> {
    ensure_parent(path)?;
    path.file_name()
        .ok_or_else(|| "File path must name a file.".to_string())?;

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut temp_file = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
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
        Ok(_) => Ok(()),
        Err(error) if !overwrite && error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err("Destination already exists.".to_string())
        }
        Err(error) => Err(error.error.to_string()),
    }
}

/// Preserves the vault writer's existing overwrite behavior while sharing the
/// byte-oriented atomic output path used by exports.
pub(crate) fn write_text_file_inner(path: &Path, contents: &str) -> Result<(), String> {
    write_atomic_file(path, contents.as_bytes(), true)
}

#[cfg(test)]
mod tests {
    use super::write_atomic_file;
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
