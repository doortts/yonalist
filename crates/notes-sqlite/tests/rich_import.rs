use std::collections::BTreeSet;
use std::io::Cursor;

use image::{DynamicImage, ImageFormat};
use notes_application::{
    CommandEnvelope, HistoryRequest, ImageAssetPort, ImageImportSource, ImageSource,
    IpcImportImage, IpcImportNode, IpcMarkerKind, IpcNotesCommand, NotesErrorCode, NotesService,
};
use notes_core::{NodeId, NoteMarkerKind, NoteNodeKind};
use notes_sqlite::{LocalImageAssets, SqliteStorage};

fn command(request_id: &str, base_revision: u64, command: IpcNotesCommand) -> CommandEnvelope {
    CommandEnvelope {
        session_id: "session".into(),
        request_id: request_id.into(),
        base_revision,
        history_group: None,
        command,
    }
}

fn png() -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(1, 1)
        .write_to(&mut bytes, ImageFormat::Png)
        .expect("encode image fixture");
    bytes.into_inner()
}

/// A page to paste into, and one published asset for the paste to reference.
fn seeded<'a>(
    storage: &'a SqliteStorage,
    assets: &LocalImageAssets,
) -> (NotesService<&'a SqliteStorage>, IpcImportImage) {
    let service = NotesService::new(storage, "session", 0);
    service
        .execute(command(
            "page",
            0,
            IpcNotesCommand::CreateNode {
                id: "page".into(),
                parent_id: "root".into(),
                before_id: None,
                text: "Page".into(),
            },
        ))
        .expect("create page");
    let published = assets
        .prepare(&[ImageImportSource {
            node_id: NodeId::try_from("seed").expect("valid node id"),
            original_name: "sample.png".into(),
            declared_mime_type: Some("image/png".into()),
            source: ImageSource::Bytes(png()),
        }])
        .expect("publish asset");
    let image = &published[0].image;
    (
        service,
        IpcImportImage {
            content_hash: image.content_hash().into(),
            original_name: image.original_name().into(),
            mime_type: image.mime_type().into(),
            byte_length: image.byte_length(),
            pixel_width: image.pixel_width(),
            pixel_height: image.pixel_height(),
            display_width: image.display_width(),
        },
    )
}

fn paste(image: Option<IpcImportImage>) -> IpcNotesCommand {
    IpcNotesCommand::ImportNodes {
        parent_id: "page".into(),
        before_id: None,
        nodes: vec![
            IpcImportNode {
                id: "pasted-text".into(),
                parent_id: "page".into(),
                text: "Buy milk".into(),
                note: Some("Two litres".into()),
                marker: Some(IpcMarkerKind::Todo),
                completed: Some(true),
                collapsed: Some(true),
                starred: Some(true),
                image: None,
            },
            IpcImportNode {
                id: "pasted-image".into(),
                parent_id: "pasted-text".into(),
                text: "sample.png".into(),
                image,
                ..IpcImportNode::default()
            },
        ],
    }
}

#[test]
fn a_rich_paste_commits_marker_note_tick_and_an_image_row_in_one_undoable_revision() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let storage = SqliteStorage::open(&directory.path().join("notes-v2.sqlite")).expect("storage");
    let assets = LocalImageAssets::open(&directory.path().join("images")).expect("asset store");
    let (service, image) = seeded(&storage, &assets);

    let receipt = service
        .execute_with_assets(command("paste", 1, paste(Some(image.clone()))), &assets)
        .expect("import rich paste");

    assert_eq!(receipt.revision, 2);
    assert_eq!(storage.revision().expect("revision"), 2);
    // The page creation plus this paste: two rows and an image row arrived as
    // one history entry.
    assert_eq!(receipt.history.undo_depth, 2);
    let text = storage
        .node("pasted-text")
        .expect("query")
        .expect("pasted text node");
    assert_eq!(text.note(), "Two litres");
    assert_eq!(text.marker(), NoteMarkerKind::Todo);
    assert!(text.is_completed());
    // Cut a collapsed, starred subtree and it comes back the same way round.
    assert!(text.is_collapsed());
    assert!(text.is_starred());
    let pasted_image = storage
        .node("pasted-image")
        .expect("query")
        .expect("pasted image node");
    assert_eq!(pasted_image.kind(), NoteNodeKind::Image);
    assert_eq!(
        pasted_image.parent_id().map(NodeId::as_str),
        Some("pasted-text")
    );
    assert_eq!(
        pasted_image.image().map(|image| image.content_hash()),
        Some(image.content_hash.as_str())
    );
    assert!(
        storage
            .live_image_hashes()
            .expect("live hashes")
            .contains(&image.content_hash)
    );

    let undone = service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 2,
        })
        .expect("undo whole paste");
    assert_eq!(undone.deleted_ids, ["pasted-image", "pasted-text"]);
    assert!(storage.node("pasted-text").expect("query").is_none());
    assert!(storage.live_image_hashes().expect("live hashes").is_empty());

    let redone = service
        .redo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 3,
        })
        .expect("redo whole paste");
    assert_eq!(redone.changed_nodes.len(), 2);
    assert!(
        storage
            .live_image_hashes()
            .expect("live hashes")
            .contains(&image.content_hash)
    );
}

#[test]
fn a_paste_whose_image_bytes_are_gone_commits_nothing() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let storage = SqliteStorage::open(&directory.path().join("notes-v2.sqlite")).expect("storage");
    let assets = LocalImageAssets::open(&directory.path().join("images")).expect("asset store");
    let (service, image) = seeded(&storage, &assets);
    assets
        .reconcile(&BTreeSet::new())
        .expect("sweep the unreferenced asset away");

    let error = service
        .execute_with_assets(command("paste", 1, paste(Some(image))), &assets)
        .expect_err("a stale image reference must be rejected");

    assert_eq!(error.code, NotesErrorCode::InvalidCommand);
    assert_eq!(storage.revision().expect("revision"), 1);
    assert!(storage.node("pasted-text").expect("query").is_none());
    assert!(storage.node("pasted-image").expect("query").is_none());
}
