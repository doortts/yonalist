use notes_application::{
    CommandEnvelope, HistoryRequest, IpcEditorCommand, IpcImportNode, IpcMarkerKind,
    IpcNodeDuplicate, IpcNodeMove, IpcNotesCommand, NotesService, SearchQuery, StorageError,
    StoragePort, ViewportRequest,
};
use notes_core::{DomainPatch, NodeId, NoteNode, TreeMutation};
use notes_sqlite::SqliteStorage;

fn command(request_id: &str, base_revision: u64, command: IpcNotesCommand) -> CommandEnvelope {
    CommandEnvelope {
        session_id: "session".into(),
        request_id: request_id.into(),
        base_revision,
        history_group: None,
        command,
    }
}

#[test]
fn page_bullet_commit_restart_and_session_undo_are_end_to_end() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("notes-v2.sqlite");
    {
        let storage = SqliteStorage::open(&database).unwrap();
        let service = NotesService::new(&storage, "session", 0);
        service
            .execute(command(
                "page",
                0,
                IpcNotesCommand::CreatePage {
                    id: "page".into(),
                    text: "Inbox".into(),
                },
            ))
            .unwrap();
        service
            .execute(command(
                "bullet",
                1,
                IpcNotesCommand::CreateNode {
                    id: "bullet".into(),
                    parent_id: "page".into(),
                    before_id: None,
                    text: "first".into(),
                },
            ))
            .unwrap();
        service
            .execute(command(
                "edit",
                2,
                IpcNotesCommand::UpdateText {
                    id: "bullet".into(),
                    text: "changed".into(),
                },
            ))
            .unwrap();
        service
            .undo(HistoryRequest {
                session_id: "session".into(),
                base_revision: 3,
            })
            .unwrap();
        assert_eq!(storage.node("bullet").unwrap().unwrap().text(), "first");
        assert_eq!(storage.revision().unwrap(), 4);
    }

    let reopened = SqliteStorage::open(&database).unwrap();
    assert_eq!(reopened.revision().unwrap(), 4);
    assert_eq!(reopened.node("bullet").unwrap().unwrap().text(), "first");
    let restarted_session = NotesService::new(&reopened, "new-session", 4);
    let error = restarted_session
        .undo(HistoryRequest {
            session_id: "new-session".into(),
            base_revision: 4,
        })
        .unwrap_err();
    assert_eq!(error.code, notes_application::NotesErrorCode::HistoryEmpty);
}

#[test]
fn editor_batch_split_and_inverse_restore_stable_ids_across_restarts() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("editor-batch.sqlite");
    {
        let storage = SqliteStorage::open(&database).unwrap();
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
                    text: "alphaomega".into(),
                },
            ),
            (
                "next",
                2,
                IpcNotesCommand::CreateNode {
                    id: "next".into(),
                    parent_id: "page".into(),
                    before_id: None,
                    text: "next".into(),
                },
            ),
        ] {
            service
                .execute(command(request_id, revision, notes_command))
                .unwrap();
        }

        let receipt = service
            .execute(command(
                "editor-split",
                3,
                IpcNotesCommand::ApplyEditorBatch {
                    commands: vec![IpcEditorCommand::SplitNode {
                        id: "current".into(),
                        new_id: "inserted".into(),
                        parent_id: "page".into(),
                        before_id: Some("next".into()),
                        prefix: "alpha".into(),
                        suffix: "omega".into(),
                    }],
                },
            ))
            .expect("persist editor split");
        assert_eq!(receipt.revision, 4);
        assert_eq!(
            (receipt.history.undo_depth, receipt.history.redo_depth),
            (0, 0)
        );
    }

    {
        let storage = SqliteStorage::open(&database).unwrap();
        assert_eq!(storage.node("current").unwrap().unwrap().text(), "alpha");
        assert_eq!(storage.node("inserted").unwrap().unwrap().text(), "omega");
        let viewport = storage
            .query_viewport(ViewportRequest {
                page_id: "page".into(),
                anchor_id: None,
                before_cursor: None,
                after_cursor: None,
                limit: 20,
            })
            .unwrap();
        assert_eq!(
            viewport
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec!["current", "inserted", "next"]
        );

        let service = NotesService::new(&storage, "restart", 4);
        service
            .execute(CommandEnvelope {
                session_id: "restart".into(),
                request_id: "editor-inverse".into(),
                base_revision: 4,
                history_group: None,
                command: IpcNotesCommand::ApplyEditorBatch {
                    commands: vec![
                        IpcEditorCommand::UpdateText {
                            id: "inserted".into(),
                            text: String::new(),
                        },
                        IpcEditorCommand::RemoveEmptyNode {
                            id: "inserted".into(),
                        },
                        IpcEditorCommand::UpdateText {
                            id: "current".into(),
                            text: "alphaomega".into(),
                        },
                    ],
                },
            })
            .expect("persist editor inverse");
    }

    let reopened = SqliteStorage::open(&database).unwrap();
    assert_eq!(reopened.revision().unwrap(), 5);
    assert_eq!(
        reopened.node("current").unwrap().unwrap().text(),
        "alphaomega"
    );
    assert!(reopened.node("inserted").unwrap().is_none());
    assert_eq!(reopened.node("next").unwrap().unwrap().text(), "next");
}

#[test]
fn batch_complete_and_delete_each_commit_as_one_history_entry() {
    let storage = SqliteStorage::open_in_memory().unwrap();
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
            "one",
            1,
            IpcNotesCommand::CreateNode {
                id: "one".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "One".into(),
            },
        ),
        (
            "two",
            2,
            IpcNotesCommand::CreateNode {
                id: "two".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "Two".into(),
            },
        ),
    ] {
        service
            .execute(command(request_id, revision, notes_command))
            .unwrap();
    }

    service
        .execute(command(
            "complete-many",
            3,
            IpcNotesCommand::SetCompletedMany {
                ids: vec!["one".into(), "two".into()],
                completed: true,
            },
        ))
        .unwrap();
    assert_eq!(storage.revision().unwrap(), 4);
    assert!(storage.node("one").unwrap().unwrap().is_completed());
    assert!(storage.node("two").unwrap().unwrap().is_completed());
    service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 4,
        })
        .unwrap();
    assert!(!storage.node("one").unwrap().unwrap().is_completed());
    assert!(!storage.node("two").unwrap().unwrap().is_completed());

    service
        .execute(command(
            "delete-many",
            5,
            IpcNotesCommand::DeleteSubtrees {
                ids: vec!["one".into(), "two".into()],
            },
        ))
        .unwrap();
    assert_eq!(storage.revision().unwrap(), 6);
    assert!(storage.node("one").unwrap().unwrap().is_deleted());
    assert!(storage.node("two").unwrap().unwrap().is_deleted());
    service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 6,
        })
        .unwrap();
    assert!(!storage.node("one").unwrap().unwrap().is_deleted());
    assert!(!storage.node("two").unwrap().unwrap().is_deleted());
}

#[test]
fn outline_import_preserves_hierarchy_in_one_revision_and_one_undo() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    service
        .execute(command(
            "page",
            0,
            IpcNotesCommand::CreatePage {
                id: "page".into(),
                text: "Page".into(),
            },
        ))
        .unwrap();
    service
        .execute(command(
            "import",
            1,
            IpcNotesCommand::ImportNodes {
                parent_id: "page".into(),
                before_id: None,
                nodes: vec![
                    IpcImportNode {
                        id: "parent".into(),
                        parent_id: "page".into(),
                        text: "Parent".into(),
                    },
                    IpcImportNode {
                        id: "child".into(),
                        parent_id: "parent".into(),
                        text: "Child".into(),
                    },
                    IpcImportNode {
                        id: "sibling".into(),
                        parent_id: "page".into(),
                        text: "Sibling".into(),
                    },
                ],
            },
        ))
        .unwrap();

    assert_eq!(storage.revision().unwrap(), 2);
    assert_eq!(
        storage.node("child").unwrap().unwrap().parent_id(),
        Some(&NodeId::try_from("parent").unwrap())
    );
    service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 2,
        })
        .unwrap();
    for id in ["parent", "child", "sibling"] {
        assert!(storage.node(id).unwrap().is_none());
    }
}

#[test]
fn batch_move_commits_and_undoes_as_one_revision() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    service
        .execute(command(
            "page",
            0,
            IpcNotesCommand::CreatePage {
                id: "page".into(),
                text: "Page".into(),
            },
        ))
        .unwrap();
    for (index, id) in ["a", "b", "c"].into_iter().enumerate() {
        service
            .execute(command(
                id,
                u64::try_from(index + 1).unwrap(),
                IpcNotesCommand::CreateNode {
                    id: id.into(),
                    parent_id: "page".into(),
                    before_id: None,
                    text: id.to_uppercase(),
                },
            ))
            .unwrap();
    }

    service
        .execute(command(
            "move-many",
            4,
            IpcNotesCommand::MoveNodes {
                moves: ["b", "c"]
                    .into_iter()
                    .map(|id| IpcNodeMove {
                        id: id.into(),
                        parent_id: "a".into(),
                        before_id: None,
                    })
                    .collect(),
            },
        ))
        .unwrap();
    assert_eq!(storage.revision().unwrap(), 5);
    for id in ["b", "c"] {
        assert_eq!(
            storage.node(id).unwrap().unwrap().parent_id(),
            Some(&NodeId::try_from("a").unwrap())
        );
    }
    service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 5,
        })
        .unwrap();
    for id in ["b", "c"] {
        assert_eq!(
            storage.node(id).unwrap().unwrap().parent_id(),
            Some(&NodeId::try_from("page").unwrap())
        );
    }
}

#[test]
fn batch_duplicate_commits_and_undoes_as_one_revision() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    service
        .execute(command(
            "page",
            0,
            IpcNotesCommand::CreatePage {
                id: "page".into(),
                text: "Page".into(),
            },
        ))
        .unwrap();
    for (index, id) in ["a", "b"].into_iter().enumerate() {
        service
            .execute(command(
                id,
                u64::try_from(index + 1).unwrap(),
                IpcNotesCommand::CreateNode {
                    id: id.into(),
                    parent_id: "page".into(),
                    before_id: None,
                    text: id.to_uppercase(),
                },
            ))
            .unwrap();
    }

    service
        .execute(command(
            "duplicate-many",
            3,
            IpcNotesCommand::DuplicateNodes {
                duplicates: ["a", "b"]
                    .into_iter()
                    .map(|id| IpcNodeDuplicate {
                        id: id.into(),
                        new_id: format!("{id}-copy"),
                        parent_id: "page".into(),
                        before_id: None,
                    })
                    .collect(),
            },
        ))
        .unwrap();
    assert_eq!(storage.revision().unwrap(), 4);
    assert_eq!(storage.node("a-copy").unwrap().unwrap().text(), "A");
    assert_eq!(storage.node("b-copy").unwrap().unwrap().text(), "B");
    service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 4,
        })
        .unwrap();
    assert!(storage.node("a-copy").unwrap().is_none());
    assert!(storage.node("b-copy").unwrap().is_none());
}

#[test]
fn atomic_editor_gestures_commit_and_restart_with_one_revision_each() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("atomic-editor.sqlite");
    {
        let storage = SqliteStorage::open(&database).unwrap();
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
        service
            .execute(command(
                "empty",
                4,
                IpcNotesCommand::CreateNode {
                    id: "empty".into(),
                    parent_id: "page".into(),
                    before_id: None,
                    text: " ".into(),
                },
            ))
            .unwrap();
        service
            .execute(command(
                "child",
                5,
                IpcNotesCommand::CreateNode {
                    id: "child".into(),
                    parent_id: "empty".into(),
                    before_id: None,
                    text: "Child".into(),
                },
            ))
            .unwrap();
        service
            .execute(command(
                "remove",
                6,
                IpcNotesCommand::RemoveEmptyNode { id: "empty".into() },
            ))
            .unwrap();

        assert_eq!(storage.revision().unwrap(), 7);
        assert_eq!(storage.node("current").unwrap().unwrap().text(), "alpha");
        assert_eq!(storage.node("split").unwrap().unwrap().text(), "omega");
        assert!(storage.node("empty").unwrap().is_none());
        assert_eq!(
            storage
                .node("child")
                .unwrap()
                .unwrap()
                .parent_id()
                .map(NodeId::as_str),
            Some("page")
        );
    }

    let reopened = SqliteStorage::open(&database).unwrap();
    assert_eq!(reopened.revision().unwrap(), 7);
    assert_eq!(reopened.node("current").unwrap().unwrap().text(), "alpha");
    assert_eq!(reopened.node("split").unwrap().unwrap().text(), "omega");
    assert!(reopened.node("empty").unwrap().is_none());
    assert_eq!(
        reopened
            .node("child")
            .unwrap()
            .unwrap()
            .parent_id()
            .map(NodeId::as_str),
        Some("page")
    );
}

#[test]
fn backward_merge_commits_current_identity_and_undoes_in_one_revision() {
    let storage = SqliteStorage::open_in_memory().unwrap();
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
            "previous",
            1,
            IpcNotesCommand::CreateNode {
                id: "previous".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "stale previous".into(),
            },
        ),
        (
            "current",
            2,
            IpcNotesCommand::CreateNode {
                id: "current".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "stale current".into(),
            },
        ),
    ] {
        service
            .execute(command(request_id, revision, notes_command))
            .unwrap();
    }

    let receipt = service
        .execute(command(
            "merge",
            3,
            IpcNotesCommand::MergeNodeBackward {
                id: "current".into(),
                previous_id: "previous".into(),
                previous_text: "draft previous".into(),
                current_text: "draft current".into(),
            },
        ))
        .unwrap();

    assert_eq!(receipt.revision, 4);
    assert_eq!(receipt.deleted_ids, ["previous"]);
    assert_eq!(receipt.changed_nodes.len(), 1);
    assert_eq!(receipt.changed_nodes[0].id, "current");
    assert_eq!(
        storage.node("current").unwrap().unwrap().text(),
        "draft previousdraft current"
    );
    assert!(storage.node("previous").unwrap().is_none());

    service
        .undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: 4,
        })
        .unwrap();
    assert_eq!(
        storage.node("previous").unwrap().unwrap().text(),
        "stale previous"
    );
    assert_eq!(
        storage.node("current").unwrap().unwrap().text(),
        "stale current"
    );
}

#[test]
fn node_editor_fields_restart_and_supporting_note_indexes_are_end_to_end() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("node-editor.sqlite");
    {
        let storage = SqliteStorage::open(&database).unwrap();
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
            (
                "note",
                2,
                IpcNotesCommand::UpdateNote {
                    id: "row".into(),
                    note: "Context #detail 2026-07-28".into(),
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
                .execute(command(request_id, revision, notes_command))
                .unwrap();
        }
        for query in ["context", "tag:#detail", "date:2026-07-28"] {
            assert_eq!(
                storage
                    .search(SearchQuery {
                        text: query.into(),
                        cursor: None,
                        limit: 20,
                    })
                    .unwrap()
                    .hits
                    .len(),
                1,
                "{query}"
            );
        }
    }

    let reopened = SqliteStorage::open(&database).unwrap();
    let row = reopened.node("row").unwrap().unwrap();
    assert_eq!(row.note(), "Context #detail 2026-07-28");
    assert!(row.is_collapsed());
    assert_eq!(row.marker(), notes_core::NoteMarkerKind::Todo);
}

#[test]
fn invalid_patch_rolls_back_nodes_and_revision_atomically() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let orphan = NoteNode::child(
        NodeId::try_from("orphan").unwrap(),
        NodeId::try_from("missing").unwrap(),
        1_024,
        "orphan",
    );

    let result = storage.commit(
        0,
        &DomainPatch {
            forward: vec![TreeMutation::upsert(orphan)],
            inverse: vec![TreeMutation::Delete {
                id: NodeId::try_from("orphan").unwrap(),
            }],
        },
    );

    assert!(matches!(result, Err(StorageError::Internal(_))));
    assert_eq!(storage.revision().unwrap(), 0);
    assert!(storage.node("orphan").unwrap().is_none());
}

#[test]
fn stale_commit_never_applies_a_patch() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let page = NoteNode::page(NodeId::try_from("page").unwrap(), "Page");
    let page_id = page.id().clone();
    storage
        .commit(
            0,
            &DomainPatch {
                forward: vec![TreeMutation::upsert(page)],
                inverse: vec![TreeMutation::Delete { id: page_id }],
            },
        )
        .unwrap();

    let other = NoteNode::page(NodeId::try_from("other").unwrap(), "Other");
    let other_id = other.id().clone();
    let result = storage.commit(
        0,
        &DomainPatch {
            forward: vec![TreeMutation::upsert(other)],
            inverse: vec![TreeMutation::Delete { id: other_id }],
        },
    );

    assert_eq!(
        result,
        Err(StorageError::RevisionConflict {
            expected: 0,
            actual: 1,
        })
    );
    assert!(storage.node("other").unwrap().is_none());
}

#[test]
fn proposed_ids_never_overwrite_existing_nodes() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    service
        .execute(command(
            "page",
            0,
            IpcNotesCommand::CreatePage {
                id: "page".into(),
                text: "Inbox".into(),
            },
        ))
        .unwrap();
    service
        .execute(command(
            "original",
            1,
            IpcNotesCommand::CreateNode {
                id: "existing".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "preserve me".into(),
            },
        ))
        .unwrap();

    for (request_id, attempted) in [
        (
            "colliding-page",
            IpcNotesCommand::CreatePage {
                id: "existing".into(),
                text: "overwrite".into(),
            },
        ),
        (
            "colliding-node",
            IpcNotesCommand::CreateNode {
                id: "existing".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "overwrite".into(),
            },
        ),
        (
            "colliding-copy",
            IpcNotesCommand::Duplicate {
                id: "existing".into(),
                new_id: "page".into(),
                parent_id: "page".into(),
                before_id: None,
            },
        ),
    ] {
        let error = service
            .execute(command(request_id, 2, attempted))
            .unwrap_err();
        assert_eq!(
            error.code,
            notes_application::NotesErrorCode::InvalidCommand
        );
        assert_eq!(storage.revision().unwrap(), 2);
        assert_eq!(
            storage.node("existing").unwrap().unwrap().text(),
            "preserve me"
        );
    }
}
