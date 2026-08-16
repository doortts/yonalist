//! Two devices, one folder.
//!
//! Every other test in this repository checks a rule. These check the thing the
//! rules are for: that two databases handed the same folder end up holding the
//! same notes, whichever order the files reach them in.
//!
//! The transport is a copy — the folder is written by one device and copied to
//! the other, which is what iCloud and Syncthing do once the delays are taken
//! out. What that cannot show is the parts that only exist in a real client:
//! placeholders, half-written files, and the copies they leave behind when they
//! cannot decide. Those have tests of their own, and the manual proof covers
//! them together.

use notes_application::{CommandEnvelope, IpcNotesCommand, NotesService};
use notes_sqlite::SqliteStorage;

/// One device: its own database, its own image store, its own copy of the
/// folder. Nothing is shared but the bytes that get copied across.
struct Device {
    _home: tempfile::TempDir,
    storage: SqliteStorage,
    vault: std::path::PathBuf,
    store: std::path::PathBuf,
    session: String,
}

impl Device {
    fn new(name: &str) -> Self {
        let home = tempfile::tempdir().expect("home");
        let storage = SqliteStorage::open(&home.path().join("notes.sqlite")).expect("open");
        let vault = home.path().join("vault");
        let store = home.path().join("images");
        std::fs::create_dir_all(&vault).expect("vault");
        std::fs::create_dir_all(&store).expect("store");
        Self {
            _home: home,
            storage,
            vault,
            store,
            session: format!("session-{name}"),
        }
    }

    fn service(&self) -> NotesService<&SqliteStorage> {
        let revision = self.storage.revision().expect("revision");
        NotesService::new(&self.storage, self.session.clone(), revision)
    }

    fn run(&self, command: IpcNotesCommand) {
        let revision = self.storage.revision().expect("revision");
        self.service()
            .execute(CommandEnvelope {
                session_id: self.session.clone(),
                request_id: format!("request-{revision}"),
                base_revision: revision,
                history_group: None,
                command,
            })
            .expect("command");
    }

    /// Everything this device is holding, written into its folder.
    fn export(&self) {
        self.storage
            .export_pending(&self.vault, &self.store)
            .expect("export");
    }

    /// Everything the folder is holding that this device has not seen, read
    /// the way the watcher reads it: one file at a time, skipping its own
    /// writing, and merging the rest. Not a reindex — a reindex adopts the
    /// folder as the truth, which is a recovery tool rather than the way
    /// notes arrive.
    fn absorb(&self) {
        for relative in documents(&self.vault) {
            let recorded = self.storage.vault_file_hash(&relative).ok().flatten();
            match notes_sync::watcher::consider(&self.vault, &relative, recorded.as_deref()) {
                Ok(notes_sync::watcher::Verdict::Merge(file, input)) => {
                    let outcome = self.storage.merge_document(&file, &input).expect("merge");
                    if outcome.retire_file {
                        std::fs::remove_file(self.vault.join(&relative)).expect("retire");
                    }
                }
                Ok(_) => {}
                Err(reason) => panic!("{relative}: {reason}"),
            }
        }
        // What the merge decided, and anything this device was already
        // holding. The export thread runs behind the watcher exactly so.
        self.export();
    }

    /// What the outline actually says, in order, deleted rows left out. Two
    /// devices agreeing on this is what convergence means.
    fn outline(&self) -> Vec<(String, String)> {
        let connection = rusqlite::Connection::open_with_flags(
            self._home.path().join("notes.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("read");
        let mut statement = connection
            .prepare(
                "SELECT id, text FROM notes_nodes
                 WHERE deleted = 0 AND id <> 'root' AND hlc <> ''
                 ORDER BY path, id",
            )
            .expect("prepare");
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query");
        rows.map(|row| row.expect("row")).collect()
    }

    fn text_of(&self, id: &str) -> Option<String> {
        let connection = rusqlite::Connection::open_with_flags(
            self._home.path().join("notes.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("read");
        connection
            .query_row("SELECT text FROM notes_nodes WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .ok()
    }

    fn first_page(&self) -> String {
        let connection = rusqlite::Connection::open_with_flags(
            self._home.path().join("notes.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("read");
        connection
            .query_row(
                "SELECT id FROM notes_nodes WHERE parent_id = 'root' AND deleted = 0
                 ORDER BY sort_key LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("a page")
    }
}

/// The transport: what one device wrote, appearing in the other's folder. Only
/// files are copied, never a database — the two devices never see each other's
/// state, only each other's documents.
fn carry(from: &Device, to: &Device) {
    copy_tree(&from.vault, &to.vault);
}

/// Every document in a folder, deepest last — the order does not matter to a
/// merge, which is part of the contract being tested.
fn documents(vault: &std::path::Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![vault.to_path_buf()];
    while let Some(at) = stack.pop() {
        for entry in std::fs::read_dir(&at).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|extension| extension == "md") {
                found.push(
                    path.strip_prefix(vault)
                        .expect("inside")
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    found.sort();
    found
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).expect("folder");
    for entry in std::fs::read_dir(from).expect("read").flatten() {
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_tree(&source, &target);
        } else {
            std::fs::copy(&source, &target).expect("copy");
        }
    }
}

/// One device writes, the other reads, and the answer travels back. Two rounds,
/// because a merge can leave the receiving device with something to say.
fn settle(first: &Device, second: &Device) {
    for _ in 0..2 {
        first.export();
        carry(first, second);
        second.absorb();
        carry(second, first);
        first.absorb();
    }
}

fn seeded_pair() -> (Device, Device) {
    let one = Device::new("one");
    let two = Device::new("two");
    settle(&one, &two);
    (one, two)
}

fn add_bullet(device: &Device, parent: &str, text: &str) -> String {
    let id = uuid::Uuid::new_v4().hyphenated().to_string();
    device.run(IpcNotesCommand::CreateNode {
        id: id.clone(),
        parent_id: parent.to_owned(),
        before_id: None,
        text: text.to_owned(),
    });
    id
}

#[test]
fn an_edit_on_one_device_reaches_the_other() {
    let (one, two) = seeded_pair();
    let page = one.first_page();

    let bullet = add_bullet(&one, &page, "Written on the first device");
    settle(&one, &two);

    assert_eq!(
        two.text_of(&bullet).as_deref(),
        Some("Written on the first device"),
        "the whole point of the folder"
    );
    assert_eq!(one.outline(), two.outline(), "and nothing else differs");
}

/// Two people editing different notes is the ordinary case, and it must not
/// produce a conflict — nothing disagrees.
#[test]
fn edits_to_different_notes_merge_without_anyone_losing() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    let first = add_bullet(&one, &page, "First");
    settle(&one, &two);

    one.run(IpcNotesCommand::UpdateText {
        id: first.clone(),
        text: "First, edited here".to_owned(),
    });
    let second = add_bullet(&two, &page, "Second, added there");
    settle(&one, &two);

    assert_eq!(one.outline(), two.outline());
    assert_eq!(one.text_of(&first).as_deref(), Some("First, edited here"));
    assert_eq!(two.text_of(&second).as_deref(), Some("Second, added there"));
}

/// The same note edited on both. One version has to win, and the other has to
/// be somewhere the user can get it back from — that is the whole contract.
#[test]
fn the_same_note_edited_twice_converges_and_keeps_the_loser() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    let bullet = add_bullet(&one, &page, "Original");
    settle(&one, &two);

    one.run(IpcNotesCommand::UpdateText {
        id: bullet.clone(),
        text: "Said on the first device".to_owned(),
    });
    two.run(IpcNotesCommand::UpdateText {
        id: bullet.clone(),
        text: "Said on the second device".to_owned(),
    });
    settle(&one, &two);

    assert_eq!(one.outline(), two.outline(), "they agree on one of them");
    assert_eq!(
        one.text_of(&bullet),
        two.text_of(&bullet),
        "and it is the same one"
    );
    // On whichever device read the losing file — the loser is recorded where
    // the disagreement was seen, not on both.
    let one_kept = one.storage.sync_conflicts(10).expect("conflicts");
    let two_kept = two.storage.sync_conflicts(10).expect("conflicts");
    assert!(
        one_kept
            .iter()
            .chain(two_kept.iter())
            .any(|row| row.node_id == bullet),
        "the other version is where the user can put it back from: \
         {one_kept:?} {two_kept:?}"
    );
}

/// Deleting on one device has to reach the other, and the note has to stay
/// gone: `trash.md` is the only evidence a deletion gets.
#[test]
fn a_deletion_travels_and_stays() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    let bullet = add_bullet(&one, &page, "Not for long");
    settle(&one, &two);

    one.run(IpcNotesCommand::DeleteSubtree { id: bullet.clone() });
    settle(&one, &two);

    assert!(
        !two.outline().iter().any(|(id, _)| id == &bullet),
        "the second device still has a note the first one deleted"
    );
    assert_eq!(one.outline(), two.outline());
}

/// A file somebody's editor mangled must not take the notes with it. The
/// device that reads it keeps what it had, and the next write puts a document
/// back that everyone can read.
#[test]
fn a_file_nobody_can_read_costs_nothing() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    let bullet = add_bullet(&one, &page, "Still here afterwards");
    settle(&one, &two);
    let before = two.outline();

    // Half a document, which is what an interrupted write leaves.
    let folder = std::fs::read_dir(&two.vault)
        .expect("read")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && path.join("README.md").exists())
        .expect("a page folder");
    std::fs::write(folder.join("README.md"), b"---\nkind: yonalist-notes\n").expect("truncate");
    two.absorb();

    assert_eq!(
        two.outline(),
        before,
        "reading a file that makes no sense must not empty the notes it describes"
    );
    two.export();
    settle(&two, &one);
    assert_eq!(
        one.text_of(&bullet).as_deref(),
        Some("Still here afterwards")
    );
}

/// Hand editing is the point of a folder full of markdown. A bullet somebody
/// typed in by hand has no id — the merge gives it one and writes it back, so
/// the same line is not read as a new note every time.
#[test]
fn a_bullet_typed_in_by_hand_is_adopted_and_written_back() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    add_bullet(&one, &page, "Typed in the app");
    settle(&one, &two);

    let readme = std::fs::read_dir(&two.vault)
        .expect("read")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && path.join("README.md").exists())
        .expect("a page folder")
        .join("README.md");
    let mut document = std::fs::read_to_string(&readme).expect("document");
    document.push_str("- Typed in by hand\n");
    std::fs::write(&readme, document).expect("hand edit");
    two.absorb();
    two.export();

    let written = std::fs::read_to_string(&readme).expect("document");
    assert!(
        written.contains("Typed in by hand"),
        "the line the user typed is still there: {written}"
    );
    assert!(
        written
            .lines()
            .find(|line| line.contains("Typed in by hand"))
            .is_some_and(|line| line.contains("yid:")),
        "and it now carries an id, or it is a new note on every read: {written}"
    );
    settle(&two, &one);
    assert_eq!(one.outline(), two.outline());
}

/// The copy a sync client writes when it cannot decide. Its contents are
/// somebody's notes, so they are merged rather than ignored.
#[test]
fn a_conflicted_copy_is_taken_in() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    add_bullet(&one, &page, "The original line");
    settle(&one, &two);

    let folder = std::fs::read_dir(&two.vault)
        .expect("read")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && path.join("README.md").exists())
        .expect("a page folder");
    let mut document = std::fs::read_to_string(folder.join("README.md")).expect("document");
    // A line only the copy has. Replacing an existing line would be a
    // same-stamp disagreement, which is a different rule; this is the one
    // being tested — the copy is read at all.
    document.push_str("- What the other device had\n");
    let copy = folder.join("README (conflicted copy 2026-08-16).md");
    std::fs::write(&copy, document).expect("the copy");
    two.absorb();

    assert!(
        two.outline()
            .iter()
            .any(|(_, text)| text == "What the other device had"),
        "a copy the transport wrote is still somebody's notes: {:?}",
        two.outline()
    );
    assert!(
        !copy.exists(),
        "and once it has been read it is tidied away, or every device keeps \
         merging it for ever"
    );
    let canonical = std::fs::read_to_string(folder.join("README.md")).expect("the page");
    assert!(
        canonical.contains("What the other device had"),
        "the page itself is what states the notes, not the copy: {canonical}"
    );
    settle(&two, &one);
    assert_eq!(one.outline(), two.outline());
    assert!(
        !copy.exists(),
        "the copy came back, which means the document's own file is now the \
         copy's name and the real page is going stale"
    );
}

/// Two devices moving each other's node underneath their own close a ring —
/// a state no file can express. Both have to pick the same node to take out,
/// or they never agree again.
#[test]
fn a_move_cycle_parks_the_same_node_on_both_devices() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    let first = add_bullet(&one, &page, "First");
    let second = add_bullet(&one, &page, "Second");
    settle(&one, &two);

    one.run(IpcNotesCommand::MoveNode {
        id: first.clone(),
        parent_id: second.clone(),
        before_id: None,
    });
    two.run(IpcNotesCommand::MoveNode {
        id: second.clone(),
        parent_id: first.clone(),
        before_id: None,
    });
    settle(&one, &two);

    assert_eq!(
        one.outline(),
        two.outline(),
        "a ring both devices resolved differently is two vaults that never agree"
    );
}

/// What iCloud does quietly: one device's file lands on top of another's. The
/// device whose work was overwritten still holds it, so its next write puts
/// both back.
#[test]
fn an_overwritten_file_comes_back_through_the_merge() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    let shared = add_bullet(&one, &page, "Shared");
    settle(&one, &two);

    let mine = add_bullet(&two, &page, "Only the second device has this");
    // The first device's copy of the page lands on top before the second has
    // written anything of its own.
    one.run(IpcNotesCommand::UpdateText {
        id: shared.clone(),
        text: "Changed on the first device".to_owned(),
    });
    one.export();
    carry(&one, &two);
    two.absorb();
    settle(&two, &one);

    assert_eq!(
        two.text_of(&mine).as_deref(),
        Some("Only the second device has this"),
        "the overwrite took a note that was never written out"
    );
    assert_eq!(one.outline(), two.outline());
}
