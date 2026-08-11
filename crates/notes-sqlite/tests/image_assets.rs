use std::fs;
use std::io::Cursor;

use image::{DynamicImage, ImageFormat};
use notes_application::{
    CommandEnvelope, HistoryRequest, ImageAssetPort, ImageImportContext, ImageImportItem,
    ImageImportSource, ImageReplaceContext, ImageSource, IpcNotesCommand, MAX_IMAGE_BATCH_ITEMS,
    NotesErrorCode, NotesService,
};
use notes_core::MAX_IMAGE_BYTES;
use notes_core::NodeId;
use notes_sqlite::{LocalImageAssets, SqliteStorage};

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).expect("valid node id")
}

fn png() -> Vec<u8> {
    encoded(ImageFormat::Png)
}

fn encoded(format: ImageFormat) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(1, 1)
        .write_to(&mut bytes, format)
        .expect("encode image fixture");
    bytes.into_inner()
}

fn png_with_width(width: u32) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(width, 1)
        .write_to(&mut bytes, ImageFormat::Png)
        .expect("encode image fixture");
    bytes.into_inner()
}

fn source(node_id: &str, name: &str, declared_mime_type: Option<&str>) -> ImageImportSource {
    ImageImportSource {
        node_id: id(node_id),
        original_name: name.into(),
        declared_mime_type: declared_mime_type.map(str::to_owned),
        source: ImageSource::Bytes(png()),
    }
}

#[test]
fn valid_image_is_decoded_hashed_published_and_verified_on_read() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let assets = LocalImageAssets::open(directory.path()).expect("open asset store");

    let published = assets
        .prepare(&[source("image-1", "cat.anything", Some("image/png"))])
        .expect("publish image");

    assert_eq!(published.len(), 1);
    let image = &published[0].image;
    assert_eq!(image.mime_type(), "image/png");
    assert_eq!((image.pixel_width(), image.pixel_height()), (1, 1));
    assert_eq!(image.content_hash().len(), 64);
    assert!(
        image
            .content_hash()
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    assert_eq!(
        image.relative_path(),
        format!("{}.png", image.content_hash())
    );
    assert_eq!(assets.read(image).expect("verified read"), png());
}

#[test]
fn duplicate_content_is_published_once_and_rollback_removes_only_new_files() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let assets = LocalImageAssets::open(directory.path()).expect("open asset store");

    let published = assets
        .prepare(&[
            source("image-1", "cat.png", None),
            source("image-2", "copy.png", None),
        ])
        .expect("publish duplicate images");

    assert!(published[0].newly_created);
    assert!(!published[1].newly_created);
    assert_eq!(
        published[0].image.content_hash(),
        published[1].image.content_hash()
    );
    assert_eq!(
        fs::read_dir(directory.path())
            .expect("list asset files")
            .count(),
        1
    );

    assets.rollback(&published);
    assert_eq!(
        fs::read_dir(directory.path())
            .expect("list rolled-back files")
            .count(),
        0
    );
}

#[test]
fn spoofed_mime_and_invalid_sources_are_rejected_without_publication() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let assets = LocalImageAssets::open(directory.path()).expect("open asset store");

    assert!(
        assets
            .prepare(&[source("image-1", "cat.svg", Some("image/svg+xml"))])
            .is_err()
    );
    assert!(
        assets
            .prepare(&[ImageImportSource {
                node_id: id("image-2"),
                original_name: "broken.png".into(),
                declared_mime_type: Some("image/png".into()),
                source: ImageSource::Bytes(png()[..20].to_vec()),
            }])
            .is_err()
    );
    assert!(
        assets
            .prepare(&[ImageImportSource {
                node_id: id("image-3"),
                original_name: "directory.png".into(),
                declared_mime_type: Some("image/png".into()),
                source: ImageSource::Path(directory.path().to_path_buf()),
            }])
            .is_err()
    );
    assert_eq!(
        fs::read_dir(directory.path())
            .expect("list rejected files")
            .count(),
        0
    );
}

#[test]
fn supported_formats_are_derived_from_decoded_bytes_not_filename_extensions() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let assets = LocalImageAssets::open(directory.path()).expect("open asset store");
    let cases = [
        (ImageFormat::Png, "image/png", "png"),
        (ImageFormat::Jpeg, "image/jpeg", "jpg"),
        (ImageFormat::Gif, "image/gif", "gif"),
        (ImageFormat::WebP, "image/webp", "webp"),
    ];

    for (index, (format, mime, extension)) in cases.into_iter().enumerate() {
        let published = assets
            .prepare(&[ImageImportSource {
                node_id: id(&format!("image-{index}")),
                original_name: format!("misleading-{index}.bin"),
                declared_mime_type: Some(mime.into()),
                source: ImageSource::Bytes(encoded(format)),
            }])
            .expect("publish supported image");
        assert_eq!(published[0].image.mime_type(), mime);
        assert!(
            published[0]
                .image
                .relative_path()
                .ends_with(&format!(".{extension}"))
        );
    }
}

#[test]
fn byte_and_batch_budgets_fail_before_decode_or_publication() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let assets = LocalImageAssets::open(directory.path()).expect("open asset store");
    let oversized = vec![0; usize::try_from(MAX_IMAGE_BYTES + 1).expect("test allocation")];
    assert!(
        assets
            .prepare(&[ImageImportSource {
                node_id: id("oversized"),
                original_name: "oversized.png".into(),
                declared_mime_type: None,
                source: ImageSource::Bytes(oversized),
            }])
            .is_err()
    );

    let chunk = vec![0; 17 * 1024 * 1024];
    let aggregate = (0..4)
        .map(|index| ImageImportSource {
            node_id: id(&format!("aggregate-{index}")),
            original_name: format!("{index}.png"),
            declared_mime_type: None,
            source: ImageSource::Bytes(chunk.clone()),
        })
        .collect::<Vec<_>>();
    assert!(assets.prepare(&aggregate).is_err());

    let too_many = (0..=MAX_IMAGE_BATCH_ITEMS)
        .map(|index| source(&format!("many-{index}"), "tiny.png", None))
        .collect::<Vec<_>>();
    assert!(assets.prepare(&too_many).is_err());
    assert_eq!(
        fs::read_dir(directory.path())
            .expect("list rejected files")
            .count(),
        0
    );
}

#[test]
fn verified_read_detects_asset_tampering_and_reconcile_removes_orphans() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let assets = LocalImageAssets::open(directory.path()).expect("open asset store");
    let first = assets
        .prepare(&[source("image-1", "cat.png", None)])
        .expect("publish first");
    let second = assets
        .prepare(&[ImageImportSource {
            node_id: id("image-2"),
            original_name: "other.jpg".into(),
            declared_mime_type: Some("image/jpeg".into()),
            source: ImageSource::Bytes(encoded(ImageFormat::Jpeg)),
        }])
        .expect("publish second");

    let live = [first[0].image.content_hash().to_owned()]
        .into_iter()
        .collect();
    assets.reconcile(&live).expect("reconcile assets");
    assert!(assets.read(&first[0].image).is_ok());
    assert!(assets.read(&second[0].image).is_err());

    fs::write(
        directory.path().join(first[0].image.relative_path()),
        b"tampered",
    )
    .expect("tamper asset");
    assert!(assets.read(&first[0].image).is_err());
}

#[test]
fn close_reconciliation_keeps_final_history_state_and_restart_clears_history() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("notes.sqlite");
    let asset_root = directory.path().join("images");
    let final_hash;
    {
        let storage = SqliteStorage::open(&database).expect("open storage");
        let assets = LocalImageAssets::open(&asset_root).expect("open assets");
        let service = NotesService::new(&storage, "session", 0);
        service
            .execute(CommandEnvelope {
                session_id: "session".into(),
                request_id: "page".into(),
                base_revision: 0,
                history_group: None,
                command: IpcNotesCommand::CreateNode {
                    id: "page".into(),
                    parent_id: "root".into(),
                    before_id: None,
                    text: "Page".into(),
                },
            })
            .expect("create page");

        let first_bytes = png_with_width(1);
        service
            .import_images(
                ImageImportContext {
                    session_id: "session".into(),
                    request_id: "import".into(),
                    base_revision: 1,
                    history_group: Some("images:batch".into()),
                    parent_id: "page".into(),
                    before_id: None,
                    items: vec![ImageImportItem {
                        node_id: "image".into(),
                        original_name: "first.png".into(),
                        declared_mime_type: Some("image/png".into()),
                        byte_length: u64::try_from(first_bytes.len()).unwrap(),
                    }],
                },
                vec![ImageImportSource {
                    node_id: id("image"),
                    original_name: "first.png".into(),
                    declared_mime_type: Some("image/png".into()),
                    source: ImageSource::Bytes(first_bytes),
                }],
                &assets,
            )
            .expect("import first image");

        let replacement_bytes = png_with_width(2);
        let replaced = service
            .replace_image(
                ImageReplaceContext {
                    session_id: "session".into(),
                    request_id: "replace".into(),
                    base_revision: 2,
                    history_group: Some("images:replace".into()),
                    target_id: "image".into(),
                    item: ImageImportItem {
                        node_id: "image".into(),
                        original_name: "replacement.png".into(),
                        declared_mime_type: Some("image/png".into()),
                        byte_length: u64::try_from(replacement_bytes.len()).unwrap(),
                    },
                },
                ImageImportSource {
                    node_id: id("image"),
                    original_name: "replacement.png".into(),
                    declared_mime_type: Some("image/png".into()),
                    source: ImageSource::Bytes(replacement_bytes),
                },
                &assets,
            )
            .expect("replace image");
        final_hash = replaced.changed_nodes[0]
            .image
            .as_ref()
            .expect("replacement metadata")
            .content_hash
            .clone();
        service
            .undo(HistoryRequest {
                session_id: "session".into(),
                base_revision: 3,
            })
            .expect("undo replacement");
        service
            .redo(HistoryRequest {
                session_id: "session".into(),
                base_revision: 4,
            })
            .expect("redo replacement");

        assets
            .prepare(&[ImageImportSource {
                node_id: id("orphan"),
                original_name: "orphan.png".into(),
                declared_mime_type: Some("image/png".into()),
                source: ImageSource::Bytes(png_with_width(3)),
            }])
            .expect("publish uncommitted orphan");
        assert_eq!(fs::read_dir(&asset_root).unwrap().count(), 3);
    }

    let reopened = SqliteStorage::open(&database).expect("restart storage");
    let assets = LocalImageAssets::open(&asset_root).expect("restart assets");
    assert_eq!(
        fs::read_dir(&asset_root).unwrap().count(),
        3,
        "startup must not scan or reconcile image assets"
    );
    let live_hashes = reopened.live_image_hashes().expect("load live hashes");
    assert_eq!(live_hashes.len(), 1);
    assert!(live_hashes.contains(&final_hash));
    assets
        .reconcile(&live_hashes)
        .expect("close reconciliation");
    assert_eq!(fs::read_dir(&asset_root).unwrap().count(), 1);

    let restarted = NotesService::new(&reopened, "restart", 5);
    let error = restarted
        .undo(HistoryRequest {
            session_id: "restart".into(),
            base_revision: 5,
        })
        .expect_err("history is session-only");
    assert_eq!(error.code, NotesErrorCode::HistoryEmpty);
}
