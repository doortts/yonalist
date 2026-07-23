use super::prune_expired_purged_tombstones_at;
use crate::notes::connection::{
    acquire_notes_connection, evict_notes_connection, lock_notes_connection,
};
use crate::notes::hlc::Hlc;
use crate::notes::repository::{empty_trash, restore_node, soft_delete_node, update_node};
use crate::notes::sync::bootstrap::{flush_pending, reconcile_startup};
use crate::notes::sync::exporter::TRASH_TOPIC_ID;
use crate::notes::sync::topic_file::{
    render_topic_doc, render_trash_doc, PurgedTombstone, TopicAttachment, TopicContent, TopicDoc,
    TopicNode, TopicRoot, TrashDoc,
};
use crate::notes::types::UpdateNodeInput;
use rusqlite::params;
use std::fs;
use std::time::{Duration, Instant};

const NODE_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOPIC_P: &str = "11111111-1111-4111-8111-111111111111";
const TOPIC_Q: &str = "33333333-3333-4333-8333-333333333333";
const NODE_X: &str = "22222222-2222-4222-8222-222222222222";
const RETENTION_MILLIS: u64 = 90 * 24 * 60 * 60 * 1_000;

fn vault_path(vault: &tempfile::TempDir) -> String {
    vault.path().to_str().expect("UTF-8 vault path").to_string()
}

fn hlc_at(millis: u64) -> String {
    Hlc {
        millis,
        counter: 0,
        device: "a1b2".to_string(),
    }
    .encode()
    .expect("encode HLC")
}

fn text_node(id: &str, title: &str, hlc: &str) -> TopicNode {
    TopicNode {
        marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
        id: Some(id.to_string()),
        hlc: hlc.to_string(),
        starred: false,
        completed: false,
        content: TopicContent::Text(title.to_string()),
        note: String::new(),
        markdown_image_width: None,
        from: None,
        sibling_ordinal: 1,
        sort_key: 1024,
        children: Vec::new(),
    }
}

fn topic_document_with(id: &str, title: &str, root_hlc: &str, nodes: Vec<TopicNode>) -> TopicDoc {
    TopicDoc {
        id: id.to_string(),
        sort_key: 1024,
        max_hlc: nodes
            .iter()
            .map(|node| node.hlc.as_str())
            .chain(std::iter::once(root_hlc))
            .max()
            .unwrap_or_default()
            .to_string(),
        root: TopicRoot {
            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            title: title.to_string(),
            note: String::new(),
            markdown_image_width: None,
            hlc: root_hlc.to_string(),
            starred: false,
            completed_at: None,
            archived_at: None,
        },
        nodes,
    }
}

fn topic_document(title: &str, root_hlc: &str, child_hlc: &str) -> TopicDoc {
    topic_document_with(
        TOPIC_P,
        title,
        root_hlc,
        vec![text_node(NODE_X, "Child", child_hlc)],
    )
}

fn write_topic(vault: &tempfile::TempDir, file_name: &str, document: &TopicDoc) {
    fs::write(
        vault.path().join(file_name),
        render_topic_doc(document).expect("render topic"),
    )
    .expect("write topic");
}

fn write_trash(vault: &tempfile::TempDir, document: &TrashDoc) {
    fs::write(
        vault.path().join("trash.md"),
        render_trash_doc(document).expect("render trash"),
    )
    .expect("write trash");
}

fn copy_markdown_files(from: &tempfile::TempDir, to: &tempfile::TempDir) {
    let mut files = fs::read_dir(from.path())
        .expect("read source vault")
        .map(|entry| entry.expect("read source entry").path())
        .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("md"))
        .collect::<Vec<_>>();
    files.sort();
    for source in files {
        let destination = to.path().join(source.file_name().expect("source filename"));
        fs::copy(source, destination).expect("copy sync source");
    }
}

fn node_state(vault_path: &str, node_id: &str) -> Option<(Option<String>, String, bool)> {
    let shared = acquire_notes_connection(vault_path).expect("open notes database");
    let connection = lock_notes_connection(&shared).expect("lock notes database");
    let state = connection
        .query_row(
            "SELECT parent_id, title, deleted_at IS NOT NULL FROM notes_nodes WHERE id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();
    drop(connection);
    drop(shared);
    state
}

fn root_count(vault_path: &str) -> i64 {
    let shared = acquire_notes_connection(vault_path).expect("open notes database");
    let connection = lock_notes_connection(&shared).expect("lock notes database");
    let count = connection
        .query_row(
            "SELECT COUNT(*) FROM notes_nodes WHERE parent_id IS NULL AND deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .expect("count live topics");
    drop(connection);
    drop(shared);
    count
}

fn cleanup_vaults(paths: &[&str]) {
    for path in paths {
        evict_notes_connection(path);
    }
}

fn trash_document(nodes: Vec<TopicNode>, purged: Vec<PurgedTombstone>) -> TrashDoc {
    let max_hlc = nodes
        .iter()
        .map(|node| node.hlc.as_str())
        .chain(purged.iter().map(|tombstone| tombstone.hlc.as_str()))
        .max()
        .unwrap_or_default()
        .to_string();
    TrashDoc {
        max_hlc,
        purged,
        nodes,
    }
}

fn trashed_node(title: &str, hlc: &str) -> TopicNode {
    let mut node = text_node(NODE_X, title, hlc);
    node.from = Some((TOPIC_P.to_string(), 1024));
    node
}

#[test]
fn ninety_day_purge_evidence_pruning_is_derived_from_hlc_time() {
    let vault = tempfile::tempdir().expect("create vault");
    let vault_path = vault_path(&vault);
    let shared = acquire_notes_connection(&vault_path).expect("open notes database");
    let connection = lock_notes_connection(&shared).expect("lock notes database");
    let now = RETENTION_MILLIS + 10_000;
    connection
        .execute(
            "INSERT INTO sync_purged_tombstones(node_id, purged_hlc) VALUES (?1, ?2)",
            params![NODE_ID, hlc_at(9_999)],
        )
        .expect("seed expired evidence");
    connection
        .execute(
            "INSERT INTO sync_purged_tombstones(node_id, purged_hlc) VALUES (?1, ?2)",
            params!["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", hlc_at(10_000)],
        )
        .expect("seed retained evidence");

    let removed =
        prune_expired_purged_tombstones_at(&connection, now).expect("prune expired tombstones");

    assert_eq!(removed, 1);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM sync_purged_tombstones", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count retained tombstones"),
        1
    );
    assert!(
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_dirty_nodes WHERE node_id = ?1)",
                [TRASH_TOPIC_ID],
                |row| row.get::<_, bool>(0),
            )
            .expect("inspect trash rewrite marker"),
        "pruning must export the deletion of expired evidence instead of allowing trash.md to re-add it"
    );
    drop(connection);
    drop(shared);
    evict_notes_connection(&vault_path);
}

#[test]
fn startup_pruning_does_not_reimport_expired_evidence_from_existing_trash_file() {
    let vault = tempfile::tempdir().expect("create vault");
    let vault_path = vault_path(&vault);
    let expired_hlc = hlc_at(1);
    let shared = acquire_notes_connection(&vault_path).expect("open notes database");
    let connection = lock_notes_connection(&shared).expect("lock notes database");
    connection
        .execute(
            "INSERT INTO sync_purged_tombstones(node_id, purged_hlc) VALUES (?1, ?2)",
            params![NODE_X, expired_hlc],
        )
        .expect("seed expired purge evidence");
    drop(connection);
    drop(shared);
    write_trash(
        &vault,
        &trash_document(
            vec![trashed_node("Delayed old trash copy", &hlc_at(0))],
            vec![PurgedTombstone {
                id: NODE_X.to_string(),
                hlc: hlc_at(1),
            }],
        ),
    );

    reconcile_startup(&vault_path).expect("prune and reconcile stale trash file");

    let shared = acquire_notes_connection(&vault_path).expect("reopen notes database");
    let connection = lock_notes_connection(&shared).expect("relock notes database");
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM sync_purged_tombstones", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count purge evidence after startup"),
        0,
        "startup must not re-accept the expired tombstone it just pruned"
    );
    drop(connection);
    drop(shared);
    assert_eq!(
        node_state(&vault_path, NODE_X),
        Some((
            Some(TOPIC_P.to_string()),
            "Delayed old trash copy".to_string(),
            true
        )),
        "the expired purge must no longer block the delayed old trash node"
    );
    evict_notes_connection(&vault_path);
}

#[test]
fn strict_prefix_truncation_is_quarantined_then_restored_from_verified_canonical_bytes() {
    let vault = tempfile::tempdir().expect("create vault");
    let vault_path = vault_path(&vault);
    let source = vault.path().join("stable.11111111.md");
    let document = topic_document_with(
        TOPIC_P,
        "Stable",
        &hlc_at(1),
        vec![TopicNode {
            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            id: Some(NODE_X.to_string()),
            hlc: hlc_at(2),
            starred: false,
            completed: false,
            content: TopicContent::Image {
                before: String::new(),
                attachment: TopicAttachment {
                    content_hash: "a".repeat(64),
                    extension: "png".to_string(),
                    encoded_original_name: "image.png".to_string(),
                    display_width: Some(320),
                },
                after: String::new(),
            },
            note: String::new(),
            markdown_image_width: None,
            from: None,
            sibling_ordinal: 1,
            sort_key: 1024,
            children: Vec::new(),
        }],
    );
    let canonical = render_topic_doc(&document).expect("render canonical topic");
    fs::write(&source, &canonical).expect("write canonical topic");
    reconcile_startup(&vault_path).expect("bootstrap canonical topic");

    fs::write(&source, &canonical[..canonical.len() - 5]).expect("truncate topic tail");
    let report = reconcile_startup(&vault_path).expect("reconcile truncated topic");

    assert!(
        report
            .errors
            .iter()
            .any(|error| error.contains("truncated")),
        "the user-visible report must preserve the corruption notification"
    );
    assert_eq!(fs::read(&source).expect("read recovered topic"), canonical);
    let shared = acquire_notes_connection(&vault_path).expect("open recovered database");
    let connection = lock_notes_connection(&shared).expect("lock recovered database");
    assert_eq!(
        connection
            .query_row(
                "SELECT quarantined FROM sync_topics WHERE topic_id = ?1",
                [&document.id],
                |row| row.get::<_, i64>(0),
            )
            .expect("read quarantine state"),
        1
    );
    drop(connection);
    drop(shared);

    let retry = reconcile_startup(&vault_path).expect("acknowledge recovered canonical file");
    assert!(retry.status_changed);
    let shared = acquire_notes_connection(&vault_path).expect("open acknowledged database");
    let connection = lock_notes_connection(&shared).expect("lock acknowledged database");
    assert_eq!(
        connection
            .query_row(
                "SELECT quarantined FROM sync_topics WHERE topic_id = ?1",
                [&document.id],
                |row| row.get::<_, i64>(0),
            )
            .expect("read acknowledged quarantine state"),
        0
    );
    drop(connection);
    drop(shared);
    evict_notes_connection(&vault_path);
}

#[test]
fn arbitrary_malformed_file_stays_quarantined_without_overwriting_user_bytes() {
    let vault = tempfile::tempdir().expect("create vault");
    let vault_path = vault_path(&vault);
    let source = vault.path().join("stable.11111111.md");
    let document = topic_document("Stable", &hlc_at(1), &hlc_at(2));
    fs::write(
        &source,
        render_topic_doc(&document).expect("render canonical topic"),
    )
    .expect("write canonical topic");
    reconcile_startup(&vault_path).expect("bootstrap canonical topic");

    let corruption = b"this is unrelated malformed user content";
    fs::write(&source, corruption).expect("write malformed topic");
    let report = reconcile_startup(&vault_path).expect("reconcile malformed topic");

    assert!(report
        .errors
        .iter()
        .any(|error| error.contains("quarantined")));
    assert_eq!(fs::read(&source).expect("read malformed topic"), corruption);
    let shared = acquire_notes_connection(&vault_path).expect("open quarantined database");
    let connection = lock_notes_connection(&shared).expect("lock quarantined database");
    assert_eq!(
        connection
            .query_row(
                "SELECT quarantined FROM sync_topics WHERE topic_id = ?1",
                [document.id],
                |row| row.get::<_, i64>(0),
            )
            .expect("read quarantine state"),
        1
    );
    drop(connection);
    drop(shared);
    evict_notes_connection(&vault_path);
}

#[test]
fn device_a_export_propagates_to_device_b() {
    let vault_a = tempfile::tempdir().expect("create device A vault");
    let vault_b = tempfile::tempdir().expect("create device B vault");
    let path_a = vault_path(&vault_a);
    let path_b = vault_path(&vault_b);
    write_topic(
        &vault_a,
        "project.11111111.md",
        &topic_document("Project", &hlc_at(1), &hlc_at(2)),
    );

    reconcile_startup(&path_a).expect("bootstrap device A");
    let shared = acquire_notes_connection(&path_a).expect("open device A database");
    let mut connection = lock_notes_connection(&shared).expect("lock device A database");
    update_node(
        &mut connection,
        UpdateNodeInput {
            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            id: NODE_X.to_string(),
            title: "Edited on device A".to_string(),
            note: String::new(),
            image_offset_utf16: 0,
            markdown_image_width: None,
        },
    )
    .expect("edit node on device A");
    flush_pending(&mut connection, vault_a.path()).expect("export device A edit");
    drop(connection);
    drop(shared);
    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("merge device A file on device B");

    assert_eq!(
        node_state(&path_b, NODE_X),
        Some((
            Some(TOPIC_P.to_string()),
            "Edited on device A".to_string(),
            false
        ))
    );
    cleanup_vaults(&[&path_a, &path_b]);
}

#[test]
fn concurrent_same_node_edits_converge_to_hlc_winner_and_record_loser() {
    let vault_a = tempfile::tempdir().expect("create device A vault");
    let vault_b = tempfile::tempdir().expect("create device B vault");
    let path_a = vault_path(&vault_a);
    let path_b = vault_path(&vault_b);
    write_topic(
        &vault_a,
        "project.11111111.md",
        &topic_document("Base", &hlc_at(1), &hlc_at(2)),
    );
    reconcile_startup(&path_a).expect("bootstrap device A");
    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("bootstrap device B");

    write_topic(
        &vault_a,
        "project.11111111.md",
        &topic_document("A title", &hlc_at(3), &hlc_at(2)),
    );
    reconcile_startup(&path_a).expect("apply device A edit");
    write_topic(
        &vault_b,
        "project.11111111.md",
        &topic_document("B title", &hlc_at(4), &hlc_at(2)),
    );
    reconcile_startup(&path_b).expect("apply device B edit");

    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("merge lower A edit into device B");
    copy_markdown_files(&vault_b, &vault_a);
    reconcile_startup(&path_a).expect("merge winning B edit into device A");

    for path in [&path_a, &path_b] {
        let shared = acquire_notes_connection(path).expect("open converged database");
        let connection = lock_notes_connection(&shared).expect("lock converged database");
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [TOPIC_P],
                    |row| row.get::<_, String>(0),
                )
                .expect("read winner title"),
            "B title"
        );
    }
    let shared = acquire_notes_connection(&path_b).expect("open conflict database");
    let connection = lock_notes_connection(&shared).expect("lock conflict database");
    assert!(
        connection
            .query_row("SELECT COUNT(*) FROM sync_conflict_log", [], |row| row
                .get::<_, i64>(0))
            .expect("count conflict log")
            >= 1
    );
    drop(connection);
    drop(shared);
    cleanup_vaults(&[&path_a, &path_b]);
}

#[test]
fn disjoint_device_topics_merge_without_conflicts() {
    let vault_a = tempfile::tempdir().expect("create device A vault");
    let vault_b = tempfile::tempdir().expect("create device B vault");
    let path_a = vault_path(&vault_a);
    let path_b = vault_path(&vault_b);
    write_topic(
        &vault_a,
        "p.11111111.md",
        &topic_document_with(TOPIC_P, "P", &hlc_at(1), Vec::new()),
    );
    write_topic(
        &vault_b,
        "q.33333333.md",
        &topic_document_with(TOPIC_Q, "Q", &hlc_at(2), Vec::new()),
    );
    reconcile_startup(&path_a).expect("bootstrap device A");
    reconcile_startup(&path_b).expect("bootstrap device B");

    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("merge A topic onto B");
    copy_markdown_files(&vault_b, &vault_a);
    reconcile_startup(&path_a).expect("merge B topic onto A");

    assert_eq!(root_count(&path_a), 2);
    assert_eq!(root_count(&path_b), 2);
    for path in [&path_a, &path_b] {
        let shared = acquire_notes_connection(path).expect("open conflict-free database");
        let connection = lock_notes_connection(&shared).expect("lock conflict-free database");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_conflict_log", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count disjoint-edit conflicts"),
            0
        );
    }
    cleanup_vaults(&[&path_a, &path_b]);
}

#[test]
fn concurrent_move_and_edit_use_whole_node_hlc_winner_without_duplication() {
    let vault_a = tempfile::tempdir().expect("create device A vault");
    let vault_b = tempfile::tempdir().expect("create device B vault");
    let path_a = vault_path(&vault_a);
    let path_b = vault_path(&vault_b);
    write_topic(
        &vault_a,
        "p.11111111.md",
        &topic_document_with(
            TOPIC_P,
            "P",
            &hlc_at(1),
            vec![text_node(NODE_X, "Base", &hlc_at(2))],
        ),
    );
    write_topic(
        &vault_a,
        "q.33333333.md",
        &topic_document_with(TOPIC_Q, "Q", &hlc_at(1), Vec::new()),
    );
    reconcile_startup(&path_a).expect("bootstrap device A");
    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("bootstrap device B");

    write_topic(
        &vault_a,
        "p.11111111.md",
        &topic_document_with(TOPIC_P, "P", &hlc_at(1), Vec::new()),
    );
    write_topic(
        &vault_a,
        "q.33333333.md",
        &topic_document_with(
            TOPIC_Q,
            "Q",
            &hlc_at(1),
            vec![text_node(NODE_X, "Moved", &hlc_at(5))],
        ),
    );
    reconcile_startup(&path_a).expect("apply winning device A move");
    write_topic(
        &vault_b,
        "p.11111111.md",
        &topic_document_with(
            TOPIC_P,
            "P",
            &hlc_at(1),
            vec![text_node(NODE_X, "Edited", &hlc_at(4))],
        ),
    );
    reconcile_startup(&path_b).expect("apply losing device B edit");

    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("merge move on device B");
    copy_markdown_files(&vault_b, &vault_a);
    reconcile_startup(&path_a).expect("merge converged files on device A");

    assert_eq!(
        node_state(&path_a, NODE_X),
        Some((Some(TOPIC_Q.to_string()), "Moved".to_string(), false))
    );
    assert_eq!(node_state(&path_b, NODE_X), node_state(&path_a, NODE_X));
    cleanup_vaults(&[&path_a, &path_b]);
}

#[test]
fn trash_and_restore_propagate_between_devices() {
    let vault_a = tempfile::tempdir().expect("create device A vault");
    let vault_b = tempfile::tempdir().expect("create device B vault");
    let path_a = vault_path(&vault_a);
    let path_b = vault_path(&vault_b);
    write_topic(
        &vault_a,
        "project.11111111.md",
        &topic_document("Project", &hlc_at(1), &hlc_at(2)),
    );
    reconcile_startup(&path_a).expect("bootstrap device A");
    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("bootstrap device B");

    let shared = acquire_notes_connection(&path_a).expect("open device A database");
    let mut connection = lock_notes_connection(&shared).expect("lock device A database");
    soft_delete_node(&mut connection, NODE_X).expect("trash node on device A");
    flush_pending(&mut connection, vault_a.path()).expect("export device A trash");
    drop(connection);
    drop(shared);
    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("merge trash on device B");
    assert_eq!(
        node_state(&path_b, NODE_X),
        Some((Some(TOPIC_P.to_string()), "Child".to_string(), true))
    );

    let shared = acquire_notes_connection(&path_b).expect("open device B database");
    let mut connection = lock_notes_connection(&shared).expect("lock device B database");
    restore_node(&mut connection, NODE_X).expect("restore node on device B");
    update_node(
        &mut connection,
        UpdateNodeInput {
            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            id: NODE_X.to_string(),
            title: "Restored".to_string(),
            note: String::new(),
            image_offset_utf16: 0,
            markdown_image_width: None,
        },
    )
    .expect("rename restored node on device B");
    flush_pending(&mut connection, vault_b.path()).expect("export device B restore");
    drop(connection);
    drop(shared);
    copy_markdown_files(&vault_b, &vault_a);
    reconcile_startup(&path_a).expect("merge restore on device A");

    let expected = Some((Some(TOPIC_P.to_string()), "Restored".to_string(), false));
    assert_eq!(node_state(&path_b, NODE_X), expected);
    assert_eq!(node_state(&path_a, NODE_X), expected);
    cleanup_vaults(&[&path_a, &path_b]);
}

#[test]
fn purge_evidence_propagates_then_an_expired_tombstone_allows_old_trash_to_revive() {
    let vault_a = tempfile::tempdir().expect("create device A vault");
    let vault_b = tempfile::tempdir().expect("create device B vault");
    let path_a = vault_path(&vault_a);
    let path_b = vault_path(&vault_b);
    write_topic(
        &vault_a,
        "project.11111111.md",
        &topic_document("Project", &hlc_at(1), &hlc_at(2)),
    );
    reconcile_startup(&path_a).expect("bootstrap device A");
    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("bootstrap device B");

    let shared = acquire_notes_connection(&path_a).expect("open device A database");
    let mut connection = lock_notes_connection(&shared).expect("lock device A database");
    soft_delete_node(&mut connection, NODE_X).expect("trash node before purge");
    empty_trash(&mut connection).expect("purge node on device A");
    let purge_hlc = connection
        .query_row(
            "SELECT purged_hlc FROM sync_purged_tombstones WHERE node_id = ?1",
            [NODE_X],
            |row| row.get::<_, String>(0),
        )
        .expect("read locally generated purge HLC");
    flush_pending(&mut connection, vault_a.path()).expect("export device A purge");
    drop(connection);
    drop(shared);
    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("merge purge on device B");
    assert_eq!(node_state(&path_b, NODE_X), None);

    let shared = acquire_notes_connection(&path_b).expect("open device B database");
    let connection = lock_notes_connection(&shared).expect("lock device B database");
    let purge_millis = Hlc::decode(&purge_hlc).expect("decode purge HLC").millis;
    assert_eq!(
        prune_expired_purged_tombstones_at(&connection, purge_millis + RETENTION_MILLIS + 1)
            .expect("expire purge evidence"),
        1
    );
    drop(connection);
    drop(shared);

    write_trash(
        &vault_b,
        &trash_document(vec![trashed_node("Old trash copy", &hlc_at(2))], Vec::new()),
    );
    reconcile_startup(&path_b).expect("merge old trash after evidence expiry");
    assert_eq!(
        node_state(&path_b, NODE_X),
        Some((
            Some(TOPIC_P.to_string()),
            "Old trash copy".to_string(),
            true
        ))
    );
    cleanup_vaults(&[&path_a, &path_b]);
}

#[test]
fn hand_edited_unstamped_bullet_receives_identity_and_is_written_back() {
    let vault = tempfile::tempdir().expect("create vault");
    let vault_path = vault_path(&vault);
    let source = vault.path().join("handwritten.11111111.md");
    let document = topic_document("Handwritten", &hlc_at(1), &hlc_at(2));
    let canonical = String::from_utf8(render_topic_doc(&document).expect("render canonical topic"))
        .expect("canonical UTF-8");
    let unstamped = canonical.replace(&format!(" <!-- yid: {NODE_X} t: {} -->", hlc_at(2)), "");
    assert_ne!(
        unstamped, canonical,
        "fixture must remove the canonical identity"
    );
    fs::write(&source, unstamped).expect("write unstamped topic");

    reconcile_startup(&vault_path).expect("merge unstamped external bullet");

    let rewritten = fs::read_to_string(&source).expect("read write-back topic");
    assert!(rewritten.contains("yid:"));
    assert!(rewritten.contains(" t: "));
    let shared = acquire_notes_connection(&vault_path).expect("open write-back database");
    let connection = lock_notes_connection(&shared).expect("lock write-back database");
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE parent_id = ?1",
                [TOPIC_P],
                |row| row.get::<_, i64>(0),
            )
            .expect("count assigned external bullet"),
        1
    );
    drop(connection);
    drop(shared);
    evict_notes_connection(&vault_path);
}

fn performance_node_id(topic_index: usize, node_index: usize) -> String {
    format!(
        "{:08x}-0000-4000-8000-{:012x}",
        0x1000_0000_u64 + topic_index as u64,
        node_index as u64 + 1
    )
}

fn performance_topic_id(topic_index: usize) -> String {
    format!(
        "{:08x}-0000-4000-8000-{:012x}",
        0x2000_0000_u64 + topic_index as u64,
        topic_index as u64 + 1
    )
}

fn performance_topic(topic_index: usize, total_nodes: usize, revision: u64) -> TopicDoc {
    assert!(total_nodes >= 1);
    let timestamp = hlc_at(revision);
    let nodes = (0..total_nodes - 1)
        .map(|node_index| TopicNode {
            marker_kind: crate::notes::types::NoteMarkerKind::Bullet,
            id: Some(performance_node_id(topic_index, node_index)),
            hlc: timestamp.clone(),
            starred: false,
            completed: false,
            content: TopicContent::Text(format!(
                "Topic {topic_index} node {node_index} revision {revision}"
            )),
            note: String::new(),
            markdown_image_width: None,
            from: None,
            sibling_ordinal: node_index + 1,
            sort_key: i64::try_from((node_index + 1) * 1024).expect("performance sort key"),
            children: Vec::new(),
        })
        .collect::<Vec<_>>();
    topic_document_with(
        &performance_topic_id(topic_index),
        &format!("Performance topic {topic_index} revision {revision}"),
        &timestamp,
        nodes,
    )
}

fn write_and_sync_performance_topics(
    vault: &tempfile::TempDir,
    topic_count: usize,
    nodes_per_topic: usize,
    revision: u64,
) {
    for topic_index in 0..topic_count {
        let document = performance_topic(topic_index, nodes_per_topic, revision);
        let path = vault.path().join(format!("perf-{topic_index}.md"));
        fs::write(
            &path,
            render_topic_doc(&document).expect("render performance topic"),
        )
        .expect("write performance topic");
        fs::File::open(path)
            .expect("open performance topic for sync")
            .sync_all()
            .expect("sync performance topic");
    }
}

fn measure_bootstrap(total_nodes: usize) -> Duration {
    const NODES_PER_TOPIC: usize = 2_000;
    assert_eq!(total_nodes % NODES_PER_TOPIC, 0);
    let vault = tempfile::tempdir().expect("create performance bootstrap vault");
    let vault_path = vault_path(&vault);
    write_and_sync_performance_topics(&vault, total_nodes / NODES_PER_TOPIC, NODES_PER_TOPIC, 100);
    let started = Instant::now();
    let report = reconcile_startup(&vault_path).expect("run performance bootstrap");
    let elapsed = started.elapsed();
    assert_eq!(report.merged_files, total_nodes / NODES_PER_TOPIC);
    cleanup_vaults(&[&vault_path]);
    elapsed
}

fn measure_single_topic_merge(total_nodes: usize) -> Duration {
    let vault = tempfile::tempdir().expect("create performance merge vault");
    let vault_path = vault_path(&vault);
    write_and_sync_performance_topics(&vault, 1, total_nodes, 200);
    reconcile_startup(&vault_path).expect("bootstrap performance merge vault");
    write_and_sync_performance_topics(&vault, 1, total_nodes, 300);
    let started = Instant::now();
    let report = reconcile_startup(&vault_path).expect("run performance topic merge");
    let elapsed = started.elapsed();
    assert_eq!(report.merged_files, 1);
    cleanup_vaults(&[&vault_path]);
    elapsed
}

#[test]
#[ignore = "release-only Phase 6 personal-laptop performance contract"]
fn notes_file_sync_performance_contract() {
    let bootstrap_warmup = measure_bootstrap(2_000);
    let bootstrap_10k = measure_bootstrap(10_000);
    let bootstrap_20k = measure_bootstrap(20_000);
    let merge_warmup = measure_single_topic_merge(1_000);
    let merge_1k = measure_single_topic_merge(1_000);

    eprintln!(
        "notes-file-sync performance: bootstrap warmup={bootstrap_warmup:?}, 10k={bootstrap_10k:?}, 20k diagnostic={bootstrap_20k:?}; merge warmup={merge_warmup:?}, 1k={merge_1k:?}, 100ms diagnostic={} ",
        if merge_1k < Duration::from_millis(100) {
            "pass"
        } else {
            "miss"
        }
    );

    assert!(
        bootstrap_10k < Duration::from_secs(15),
        "10k-node bootstrap took {bootstrap_10k:?}; personal-laptop gate is 15s"
    );
    assert!(
        merge_1k < Duration::from_secs(1),
        "1k-node single-topic merge took {merge_1k:?}; personal-laptop gate is 1s"
    );
}

// A2.5: once live trash passes the 20k-node parser cap, the exporter peels the
// oldest deletions into write-once `trash-archive-<seq>.md` segments so trash.md
// stays renderable, and re-merging a segment restores its archived deletions.
#[test]
#[ignore = "20k-node emission is a release-only large-N contract"]
fn trash_overflow_archives_into_write_once_segments_and_round_trips() {
    use crate::notes::sync::exporter::trash_archive_seq;

    const OVERFLOW: usize = 20_001; // one past MAX_NOTES_EXPORT_NODES

    let vault_a = tempfile::tempdir().expect("create device A vault");
    let vault_b = tempfile::tempdir().expect("create device B vault");
    let path_a = vault_path(&vault_a);
    let path_b = vault_path(&vault_b);

    {
        let shared = acquire_notes_connection(&path_a).expect("open device A database");
        let mut connection = lock_notes_connection(&shared).expect("lock device A database");
        connection
            .execute("DELETE FROM notes_nodes", [])
            .expect("clear onboarding nodes");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear onboarding dirty rows");
        connection
            .execute_batch("BEGIN")
            .expect("begin bulk insert");
        for index in 1..=OVERFLOW {
            let id = format!("{index:08x}-0000-4000-8000-{index:012x}");
            let hlc = format!("{index:09}-00-a3f2");
            connection
                .execute(
                    "INSERT INTO notes_nodes(\
                       id, parent_id, sort_key, title, created_at, updated_at, deleted_at, hlc\
                     ) VALUES (?1, NULL, ?2, ?3, '2026-07-21T00:00:00.000Z', \
                               '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', ?4)",
                    params![id, (index as i64) * 1024, format!("Deleted {index}"), hlc],
                )
                .expect("insert trash node");
        }
        connection
            .execute_batch("COMMIT")
            .expect("commit bulk insert");
        connection
            .execute(
                "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1)",
                [TRASH_TOPIC_ID],
            )
            .expect("mark trash dirty");

        flush_pending(&mut connection, vault_a.path()).expect("export trash overflow");

        // trash.md renders (was not wedged on the cap) and stays un-quarantined.
        assert!(
            vault_a.path().join("trash.md").is_file(),
            "trash.md written"
        );
        let trash_quarantined: i64 = connection
            .query_row(
                "SELECT COALESCE(quarantined, 0) FROM sync_topics WHERE topic_id = ?1",
                [TRASH_TOPIC_ID],
                |row| row.get(0),
            )
            .unwrap_or(0);
        assert_eq!(trash_quarantined, 0, "trash export was not quarantined");

        // Exactly the single overflow node was archived into one segment.
        let archived: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_trash_archive", [], |row| {
                row.get(0)
            })
            .expect("count archived nodes");
        assert_eq!(archived, 1, "one node archived past the 20k cap");
        let live: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL \
                   AND id NOT IN (SELECT node_id FROM sync_trash_archive)",
                [],
                |row| row.get(0),
            )
            .expect("count live trash");
        assert_eq!(
            live as usize,
            OVERFLOW - 1,
            "trash.md holds the cap exactly"
        );
    }

    // Exactly one write-once segment exists on disk.
    let segments = std::fs::read_dir(vault_a.path())
        .expect("read vault A")
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| trash_archive_seq(name).is_some())
        .collect::<Vec<_>>();
    assert_eq!(
        segments,
        vec!["trash-archive-1.md".to_string()],
        "one segment emitted"
    );

    // Round-trip: re-merging only the write-once segment on a fresh device
    // restores its archived deletion as trash (the 20k trash.md re-merge is
    // ordinary LWW, already covered elsewhere and left out to keep this cheap).
    std::fs::copy(
        vault_a.path().join("trash-archive-1.md"),
        vault_b.path().join("trash-archive-1.md"),
    )
    .expect("copy segment to device B");
    reconcile_startup(&path_b).expect("merge archive segment on device B");
    let shared_b = acquire_notes_connection(&path_b).expect("open device B database");
    let connection_b = lock_notes_connection(&shared_b).expect("lock device B database");
    let deleted_b: i64 = connection_b
        .query_row(
            "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count device B trash");
    assert_eq!(
        deleted_b, 1,
        "segment re-merge round-trips its archived node"
    );
    let archived_b: i64 = connection_b
        .query_row("SELECT COUNT(*) FROM sync_trash_archive", [], |row| {
            row.get(0)
        })
        .expect("count device B archive membership");
    assert_eq!(
        archived_b, 1,
        "device B records the received segment as archived"
    );
    drop(connection_b);
    drop(shared_b);

    cleanup_vaults(&[&path_a, &path_b]);
}

// R12: a topic file deleted while the app was closed is recreated on the next
// startup. A second topic keeps a parseable file present, so the "no topic
// file" full-rebuild branch does not fire — only the missing-file scan can
// recover it (absence != deletion, rule 1).
#[test]
fn a_topic_file_deleted_while_offline_is_recreated_on_startup() {
    let vault = tempfile::tempdir().expect("create vault");
    let path = vault_path(&vault);
    write_topic(
        &vault,
        "project.11111111.md",
        &topic_document("Project", &hlc_at(1), &hlc_at(2)),
    );
    write_topic(
        &vault,
        "other.33333333.md",
        &topic_document_with(TOPIC_Q, "Other", &hlc_at(1), Vec::new()),
    );
    reconcile_startup(&path).expect("bootstrap both topics");
    assert!(vault.path().join("project.11111111.md").is_file());
    assert!(vault.path().join("other.33333333.md").is_file());

    // Offline deletion of ONE topic file; the other stays present.
    std::fs::remove_file(vault.path().join("project.11111111.md")).expect("delete topic file");
    evict_notes_connection(&path);

    reconcile_startup(&path).expect("restart recreates the missing topic file");
    assert!(
        vault.path().join("project.11111111.md").is_file(),
        "the offline-deleted topic file is recreated"
    );
    assert!(vault.path().join("other.33333333.md").is_file());
    cleanup_vaults(&[&path]);
}

// R1a: a node migrated into an archive segment must leave `sync_trash_archive`
// the moment it is restored, so a later re-deletion is exported to trash.md and
// propagates again (permanent membership would silently withhold the deletion —
// absence ≠ deletion, rule 1).
#[test]
fn archived_node_reappears_in_trash_after_restore_and_redelete() {
    let vault_a = tempfile::tempdir().expect("create device A vault");
    let vault_b = tempfile::tempdir().expect("create device B vault");
    let path_a = vault_path(&vault_a);
    let path_b = vault_path(&vault_b);
    write_topic(
        &vault_a,
        "project.11111111.md",
        &topic_document("Project", &hlc_at(1), &hlc_at(2)),
    );
    reconcile_startup(&path_a).expect("bootstrap device A");
    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("bootstrap device B");

    let shared = acquire_notes_connection(&path_a).expect("open device A database");
    let mut connection = lock_notes_connection(&shared).expect("lock device A database");
    // Trash the node, then simulate the trash-overflow migration by registering
    // it as archived directly (the real path only fires above the 20k cap).
    soft_delete_node(&mut connection, NODE_X).expect("trash node");
    connection
        .execute(
            "INSERT INTO sync_trash_archive(node_id, seq) VALUES (?1, 1)",
            [NODE_X],
        )
        .expect("archive node");
    flush_pending(&mut connection, vault_a.path()).expect("export trash without archived node");
    let trash_after_archive =
        fs::read_to_string(vault_a.path().join("trash.md")).unwrap_or_default();
    assert!(
        !trash_after_archive.contains(NODE_X),
        "an archived node stays out of trash.md"
    );

    // Restore un-deletes the node; the R1a trigger drops its archive membership.
    restore_node(&mut connection, NODE_X).expect("restore node");
    let archived_after_restore: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_trash_archive WHERE node_id = ?1",
            [NODE_X],
            |row| row.get(0),
        )
        .expect("count archive membership");
    assert_eq!(
        archived_after_restore, 0,
        "restore clears trash-archive membership"
    );

    // Re-deleting now propagates through trash.md again.
    soft_delete_node(&mut connection, NODE_X).expect("re-trash node");
    flush_pending(&mut connection, vault_a.path()).expect("export re-deletion");
    let trash_after_redelete =
        fs::read_to_string(vault_a.path().join("trash.md")).expect("read trash.md");
    assert!(
        trash_after_redelete.contains(NODE_X),
        "a re-deleted node reappears in trash.md"
    );
    drop(connection);
    drop(shared);

    copy_markdown_files(&vault_a, &vault_b);
    reconcile_startup(&path_b).expect("merge re-deletion on device B");
    assert_eq!(
        node_state(&path_b, NODE_X).map(|(_, _, deleted)| deleted),
        Some(true),
        "the re-deletion propagates to device B"
    );
    cleanup_vaults(&[&path_a, &path_b]);
}

// R1b: a crafted `trash-archive-*.md` that names a live yid whose deletion loses
// the HLC gate must NOT be registered as archived — otherwise its future real
// deletion would be silently withheld from trash.md.
#[test]
fn crafted_archive_segment_cannot_register_a_live_node() {
    let vault = tempfile::tempdir().expect("create vault");
    let path = vault_path(&vault);
    write_topic(
        &vault,
        "project.11111111.md",
        &topic_document("Project", &hlc_at(5), &hlc_at(5)),
    );
    reconcile_startup(&path).expect("bootstrap live node");
    assert_eq!(
        node_state(&path, NODE_X).map(|(_, _, deleted)| deleted),
        Some(false),
        "node starts live"
    );

    // Deletion at an OLDER hlc than the live node loses the LWW gate.
    let segment = trash_document(vec![trashed_node("Child", &hlc_at(2))], Vec::new());
    fs::write(
        vault.path().join("trash-archive-1.md"),
        render_trash_doc(&segment).expect("render crafted segment"),
    )
    .expect("write crafted segment");
    reconcile_startup(&path).expect("merge crafted segment");

    assert_eq!(
        node_state(&path, NODE_X).map(|(_, _, deleted)| deleted),
        Some(false),
        "the live node stays live"
    );
    let shared = acquire_notes_connection(&path).expect("open database");
    let connection = lock_notes_connection(&shared).expect("lock database");
    let archived: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_trash_archive WHERE node_id = ?1",
            [NODE_X],
            |row| row.get(0),
        )
        .expect("count archive membership");
    assert_eq!(
        archived, 0,
        "a crafted live yid is never registered as archived"
    );
    drop(connection);
    drop(shared);
    cleanup_vaults(&[&path]);
}
