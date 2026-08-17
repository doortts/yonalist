use std::path::Path;

use notes_application::ViewportRequest;
use notes_sqlite::SqliteStorage;
use rusqlite::{Connection, params};

/// The recursive walk `viewport` was ordered by, kept here as the oracle the
/// stored-path window has to reproduce row for row, trashed branches and all.
const WALK: &str = "WITH RECURSIVE outline(id, path) AS (
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
        WHERE id = ?1 AND deleted = 0
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
     SELECT node.id
     FROM outline
     JOIN notes_node_records node ON node.id = outline.id
     WHERE node.id <> ?1
     ORDER BY outline.path
     LIMIT ?2 OFFSET ?3";

/// `(id, parent_id, sort_key, deleted)`. Raw rows rather than commands: the
/// live-row-under-a-trashed-parent shape is one no command can produce, and the
/// window has to be right on it anyway.
const ROWS: &[(&str, &str, i64, i64)] = &[
    ("page-main", "root", 1024, 0),
    ("head", "page-main", -1024, 0),
    ("n00", "page-main", 1024, 0),
    ("n01", "page-main", 2048, 0),
    ("n01a", "n01", 1024, 0),
    ("n01a1", "n01a", 1024, 0),
    ("n01b", "n01", 2048, 0),
    ("n02", "page-main", 3072, 0),
    ("gone", "page-main", 4096, 1),
    ("gone-1", "gone", 1024, 1),
    ("gone-1-1", "gone-1", 1024, 1),
    ("n03", "page-main", 5120, 0),
    ("shadow", "page-main", 6144, 1),
    ("shadow-live", "shadow", 1024, 0),
    ("n04", "page-main", 7168, 0),
    ("n05", "page-main", 8192, 0),
    ("n06", "page-main", 9216, 0),
    ("n07", "page-main", 10240, 0),
    ("n08", "page-main", 11264, 0),
    ("n09", "page-main", 12288, 0),
    ("n10", "page-main", 13312, 0),
    ("n11", "page-main", 14336, 0),
    ("n12", "page-main", 15360, 0),
    // Siblings sharing page-main's sort key whose ids extend its own, so their
    // paths are page-main's path plus a byte on either side of the separator.
    // They are the rows a range bounded any wider than [path/, path0) swallows.
    ("page-main.below", "root", 1024, 0),
    ("page-main0above", "root", 1024, 0),
    ("page-single", "root", 2048, 0),
    ("only-child", "page-single", 1024, 0),
    ("page-empty", "root", 3072, 0),
];

const LIVE_MAIN: [&str; 17] = [
    "head", "n00", "n01", "n01a", "n01a1", "n01b", "n02", "n03", "n04", "n05", "n06", "n07", "n08",
    "n09", "n10", "n11", "n12",
];

/// Writes the rows straight in with no path, then reopens so the schema's own
/// repair fills the column — the value under test is the one production computes.
fn build(database: &Path) {
    SqliteStorage::open(database).expect("create the schema and the root row");
    let connection = Connection::open(database).expect("fixture connection");
    // The stamping triggers call `yona_hlc()`, registered per connection.
    let clock = std::sync::Arc::new(notes_sync::hlc::Clock::new("c0de").expect("clock"));
    notes_sync::hlc::register(&connection, clock).expect("register");
    for (id, parent_id, sort_key, deleted) in ROWS {
        connection
            .execute(
                "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, deleted)
                 VALUES (?1, ?2, ?3, 'bullet', ?1, ?4)",
                params![id, parent_id, sort_key, deleted],
            )
            .expect("fixture row");
    }
    drop(connection);
    SqliteStorage::open(database).expect("fill the paths the raw inserts left null");
}

fn revision(database: &Path) -> u64 {
    Connection::open(database)
        .expect("inspect")
        .query_row("SELECT revision FROM notes_meta", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("revision") as u64
}

fn walk(database: &Path, page_id: &str, offset: usize, limit: usize) -> Vec<String> {
    let connection = Connection::open(database).expect("inspect");
    let mut statement = connection.prepare(WALK).expect("walk");
    statement
        .query_map(params![page_id, limit as i64, offset as i64], |row| {
            row.get(0)
        })
        .expect("walk rows")
        .collect::<Result<Vec<String>, _>>()
        .expect("walk rows")
}

fn window(
    storage: &SqliteStorage,
    revision: u64,
    page_id: &str,
    offset: usize,
    limit: u32,
) -> Vec<String> {
    storage
        .query_viewport(ViewportRequest {
            page_id: page_id.into(),
            anchor_id: None,
            before_cursor: None,
            after_cursor: Some(format!("r:{revision}:o:{offset}")),
            limit,
        })
        .expect("window")
        .nodes
        .into_iter()
        .map(|node| node.id)
        .collect()
}

#[test]
fn every_window_matches_the_walk_it_replaces() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("notes-v2.sqlite");
    build(&database);
    let revision = revision(&database);
    let storage = SqliteStorage::open(&database).expect("open storage");

    // A trashed subtree, a live row under a trashed parent and a deep branch
    // all sit inside this page, so its windows carry every pruning case.
    for offset in [0, 4, 8, 12, 16, 20] {
        assert_eq!(
            window(&storage, revision, "page-main", offset, 4),
            walk(&database, "page-main", offset, 4),
            "page-main at offset {offset}"
        );
    }
    assert_eq!(
        window(&storage, revision, "page-main", 0, 200),
        LIVE_MAIN,
        "the fixture stopped covering what it was built for"
    );
    for (page_id, expected) in [
        ("page-single", vec!["only-child"]),
        ("page-empty", Vec::new()),
    ] {
        assert_eq!(
            window(&storage, revision, page_id, 0, 4),
            walk(&database, page_id, 0, 4),
            "{page_id}"
        );
        assert_eq!(window(&storage, revision, page_id, 0, 4), expected);
    }
    // The walk stopped at a trashed parent, so it never saw the live row below
    // one; the range has to prune it the same way.
    assert!(!LIVE_MAIN.contains(&"shadow-live"));
    assert_eq!(
        Connection::open(&database)
            .expect("inspect")
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE deleted = 0 AND path IS NULL",
                [],
                |row| row.get::<_, i64>(0)
            )
            .expect("count"),
        1,
        "the live-under-trashed row is the only NULL path a live row carries"
    );
}

#[test]
fn an_anchor_lands_on_the_offset_the_windows_put_it_at() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = directory.path().join("notes-v2.sqlite");
    build(&database);
    let revision = revision(&database);
    let storage = SqliteStorage::open(&database).expect("open storage");

    // Paged through four at a time rather than read off the fixture, so the
    // expected offset is the one the windows actually hand out.
    let mut ordered = Vec::new();
    let mut offset = 0;
    loop {
        let page = window(&storage, revision, "page-main", offset, 4);
        if page.is_empty() {
            break;
        }
        offset += page.len();
        ordered.extend(page);
    }
    assert_eq!(ordered, LIVE_MAIN);

    // First, last, the bottom of the deep branch, and the rows a trashed branch
    // sits between.
    for anchor in ["head", "n12", "n01a1", "n02", "n03", "n04"] {
        let at = ordered
            .iter()
            .position(|id| id == anchor)
            .expect("anchor is in the page");
        // A one-row window centres on the anchor exactly, so its cursors report
        // the offset the anchor resolved to.
        let page = storage
            .query_viewport(ViewportRequest {
                page_id: "page-main".into(),
                anchor_id: Some(anchor.into()),
                before_cursor: None,
                after_cursor: None,
                limit: 1,
            })
            .expect("anchored window");
        assert_eq!(
            page.nodes.iter().map(|node| &node.id).collect::<Vec<_>>(),
            vec![anchor],
            "anchored on {anchor}"
        );
        assert_eq!(
            page.before_cursor,
            (at > 0).then(|| format!("r:{revision}:o:{at}")),
            "anchored on {anchor}"
        );
        assert_eq!(
            page.after_cursor,
            (at + 1 < ordered.len()).then(|| format!("r:{revision}:o:{}", at + 1)),
            "anchored on {anchor}"
        );
    }
}
