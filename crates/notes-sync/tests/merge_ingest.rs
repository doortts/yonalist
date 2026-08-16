//! M3.1a: what a vault file does to the rows when it lands. Three comparisons
//! decide every node — the file is newer, the file is older, or the stamps
//! match — and a node the file never mentions is not evidence of anything.

use notes_sync::document::{
    DocumentId, DocumentNode, DocumentRoot, Marker, NodeBody, PageDocument,
};
use notes_sync::hlc::{Clock, Hlc};
use notes_sync::merger::{MergeInput, merge_document};
use rusqlite::Connection;

const DEVICE: &str = "cccc";
const PAGE_ID: &str = "4f1c8e20-a3b7-4c91-8d02-11c8da70b5e1";
const NODE_ID: &str = "8a201f33-0000-4c91-8d02-000000000001";
/// Inside the encoding, far outside the day the drift guard allows: about the
/// year 4821 by the wall clock.
const FAR_FUTURE_MILLIS: u64 = 90_000_000_000_000;

/// A real database, from the same DDL the app ships. A copy would drift.
fn database() -> Connection {
    let connection = Connection::open_in_memory().expect("open");
    connection
        .execute_batch(include_str!("../../notes-sqlite/src/schema.sql"))
        .expect("schema");
    connection
        .execute(
            "INSERT INTO sync_meta(singleton, device_id, vault_uuid) VALUES (1, ?1, ?2)",
            (DEVICE, "3f2a1c8e-0000-4c91-8d02-000000000000"),
        )
        .expect("sync meta");
    // The stamping triggers call it, so every connection that writes a node
    // has to have it — the worker does the same thing at boot.
    notes_sync::hlc::register(&connection, std::sync::Arc::new(clock())).expect("register");
    connection
        .execute(
            // Stamped, or the insert trigger would mark it dirty and every
            // test asserting on dirtiness would be reading the fixture.
            "INSERT INTO notes_nodes(id, parent_id, sort_key, kind, text, hlc)
             VALUES ('root', NULL, 0, 'page', 'Home', ?1)",
            [Hlc::new(1, 0, "a3f2").expect("hlc").encode()],
        )
        .expect("root");
    connection
}

fn clock() -> Clock {
    Clock::new(DEVICE).expect("clock")
}

fn stamp(millis: u64, device: &str) -> String {
    Hlc::new(millis, 0, device).expect("hlc").encode()
}

fn node(id: &str, hlc: &str, text: &str) -> DocumentNode {
    DocumentNode {
        id: id.to_owned(),
        hlc: hlc.to_owned(),
        body: NodeBody::Text(text.to_owned()),
        note: String::new(),
        marker: Marker::Bullet,
        collapsed: false,
        completed: false,
        starred: false,
        from: None,
        unknown_tokens: Vec::new(),
        children: Vec::new(),
    }
}

fn page(nodes: Vec<DocumentNode>, max_hlc: &str) -> PageDocument {
    PageDocument {
        id: DocumentId::Node(PAGE_ID.to_owned()),
        parent: None,
        sort_key: None,
        max_hlc: max_hlc.to_owned(),
        root: DocumentRoot {
            title: "Projects".to_owned(),
            hlc: max_hlc.to_owned(),
            ..DocumentRoot::default()
        },
        nodes,
        unknown_frontmatter: Vec::new(),
    }
}

fn input() -> MergeInput {
    MergeInput {
        file_path: "Projects-4f1c8e20a3b7/README.md".to_owned(),
        file_hash: "a".repeat(64),
        file_mtime_ms: Some(1_700_000_000_000),
        file_size: Some(256),
    }
}

fn text_of(connection: &Connection, id: &str) -> Option<String> {
    connection
        .query_row("SELECT text FROM notes_nodes WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .ok()
}

fn hlc_of(connection: &Connection, id: &str) -> String {
    connection
        .query_row("SELECT hlc FROM notes_nodes WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .expect("hlc")
}

fn conflicts_for(connection: &Connection, id: &str) -> i64 {
    connection
        .query_row(
            "SELECT count(*) FROM sync_conflict_log WHERE node_id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("count")
}

fn conflicts(connection: &Connection) -> i64 {
    connection
        .query_row("SELECT count(*) FROM sync_conflict_log", [], |row| {
            row.get(0)
        })
        .expect("count")
}

#[test]
fn a_canonical_document_merges_into_an_empty_database() {
    let mut connection = database();
    let file = notes_sync::document::VaultFile::Page(page(
        vec![node(NODE_ID, &stamp(5, "a3f2"), "Thought")],
        &stamp(5, "a3f2"),
    ));
    let transaction = connection.transaction().expect("begin");

    let outcome = merge_document(&transaction, &clock(), &file, &input()).expect("merge");

    assert!(outcome.applied > 0);
    assert_eq!(text_of(&transaction, NODE_ID).as_deref(), Some("Thought"));
    assert_eq!(hlc_of(&transaction, NODE_ID), stamp(5, "a3f2"));
    assert_eq!(
        text_of(&transaction, PAGE_ID).as_deref(),
        Some("Projects"),
        "the document root is a node too"
    );
}

#[test]
fn a_node_missing_from_the_file_is_never_deleted() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(5, "a3f2"), "Thought")],
            &stamp(5, "a3f2"),
        )),
        &input(),
    )
    .expect("first");

    let outcome = merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(Vec::new(), &stamp(6, "a3f2"))),
        &input(),
    )
    .expect("second");

    assert_eq!(
        text_of(&transaction, NODE_ID).as_deref(),
        Some("Thought"),
        "absence is not evidence — only trash.md deletes"
    );
    assert!(
        outcome.needs_write_back,
        "the file is missing a node this document should hold, so it gets rewritten"
    );
}

#[test]
fn a_newer_file_wins_and_an_older_one_loses() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(5, "a3f2"), "First")],
            &stamp(5, "a3f2"),
        )),
        &input(),
    )
    .expect("seed");

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(9, "a3f2"), "Second")],
            &stamp(9, "a3f2"),
        )),
        &input(),
    )
    .expect("newer");
    assert_eq!(text_of(&transaction, NODE_ID).as_deref(), Some("Second"));

    let outcome = merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(7, "a3f2"), "Stale")],
            &stamp(7, "a3f2"),
        )),
        &input(),
    )
    .expect("older");

    assert_eq!(
        text_of(&transaction, NODE_ID).as_deref(),
        Some("Second"),
        "an older stamp does not move the row"
    );
    assert!(
        outcome.needs_write_back,
        "the file is behind, so it is rewritten to say who won"
    );
    assert_eq!(
        conflicts_for(&transaction, NODE_ID),
        1,
        "and the loser is kept"
    );
}

#[test]
fn a_loser_is_recorded_once_in_the_conflict_log() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let winner = notes_sync::document::VaultFile::Page(page(
        vec![node(NODE_ID, &stamp(9, "a3f2"), "Winner")],
        &stamp(9, "a3f2"),
    ));
    let loser = notes_sync::document::VaultFile::Page(page(
        vec![node(NODE_ID, &stamp(7, "a3f2"), "Loser")],
        &stamp(7, "a3f2"),
    ));
    merge_document(&transaction, &clock(), &winner, &input()).expect("seed");

    merge_document(&transaction, &clock(), &loser, &input()).expect("first");
    merge_document(&transaction, &clock(), &loser, &input()).expect("replay");
    assert_eq!(
        conflicts_for(&transaction, NODE_ID),
        1,
        "the same defeat is one row"
    );

    // The local row moves on, and the same stale file arrives again. v1 keyed
    // the guard on the winner too, so every local advance re-logged the same
    // loser.
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(11, "a3f2"), "Later")],
            &stamp(11, "a3f2"),
        )),
        &input(),
    )
    .expect("advance");
    merge_document(&transaction, &clock(), &loser, &input()).expect("third");

    assert_eq!(conflicts_for(&transaction, NODE_ID), 1);
}

#[test]
fn an_unstamped_bullet_gets_a_fresh_uuid_and_stamp() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");

    let outcome = merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node("", "", "Typed by hand")],
            &stamp(5, "a3f2"),
        )),
        &input(),
    )
    .expect("merge");

    let issued: String = transaction
        .query_row(
            "SELECT id FROM notes_nodes WHERE text = 'Typed by hand'",
            [],
            |row| row.get(0),
        )
        .expect("issued");
    assert_eq!(issued.len(), 36, "a hand-written line still gets a real id");
    assert!(!hlc_of(&transaction, &issued).is_empty());
    assert!(
        outcome.needs_write_back,
        "the file has to learn the id that was issued"
    );
}

/// A stamp the merge decided on must survive the triggers that stamp every
/// other write. Otherwise adopting a remote value would silently replace its
/// clock reading with a local one and the file would disagree with the row.
#[test]
fn a_merged_stamp_survives_the_stamping_triggers() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(5, "a3f2"), "Thought")],
            &stamp(5, "a3f2"),
        )),
        &input(),
    )
    .expect("merge");

    assert_eq!(hlc_of(&transaction, NODE_ID), stamp(5, "a3f2"));
    let dirty: i64 = transaction
        .query_row("SELECT count(*) FROM sync_dirty_nodes", [], |row| {
            row.get(0)
        })
        .expect("dirty");
    assert_eq!(dirty, 0, "adopting a remote value is not a local edit");
}

#[test]
fn unknown_extras_are_upserted_with_the_node() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mut carrier = node(NODE_ID, &stamp(5, "a3f2"), "Thought");
    carrier.unknown_tokens = vec!["future:".to_owned(), "value".to_owned()];

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(vec![carrier], &stamp(5, "a3f2"))),
        &input(),
    )
    .expect("merge");

    let extras: String = transaction
        .query_row(
            "SELECT sync_extras FROM notes_nodes WHERE id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("extras");
    assert!(
        extras.contains("future:") && extras.contains("value"),
        "a token this version cannot read still belongs to whoever wrote it: {extras}"
    );
}

#[test]
fn a_future_hlc_beyond_drift_is_restamped_and_logged() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let far = Hlc::new(FAR_FUTURE_MILLIS, 0, "a3f2")
        .expect("far")
        .encode();

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &far, "From a broken clock")],
            &far,
        )),
        &input(),
    )
    .expect("merge");

    assert_ne!(
        hlc_of(&transaction, NODE_ID),
        far,
        "a stamp from a broken clock is replaced, not adopted"
    );
    assert_eq!(conflicts_for(&transaction, NODE_ID), 1);
}

/// Absorbing a drifted stamp would hand every later local edit that future
/// time, and a runaway value near the encoding ceiling would wedge the clock
/// so hard that even the delete removing it could not be issued.
#[test]
fn a_drifted_hlc_is_not_observed() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let far = Hlc::new(FAR_FUTURE_MILLIS, 0, "a3f2")
        .expect("far")
        .encode();
    let clock = clock();

    merge_document(
        &transaction,
        &clock,
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &far, "From a broken clock")],
            &far,
        )),
        &input(),
    )
    .expect("merge");

    let next = clock.now().expect("now");
    assert!(
        !clock.is_beyond_drift(&next),
        "the local clock stayed in the present: {}",
        next.encode()
    );
}

#[test]
fn a_drift_replay_before_write_back_is_quiet() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let far = Hlc::new(FAR_FUTURE_MILLIS, 0, "a3f2")
        .expect("far")
        .encode();
    let file = notes_sync::document::VaultFile::Page(page(
        vec![node(NODE_ID, &far, "From a broken clock")],
        &far,
    ));
    merge_document(&transaction, &clock(), &file, &input()).expect("first");
    let after_first = hlc_of(&transaction, NODE_ID);

    merge_document(&transaction, &clock(), &file, &input()).expect("replay");

    assert_eq!(
        hlc_of(&transaction, NODE_ID),
        after_first,
        "the same file arriving again is not a new edit"
    );
    assert_eq!(conflicts_for(&transaction, NODE_ID), 1);
}

#[test]
fn a_dirty_local_loser_is_logged_before_it_is_overwritten() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(5, "a3f2"), "Mine, not yet exported")],
            &stamp(5, "a3f2"),
        )),
        &input(),
    )
    .expect("seed");
    transaction
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, 0)",
            [NODE_ID],
        )
        .expect("dirty");

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(9, "a3f2"), "Theirs")],
            &stamp(9, "a3f2"),
        )),
        &input(),
    )
    .expect("remote");

    assert_eq!(text_of(&transaction, NODE_ID).as_deref(), Some("Theirs"));
    assert_eq!(
        conflicts_for(&transaction, NODE_ID),
        1,
        "an edit that never left this device has no other copy anywhere"
    );
}

#[test]
fn merging_the_same_document_twice_changes_nothing() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let file = notes_sync::document::VaultFile::Page(page(
        vec![node(NODE_ID, &stamp(5, "a3f2"), "Thought")],
        &stamp(5, "a3f2"),
    ));
    merge_document(&transaction, &clock(), &file, &input()).expect("first");

    let outcome = merge_document(&transaction, &clock(), &file, &input()).expect("replay");

    assert_eq!(outcome.applied, 0, "a replay is not a write");
    assert_eq!(conflicts(&transaction), 0);
}
