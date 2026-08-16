//! What sync costs when nothing happened.
//!
//! Counted, not timed: a timing test on a shared machine fails for reasons
//! that have nothing to do with the code, and passes on a regression that a
//! faster machine hides. What these count is writes — the thing that turns
//! "nothing changed" into work for every other device as well as this one.
//!
//! Every bug this port found in review was some version of the same shape: a
//! pass that could not tell "already done" from "to do", and so did it again.

use notes_application::{CommandEnvelope, IpcNotesCommand, NotesService};
use notes_sqlite::SqliteStorage;

const DOCUMENTS: usize = 25;

struct Workspace {
    home: tempfile::TempDir,
    storage: SqliteStorage,
    vault: std::path::PathBuf,
    store: std::path::PathBuf,
}

fn workspace() -> Workspace {
    let home = tempfile::tempdir().expect("home");
    let storage = SqliteStorage::open(&home.path().join("notes.sqlite")).expect("open");
    let vault = home.path().join("vault");
    let store = home.path().join("images");
    std::fs::create_dir_all(&vault).expect("vault");
    std::fs::create_dir_all(&store).expect("store");
    Workspace {
        home,
        storage,
        vault,
        store,
    }
}

impl Workspace {
    /// Rows written since the database was opened. SQLite counts these itself,
    /// so nothing here has to guess what a write is.
    fn rows_written(&self) -> i64 {
        rusqlite::Connection::open(self.home.path().join("notes.sqlite"))
            .expect("open")
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap_or(0)
    }

    fn pages(&self, count: usize) {
        let session = "session".to_owned();
        for index in 0..count {
            let revision = self.storage.revision().expect("revision");
            NotesService::new(&self.storage, session.clone(), revision)
                .execute(CommandEnvelope {
                    session_id: session.clone(),
                    request_id: format!("request-{index}"),
                    base_revision: revision,
                    history_group: None,
                    command: IpcNotesCommand::CreateNode {
                        id: uuid::Uuid::new_v4().hyphenated().to_string(),
                        parent_id: "root".to_owned(),
                        before_id: None,
                        text: format!("Page {index}"),
                    },
                })
                .expect("command");
        }
    }

    fn export(&self) -> usize {
        self.storage
            .export_pending(&self.vault, &self.store)
            .expect("export")
    }

    /// What the watcher does on a sweep, and what a startup scan does: look at
    /// every file and decide. Answers how many were read as news.
    fn sweep(&self) -> usize {
        let mut merged = 0;
        for relative in documents(&self.vault) {
            let recorded = self.storage.vault_file_hash(&relative).ok().flatten();
            if let Ok(notes_sync::watcher::Verdict::Merge(file, input)) =
                notes_sync::watcher::consider(&self.vault, &relative, recorded.as_deref())
            {
                self.storage.merge_document(&file, &input).expect("merge");
                merged += 1;
            }
        }
        merged
    }
}

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
    found
}

/// The one that matters: an app that opens on a folder nobody has touched does
/// no work at all. Every device runs this on every start, so a per-document
/// cost here is a cost every user pays for having notes.
#[test]
fn opening_an_untouched_vault_reads_nothing_as_news() {
    let workspace = workspace();
    workspace.pages(DOCUMENTS);
    workspace.export();

    let merged = workspace.sweep();

    assert_eq!(
        merged, 0,
        "every file in the folder is what this app itself wrote"
    );
}

/// And it writes nothing. A sweep that decided correctly but still touched a
/// row would hand every other device a document to merge.
#[test]
fn opening_an_untouched_vault_writes_nothing() {
    let workspace = workspace();
    workspace.pages(DOCUMENTS);
    workspace.export();
    let before = workspace.rows_written();

    workspace.sweep();

    assert_eq!(
        workspace.rows_written(),
        before,
        "reading a folder that has not changed is not an edit"
    );
}

/// The export queue drains. A pass that leaves work behind runs the same work
/// again on the next poke, for ever — which is what blocks the reindex and
/// what rewrites files nothing changed.
#[test]
fn a_second_export_with_nothing_waiting_writes_no_files() {
    let workspace = workspace();
    workspace.pages(DOCUMENTS);
    workspace.export();

    let written = workspace.export();

    assert_eq!(written, 0, "everything was already written out");
    assert_eq!(
        workspace.storage.pending_count().expect("pending"),
        0,
        "and nothing is still owed"
    );
}

/// One edit is one document rewritten, whatever else is in the folder. The
/// cost of an edit must not grow with how many notes the user has.
#[test]
fn one_edit_rewrites_one_document() {
    let workspace = workspace();
    workspace.pages(DOCUMENTS);
    workspace.export();
    let page: String = rusqlite::Connection::open(workspace.home.path().join("notes.sqlite"))
        .expect("open")
        .query_row(
            "SELECT id FROM notes_nodes WHERE parent_id = 'root' ORDER BY sort_key LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("a page");
    let revision = workspace.storage.revision().expect("revision");
    NotesService::new(&workspace.storage, "session".to_owned(), revision)
        .execute(CommandEnvelope {
            session_id: "session".to_owned(),
            request_id: "edit".to_owned(),
            base_revision: revision,
            history_group: None,
            command: IpcNotesCommand::UpdateText {
                id: page,
                text: "Renamed".to_owned(),
            },
        })
        .expect("command");

    let written = workspace.export();

    assert_eq!(
        written, 2,
        "the page that changed, and home — which states its title"
    );
}

/// A document arriving again unchanged — the same bytes a second device keeps
/// handing over — is read and dropped. Applying it would restamp rows and
/// send it back, and the two devices would trade the same file for ever.
#[test]
fn the_same_document_arriving_twice_is_applied_once() {
    let workspace = workspace();
    workspace.pages(3);
    workspace.export();
    let relative = documents(&workspace.vault)
        .into_iter()
        .find(|path| path != "README.md")
        .expect("a page");
    let bytes = std::fs::read(workspace.vault.join(&relative)).expect("read");
    let file = notes_sync::parse::parse(&bytes).expect("parse");
    let input = notes_sync::merger::MergeInput {
        file_path: relative,
        file_hash: notes_sync::export::hash_bytes(&bytes),
        file_mtime_ms: None,
        file_size: None,
    };

    let first = workspace
        .storage
        .merge_document(&file, &input)
        .expect("merge");
    let before = workspace.rows_written();
    let again = workspace
        .storage
        .merge_document(&file, &input)
        .expect("merge again");

    assert_eq!(again.applied, 0, "{first:?} then {again:?}");
    assert_eq!(
        workspace.rows_written() - before,
        0,
        "a replay is not an edit, and writing one makes it look like one"
    );
}
