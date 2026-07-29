use std::collections::BTreeSet;
use std::sync::Mutex;

use notes_application::{
    HistoryRequest, ImageAssetPort, ImageImportContext, ImageImportItem, ImageImportSource,
    ImageReadRequest, ImageSource, NotesErrorCode, NotesService, PublishedImage, StorageCommit,
    StorageError, StoragePort,
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
        tree.apply(&[TreeMutation::Upsert(NoteNode::page(id("page"), "Page"))])
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
                    TreeMutation::Upsert(node) => Some(node.clone()),
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
}
