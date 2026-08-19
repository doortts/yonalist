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

    fn cycle(&mut self, node_id: &str) {
        self.run(IpcNotesCommand::CycleCompleted { id: node_id.into() });
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
        // Something in it: a blank row is room to type, not one thing more to do.
        text: "one more thing".into(),
    });

    assert!(!session.is_completed("parent"));
    // The press only ever spoke for `parent`; the rows under it are as they were.
    for row in ["done", "open", "bare"] {
        assert!(!session.is_completed(row), "{row} was touched");
    }
}

/// The rows a settle has to read sit beside the row that left, and only the
/// working set can bring them: the branch is judged from the stored rows, not
/// from the one row the command names.
#[test]
fn trashing_the_last_open_row_finishes_the_branch_in_storage() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);
    session.set_completed("open", true);
    assert!(!session.is_completed("parent"));

    session.run(IpcNotesCommand::DeleteSubtree { id: "bare".into() });

    assert!(session.is_completed("parent"));
}

#[test]
fn trashing_a_row_with_another_still_open_leaves_the_branch_open_in_storage() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);

    session.run(IpcNotesCommand::DeleteSubtree { id: "bare".into() });

    // `open` is still open, so nothing above it is finished.
    assert!(!session.is_completed("parent"));
}

/// A merge takes a row away like any other departure, so it has to bring the rows
/// that stay along. A row nobody loaded reads as no row at all, and the row above
/// it closes over it.
#[test]
fn merging_a_row_backward_does_not_close_over_a_row_it_never_loaded() {
    let storage = SqliteStorage::open_in_memory().unwrap();
    let forward = vec![
        TreeMutation::upsert(NoteNode::child(id("page"), id("root"), 1_024, "Page")),
        TreeMutation::upsert(NoteNode::child(id("parent"), id("page"), 1_024, "Parent")),
        TreeMutation::upsert(NoteNode::from_persisted(
            id("target"),
            Some(id("parent")),
            2_048,
            NoteNodeKind::Bullet,
            "Target".into(),
            String::new(),
            NoteMarkerKind::Bullet,
            false,
            true,
            false,
            false,
        )),
        TreeMutation::upsert(NoteNode::child(id("previous"), id("parent"), 1_024, "Text")),
        // A row the merge's own working set has to reach: the sibling that stays,
        // still open, so `parent` is not finished once the merge is done.
        TreeMutation::upsert(NoteNode::child(
            id("sibling"),
            id("parent"),
            3_072,
            "Sibling",
        )),
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
    let mut session = Session::open(&storage);

    // Backspace at the head of the finished row: the open row above it goes
    // away, and the row that stays is already done.
    session.run(IpcNotesCommand::MergeNodeBackward {
        id: "target".into(),
        previous_id: "previous".into(),
        previous_text: "Text".into(),
        current_text: "Target".into(),
    });

    assert!(!session.is_completed("parent"));
}

/// Backspace on a blank row removes it, and that is a departure like any other:
/// the branch it was holding open can be finished.
#[test]
fn removing_a_blank_row_finishes_the_branch_in_storage() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);
    session.set_completed("open", true);
    session.run(IpcNotesCommand::UpdateText {
        id: "bare".into(),
        text: String::new(),
    });
    assert!(!session.is_completed("parent"));

    session.run(IpcNotesCommand::RemoveEmptyNode { id: "bare".into() });

    assert!(session.is_completed("parent"));
}

/// The settle rides in the delete's own patch, so one undo takes both back.
#[test]
fn undoing_the_delete_reopens_the_branch_it_finished() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);
    session.set_completed("open", true);
    session.run(IpcNotesCommand::DeleteSubtree { id: "bare".into() });
    assert!(session.is_completed("parent"));

    session.undo().unwrap();

    assert!(!session.is_completed("parent"));
    assert!(session.is_completed("done"));
}

/// The same three placements the domain covers, but through storage: the rows the
/// climb reads can only be the ones the working set loaded, and each command
/// loads its own.
#[test]
fn a_moved_row_opens_the_finished_rows_above_it_in_storage() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.run(IpcNotesCommand::CreateNode {
        id: "elsewhere".into(),
        parent_id: "page".into(),
        before_id: None,
        text: "Elsewhere".into(),
    });
    session.set_completed("parent", true);

    session.run(IpcNotesCommand::MoveNode {
        id: "elsewhere".into(),
        parent_id: "parent".into(),
        before_id: None,
    });

    assert!(!session.is_completed("parent"));
}

#[test]
fn a_duplicate_opens_the_finished_rows_above_it_in_storage() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.run(IpcNotesCommand::CreateNode {
        id: "source".into(),
        parent_id: "page".into(),
        before_id: None,
        text: "Source".into(),
    });
    session.set_completed("parent", true);

    session.run(IpcNotesCommand::Duplicate {
        id: "source".into(),
        new_id: "source-copy".into(),
        parent_id: "parent".into(),
        before_id: None,
    });

    assert!(!session.is_completed("parent"));
}

#[test]
fn a_row_out_of_the_trash_opens_the_finished_rows_above_it_in_storage() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.run(IpcNotesCommand::DeleteSubtree { id: "open".into() });
    session.set_completed("parent", true);
    assert!(session.is_completed("parent"));

    session.run(IpcNotesCommand::RestoreSubtree { id: "open".into() });

    assert!(!session.is_completed("parent"));
}

/// The reopening rides in the same patch as the row that caused it, so one undo
/// takes both back.
#[test]
fn undoing_the_new_row_puts_the_tick_it_opened_back() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("parent", true);
    session.run(IpcNotesCommand::CreateNode {
        id: "fresh".into(),
        parent_id: "parent".into(),
        before_id: None,
        // Something in it: a blank row is room to type, not one thing more to do.
        text: "one more thing".into(),
    });
    assert!(!session.is_completed("parent"));

    session.undo().unwrap();

    assert!(session.is_completed("parent"));
}

/// The three presses, through storage. `stored_page` holds `parent` over `done`,
/// `open` and `bare`.
#[test]
fn the_first_press_finishes_only_the_row_itself() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);

    session.cycle("parent");

    assert!(session.is_completed("parent"));
    assert!(session.is_completed("done"));
    for row in ["open", "bare"] {
        assert!(!session.is_completed(row), "{row} was touched");
    }
}

#[test]
fn the_second_press_finishes_the_children() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);
    session.cycle("parent");

    session.cycle("parent");

    for row in ["parent", "done", "open", "bare"] {
        assert!(session.is_completed(row), "{row} was left open");
    }
}

#[test]
fn the_third_press_hands_the_children_back_their_own_states() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);
    session.cycle("parent");
    session.cycle("parent");

    session.cycle("parent");

    assert!(!session.is_completed("parent"));
    // Finished before the press that finished the others, so it keeps its tick.
    assert!(session.is_completed("done"));
    for row in ["open", "bare"] {
        assert!(!session.is_completed(row), "{row} was not handed back");
    }
}

#[test]
fn a_row_with_no_children_turns_over_in_two_presses() {
    let storage = stored_page();
    let mut session = Session::open(&storage);

    session.cycle("bare");
    assert!(session.is_completed("bare"));

    session.cycle("bare");
    assert!(!session.is_completed("bare"));
}

#[test]
fn an_edit_in_between_leaves_the_children_alone() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);
    session.cycle("parent");
    session.cycle("parent");
    session.run(IpcNotesCommand::UpdateText {
        id: "bare".into(),
        text: "Bare, edited".into(),
    });

    session.cycle("parent");

    assert!(!session.is_completed("parent"));
    // Nothing remembers what they held, so they stay as the press left them.
    for row in ["done", "open", "bare"] {
        assert!(
            session.is_completed(row),
            "{row} was changed with no memory"
        );
    }
}

#[test]
fn undoing_the_press_that_finished_the_children_takes_it_back_whole() {
    let storage = stored_page();
    let mut session = Session::open(&storage);
    session.set_completed("done", true);
    session.cycle("parent");
    session.cycle("parent");

    session.undo().unwrap();

    assert!(session.is_completed("parent"));
    assert!(session.is_completed("done"));
    assert!(!session.is_completed("open"));
}
