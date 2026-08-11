use notes_application::{CommandEnvelope, HistoryRequest, IpcNotesCommand, NotesService};
use notes_core::NodeId;
use notes_sqlite::SqliteStorage;

fn command(
    request_id: &str,
    base_revision: u64,
    group: Option<&str>,
    command: IpcNotesCommand,
) -> CommandEnvelope {
    CommandEnvelope {
        session_id: "session".into(),
        request_id: request_id.into(),
        base_revision,
        history_group: group.map(str::to_owned),
        command,
    }
}

fn history(base_revision: u64) -> HistoryRequest {
    HistoryRequest {
        session_id: "session".into(),
        base_revision,
    }
}

fn parent_of(storage: &SqliteStorage, id: &str) -> Option<String> {
    storage
        .node(id)
        .unwrap()
        .unwrap()
        .parent_id()
        .map(NodeId::to_string)
}

fn seed(
    storage: &SqliteStorage,
    service: &NotesService<&SqliteStorage>,
    rows: &[(&str, &str, &str)],
) {
    service
        .execute(command(
            "page",
            0,
            None,
            IpcNotesCommand::CreateNode {
                id: "page".into(),
                parent_id: "root".into(),
                before_id: None,
                text: "Page".into(),
            },
        ))
        .unwrap();
    for (id, parent_id, text) in rows {
        service
            .execute(command(
                id,
                storage.revision().unwrap(),
                None,
                IpcNotesCommand::CreateNode {
                    id: (*id).into(),
                    parent_id: (*parent_id).into(),
                    before_id: None,
                    text: (*text).into(),
                },
            ))
            .unwrap();
    }
}

// The parent-merge gesture: the parent takes the merged text, the child is
// blanked, and removeEmptyNode drops it — all under one history group, so the
// entry replays two upserts of the child on undo.
#[test]
fn undoing_a_coalesced_parent_merge_restores_the_row_it_re_inserts() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    seed(
        &storage,
        &service,
        &[
            ("parent", "page", "뭔가"),
            ("child", "parent", "하지만"),
            ("grandchild", "child", "손자"),
            ("sibling", "parent", "이런것이"),
        ],
    );

    for (request_id, notes_command) in [
        (
            "merge-text",
            IpcNotesCommand::UpdateText {
                id: "parent".into(),
                text: "뭔가하지만".into(),
            },
        ),
        (
            "blank",
            IpcNotesCommand::UpdateText {
                id: "child".into(),
                text: String::new(),
            },
        ),
        (
            "remove",
            IpcNotesCommand::RemoveEmptyNode { id: "child".into() },
        ),
    ] {
        service
            .execute(command(
                request_id,
                storage.revision().unwrap(),
                Some("backspace:1"),
                notes_command,
            ))
            .unwrap();
    }
    assert!(storage.node("child").unwrap().is_none());
    assert_eq!(parent_of(&storage, "grandchild").as_deref(), Some("parent"));

    let assert_restored = |storage: &SqliteStorage| {
        assert_eq!(storage.node("parent").unwrap().unwrap().text(), "뭔가");
        assert_eq!(storage.node("child").unwrap().unwrap().text(), "하지만");
        assert_eq!(parent_of(storage, "child").as_deref(), Some("parent"));
        assert_eq!(parent_of(storage, "grandchild").as_deref(), Some("child"));
        assert!(
            storage.node("child").unwrap().unwrap().sort_key()
                < storage.node("sibling").unwrap().unwrap().sort_key()
        );
    };

    service.undo(history(storage.revision().unwrap())).unwrap();
    assert_restored(&storage);

    service.redo(history(storage.revision().unwrap())).unwrap();
    assert_eq!(
        storage.node("parent").unwrap().unwrap().text(),
        "뭔가하지만"
    );
    assert!(storage.node("child").unwrap().is_none());
    assert_eq!(parent_of(&storage, "grandchild").as_deref(), Some("parent"));

    service.undo(history(storage.revision().unwrap())).unwrap();
    assert_restored(&storage);
}

// The plain empty-row backspace coalesces the same way: the blanking edit and
// the removal share a group, so its undo replays two upserts of the row too.
#[test]
fn undoing_a_coalesced_blank_then_remove_restores_the_original_text() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    seed(&storage, &service, &[("row", "page", "원래")]);

    for (request_id, notes_command) in [
        (
            "blank",
            IpcNotesCommand::UpdateText {
                id: "row".into(),
                text: String::new(),
            },
        ),
        (
            "remove",
            IpcNotesCommand::RemoveEmptyNode { id: "row".into() },
        ),
    ] {
        service
            .execute(command(
                request_id,
                storage.revision().unwrap(),
                Some("backspace:2"),
                notes_command,
            ))
            .unwrap();
    }
    assert!(storage.node("row").unwrap().is_none());

    service.undo(history(storage.revision().unwrap())).unwrap();
    assert_eq!(storage.node("row").unwrap().unwrap().text(), "원래");
}
