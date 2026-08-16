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

/// A stamp I issued, under content I did not write, means someone edited this
/// vault's file in another editor. That is authoring, not a merge: the file's
/// text is adopted and given a fresh stamp so it propagates normally.
#[test]
fn a_local_hand_edit_is_restamped_as_authoring() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mine = stamp(5, DEVICE);
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &mine, "As exported")],
            &mine,
        )),
        &input(),
    )
    .expect("seed");

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &mine, "Edited in vim")],
            &mine,
        )),
        &input(),
    )
    .expect("hand edit");

    assert_eq!(
        text_of(&transaction, NODE_ID).as_deref(),
        Some("Edited in vim")
    );
    assert!(
        hlc_of(&transaction, NODE_ID) > mine,
        "an edit needs a stamp that can beat what it replaced"
    );
    assert_eq!(
        conflicts_for(&transaction, NODE_ID),
        0,
        "editing your own file is not a conflict with anyone"
    );
}

/// Someone else's stamp under changed content is a hand edit on *their*
/// machine. Issuing a fresh stamp here would make the answer depend on which
/// device merged first, so the content decides and both sides agree.
#[test]
fn a_remote_same_hlc_conflict_breaks_ties_by_content_hash() {
    let theirs = stamp(5, "a3f2");
    let mut winners = Vec::new();
    for order in [("Alpha", "Omega"), ("Omega", "Alpha")] {
        let mut connection = database();
        let transaction = connection.transaction().expect("begin");
        for text in [order.0, order.1] {
            merge_document(
                &transaction,
                &clock(),
                &notes_sync::document::VaultFile::Page(page(
                    vec![node(NODE_ID, &theirs, text)],
                    &theirs,
                )),
                &input(),
            )
            .expect("merge");
        }
        assert_eq!(
            hlc_of(&transaction, NODE_ID),
            theirs,
            "a tie-break keeps the stamp, or the next device would see a new edit"
        );
        assert_eq!(conflicts_for(&transaction, NODE_ID), 1, "the loser is kept");
        winners.push(text_of(&transaction, NODE_ID).expect("text"));
    }

    assert_eq!(
        winners[0], winners[1],
        "whichever arrived first, both devices land on the same text"
    );
}

/// Moving one sibling must not restamp the ones that did not move. Position is
/// compared as "under this parent, after this sibling" — a raw sort_key would
/// never match, because the parser quantises and the database uses midpoints.
#[test]
fn a_reorder_touches_only_the_moved_sibling() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let second_id = "8a201f33-0000-4c91-8d02-000000000002";
    let third_id = "8a201f33-0000-4c91-8d02-000000000003";
    let ordered = |ids: [&str; 3], hlc: &str| {
        notes_sync::document::VaultFile::Page(page(
            ids.iter()
                .map(|id| node(id, hlc, &format!("Node {}", &id[34..])))
                .collect(),
            hlc,
        ))
    };
    merge_document(
        &transaction,
        &clock(),
        &ordered([NODE_ID, second_id, third_id], &stamp(5, "a3f2")),
        &input(),
    )
    .expect("seed");
    let untouched_first = hlc_of(&transaction, NODE_ID);
    let untouched_second = hlc_of(&transaction, second_id);

    // The third moves to the front, and only its line gets a new stamp.
    let mut moved = page(
        vec![
            node(third_id, &stamp(9, "a3f2"), "Node 03"),
            node(NODE_ID, &stamp(5, "a3f2"), "Node 01"),
            node(second_id, &stamp(5, "a3f2"), "Node 02"),
        ],
        &stamp(9, "a3f2"),
    );
    moved.root.hlc = stamp(5, "a3f2");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(moved),
        &input(),
    )
    .expect("reorder");

    assert_eq!(hlc_of(&transaction, NODE_ID), untouched_first);
    assert_eq!(hlc_of(&transaction, second_id), untouched_second);
    let keys: Vec<i64> = ["03", "01", "02"]
        .iter()
        .map(|suffix| {
            transaction
                .query_row(
                    "SELECT sort_key FROM notes_nodes WHERE text = ?1",
                    [format!("Node {suffix}")],
                    |row| row.get(0),
                )
                .expect("key")
        })
        .collect();
    assert!(
        keys[0] < keys[1] && keys[1] < keys[2],
        "the file's order is the order: {keys:?}"
    );
}

fn second_page() -> PageDocument {
    let mut document = page(Vec::new(), &stamp(5, "a3f2"));
    document.id = DocumentId::Node("11c8da70-b5e1-4c91-8d02-a3f204ee81cc".to_owned());
    document.root.title = "Second".to_owned();
    document
}

fn order_of_pages(connection: &Connection) -> Vec<String> {
    let mut statement = connection
        .prepare(
            "SELECT text FROM notes_nodes WHERE parent_id = 'root' AND deleted = 0
             ORDER BY sort_key, id",
        )
        .expect("prepare");
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query");
    rows.map(|row| row.expect("row")).collect()
}

/// A page README states no position — a page's place is its line in home. The
/// merge must not read that absence as "first child of root", or re-reading a
/// page's own file would drag it back to the front of the list and restamp it,
/// and that stamp would then win everywhere.
#[test]
fn a_page_document_does_not_claim_a_position() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let first = notes_sync::document::VaultFile::Page(page(Vec::new(), &stamp(5, DEVICE)));
    let second = notes_sync::document::VaultFile::Page(second_page());
    merge_document(&transaction, &clock(), &first, &input()).expect("first");
    let mut elsewhere = input();
    elsewhere.file_path = "Second-11c8da70b5e1/README.md".to_owned();
    merge_document(&transaction, &clock(), &second, &elsewhere).expect("second");
    let ordered = order_of_pages(&transaction);
    let stamps: Vec<String> = ordered.iter().map(|_| String::new()).collect::<Vec<_>>();
    let _ = stamps;

    let before = hlc_of(&transaction, PAGE_ID);
    let outcome = merge_document(&transaction, &clock(), &first, &input()).expect("replay");

    assert_eq!(
        order_of_pages(&transaction),
        ordered,
        "re-reading a page's own file must not reorder the pages"
    );
    assert_eq!(
        hlc_of(&transaction, PAGE_ID),
        before,
        "and must not restamp it"
    );
    assert_eq!(outcome.applied, 0, "nothing about the document changed");
}

/// An image line states its file, its size and its bytes. If none of that
/// reaches the row, the comparison can never match on the way back and every
/// replay looks like an edit — and the metadata needed to re-render the line
/// is simply gone.
#[test]
fn an_image_node_keeps_its_metadata_and_settles() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mut picture = node(NODE_ID, &stamp(5, DEVICE), "");
    picture.body = NodeBody::Image(notes_sync::document::ImageReference {
        original_name: "shot.png".to_owned(),
        path: "assets/shot-9f3a1c8e2044.png".to_owned(),
        display_width: 320,
        pixel_width: 1280,
        pixel_height: 720,
        byte_size: 421_904,
        unknown_tokens: Vec::new(),
    });
    let file = notes_sync::document::VaultFile::Page(page(vec![picture], &stamp(5, DEVICE)));
    merge_document(&transaction, &clock(), &file, &input()).expect("first");

    let outcome = merge_document(&transaction, &clock(), &file, &input()).expect("replay");

    assert_eq!(outcome.applied, 0, "the same image file is not a new edit");
    assert_eq!(conflicts_for(&transaction, NODE_ID), 0);
    let (path, width, bytes): (String, i64, i64) = transaction
        .query_row(
            "SELECT relative_path, display_width, byte_length FROM notes_images WHERE node_id = ?1",
            [NODE_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("image row");
    assert_eq!(path, "assets/shot-9f3a1c8e2044.png");
    assert_eq!(width, 320);
    assert_eq!(bytes, 421_904);
}

/// A drifted stamp over an existing row replaces content, not just a clock
/// reading. What it replaced is the thing worth keeping — especially when the
/// row was dirty and this device held the only copy.
#[test]
fn a_drifted_file_logs_the_row_it_overwrote() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(5, "a3f2"), "Mine")],
            &stamp(5, "a3f2"),
        )),
        &input(),
    )
    .expect("seed");
    let far = Hlc::new(FAR_FUTURE_MILLIS, 0, "a3f2")
        .expect("far")
        .encode();

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &far, "Theirs, from a broken clock")],
            &far,
        )),
        &input(),
    )
    .expect("drift");

    let loser: String = transaction
        .query_row(
            "SELECT loser_json FROM sync_conflict_log WHERE node_id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("loser");
    assert!(
        loser.contains("Mine"),
        "the content that was replaced is what needs keeping: {loser}"
    );
}

/// Moving one sibling must leave the others out of the conflict machinery
/// entirely. Comparing them against a snapshot taken before the move makes
/// each one look reordered, and the log fills with defeats nobody suffered.
#[test]
fn a_reorder_logs_nothing_against_the_siblings_that_stayed() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let second_id = "8a201f33-0000-4c91-8d02-000000000002";
    let third_id = "8a201f33-0000-4c91-8d02-000000000003";
    let seeded = stamp(5, "a3f2");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            [NODE_ID, second_id, third_id]
                .iter()
                .map(|id| node(id, &seeded, &format!("Node {}", &id[34..])))
                .collect(),
            &seeded,
        )),
        &input(),
    )
    .expect("seed");

    let mut moved = page(
        vec![
            node(third_id, &stamp(9, "a3f2"), "Node 03"),
            node(NODE_ID, &seeded, "Node 01"),
            node(second_id, &seeded, "Node 02"),
        ],
        &stamp(9, "a3f2"),
    );
    moved.root.hlc = seeded.clone();
    let outcome = merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(moved),
        &input(),
    )
    .expect("reorder");

    assert_eq!(
        outcome.applied, 1,
        "one sibling moved, so one row is written"
    );
    assert_eq!(
        conflicts(&transaction),
        0,
        "and nobody lost anything to anybody"
    );
}

/// Two nodes taking turns in the same slot halve the gap each round, and after
/// thirty-two of them it is gone. A midpoint of a gap of one is the
/// predecessor's own key, and a duplicate key sorts by id — putting the node in
/// front of the sibling it has to follow.
#[test]
fn siblings_taking_turns_in_one_slot_never_run_out_of_room() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let first = "8a201f33-0000-4c91-8d02-000000000001";
    let a = "8a201f33-0000-4c91-8d02-000000000002";
    let b = "8a201f33-0000-4c91-8d02-000000000003";
    let last = "8a201f33-0000-4c91-8d02-000000000004";
    let seeded = stamp(5, "a3f2");
    // Only the node that actually moved carries a new stamp — the others are
    // unchanged, which is what leaves the gap to be eaten.
    let order = |ids: [&str; 4], mover: &str, millis: u64| {
        let mut document = page(
            ids.iter()
                .map(|id| {
                    let mark = if *id == mover {
                        stamp(millis, "a3f2")
                    } else {
                        seeded.clone()
                    };
                    node(id, &mark, &format!("Node {}", &id[34..]))
                })
                .collect(),
            &stamp(millis, "a3f2"),
        );
        document.root.hlc = seeded.clone();
        notes_sync::document::VaultFile::Page(document)
    };
    merge_document(
        &transaction,
        &clock(),
        &order([first, a, b, last], first, 5),
        &input(),
    )
    .expect("seed");

    // A sibling with an edit of its own waiting to be exported. Respacing must
    // not clear that flag — it belongs to the edit, not to the bookkeeping.
    transaction
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, 0)",
            [last],
        )
        .expect("dirty");

    for round in 0..40 {
        let (arrangement, mover) = if round % 2 == 0 {
            ([first, b, a, last], b)
        } else {
            ([first, a, b, last], a)
        };
        merge_document(
            &transaction,
            &clock(),
            &order(arrangement, mover, 10 + round),
            &input(),
        )
        .expect("move");
    }

    let ordered: Vec<String> = {
        let mut statement = transaction
            .prepare(
                "SELECT text FROM notes_nodes WHERE parent_id = ?1 AND deleted = 0
                 ORDER BY sort_key, id",
            )
            .expect("prepare");
        let rows = statement
            .query_map([PAGE_ID], |row| row.get::<_, String>(0))
            .expect("query");
        rows.map(|row| row.expect("row")).collect()
    };
    assert_eq!(
        ordered,
        vec!["Node 01", "Node 02", "Node 03", "Node 04"],
        "the last arrangement is the one that stands"
    );
    let distinct: i64 = transaction
        .query_row(
            "SELECT count(DISTINCT sort_key) FROM notes_nodes WHERE parent_id = ?1",
            [PAGE_ID],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(distinct, 4, "and no two siblings share a key");
    let restamped: i64 = transaction
        .query_row(
            "SELECT count(*) FROM notes_nodes WHERE parent_id = ?1 AND hlc LIKE '%-cccc'",
            [PAGE_ID],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(
        restamped, 0,
        "spacing the keys out again is bookkeeping, not an edit by this device"
    );
    let still_dirty: i64 = transaction
        .query_row(
            "SELECT count(*) FROM sync_dirty_nodes WHERE node_id = ?1",
            [last],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(
        still_dirty, 1,
        "a sibling's own unexported edit survives being moved along"
    );
}
