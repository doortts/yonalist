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
    /// Everything a write would move: the readings, where each line sits, and
    /// what is still owed. Two of these being equal is what "nothing was
    /// written" means — `total_changes` cannot answer it, because it counts
    /// per connection and the writes happen on the worker's.
    fn state(&self) -> (String, String, i64) {
        rusqlite::Connection::open(self.home.path().join("notes.sqlite"))
            .expect("open")
            .query_row(
                "SELECT coalesce(group_concat(hlc, ''), ''),
                        coalesce(group_concat(sync_prev || sync_prev_hlc, ''), ''),
                        (SELECT count(*) FROM sync_dirty_nodes)
                 FROM (SELECT hlc, sync_prev, sync_prev_hlc FROM notes_nodes ORDER BY id)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("state")
    }

    /// How many lines on this page had their claim rewritten by whatever just
    /// happened — every claim written by one command carries that command's
    /// reading.
    fn relinked(&self, parent: &str) -> i64 {
        rusqlite::Connection::open(self.home.path().join("notes.sqlite"))
            .expect("open")
            .query_row(
                "SELECT count(*) FROM notes_nodes
                 WHERE parent_id = ?1
                   AND sync_prev_hlc = (SELECT max(sync_prev_hlc) FROM notes_nodes
                                        WHERE parent_id = ?1)",
                [parent],
                |row| row.get(0),
            )
            .expect("relinked")
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
                        id: notes_core::new_yid(),
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

/// The stat gate the boot scan leans on compares what the folder says now
/// with what was recorded when this app last dealt with the file. The merge
/// records that; the export never did — so on a vault of this app's own
/// files, every record was empty and the gate would answer "read it" for all
/// of them, every launch, with nothing to notice.
#[test]
fn the_export_records_the_stat_of_what_it_wrote() {
    let workspace = workspace();
    workspace.pages(1);
    workspace.export();

    let (relative, recorded_mtime, recorded_size): (String, Option<i64>, Option<i64>) =
        rusqlite::Connection::open(workspace.home.path().join("notes.sqlite"))
            .expect("open")
            .query_row(
                "SELECT folder_path, file_mtime_ms, file_size FROM sync_documents
                 WHERE root_id <> 'root' AND root_id <> 'yonalist-trash'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("the page's document");
    let on_disk = std::fs::metadata(workspace.vault.join(&relative)).expect("the file");
    assert_eq!(
        recorded_size,
        Some(on_disk.len() as i64),
        "what the export wrote is what it has to write down"
    );
    let modified = on_disk
        .modified()
        .expect("mtime")
        .duration_since(std::time::UNIX_EPOCH)
        .expect("since the epoch")
        .as_millis() as i64;
    assert_eq!(recorded_mtime, Some(modified));
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

/// What the boot scan costs on a folder nobody touched: a stat for each file
/// and not one read. The gate is the whole point — a vault of a thousand
/// notes must not be a thousand file reads on every launch.
#[test]
fn opening_an_untouched_vault_stats_every_file_and_reads_none() {
    let workspace = workspace();
    workspace.pages(DOCUMENTS);
    workspace.export();

    let records: std::collections::BTreeMap<String, notes_sync::intake::Known> = workspace
        .storage
        .vault_stat_records()
        .expect("records")
        .into_iter()
        .collect();
    let mut read_anyway = Vec::new();
    for relative in documents(&workspace.vault) {
        let facts = std::fs::metadata(workspace.vault.join(&relative)).expect("stat");
        let verdict = notes_sync::intake::scan_verdict(
            records.get(&relative),
            facts
                .modified()
                .expect("mtime")
                .duration_since(std::time::UNIX_EPOCH)
                .expect("since the epoch")
                .as_millis() as i64,
            facts.len() as i64,
        );
        if verdict != notes_sync::intake::Verdict::Skip {
            read_anyway.push(relative);
        }
    }

    assert_eq!(
        read_anyway,
        Vec::<String>::new(),
        "every one of these is what this app itself wrote, and the folder \
         still says exactly that"
    );
}

/// And it writes nothing. A sweep that decided correctly but still touched a
/// row would hand every other device a document to merge.
#[test]
fn opening_an_untouched_vault_writes_nothing() {
    let workspace = workspace();
    workspace.pages(DOCUMENTS);
    workspace.export();
    let before = workspace.state();

    workspace.sweep();

    assert_eq!(
        workspace.state(),
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

/// Adding a bullet to a page costs the same whether the page holds ten notes
/// or ten thousand. It did not: every sibling's place claim was rewritten on
/// every insert, and the lookup inside that write scanned the page again for
/// each row — so an append cost the length of the page twice over.
#[test]
fn adding_a_note_costs_the_same_whatever_else_is_on_the_page() {
    let mut relinked = Vec::new();
    for siblings in [40usize, 160] {
        let workspace = workspace();
        let page = {
            let session = "session".to_owned();
            let id = notes_core::new_yid();
            let revision = workspace.storage.revision().expect("revision");
            NotesService::new(&workspace.storage, session.clone(), revision)
                .execute(CommandEnvelope {
                    session_id: session,
                    request_id: "page".to_owned(),
                    base_revision: revision,
                    history_group: None,
                    command: IpcNotesCommand::CreateNode {
                        id: id.clone(),
                        parent_id: "root".to_owned(),
                        before_id: None,
                        text: "Long page".to_owned(),
                    },
                })
                .expect("page");
            id
        };
        for index in 0..siblings {
            add(&workspace, &page, index);
        }
        add(&workspace, &page, siblings);
        relinked.push(workspace.relinked(&page));
    }

    assert!(
        relinked[1] <= relinked[0] * 2,
        "four times the page, four times the writing: {relinked:?}"
    );
}

fn add(workspace: &Workspace, parent: &str, index: usize) {
    let session = "session".to_owned();
    let revision = workspace.storage.revision().expect("revision");
    NotesService::new(&workspace.storage, session.clone(), revision)
        .execute(CommandEnvelope {
            session_id: session,
            request_id: format!("bullet-{index}"),
            base_revision: revision,
            history_group: None,
            command: IpcNotesCommand::CreateNode {
                id: notes_core::new_yid(),
                parent_id: parent.to_owned(),
                before_id: None,
                text: format!("Bullet {index}"),
            },
        })
        .expect("bullet");
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
    let before = workspace.state();
    let again = workspace
        .storage
        .merge_document(&file, &input)
        .expect("merge again");

    assert_eq!(again.applied, 0, "{first:?} then {again:?}");
    assert_eq!(
        workspace.state(),
        before,
        "a replay is not an edit, and writing one makes it look like one"
    );
}
