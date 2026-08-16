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
    /// Answers how many documents actually changed on disk.
    fn export(&self) -> usize {
        self.storage
            .export_pending(&self.vault, &self.store)
            .expect("export")
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
        // The pictures too. The watcher hands the bytes to this app's own
        // store and then says where they are; here the bytes are taken as
        // read, since what is being tested is where two devices put them.
        for (location, disk_name) in attachments(&self.vault) {
            let hash = disk_name
                .rsplit_once('-')
                .and_then(|(_, tail)| tail.split('.').next())
                .unwrap_or_default();
            if hash.len() == 12 {
                assert_eq!(
                    hash,
                    &HASH[..12],
                    "these tests know one picture; a second would need its own \
                     bytes rather than this one's tail"
                );
                let full = HASH.to_owned();
                self.storage
                    .resolve_asset(&disk_name, &full, &location)
                    .expect("resolve");
            }
        }
        // What the merge decided, and anything this device was already
        // holding. The export thread runs behind the watcher exactly so.
        let _ = self.export();
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
        let _ = first.export();
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
    let _ = two.export();
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
    let _ = two.export();

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
    let _ = one.export();
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

/// Two devices that have said everything they have to say stop writing. A
/// pair that keeps rewriting the same file at each other converges on content
/// while churning the folder for ever — and every one of those writes is a
/// document the other device merges again.
#[test]
fn a_settled_pair_stops_writing() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    let bullet = add_bullet(&one, &page, "Something");
    settle(&one, &two);

    // The other device changes its mind and puts it back. Both readings are
    // real edits, so the row ends up saying what it said at a reading this
    // device has never written — and this device has a record of its own for
    // the same words.
    two.run(IpcNotesCommand::UpdateText {
        id: bullet.clone(),
        text: "Something else".to_owned(),
    });
    two.run(IpcNotesCommand::UpdateText {
        id: bullet,
        text: "Something".to_owned(),
    });
    settle(&two, &one);

    assert_eq!(one.export(), 0, "the first device has nothing left to say");
    assert_eq!(two.export(), 0, "nor the second");
    one.absorb();
    two.absorb();
    assert_eq!(
        one.export(),
        0,
        "and reading the folder again changes nothing"
    );
    assert_eq!(two.export(), 0);
    // A document that fails to write answers zero as well, and keeps its
    // marks — the count alone cannot tell quiet from stuck.
    assert_eq!(one.storage.pending_count().expect("pending"), 0);
    assert_eq!(two.storage.pending_count().expect("pending"), 0);
}

/// A page dragged under another page stops being a page: its folder goes and
/// its notes belong to the page it joined. Removing the folder before that
/// page's file states them leaves the subtree in no file at all — and this
/// device would then read the vault back and drop it.
#[test]
fn a_page_dragged_under_another_keeps_its_notes() {
    let (one, two) = seeded_pair();
    let host = one.first_page();
    // A page of its own, with a note under it — one folder, two files, and a
    // link from home.
    let joining = add_bullet(&one, "root", "Joining page");
    let carried = add_bullet(&one, &joining, "Carried along");
    settle(&one, &two);

    one.run(IpcNotesCommand::MoveNode {
        id: joining.clone(),
        parent_id: host.clone(),
        before_id: None,
    });
    // One pass, which is what the export thread does when the debounce fires.
    let _ = one.export();
    // One pass has to finish the job: state the notes in their new home and
    // take the old folder with it. A folder left behind is read again on every
    // sweep, and what it says is the subtree as it was before the move.
    assert_eq!(
        documents(&one.vault).len(),
        2,
        "home and the page it joined, and nothing left of the folder it had: {:?}",
        documents(&one.vault)
    );
    assert_eq!(
        one.storage.pending_count().expect("pending"),
        0,
        "and nothing is still owed"
    );
    assert_eq!(one.export(), 0, "so a second pass writes nothing");

    // The folder is what the other devices read, so the question is whether
    // any file in it still states these notes.
    let stated = documents(&one.vault).into_iter().any(|relative| {
        std::fs::read_to_string(one.vault.join(relative))
            .unwrap_or_default()
            .contains("Carried along")
    });
    assert!(
        stated,
        "the page's folder went before the page it joined said anything about \
         its notes, so they are in no file at all"
    );
    settle(&one, &two);
    assert_eq!(
        two.text_of(&carried).as_deref(),
        Some("Carried along"),
        "and the other device never learned about them either"
    );
}

/// The export is on a timer and the user is in a text editor. Both write the
/// same file, and whichever order they land in, what the user typed has to be
/// there afterwards.
#[test]
fn a_hand_edit_is_not_overwritten_by_an_export_that_was_already_coming() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    let bullet = add_bullet(&one, &page, "Written in the app");
    settle(&one, &two);

    // The user types into the file while this device is holding an edit of its
    // own — which is exactly what a debounce window is.
    let readme = page_file(&two);
    let mut document = std::fs::read_to_string(&readme).expect("document");
    document.push_str("- Typed while the app was about to write\n");
    std::fs::write(&readme, document).expect("hand edit");
    two.run(IpcNotesCommand::UpdateText {
        id: bullet.clone(),
        text: "Changed in the app".to_owned(),
    });

    two.absorb();

    let written = std::fs::read_to_string(&readme).expect("document");
    assert!(
        written.contains("Typed while the app was about to write"),
        "the export wrote over what the user typed: {written}"
    );
    assert!(
        written.contains("Changed in the app"),
        "and the app's own edit went with it: {written}"
    );
}

/// Two devices that each put the same picture in a note have to agree on where
/// it lives, without asking each other.
#[test]
fn a_picture_two_pages_share_ends_up_in_the_vault_store() {
    let (one, two) = seeded_pair();
    let page = one.first_page();
    let second_page = add_bullet(&one, &page, "Another page");
    settle(&one, &two);

    let shot = add_bullet(&one, &page, "holiday.png");
    let copy = add_bullet(&one, &second_page, "holiday.png");
    for node in [&shot, &copy] {
        picture(&one, node);
    }
    settle(&one, &two);

    assert!(
        one.vault.join("assets").exists(),
        "two notes point at it, so it belongs to neither of their folders"
    );
    let placed: Vec<String> = std::fs::read_dir(one.vault.join("assets"))
        .expect("read")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(placed.len(), 1, "{placed:?}");
    assert!(
        two.vault.join("assets").join(&placed[0]).exists(),
        "and the other device has it under the same name"
    );
    let (shared, location): (i64, String) =
        rusqlite::Connection::open(two._home.path().join("notes.sqlite"))
            .expect("open")
            .query_row(
                "SELECT (SELECT count(*) FROM notes_images WHERE content_hash = ?1),
                        (SELECT coalesce(max(location), '') FROM sync_assets
                         WHERE content_hash = ?1)",
                [HASH],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("what the other device knows");
    assert_eq!(
        shared, 2,
        "the other device has to know both notes point at it, or it will \
         decide the picture belongs in a page folder"
    );
    assert_eq!(
        location,
        format!("assets/{}", placed[0]),
        "and it has to agree about where that is"
    );
}

const HASH: &str = "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";

/// Every picture in the folder, as (where it is, what it is called).
fn attachments(vault: &std::path::Path) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut stack = vec![vault.to_path_buf()];
    while let Some(at) = stack.pop() {
        for entry in std::fs::read_dir(&at).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|extension| extension == "png") {
                found.push((
                    path.strip_prefix(vault)
                        .expect("inside")
                        .to_string_lossy()
                        .into_owned(),
                    path.file_name()
                        .expect("name")
                        .to_string_lossy()
                        .into_owned(),
                ));
            }
        }
    }
    found
}

fn page_file(device: &Device) -> std::path::PathBuf {
    std::fs::read_dir(&device.vault)
        .expect("read")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && path.join("README.md").exists())
        .expect("a page folder")
        .join("README.md")
}

/// A picture on this bullet, with its bytes in this device's own store — what
/// an import leaves behind, without going through the image pipeline.
fn picture(device: &Device, node_id: &str) {
    std::fs::write(device.store.join(format!("{HASH}.png")), b"pretend png").expect("bytes");
    let connection =
        rusqlite::Connection::open(device._home.path().join("notes.sqlite")).expect("open");
    // The stamping triggers call it, and it is registered per connection.
    notes_sync::hlc::register(
        &connection,
        std::sync::Arc::new(notes_sync::hlc::Clock::new("cccc").expect("clock")),
    )
    .expect("register");
    connection
        .execute(
            "INSERT INTO notes_images(node_id, content_hash, relative_path, original_name,
                 mime_type, byte_length, pixel_width, pixel_height, display_width)
             VALUES (?1, ?2, ?3, 'holiday.png', 'image/png', 11, 800, 600, 480)
             ON CONFLICT(node_id) DO NOTHING",
            rusqlite::params![node_id, HASH, format!("{HASH}.png")],
        )
        .expect("image");
    // A bullet with an image row beside it is still a bullet: what makes the
    // line a picture is the node's own kind, and without it nothing about the
    // picture is ever written to a file.
    connection
        .execute(
            "UPDATE notes_nodes SET kind = 'image' WHERE id = ?1",
            [node_id],
        )
        .expect("kind");
}
