use std::collections::BTreeSet;
use std::sync::Mutex;

use notes_application::{
    CommandEnvelope, HistoryRequest, ImageAssetPort, ImageImportContext, ImageImportItem,
    ImageImportSource, ImageReadRequest, ImageReplaceContext, ImageSource, IpcImportImage,
    IpcImportNode, IpcMarkerKind, IpcNodeKind, IpcNotesCommand, NotesErrorCode, NotesService,
    PublishedImage, StorageCommit, StorageError, StoragePort,
};
use notes_core::{DomainPatch, NodeId, NoteImage, NoteNode, NotesCommand, NotesTree, TreeMutation};

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).expect("valid node id")
}

fn metadata(name: &str, hash_digit: char) -> NoteImage {
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
    .expect("valid image metadata")
}

struct FakeStorage {
    state: Mutex<StorageState>,
}

struct StorageState {
    revision: u64,
    tree: NotesTree,
    commits: usize,
    fail_commit: bool,
}

impl FakeStorage {
    fn new(fail_commit: bool) -> Self {
        let mut tree = NotesTree::default();
        tree.apply(&[TreeMutation::upsert(NoteNode::page(id("page"), "Page"))])
            .expect("seed page");
        Self {
            state: Mutex::new(StorageState {
                revision: 1,
                tree,
                commits: 0,
                fail_commit,
            }),
        }
    }
}

impl StoragePort for FakeStorage {
    fn load_command_tree(&self, _command: &NotesCommand) -> Result<NotesTree, StorageError> {
        Ok(self.state.lock().unwrap().tree.clone())
    }

    fn load_node(&self, id: &NodeId) -> Result<Option<NoteNode>, StorageError> {
        Ok(self.state.lock().unwrap().tree.node(id).cloned())
    }

    fn live_image_hashes(&self) -> Result<BTreeSet<String>, StorageError> {
        Ok(BTreeSet::new())
    }

    fn commit(
        &self,
        expected_revision: u64,
        patch: &DomainPatch,
    ) -> Result<StorageCommit, StorageError> {
        let mut state = self.state.lock().unwrap();
        if state.fail_commit {
            return Err(StorageError::Internal("injected commit failure".into()));
        }
        assert_eq!(state.revision, expected_revision);
        state.tree.apply(&patch.forward)?;
        state.revision += 1;
        state.commits += 1;
        Ok(StorageCommit {
            revision: state.revision,
            changed_nodes: patch
                .forward
                .iter()
                .filter_map(|mutation| match mutation {
                    TreeMutation::Upsert(node) => Some(node.as_ref().clone()),
                    TreeMutation::Delete { .. } => None,
                })
                .collect(),
            deleted_ids: patch
                .forward
                .iter()
                .filter_map(|mutation| match mutation {
                    TreeMutation::Delete { id } => Some(id.clone()),
                    TreeMutation::Upsert(_) => None,
                })
                .collect(),
        })
    }
}

#[derive(Default)]
struct FakeAssets {
    fail_prepare: bool,
    prepare_calls: Mutex<usize>,
    rollbacks: Mutex<Vec<Vec<bool>>>,
    reads: Mutex<Vec<String>>,
    /// The hashes this store still holds, for imports that reference one.
    residents: BTreeSet<String>,
}

impl ImageAssetPort for FakeAssets {
    fn prepare(&self, sources: &[ImageImportSource]) -> Result<Vec<PublishedImage>, StorageError> {
        *self.prepare_calls.lock().unwrap() += 1;
        if self.fail_prepare {
            return Err(StorageError::Internal("injected prepare failure".into()));
        }
        Ok(sources
            .iter()
            .enumerate()
            .map(|(index, source)| PublishedImage {
                image: metadata(
                    &source.original_name,
                    char::from_digit((index + 10) as u32, 16).expect("hex digit"),
                ),
                newly_created: index == 0,
            })
            .collect())
    }

    fn read(&self, image: &NoteImage) -> Result<Vec<u8>, StorageError> {
        self.reads
            .lock()
            .unwrap()
            .push(image.content_hash().to_owned());
        Ok(vec![1, 2, 3])
    }

    fn contains(&self, image: &NoteImage) -> bool {
        self.residents.contains(image.content_hash())
    }

    fn rollback(&self, images: &[PublishedImage]) {
        self.rollbacks
            .lock()
            .unwrap()
            .push(images.iter().map(|image| image.newly_created).collect());
    }

    fn reconcile(&self, _live_hashes: &BTreeSet<String>) -> Result<(), StorageError> {
        Ok(())
    }
}

fn context(request_id: &str) -> ImageImportContext {
    ImageImportContext {
        session_id: "session".into(),
        request_id: request_id.into(),
        base_revision: 1,
        history_group: Some("images:batch".into()),
        parent_id: "page".into(),
        before_id: None,
        items: vec![
            ImageImportItem {
                node_id: "image-a".into(),
                original_name: "a.png".into(),
                declared_mime_type: Some("image/png".into()),
                byte_length: 3,
            },
            ImageImportItem {
                node_id: "image-b".into(),
                original_name: "b.png".into(),
                declared_mime_type: Some("image/png".into()),
                byte_length: 3,
            },
        ],
    }
}

fn sources() -> Vec<ImageImportSource> {
    vec![
        ImageImportSource {
            node_id: id("image-a"),
            original_name: "a.png".into(),
            declared_mime_type: Some("image/png".into()),
            source: ImageSource::Bytes(vec![1, 2, 3]),
        },
        ImageImportSource {
            node_id: id("image-b"),
            original_name: "b.png".into(),
            declared_mime_type: Some("image/png".into()),
            source: ImageSource::Bytes(vec![4, 5, 6]),
        },
    ]
}

fn replacement_context(request_id: &str) -> ImageReplaceContext {
    ImageReplaceContext {
        session_id: "session".into(),
        request_id: request_id.into(),
        base_revision: 2,
        history_group: Some("images:replace".into()),
        target_id: "image-a".into(),
        item: ImageImportItem {
            node_id: "image-a".into(),
            original_name: "replacement.png".into(),
            declared_mime_type: Some("image/png".into()),
            byte_length: 3,
        },
    }
}

fn replacement_source() -> ImageImportSource {
    ImageImportSource {
        node_id: id("image-a"),
        original_name: "replacement.png".into(),
        declared_mime_type: Some("image/png".into()),
        source: ImageSource::Bytes(vec![7, 8, 9]),
    }
}

#[test]
fn image_batch_uses_one_commit_history_entry_and_idempotency_cache() {
    let storage = FakeStorage::new(false);
    let assets = FakeAssets::default();
    let service = NotesService::new(&storage, "session", 1);

    let receipt = service
        .import_images(context("import-1"), sources(), &assets)
        .expect("import image batch");
    assert_eq!(receipt.revision, 2);
    assert_eq!(
        receipt
            .changed_nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["image-a", "image-b"]
    );
    assert_eq!(storage.state.lock().unwrap().commits, 1);

    let repeated = service
        .import_images(context("import-1"), sources(), &assets)
        .expect("repeat idempotent request");
    assert_eq!(repeated, receipt);
    assert_eq!(*assets.prepare_calls.lock().unwrap(), 1);

    let undone = service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 2,
        })
        .expect("undo whole image batch");
    assert_eq!(undone.deleted_ids, ["image-a", "image-b"]);
    assert!(!undone.history.can_undo);
}

#[test]
fn commit_failure_rolls_back_only_the_assets_published_by_the_batch() {
    let storage = FakeStorage::new(true);
    let assets = FakeAssets::default();
    let service = NotesService::new(&storage, "session", 1);

    let error = service
        .import_images(context("import-fails"), sources(), &assets)
        .expect_err("commit failure must surface");

    assert_eq!(error.code, NotesErrorCode::Internal);
    assert_eq!(&*assets.rollbacks.lock().unwrap(), &[vec![true]]);
    assert_eq!(storage.state.lock().unwrap().commits, 0);
}

#[test]
fn prepare_failure_never_commits_or_records_history() {
    let storage = FakeStorage::new(false);
    let assets = FakeAssets {
        fail_prepare: true,
        ..FakeAssets::default()
    };
    let service = NotesService::new(&storage, "session", 1);

    let error = service
        .import_images(context("prepare-fails"), sources(), &assets)
        .expect_err("prepare failure must surface");

    assert_eq!(error.code, NotesErrorCode::Internal);
    assert!(assets.rollbacks.lock().unwrap().is_empty());
    assert_eq!(storage.state.lock().unwrap().commits, 0);
    assert!(
        service
            .undo(HistoryRequest {
                session_id: "session".into(),
                base_revision: 1,
            })
            .is_err()
    );
}

#[test]
fn image_reads_are_authorized_by_session_and_database_metadata() {
    let storage = FakeStorage::new(false);
    let assets = FakeAssets::default();
    let service = NotesService::new(&storage, "session", 1);
    service
        .import_images(context("import-1"), sources(), &assets)
        .expect("import image batch");

    let bytes = service
        .read_image(
            ImageReadRequest {
                session_id: "session".into(),
                node_id: "image-a".into(),
            },
            &assets,
        )
        .expect("read imported image");
    assert_eq!(bytes, [1, 2, 3]);
    assert_eq!(assets.reads.lock().unwrap().len(), 1);

    let wrong_session = service.read_image(
        ImageReadRequest {
            session_id: "other-session".into(),
            node_id: "image-a".into(),
        },
        &assets,
    );
    assert_eq!(
        wrong_session
            .expect_err("foreign session must be rejected")
            .code,
        NotesErrorCode::SessionMismatch
    );

    let text_node = service.read_image(
        ImageReadRequest {
            session_id: "session".into(),
            node_id: "page".into(),
        },
        &assets,
    );
    assert_eq!(
        text_node.expect_err("text node must be rejected").code,
        NotesErrorCode::InvalidCommand
    );

    {
        let mut state = storage.state.lock().unwrap();
        let patch = state
            .tree
            .plan(NotesCommand::DeleteSubtree { id: id("image-a") })
            .expect("delete image");
        state.tree.apply(&patch.forward).expect("apply deletion");
    }
    let deleted = service.read_image(
        ImageReadRequest {
            session_id: "session".into(),
            node_id: "image-a".into(),
        },
        &assets,
    );
    assert_eq!(
        deleted.expect_err("deleted image must be rejected").code,
        NotesErrorCode::InvalidCommand
    );
    assert_eq!(assets.reads.lock().unwrap().len(), 1);
}

#[test]
fn replacement_preserves_identity_width_and_uses_one_reversible_history_entry() {
    let storage = FakeStorage::new(false);
    let assets = FakeAssets::default();
    let service = NotesService::new(&storage, "session", 1);
    service
        .import_images(context("import-1"), sources(), &assets)
        .expect("import image batch");

    let receipt = service
        .replace_image(
            replacement_context("replace-1"),
            replacement_source(),
            &assets,
        )
        .expect("replace image");

    assert_eq!(receipt.changed_nodes.len(), 1);
    let image = receipt.changed_nodes[0].image.as_ref().unwrap();
    assert_eq!(receipt.changed_nodes[0].id, "image-a");
    assert_eq!(image.original_name, "replacement.png");
    assert_eq!(image.display_width, 320);

    let undone = service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 3,
        })
        .expect("undo replacement");
    assert_eq!(
        undone.changed_nodes[0]
            .image
            .as_ref()
            .unwrap()
            .original_name,
        "a.png"
    );
}

fn pasted_outline(hash_digit: char) -> IpcNotesCommand {
    let hash = hash_digit.to_string().repeat(64);
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
                image: None,
            },
            IpcImportNode {
                id: "pasted-image".into(),
                parent_id: "page".into(),
                text: "a.png".into(),
                image: Some(IpcImportImage {
                    content_hash: hash,
                    original_name: "a.png".into(),
                    mime_type: "image/png".into(),
                    byte_length: 3,
                    pixel_width: 1,
                    pixel_height: 1,
                    display_width: 320,
                }),
                ..IpcImportNode::default()
            },
        ],
    }
}

fn envelope(request_id: &str, command: IpcNotesCommand) -> CommandEnvelope {
    CommandEnvelope {
        session_id: "session".into(),
        request_id: request_id.into(),
        base_revision: 1,
        history_group: None,
        command,
    }
}

#[test]
fn a_paste_referencing_a_resident_asset_lands_every_field_in_one_history_entry() {
    let storage = FakeStorage::new(false);
    let assets = FakeAssets {
        residents: BTreeSet::from(["a".repeat(64)]),
        ..FakeAssets::default()
    };
    let service = NotesService::new(&storage, "session", 1);

    let receipt = service
        .execute_with_assets(envelope("paste-1", pasted_outline('a')), &assets)
        .expect("import referenced paste");

    assert_eq!(storage.state.lock().unwrap().commits, 1);
    assert_eq!(receipt.changed_nodes.len(), 2);
    let changed = |node_id: &str| {
        receipt
            .changed_nodes
            .iter()
            .find(|node| node.id == node_id)
            .expect("imported node")
    };
    let text = changed("pasted-text");
    assert_eq!(text.note, "Two litres");
    assert_eq!(text.marker, IpcMarkerKind::Todo);
    assert!(text.completed);
    let image = changed("pasted-image");
    assert_eq!(image.kind, IpcNodeKind::Image);
    assert_eq!(
        image
            .image
            .as_ref()
            .map(|image| image.content_hash.as_str()),
        Some("a".repeat(64).as_str())
    );
    assert_eq!(receipt.history.undo_depth, 1);
}

#[test]
fn a_paste_referencing_a_missing_asset_is_rejected_whole() {
    let storage = FakeStorage::new(false);
    let assets = FakeAssets::default();
    let service = NotesService::new(&storage, "session", 1);

    let error = service
        .execute_with_assets(envelope("paste-stale", pasted_outline('b')), &assets)
        .expect_err("a stale image reference must be rejected");

    assert_eq!(error.code, NotesErrorCode::InvalidCommand);
    assert_eq!(storage.state.lock().unwrap().commits, 0);
    let state = storage.state.lock().unwrap();
    assert!(state.tree.node(&id("pasted-text")).is_none());
    assert!(state.tree.node(&id("pasted-image")).is_none());
    drop(state);
    assert!(
        service
            .undo(HistoryRequest {
                session_id: "session".into(),
                base_revision: 1,
            })
            .is_err()
    );
}

#[test]
fn the_asset_free_command_path_refuses_an_image_reference() {
    let storage = FakeStorage::new(false);
    let service = NotesService::new(&storage, "session", 1);

    let error = service
        .execute(envelope("paste-unchecked", pasted_outline('a')))
        .expect_err("an unchecked image reference must be rejected");

    assert_eq!(error.code, NotesErrorCode::InvalidCommand);
    assert_eq!(storage.state.lock().unwrap().commits, 0);
}
