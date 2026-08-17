//! When the guide notes appear, and when they must not.
//!
//! The guide used to be written the moment a database was opened, which is
//! before the app knows whether this device is joining a folder that already
//! holds notes. Writing it then hands this device a fresh reading for every
//! line the guide occupies, and a fresh reading beats whatever the other
//! device said — including a deletion it made in between. So the guide waits
//! until somebody has decided what folder these notes live in.

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
