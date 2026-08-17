//! When the guide notes appear, and when they must not.
//!
//! The guide used to be written the moment a database was opened, which is
//! before the app knows whether this device is joining a folder that already
//! holds notes. Writing it then hands this device a fresh reading for every
//! line the guide occupies, and a fresh reading beats whatever the other
//! device said — including a deletion it made in between. So the guide waits
//! until somebody has decided what folder these notes live in.

use notes_application::StoragePort;
use notes_core::{NodeId, NotesCommand, Position};
use notes_sqlite::SqliteStorage;

fn database(directory: &tempfile::TempDir) -> std::path::PathBuf {
    directory.path().join("notes-v2.sqlite")
}

fn titles(storage: &SqliteStorage) -> Vec<String> {
    let snapshot = storage
        .bootstrap("session", 80)
        .expect("what the window would be handed");
    snapshot.pages.into_iter().map(|page| page.title).collect()
}

/// A database that has just been made holds nothing to show. That is the point:
/// the folder has not been chosen yet, and until it is, anything written here
/// is a claim this device has not earned.
#[test]
fn opening_a_database_writes_no_guide() {
    let directory = tempfile::tempdir().expect("home");
    let storage = SqliteStorage::open(&database(&directory)).expect("open");

    assert!(titles(&storage).is_empty());
}

/// The other half: once the decision is made, the guide is written.
#[test]
fn the_guide_arrives_when_it_is_asked_for() {
    let directory = tempfile::tempdir().expect("home");
    let storage = SqliteStorage::open(&database(&directory)).expect("open");

    storage.seed_onboarding().expect("the guide");

    assert_eq!(titles(&storage), vec!["Yonalist 시작하기".to_owned()]);
}

/// Asked twice — a second first run, a reopened app — it stays one guide.
#[test]
fn the_guide_is_written_once() {
    let directory = tempfile::tempdir().expect("home");
    let storage = SqliteStorage::open(&database(&directory)).expect("open");

    storage.seed_onboarding().expect("first");
    storage.seed_onboarding().expect("second");

    assert_eq!(titles(&storage), vec!["Yonalist 시작하기".to_owned()]);
}

/// And a device that has notes already — one that joined a folder and read it
/// — is never given a guide on top of them, whoever asks.
#[test]
fn a_device_that_already_has_notes_is_left_alone() {
    let directory = tempfile::tempdir().expect("home");
    let path = database(&directory);
    {
        let storage = SqliteStorage::open(&path).expect("open");
        storage.seed_onboarding().expect("the guide");
    }
    // Reopened, the way the app opens it on every later launch.
    let storage = SqliteStorage::open(&path).expect("reopen");

    storage.seed_onboarding().expect("asked again");

    assert_eq!(titles(&storage), vec!["Yonalist 시작하기".to_owned()]);
}

/// Choosing a folder answers the only question the first-run card asks — where
/// these notes live — so recording that choice settles the question on its own.
/// It used to be the guide that left the mark, which is why a device joining a
/// folder that already held notes was asked again on its next launch: that
/// device is given no guide, so nothing recorded its answer. The guide stays a
/// separate decision, and recording the folder writes none.
#[test]
fn recording_the_folder_settles_the_first_run_question_without_a_guide() {
    let directory = tempfile::tempdir().expect("home");
    let storage = SqliteStorage::open(&database(&directory)).expect("open");
    assert!(
        storage.onboarding_first_run().expect("asked"),
        "a database nobody has answered for is a first run"
    );

    storage
        .mark_onboarding_answered()
        .expect("the folder is recorded");

    assert!(
        !storage.onboarding_first_run().expect("asked again"),
        "the card would come back to ask a question it has the answer to"
    );
    assert!(
        titles(&storage).is_empty(),
        "recording the folder is not a request for a guide"
    );
}

/// A page of the user's own, written out into the folder the way the app writes
/// it. What the rebuild then reads back.
fn write_a_page(storage: &SqliteStorage, vault: &std::path::Path) {
    let command = NotesCommand::CreateNode {
        id: NodeId::try_from("MyNotes00001".to_owned()).expect("id"),
        parent_id: NodeId::try_from("root".to_owned()).expect("home"),
        position: Position::at_end(),
        text: "Mine".to_owned(),
    };
    let tree = storage.load_command_tree(&command).expect("load");
    let patch = tree.plan(command).expect("plan");
    storage
        .commit(storage.revision().expect("revision"), &patch)
        .expect("the page");
    // The folder has to hold it before the folder can be read as the truth —
    // and this is also what empties the queue the rebuild would refuse over.
    storage
        .export_pending(vault, &std::env::temp_dir().join("yonalist-empty-store"))
        .expect("written out");
}

/// The two halves meet here, and the answer survives the meeting.
///
/// A rebuild empties `notes_ui_state`, which is where the answer to "where do
/// these notes live" is kept — and it deliberately leaves the recorded folder on
/// disk. Clearing the answer while keeping the folder would have the card ask a
/// question it is holding the answer to. So the wipe keeps that one key and
/// throws the rest of that table (the cached `active_page_id` and its like) away.
///
/// The other half is that no guide is written over the user's notes. The rebuild
/// leaves the database full rather than empty — the folder's own documents are
/// back in it — so `seed_onboarding` finds notes and writes nothing, whichever
/// way the card is answered afterwards.
#[test]
fn a_rebuilt_database_keeps_the_answer_and_writes_no_guide_over_notes() {
    let directory = tempfile::tempdir().expect("home");
    let vault = tempfile::tempdir().expect("the folder these notes live in");
    let storage = SqliteStorage::open(&database(&directory)).expect("open");
    // The user said where their notes live, and then wrote one.
    storage
        .mark_onboarding_answered()
        .expect("the folder is recorded");
    write_a_page(&storage, vault.path());

    let report = storage
        .rebuild_from_vault(vault.path())
        .expect("thrown away and read back");

    assert!(
        report.read >= 2,
        "home and the page came back out of the folder, so the count is {}",
        report.read
    );
    assert!(
        !storage.onboarding_first_run().expect("asked"),
        "the folder is still recorded on disk, so the card would be asking a \
         question it already holds the answer to"
    );
    // Answered either way, the guide stays out: the notes it would be written
    // over are the ones the rebuild just put back.
    storage.seed_onboarding().expect("asked for a guide");
    assert_eq!(
        titles(&storage),
        vec!["Mine".to_owned()],
        "a guide was written on top of the user's own notes"
    );
}

/// Every id the guide plants is a block id the vault can carry, and they are
/// written down rather than generated. Fixed is what makes a second seed a no-op
/// and what lets the guide fixture and a freshly seeded vault hold the same block
/// identities — generate them and the two would never agree again.
#[test]
fn the_guide_plants_ids_the_vault_can_carry() {
    let directory = tempfile::tempdir().expect("home");
    let storage = SqliteStorage::open(&database(&directory)).expect("open");
    storage.seed_onboarding().expect("the guide");
    drop(storage);

    let ids: Vec<String> = rusqlite::Connection::open(database(&directory))
        .expect("open")
        .prepare("SELECT id FROM notes_nodes WHERE id <> 'root' ORDER BY id")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .map(|row| row.expect("row"))
        .collect();

    assert!(!ids.is_empty(), "the guide planted nothing");
    for id in &ids {
        assert!(
            notes_core::is_block_id(id),
            "`{id}` is not an id this format can write into a file"
        );
    }
    let distinct: std::collections::BTreeSet<&String> = ids.iter().collect();
    assert_eq!(distinct.len(), ids.len(), "two guide lines share an id");
}
