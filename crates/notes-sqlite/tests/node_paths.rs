use std::path::{Path, PathBuf};

use notes_application::{
    CommandEnvelope, HistoryRequest, IpcNodeDuplicate, IpcNodeMove, IpcNotesCommand, NotesService,
};
use notes_sqlite::SqliteStorage;

/// Byte-identical to the CTE a viewport window is ordered by, anchored at the
/// root the whole outline hangs from. It is the oracle for the stored column:
/// the two have to agree on every row, including the trashed branches the CTE
/// prunes and the column leaves NULL.
const DRIFT: &str = "WITH RECURSIVE outline(id, path) AS (
        SELECT id,
               CASE WHEN sort_key < 0
                   THEN printf(
                       '0%019lld:%s',
                       9223372036854775807 + sort_key + 1,
                       id
                   )
                   ELSE printf('1%019lld:%s', sort_key, id)
               END
        FROM notes_nodes
        WHERE id = 'root' AND deleted = 0
        UNION ALL
        SELECT child.id,
               outline.path || '/' ||
                   CASE WHEN child.sort_key < 0
                       THEN printf(
                           '0%019lld:%s',
                           9223372036854775807 + child.sort_key + 1,
                           child.id
                       )
                       ELSE printf('1%019lld:%s', child.sort_key, child.id)
                   END
        FROM notes_nodes child
        JOIN outline ON child.parent_id = outline.id
        WHERE child.deleted = 0
     )
     SELECT node.id, node.path, outline.path
     FROM notes_nodes node
     LEFT JOIN outline ON outline.id = node.id
     WHERE node.path IS NOT outline.path
     ORDER BY node.id";

fn assert_no_drift(database: &Path, label: &str) {
    let connection = rusqlite::Connection::open(database).expect("inspect database");
    let mut statement = connection.prepare(DRIFT).expect("drift query");
    let drifted = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .expect("drift rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("drift rows");
    assert!(
        drifted.is_empty(),
        "after {label}, stored path vs CTE: {drifted:#?}"
    );
    // Guards the vacuous pass where both sides are empty because the walk found
    // no root at all.
    assert!(
        scalar(
            database,
            "SELECT COUNT(*) FROM notes_nodes WHERE path IS NOT NULL"
        ) > 0
    );
}

fn scalar(database: &Path, sql: &str) -> i64 {
    rusqlite::Connection::open(database)
        .expect("inspect database")
        .query_row(sql, [], |row| row.get(0))
        .expect("scalar")
}

fn sort_key(database: &Path, id: &str) -> i64 {
    rusqlite::Connection::open(database)
        .expect("inspect database")
        .query_row(
            "SELECT sort_key FROM notes_nodes WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("sort key")
}

/// The onboarding row the seed writes before any command runs, and so the only
/// root child present at this point.
fn seeded_page(database: &Path) -> String {
    rusqlite::Connection::open(database)
        .expect("inspect database")
        .query_row(
            "SELECT id FROM notes_nodes WHERE parent_id = 'root'",
            [],
            |row| row.get(0),
        )
        .expect("seeded onboarding page")
}

fn create(id: &str, parent_id: &str, before_id: Option<&str>) -> IpcNotesCommand {
    IpcNotesCommand::CreateNode {
        id: id.into(),
        parent_id: parent_id.into(),
        before_id: before_id.map(str::to_owned),
        text: format!("{id} text"),
    }
}

fn move_to(id: &str, parent_id: &str, before_id: Option<&str>) -> IpcNotesCommand {
    IpcNotesCommand::MoveNode {
        id: id.into(),
        parent_id: parent_id.into(),
        before_id: before_id.map(str::to_owned),
    }
}

struct Outline {
    database: PathBuf,
    ordinal: usize,
    revision: u64,
}

impl Outline {
    fn run(&mut self, service: &NotesService<&SqliteStorage>, command: IpcNotesCommand) {
        self.grouped(service, None, command);
    }

    fn grouped(
        &mut self,
        service: &NotesService<&SqliteStorage>,
        history_group: Option<&str>,
        command: IpcNotesCommand,
    ) {
        self.ordinal += 1;
        let label = format!("command {}: {command:?}", self.ordinal);
        let receipt = service
            .execute(CommandEnvelope {
                session_id: "session".into(),
                request_id: format!("request-{}", self.ordinal),
                base_revision: self.revision,
                history_group: history_group.map(str::to_owned),
                command,
            })
            .unwrap_or_else(|error| panic!("{label} was rejected: {error:?}"));
        self.revision = receipt.revision;
        assert_no_drift(&self.database, &label);
    }

    /// Undo replays a coalesced group as one patch, which is the only way a
    /// single commit both drops a row and writes it back.
    fn rewind(&mut self, service: &NotesService<&SqliteStorage>, redo: bool) {
        self.ordinal += 1;
        let request = HistoryRequest {
            session_id: "session".into(),
            base_revision: self.revision,
        };
        let receipt = if redo {
            service.redo(request)
        } else {
            service.undo(request)
        }
        .unwrap_or_else(|error| panic!("history step {} was rejected: {error:?}", self.ordinal));
        self.revision = receipt.revision;
        assert_no_drift(&self.database, &format!("history step {}", self.ordinal));
    }
}

/// The stored column is only worth switching a reader onto if no command can
/// leave it disagreeing with the CTE, so every command in this sequence is
/// followed by a full-table comparison against it.
#[test]
fn every_command_leaves_the_stored_path_equal_to_the_cte() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("notes-v2.sqlite");
    let storage = SqliteStorage::open(&database).expect("open storage");
    // As a device that has been through first run with a folder of its own.
    // The guide is written once that folder is settled rather than when the
    // database is opened, so a test that wants it has to say so.
    storage.seed_onboarding().expect("the guide");
    // The seeded onboarding page is the one row that arrived without a command,
    // so it is read back rather than named: its id belongs to the seed, not to
    // this test.
    let seeded_page_id = seeded_page(&database);
    let service = NotesService::new(&storage, "session", 0);
    let mut outline = Outline {
        database: database.clone(),
        ordinal: 0,
        revision: 0,
    };
    assert_no_drift(&database, "open");

    for command in [
        create("page", "root", None),
        create("alpha", "page", None),
        create("beta", "page", None),
        create("gamma", "page", None),
        create("alpha-1", "alpha", None),
        create("alpha-2", "alpha", None),
        create("alpha-1-1", "alpha-1", None),
        // Prepending twice walks the head sort key down through zero.
        create("zero", "page", Some("alpha")),
        create("under", "page", Some("zero")),
    ] {
        outline.run(&service, command);
    }
    assert_eq!(
        scalar(
            &database,
            "SELECT COUNT(*) FROM notes_nodes WHERE sort_key < 0"
        ),
        1,
        "the negative sort key branch of the path printf is never exercised"
    );
    assert_eq!(
        scalar(
            &database,
            "SELECT COUNT(*) FROM notes_nodes WHERE path LIKE '%/0%'"
        ),
        1
    );

    for command in [
        // A move only changes the moved row, so these are the cases where the
        // descendants' paths go stale without the patch naming them.
        move_to("alpha", "beta", None),
        move_to("alpha-1", "page", Some("under")),
        IpcNotesCommand::Indent {
            id: "gamma".into(),
            new_parent_id: "beta".into(),
        },
        IpcNotesCommand::Outdent {
            id: "gamma".into(),
            new_parent_id: "page".into(),
            before_id: None,
        },
        IpcNotesCommand::Duplicate {
            id: "alpha".into(),
            new_id: "alpha-copy".into(),
            parent_id: "beta".into(),
            before_id: None,
        },
        IpcNotesCommand::DeleteSubtree { id: "beta".into() },
    ] {
        outline.run(&service, command);
    }
    let trashed = scalar(
        &database,
        "SELECT COUNT(*) FROM notes_nodes WHERE deleted = 1",
    );
    assert!(
        trashed > 1,
        "the trashed subtree never reached the database"
    );
    assert_eq!(
        scalar(
            &database,
            "SELECT COUNT(*) FROM notes_nodes WHERE path IS NULL"
        ),
        trashed,
        "a trashed row still carries a path, so the CTE's pruning is not mirrored"
    );

    for command in [
        IpcNotesCommand::RestoreSubtree { id: "beta".into() },
        IpcNotesCommand::MoveNodes {
            moves: vec![
                IpcNodeMove {
                    id: "zero".into(),
                    parent_id: "beta".into(),
                    before_id: None,
                },
                IpcNodeMove {
                    id: "under".into(),
                    parent_id: "beta".into(),
                    before_id: Some("zero".into()),
                },
            ],
        },
        IpcNotesCommand::DuplicateNodes {
            duplicates: vec![
                IpcNodeDuplicate {
                    id: "zero".into(),
                    new_id: "zero-copy".into(),
                    parent_id: "page".into(),
                    before_id: None,
                },
                IpcNodeDuplicate {
                    id: "alpha-1".into(),
                    new_id: "alpha-1-copy".into(),
                    parent_id: "page".into(),
                    before_id: None,
                },
            ],
        },
    ] {
        outline.run(&service, command);
    }

    // Squeezing before the same sibling exhausts the sparse gap and forces the
    // domain to re-key every one of that parent's children, which rewrites the
    // path of each of them and of everything hanging below them.
    for command in [
        create("squeeze-parent", "page", None),
        create("squeeze-left", "squeeze-parent", None),
        create("squeeze-right", "squeeze-parent", None),
        create("squeeze-deep", "squeeze-right", None),
    ] {
        outline.run(&service, command);
    }
    let before_squeeze = sort_key(&database, "squeeze-right");
    let mut squeezes = 0;
    while sort_key(&database, "squeeze-right") == before_squeeze {
        assert!(
            squeezes < 64,
            "the sibling re-key never happened, so the whole-parent rewrite is untested"
        );
        outline.run(
            &service,
            create(
                &format!("squeeze-{squeezes}"),
                "squeeze-parent",
                Some("squeeze-right"),
            ),
        );
        squeezes += 1;
    }

    for command in [
        create("head", "page", Some("alpha-1-copy")),
        create("head-again", "page", Some("head")),
        // Empty text and note: the gesture promotes the children and drops the row.
        IpcNotesCommand::CreateNode {
            id: "hollow".into(),
            parent_id: "page".into(),
            before_id: None,
            text: String::new(),
        },
        create("hollow-child", "hollow", None),
        create("hollow-grandchild", "hollow-child", None),
        IpcNotesCommand::RemoveEmptyNode {
            id: "hollow".into(),
        },
        IpcNotesCommand::SplitNode {
            id: "squeeze-deep".into(),
            new_id: "squeeze-deep-tail".into(),
            parent_id: "squeeze-right".into(),
            before_id: None,
            prefix: "squeeze".into(),
            suffix: "-deep".into(),
        },
        IpcNotesCommand::MergeNodeBackward {
            id: "squeeze-deep-tail".into(),
            previous_id: "squeeze-deep".into(),
            previous_text: "squeeze".into(),
            current_text: "-deep".into(),
        },
        IpcNotesCommand::UpdateText {
            id: "beta".into(),
            text: "renamed".into(),
        },
        IpcNotesCommand::SetCompleted {
            id: "alpha".into(),
            completed: true,
        },
        IpcNotesCommand::SetCollapsed {
            id: "beta".into(),
            collapsed: true,
        },
        IpcNotesCommand::SetStarred {
            id: "beta".into(),
            starred: true,
        },
        IpcNotesCommand::DeleteSubtrees {
            ids: vec!["beta".into(), "alpha-1".into()],
        },
        IpcNotesCommand::RestoreSubtree {
            id: "alpha-1".into(),
        },
        IpcNotesCommand::RestoreSubtree { id: "beta".into() },
        IpcNotesCommand::DeleteSubtree {
            id: seeded_page_id.clone(),
        },
        IpcNotesCommand::RestoreSubtree {
            id: seeded_page_id.clone(),
        },
    ] {
        outline.run(&service, command);
    }

    // One history group that drops a row and writes the same id back at the very
    // same slot. Replaying it is the single patch where a row is inserted afresh
    // while every field its path is built from stayed put.
    outline.run(
        &service,
        IpcNotesCommand::CreateNode {
            id: "recycled".into(),
            parent_id: "page".into(),
            before_id: None,
            text: String::new(),
        },
    );
    outline.grouped(
        &service,
        Some("recycle"),
        IpcNotesCommand::RemoveEmptyNode {
            id: "recycled".into(),
        },
    );
    outline.grouped(
        &service,
        Some("recycle"),
        IpcNotesCommand::CreateNode {
            id: "recycled".into(),
            parent_id: "page".into(),
            before_id: None,
            text: "back".into(),
        },
    );
    outline.rewind(&service, false);
    outline.rewind(&service, true);
    for _ in 0..6 {
        outline.rewind(&service, false);
    }
    for _ in 0..6 {
        outline.rewind(&service, true);
    }

    assert!(scalar(&database, "SELECT COUNT(*) FROM notes_nodes") > 40);
}
