//! M3.1a: what a vault file does to the rows when it lands. Three comparisons
//! decide every node — the file is newer, the file is older, or the stamps
//! match — and a node the file never mentions is not evidence of anything.

use notes_sync::document::{
    DocumentId, DocumentNode, DocumentRoot, Marker, NodeBody, PageDocument,
};
use notes_sync::hlc::{Clock, Hlc};
use notes_sync::merger::{MergeInput, merge_document};
use rusqlite::{Connection, OptionalExtension};

const DEVICE: &str = "cccc";
const PAGE_ID: &str = "PrJects00001";
const NODE_ID: &str = "Nd0000000001";
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
        place: None,
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
        // Built in memory, so there is no file that could have been cut short.
        stated_max_hlc: max_hlc.to_owned(),
        root: DocumentRoot {
            title: "Projects".to_owned(),
            hlc: max_hlc.to_owned(),
            ..DocumentRoot::default()
        },
        nodes,
        unknown_frontmatter: Vec::new(),
        writer: None,
    }
}

fn input() -> MergeInput {
    MergeInput {
        file_path: "Projects-PrJects00001/README.md".to_owned(),
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

/// What the newest recorded conflict for a node says the two versions were:
/// what won, then what lost.
fn sides(connection: &Connection, id: &str) -> (String, String) {
    connection
        .query_row(
            "SELECT json_extract(winner_json, '$.text'), json_extract(loser_json, '$.text')
             FROM sync_conflict_log WHERE node_id = ?1 ORDER BY seq DESC LIMIT 1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("both sides")
}

fn device_names(connection: &Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare("SELECT device_id, name FROM sync_devices ORDER BY device_id")
        .expect("prepare");
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query");
    rows.map(|row| row.expect("row")).collect()
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

    let outcome = merge_document(&transaction, &clock(), &file, &input(), None).expect("merge");

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
        None,
    )
    .expect("first");

    let outcome = merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(Vec::new(), &stamp(6, "a3f2"))),
        &input(),
        None,
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
        None,
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
        None,
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
        None,
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

/// A copy a sync client leaves behind is re-read every sweep, and each read
/// used to log this device's own file against a newer snapshot of itself — two
/// sides with identical text, once a minute. A file that is only behind on its
/// stamp has lost nothing worth showing anybody; it owes a rewrite, and that is
/// the whole of it.
#[test]
fn an_older_file_saying_the_same_thing_is_not_a_conflict() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(9, "a3f2"), "Same")],
            &stamp(9, "a3f2"),
        )),
        &input(),
        None,
    )
    .expect("seed");

    let outcome = merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(7, "a3f2"), "Same")],
            &stamp(7, "a3f2"),
        )),
        &input(),
        None,
    )
    .expect("older");

    assert_eq!(
        outcome.conflicts_recorded, 0,
        "nothing was lost, so there is nothing to show the user"
    );
    assert_eq!(conflicts(&transaction), 0);
    assert!(
        outcome.needs_write_back,
        "the file is still behind on its stamp, and the rewrite is what fixes that"
    );
}

#[test]
fn an_older_file_saying_something_else_still_records_the_loss() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(9, "a3f2"), "First")],
            &stamp(9, "a3f2"),
        )),
        &input(),
        None,
    )
    .expect("seed");

    let outcome = merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(7, "a3f2"), "Stale")],
            &stamp(7, "a3f2"),
        )),
        &input(),
        None,
    )
    .expect("older");

    assert_eq!(
        outcome.conflicts_recorded, 1,
        "the text the file held exists nowhere else once it is rewritten"
    );
    assert_eq!(conflicts_for(&transaction, NODE_ID), 1);
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
    merge_document(&transaction, &clock(), &winner, &input(), None).expect("seed");

    merge_document(&transaction, &clock(), &loser, &input(), None).expect("first");
    merge_document(&transaction, &clock(), &loser, &input(), None).expect("replay");
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
        None,
    )
    .expect("advance");
    merge_document(&transaction, &clock(), &loser, &input(), None).expect("third");

    assert_eq!(conflicts_for(&transaction, NODE_ID), 1);
}

/// The id the merge issues has to be one the vault can carry back out. It used
/// to be a UUID, so the shape was stated as its 36 characters; a `yid` is checked
/// against its own alphabet instead, which is the check the renderer and the
/// folder name both make before they will write it.
#[test]
fn an_unstamped_bullet_gets_a_fresh_yid_and_stamp() {
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
        None,
    )
    .expect("merge");

    let issued: String = transaction
        .query_row(
            "SELECT id FROM notes_nodes WHERE text = 'Typed by hand'",
            [],
            |row| row.get(0),
        )
        .expect("issued");
    assert!(
        notes_core::is_yid(&issued),
        "a hand-written line still gets a real id, got {issued}"
    );
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
        None,
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
        None,
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
        None,
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
        None,
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
    merge_document(&transaction, &clock(), &file, &input(), None).expect("first");
    let after_first = hlc_of(&transaction, NODE_ID);

    merge_document(&transaction, &clock(), &file, &input(), None).expect("replay");

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
        None,
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
        None,
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
    merge_document(&transaction, &clock(), &file, &input(), None).expect("first");

    let outcome = merge_document(&transaction, &clock(), &file, &input(), None).expect("replay");

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
        None,
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
        None,
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
                None,
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
    let second_id = "Nd0000000002";
    let third_id = "Nd0000000003";
    let ordered = |ids: [&str; 3], hlc: &str| {
        notes_sync::document::VaultFile::Page(page(
            ids.iter()
                .map(|id| node(id, hlc, &format!("Node {}", &id[10..])))
                .collect(),
            hlc,
        ))
    };
    merge_document(
        &transaction,
        &clock(),
        &ordered([NODE_ID, second_id, third_id], &stamp(5, "a3f2")),
        &input(),
        None,
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
        None,
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
    document.id = DocumentId::Node("Mnutes000001".to_owned());
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
    merge_document(&transaction, &clock(), &first, &input(), None).expect("first");
    let mut elsewhere = input();
    elsewhere.file_path = "Second-Mnutes000001/README.md".to_owned();
    merge_document(&transaction, &clock(), &second, &elsewhere, None).expect("second");
    let ordered = order_of_pages(&transaction);
    let stamps: Vec<String> = ordered.iter().map(|_| String::new()).collect::<Vec<_>>();
    let _ = stamps;

    let before = hlc_of(&transaction, PAGE_ID);
    let outcome = merge_document(&transaction, &clock(), &first, &input(), None).expect("replay");

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

/// A line that is a picture: the file states its name, its size on screen and
/// its real dimensions.
fn picture(id: &str, hlc: &str) -> DocumentNode {
    let mut picture = node(id, hlc, "");
    picture.body = NodeBody::Image(notes_sync::document::ImageReference {
        original_name: "shot.png".to_owned(),
        path: "assets/shot-9f3a1c8e2044.png".to_owned(),
        display_width: 320,
        pixel_width: 1280,
        pixel_height: 720,
        byte_size: 421_904,
    });
    picture
}

/// An image line states its file, its size and its bytes. If none of that
/// reaches the row, the comparison can never match on the way back and every
/// replay looks like an edit — and the metadata needed to re-render the line
/// is simply gone.
#[test]
fn an_image_node_keeps_its_metadata_and_settles() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let file = notes_sync::document::VaultFile::Page(page(
        vec![picture(NODE_ID, &stamp(5, DEVICE))],
        &stamp(5, DEVICE),
    ));
    merge_document(&transaction, &clock(), &file, &input(), None).expect("first");

    let outcome = merge_document(&transaction, &clock(), &file, &input(), None).expect("replay");

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

/// A file can say a line stopped being a picture. The kind follows the file,
/// and the picture row has to follow the kind: left behind, it makes a bullet
/// that owns image metadata, which every command on that node refuses.
#[test]
fn a_line_that_stops_being_a_picture_takes_its_image_row_with_it() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let picture_file = notes_sync::document::VaultFile::Page(page(
        vec![picture(NODE_ID, &stamp(5, DEVICE))],
        &stamp(5, DEVICE),
    ));
    merge_document(&transaction, &clock(), &picture_file, &input(), None).expect("the picture");

    let text_file = notes_sync::document::VaultFile::Page(page(
        vec![node(NODE_ID, &stamp(9, DEVICE), "just words")],
        &stamp(9, DEVICE),
    ));
    merge_document(&transaction, &clock(), &text_file, &input(), None).expect("the hand edit");

    let kind: String = transaction
        .query_row(
            "SELECT kind FROM notes_nodes WHERE id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("the node");
    assert_eq!(kind, "bullet", "the file's word about the line");
    let rows: i64 = transaction
        .query_row(
            "SELECT count(*) FROM notes_images WHERE node_id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(rows, 0, "and the picture row went with it");
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
        None,
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
        None,
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
    let second_id = "Nd0000000002";
    let third_id = "Nd0000000003";
    let seeded = stamp(5, "a3f2");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            [NODE_ID, second_id, third_id]
                .iter()
                .map(|id| node(id, &seeded, &format!("Node {}", &id[10..])))
                .collect(),
            &seeded,
        )),
        &input(),
        None,
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
        None,
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
    let first = "Nd0000000001";
    let a = "Nd0000000002";
    let b = "Nd0000000003";
    let last = "Nd0000000004";
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
                    node(id, &mark, &format!("Node {}", &id[10..]))
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
        None,
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
            None,
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
    assert_eq!(ordered.len(), 4);
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

fn trash(nodes: Vec<DocumentNode>, max_hlc: &str) -> notes_sync::document::VaultFile {
    notes_sync::document::VaultFile::Trash(notes_sync::document::TrashDocument {
        max_hlc: max_hlc.to_owned(),
        nodes,
    })
}

fn trash_input() -> MergeInput {
    let mut input = input();
    input.file_path = ".yonalist/trash.md".to_owned();
    input
}

fn deleted_flag(connection: &Connection, id: &str) -> i64 {
    connection
        .query_row(
            "SELECT deleted FROM notes_nodes WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("deleted")
}

/// A page document that stops mentioning a node says nothing about it. Only
/// trash.md carries a deletion, because only trash.md is evidence one happened.
#[test]
fn deletion_needs_trash_evidence() {
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
        None,
    )
    .expect("seed");
    assert_eq!(deleted_flag(&transaction, NODE_ID), 0);

    let mut gone = node(NODE_ID, &stamp(9, "a3f2"), "Thought");
    gone.from = Some((PAGE_ID.to_owned(), 4_294_967_296));
    merge_document(
        &transaction,
        &clock(),
        &trash(vec![gone], &stamp(9, "a3f2")),
        &trash_input(),
        None,
    )
    .expect("trash");

    assert_eq!(deleted_flag(&transaction, NODE_ID), 1);
}

/// A deletion is one of a node's states, so it competes on its stamp like any
/// other. The stale side loses and is kept.
#[test]
fn a_deletion_and_an_edit_compete_by_hlc() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mut gone = node(NODE_ID, &stamp(5, "a3f2"), "Thought");
    gone.from = Some((PAGE_ID.to_owned(), 4_294_967_296));
    merge_document(
        &transaction,
        &clock(),
        &trash(vec![gone], &stamp(5, "a3f2")),
        &trash_input(),
        None,
    )
    .expect("trash");

    // A newer edit from elsewhere brings the node back.
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(9, "a3f2"), "Still wanted")],
            &stamp(9, "a3f2"),
        )),
        &input(),
        None,
    )
    .expect("edit");

    assert_eq!(
        deleted_flag(&transaction, NODE_ID),
        0,
        "a newer edit outranks an older deletion"
    );
    assert_eq!(
        text_of(&transaction, NODE_ID).as_deref(),
        Some("Still wanted")
    );
    assert_eq!(
        conflicts_for(&transaction, NODE_ID),
        1,
        "the deletion is kept"
    );
}

/// The row remembers where it was, so restoring is just clearing the flag.
/// Nothing else has to be stored for the trash to be undoable.
#[test]
fn restoring_from_trash_puts_the_node_back_where_it_was() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mut gone = node(NODE_ID, &stamp(5, "a3f2"), "Thought");
    gone.from = Some((PAGE_ID.to_owned(), 8_589_934_592));
    merge_document(
        &transaction,
        &clock(),
        &trash(vec![gone], &stamp(5, "a3f2")),
        &trash_input(),
        None,
    )
    .expect("trash");

    let (parent, key): (String, i64) = transaction
        .query_row(
            "SELECT parent_id, sort_key FROM notes_nodes WHERE id = ?1",
            [NODE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("row");

    assert_eq!(parent, PAGE_ID, "the node still belongs where it was");
    assert_eq!(key, 8_589_934_592, "at the place it was deleted from");
}

/// A trash child's parent came with it, so its place is its line. Only the
/// roots of the trash state where they were taken from.
#[test]
fn a_trash_child_takes_its_place_from_its_line() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let child_id = "Nd0000000007";
    let mut parent = node(NODE_ID, &stamp(5, "a3f2"), "Deleted");
    parent.from = Some((PAGE_ID.to_owned(), 4_294_967_296));
    parent.children = vec![node(child_id, &stamp(5, "a3f2"), "Child")];

    merge_document(
        &transaction,
        &clock(),
        &trash(vec![parent], &stamp(5, "a3f2")),
        &trash_input(),
        None,
    )
    .expect("trash");

    assert_eq!(deleted_flag(&transaction, child_id), 1);
    let parent_of_child: String = transaction
        .query_row(
            "SELECT parent_id FROM notes_nodes WHERE id = ?1",
            [child_id],
            |row| row.get(0),
        )
        .expect("parent");
    assert_eq!(parent_of_child, NODE_ID);
}

/// Trash can arrive before the document holding the node it was taken from. A
/// placeholder keeps the place open with an empty stamp, so the real document
/// wins everything the moment it lands.
#[test]
fn a_trash_root_whose_parent_is_unknown_gets_a_placeholder() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let unknown_parent = "Archive00001";
    let mut gone = node(NODE_ID, &stamp(5, "a3f2"), "Thought");
    gone.from = Some((unknown_parent.to_owned(), 4_294_967_296));

    merge_document(
        &transaction,
        &clock(),
        &trash(vec![gone], &stamp(5, "a3f2")),
        &trash_input(),
        None,
    )
    .expect("trash");

    assert_eq!(
        hlc_of(&transaction, unknown_parent),
        "",
        "an empty stamp loses to the real document the moment it arrives"
    );
    assert_eq!(deleted_flag(&transaction, unknown_parent), 1);
}

/// Merging the same trash file twice is not two deletions.
#[test]
fn merging_the_same_trash_twice_changes_nothing() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mut gone = node(NODE_ID, &stamp(5, "a3f2"), "Thought");
    gone.from = Some((PAGE_ID.to_owned(), 4_294_967_296));
    let file = trash(vec![gone], &stamp(5, "a3f2"));
    merge_document(&transaction, &clock(), &file, &trash_input(), None).expect("first");

    let outcome =
        merge_document(&transaction, &clock(), &file, &trash_input(), None).expect("replay");

    assert_eq!(outcome.applied, 0);
    assert_eq!(conflicts(&transaction), 0);
}

/// A stale page file can state a new order for a row another device has since
/// thrown away. The claim is recorded either way — restoring is clearing the
/// flag, and the place it comes back to is this one — but the window is told
/// what the database holds the row as: a note in the trash has no line to
/// redraw, and named as changed it reads as a note that came back. The sibling
/// still on the page is named, which is what makes this about the row's state
/// and not about place adoptions in general.
#[test]
fn a_place_claim_on_a_row_the_trash_holds_is_not_named_as_changed() {
    let live = "Nd0000000002";
    let base = stamp(5, "a3f2");
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &base, "Thought"), node(live, &base, "Other")],
            &base,
        )),
        &input(),
        None,
    )
    .expect("seed");
    let mut gone = node(NODE_ID, &stamp(20, "a3f2"), "Thought");
    gone.from = Some((PAGE_ID.to_owned(), 4_294_967_296));
    merge_document(
        &transaction,
        &clock(),
        &trash(vec![gone], &stamp(20, "a3f2")),
        &trash_input(),
        None,
    )
    .expect("trash");

    // The page file swaps the two lines and stamps the claim, while both node
    // stamps stay where they were: the deletion still wins the content, and
    // both rows adopt a place without anything being written.
    let claimed = stamp(9, "a3f2");
    let claim = |id: &str, prev: &str, text: &str| {
        let mut carrier = node(id, &base, text);
        carrier.place = Some((prev.to_owned(), claimed.clone()));
        carrier
    };
    let mut reordered = page(
        vec![claim(live, "", "Other"), claim(NODE_ID, live, "Thought")],
        &claimed,
    );
    reordered.root.hlc = base.clone();

    let outcome = merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(reordered),
        &input(),
        None,
    )
    .expect("reorder");

    assert_eq!(
        outcome.changed_ids,
        std::collections::BTreeSet::from([live.to_owned()]),
        "the row still on the page is redrawn; the one in the trash is not there to redraw"
    );
    assert_eq!(
        outcome.deleted_ids,
        std::collections::BTreeSet::from([NODE_ID.to_owned()]),
        "and what the database holds it as is what the window is told"
    );
    assert_eq!(deleted_flag(&transaction, NODE_ID), 1, "still in the trash");
    let recorded: String = transaction
        .query_row(
            "SELECT sync_prev FROM notes_nodes WHERE id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("claim");
    assert_eq!(
        recorded, live,
        "the claim is recorded either way — the ordering column is not the announcement"
    );
    assert_eq!(
        outcome.applied, 2,
        "both claims were recorded, so the caller has keys to rebuild and a revision to move"
    );
}

/// The other direction, and the reason the row's own column is what decides: a
/// trash file states a deletion a newer local edit outlived, so the rows are
/// still on the page. Their lines are there to redraw, and told they were gone
/// the window would throw away whatever the caret is holding on them.
#[test]
fn a_claim_from_the_trash_on_a_row_that_outlived_it_is_named_as_changed() {
    let first = "Nd0000000003";
    let second = "Nd0000000004";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mut parent = node(NODE_ID, &stamp(20, "a3f2"), "Kept");
    parent.children = vec![
        node(first, &stamp(20, "a3f2"), "One"),
        node(second, &stamp(20, "a3f2"), "Two"),
    ];
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(vec![parent], &stamp(20, "a3f2"))),
        &input(),
        None,
    )
    .expect("seed");

    // The deletion is older than every row it names, so it loses all three —
    // but its claim on the two children is newer than the one they hold, and
    // that is adopted on rows still very much on the page.
    let claimed = stamp(30, "a3f2");
    let claim = |id: &str, prev: &str, text: &str| {
        let mut carrier = node(id, &stamp(5, "a3f2"), text);
        carrier.place = Some((prev.to_owned(), claimed.clone()));
        carrier
    };
    let mut gone = node(NODE_ID, &stamp(5, "a3f2"), "Kept");
    gone.from = Some((PAGE_ID.to_owned(), 4_294_967_296));
    gone.children = vec![claim(second, "", "Two"), claim(first, second, "One")];

    let outcome = merge_document(
        &transaction,
        &clock(),
        &trash(vec![gone], &stamp(30, "a3f2")),
        &trash_input(),
        None,
    )
    .expect("trash");

    assert_eq!(
        outcome.changed_ids,
        std::collections::BTreeSet::from([first.to_owned(), second.to_owned()]),
        "the rows are on the page, whatever file the claim arrived in"
    );
    assert!(
        outcome.deleted_ids.is_empty(),
        "nothing was deleted: the local edit is newer than the deletion"
    );
    assert_eq!(deleted_flag(&transaction, first), 0, "still on the page");
}

fn parent_of(connection: &Connection, id: &str) -> String {
    connection
        .query_row(
            "SELECT parent_id FROM notes_nodes WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("parent")
}

fn recovery_page(connection: &Connection) -> Option<String> {
    connection
        .query_row(
            "SELECT id FROM notes_nodes WHERE parent_id = 'root' AND text = '복구됨'",
            [],
            |row| row.get(0),
        )
        .ok()
}

/// Two devices each moving the other's node underneath their own leave a parent
/// chain that closes on itself — a state no file can express, which is exactly
/// why the repair has to be able to reach it. One node has to come out, and
/// every device has to pick the same one, or the vaults never converge.
#[test]
fn a_cycle_parks_the_same_node_for_the_same_input() {
    let first = "Nd0000000001";
    let second = "Nd0000000002";
    let mut parked = Vec::new();

    // The same ring, built from either end.
    for rotation in [false, true] {
        let mut connection = database();
        let transaction = connection.transaction().expect("begin");
        let seeded = stamp(5, "a3f2");
        merge_document(
            &transaction,
            &clock(),
            &notes_sync::document::VaultFile::Page(page(
                vec![
                    node(first, &seeded, "First"),
                    node(second, &seeded, "Second"),
                ],
                &seeded,
            )),
            &input(),
            None,
        )
        .expect("seed");
        let pairs = if rotation {
            [
                (first, second, stamp(11, "bbb2")),
                (second, first, stamp(9, "a3f2")),
            ]
        } else {
            [
                (second, first, stamp(9, "a3f2")),
                (first, second, stamp(11, "bbb2")),
            ]
        };
        for (child, parent, mark) in pairs {
            transaction
                .execute(
                    "UPDATE notes_nodes SET parent_id = ?2, hlc = ?3 WHERE id = ?1",
                    rusqlite::params![child, parent, mark],
                )
                .expect("close the ring");
        }

        // Any merge at all is enough: the repair runs at the end of every one.
        merge_document(
            &transaction,
            &clock(),
            &notes_sync::document::VaultFile::Page(page(Vec::new(), &seeded)),
            &input(),
            None,
        )
        .expect("merge");

        let recovery = recovery_page(&transaction).expect("a recovery page was made");
        let moved: Vec<String> = {
            let mut statement = transaction
                .prepare("SELECT id FROM notes_nodes WHERE parent_id = ?1 ORDER BY id")
                .expect("prepare");
            let rows = statement
                .query_map([&recovery], |row| row.get::<_, String>(0))
                .expect("query");
            rows.map(|row| row.expect("row")).collect()
        };
        assert_eq!(moved.len(), 1, "exactly one node comes out of the ring");
        parked.push(moved[0].clone());
    }

    assert_eq!(
        parked[0], parked[1],
        "both build orders take the same node out, or the two vaults never agree"
    );
    assert_eq!(
        parked[0], second,
        "the ring gives up its smallest stamp, and that stamp came from a file"
    );
}

/// Adopting what another device decided is not a local edit: the file already
/// states it. The row's own mark is taken back — and so is the mark the
/// trigger mints for the file that holds it, or a merge leaves the queue with
/// work nothing will ever write, which is what blocks a reindex for good.
#[test]
fn adopting_another_devices_decision_leaves_the_queue_as_it_found_it() {
    let node_id = "Nd0000000001";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let seeded = stamp(5, "a3f2");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(node_id, &seeded, "First")],
            &seeded,
        )),
        &input(),
        None,
    )
    .expect("seed");
    transaction
        .execute("DELETE FROM sync_dirty_nodes", ())
        .expect("clear");

    // The same reading, a different word: what another device wrote at a
    // stamp this one already holds.
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(node_id, &seeded, "Second")],
            &seeded,
        )),
        &input(),
        None,
    )
    .expect("merge");

    let waiting: i64 = transaction
        .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
            row.get(0)
        })
        .expect("dirty");
    assert_eq!(waiting, 0, "the file this came from already says all of it");
}

/// A note the trash says was taken from a page this device already has must
/// leave that page exactly as it was. The stand-in row exists for a parent
/// nobody has seen yet; running it over a real one wipes that note's reading
/// — which loses it every later comparison — and drops whatever it was owed.
#[test]
fn the_trash_does_not_stand_in_for_a_parent_that_is_already_here() {
    let parent = "Nd0000000001";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let seeded = stamp(5, "a3f2");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(vec![node(parent, &seeded, "")], &seeded)),
        &input(),
        None,
    )
    .expect("seed");
    // A note with no words yet is an ordinary state — a row somebody just
    // made and has not typed into.
    let before: String = transaction
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [parent],
            |row| row.get(0),
        )
        .expect("hlc");
    transaction
        .execute("DELETE FROM sync_dirty_nodes", ())
        .expect("clear");
    transaction
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id, marked_at) VALUES (?1, 0)",
            [parent],
        )
        .expect("owed");

    let mut deleted = node("Nd000000000e", &seeded, "Taken out");
    deleted.from = Some((parent.to_owned(), 4_294_967_296));
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Trash(notes_sync::document::TrashDocument {
            max_hlc: seeded.clone(),
            nodes: vec![deleted],
        }),
        &notes_sync::merger::MergeInput {
            file_path: ".yonalist/trash.md".to_owned(),
            ..input()
        },
        None,
    )
    .expect("merge the trash");

    let after: String = transaction
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [parent],
            |row| row.get(0),
        )
        .expect("hlc");
    assert_eq!(
        after, before,
        "a note that is already here keeps its reading, or it loses every \
         comparison from now on"
    );
    let waiting: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
            [parent],
            |row| row.get(0),
        )
        .expect("dirty");
    assert_eq!(
        waiting, 1,
        "and it still owes the write it owed before the trash arrived"
    );
}

/// A copy some sync client wrote holds the same document id, so recording it
/// would move that document's file to the copy's name. Every later write would
/// go into the copy while the real file went stale — and the other device,
/// reading the same two files, would swap the name back.
#[test]
fn a_conflicted_copy_does_not_become_the_documents_own_file() {
    // iCloud's numbered duplicate is the same copy under a name that looks like
    // a document this app wrote.
    for copy in [
        "Projects-PrJects00001/README (conflicted copy 2026-08-16).md",
        "Projects-PrJects00001/README 2.md",
    ] {
        let mut connection = database();
        let transaction = connection.transaction().expect("begin");
        let seeded = stamp(5, "a3f2");
        let file = notes_sync::document::VaultFile::Page(page(
            vec![node("Nd0000000001", &seeded, "First")],
            &seeded,
        ));
        merge_document(&transaction, &clock(), &file, &input(), None).expect("the page");

        let outcome = merge_document(
            &transaction,
            &clock(),
            &file,
            &notes_sync::merger::MergeInput {
                file_path: copy.to_owned(),
                file_hash: "b".repeat(64),
                ..input()
            },
            None,
        )
        .expect("the copy");

        let recorded: String = transaction
            .query_row(
                "SELECT folder_path FROM sync_documents WHERE root_id = ?1",
                ["PrJects00001"],
                |row| row.get(0),
            )
            .expect("the document");
        assert_eq!(
            recorded, "Projects-PrJects00001/README.md",
            "the page keeps its own name against `{copy}`"
        );
        assert!(
            outcome.retire_file,
            "and `{copy}` is handed back to be removed, or every device reads it \
             again for ever"
        );
    }
}

/// What was last written for a node is only true until another device's
/// version wins. Keeping the old record would have the export put that
/// reading back — onto a row every other device now holds at a different one,
/// which is two devices rewriting the same file at each other for ever.
///
/// The row itself stays, emptied. It answers a second question — whether the
/// vault has ever stated this node — and a node that arrived in a file has.
#[test]
fn adopting_another_devices_version_forgets_what_this_one_last_wrote() {
    let node_id = "Nd0000000001";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let seeded = stamp(5, "a3f2");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(node_id, &seeded, "First")],
            &seeded,
        )),
        &input(),
        None,
    )
    .expect("seed");
    transaction
        .execute(
            // Over whatever the seeding merge left, the way an export of the
            // seeded row would have.
            "INSERT INTO sync_node_exports(node_id, content_hash, exported_hlc)
             VALUES (?1, 'whatever this device last wrote', ?2)
             ON CONFLICT(node_id) DO UPDATE SET
                 content_hash = excluded.content_hash,
                 exported_hlc = excluded.exported_hlc",
            rusqlite::params![node_id, &seeded],
        )
        .expect("record");

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(node_id, &stamp(9, "bbb2"), "Theirs")],
            &stamp(9, "bbb2"),
        )),
        &input(),
        None,
    )
    .expect("their version");

    let kept: Option<(String, String)> = transaction
        .query_row(
            "SELECT content_hash, exported_hlc FROM sync_node_exports WHERE node_id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .expect("records");
    assert_eq!(
        kept,
        Some((String::new(), String::new())),
        "this row holds no reading this device could put back, and stays as the \
         mark that the vault has stated the node"
    );
}

/// A copy of the trash is read and taken away like any other copy — and the
/// deletions it stated have to reach the canonical `trash.md`, which is the
/// only evidence a deletion ever gets. Without that they exist in this
/// database and nowhere else: every other device keeps the notes alive and
/// hands them back.
#[test]
fn a_trash_copy_leaves_the_real_trash_owing_a_write() {
    let node_id = "Nd0000000001";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let seeded = stamp(5, "a3f2");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(node_id, &seeded, "Taken out")],
            &seeded,
        )),
        &input(),
        None,
    )
    .expect("seed");
    transaction
        .execute("DELETE FROM sync_dirty_nodes", ())
        .expect("clear");

    let mut deleted = node(node_id, &stamp(9, "bbb2"), "Taken out");
    deleted.from = Some(("PrJects00001".to_owned(), 4_294_967_296));
    let outcome = merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Trash(notes_sync::document::TrashDocument {
            max_hlc: stamp(9, "bbb2"),
            nodes: vec![deleted],
        }),
        &notes_sync::merger::MergeInput {
            file_path: ".yonalist/trash (conflicted copy 2026-08-16).md".to_owned(),
            ..input()
        },
        None,
    )
    .expect("the copy");

    assert!(outcome.retire_file, "the copy is handed back to be removed");
    let pending = notes_sync::export::pending_documents(&transaction).expect("pending");
    assert!(
        pending.contains(&"yonalist-trash".to_owned()),
        "the deletion has to be stated in the file every device reads: {pending:?}"
    );
}

/// A document that states the node it hangs from is a split document, not a
/// page. The difference decides whether "no longer a child of root" means it
/// stopped being a page — for a split document that is where it has always
/// been, and treating it as a demotion flattens it into its page.
#[test]
fn a_document_that_states_its_parent_is_recorded_as_a_split_document() {
    let node_id = "Nd0000000001";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let seeded = stamp(5, "a3f2");
    let mut split = page(vec![node(node_id, &seeded, "Inside")], &seeded);
    split.id = DocumentId::Node(node_id.to_owned());
    split.parent = Some(PAGE_ID.to_owned());

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(split),
        &notes_sync::merger::MergeInput {
            file_path: "Projects-PrJects00001/Deeper-Nd0000000001/README.md".to_owned(),
            ..input()
        },
        None,
    )
    .expect("merge");

    let is_page: i64 = transaction
        .query_row(
            "SELECT is_page FROM sync_documents WHERE root_id = ?1",
            [node_id],
            |row| row.get(0),
        )
        .expect("the document");
    assert_eq!(is_page, 0, "it says which node it hangs from");
}

/// A rescue that no file states is a rescue nobody else ever sees — and on the
/// device that did it, a reindex from the vault would take the node away
/// again. The recovery page, the node put under it, and home all owe a write.
#[test]
fn a_rescued_node_and_the_page_holding_it_owe_a_file() {
    let first = "Nd0000000001";
    let second = "Nd0000000002";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let seeded = stamp(5, "a3f2");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![
                node(first, &seeded, "First"),
                node(second, &seeded, "Second"),
            ],
            &seeded,
        )),
        &input(),
        None,
    )
    .expect("seed");
    for (child, parent, mark) in [
        (second, first, stamp(9, "a3f2")),
        (first, second, stamp(11, "bbb2")),
    ] {
        transaction
            .execute(
                "UPDATE notes_nodes SET parent_id = ?2, hlc = ?3 WHERE id = ?1",
                rusqlite::params![child, parent, mark],
            )
            .expect("close the ring");
    }
    transaction
        .execute("DELETE FROM sync_dirty_nodes", ())
        .expect("clear");

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(Vec::new(), &seeded)),
        &input(),
        None,
    )
    .expect("merge");

    let recovery = recovery_page(&transaction).expect("a recovery page was made");
    for owed in [second, recovery.as_str(), "root"] {
        let waiting: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                [owed],
                |row| row.get(0),
            )
            .expect("dirty");
        assert_eq!(
            waiting, 1,
            "`{owed}` was rescued into a state no file states yet"
        );
    }
}

/// A deletion winning over a parent while an edit wins over its child leaves
/// the child alive under a parent that is gone. It goes where the user can
/// find it rather than staying invisible.
#[test]
fn an_orphaned_live_child_parks_on_the_recovery_page() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let parent_id = "Nd0000000001";
    let child_id = "Nd0000000002";
    let mut parent = node(parent_id, &stamp(5, "a3f2"), "Parent");
    parent.children = vec![node(child_id, &stamp(5, "a3f2"), "Child")];
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(vec![parent], &stamp(5, "a3f2"))),
        &input(),
        None,
    )
    .expect("seed");

    // The parent is deleted elsewhere; the child is edited elsewhere, later.
    let mut gone = node(parent_id, &stamp(9, "a3f2"), "Parent");
    gone.from = Some((PAGE_ID.to_owned(), 4_294_967_296));
    merge_document(
        &transaction,
        &clock(),
        &trash(vec![gone], &stamp(9, "a3f2")),
        &trash_input(),
        None,
    )
    .expect("trash");

    let recovery = recovery_page(&transaction).expect("a recovery page was made");
    assert_eq!(
        parent_of(&transaction, child_id),
        recovery,
        "a live child of a deleted parent is not left where nobody can see it"
    );
    assert_eq!(deleted_flag(&transaction, child_id), 0);
}

/// Two devices that both had to rescue the same nodes have to lay them out the
/// same way, or their recovery pages differ and each keeps rewriting the
/// other's. Each key comes from the node's own id — one key for all of them
/// would stack the rescues on top of each other and leave the order to chance.
#[test]
fn rescued_nodes_land_in_the_same_order_whichever_was_rescued_first() {
    let one = "Nd00000000aa";
    let two = "Nd00000000bb";
    let mut orders = Vec::new();

    for reversed in [false, true] {
        let mut connection = database();
        let transaction = connection.transaction().expect("begin");
        let seeded = stamp(5, "a3f2");
        let ids = if reversed { [two, one] } else { [one, two] };
        let mut parent = node(NODE_ID, &seeded, "Parent");
        parent.children = ids.iter().map(|id| node(id, &seeded, "Child")).collect();
        merge_document(
            &transaction,
            &clock(),
            &notes_sync::document::VaultFile::Page(page(vec![parent], &seeded)),
            &input(),
            None,
        )
        .expect("seed");

        let mut gone = node(NODE_ID, &stamp(9, "a3f2"), "Parent");
        gone.from = Some((PAGE_ID.to_owned(), 4_294_967_296));
        merge_document(
            &transaction,
            &clock(),
            &trash(vec![gone], &stamp(9, "a3f2")),
            &trash_input(),
            None,
        )
        .expect("trash");

        let recovery = recovery_page(&transaction).expect("a recovery page was made");
        let mut statement = transaction
            .prepare("SELECT id FROM notes_nodes WHERE parent_id = ?1 ORDER BY sort_key, id")
            .expect("prepare");
        let rows = statement
            .query_map([&recovery], |row| row.get::<_, String>(0))
            .expect("query");
        orders.push(rows.map(|row| row.expect("row")).collect::<Vec<_>>());
    }

    assert_eq!(orders[0].len(), 2);
    assert_eq!(orders[0], orders[1]);

    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let seeded = stamp(5, "a3f2");
    let mut parent = node(NODE_ID, &seeded, "Parent");
    parent.children = [one, two]
        .iter()
        .map(|id| node(id, &seeded, "Child"))
        .collect();
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(vec![parent], &seeded)),
        &input(),
        None,
    )
    .expect("seed");
    let mut gone = node(NODE_ID, &stamp(9, "a3f2"), "Parent");
    gone.from = Some((PAGE_ID.to_owned(), 4_294_967_296));
    merge_document(
        &transaction,
        &clock(),
        &trash(vec![gone], &stamp(9, "a3f2")),
        &trash_input(),
        None,
    )
    .expect("trash");
    let recovery = recovery_page(&transaction).expect("a recovery page was made");
    let distinct: i64 = transaction
        .query_row(
            "SELECT count(DISTINCT sort_key) FROM notes_nodes WHERE parent_id = ?1",
            [&recovery],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(
        distinct, 2,
        "each rescued node gets its own place, not one shared with the rest"
    );
}

/// A line someone typed has no id yet, and the line after it says it follows
/// that line. If the id is issued after the following line's evidence is
/// captured, the follower claims to be first — and the document reorders
/// itself around a single typed line.
#[test]
fn a_typed_line_does_not_unseat_the_sibling_after_it() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let a = "Nd0000000001";
    let b = "Nd0000000002";
    let c = "Nd0000000003";
    let mine = stamp(5, DEVICE);
    let seed = |ids: Vec<DocumentNode>| notes_sync::document::VaultFile::Page(page(ids, &mine));
    merge_document(
        &transaction,
        &clock(),
        &seed(vec![
            node(a, &mine, "A"),
            node(b, &mine, "B"),
            node(c, &mine, "C"),
        ]),
        &input(),
        None,
    )
    .expect("seed");
    let before: Vec<String> = order_under(&transaction, PAGE_ID);

    merge_document(
        &transaction,
        &clock(),
        &seed(vec![
            node(a, &mine, "A"),
            node("", "", "Typed"),
            node(b, &mine, "B"),
            node(c, &mine, "C"),
        ]),
        &input(),
        None,
    )
    .expect("typed");

    let after = order_under(&transaction, PAGE_ID);
    assert_eq!(
        after,
        vec![
            before[0].clone(),
            after[1].clone(),
            before[1].clone(),
            before[2].clone()
        ],
        "the typed line goes where it was typed and nothing else moves"
    );
    let who: Vec<(String, String)> = {
        let mut st = transaction
            .prepare("SELECT id, hlc FROM notes_nodes WHERE id IN (?1, ?2)")
            .unwrap();
        st.query_map(rusqlite::params![b, c], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    eprintln!("WHO {who:?} mine={mine}");
    let restamped: i64 = transaction
        .query_row(
            "SELECT count(*) FROM notes_nodes WHERE id IN (?1, ?2) AND hlc <> ?3",
            rusqlite::params![b, c, mine],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(restamped, 0, "and its neighbours keep the stamps they had");
}

fn order_under(connection: &Connection, parent: &str) -> Vec<String> {
    let mut statement = connection
        .prepare(
            "SELECT id FROM notes_nodes WHERE parent_id = ?1 AND deleted = 0
             ORDER BY sort_key, id",
        )
        .expect("prepare");
    let rows = statement
        .query_map([parent], |row| row.get::<_, String>(0))
        .expect("query");
    rows.map(|row| row.expect("row")).collect()
}

/// A page arriving for the first time joins the end of the list. Giving every
/// new page the same key leaves the order to whichever id happens to sort
/// first.
#[test]
fn a_new_page_lands_after_the_pages_already_there() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(Vec::new(), &stamp(5, "a3f2"))),
        &input(),
        None,
    )
    .expect("first");
    let mut elsewhere = input();
    elsewhere.file_path = "Second-Mnutes000001/README.md".to_owned();

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(second_page()),
        &elsewhere,
        None,
    )
    .expect("second");

    assert_eq!(
        order_of_pages(&transaction),
        vec!["Projects".to_owned(), "Second".to_owned()],
        "a page that arrives second is second"
    );
}

/// The write-back is what replaces the broken stamp in the file. A replay
/// arriving before the exporter runs must not cancel it, or the far-future
/// stamp stays in the vault and every device guards against it forever.
#[test]
fn a_drift_echo_still_asks_for_the_file_to_be_rewritten() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let far = Hlc::new(FAR_FUTURE_MILLIS, 0, "a3f2")
        .expect("far")
        .encode();
    let file = notes_sync::document::VaultFile::Page(page(
        vec![node(NODE_ID, &far, "From a broken clock")],
        &far,
    ));
    merge_document(&transaction, &clock(), &file, &input(), None).expect("first");

    let outcome = merge_document(&transaction, &clock(), &file, &input(), None).expect("replay");

    assert!(outcome.needs_write_back);
    // What says the file is behind is the dirty mark, not a hash that disagrees
    // with the bytes on disk: recording anything but the absorbed bytes would
    // leave the exporter answering "somebody's edit" forever and the canonical
    // form would never reach the file.
    let waiting: i64 = transaction
        .query_row(
            "SELECT count(*) FROM sync_dirty_nodes WHERE node_id = ?1",
            [PAGE_ID],
            |row| row.get(0),
        )
        .expect("dirty");
    assert_eq!(waiting, 1, "the document is queued for a rewrite");
}

/// The conflict log is read back by the settings screen and re-applied from.
/// A payload that is not JSON is a defeat nobody can recover.
#[test]
fn a_loser_with_a_newline_is_still_json() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mut multiline = node(NODE_ID, &stamp(5, "a3f2"), "first line\nsecond line");
    // A tab, and a control character with no name of its own — the second is
    // what the escape range has to catch.
    multiline.note = "a\tnote\u{1}here".to_owned();
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(vec![multiline], &stamp(5, "a3f2"))),
        &input(),
        None,
    )
    .expect("seed");
    // Never exported, so this device holds the only copy of it.
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
            vec![node(NODE_ID, &stamp(9, "a3f2"), "theirs")],
            &stamp(9, "a3f2"),
        )),
        &input(),
        None,
    )
    .expect("newer");

    let (valid, raw_newlines): (i64, i64) = transaction
        .query_row(
            "SELECT min(json_valid(loser_json)), sum(instr(loser_json, char(10)) > 0)
             FROM sync_conflict_log",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("valid");
    assert_eq!(valid, 1, "every recorded defeat has to be readable again");
    assert_eq!(
        raw_newlines, 0,
        "a line break inside a JSON string is written as an escape, not as itself"
    );
    let text: String = transaction
        .query_row(
            "SELECT json_extract(loser_json, '$.text') FROM sync_conflict_log
             WHERE node_id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("text");
    assert_eq!(text, "first line\nsecond line", "and it comes back whole");
}

/// A tie-break the file loses is a tie-break, not a plain defeat on the
/// stamps. The screen shows the reason, so it has to be the true one.
#[test]
fn a_same_stamp_defeat_is_labelled_as_one() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let theirs = stamp(5, "a3f2");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &theirs, "Omega")],
            &theirs,
        )),
        &input(),
        None,
    )
    .expect("seed");

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &theirs, "Alpha")],
            &theirs,
        )),
        &input(),
        None,
    )
    .expect("tie");

    let reason: String = transaction
        .query_row(
            "SELECT json_extract(loser_json, '$.reason') FROM sync_conflict_log
             WHERE node_id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("reason");
    assert_eq!(reason, "same_t");
}

/// Replaying the same trash is not a second deletion, however many nodes it
/// holds. Comparing them against an order that never included deleted rows
/// makes each one look moved.
#[test]
fn replaying_a_trash_with_several_roots_changes_nothing() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mine = stamp(5, DEVICE);
    let roots: Vec<DocumentNode> = ["Nd0000000005", "Nd0000000006", "Nd0000000007"]
        .iter()
        .enumerate()
        .map(|(index, tail)| {
            let mut gone = node(tail, &mine, &format!("Gone {index}"));
            gone.from = Some((PAGE_ID.to_owned(), (index as i64 + 1) * 4_294_967_296));
            gone
        })
        .collect();
    let file = trash(roots, &mine);
    merge_document(&transaction, &clock(), &file, &trash_input(), None).expect("first");

    let outcome =
        merge_document(&transaction, &clock(), &file, &trash_input(), None).expect("replay");

    assert_eq!(outcome.applied, 0);
    assert_eq!(conflicts(&transaction), 0);
}

fn split_line(id: &str, hlc: &str, title: &str, path: &str) -> DocumentNode {
    let mut line = node(id, hlc, "");
    line.body = NodeBody::Split {
        title: title.to_owned(),
        path: path.to_owned(),
    };
    line
}

const CHILD_ID: &str = "Archive00001";

fn child_document(hlc: &str, title: &str, starred: bool) -> PageDocument {
    PageDocument {
        id: DocumentId::Node(CHILD_ID.to_owned()),
        parent: Some(PAGE_ID.to_owned()),
        sort_key: Some(4_294_967_296),
        max_hlc: hlc.to_owned(),
        // Built in memory, so there is no file that could have been cut short.
        stated_max_hlc: hlc.to_owned(),
        root: DocumentRoot {
            title: title.to_owned(),
            hlc: hlc.to_owned(),
            starred,
            ..DocumentRoot::default()
        },
        nodes: Vec::new(),
        unknown_frontmatter: Vec::new(),
        writer: None,
    }
}

fn child_input() -> MergeInput {
    let mut input = input();
    input.file_path = "Projects-PrJects00001/Archive-Archive00001/README.md".to_owned();
    input
}

fn starred_flag(connection: &Connection, id: &str) -> i64 {
    connection
        .query_row(
            "SELECT starred FROM notes_nodes WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .expect("starred")
}

/// A split line says a node exists and where it sits, and nothing else. Its
/// title is a display copy the child document owns, so believing the line
/// would give one node two authorities and let merge order decide the answer.
#[test]
fn a_split_line_grants_existence_and_position_only() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mark = stamp(5, "a3f2");

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![split_line(
                CHILD_ID,
                &mark,
                "Stale display title",
                "Archive-Archive00001/README.md",
            )],
            &mark,
        )),
        &input(),
        None,
    )
    .expect("parent");

    assert_eq!(
        parent_of(&transaction, CHILD_ID),
        PAGE_ID,
        "the line is what says the node is here at all"
    );
    assert_eq!(hlc_of(&transaction, CHILD_ID), mark);
    let document_rows: i64 = transaction
        .query_row(
            "SELECT count(*) FROM sync_documents WHERE root_id = ?1",
            [CHILD_ID],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(
        document_rows, 0,
        "no row yet: that absence is how the merge knows the child never arrived"
    );
}

/// The child document is the authority on its own state, whichever file lands
/// first. Both orders have to reach the same rows or the two devices never
/// agree about the same node.
#[test]
fn a_child_document_converges_in_either_arrival_order() {
    let mark = stamp(5, "a3f2");
    let mut states = Vec::new();

    for child_first in [false, true] {
        let mut connection = database();
        let transaction = connection.transaction().expect("begin");
        let parent_file = notes_sync::document::VaultFile::Page(page(
            vec![split_line(
                CHILD_ID,
                &mark,
                "Stale display title",
                "Archive-Archive00001/README.md",
            )],
            &mark,
        ));
        let child_file =
            notes_sync::document::VaultFile::Page(child_document(&mark, "2024 Archive", true));

        if child_first {
            merge_document(&transaction, &clock(), &child_file, &child_input(), None)
                .expect("child");
            merge_document(&transaction, &clock(), &parent_file, &input(), None).expect("parent");
        } else {
            merge_document(&transaction, &clock(), &parent_file, &input(), None).expect("parent");
            merge_document(&transaction, &clock(), &child_file, &child_input(), None)
                .expect("child");
        }

        states.push((
            text_of(&transaction, CHILD_ID).expect("text"),
            starred_flag(&transaction, CHILD_ID),
            parent_of(&transaction, CHILD_ID),
            hlc_of(&transaction, CHILD_ID),
        ));
    }

    assert_eq!(
        states[0], states[1],
        "arrival order cannot decide the answer"
    );
    assert_eq!(
        states[0].0, "2024 Archive",
        "the child document owns the title"
    );
    assert_eq!(states[0].1, 1, "and every other piece of its state");
    assert_eq!(states[0].2, PAGE_ID, "the parent's line owns where it sits");
}

/// Replaying the pair changes nothing. A split node lives in two files, so a
/// second reading of either must not read as an edit.
#[test]
fn replaying_a_split_pair_changes_nothing() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mark = stamp(5, "a3f2");
    let parent_file = notes_sync::document::VaultFile::Page(page(
        vec![split_line(
            CHILD_ID,
            &mark,
            "2024 Archive",
            "Archive-Archive00001/README.md",
        )],
        &mark,
    ));
    let child_file =
        notes_sync::document::VaultFile::Page(child_document(&mark, "2024 Archive", true));
    merge_document(&transaction, &clock(), &parent_file, &input(), None).expect("parent");
    merge_document(&transaction, &clock(), &child_file, &child_input(), None).expect("child");

    let again =
        merge_document(&transaction, &clock(), &parent_file, &input(), None).expect("replay");
    let and_again =
        merge_document(&transaction, &clock(), &child_file, &child_input(), None).expect("replay");

    assert_eq!(again.applied, 0, "the parent's line states nothing new");
    assert_eq!(and_again.applied, 0, "and neither does the child");
    assert_eq!(conflicts(&transaction), 0);
}

/// Two devices claiming the same slot with the same claim stamp is a race, and
/// the value settles it — the same way on both of them. Anything that depended
/// on which file arrived first would leave the two vaults holding the notes in
/// different orders.
#[test]
fn equal_claim_stamps_break_place_ties_by_digest() {
    let first = "Nd0000000001";
    let second = "Nd0000000002";
    let third = "Nd0000000003";
    let base = stamp(5, "a3f2");
    let mut orders = Vec::new();

    for reversed in [false, true] {
        let mut connection = database();
        let transaction = connection.transaction().expect("begin");
        let claim = |id: &str, prev: &str| {
            let mut carrier = node(id, &base, "Node");
            carrier.place = Some((prev.to_owned(), base.clone()));
            carrier
        };
        // Both files stamp their claim identically and disagree about who is
        // first.
        let one = notes_sync::document::VaultFile::Page(page(
            vec![claim(second, ""), claim(first, second), claim(third, first)],
            &base,
        ));
        let other = notes_sync::document::VaultFile::Page(page(
            vec![claim(first, ""), claim(second, first), claim(third, second)],
            &base,
        ));
        let (a, b) = if reversed {
            (&other, &one)
        } else {
            (&one, &other)
        };
        merge_document(&transaction, &clock(), a, &input(), None).expect("first");
        merge_document(&transaction, &clock(), b, &input(), None).expect("second");

        orders.push(order_under(&transaction, PAGE_ID));
    }

    assert_eq!(
        orders[0], orders[1],
        "a race over one slot cannot be settled by which file was read first"
    );
}

/// The shape the ordering property shrank to. A node that never moved must end
/// up in the same place whichever file was read first — its own claim says
/// where it sits, so there is nothing for the two files to disagree about.
#[test]
fn two_documents_sharing_a_base_agree_on_an_unmoved_nodes_place() {
    let one = "Nd0000000001";
    let two = "Nd0000000002";
    let three = "Nd0000000003";
    let base = stamp(5, "a3f2");
    let mut orders = Vec::new();

    for reversed in [false, true] {
        let mut connection = database();
        let transaction = connection.transaction().expect("begin");

        // One device moved `two` to the front. A move rewrites three claims:
        // the node itself, whoever it now follows, and whoever it stopped
        // following.
        let moved_at = stamp(9, "aaa1");
        let mut two_first = node(two, &moved_at, "node 1");
        two_first.place = Some((String::new(), moved_at.clone()));
        let mut one_after_two = node(one, &base, "node 0");
        one_after_two.place = Some((two.to_owned(), moved_at.clone()));
        let mut three_after_one = node(three, &base, "node 2");
        three_after_one.place = Some((one.to_owned(), moved_at.clone()));
        let moved = notes_sync::document::VaultFile::Page(page(
            vec![two_first, one_after_two, three_after_one],
            &moved_at,
        ));

        // The other device only restamped `one` where it already was, so its
        // file still carries the claims the document was created with.
        let mut one_first = node(one, &stamp(7, "bbb2"), "node 0");
        one_first.place = Some((String::new(), base.clone()));
        let mut two_after_one = node(two, &base, "node 1");
        two_after_one.place = Some((one.to_owned(), base.clone()));
        let mut three_after_two = node(three, &base, "node 2");
        three_after_two.place = Some((two.to_owned(), base.clone()));
        let edited = notes_sync::document::VaultFile::Page(page(
            vec![one_first, two_after_one, three_after_two],
            &stamp(7, "bbb2"),
        ));

        let (first, second) = if reversed {
            (&edited, &moved)
        } else {
            (&moved, &edited)
        };
        merge_document(&transaction, &clock(), first, &input(), None).expect("first");
        merge_document(&transaction, &clock(), second, &input(), None).expect("second");

        orders.push(order_under(&transaction, PAGE_ID));
    }

    assert_eq!(
        orders[0], orders[1],
        "a node nobody moved cannot land differently because of arrival order"
    );
    assert_eq!(
        orders[0],
        vec![two.to_owned(), one.to_owned(), three.to_owned()],
        "and the order is the one the device that moved something was looking at"
    );
}

/// A page can be read before home is. It joins the end of the list saying so
/// with an empty claim stamp, so home's real line wins whenever it arrives —
/// however long the page has been sitting there being edited.
#[test]
fn a_page_that_arrives_before_home_yields_to_homes_line() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let other = "Mnutes000001";
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(Vec::new(), &stamp(5, "a3f2"))),
        &input(),
        None,
    )
    .expect("first page");
    let mut elsewhere = input();
    elsewhere.file_path = "Second-Mnutes000001/README.md".to_owned();
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(second_page()),
        &elsewhere,
        None,
    )
    .expect("second page");

    // Home finally arrives, and it lists them the other way round.
    let mut home = page(
        vec![
            split_line(
                other,
                &stamp(1, "a3f2"),
                "Second",
                "Second-Mnutes000001/README.md",
            ),
            split_line(
                PAGE_ID,
                &stamp(1, "a3f2"),
                "Projects",
                "Projects-PrJects00001/README.md",
            ),
        ],
        &stamp(1, "a3f2"),
    );
    home.id = DocumentId::Home;
    home.root.title = "Home".to_owned();
    home.root.hlc = stamp(1, "a3f2");
    let mut at_root = input();
    at_root.file_path = "README.md".to_owned();
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(home),
        &at_root,
        None,
    )
    .expect("home");

    assert_eq!(
        order_of_pages(&transaction),
        vec!["Second".to_owned(), "Projects".to_owned()],
        "home says where the pages go, however old its line is"
    );
}

/// The bytes of a picture arrive after the line that points at them, and from
/// then on the row names the picture by its hash while the file still names it
/// by its link. If the comparison keeps reading those two as different states,
/// every replay of the same file looks like a hand edit on this device and the
/// stamp moves — a phantom edit that ping-pongs between two devices for ever.
#[test]
fn a_resolved_picture_replayed_is_not_an_edit() {
    const HASH: &str = "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mut picture = node(NODE_ID, &stamp(5, DEVICE), "");
    picture.body = NodeBody::Image(notes_sync::document::ImageReference {
        original_name: "holiday.png".to_owned(),
        path: "assets/holiday-9f2c1b7a4e6d.png".to_owned(),
        display_width: 320,
        pixel_width: 1280,
        pixel_height: 720,
        byte_size: 421_904,
    });
    let file = notes_sync::document::VaultFile::Page(page(vec![picture], &stamp(5, DEVICE)));
    merge_document(&transaction, &clock(), &file, &input(), None).expect("first");
    // The bytes land: the row learns its hash and takes the domain form.
    transaction
        .execute(
            "UPDATE notes_images SET content_hash = ?1, relative_path = ?1 || '.png'
             WHERE node_id = ?2",
            rusqlite::params![HASH, NODE_ID],
        )
        .expect("resolve");
    transaction
        .execute(
            "INSERT INTO sync_assets(content_hash, disk_name, location, unreferenced_at)
             VALUES (?1, 'holiday-9f2c1b7a4e6d.png', 'assets/holiday-9f2c1b7a4e6d.png', NULL)",
            [HASH],
        )
        .expect("asset");
    let before = hlc_of(&transaction, NODE_ID);

    let outcome = merge_document(&transaction, &clock(), &file, &input(), None).expect("replay");

    assert_eq!(outcome.applied, 0, "the same picture is not a new edit");
    assert_eq!(
        hlc_of(&transaction, NODE_ID),
        before,
        "and is not restamped"
    );
    assert_eq!(conflicts_for(&transaction, NODE_ID), 0);
}

/// When the bytes are already here, the row can say which picture it is from
/// the first merge. The link the file used is the vault's business, not the
/// row's.
#[test]
fn a_picture_whose_bytes_are_known_lands_in_domain_form() {
    const HASH: &str = "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    transaction
        .execute(
            "INSERT INTO sync_assets(content_hash, disk_name, location, unreferenced_at)
             VALUES (?1, 'holiday-9f2c1b7a4e6d.png', 'assets/holiday-9f2c1b7a4e6d.png', NULL)",
            [HASH],
        )
        .expect("asset");
    let mut picture = node(NODE_ID, &stamp(5, DEVICE), "");
    picture.body = NodeBody::Image(notes_sync::document::ImageReference {
        original_name: "holiday.png".to_owned(),
        path: "assets/holiday-9f2c1b7a4e6d.png".to_owned(),
        display_width: 320,
        pixel_width: 1280,
        pixel_height: 720,
        byte_size: 421_904,
    });
    let file = notes_sync::document::VaultFile::Page(page(vec![picture], &stamp(5, DEVICE)));

    merge_document(&transaction, &clock(), &file, &input(), None).expect("merge");

    let (hash, path): (String, String) = transaction
        .query_row(
            "SELECT content_hash, relative_path FROM notes_images WHERE node_id = ?1",
            [NODE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("image row");
    // The pair, not the path alone: a domain-form path over an empty hash is
    // a row `resolve_asset` can never rescue, since it names no file that
    // will ever arrive.
    assert_eq!(hash, HASH);
    assert_eq!(path, format!("{HASH}.png"));
}

/// The other half of the same rule. A line that names a different picture is
/// a different state, and under an equal stamp this device's own row wins and
/// is restamped — otherwise a comparison that ignored the picture entirely
/// would settle every replacement as "nothing happened".
#[test]
fn a_replaced_picture_under_an_equal_stamp_is_an_edit() {
    const HASH: &str = "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let file = page_with_picture("assets/holiday-9f2c1b7a4e6d.png");
    merge_document(&transaction, &clock(), &file, &input(), None).expect("first");
    resolve_picture(&transaction, HASH);
    let before = hlc_of(&transaction, NODE_ID);

    let replaced = page_with_picture("assets/holiday-aaaabbbbcccc.png");
    let outcome =
        merge_document(&transaction, &clock(), &replaced, &input(), None).expect("replace");

    assert_eq!(
        outcome.applied, 1,
        "a different picture is a different state"
    );
    assert_ne!(hlc_of(&transaction, NODE_ID), before, "so the stamp moves");
}

/// The attachment moved — a page's own `assets/` to the vault's, which the
/// placement pass does whenever a second note points at the same bytes. The
/// link changed and the bytes did not, so nothing was edited.
#[test]
fn a_repositioned_picture_is_not_an_edit() {
    const HASH: &str = "9f2c1b7a4e6d8c0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let file = page_with_picture("assets/holiday-9f2c1b7a4e6d.png");
    merge_document(&transaction, &clock(), &file, &input(), None).expect("first");
    resolve_picture(&transaction, HASH);
    let before = hlc_of(&transaction, NODE_ID);

    let moved = page_with_picture("../assets/holiday-9f2c1b7a4e6d.png");
    let outcome = merge_document(&transaction, &clock(), &moved, &input(), None).expect("replay");

    assert_eq!(
        outcome.applied, 0,
        "the same bytes, somewhere else in the vault"
    );
    assert_eq!(hlc_of(&transaction, NODE_ID), before);
}

/// One page, one picture, at whatever link the caller wants to state.
fn page_with_picture(link: &str) -> notes_sync::document::VaultFile {
    let mut picture = node(NODE_ID, &stamp(5, DEVICE), "");
    picture.body = NodeBody::Image(notes_sync::document::ImageReference {
        original_name: "holiday.png".to_owned(),
        path: link.to_owned(),
        display_width: 320,
        pixel_width: 1280,
        pixel_height: 720,
        byte_size: 421_904,
    });
    notes_sync::document::VaultFile::Page(page(vec![picture], &stamp(5, DEVICE)))
}

/// The bytes landed: the row learns its hash and takes the domain form.
fn resolve_picture(transaction: &rusqlite::Transaction<'_>, hash: &str) {
    transaction
        .execute(
            "UPDATE notes_images SET content_hash = ?1, relative_path = ?1 || '.png'
             WHERE node_id = ?2",
            rusqlite::params![hash, NODE_ID],
        )
        .expect("resolve");
    transaction
        .execute(
            "INSERT INTO sync_assets(content_hash, disk_name, location, unreferenced_at)
             VALUES (?1, 'holiday-9f2c1b7a4e6d.png', 'assets/holiday-9f2c1b7a4e6d.png', NULL)",
            [hash],
        )
        .expect("asset");
}

/// A file whose tail was lost still asks to be rewritten.
///
/// The bound on "is this file incomplete" is the newest stamp the file mentions,
/// and every node's stamp now lives in the footer — so a truncation that takes the
/// bullets takes the evidence with it, and the document read as complete. The
/// frontmatter survives a truncation, and its stated `max_hlc` is the one thing
/// left that says how much the file ought to have held.
///
/// The stated value is trusted for this and for nothing else. It is not the clock:
/// a hand edit that pushed it into the future would future-stamp every later local
/// edit, which is why the value the document carries is still recomputed from its
/// content. Inflating it here only asks for more rewrites, and a rewrite is safe.
#[test]
fn a_file_whose_footer_was_lost_still_asks_to_be_rewritten() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let whole = notes_sync::render::render(
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(5, "a3f2"), "Thought")],
            &stamp(5, "a3f2"),
        )),
        notes_sync::render::device_offset(),
    )
    .expect("render");
    notes_sync::merger::merge_document(
        &transaction,
        &clock(),
        &notes_sync::parse::parse(&whole).expect("parse"),
        &input(),
        None,
    )
    .expect("first");

    // The transport dropped the end of the file: the bullet and the footer that
    // stated its stamp went together, which is the correlated case.
    let text = String::from_utf8(whole).expect("utf-8");
    let (frontmatter, _) = text.split_once("\n# ").expect("a heading");
    let truncated = format!("{frontmatter}\n# Projects\n\n");

    let outcome = notes_sync::merger::merge_document(
        &transaction,
        &clock(),
        &notes_sync::parse::parse(truncated.as_bytes()).expect("parse"),
        &input(),
        None,
    )
    .expect("second");

    assert_eq!(
        text_of(&transaction, NODE_ID).as_deref(),
        Some("Thought"),
        "absence is not evidence — only trash.md deletes"
    );
    assert!(
        outcome.needs_write_back,
        "a file that lost its tail read as complete, so nothing would put the \
         missing bullet back into it"
    );
}

/// A picture's unknown tokens reach `sync_extras` in the order the file wrote
/// them, and that string is what the merge compares.
///
/// This is the item's one merge-visible risk, and it needs saying out loud rather
/// than being left to a byte-level round trip. `extras_of` used to join two lists
/// — the node's tokens and the picture's, which arrived in two separate comments.
/// One footer line carries both now, so it joins one list, and the two have to
/// spell the same string: `content_of_file` hashes it, so a different spelling of
/// the same unknown tokens is an edit on every device that meets it.
///
/// The footer writes a picture's own facts ahead of the tokens it cannot name,
/// which is what makes file order and list order agree. A test carrying only a
/// text node cannot fail here — it is the shape where the old and new bodies of
/// `extras_of` are identical by construction.
#[test]
fn a_pictures_unknown_tokens_reach_the_row_in_the_order_the_file_wrote_them() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    let mut shot = node(NODE_ID, &stamp(5, "a3f2"), "");
    shot.body = notes_sync::document::NodeBody::Image(notes_sync::document::ImageReference {
        original_name: "shot.png".to_owned(),
        path: "assets/shot-9f3a1c8e2044.png".to_owned(),
        display_width: 320,
        pixel_width: 10,
        pixel_height: 10,
        byte_size: 4,
    });
    // One of each: a token about the node and a token about the picture, which in
    // the old format arrived through two different comments.
    shot.unknown_tokens = vec![
        "nodeside:".to_owned(),
        "one".to_owned(),
        "pictureside:".to_owned(),
        "two".to_owned(),
    ];

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(vec![shot], &stamp(5, "a3f2"))),
        &input(),
        None,
    )
    .expect("merge");

    let extras: String = transaction
        .query_row(
            "SELECT sync_extras FROM notes_nodes WHERE id = ?1",
            [NODE_ID],
            |row| row.get(0),
        )
        .expect("extras");

    assert_eq!(
        extras, "nodeside: one pictureside: two",
        "the string the merge hashes has to be the tokens in file order, once"
    );
}

/// The stamps only ever call a device by four hex characters. A file that says
/// what those characters belong to is the one place a name comes from, so a
/// merge keeps what it read — the settings screen has no other way to name the
/// device that overwrote a note.
#[test]
fn a_merge_learns_the_writing_devices_name() {
    let mut connection = database();
    let named = |name: &str| PageDocument {
        writer: Some(notes_sync::document::Writer {
            device_id: "a3f2".to_owned(),
            device_name: name.to_owned(),
        }),
        ..page(
            vec![node(NODE_ID, &stamp(5, "a3f2"), "Ship it")],
            &stamp(5, "a3f2"),
        )
    };

    let transaction = connection.transaction().expect("begin");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(named("Studio")),
        &input(),
        None,
    )
    .expect("merge");
    assert_eq!(
        device_names(&transaction),
        vec![("a3f2".to_owned(), "Studio".to_owned())]
    );

    // A rename reaches every other device the same way every other fact does:
    // in the next file that device writes. What was learned before is replaced,
    // not kept beside it.
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(named("Studio 2")),
        &input(),
        None,
    )
    .expect("merge");
    assert_eq!(
        device_names(&transaction),
        vec![("a3f2".to_owned(), "Studio 2".to_owned())]
    );
}

/// A file that names nobody leaves what is known alone. Otherwise a device
/// running an older build, or a hand-written file, would erase the name every
/// other file established.
#[test]
fn a_file_that_names_nobody_leaves_the_names_alone() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    transaction
        .execute(
            "INSERT INTO sync_devices(device_id, name) VALUES ('a3f2', 'Studio')",
            [],
        )
        .expect("seed");

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(5, "a3f2"), "Ship it")],
            &stamp(5, "a3f2"),
        )),
        &input(),
        None,
    )
    .expect("merge");

    assert_eq!(
        device_names(&transaction),
        vec![("a3f2".to_owned(), "Studio".to_owned())]
    );
}

/// The screen shows both versions, so the record has to hold both. What won is
/// kept here rather than read off the row when somebody looks: the row moves on
/// with the next edit, and then it is no longer what won this conflict.
#[test]
fn a_conflict_records_the_text_that_won_as_well_as_the_one_that_lost() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(NODE_ID, &stamp(5, "a3f2"), "Next sprint")],
            &stamp(5, "a3f2"),
        )),
        &input(),
        None,
    )
    .expect("seed");

    // A stamp from a broken clock: the file is written, and the row it replaced
    // is the loss worth keeping.
    let far = Hlc::new(FAR_FUTURE_MILLIS, 0, "a3f2")
        .expect("far")
        .encode();
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(vec![node(NODE_ID, &far, "This week")], &far)),
        &input(),
        None,
    )
    .expect("drift");

    assert_eq!(
        sides(&transaction, NODE_ID),
        ("This week".to_owned(), "Next sprint".to_owned())
    );

    // And the other way round: a file older than the row loses, so the winner
    // is the row this merge left alone.
    let other = "Nd0000000002";
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(other, &stamp(9, "a3f2"), "Mine")],
            &stamp(9, "a3f2"),
        )),
        &input(),
        None,
    )
    .expect("seed");
    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(page(
            vec![node(other, &stamp(5, "a3f2"), "Theirs, older")],
            &stamp(5, "a3f2"),
        )),
        &input(),
        None,
    )
    .expect("older");

    assert_eq!(
        sides(&transaction, other),
        ("Mine".to_owned(), "Theirs, older".to_owned())
    );
}

/// Ids are four hex characters, so two devices can land on the same one. A file
/// claiming this device's id must not be able to rename it: the name would then
/// go out in every file this device writes from then on.
#[test]
fn a_file_cannot_rename_this_device() {
    let mut connection = database();
    let transaction = connection.transaction().expect("begin");
    transaction
        .execute(
            "INSERT INTO sync_devices(device_id, name) VALUES (?1, 'MacBook Pro')",
            [DEVICE],
        )
        .expect("our own name");

    merge_document(
        &transaction,
        &clock(),
        &notes_sync::document::VaultFile::Page(PageDocument {
            writer: Some(notes_sync::document::Writer {
                device_id: DEVICE.to_owned(),
                device_name: "Somebody else's laptop".to_owned(),
            }),
            ..page(
                vec![node(NODE_ID, &stamp(5, "a3f2"), "Ship it")],
                &stamp(5, "a3f2"),
            )
        }),
        &input(),
        None,
    )
    .expect("merge");

    assert_eq!(
        device_names(&transaction),
        vec![(DEVICE.to_owned(), "MacBook Pro".to_owned())]
    );
}
