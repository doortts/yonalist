use notes_application::{
    CommandEnvelope, HistoryRequest, IpcNotesCommand, MutationReceipt, NotesError, NotesService,
    StoragePort,
};
use notes_core::{DomainPatch, NodeId, NoteMarkerKind, NoteNode, NoteNodeKind, TreeMutation};
use notes_sqlite::SqliteStorage;

fn id(value: &str) -> NodeId {
    NodeId::try_from(value).unwrap()
}

fn todo(node_id: &str, parent_id: &str, sort_key: i64, completed: bool) -> NoteNode {
    NoteNode::from_persisted(
        id(node_id),
        Some(id(parent_id)),
        sort_key,
        NoteNodeKind::Bullet,
        node_id.into(),
        String::new(),
        NoteMarkerKind::Todo,
        false,
        completed,
        false,
        false,
    )
}

/// root
/// └ page (the page row)
///   └ parent (bullet)
///     ├ done (Todo, ticked before the parent is)
///     ├ open (Todo)
///     └ bare (bullet)
fn stored_page() -> SqliteStorage {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let forward = vec![
        TreeMutation::upsert(NoteNode::child(id("page"), id("root"), 1_024, "Page")),
        TreeMutation::upsert(NoteNode::child(id("parent"), id("page"), 1_024, "Parent")),
        TreeMutation::upsert(todo("done", "parent", 1_024, false)),
        TreeMutation::upsert(todo("open", "parent", 2_048, false)),
        TreeMutation::upsert(NoteNode::child(id("bare"), id("parent"), 3_072, "Bare")),
    ];
    let inverse = forward
        .iter()
        .filter_map(|mutation| match mutation {
            TreeMutation::Upsert(node) => Some(TreeMutation::Delete {
                id: node.id().clone(),
            }),
            TreeMutation::Delete { .. } => None,
        })
        .collect();
    storage
        .commit(
            0,
            &DomainPatch {
                forward,
                inverse,
                carried_pictures: Vec::new(),
            },
        )
        .unwrap();
    storage
}

/// One service across every command, because the memory a restore reads is the
/// session's own history: a fresh service is a fresh session with none of it.
struct Session<'a> {
    service: NotesService<&'a SqliteStorage>,
    storage: &'a SqliteStorage,
    revision: u64,
    request: usize,
}

impl<'a> Session<'a> {
    fn open(storage: &'a SqliteStorage) -> Self {
        let revision = storage.revision().unwrap();
        Self {
            service: NotesService::new(storage, "session", revision),
            storage,
            revision,
            request: 0,
        }
    }

    fn run(&mut self, command: IpcNotesCommand) -> MutationReceipt {
        self.request += 1;
        let receipt = self
            .service
            .execute(CommandEnvelope {
                session_id: "session".into(),
                request_id: format!("request-{}", self.request),
                base_revision: self.revision,
                history_group: None,
                command,
            })
            .unwrap();
        self.revision = receipt.revision;
        receipt
    }

    fn set_completed(&mut self, node_id: &str, completed: bool) {
        self.run(IpcNotesCommand::SetCompleted {
            id: node_id.into(),
            completed,
        });
    }

    fn set_completed_many(&mut self, node_ids: &[&str], completed: bool) {
        self.run(IpcNotesCommand::SetCompletedMany {
            ids: node_ids.iter().map(|value| (*value).to_owned()).collect(),
            completed,
        });
    }

    fn undo(&mut self) -> Result<MutationReceipt, NotesError> {
        let receipt = self.service.undo(HistoryRequest {
            session_id: "session".into(),
            base_revision: self.revision,
        })?;
        self.revision = receipt.revision;
        Ok(receipt)
    }

    fn is_completed(&self, node_id: &str) -> bool {
        self.storage.node(node_id).unwrap().unwrap().is_completed()
    }
}

/// The rows a new child has to open sit above it, and the working set has to
/// have loaded them: a page-deep branch is finished in storage, and only the
/// stored rows can say so.
#[test]
fn a_new_row_opens_the_finished_rows_above_it_in_storage() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("parent", true);
    assert!(session.is_completed("parent"));

    session.run(IpcNotesCommand::CreateNode {
        id: "fresh".into(),
        parent_id: "parent".into(),
        before_id: None,
        text: String::new(),
    });

    assert!(!session.is_completed("parent"));
    // The rows the tick had settled keep their own state.
    assert!(session.is_completed("done"));
    assert!(session.is_completed("open"));
}

#[test]
fn an_uncomplete_right_after_the_tick_hands_the_rows_back_their_own_states() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);

    session.set_completed("parent", true);
    for row in ["parent", "done", "open", "bare"] {
        assert!(session.is_completed(row), "{row} was left open by the tick");
    }

    session.set_completed("parent", false);

    assert!(!session.is_completed("parent"));
    // The row that was already ticked before the parent was keeps its tick.
    assert!(session.is_completed("done"));
    assert!(!session.is_completed("open"));
    assert!(!session.is_completed("bare"));
}

#[test]
fn taking_back_the_restore_puts_the_whole_branch_back() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);
    session.set_completed("parent", true);
    session.set_completed("parent", false);

    session.undo().unwrap();

    for row in ["parent", "done", "open", "bare"] {
        assert!(session.is_completed(row), "{row} did not come back");
    }
}

/// A selection hands its ids over in whatever order it holds them, and the two
/// halves of one gesture -- tick, then take it back -- need not hand them over
/// the same way. The rows are what identifies the gesture, not their order.
#[test]
fn a_selection_takes_its_tick_back_whatever_order_the_ids_arrive_in() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);

    session.set_completed_many(&["parent", "open"], true);
    session.set_completed_many(&["open", "parent"], false);

    assert!(!session.is_completed("parent"));
    assert!(!session.is_completed("open"));
    // Ticked before the selection was, so it keeps its tick.
    assert!(session.is_completed("done"));
}

#[test]
fn a_wider_selection_does_not_read_as_the_one_that_was_ticked() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);

    session.set_completed_many(&["parent"], true);
    // A different set of rows, so there is nothing to hand back: the clear is
    // the plain clear.
    session.set_completed_many(&["parent", "open"], false);

    assert!(!session.is_completed("done"));
}

#[test]
fn an_edit_in_between_closes_the_window() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);
    session.set_completed("parent", true);
    session.run(IpcNotesCommand::UpdateText {
        id: "bare".into(),
        text: "Bare, edited".into(),
    });

    session.set_completed("parent", false);

    // Nothing remembers what the rows held before, so an uncomplete is what it
    // has always been: the branch comes open.
    for row in ["parent", "done", "open", "bare"] {
        assert!(!session.is_completed(row), "{row} stayed ticked");
    }
}

#[test]
fn clearing_another_row_first_closes_the_window() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);
    session.set_completed("parent", true);
    session.set_completed("open", false);

    session.set_completed("parent", false);

    assert!(!session.is_completed("done"));
}
