//! What a merge does to this session's undo stack.
//!
//! Undo replays an inverse recorded against a state that has since moved. Once
//! another device's edit has landed on a node, an entry that touches that node
//! can no longer be reversed — replaying it would silently discard what the
//! merge brought in. The barrier stops there, and only there: entries above it
//! still undo, because nothing about them is in question.

use std::collections::BTreeSet;
use std::sync::Mutex;

use notes_application::{
    CommandEnvelope, HistoryRequest, IpcNotesCommand, NotesErrorCode, NotesService, StorageCommit,
    StorageError, StoragePort,
};
use notes_core::{DomainPatch, NodeId, NotesCommand, NotesTree, TreeMutation};

#[derive(Default)]
struct FakeState {
    revision: u64,
    tree: NotesTree,
}

struct FakeStorage {
    state: Mutex<FakeState>,
}

impl Default for FakeStorage {
    fn default() -> Self {
        let mut tree = NotesTree::default();
        tree.apply(&[TreeMutation::upsert(notes_core::NoteNode::page(
            NodeId::try_from("root").unwrap(),
            "Home",
        ))])
        .unwrap();
        Self {
            state: Mutex::new(FakeState {
                tree,
                ..FakeState::default()
            }),
        }
    }
}

impl FakeStorage {
    /// What a merge looks like from here: the revision moves without this
    /// session having asked for anything.
    fn merged_elsewhere(&self) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.revision += 1;
        state.revision
    }
}

impl StoragePort for FakeStorage {
    fn load_command_tree(&self, _command: &NotesCommand) -> Result<NotesTree, StorageError> {
        Ok(self.state.lock().unwrap().tree.clone())
    }

    fn load_node(&self, id: &NodeId) -> Result<Option<notes_core::NoteNode>, StorageError> {
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
        if state.revision != expected_revision {
            return Err(StorageError::RevisionConflict {
                expected: expected_revision,
                actual: state.revision,
            });
        }
        state.tree.apply(&patch.forward).expect("apply");
        state.revision += 1;
        Ok(StorageCommit {
            revision: state.revision,
            changed_nodes: patch
                .forward
                .iter()
                .filter_map(|mutation| match mutation {
                    TreeMutation::Upsert(node) => Some((**node).clone()),
                    TreeMutation::Delete { .. } => None,
                })
                .collect(),
            deleted_ids: Vec::new(),
        })
    }
}

fn service(storage: &FakeStorage) -> NotesService<&FakeStorage> {
    NotesService::new(storage, "session", 0)
}

fn create(service: &NotesService<&FakeStorage>, id: &str, revision: u64) -> u64 {
    let receipt = service
        .execute(CommandEnvelope {
            session_id: session_id(service),
            base_revision: revision,
            request_id: format!("create-{id}"),
            history_group: None,
            command: IpcNotesCommand::CreateNode {
                id: id.to_owned(),
                parent_id: "root".to_owned(),
                before_id: None,
                text: format!("node {id}"),
            },
        })
        .expect("create");
    receipt.revision
}

fn edit(service: &NotesService<&FakeStorage>, id: &str, revision: u64, text: &str) -> u64 {
    service
        .execute(CommandEnvelope {
            session_id: session_id(service),
            base_revision: revision,
            request_id: format!("edit-{id}-{text}"),
            history_group: None,
            command: IpcNotesCommand::UpdateText {
                id: id.to_owned(),
                text: text.to_owned(),
            },
        })
        .expect("edit")
        .revision
}

fn session_id(_service: &NotesService<&FakeStorage>) -> String {
    "session".to_owned()
}

fn undo(service: &NotesService<&FakeStorage>, revision: u64) -> Result<u64, NotesErrorCode> {
    service
        .undo(HistoryRequest {
            session_id: session_id(service),
            base_revision: revision,
        })
        .map(|receipt| receipt.revision)
        .map_err(|error| error.code)
}

const FIRST: &str = "8a201f33-0000-4c91-8d02-000000000001";
const SECOND: &str = "8a201f33-0000-4c91-8d02-000000000002";

#[test]
fn undo_stops_at_an_entry_touching_a_merged_node() {
    let storage = FakeStorage::default();
    let service = service(&storage);
    let revision = create(&service, FIRST, 0);
    let revision = create(&service, SECOND, revision);
    let revision = edit(&service, FIRST, revision, "mine");
    let revision = edit(&service, SECOND, revision, "also mine");

    // Another device's edit lands on the first node.
    let revision = service
        .absorb_external(storage.merged_elsewhere(), &[FIRST.to_owned()])
        .expect("absorb");

    let receipt = service
        .undo(HistoryRequest {
            session_id: session_id(&service),
            base_revision: revision,
        })
        .expect("the second edit is untouched");
    assert!(
        !receipt.history.can_undo,
        "the screen has to stop offering a step the app will refuse"
    );
    assert_eq!(receipt.history.undo_depth, 0);
    let refused = undo(&service, receipt.revision);
    assert_eq!(
        refused,
        Err(NotesErrorCode::InvalidCommand),
        "reversing an entry about a node someone else has since changed would \
         throw their change away"
    );
}

#[test]
fn entries_above_the_barrier_still_undo() {
    let storage = FakeStorage::default();
    let service = service(&storage);
    let revision = create(&service, FIRST, 0);
    let revision = create(&service, SECOND, revision);
    let revision = edit(&service, FIRST, revision, "mine");
    let revision = edit(&service, SECOND, revision, "one");
    let revision = edit(&service, SECOND, revision, "two");

    let mut revision = service
        .absorb_external(storage.merged_elsewhere(), &[FIRST.to_owned()])
        .expect("absorb");

    // Both entries above the barrier come back; cutting the whole history
    // instead would lose them.
    for _ in 0..2 {
        revision = undo(&service, revision).expect("undo above the barrier");
    }
    assert_eq!(
        undo(&service, revision),
        Err(NotesErrorCode::InvalidCommand),
        "and the barrier still holds underneath them"
    );
}

#[test]
fn a_merge_with_no_overlap_leaves_history_alone() {
    let storage = FakeStorage::default();
    let service = service(&storage);
    let revision = create(&service, FIRST, 0);
    let revision = edit(&service, FIRST, revision, "mine");
    let depth = service.history_depth();

    let revision = service
        .absorb_external(
            storage.merged_elsewhere(),
            &["9d3f21b8-c440-4c91-8d02-2e77a05fb163".to_owned()],
        )
        .expect("absorb");

    assert_eq!(service.history_depth(), depth, "nothing was in question");
    assert!(undo(&service, revision).is_ok());
}

#[test]
fn redo_clears_when_the_merge_touches_a_redone_node() {
    let storage = FakeStorage::default();
    let service = service(&storage);
    let revision = create(&service, FIRST, 0);
    let revision = edit(&service, FIRST, revision, "mine");
    let revision = undo(&service, revision).expect("undo");

    let revision = service
        .absorb_external(storage.merged_elsewhere(), &[FIRST.to_owned()])
        .expect("absorb");

    let refused = service.redo(HistoryRequest {
        session_id: session_id(&service),
        base_revision: revision,
    });
    assert_eq!(
        refused.map_err(|error| error.code),
        Err(NotesErrorCode::HistoryEmpty),
        "replaying an edit onto a node somebody else has since changed is the \
         same hazard in the other direction, so the step stops existing"
    );
}

#[test]
fn the_barrier_counts_deleted_ids() {
    let storage = FakeStorage::default();
    let service = service(&storage);
    let revision = create(&service, FIRST, 0);
    let revision = edit(&service, FIRST, revision, "mine");

    // A merge that deleted the node rather than editing it.
    let revision = service
        .absorb_external(storage.merged_elsewhere(), &[FIRST.to_owned()])
        .expect("absorb");

    assert_eq!(
        undo(&service, revision),
        Err(NotesErrorCode::InvalidCommand),
        "a deletion is a change like any other"
    );
}
