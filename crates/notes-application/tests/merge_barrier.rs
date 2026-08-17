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
    /// A picture whose bytes have not landed: the node is a picture and holds
    /// none, which is exactly what the tree carries while the file waits.
    fn add_waiting_picture(&self, parent_id: &str, id: &str) {
        let node = notes_core::NoteNode::from_persisted_with_image(
            NodeId::try_from(id).unwrap(),
            Some(NodeId::try_from(parent_id).unwrap()),
            1_024,
            notes_core::NoteNodeKind::Image,
            None,
            "holiday.png".to_owned(),
            String::new(),
            notes_core::NoteMarkerKind::Bullet,
            false,
            false,
            false,
            false,
        );
        self.state
            .lock()
            .unwrap()
            .tree
            .apply(&[TreeMutation::upsert(node)])
            .expect("apply");
    }

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

const FIRST: &str = "Nd0000000001";
const SECOND: &str = "Nd0000000002";
const THIRD: &str = "Nd0000000003";

#[test]
fn undo_stops_at_an_entry_touching_a_merged_node() {
    let storage = FakeStorage::default();
    let service = service(&storage);
    let revision = create(&service, FIRST, 0);
    let revision = create(&service, SECOND, revision);
    let revision = edit(&service, FIRST, revision, "mine");
    edit(&service, SECOND, revision, "also mine");

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
    edit(&service, SECOND, revision, "two");

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
    edit(&service, FIRST, revision, "mine");
    let depth = service.history_depth();

    let revision = service
        .absorb_external(storage.merged_elsewhere(), &["Archive00001".to_owned()])
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
    undo(&service, revision).expect("undo");

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
    edit(&service, FIRST, revision, "mine");

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

/// Putting a defeated note back is an edit, so it has to go through the same
/// door every other edit does. A write that moved the stored revision without
/// telling this session would leave every later edit, undo and redo failing
/// until the app was restarted.
#[test]
fn a_session_keeps_working_after_a_note_is_restored() {
    let storage = FakeStorage::default();
    let service = service(&storage);
    let revision = create(&service, FIRST, 0);
    let revision = edit(&service, FIRST, revision, "theirs");

    let receipt = service.restore_conflict(FIRST, "mine").expect("restore");

    assert!(receipt.revision > revision, "a restore is a write");
    let after = edit(&service, FIRST, receipt.revision, "and life goes on");
    assert!(after > receipt.revision);
}

/// The floor is a position in a stack that drops its oldest entry when it
/// fills. If it did not move down with the stack, every rotation would convert
/// one reachable entry into a blocked one.
#[test]
fn the_barrier_moves_with_a_stack_that_rotates() {
    let storage = FakeStorage::default();
    let service = service(&storage);
    let mut revision = create(&service, FIRST, 0);
    revision = create(&service, SECOND, revision);
    edit(&service, FIRST, revision, "mine");
    revision = service
        .absorb_external(storage.merged_elsewhere(), &[FIRST.to_owned()])
        .expect("absorb");
    let reachable = service.history_depth();

    // Well past the stack's own limit, all about the other node.
    for round in 0..1_200 {
        revision = edit(&service, SECOND, revision, &format!("round {round}"));
    }

    let _ = reachable;
    assert_eq!(
        service.history_depth(),
        1_000,
        "once the blocked entry has itself rotated out, everything left is reachable — \
         a floor that stayed put would keep blocking whatever slid into its place"
    );
}

/// Typing after a merge is new work, and new work is undoable. Folding it into
/// the entry the merge blocked would make it un-undoable without anything
/// saying so.
#[test]
fn work_after_the_barrier_does_not_join_the_entry_below_it() {
    let storage = FakeStorage::default();
    let service = service(&storage);
    let revision = create(&service, FIRST, 0);
    let revision = create(&service, SECOND, revision);
    grouped_edit(&service, FIRST, revision, "one", "typing");
    let revision = service
        .absorb_external(storage.merged_elsewhere(), &[FIRST.to_owned()])
        .expect("absorb");
    assert_eq!(service.history_depth(), 0, "the barrier is up");

    let revision = grouped_edit(&service, SECOND, revision, "after", "typing");

    assert_eq!(
        service.history_depth(),
        1,
        "what the user types next is theirs to take back"
    );
    assert!(undo(&service, revision).is_ok());
}

/// A picture still waiting for its bytes reads as a node without one, so the
/// copy a duplicate makes depends on the source's own record rather than on
/// anything in its mutations. The barrier reads an entry to decide what is
/// still reversible, and it has to count that source too: otherwise a redo
/// hands the copy whatever picture the other device has since put there — one
/// the user never duplicated, with nothing on screen saying so.
#[test]
fn the_barrier_counts_the_picture_a_duplicate_had_to_borrow() {
    let storage = FakeStorage::default();
    let service = service(&storage);
    // A picture may not hang directly below the root, so it gets the bullet a
    // real one would sit on.
    let revision = create(&service, FIRST, 0);
    storage.add_waiting_picture(FIRST, SECOND);
    let revision = duplicate(&service, SECOND, THIRD, FIRST, revision);
    undo(&service, revision).expect("undo");

    // The other device changed the picture the copy is still waiting on.
    let revision = service
        .absorb_external(storage.merged_elsewhere(), &[SECOND.to_owned()])
        .expect("absorb");

    let refused = service.redo(HistoryRequest {
        session_id: session_id(&service),
        base_revision: revision,
    });
    assert_eq!(
        refused.map_err(|error| error.code),
        Err(NotesErrorCode::HistoryEmpty),
        "redoing the copy would take whichever picture the merge left on the source"
    );
}

fn duplicate(
    service: &NotesService<&FakeStorage>,
    source_id: &str,
    new_id: &str,
    parent_id: &str,
    revision: u64,
) -> u64 {
    service
        .execute(CommandEnvelope {
            session_id: session_id(service),
            base_revision: revision,
            request_id: format!("duplicate-{new_id}"),
            history_group: None,
            command: IpcNotesCommand::Duplicate {
                id: source_id.to_owned(),
                new_id: new_id.to_owned(),
                parent_id: parent_id.to_owned(),
                before_id: None,
            },
        })
        .expect("duplicate")
        .revision
}

fn grouped_edit(
    service: &NotesService<&FakeStorage>,
    id: &str,
    revision: u64,
    text: &str,
    group: &str,
) -> u64 {
    service
        .execute(CommandEnvelope {
            session_id: session_id(service),
            base_revision: revision,
            request_id: format!("grouped-{id}-{text}"),
            history_group: Some(group.to_owned()),
            command: IpcNotesCommand::UpdateText {
                id: id.to_owned(),
                text: text.to_owned(),
            },
        })
        .expect("edit")
        .revision
}
