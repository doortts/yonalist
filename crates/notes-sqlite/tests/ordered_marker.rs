use notes_application::{CommandEnvelope, IpcMarkerKind, IpcNotesCommand, NotesService};
use notes_core::NoteMarkerKind;
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

fn seed(service: &NotesService<&SqliteStorage>) {
    service
        .execute(command(
            "page",
            0,
            IpcNotesCommand::CreateNode {
                id: "page".into(),
                parent_id: "root".into(),
                before_id: None,
                text: "Inbox".into(),
            },
        ))
        .unwrap();
    service
        .execute(command(
            "row",
            1,
            IpcNotesCommand::CreateNode {
                id: "row".into(),
                parent_id: "page".into(),
                before_id: None,
                text: "Milk".into(),
            },
        ))
        .unwrap();
}

/// The number the reader typed belongs to the run, so it has to survive a
/// restart rather than every numbered row reopening at one.
#[test]
fn an_ordered_marker_keeps_the_number_it_started_at() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("notes-v2.sqlite");
    {
        let storage = SqliteStorage::open(&database).unwrap();
        let service = NotesService::new(&storage, "session", 0);
        seed(&service);
        service
            .execute(command(
                "ordered",
                2,
                IpcNotesCommand::SetMarker {
                    id: "row".into(),
                    marker: IpcMarkerKind::Ordered { start: 3 },
                },
            ))
            .unwrap();
    }

    let reopened = SqliteStorage::open(&database).unwrap();
    assert_eq!(
        reopened.node("row").unwrap().unwrap().marker(),
        NoteMarkerKind::Ordered { start: 3 }
    );
}

/// A row stepping back to a plain bullet reports one, so nothing downstream
/// keeps drawing a number off a marker that no longer carries it.
#[test]
fn a_row_leaving_the_ordered_marker_reports_the_plain_one() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let service = NotesService::new(&storage, "session", 0);
    seed(&service);
    for (revision, marker) in [
        (2, IpcMarkerKind::Ordered { start: 7 }),
        (3, IpcMarkerKind::Bullet),
    ] {
        service
            .execute(command(
                &format!("marker-{revision}"),
                revision,
                IpcNotesCommand::SetMarker {
                    id: "row".into(),
                    marker,
                },
            ))
            .unwrap();
    }

    assert_eq!(
        storage.node("row").unwrap().unwrap().marker(),
        NoteMarkerKind::Bullet
    );
}
