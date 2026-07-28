use std::sync::Mutex;

use notes_application::{
    CommandEnvelope, HistoryRequest, IpcMarkerKind, IpcNotesCommand, MutationReceipt,
    NotesErrorCode, NotesService, StorageCommit, StorageError, StoragePort,
};
use notes_core::{DomainPatch, NodeId, NotesCommand, NotesTree, TreeMutation};

#[derive(Default)]
struct FakeState {
    revision: u64,
    tree: NotesTree,
    commit_count: usize,
}

#[derive(Default)]
struct FakeStorage {
    state: Mutex<FakeState>,
}

impl FakeStorage {
    fn text(&self, id: &str) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .tree
            .node(&NodeId::try_from(id).unwrap())
            .map(|node| node.text().to_owned())
    }

    fn commit_count(&self) -> usize {
        self.state.lock().unwrap().commit_count
    }

    fn editor_fields(&self, id: &str) -> Option<(String, bool, notes_core::NoteMarkerKind)> {
        self.state
            .lock()
            .unwrap()
            .tree
            .node(&NodeId::try_from(id).unwrap())
            .map(|node| (node.note().to_owned(), node.is_collapsed(), node.marker()))
    }

    fn children(&self, parent_id: &str) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .tree
            .children_of(&NodeId::try_from(parent_id).unwrap())
            .into_iter()
            .map(|id| id.to_string())
            .collect()
    }

    fn parent(&self, id: &str) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .tree
            .node(&NodeId::try_from(id).unwrap())
            .and_then(|node| node.parent_id())
            .map(ToString::to_string)
    }
}

impl StoragePort for FakeStorage {
    fn load_command_tree(&self, _command: &NotesCommand) -> Result<NotesTree, StorageError> {
        Ok(self.state.lock().unwrap().tree.clone())
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
        state
            .tree
            .apply(&patch.forward)
            .map_err(StorageError::Domain)?;
        state.revision += 1;
        state.commit_count += 1;
        let changed_nodes = patch
            .forward
            .iter()
            .filter_map(|mutation| match mutation {
                TreeMutation::Upsert(node) => Some(node.clone()),
                TreeMutation::Delete { .. } => None,
            })
            .collect();
        let deleted_ids = patch
            .forward
            .iter()
            .filter_map(|mutation| match mutation {
                TreeMutation::Delete { id } => Some(id.clone()),
                TreeMutation::Upsert(_) => None,
            })
            .collect();
        Ok(StorageCommit {
            revision: state.revision,
            changed_nodes,
            deleted_ids,
        })
    }
}

fn command(request_id: &str, base_revision: u64, command: IpcNotesCommand) -> CommandEnvelope {
    CommandEnvelope {
        session_id: "session".into(),
        request_id: request_id.into(),
        base_revision,
        history_group: None,
        command,
    }
}

fn grouped_command(
    request_id: &str,
    base_revision: u64,
    history_group: &str,
    notes_command: IpcNotesCommand,
) -> CommandEnvelope {
    CommandEnvelope {
        history_group: Some(history_group.into()),
        ..command(request_id, base_revision, notes_command)
    }
}

fn assert_history(receipt: &MutationReceipt, can_undo: bool, can_redo: bool) {
    assert_eq!(receipt.history.can_undo, can_undo);
    assert_eq!(receipt.history.can_redo, can_redo);
}

#[test]
fn create_edit_undo_redo_is_revisioned_and_request_idempotent() {
    let storage = FakeStorage::default();
    let service = NotesService::new(&storage, "session", 0);

    let page = service
        .execute(command(
            "create-page",
            0,
            IpcNotesCommand::CreatePage {
                id: "page".into(),
                text: "Inbox".into(),
            },
        ))
        .unwrap();
    assert_eq!(page.revision, 1);
    assert_history(&page, true, false);
    assert_eq!((page.history.undo_depth, page.history.redo_depth), (1, 0));

    let bullet = service
        .execute(command(
            "create-bullet",
            1,
            IpcNotesCommand::CreateNode {
                id: "bullet".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "first".into(),
            },
        ))
        .unwrap();
    assert_eq!(bullet.revision, 2);
    assert_eq!(bullet.history.undo_depth, 2);

    let edited = service
        .execute(command(
            "edit-bullet",
            2,
            IpcNotesCommand::UpdateText {
                id: "bullet".into(),
                text: "changed".into(),
            },
        ))
        .unwrap();
    assert_eq!(storage.text("bullet").as_deref(), Some("changed"));
    assert_eq!(edited.revision, 3);
    assert_eq!(edited.history.undo_depth, 3);

    let duplicate = service
        .execute(command(
            "edit-bullet",
            2,
            IpcNotesCommand::UpdateText {
                id: "bullet".into(),
                text: "ignored duplicate payload".into(),
            },
        ))
        .unwrap();
    assert_eq!(duplicate, edited);
    assert_eq!(storage.commit_count(), 3);

    let undone = service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 3,
        })
        .unwrap();
    assert_eq!(undone.revision, 4);
    assert_eq!(storage.text("bullet").as_deref(), Some("first"));
    assert_history(&undone, true, true);
    assert_eq!(
        (undone.history.undo_depth, undone.history.redo_depth),
        (2, 1)
    );

    let redone = service
        .redo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 4,
        })
        .unwrap();
    assert_eq!(redone.revision, 5);
    assert_eq!(storage.text("bullet").as_deref(), Some("changed"));
    assert_history(&redone, true, false);
    assert_eq!(
        (redone.history.undo_depth, redone.history.redo_depth),
        (3, 0)
    );
}

#[test]
fn stale_revision_is_a_retryable_conflict() {
    let storage = FakeStorage::default();
    let service = NotesService::new(&storage, "session", 0);
    service
        .execute(command(
            "create-page",
            0,
            IpcNotesCommand::CreatePage {
                id: "page".into(),
                text: "Inbox".into(),
            },
        ))
        .unwrap();

    let error = service
        .execute(command(
            "stale",
            0,
            IpcNotesCommand::CreatePage {
                id: "other".into(),
                text: "Other".into(),
            },
        ))
        .unwrap_err();

    assert_eq!(error.code, NotesErrorCode::RevisionConflict);
    assert!(error.retryable);
    assert_eq!(storage.commit_count(), 1);
}

#[test]
fn consecutive_commands_in_the_same_history_group_undo_as_one_edit() {
    let storage = FakeStorage::default();
    let service = NotesService::new(&storage, "session", 0);
    service
        .execute(command(
            "page",
            0,
            IpcNotesCommand::CreatePage {
                id: "page".into(),
                text: "Original".into(),
            },
        ))
        .unwrap();
    let coalesced = service
        .execute(grouped_command(
            "edit-1",
            1,
            "text:page",
            IpcNotesCommand::UpdateText {
                id: "page".into(),
                text: "Original draft".into(),
            },
        ))
        .unwrap();
    assert_eq!(coalesced.history.undo_depth, 2);
    let still_coalesced = service
        .execute(grouped_command(
            "edit-2",
            2,
            "text:page",
            IpcNotesCommand::UpdateText {
                id: "page".into(),
                text: "Final text".into(),
            },
        ))
        .unwrap();
    assert_eq!(still_coalesced.history.undo_depth, 2);

    service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 3,
        })
        .unwrap();

    assert_eq!(storage.text("page").as_deref(), Some("Original"));
}

#[test]
fn node_editor_fields_share_generated_ipc_and_one_reversible_history_group() {
    let storage = FakeStorage::default();
    let service = NotesService::new(&storage, "session", 0);
    for (request_id, revision, notes_command) in [
        (
            "page",
            0,
            IpcNotesCommand::CreatePage {
                id: "page".into(),
                text: "Page".into(),
            },
        ),
        (
            "row",
            1,
            IpcNotesCommand::CreateNode {
                id: "row".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "Row".into(),
            },
        ),
    ] {
        service
            .execute(command(request_id, revision, notes_command))
            .unwrap();
    }
    for (request_id, revision, notes_command) in [
        (
            "note",
            2,
            IpcNotesCommand::UpdateNote {
                id: "row".into(),
                note: "Context".into(),
            },
        ),
        (
            "collapse",
            3,
            IpcNotesCommand::SetCollapsed {
                id: "row".into(),
                collapsed: true,
            },
        ),
        (
            "marker",
            4,
            IpcNotesCommand::SetMarker {
                id: "row".into(),
                marker: IpcMarkerKind::Todo,
            },
        ),
    ] {
        service
            .execute(grouped_command(
                request_id,
                revision,
                "editor:row",
                notes_command,
            ))
            .unwrap();
    }
    assert_eq!(
        storage.editor_fields("row"),
        Some(("Context".into(), true, notes_core::NoteMarkerKind::Todo))
    );

    service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 5,
        })
        .unwrap();
    assert_eq!(
        storage.editor_fields("row"),
        Some((String::new(), false, notes_core::NoteMarkerKind::Bullet))
    );
}

#[test]
fn atomic_editor_gesture_split_undoes_and_redoes_as_one_history_entry() {
    let storage = FakeStorage::default();
    let service = NotesService::new(&storage, "session", 0);
    for (request_id, revision, notes_command) in [
        (
            "page",
            0,
            IpcNotesCommand::CreatePage {
                id: "page".into(),
                text: "Page".into(),
            },
        ),
        (
            "current",
            1,
            IpcNotesCommand::CreateNode {
                id: "current".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "alphaXYZomega".into(),
            },
        ),
        (
            "next",
            2,
            IpcNotesCommand::CreateNode {
                id: "next".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "Next".into(),
            },
        ),
    ] {
        service
            .execute(command(request_id, revision, notes_command))
            .unwrap();
    }

    service
        .execute(command(
            "split",
            3,
            IpcNotesCommand::SplitNode {
                id: "current".into(),
                new_id: "split".into(),
                parent_id: "page".into(),
                before_id: Some("next".into()),
                prefix: "alpha".into(),
                suffix: "omega".into(),
            },
        ))
        .unwrap();
    assert_eq!(storage.text("current").as_deref(), Some("alpha"));
    assert_eq!(storage.text("split").as_deref(), Some("omega"));
    assert_eq!(storage.children("page"), ["current", "split", "next"]);

    service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 4,
        })
        .unwrap();
    assert_eq!(storage.text("current").as_deref(), Some("alphaXYZomega"));
    assert_eq!(storage.text("split"), None);
    assert_eq!(storage.children("page"), ["current", "next"]);

    service
        .redo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 5,
        })
        .unwrap();
    assert_eq!(storage.text("current").as_deref(), Some("alpha"));
    assert_eq!(storage.text("split").as_deref(), Some("omega"));
}

#[test]
fn atomic_editor_gesture_empty_removal_lifts_children_and_undoes_once() {
    let storage = FakeStorage::default();
    let service = NotesService::new(&storage, "session", 0);
    for (request_id, revision, notes_command) in [
        (
            "page",
            0,
            IpcNotesCommand::CreatePage {
                id: "page".into(),
                text: "Page".into(),
            },
        ),
        (
            "before",
            1,
            IpcNotesCommand::CreateNode {
                id: "before".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "Before".into(),
            },
        ),
        (
            "empty",
            2,
            IpcNotesCommand::CreateNode {
                id: "empty".into(),
                parent_id: "page".into(),
                before_id: None,
                text: " ".into(),
            },
        ),
        (
            "child",
            3,
            IpcNotesCommand::CreateNode {
                id: "child".into(),
                parent_id: "empty".into(),
                before_id: None,
                text: "Child".into(),
            },
        ),
        (
            "after",
            4,
            IpcNotesCommand::CreateNode {
                id: "after".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "After".into(),
            },
        ),
    ] {
        service
            .execute(command(request_id, revision, notes_command))
            .unwrap();
    }

    service
        .execute(command(
            "remove",
            5,
            IpcNotesCommand::RemoveEmptyNode { id: "empty".into() },
        ))
        .unwrap();
    assert_eq!(storage.text("empty"), None);
    assert_eq!(storage.parent("child").as_deref(), Some("page"));
    assert_eq!(storage.children("page"), ["before", "child", "after"]);

    service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 6,
        })
        .unwrap();
    assert_eq!(storage.text("empty").as_deref(), Some(" "));
    assert_eq!(storage.parent("child").as_deref(), Some("empty"));
    assert_eq!(storage.children("page"), ["before", "empty", "after"]);
}
