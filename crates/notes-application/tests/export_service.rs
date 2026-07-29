use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use notes_application::{
    ExportError, ExportFormat, ExportImage, ExportNode, ExportPublicationPort, ExportRendererPort,
    ExportSnapshot, ExportSnapshotPort, HistoryRequest, ImageAssetPort, ImageImportSource,
    NotesErrorCode, NotesExportRequest, NotesService, PublishedImage, RenderedExport,
    StorageCommit, StorageError, StoragePort,
};
use notes_core::{
    DomainPatch, NodeId, NoteImage, NoteMarkerKind, NoteNode, NoteNodeKind, NotesCommand, NotesTree,
};

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).expect("valid node id")
}

fn image(hash_digit: char, name: &str) -> NoteImage {
    let hash = hash_digit.to_string().repeat(64);
    NoteImage::try_new(
        hash.clone(),
        format!("{hash}.png"),
        name,
        "image/png",
        3,
        1,
        1,
        320,
    )
    .expect("valid image")
}

fn image_node(node_id: &str, metadata: NoteImage) -> ExportNode {
    ExportNode {
        id: id(node_id),
        kind: NoteNodeKind::Image,
        marker: NoteMarkerKind::Bullet,
        text: metadata.original_name().into(),
        note: String::new(),
        completed: false,
        image: Some(ExportImage {
            metadata,
            bytes: None,
        }),
        children: Vec::new(),
    }
}

fn snapshot() -> ExportSnapshot {
    let shared = image('a', "shared.png");
    ExportSnapshot {
        revision: 7,
        root_node_id: id("page"),
        title: "Page".into(),
        exported_at: "2026-07-29T00:00:00.000Z".into(),
        root: ExportNode {
            id: id("page"),
            kind: NoteNodeKind::Page,
            marker: NoteMarkerKind::Bullet,
            text: "Page".into(),
            note: String::new(),
            completed: false,
            image: None,
            children: vec![
                image_node("image-a", shared.clone()),
                image_node("image-b", shared),
            ],
        },
    }
}

struct FakeStorage {
    snapshot: ExportSnapshot,
}

impl ExportSnapshotPort for FakeStorage {
    fn load_export_snapshot(
        &self,
        expected_revision: u64,
        root_id: &NodeId,
    ) -> Result<ExportSnapshot, ExportError> {
        if expected_revision != self.snapshot.revision {
            return Err(StorageError::RevisionConflict {
                expected: expected_revision,
                actual: self.snapshot.revision,
            }
            .into());
        }
        assert_eq!(root_id, &self.snapshot.root_node_id);
        Ok(self.snapshot.clone())
    }
}

impl StoragePort for FakeStorage {
    fn load_command_tree(&self, _command: &NotesCommand) -> Result<NotesTree, StorageError> {
        unreachable!("export must not load a mutation tree")
    }

    fn load_node(&self, _id: &NodeId) -> Result<Option<NoteNode>, StorageError> {
        unreachable!("export uses its immutable snapshot")
    }

    fn live_image_hashes(&self) -> Result<BTreeSet<String>, StorageError> {
        Ok(BTreeSet::new())
    }

    fn commit(
        &self,
        _expected_revision: u64,
        _patch: &DomainPatch,
    ) -> Result<StorageCommit, StorageError> {
        unreachable!("export must not commit")
    }
}

#[derive(Default)]
struct FakeAssets {
    reads: Mutex<Vec<String>>,
    fail: bool,
}

impl ImageAssetPort for FakeAssets {
    fn prepare(&self, _sources: &[ImageImportSource]) -> Result<Vec<PublishedImage>, StorageError> {
        unreachable!("export never prepares image assets")
    }

    fn read(&self, image: &NoteImage) -> Result<Vec<u8>, StorageError> {
        self.reads
            .lock()
            .expect("reads lock")
            .push(image.content_hash().into());
        if self.fail {
            Err(StorageError::Internal("injected image read failure".into()))
        } else {
            Ok(vec![1, 2, 3])
        }
    }

    fn rollback(&self, _images: &[PublishedImage]) {
        unreachable!("export never rolls assets back")
    }

    fn reconcile(&self, _live_hashes: &BTreeSet<String>) -> Result<(), StorageError> {
        unreachable!("export never reconciles assets")
    }
}

#[derive(Default)]
struct FakeRenderer {
    snapshots: Mutex<Vec<ExportSnapshot>>,
    fail: bool,
}

impl ExportRendererPort for FakeRenderer {
    fn render(
        &self,
        snapshot: &ExportSnapshot,
        format: ExportFormat,
        asset_directory_name: Option<&str>,
    ) -> Result<RenderedExport, ExportError> {
        self.snapshots
            .lock()
            .expect("snapshots lock")
            .push(snapshot.clone());
        if self.fail {
            return Err(ExportError::Failed("injected render failure".into()));
        }
        assert_eq!(format, ExportFormat::Markdown);
        assert_eq!(asset_directory_name, Some("Page_assets"));
        Ok(RenderedExport::Markdown {
            document: b"document".to_vec(),
            asset_directory_name: "Page_assets".into(),
            assets: Vec::new(),
        })
    }
}

#[derive(Default)]
struct FakePublisher {
    calls: Mutex<Vec<(String, bool)>>,
    error: Mutex<Option<ExportError>>,
}

impl ExportPublicationPort for FakePublisher {
    fn publish(
        &self,
        destination: &Path,
        _rendered: &RenderedExport,
        overwrite: bool,
    ) -> Result<(), ExportError> {
        self.calls
            .lock()
            .expect("calls lock")
            .push((destination.display().to_string(), overwrite));
        if let Some(error) = self.error.lock().expect("error lock").take() {
            Err(error)
        } else {
            Ok(())
        }
    }
}

fn request() -> NotesExportRequest {
    NotesExportRequest {
        session_id: "session".into(),
        base_revision: 7,
        root_node_id: "page".into(),
        format: ExportFormat::Markdown,
        destination_path: "C:/Exports/Page.md".into(),
        overwrite: false,
    }
}

#[test]
fn export_hydrates_unique_images_once_without_mutating_history() {
    let storage = FakeStorage {
        snapshot: snapshot(),
    };
    let assets = FakeAssets::default();
    let renderer = FakeRenderer::default();
    let publisher = FakePublisher::default();
    let service = NotesService::new(&storage, "session", 7);

    let result = service
        .export(request(), &assets, &renderer, &publisher)
        .expect("export");

    assert_eq!(result.revision, 7);
    assert_eq!(result.root_node_id, "page");
    assert_eq!(result.format, ExportFormat::Markdown);
    assert_eq!(
        assets.reads.lock().expect("reads lock").as_slice(),
        &["a".repeat(64)]
    );
    let rendered = renderer.snapshots.lock().expect("snapshots lock");
    assert_eq!(rendered.len(), 1);
    let first = rendered[0].root.children[0]
        .image
        .as_ref()
        .and_then(|image| image.bytes.as_ref())
        .expect("first hydrated payload");
    let second = rendered[0].root.children[1]
        .image
        .as_ref()
        .and_then(|image| image.bytes.as_ref())
        .expect("second hydrated payload");
    assert!(Arc::ptr_eq(first, second));
    assert_eq!(
        publisher.calls.lock().expect("calls lock").as_slice(),
        &[(Path::new("C:/Exports/Page.md").display().to_string(), false)]
    );

    let history_error = service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 7,
        })
        .expect_err("export must not create history");
    assert_eq!(history_error.code, NotesErrorCode::HistoryEmpty);
}

#[test]
fn export_rejects_foreign_session_and_stale_revision_before_loading_assets() {
    let storage = FakeStorage {
        snapshot: snapshot(),
    };
    let assets = FakeAssets::default();
    let renderer = FakeRenderer::default();
    let publisher = FakePublisher::default();
    let service = NotesService::new(&storage, "session", 7);

    let mut foreign = request();
    foreign.session_id = "other".into();
    assert_eq!(
        service
            .export(foreign, &assets, &renderer, &publisher)
            .expect_err("foreign session")
            .code,
        NotesErrorCode::SessionMismatch
    );

    let mut stale = request();
    stale.base_revision = 6;
    let error = service
        .export(stale, &assets, &renderer, &publisher)
        .expect_err("stale revision");
    assert_eq!(error.code, NotesErrorCode::RevisionConflict);
    assert!(error.retryable);
    assert!(assets.reads.lock().expect("reads lock").is_empty());
}

#[test]
fn export_maps_image_render_and_destination_failures_to_stable_codes() {
    let cases = [
        (
            FakeAssets {
                fail: true,
                ..FakeAssets::default()
            },
            FakeRenderer::default(),
            None,
            NotesErrorCode::Internal,
        ),
        (
            FakeAssets::default(),
            FakeRenderer {
                fail: true,
                ..FakeRenderer::default()
            },
            None,
            NotesErrorCode::ExportFailed,
        ),
        (
            FakeAssets::default(),
            FakeRenderer::default(),
            Some(ExportError::DestinationExists),
            NotesErrorCode::DestinationExists,
        ),
    ];

    for (assets, renderer, publication_error, expected_code) in cases {
        let storage = FakeStorage {
            snapshot: snapshot(),
        };
        let publisher = FakePublisher::default();
        *publisher.error.lock().expect("error lock") = publication_error;
        let service = NotesService::new(&storage, "session", 7);

        let error = service
            .export(request(), &assets, &renderer, &publisher)
            .expect_err("injected failure");

        assert_eq!(error.code, expected_code);
    }
}
