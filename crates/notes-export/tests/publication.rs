use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use notes_application::{ExportAsset, ExportError, ExportPublicationPort, RenderedExport};
use notes_export::{EXPORT_ASSET_MARKER_NAME, NativeExportPublisher};

// macOS temp dirs sit under /var (a symlink to /private/var), which the
// destination validation rejects by design; canonicalize before use.
fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = fs::canonicalize(directory.path()).expect("canonical temporary directory");
    (directory, path)
}

fn markdown(document: &[u8], asset: &[u8]) -> RenderedExport {
    RenderedExport::Markdown {
        document: document.to_vec(),
        asset_directory_name: "Page_assets".into(),
        assets: vec![ExportAsset {
            file_name: "0001.png".into(),
            bytes: Arc::from(asset),
        }],
    }
}

#[test]
fn new_pdf_and_markdown_exports_publish_complete_staged_artifacts() {
    let (_directory, directory) = canonical_tempdir();
    let publisher = NativeExportPublisher::new(Vec::new());
    let pdf_destination = directory.join("Page.pdf");
    let markdown_destination = directory.join("Page.md");

    publisher
        .publish(
            &pdf_destination,
            &RenderedExport::Pdf {
                document: b"%PDF-test".to_vec(),
            },
            false,
        )
        .expect("publish PDF");
    publisher
        .publish(
            &markdown_destination,
            &markdown(b"first document", b"first image"),
            false,
        )
        .expect("publish Markdown");

    assert_eq!(fs::read(pdf_destination).expect("read PDF"), b"%PDF-test");
    assert_eq!(
        fs::read(markdown_destination).expect("read Markdown"),
        b"first document"
    );
    let assets = directory.join("Page_assets");
    assert_eq!(
        fs::read(assets.join("0001.png")).expect("read image"),
        b"first image"
    );
    let marker =
        fs::read_to_string(assets.join(EXPORT_ASSET_MARKER_NAME)).expect("read ownership marker");
    assert!(marker.contains("\"created_by\":\"yonalist-notes-export\""));
    assert!(marker.contains("\"version\":1"));
}

#[test]
fn conflict_preserves_existing_content_until_explicit_owned_overwrite() {
    let (_directory, directory) = canonical_tempdir();
    let publisher = NativeExportPublisher::new(Vec::new());
    let destination = directory.join("Page.md");
    publisher
        .publish(&destination, &markdown(b"old", b"old image"), false)
        .expect("initial export");

    let error = publisher
        .publish(&destination, &markdown(b"new", b"new image"), false)
        .expect_err("no-overwrite conflict");
    assert!(matches!(error, ExportError::DestinationExists));
    assert_eq!(fs::read(&destination).expect("old document"), b"old");
    assert_eq!(
        fs::read(directory.join("Page_assets/0001.png")).expect("old image"),
        b"old image"
    );

    publisher
        .publish(&destination, &markdown(b"new", b"new image"), true)
        .expect("owned overwrite");
    assert_eq!(fs::read(&destination).expect("new document"), b"new");
    assert_eq!(
        fs::read(directory.join("Page_assets/0001.png")).expect("new image"),
        b"new image"
    );
}

#[test]
fn foreign_asset_directories_and_forbidden_roots_fail_closed() {
    let (_directory, directory) = canonical_tempdir();
    let destination = directory.join("Page.md");
    let foreign_assets = directory.join("Page_assets");
    fs::create_dir(&foreign_assets).expect("create foreign assets");
    fs::write(foreign_assets.join("keep.txt"), b"foreign").expect("write foreign file");

    let publisher = NativeExportPublisher::new(Vec::new());
    let error = publisher
        .publish(&destination, &markdown(b"document", b"image"), true)
        .expect_err("foreign assets must not be replaced");
    assert!(matches!(error, ExportError::InvalidDestination(_)));
    assert!(!destination.exists());
    assert_eq!(
        fs::read(foreign_assets.join("keep.txt")).expect("foreign file"),
        b"foreign"
    );

    let forbidden_publisher = NativeExportPublisher::new(vec![directory.clone()]);
    let error = forbidden_publisher
        .publish(
            &directory.join("Blocked.pdf"),
            &RenderedExport::Pdf {
                document: b"%PDF-blocked".to_vec(),
            },
            false,
        )
        .expect_err("forbidden root");
    assert!(matches!(error, ExportError::InvalidDestination(_)));
}

#[test]
fn invalid_extension_and_directory_destinations_are_rejected() {
    let (_directory, directory) = canonical_tempdir();
    let publisher = NativeExportPublisher::new(Vec::new());

    for destination in [directory.join("Page.txt"), directory.clone()] {
        let error = publisher
            .publish(
                &destination,
                &RenderedExport::Pdf {
                    document: b"%PDF-test".to_vec(),
                },
                false,
            )
            .expect_err("invalid destination");
        assert!(matches!(error, ExportError::InvalidDestination(_)));
    }
}
