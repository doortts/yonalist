use std::fs;
use std::path::PathBuf;

use notes_application::{ExportPublicationPort, RenderedExport};

use super::{
    BEFORE_PUBLICATION, BEFORE_STAGING, FORCE_PARENT_REVALIDATION_FAILURE, NativeExportPublisher,
};

// macOS temp dirs sit under /var (a symlink to /private/var), which the
// destination validation rejects by design; canonicalize before use.
fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = fs::canonicalize(directory.path()).expect("canonical temporary directory");
    (directory, path)
}

#[test]
fn destination_replacement_race_preserves_foreign_file_and_cleans_stage() {
    let (_directory, directory) = canonical_tempdir();
    let destination = directory.join("race.pdf");
    let displaced = directory.join("original.pdf");
    let publisher = NativeExportPublisher::new(Vec::new());
    publisher
        .publish(
            &destination,
            &RenderedExport::Pdf {
                document: b"original".to_vec(),
            },
            false,
        )
        .expect("initial publication");
    let raced_destination = destination.clone();
    let raced_displaced = displaced.clone();
    BEFORE_PUBLICATION.with(|injection| {
        *injection.borrow_mut() = Some(Box::new(move || {
            fs::rename(&raced_destination, &raced_displaced).expect("attacker displaces original");
            fs::write(&raced_destination, b"foreign").expect("attacker replaces destination");
        }));
    });

    publisher
        .publish(
            &destination,
            &RenderedExport::Pdf {
                document: b"replacement".to_vec(),
            },
            true,
        )
        .expect_err("identity change must fail closed");

    assert_eq!(fs::read(&destination).expect("foreign file"), b"foreign");
    assert_eq!(fs::read(displaced).expect("original file"), b"original");
    let hidden = fs::read_dir(&directory)
        .expect("read export directory")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".yonalist-")
        })
        .count();
    assert_eq!(hidden, 0);
}

#[test]
fn parent_replacement_race_never_publishes_into_the_replacement_directory() {
    let (_root, root) = canonical_tempdir();
    let parent = root.join("exports");
    let displaced = root.join("displaced-exports");
    fs::create_dir(&parent).expect("create export parent");
    let destination = parent.join("race.pdf");
    let raced_parent = parent.clone();
    let raced_displaced = displaced.clone();
    BEFORE_STAGING.with(|injection| {
        *injection.borrow_mut() = Some(Box::new(move || {
            fs::rename(&raced_parent, &raced_displaced).expect("attacker displaces parent");
            fs::create_dir(&raced_parent).expect("attacker replaces parent");
        }));
    });

    NativeExportPublisher::new(Vec::new())
        .publish(
            &destination,
            &RenderedExport::Pdf {
                document: b"private export".to_vec(),
            },
            false,
        )
        .expect_err("parent identity change must fail closed");

    assert!(!destination.exists());
    assert!(
        fs::read_dir(&parent)
            .expect("replacement parent")
            .next()
            .is_none()
    );
    assert!(
        fs::read_dir(&displaced)
            .expect("preserved original parent")
            .next()
            .is_none()
    );
}

#[test]
#[cfg(not(windows))]
fn parent_replacement_after_staging_cleans_the_displaced_directory() {
    let (_root, root) = canonical_tempdir();
    let parent = root.join("exports");
    let displaced = root.join("displaced-exports");
    fs::create_dir(&parent).expect("create export parent");
    let destination = parent.join("race.pdf");
    let raced_parent = parent.clone();
    let raced_displaced = displaced.clone();
    BEFORE_PUBLICATION.with(|injection| {
        *injection.borrow_mut() = Some(Box::new(move || {
            fs::rename(&raced_parent, &raced_displaced).expect("attacker displaces parent");
            fs::create_dir(&raced_parent).expect("attacker replaces parent");
        }));
    });

    NativeExportPublisher::new(Vec::new())
        .publish(
            &destination,
            &RenderedExport::Pdf {
                document: b"private export".to_vec(),
            },
            false,
        )
        .expect_err("parent identity change must fail closed");

    assert!(!destination.exists());
    assert!(
        fs::read_dir(&parent)
            .expect("replacement parent")
            .next()
            .is_none()
    );
    assert!(
        fs::read_dir(&displaced)
            .expect("cleaned displaced parent")
            .next()
            .is_none()
    );
}

#[test]
fn parent_revalidation_failure_after_staging_cleans_the_stage() {
    let (_directory, directory) = canonical_tempdir();
    let destination = directory.join("race.pdf");
    BEFORE_PUBLICATION.with(|injection| {
        *injection.borrow_mut() = Some(Box::new(|| {
            FORCE_PARENT_REVALIDATION_FAILURE.with(|failure| failure.set(true));
        }));
    });

    NativeExportPublisher::new(Vec::new())
        .publish(
            &destination,
            &RenderedExport::Pdf {
                document: b"private export".to_vec(),
            },
            false,
        )
        .expect_err("parent revalidation failure must fail closed");

    assert!(!destination.exists());
    assert!(
        fs::read_dir(&directory)
            .expect("cleaned export parent")
            .next()
            .is_none()
    );
}
