use crate::notes::date_index::{LocalTodayProvider, SystemLocalTodayProvider};
use crate::notes::error::NotesError;
use crate::notes::hlc::{self, Hlc};
use crate::notes::repository::rebuild_derived_for_nodes_at;
use crate::notes::sync::topic_file::{
    derive_topic_filename, TopicAttachment, TopicContent, TopicDoc, TopicNode, TrashDoc,
};
use crate::notes::types::{NoteNodeKind, MAX_IMPORT_SUBTREE_DEPTH, MAX_NOTE_ATTACHMENTS_PER_VAULT};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const SYNC_TIMESTAMP_FALLBACK: &str = "1970-01-01T00:00:00.000Z";
const PLACEHOLDER_HLC: &str = "000000000-00-0000";
const ATTACHMENT_ID_DOMAIN: &[u8] = b"yonalist-topic-attachment-v1";
const AFFECTED_ID_QUERY_CHUNK_SIZE: usize = 500;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MergeReport {
    pub(crate) applied: usize,
    pub(crate) conflicts: usize,
    pub(crate) parked_cycles: usize,
    pub(crate) new_ids_assigned: usize,
    pub(crate) needs_write_back: bool,
}

pub(crate) fn merge_topic_doc(
    connection: &mut Connection,
    document: &TopicDoc,
) -> Result<MergeReport, NotesError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes topic merge: {error}"))?;
    observe_topic_hlc_evidence(document)?;

    let mut report = MergeReport::default();
    let mut rebuilt_ids = BTreeSet::new();
    let mut moved_hlcs = BTreeMap::new();
    let mut incoming_ids = BTreeSet::from([document.id.clone()]);
    let root = RemoteNode {
        id: document.id.clone(),
        parent_id: None,
        sort_key: document.sort_key,
        title: document.root.title.clone(),
        note: String::new(),
        image_offset_utf16: 0,
        node_kind: NoteNodeKind::Text,
        starred: document.root.starred,
        completed_at: document.root.completed_at.clone(),
        deleted_at: None,
        deleted_batch_id: None,
        archived_at: document.root.archived_at.clone(),
        archive_root_id: document
            .root
            .archived_at
            .as_ref()
            .map(|_| document.id.clone()),
        hlc: document.root.hlc.clone(),
        attachment: None,
    };
    let _ = apply_remote_node(
        &transaction,
        &root,
        &mut report,
        &mut rebuilt_ids,
        &mut moved_hlcs,
    )?;
    let root_is_viable = topic_parent_is_viable(
        &transaction,
        &document.id,
        &document.id,
        document.root.archived_at.is_some(),
    )?;
    if !root_is_viable {
        report.needs_write_back = true;
    }
    let mut stack = document
        .nodes
        .iter()
        .rev()
        .map(|node| {
            (
                node,
                document.id.clone(),
                document.root.archived_at.is_some(),
            )
        })
        .collect::<Vec<_>>();
    while let Some((parsed, intended_parent_id, expects_archive_context)) = stack.pop() {
        let parent_is_viable = topic_parent_is_viable(
            &transaction,
            &intended_parent_id,
            &document.id,
            expects_archive_context,
        )?;
        let (id, remote_hlc) = if let Some(id) = &parsed.id {
            (id.clone(), parsed.hlc.clone())
        } else {
            report.new_ids_assigned += 1;
            report.needs_write_back = true;
            (Uuid::new_v4().to_string(), hlc::now(&transaction)?)
        };
        if !incoming_ids.insert(id.clone()) {
            return Err(format!("A merged Notes topic repeats node ID {id}.").into());
        }
        let archived_at = (parent_is_viable && expects_archive_context)
            .then_some(document.root.archived_at.as_deref())
            .flatten();
        let child_expects_archive_context = archived_at.is_some();
        let was_existing_root = node_is_existing_root(&transaction, &id)?;
        let remote = remote_topic_node(
            &transaction,
            parsed,
            &id,
            &remote_hlc,
            parent_is_viable.then_some(intended_parent_id.as_str()),
            archived_at,
            document.id.as_str(),
        )?;
        apply_remote_node(
            &transaction,
            &remote,
            &mut report,
            &mut rebuilt_ids,
            &mut moved_hlcs,
        )?;
        recover_remote_orphan(
            &transaction,
            &id,
            !parent_is_viable,
            false,
            was_existing_root,
            &mut report,
            &mut rebuilt_ids,
        )?;
        if !node_exists(&transaction, &id)? {
            report.needs_write_back = true;
        }
        for child in parsed.children.iter().rev() {
            stack.push((child, id.clone(), child_expects_archive_context));
        }
    }

    park_cycles(&transaction, &mut moved_hlcs, &mut report, &mut rebuilt_ids)?;
    repair_affected_active_tree_integrity(
        &transaction,
        &incoming_ids,
        &mut report,
        &mut rebuilt_ids,
    )?;
    if topic_has_missing_older_nodes(&transaction, &document.id, &incoming_ids, &document.max_hlc)?
    {
        report.needs_write_back = true;
    }
    let today = SystemLocalTodayProvider.local_today(&transaction)?;
    rebuild_derived_for_nodes_at(&transaction, &rebuilt_ids, today)?;
    let file_name = derive_topic_filename("", &document.id)?;
    transaction
        .execute(
            "INSERT INTO sync_topics(topic_id, file_name, applied_max_hlc) VALUES (?1, ?2, ?3) \
             ON CONFLICT(topic_id) DO UPDATE SET \
               applied_max_hlc = max(sync_topics.applied_max_hlc, excluded.applied_max_hlc)",
            params![document.id, file_name, document.max_hlc],
        )
        .map_err(|error| format!("Could not record the merged Notes topic: {error}"))?;
    if report.needs_write_back {
        mark_dirty(&transaction, &document.id)?;
    }
    hlc::persist_clock(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes topic merge: {error}"))?;
    Ok(report)
}

pub(crate) fn merge_trash_doc(
    connection: &mut Connection,
    document: &TrashDoc,
) -> Result<MergeReport, NotesError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Could not start the Notes trash merge: {error}"))?;
    observe_trash_hlc_evidence(document)?;
    let mut report = MergeReport::default();
    let mut rebuilt_ids = BTreeSet::new();
    let mut moved_hlcs = BTreeMap::new();
    let mut incoming_ids = BTreeSet::new();
    let mut stack = document
        .nodes
        .iter()
        .rev()
        .map(|node| (node, None::<String>, None::<String>))
        .collect::<Vec<_>>();
    while let Some((parsed, nested_parent_id, inherited_batch_id)) = stack.pop() {
        let (id, remote_hlc) = if let Some(id) = &parsed.id {
            (id.clone(), parsed.hlc.clone())
        } else {
            report.new_ids_assigned += 1;
            report.needs_write_back = true;
            (Uuid::new_v4().to_string(), hlc::now(&transaction)?)
        };
        let batch_id =
            inherited_batch_id.unwrap_or_else(|| deterministic_deletion_batch_id(&id, &remote_hlc));
        let (parent_id, sort_key, recover_missing_parent) =
            if let Some(parent_id) = nested_parent_id {
                let parent_is_viable = trash_parent_is_viable(&transaction, &parent_id)?;
                (
                    parent_is_viable.then_some(parent_id),
                    parsed.sort_key,
                    !parent_is_viable,
                )
            } else if let Some((from_parent, from_sort_key)) = &parsed.from {
                let parent_available = ensure_placeholder_parent(&transaction, from_parent)?;
                (
                    parent_available.then(|| from_parent.clone()),
                    *from_sort_key,
                    false,
                )
            } else {
                (None, parsed.sort_key, false)
            };
        let mut remote = remote_topic_node(
            &transaction,
            parsed,
            &id,
            &remote_hlc,
            parent_id.as_deref(),
            None,
            "",
        )?;
        remote.sort_key = sort_key;
        remote.deleted_at = Some(timestamp_for_hlc(&transaction, &remote_hlc)?);
        remote.deleted_batch_id = Some(batch_id.clone());
        if !incoming_ids.insert(id.clone()) {
            return Err(format!("A merged Notes trash document repeats node ID {id}.").into());
        }
        let was_existing_root = node_is_existing_root(&transaction, &id)?;
        apply_remote_node(
            &transaction,
            &remote,
            &mut report,
            &mut rebuilt_ids,
            &mut moved_hlcs,
        )?;
        recover_remote_orphan(
            &transaction,
            &id,
            recover_missing_parent,
            true,
            was_existing_root,
            &mut report,
            &mut rebuilt_ids,
        )?;
        for child in parsed.children.iter().rev() {
            stack.push((child, Some(id.clone()), Some(batch_id.clone())));
        }
    }

    park_cycles(&transaction, &mut moved_hlcs, &mut report, &mut rebuilt_ids)?;
    apply_purge_evidence(&transaction, document, &mut report)?;
    let mut affected_ids = incoming_ids.clone();
    affected_ids.extend(document.purged.iter().map(|tombstone| tombstone.id.clone()));
    repair_affected_active_tree_integrity(
        &transaction,
        &affected_ids,
        &mut report,
        &mut rebuilt_ids,
    )?;
    let today = SystemLocalTodayProvider.local_today(&transaction)?;
    rebuild_derived_for_nodes_at(&transaction, &rebuilt_ids, today)?;
    if report.needs_write_back {
        let mut write_back_ids = incoming_ids;
        write_back_ids.extend(document.purged.iter().map(|tombstone| tombstone.id.clone()));
        for id in write_back_ids {
            mark_dirty(&transaction, &id)?;
        }
    }
    hlc::persist_clock(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit the Notes trash merge: {error}"))?;
    Ok(report)
}

fn deterministic_deletion_batch_id(node_id: &str, node_hlc: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"yonalist-trash-batch-v1");
    digest.update([0]);
    digest.update(node_id.as_bytes());
    digest.update([0]);
    digest.update(node_hlc.as_bytes());
    digest
        .finalize()
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn apply_purge_evidence(
    transaction: &Transaction<'_>,
    document: &TrashDoc,
    report: &mut MergeReport,
) -> Result<(), NotesError> {
    for tombstone in &document.purged {
        if tombstone.hlc.is_empty() {
            report.needs_write_back = true;
            continue;
        }
        let changed = transaction
            .execute(
                "INSERT INTO sync_purged_tombstones(node_id, purged_hlc) VALUES (?1, ?2) \
                 ON CONFLICT(node_id) DO UPDATE SET purged_hlc = excluded.purged_hlc \
                 WHERE excluded.purged_hlc > sync_purged_tombstones.purged_hlc",
                params![tombstone.id, tombstone.hlc],
            )
            .map_err(|error| format!("Could not record Notes purge evidence: {error}"))?;
        report.applied += changed;
    }
    let orphan_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT child.id \
                 FROM notes_nodes child \
                 JOIN notes_nodes parent ON parent.id = child.parent_id \
                 JOIN sync_purged_tombstones parent_tombstone \
                   ON parent_tombstone.node_id = parent.id \
                  AND parent.hlc < parent_tombstone.purged_hlc \
                 WHERE NOT EXISTS (\
                   SELECT 1 FROM sync_purged_tombstones child_tombstone \
                   WHERE child_tombstone.node_id = child.id \
                     AND child.hlc < child_tombstone.purged_hlc\
                 ) \
                 ORDER BY child.id",
            )
            .map_err(|error| format!("Could not prepare surviving Notes purge orphans: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Could not inspect surviving Notes purge orphans: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not read surviving Notes purge orphans: {error}"))?;
        rows
    };
    for orphan_id in orphan_ids {
        park_orphan(transaction, &orphan_id)?;
        report.needs_write_back = true;
    }
    let archived_survivor_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT survivor.id \
                 FROM notes_nodes survivor \
                 JOIN notes_nodes archive_root ON archive_root.id = survivor.archive_root_id \
                 JOIN sync_purged_tombstones root_tombstone \
                   ON root_tombstone.node_id = archive_root.id \
                  AND archive_root.hlc < root_tombstone.purged_hlc \
                 WHERE NOT EXISTS (\
                   SELECT 1 FROM sync_purged_tombstones survivor_tombstone \
                   WHERE survivor_tombstone.node_id = survivor.id \
                     AND survivor.hlc < survivor_tombstone.purged_hlc\
                 ) \
                 ORDER BY survivor.id",
            )
            .map_err(|error| {
                format!("Could not prepare surviving Notes archive references: {error}")
            })?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| {
                format!("Could not inspect surviving Notes archive references: {error}")
            })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
            format!("Could not read surviving Notes archive references: {error}")
        })?
    };
    for survivor_id in archived_survivor_ids {
        recover_archived_survivor(transaction, &survivor_id)?;
        report.needs_write_back = true;
    }
    transaction
        .execute(
            "DELETE FROM notes_nodes \
             WHERE EXISTS (\
               SELECT 1 FROM sync_purged_tombstones tombstone \
               WHERE tombstone.node_id = notes_nodes.id \
                 AND notes_nodes.hlc < tombstone.purged_hlc\
             )",
            [],
        )
        .map_err(|error| format!("Could not apply Notes purge evidence: {error}"))?;
    for tombstone in &document.purged {
        transaction
            .execute(
                "DELETE FROM sync_dirty_nodes \
                 WHERE node_id = ?1 \
                   AND NOT EXISTS (SELECT 1 FROM notes_nodes WHERE id = ?1)",
                [&tombstone.id],
            )
            .map_err(|error| format!("Could not clear purged Notes dirtiness: {error}"))?;
    }
    Ok(())
}

fn park_orphan(transaction: &Transaction<'_>, orphan_id: &str) -> Result<(), NotesError> {
    let recovery_id = ensure_recovery_topic(transaction)?;
    let sort_key = deterministic_recovery_sort_key(orphan_id)?;
    let parked_hlc = hlc::now(transaction)?;
    let timestamp = timestamp_for_hlc(transaction, &parked_hlc)?;
    transaction
        .execute(
            "UPDATE notes_nodes SET \
               parent_id = ?1, sort_key = ?2, updated_at = ?3, archived_at = NULL, \
               archive_root_id = NULL, hlc = ?4 \
             WHERE id = ?5",
            params![recovery_id, sort_key, timestamp, parked_hlc, orphan_id],
        )
        .map_err(|error| format!("Could not park a surviving Notes purge orphan: {error}"))?;
    mark_dirty(transaction, orphan_id)?;
    mark_dirty(transaction, &recovery_id)?;
    Ok(())
}

fn recover_archived_survivor(
    transaction: &Transaction<'_>,
    survivor_id: &str,
) -> Result<(), NotesError> {
    let recovered_hlc = hlc::now(transaction)?;
    let timestamp = timestamp_for_hlc(transaction, &recovered_hlc)?;
    transaction
        .execute(
            "UPDATE notes_nodes SET \
               updated_at = ?1, archived_at = NULL, archive_root_id = NULL, hlc = ?2 \
             WHERE id = ?3",
            params![timestamp, recovered_hlc, survivor_id],
        )
        .map_err(|error| format!("Could not recover a surviving archived Notes node: {error}"))?;
    mark_dirty(transaction, survivor_id)?;
    Ok(())
}

fn recover_remote_orphan(
    transaction: &Transaction<'_>,
    node_id: &str,
    recover_missing_parent: bool,
    include_deleted: bool,
    was_existing_root: bool,
    report: &mut MergeReport,
    rebuilt_ids: &mut BTreeSet<String>,
) -> Result<(), NotesError> {
    if !recover_missing_parent {
        return Ok(());
    }
    let lifecycle = transaction
        .query_row(
            "SELECT parent_id, deleted_at IS NOT NULL, archived_at IS NOT NULL \
             FROM notes_nodes WHERE id = ?1",
            [node_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not inspect a remote Notes orphan: {error}"))?;
    let should_park = match lifecycle {
        Some((Some(parent_id), false, false)) => {
            !topic_parent_is_viable(transaction, &parent_id, "", false)?
        }
        Some((None, false, false)) => !was_existing_root,
        Some((None, true, _)) if include_deleted => !was_existing_root,
        _ => false,
    };
    if !should_park {
        return Ok(());
    }
    park_orphan(transaction, node_id)?;
    rebuilt_ids.insert(node_id.to_string());
    report.needs_write_back = true;
    Ok(())
}

fn node_is_existing_root(transaction: &Transaction<'_>, node_id: &str) -> Result<bool, NotesError> {
    transaction
        .query_row(
            "SELECT parent_id IS NULL FROM notes_nodes WHERE id = ?1",
            [node_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map(|root| root.unwrap_or(false))
        .map_err(|error| format!("Could not inspect an existing Notes root: {error}").into())
}

fn repair_affected_active_tree_integrity(
    transaction: &Transaction<'_>,
    affected_ids: &BTreeSet<String>,
    report: &mut MergeReport,
    rebuilt_ids: &mut BTreeSet<String>,
) -> Result<(), NotesError> {
    if affected_ids.is_empty() {
        return Ok(());
    }
    let affected_ids = affected_ids.iter().collect::<Vec<_>>();
    let mut invalid_ids = BTreeSet::new();
    for seed_ids in affected_ids.chunks(AFFECTED_ID_QUERY_CHUNK_SIZE) {
        let values = (0..seed_ids.len())
            .map(|_| "(?)")
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "WITH RECURSIVE \
             seed(id) AS (VALUES {values}), \
             affected(id) AS (\
               SELECT id FROM seed \
               UNION \
               SELECT child.id FROM notes_nodes child \
               JOIN affected parent ON child.parent_id = parent.id\
             ) \
             SELECT node.id FROM notes_nodes node \
             JOIN affected ON affected.id = node.id \
             LEFT JOIN notes_nodes parent ON parent.id = node.parent_id \
             WHERE node.deleted_at IS NULL AND node.archived_at IS NULL \
               AND node.parent_id IS NOT NULL \
               AND (parent.id IS NULL OR parent.deleted_at IS NOT NULL \
                    OR parent.archived_at IS NOT NULL) \
             ORDER BY node.id"
        );
        let mut statement = transaction
            .prepare(&sql)
            .map_err(|error| format!("Could not prepare affected Notes tree integrity: {error}"))?;
        let rows = statement
            .query_map(
                rusqlite::params_from_iter(seed_ids.iter().map(|id| id.as_str())),
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| format!("Could not inspect affected Notes tree integrity: {error}"))?;
        invalid_ids.extend(rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
            NotesError::from(format!(
                "Could not read affected Notes tree integrity: {error}"
            ))
        })?);
    }
    for node_id in invalid_ids {
        park_orphan(transaction, &node_id)?;
        rebuilt_ids.insert(node_id);
        report.needs_write_back = true;
    }
    Ok(())
}

#[derive(Debug)]
struct RemoteNode {
    id: String,
    parent_id: Option<String>,
    sort_key: i64,
    title: String,
    note: String,
    image_offset_utf16: i64,
    node_kind: NoteNodeKind,
    starred: bool,
    completed_at: Option<String>,
    deleted_at: Option<String>,
    deleted_batch_id: Option<String>,
    archived_at: Option<String>,
    archive_root_id: Option<String>,
    hlc: String,
    attachment: Option<TopicAttachment>,
}

fn observe_document_hlc(value: &str) -> Result<(), NotesError> {
    if value.is_empty() {
        return Ok(());
    }
    let remote = Hlc::decode(value)
        .map_err(|error| format!("The merged Notes document HLC is invalid: {error}"))?;
    hlc::observe(&remote);
    Ok(())
}

fn observe_topic_hlc_evidence(document: &TopicDoc) -> Result<(), NotesError> {
    observe_document_hlc(&document.max_hlc)?;
    observe_document_hlc(&document.root.hlc)?;
    observe_node_hlc_evidence(&document.nodes)
}

fn observe_trash_hlc_evidence(document: &TrashDoc) -> Result<(), NotesError> {
    observe_document_hlc(&document.max_hlc)?;
    for tombstone in &document.purged {
        observe_document_hlc(&tombstone.hlc)?;
    }
    observe_node_hlc_evidence(&document.nodes)
}

fn observe_node_hlc_evidence(nodes: &[TopicNode]) -> Result<(), NotesError> {
    let mut stack = nodes.iter().collect::<Vec<_>>();
    while let Some(node) = stack.pop() {
        observe_document_hlc(&node.hlc)?;
        stack.extend(node.children.iter());
    }
    Ok(())
}

fn node_exists(transaction: &Transaction<'_>, node_id: &str) -> Result<bool, NotesError> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
            [node_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect a merged Notes node: {error}").into())
}

fn topic_parent_is_viable(
    transaction: &Transaction<'_>,
    parent_id: &str,
    topic_id: &str,
    topic_is_archived: bool,
) -> Result<bool, NotesError> {
    let viable = if topic_is_archived {
        transaction.query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM notes_nodes \
               WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NOT NULL \
                 AND archive_root_id = ?2\
             )",
            params![parent_id, topic_id],
            |row| row.get::<_, bool>(0),
        )
    } else {
        transaction.query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM notes_nodes \
               WHERE id = ?1 AND deleted_at IS NULL AND archived_at IS NULL\
             )",
            [parent_id],
            |row| row.get::<_, bool>(0),
        )
    };
    viable
        .map_err(|error| format!("Could not inspect merged Notes parent viability: {error}").into())
}

fn trash_parent_is_viable(
    transaction: &Transaction<'_>,
    parent_id: &str,
) -> Result<bool, NotesError> {
    transaction
        .query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM notes_nodes WHERE id = ?1 AND deleted_at IS NOT NULL\
             )",
            [parent_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect a merged Notes trash parent: {error}").into())
}

fn attachment_id_exists(
    transaction: &Transaction<'_>,
    attachment_id: &str,
) -> Result<bool, NotesError> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_attachments WHERE id = ?1)",
            [attachment_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect the Notes ID namespace: {error}").into())
}

fn ensure_placeholder_parent(
    transaction: &Transaction<'_>,
    parent_id: &str,
) -> Result<bool, NotesError> {
    if node_exists(transaction, parent_id)? {
        return Ok(true);
    }
    let purged = transaction
        .query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM sync_purged_tombstones \
               WHERE node_id = ?1 AND purged_hlc <> ''\
             )",
            [parent_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect a missing trash parent tombstone: {error}"))?;
    if purged {
        return Ok(false);
    }
    if attachment_id_exists(transaction, parent_id)? {
        return Err(
            "A missing Notes trash parent ID collides with an attachment."
                .to_string()
                .into(),
        );
    }
    let sort_key = deterministic_recovery_sort_key(parent_id)?;
    transaction
        .execute(
            "INSERT INTO notes_nodes(\
               id, parent_id, sort_key, title, note, image_offset_utf16, layout_mode, \
               is_collapsed, is_starred, created_at, updated_at, node_kind, hlc\
             ) VALUES (?1, NULL, ?2, '', '', 0, 'bullets', 0, 0, ?3, ?3, 'text', ?4)",
            params![
                parent_id,
                sort_key,
                SYNC_TIMESTAMP_FALLBACK,
                PLACEHOLDER_HLC
            ],
        )
        .map_err(|error| format!("Could not preserve a missing Notes trash parent: {error}"))?;
    Ok(true)
}

fn deterministic_recovery_sort_key(node_id: &str) -> Result<i64, NotesError> {
    let canonical = Uuid::parse_str(node_id)
        .map_err(|_| "A recovered Notes node ID is invalid.".to_string())?
        .simple()
        .to_string();
    let prefix = u64::from_str_radix(&canonical[..15], 16)
        .map_err(|_| "A recovered Notes node ID is invalid.".to_string())?;
    i64::try_from(prefix).map_err(|_| {
        "A recovered Notes sort key is too large."
            .to_string()
            .into()
    })
}

fn timestamp_for_hlc(transaction: &Transaction<'_>, value: &str) -> Result<String, NotesError> {
    let Ok(hlc) = Hlc::decode(value) else {
        return Ok(SYNC_TIMESTAMP_FALLBACK.to_string());
    };
    let seconds = i64::try_from(hlc.millis / 1_000)
        .map_err(|_| "The merged Notes HLC timestamp is too large.".to_string())?;
    let milliseconds =
        i64::try_from(hlc.millis % 1_000).expect("a millisecond remainder always fits i64");
    transaction
        .query_row(
            "SELECT COALESCE(\
               strftime('%Y-%m-%dT%H:%M:%S', ?1, 'unixepoch') || printf('.%03dZ', ?2), ?3\
             )",
            params![seconds, milliseconds, SYNC_TIMESTAMP_FALLBACK],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Could not derive a Notes sync timestamp: {error}").into())
}

fn remote_topic_node(
    transaction: &Transaction<'_>,
    parsed: &TopicNode,
    id: &str,
    remote_hlc: &str,
    parent_id: Option<&str>,
    archived_at: Option<&str>,
    archive_root_id: &str,
) -> Result<RemoteNode, NotesError> {
    let (title, image_offset_utf16, node_kind, attachment) = match &parsed.content {
        TopicContent::Text(title) => (title.clone(), 0, NoteNodeKind::Text, None),
        TopicContent::Image {
            before,
            attachment,
            after,
        } => (
            format!("{before}{after}"),
            i64::try_from(before.encode_utf16().count())
                .map_err(|_| "A merged Notes image offset is too large.".to_string())?,
            NoteNodeKind::Image,
            Some(attachment.clone()),
        ),
    };
    let completed_at = parsed
        .completed
        .then(|| timestamp_for_hlc(transaction, remote_hlc))
        .transpose()?;
    Ok(RemoteNode {
        id: id.to_string(),
        parent_id: parent_id.map(str::to_string),
        sort_key: parsed.sort_key,
        title,
        note: parsed.note.clone(),
        image_offset_utf16,
        node_kind,
        starred: parsed.starred,
        completed_at,
        deleted_at: None,
        deleted_batch_id: None,
        archived_at: archived_at.map(str::to_string),
        archive_root_id: archived_at.map(|_| archive_root_id.to_string()),
        hlc: remote_hlc.to_string(),
        attachment,
    })
}

fn topic_has_missing_older_nodes(
    transaction: &Transaction<'_>,
    topic_id: &str,
    incoming_ids: &BTreeSet<String>,
    document_max_hlc: &str,
) -> Result<bool, NotesError> {
    if document_max_hlc.is_empty() {
        return Ok(false);
    }
    let mut statement = transaction
        .prepare(
            "WITH RECURSIVE subtree(id) AS (\
               SELECT ?1 \
               UNION \
               SELECT node.id FROM notes_nodes node JOIN subtree parent ON node.parent_id = parent.id\
             ) \
             SELECT node.id, node.hlc FROM notes_nodes node JOIN subtree ON subtree.id = node.id \
             WHERE node.deleted_at IS NULL",
        )
        .map_err(|error| format!("Could not prepare the merged Notes topic membership: {error}"))?;
    let rows = statement
        .query_map([topic_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not inspect merged Notes topic membership: {error}"))?;
    for row in rows {
        let (id, hlc) =
            row.map_err(|error| format!("Could not read merged Notes topic membership: {error}"))?;
        if !incoming_ids.contains(&id) && hlc.as_str() < document_max_hlc {
            return Ok(true);
        }
    }
    Ok(false)
}

fn mark_dirty(transaction: &Transaction<'_>, node_id: &str) -> Result<(), NotesError> {
    transaction
        .execute(
            "INSERT INTO sync_dirty_nodes(node_id) VALUES (?1) \
             ON CONFLICT(node_id) DO UPDATE SET marked_at = excluded.marked_at",
            [node_id],
        )
        .map_err(|error| format!("Could not mark a Notes topic for sync write-back: {error}"))?;
    Ok(())
}

fn park_cycles(
    transaction: &Transaction<'_>,
    moved_hlcs: &mut BTreeMap<String, String>,
    report: &mut MergeReport,
    rebuilt_ids: &mut BTreeSet<String>,
) -> Result<(), NotesError> {
    loop {
        let mut cyclic_nodes = BTreeMap::<String, String>::new();
        for start in moved_hlcs.keys() {
            let mut path = Vec::<String>::new();
            let mut current = Some(start.clone());
            while let Some(node_id) = current {
                if let Some(cycle_start) = path.iter().position(|seen| seen == &node_id) {
                    for cycle_id in &path[cycle_start..] {
                        let stored_hlc = transaction
                            .query_row(
                                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                                [cycle_id],
                                |row| row.get::<_, String>(0),
                            )
                            .map_err(|error| {
                                format!("Could not inspect a cyclic Notes move HLC: {error}")
                            })?;
                        cyclic_nodes.insert(cycle_id.clone(), stored_hlc);
                    }
                    break;
                }
                if path.len() > MAX_IMPORT_SUBTREE_DEPTH {
                    return Err("A merged Notes parent chain exceeds the supported depth."
                        .to_string()
                        .into());
                }
                path.push(node_id.clone());
                current = transaction
                    .query_row(
                        "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                        [&node_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(|error| {
                        format!("Could not inspect a merged Notes parent chain: {error}")
                    })?
                    .flatten();
            }
        }
        let Some(candidate) = cyclic_nodes
            .keys()
            .min_by(|left, right| {
                cyclic_nodes
                    .get(*left)
                    .cmp(&cyclic_nodes.get(*right))
                    .then_with(|| left.cmp(right))
            })
            .cloned()
        else {
            return Ok(());
        };
        let candidate_is_deleted = transaction
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM notes_nodes WHERE id = ?1",
                [&candidate],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("Could not inspect a cyclic Notes move lifecycle: {error}"))?;
        let recovery_id = ensure_recovery_topic(transaction)?;
        let sort_key = deterministic_recovery_sort_key(&candidate)?;
        let parked_hlc = hlc::now(transaction)?;
        let timestamp = timestamp_for_hlc(transaction, &parked_hlc)?;
        if candidate_is_deleted {
            transaction.execute(
                "UPDATE notes_nodes SET \
                   parent_id = ?1, sort_key = ?2, updated_at = ?3, hlc = ?4 \
                 WHERE id = ?5",
                params![recovery_id, sort_key, timestamp, parked_hlc, candidate],
            )
        } else {
            transaction.execute(
                "UPDATE notes_nodes SET \
                   parent_id = ?1, sort_key = ?2, updated_at = ?3, deleted_at = NULL, \
                   deleted_batch_id = NULL, archived_at = NULL, archive_root_id = NULL, hlc = ?4 \
                 WHERE id = ?5",
                params![recovery_id, sort_key, timestamp, parked_hlc, candidate],
            )
        }
        .map_err(|error| format!("Could not park a cyclic Notes move: {error}"))?;
        mark_dirty(transaction, &candidate)?;
        mark_dirty(transaction, &recovery_id)?;
        rebuilt_ids.insert(candidate.clone());
        if !candidate_is_deleted {
            activate_archived_parked_descendants(transaction, &candidate, rebuilt_ids)?;
        }
        moved_hlcs.remove(&candidate);
        report.parked_cycles += 1;
        report.needs_write_back = true;
    }
}

fn activate_archived_parked_descendants(
    transaction: &Transaction<'_>,
    parked_id: &str,
    rebuilt_ids: &mut BTreeSet<String>,
) -> Result<(), NotesError> {
    let archived_ids = {
        let mut statement = transaction
            .prepare(
                "WITH RECURSIVE subtree(id) AS (\
                   SELECT ?1 \
                   UNION \
                   SELECT child.id FROM notes_nodes child \
                   JOIN subtree parent ON child.parent_id = parent.id \
                   WHERE child.deleted_at IS NULL\
                 ) \
                 SELECT node.id FROM notes_nodes node JOIN subtree ON subtree.id = node.id \
                 WHERE node.id <> ?1 AND node.deleted_at IS NULL \
                   AND (node.archived_at IS NOT NULL OR node.archive_root_id IS NOT NULL) \
                 ORDER BY node.id",
            )
            .map_err(|error| {
                format!("Could not prepare archived Notes cycle descendants: {error}")
            })?;
        let rows = statement
            .query_map([parked_id], |row| row.get::<_, String>(0))
            .map_err(|error| {
                format!("Could not inspect archived Notes cycle descendants: {error}")
            })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
            NotesError::from(format!(
                "Could not read archived Notes cycle descendants: {error}"
            ))
        })?
    };
    for node_id in archived_ids {
        let repaired_hlc = hlc::now(transaction)?;
        let timestamp = timestamp_for_hlc(transaction, &repaired_hlc)?;
        transaction
            .execute(
                "UPDATE notes_nodes SET \
                   updated_at = ?1, deleted_batch_id = NULL, archived_at = NULL, \
                   archive_root_id = NULL, hlc = ?2 \
                 WHERE id = ?3",
                params![timestamp, repaired_hlc, node_id],
            )
            .map_err(|error| {
                format!("Could not activate an archived Notes cycle descendant: {error}")
            })?;
        mark_dirty(transaction, &node_id)?;
        rebuilt_ids.insert(node_id);
    }
    Ok(())
}

fn ensure_recovery_topic(transaction: &Transaction<'_>) -> Result<String, NotesError> {
    let vault_uuid = transaction
        .query_row("SELECT vault_uuid FROM sync_meta WHERE id = 1", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| format!("Could not read the Notes recovery namespace: {error}"))?;
    let vault_uuid = Uuid::parse_str(&vault_uuid)
        .map_err(|_| "The Notes recovery namespace is invalid.".to_string())?;
    let recovery_id = Uuid::new_v5(&vault_uuid, b"yonalist-recovery-topic")
        .hyphenated()
        .to_string();
    let existing = transaction
        .query_row(
            "SELECT parent_id, title, deleted_at, deleted_batch_id, archived_at, archive_root_id, hlc \
             FROM notes_nodes WHERE id = ?1",
            [&recovery_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not inspect the Notes recovery topic: {error}"))?;
    if let Some((
        parent_id,
        title,
        deleted_at,
        deleted_batch_id,
        archived_at,
        archive_root_id,
        existing_hlc,
    )) = existing
    {
        if parent_id.is_some() {
            return Err(
                "The deterministic Notes recovery topic ID is already in use."
                    .to_string()
                    .into(),
            );
        }
        let winning_purge = transaction
            .query_row(
                "SELECT purged_hlc FROM sync_purged_tombstones WHERE node_id = ?1",
                [&recovery_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Could not inspect a Notes recovery purge: {error}"))?
            .is_some_and(|purged_hlc| existing_hlc < purged_hlc);
        if title != "복구됨"
            || deleted_at.is_some()
            || deleted_batch_id.is_some()
            || archived_at.is_some()
            || archive_root_id.is_some()
            || winning_purge
        {
            let recovery_hlc = hlc::now(transaction)?;
            let timestamp = timestamp_for_hlc(transaction, &recovery_hlc)?;
            transaction
                .execute(
                    "UPDATE notes_nodes SET \
                       title = '복구됨', updated_at = ?1, deleted_at = NULL, deleted_batch_id = NULL, \
                       archived_at = NULL, archive_root_id = NULL, hlc = ?2 \
                     WHERE id = ?3",
                    params![timestamp, recovery_hlc, recovery_id],
                )
                .map_err(|error| {
                    format!("Could not reactivate the Notes recovery topic: {error}")
                })?;
            mark_dirty(transaction, &recovery_id)?;
        }
        return Ok(recovery_id);
    }
    if attachment_id_exists(transaction, &recovery_id)? {
        return Err(
            "The deterministic Notes recovery topic ID collides with an attachment."
                .to_string()
                .into(),
        );
    }
    let sort_key = deterministic_recovery_sort_key(&recovery_id)?;
    let recovery_hlc = hlc::now(transaction)?;
    let timestamp = timestamp_for_hlc(transaction, &recovery_hlc)?;
    transaction
        .execute(
            "INSERT INTO notes_nodes(\
               id, parent_id, sort_key, title, note, image_offset_utf16, layout_mode, \
               is_collapsed, is_starred, created_at, updated_at, node_kind, hlc\
             ) VALUES (?1, NULL, ?2, '복구됨', '', 0, 'bullets', 0, 0, ?3, ?3, 'text', ?4)",
            params![recovery_id, sort_key, timestamp, recovery_hlc],
        )
        .map_err(|error| format!("Could not create the Notes recovery topic: {error}"))?;
    let file_name = derive_topic_filename("복구됨", &recovery_id)?;
    transaction
        .execute(
            "INSERT INTO sync_topics(topic_id, file_name, applied_max_hlc) VALUES (?1, ?2, ?3)",
            params![recovery_id, file_name, recovery_hlc],
        )
        .map_err(|error| format!("Could not record the Notes recovery topic: {error}"))?;
    mark_dirty(transaction, &recovery_id)?;
    Ok(recovery_id)
}

fn apply_remote_node(
    transaction: &Transaction<'_>,
    remote: &RemoteNode,
    report: &mut MergeReport,
    rebuilt_ids: &mut BTreeSet<String>,
    moved_hlcs: &mut BTreeMap<String, String>,
) -> Result<bool, NotesError> {
    let purged_hlc = transaction
        .query_row(
            "SELECT purged_hlc FROM sync_purged_tombstones WHERE node_id = ?1",
            [&remote.id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect Notes purge evidence: {error}"))?;
    if purged_hlc
        .as_deref()
        .is_some_and(|purged_hlc| remote.hlc.as_str() < purged_hlc)
    {
        report.needs_write_back = true;
        return Ok(false);
    }
    let local = transaction
        .query_row(
            "SELECT hlc, parent_id FROM notes_nodes WHERE id = ?1",
            [&remote.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Could not inspect the local Notes node: {error}"))?;
    if local.is_none() && remote.hlc.is_empty() {
        report.needs_write_back = true;
        return Ok(false);
    }
    match local.as_ref() {
        Some((local_hlc, _)) if remote.hlc == *local_hlc => return Ok(false),
        Some((local_hlc, _)) if remote.hlc.as_str() < local_hlc.as_str() => {
            let loser_json = remote_node_json(remote)?;
            let inserted = transaction
                .execute(
                    "INSERT INTO sync_conflict_log(node_id, loser_json, loser_hlc, winner_hlc) \
                     SELECT ?1, ?2, ?3, ?4 \
                     WHERE NOT EXISTS (\
                       SELECT 1 FROM sync_conflict_log \
                       WHERE node_id = ?1 AND loser_json = ?2 AND loser_hlc = ?3 AND winner_hlc = ?4\
                     )",
                    params![remote.id, loser_json, remote.hlc, local_hlc],
                )
                .map_err(|error| format!("Could not record a Notes sync conflict: {error}"))?;
            report.conflicts += inserted;
            report.needs_write_back = true;
            return Ok(false);
        }
        Some((_, local_parent_id)) => {
            if *local_parent_id != remote.parent_id {
                moved_hlcs.insert(remote.id.clone(), remote.hlc.clone());
            }
            update_remote_node(transaction, remote)?;
        }
        None => {
            if attachment_id_exists(transaction, &remote.id)? {
                return Err("A merged Notes node ID collides with an attachment."
                    .to_string()
                    .into());
            }
            insert_remote_node(transaction, remote)?;
        }
    }
    synchronize_attachment(transaction, remote)?;
    let current_hlc = transaction
        .query_row(
            "SELECT hlc FROM notes_nodes WHERE id = ?1",
            [&remote.id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Could not verify the remote Notes HLC: {error}"))?;
    if current_hlc != remote.hlc {
        transaction
            .execute(
                "UPDATE notes_nodes SET hlc = ?1 WHERE id = ?2",
                params![remote.hlc, remote.id],
            )
            .map_err(|error| format!("Could not preserve the remote Notes HLC: {error}"))?;
    }
    transaction
        .execute(
            "DELETE FROM sync_dirty_nodes WHERE node_id = ?1",
            [&remote.id],
        )
        .map_err(|error| format!("Could not clear remote Notes dirtiness: {error}"))?;
    rebuilt_ids.insert(remote.id.clone());
    report.applied += 1;
    Ok(true)
}

fn insert_remote_node(
    transaction: &Transaction<'_>,
    remote: &RemoteNode,
) -> Result<(), NotesError> {
    let timestamp = timestamp_for_hlc(transaction, &remote.hlc)?;
    transaction
        .execute(
            "INSERT INTO notes_nodes(\
               id, parent_id, sort_key, title, note, image_offset_utf16, layout_mode, \
               is_collapsed, is_starred, completed_at, created_at, updated_at, deleted_at, \
               deleted_batch_id, archived_at, archive_root_id, node_kind, hlc\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'bullets', 0, ?7, ?8, ?9, ?9, ?10, \
                       ?11, ?12, ?13, ?14, ?15)",
            params![
                remote.id,
                remote.parent_id,
                remote.sort_key,
                remote.title,
                remote.note,
                remote.image_offset_utf16,
                i64::from(remote.starred),
                remote.completed_at,
                timestamp,
                remote.deleted_at,
                remote.deleted_batch_id,
                remote.archived_at,
                remote.archive_root_id,
                remote.node_kind.as_str(),
                remote.hlc,
            ],
        )
        .map_err(|error| format!("Could not insert a merged Notes node: {error}"))?;
    Ok(())
}

fn update_remote_node(
    transaction: &Transaction<'_>,
    remote: &RemoteNode,
) -> Result<(), NotesError> {
    let timestamp = timestamp_for_hlc(transaction, &remote.hlc)?;
    transaction
        .execute(
            "UPDATE notes_nodes SET \
               parent_id = ?1, sort_key = ?2, title = ?3, note = ?4, image_offset_utf16 = ?5, \
               layout_mode = 'bullets', is_starred = ?6, completed_at = ?7, \
               updated_at = ?8, deleted_at = ?9, deleted_batch_id = ?10, archived_at = ?11, \
               archive_root_id = ?12, node_kind = ?13, hlc = ?14 \
             WHERE id = ?15",
            params![
                remote.parent_id,
                remote.sort_key,
                remote.title,
                remote.note,
                remote.image_offset_utf16,
                i64::from(remote.starred),
                remote.completed_at,
                timestamp,
                remote.deleted_at,
                remote.deleted_batch_id,
                remote.archived_at,
                remote.archive_root_id,
                remote.node_kind.as_str(),
                remote.hlc,
                remote.id,
            ],
        )
        .map_err(|error| format!("Could not update a merged Notes node: {error}"))?;
    Ok(())
}

fn remote_node_json(remote: &RemoteNode) -> Result<String, NotesError> {
    let attachment = remote.attachment.as_ref().map(|attachment| {
        serde_json::json!({
            "content_hash": attachment.content_hash,
            "extension": attachment.extension,
            "encoded_original_name": attachment.encoded_original_name,
            "display_width": attachment.display_width,
        })
    });
    serde_json::to_string(&serde_json::json!({
        "id": remote.id,
        "parent_id": remote.parent_id,
        "sort_key": remote.sort_key,
        "title": remote.title,
        "note": remote.note,
        "image_offset_utf16": remote.image_offset_utf16,
        "node_kind": remote.node_kind.as_str(),
        "is_starred": remote.starred,
        "completed_at": remote.completed_at,
        "deleted_at": remote.deleted_at,
        "deleted_batch_id": remote.deleted_batch_id,
        "archived_at": remote.archived_at,
        "archive_root_id": remote.archive_root_id,
        "hlc": remote.hlc,
        "attachment": attachment,
    }))
    .map_err(|error| format!("Could not serialize a Notes sync conflict: {error}").into())
}

fn deterministic_attachment_id(node_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(ATTACHMENT_ID_DOMAIN);
    digest.update([0]);
    digest.update(node_id.as_bytes());
    let digest = digest.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).hyphenated().to_string()
}

fn attachment_mime_type(extension: &str) -> Result<&'static str, NotesError> {
    match extension {
        "png" => Ok("image/png"),
        "jpg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        _ => Err(format!("Unsupported merged Notes attachment extension: {extension}").into()),
    }
}

fn synchronize_attachment(
    transaction: &Transaction<'_>,
    remote: &RemoteNode,
) -> Result<(), NotesError> {
    let Some(attachment) = &remote.attachment else {
        transaction
            .execute(
                "DELETE FROM notes_attachments WHERE node_id = ?1",
                [&remote.id],
            )
            .map_err(|error| format!("Could not clear merged Notes attachments: {error}"))?;
        return Ok(());
    };
    let attachment_id = deterministic_attachment_id(&remote.id);
    let node_namespace_collision = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes_nodes WHERE id = ?1)",
            [&attachment_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("Could not inspect the Notes attachment ID namespace: {error}"))?;
    if node_namespace_collision {
        return Err("A deterministic Notes attachment ID collides with a node."
            .to_string()
            .into());
    }
    let existing_owner = transaction
        .query_row(
            "SELECT node_id FROM notes_attachments WHERE id = ?1",
            [&attachment_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not inspect a merged Notes attachment ID: {error}"))?;
    if existing_owner
        .as_deref()
        .is_some_and(|owner| owner != remote.id)
    {
        return Err(
            "A deterministic Notes attachment ID collides with another node."
                .to_string()
                .into(),
        );
    }
    let original_name = crate::notes::markdown_import::decode_canonical_original_name(
        &attachment.encoded_original_name,
    )?;
    let relative_path = format!(
        "notes-assets/{}.{}",
        attachment.content_hash, attachment.extension
    );
    let mime_type = attachment_mime_type(&attachment.extension)?;
    let display_width = attachment.display_width.unwrap_or(0);
    let timestamp = timestamp_for_hlc(transaction, &remote.hlc)?;
    transaction
        .execute(
            "DELETE FROM notes_attachments WHERE node_id = ?1 AND id <> ?2",
            params![remote.id, attachment_id],
        )
        .map_err(|error| format!("Could not replace merged Notes attachments: {error}"))?;
    if existing_owner.is_none() {
        let attachment_count = transaction
            .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| format!("Could not inspect Notes attachment capacity: {error}"))?;
        if attachment_count >= MAX_NOTE_ATTACHMENTS_PER_VAULT {
            return Err(format!(
                "A Notes vault can contain at most {MAX_NOTE_ATTACHMENTS_PER_VAULT} attachments."
            )
            .into());
        }
    }
    transaction
        .execute(
            "INSERT INTO notes_attachments(\
               id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
               byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
             ) VALUES (?1, ?2, 1024, ?3, ?4, ?5, ?6, 0, 0, 0, ?7, ?8, ?8) \
             ON CONFLICT(id) DO UPDATE SET \
               node_id = excluded.node_id, sort_key = excluded.sort_key, \
               relative_path = excluded.relative_path, content_hash = excluded.content_hash, \
               original_name = excluded.original_name, mime_type = excluded.mime_type, \
               byte_size = CASE WHEN notes_attachments.content_hash = excluded.content_hash \
                                THEN notes_attachments.byte_size ELSE 0 END, \
               intrinsic_width = CASE WHEN notes_attachments.content_hash = excluded.content_hash \
                                      THEN notes_attachments.intrinsic_width ELSE 0 END, \
               intrinsic_height = CASE WHEN notes_attachments.content_hash = excluded.content_hash \
                                       THEN notes_attachments.intrinsic_height ELSE 0 END, \
               display_width = excluded.display_width, updated_at = excluded.updated_at",
            params![
                attachment_id,
                remote.id,
                relative_path,
                attachment.content_hash,
                original_name,
                mime_type,
                display_width,
                timestamp,
            ],
        )
        .map_err(|error| format!("Could not synchronize a merged Notes attachment: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::history;
    use crate::notes::repository::{load_workspace, SORT_KEY_STEP};
    use crate::notes::sync::topic_file::{
        render_topic_doc, PurgedTombstone, TopicAttachment, TopicContent, TopicFile, TopicNode,
        TopicRoot, TrashDoc,
    };
    use crate::notes::sync::topic_parser::{parse_topic_file, TopicParseOutcome};
    use crate::notes::types::NotesWorkspaceScope;
    use rusqlite::{params, TransactionBehavior};

    const TOPIC_ID: &str = "11111111-1111-4111-8111-111111111111";
    const NODE_ID: &str = "22222222-2222-4222-8222-222222222222";
    const ROOT_HLC: &str = "0swkd7qz3-00-a3f2";
    const NODE_HLC: &str = "0swkd7qz4-00-a3f2";
    const HIGH_HLC: &str = "0swkd7qz6-00-b4e3";
    const FUTURE_HLC: &str = "zmh2960ao-00-a3f2";

    fn test_connection() -> Connection {
        let mut connection = Connection::open_in_memory().expect("open test database");
        crate::notes::schema::install_notes_sql_functions(&connection)
            .expect("install Notes SQL functions");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable foreign keys");
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("start schema transaction");
        crate::notes::schema::create_if_missing(&transaction).expect("create Notes schema");
        transaction
            .execute(
                "INSERT INTO notes_metadata(id, vault_generation) VALUES (1, ?1)",
                ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
            )
            .expect("seed vault metadata");
        transaction
            .execute(
                "INSERT INTO sync_meta(id, device_id, vault_uuid) VALUES (1, ?1, ?2)",
                params![
                    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
                ],
            )
            .expect("seed sync metadata");
        transaction.commit().expect("commit schema");
        crate::notes::hlc::register_hlc_function(&connection).expect("register Notes HLC function");
        history::install_session_history(&connection).expect("install session history");
        connection
    }

    fn text_node(id: Option<&str>, hlc: &str, title: &str) -> TopicNode {
        TopicNode {
            id: id.map(str::to_string),
            hlc: hlc.to_string(),
            starred: false,
            completed: false,
            content: TopicContent::Text(title.to_string()),
            note: String::new(),
            from: None,
            sibling_ordinal: 1,
            sort_key: crate::notes::repository::SORT_KEY_STEP,
            children: Vec::new(),
        }
    }

    fn topic_with(nodes: Vec<TopicNode>) -> TopicDoc {
        TopicDoc {
            id: TOPIC_ID.to_string(),
            sort_key: crate::notes::repository::SORT_KEY_STEP,
            max_hlc: NODE_HLC.to_string(),
            root: TopicRoot {
                title: "Topic".to_string(),
                hlc: ROOT_HLC.to_string(),
                starred: false,
                completed_at: None,
                archived_at: None,
            },
            nodes,
        }
    }

    fn rendered_topic(document: &TopicDoc) -> TopicDoc {
        match parse_topic_file(&render_topic_doc(document).expect("render topic")) {
            TopicParseOutcome::Parsed(TopicFile::Topic(document)) => document,
            outcome => panic!("unexpected rendered topic parse outcome: {outcome:?}"),
        }
    }

    fn recovery_topic_id() -> String {
        let vault_uuid =
            Uuid::parse_str("cccccccc-cccc-4ccc-8ccc-cccccccccccc").expect("vault UUID");
        Uuid::new_v5(&vault_uuid, b"yonalist-recovery-topic")
            .hyphenated()
            .to_string()
    }

    fn sync_state(connection: &Connection) -> Vec<(String, Option<String>, i64, String, String)> {
        let mut statement = connection
            .prepare("SELECT id, parent_id, sort_key, title, hlc FROM notes_nodes ORDER BY id")
            .expect("prepare sync state");
        statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .expect("query sync state")
            .collect::<Result<Vec<_>, _>>()
            .expect("read sync state")
    }

    fn reachable_lifecycle_state(
        connection: &Connection,
    ) -> Vec<(
        String,
        Option<String>,
        i64,
        String,
        bool,
        bool,
        Option<String>,
    )> {
        let mut statement = connection
            .prepare(
                "SELECT id, parent_id, sort_key, title, deleted_at IS NOT NULL, \
                        archived_at IS NOT NULL, archive_root_id \
                 FROM notes_nodes ORDER BY id",
            )
            .expect("prepare reachable lifecycle state");
        statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
            .expect("query reachable lifecycle state")
            .collect::<Result<Vec<_>, _>>()
            .expect("read reachable lifecycle state")
    }

    #[test]
    fn same_document_twice_is_a_no_op_and_preserves_remote_hlc_without_history() {
        let mut connection = test_connection();
        let document = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Remote")]);

        let first = merge_topic_doc(&mut connection, &document).expect("first merge");
        let first_state = sync_state(&connection);
        let second = merge_topic_doc(&mut connection, &document).expect("second merge");

        assert_eq!(first.applied, 2);
        assert_eq!(second.applied, 0);
        assert_eq!(sync_state(&connection), first_state);
        assert_eq!(
            connection
                .query_row(
                    "SELECT hlc FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| { row.get::<_, String>(0) }
                )
                .expect("node HLC"),
            NODE_HLC
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_dirty_nodes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("dirty count"),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_history_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("history count"),
            0
        );
    }

    #[test]
    fn image_metadata_is_synchronized_without_asset_bytes() {
        let mut connection = test_connection();
        let image = TopicNode {
            content: TopicContent::Image {
                before: "Before".to_string(),
                attachment: TopicAttachment {
                    content_hash: "a".repeat(64),
                    extension: "png".to_string(),
                    encoded_original_name: "photo%20one.png".to_string(),
                    display_width: Some(320),
                },
                after: "After".to_string(),
            },
            ..text_node(Some(NODE_ID), NODE_HLC, "")
        };

        merge_topic_doc(&mut connection, &topic_with(vec![image])).expect("merge image");

        let attachment: (String, String, String, String, i64, i64) = connection
            .query_row(
                "SELECT id, relative_path, content_hash, original_name, byte_size, display_width \
                 FROM notes_attachments WHERE node_id = ?1",
                [NODE_ID],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .expect("attachment placeholder");
        crate::notes::types::validate_note_id(&attachment.0).expect("v4-shaped attachment ID");
        assert_eq!(attachment.1, format!("notes-assets/{}.png", "a".repeat(64)));
        assert_eq!(attachment.2, "a".repeat(64));
        assert_eq!(attachment.3, "photo one.png");
        assert_eq!(attachment.4, 0);
        assert_eq!(attachment.5, 320);
        assert_eq!(
            connection
                .query_row(
                    "SELECT hlc FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| { row.get::<_, String>(0) }
                )
                .expect("node HLC"),
            NODE_HLC
        );
    }

    #[test]
    fn losing_remote_is_logged_once_and_marks_the_topic_for_write_back() {
        let mut connection = test_connection();
        let mut winner = topic_with(vec![text_node(Some(NODE_ID), HIGH_HLC, "Winner")]);
        winner.max_hlc = HIGH_HLC.to_string();
        merge_topic_doc(&mut connection, &winner).expect("merge winner");

        let loser = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Loser")]);
        let first = merge_topic_doc(&mut connection, &loser).expect("merge loser");
        let second = merge_topic_doc(&mut connection, &loser).expect("repeat loser");

        assert_eq!(first.conflicts, 1);
        assert_eq!(second.conflicts, 0);
        assert!(first.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| { row.get::<_, String>(0) }
                )
                .expect("winning title"),
            "Winner"
        );
        let conflict: (String, String, String) = connection
            .query_row(
                "SELECT loser_json, loser_hlc, winner_hlc FROM sync_conflict_log \
                 WHERE node_id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("conflict log");
        assert!(conflict.0.contains("\"title\":\"Loser\""));
        assert_eq!(conflict.1, NODE_HLC);
        assert_eq!(conflict.2, HIGH_HLC);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("topic dirtiness"),
            1
        );
    }

    #[test]
    fn file_absence_never_deletes_local_nodes_and_requests_write_back() {
        let mut connection = test_connection();
        let absent_id = "33333333-3333-4333-8333-333333333333";
        merge_topic_doc(
            &mut connection,
            &topic_with(vec![
                text_node(Some(NODE_ID), NODE_HLC, "Present"),
                TopicNode {
                    sibling_ordinal: 2,
                    sort_key: 2 * crate::notes::repository::SORT_KEY_STEP,
                    ..text_node(Some(absent_id), NODE_HLC, "Absent from file later")
                },
            ]),
        )
        .expect("seed topic");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear dirtiness");
        let mut newer = topic_with(vec![text_node(Some(NODE_ID), HIGH_HLC, "Present")]);
        newer.max_hlc = HIGH_HLC.to_string();
        newer.root.hlc = HIGH_HLC.to_string();

        let report = merge_topic_doc(&mut connection, &newer).expect("merge incomplete file");

        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [absent_id],
                    |row| row.get::<_, String>(0),
                )
                .expect("absent node survives"),
            "Absent from file later"
        );
    }

    #[test]
    fn external_bullet_gets_uuid_hlc_and_write_back_dirtiness() {
        let mut connection = test_connection();
        let mut external = text_node(None, "", "External");
        external.completed = true;

        let report = merge_topic_doc(&mut connection, &topic_with(vec![external]))
            .expect("merge external bullet");

        assert_eq!(report.new_ids_assigned, 1);
        assert!(report.needs_write_back);
        let assigned: (String, String, Option<String>) = connection
            .query_row(
                "SELECT id, hlc, completed_at FROM notes_nodes WHERE parent_id = ?1",
                [TOPIC_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("assigned external node");
        crate::notes::types::validate_note_id(&assigned.0).expect("assigned UUIDv4");
        assert!(Hlc::decode(&assigned.1).is_ok());
        assert!(assigned.1.as_str() > NODE_HLC);
        assert!(crate::notes::sync::topic_file::is_app_timestamp(
            assigned.2.as_deref().expect("completed timestamp")
        ));
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("topic dirtiness"),
            1
        );
    }

    #[test]
    fn root_hlc_is_observed_before_assigning_an_external_uuid_hlc() {
        let mut connection = test_connection();
        let mut document = topic_with(vec![text_node(None, "", "External after root")]);
        document.max_hlc.clear();
        document.root.hlc = FUTURE_HLC.to_string();

        merge_topic_doc(&mut connection, &document)
            .expect("merge external bullet after a root-only HLC maximum");

        let assigned_hlc = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE title = 'External after root'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("assigned external HLC");
        assert!(assigned_hlc.as_str() > FUTURE_HLC);
    }

    #[test]
    fn nested_node_hlc_is_observed_before_recovery_repairs() {
        let mut connection = test_connection();
        let missing_parent_id = "33333333-3333-4333-8333-333333333333";
        let mut document = topic_with(vec![TopicNode {
            children: vec![text_node(Some(NODE_ID), FUTURE_HLC, "Recovered child")],
            ..text_node(Some(missing_parent_id), "", "Unstamped missing parent")
        }]);
        document.max_hlc.clear();

        merge_topic_doc(&mut connection, &document)
            .expect("merge nested evidence below an unstamped missing parent");

        let repaired = connection
            .query_row(
                "SELECT parent_id, hlc FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("repaired nested node");
        assert_eq!(repaired.0, Some(recovery_topic_id()));
        assert!(repaired.1.as_str() > FUTURE_HLC);
    }

    #[test]
    fn document_order_produces_the_same_lww_state() {
        let mut first = test_connection();
        let mut second = test_connection();
        let low = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Low")]);
        let mut high = topic_with(vec![text_node(Some(NODE_ID), HIGH_HLC, "High")]);
        high.max_hlc = HIGH_HLC.to_string();

        merge_topic_doc(&mut first, &low).expect("first low");
        merge_topic_doc(&mut first, &high).expect("first high");
        merge_topic_doc(&mut second, &high).expect("second high");
        merge_topic_doc(&mut second, &low).expect("second low");

        assert_eq!(sync_state(&first), sync_state(&second));
    }

    #[test]
    fn active_and_trash_order_recover_the_same_local_winning_active_child() {
        let mut active_then_trash = test_connection();
        let mut trash_then_active = test_connection();
        let child_id = "77777777-7777-4777-8777-777777777777";
        let child_active_hlc = "0swkd7qz7-00-a3f2";
        let child_trash_hlc = "0swkd7qz5-00-a3f2";
        let mut active = topic_with(vec![TopicNode {
            children: vec![text_node(Some(child_id), child_active_hlc, "Active child")],
            ..text_node(Some(NODE_ID), NODE_HLC, "Parent")
        }]);
        active.max_hlc = child_active_hlc.to_string();
        let trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![TopicNode {
                children: vec![text_node(
                    Some(child_id),
                    child_trash_hlc,
                    "Stale deleted child",
                )],
                ..text_node(Some(NODE_ID), HIGH_HLC, "Deleted parent")
            }],
        };

        merge_topic_doc(&mut active_then_trash, &active).expect("seed active tree first");
        merge_trash_doc(&mut active_then_trash, &trash).expect("merge trash second");
        merge_trash_doc(&mut trash_then_active, &trash).expect("seed trash tree first");
        merge_topic_doc(&mut trash_then_active, &active).expect("merge active tree second");

        assert_eq!(
            reachable_lifecycle_state(&active_then_trash),
            reachable_lifecycle_state(&trash_then_active)
        );
        for connection in [&active_then_trash, &trash_then_active] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT parent_id, deleted_at, archived_at FROM notes_nodes WHERE id = ?1",
                        [child_id],
                        |row| {
                            Ok((
                                row.get::<_, Option<String>>(0)?,
                                row.get::<_, Option<String>>(1)?,
                                row.get::<_, Option<String>>(2)?,
                            ))
                        },
                    )
                    .expect("reachable active child"),
                (Some(recovery_topic_id()), None, None)
            );
        }
    }

    #[test]
    fn omitted_trash_child_matches_reverse_order_recovery_state() {
        let mut omitted_after_active = test_connection();
        let mut reverse_order = test_connection();
        let child_id = "77777777-7777-4777-8777-777777777777";
        let child_active_hlc = "0swkd7qz7-00-a3f2";
        let child_trash_hlc = "0swkd7qz5-00-a3f2";
        let mut active = topic_with(vec![TopicNode {
            children: vec![text_node(Some(child_id), child_active_hlc, "Active child")],
            ..text_node(Some(NODE_ID), NODE_HLC, "Parent")
        }]);
        active.max_hlc = child_active_hlc.to_string();
        let parent_only_trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![text_node(Some(NODE_ID), HIGH_HLC, "Deleted parent")],
        };
        let full_trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![TopicNode {
                children: vec![text_node(
                    Some(child_id),
                    child_trash_hlc,
                    "Stale deleted child",
                )],
                ..text_node(Some(NODE_ID), HIGH_HLC, "Deleted parent")
            }],
        };

        merge_topic_doc(&mut omitted_after_active, &active)
            .expect("seed omitted-order active tree");
        merge_trash_doc(&mut omitted_after_active, &parent_only_trash)
            .expect("merge parent-only trash");
        merge_trash_doc(&mut reverse_order, &full_trash).expect("seed reverse-order trash tree");
        merge_topic_doc(&mut reverse_order, &active).expect("merge reverse-order active tree");

        assert_eq!(
            reachable_lifecycle_state(&omitted_after_active),
            reachable_lifecycle_state(&reverse_order)
        );
        assert_eq!(
            omitted_after_active
                .query_row(
                    "SELECT parent_id, deleted_at, archived_at FROM notes_nodes WHERE id = ?1",
                    [child_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .expect("omitted reachable active child"),
            (Some(recovery_topic_id()), None, None)
        );
    }

    #[test]
    fn affected_integrity_handles_more_ids_than_sqlite_variable_limit() {
        const SQLITE_VARIABLE_LIMIT: usize = 32_766;

        let mut connection = test_connection();
        let child_id = "77777777-7777-4777-8777-777777777777";
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("start oversized affected-set transaction");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, deleted_at, \
                   deleted_batch_id, hlc\
                 ) VALUES (?1, NULL, 1024, 'Deleted parent', ?2, ?2, ?2, 'batch', ?3)",
                params![NODE_ID, SYNC_TIMESTAMP_FALLBACK, HIGH_HLC],
            )
            .expect("insert deleted parent");
        transaction
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, hlc\
                 ) VALUES (?1, ?2, 1024, 'Active child', ?3, ?3, ?4)",
                params![child_id, NODE_ID, SYNC_TIMESTAMP_FALLBACK, NODE_HLC],
            )
            .expect("insert active child");
        let mut affected_ids = (0..SQLITE_VARIABLE_LIMIT)
            .map(|index| format!("seed-{index:05}"))
            .collect::<BTreeSet<_>>();
        affected_ids.insert(NODE_ID.to_string());
        let mut report = MergeReport::default();
        let mut rebuilt_ids = BTreeSet::new();

        repair_affected_active_tree_integrity(
            &transaction,
            &affected_ids,
            &mut report,
            &mut rebuilt_ids,
        )
        .expect("repair an affected set above SQLite's variable limit");

        assert_eq!(
            transaction
                .query_row(
                    "SELECT parent_id, deleted_at, archived_at FROM notes_nodes WHERE id = ?1",
                    [child_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .expect("repaired active child"),
            (Some(recovery_topic_id()), None, None)
        );
        assert!(report.needs_write_back);
        assert!(rebuilt_ids.contains(child_id));
    }

    #[test]
    fn sort_key_collision_uses_id_tie_break_without_rewriting_absent_nodes() {
        let mut first = test_connection();
        let mut second = test_connection();
        let later_id = "77777777-7777-4777-8777-777777777777";
        let low = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Low ID")]);
        let mut high = topic_with(vec![text_node(Some(later_id), HIGH_HLC, "High ID")]);
        high.max_hlc = HIGH_HLC.to_string();

        merge_topic_doc(&mut first, &low).expect("first low-ID document");
        let high_report = merge_topic_doc(&mut first, &high).expect("first high-ID document");
        let repeated = merge_topic_doc(&mut first, &high).expect("repeat high-ID document");
        merge_topic_doc(&mut second, &high).expect("second high-ID document");
        merge_topic_doc(&mut second, &low).expect("second low-ID document");

        assert!(high_report.needs_write_back);
        assert_eq!(repeated.applied, 0);
        assert!(repeated.needs_write_back);
        assert_eq!(sync_state(&first), sync_state(&second));
        assert_eq!(
            load_workspace(&first, NotesWorkspaceScope::Active)
                .expect("load deterministic workspace")
                .nodes
                .into_iter()
                .filter(|node| node.parent_id.as_deref() == Some(TOPIC_ID))
                .map(|node| (node.id, node.sort_key))
                .collect::<Vec<_>>(),
            vec![
                (NODE_ID.to_string(), SORT_KEY_STEP),
                (later_id.to_string(), SORT_KEY_STEP),
            ]
        );
        assert_eq!(
            first
                .query_row(
                    "SELECT hlc FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("unchanged low-ID HLC"),
            NODE_HLC
        );
    }

    #[test]
    fn purge_tombstone_deletes_older_rows_and_blocks_stale_recreation() {
        let mut connection = test_connection();
        let topic = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Before purge")]);
        merge_topic_doc(&mut connection, &topic).expect("seed node");
        let trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: vec![PurgedTombstone {
                id: NODE_ID.to_string(),
                hlc: HIGH_HLC.to_string(),
            }],
            nodes: Vec::new(),
        };

        merge_trash_doc(&mut connection, &trash).expect("apply purge");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("purged row count"),
            0
        );
        let report = merge_topic_doc(&mut connection, &topic).expect("merge stale topic");
        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT purged_hlc FROM sync_purged_tombstones WHERE node_id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("purge evidence"),
            HIGH_HLC
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("stale row count"),
            0
        );
    }

    #[test]
    fn purge_hlc_is_observed_before_recovery_topic_reactivation() {
        let mut connection = test_connection();
        let recovery_id = {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("start recovery fixture transaction");
            let recovery_id =
                ensure_recovery_topic(&transaction).expect("create recovery topic fixture");
            transaction.commit().expect("commit recovery fixture");
            recovery_id
        };
        connection
            .execute(
                "UPDATE notes_nodes SET hlc = ?1 WHERE id = ?2",
                params![ROOT_HLC, recovery_id],
            )
            .expect("age recovery topic below purge evidence");
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, hlc\
                 ) VALUES (?1, ?2, ?3, 'Survivor', ?4, ?4, ?5)",
                params![
                    NODE_ID,
                    recovery_id,
                    SORT_KEY_STEP,
                    SYNC_TIMESTAMP_FALLBACK,
                    HIGH_HLC
                ],
            )
            .expect("seed recovery child survivor");
        let trash = TrashDoc {
            max_hlc: String::new(),
            purged: vec![PurgedTombstone {
                id: recovery_id.clone(),
                hlc: FUTURE_HLC.to_string(),
            }],
            nodes: Vec::new(),
        };

        merge_trash_doc(&mut connection, &trash)
            .expect("reactivate recovery topic above incoming purge evidence");

        let recovery_hlc = connection
            .query_row(
                "SELECT hlc FROM notes_nodes WHERE id = ?1",
                [&recovery_id],
                |row| row.get::<_, String>(0),
            )
            .expect("surviving recovery topic");
        assert!(recovery_hlc.as_str() > FUTURE_HLC);
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, Option<String>>(0),
                )
                .expect("parked survivor parent"),
            Some(recovery_id)
        );
    }

    #[test]
    fn attachment_id_collision_rolls_back_the_whole_merge() {
        let mut connection = test_connection();
        let collision_owner = "44444444-4444-4444-8444-444444444444";
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, hlc\
                 ) VALUES (?1, NULL, 1024, 'owner', ?2, ?2, ?3)",
                params![collision_owner, SYNC_TIMESTAMP_FALLBACK, HIGH_HLC],
            )
            .expect("insert collision owner");
        let collision_id = deterministic_attachment_id(NODE_ID);
        connection
            .execute(
                "INSERT INTO notes_attachments(\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (?1, ?2, 1024, ?3, ?4, 'owner.png', 'image/png', 0, 0, 0, 0, ?5, ?5)",
                params![
                    collision_id,
                    collision_owner,
                    format!("notes-assets/{}.png", "b".repeat(64)),
                    "b".repeat(64),
                    SYNC_TIMESTAMP_FALLBACK,
                ],
            )
            .expect("insert colliding attachment");
        let image = TopicNode {
            content: TopicContent::Image {
                before: String::new(),
                attachment: TopicAttachment {
                    content_hash: "a".repeat(64),
                    extension: "png".to_string(),
                    encoded_original_name: "target.png".to_string(),
                    display_width: None,
                },
                after: String::new(),
            },
            ..text_node(Some(NODE_ID), NODE_HLC, "")
        };

        assert!(merge_topic_doc(&mut connection, &topic_with(vec![image])).is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id IN (?1, ?2)",
                    params![TOPIC_ID, NODE_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("rolled back node count"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT node_id FROM notes_attachments WHERE id = ?1",
                    [collision_id],
                    |row| row.get::<_, String>(0),
                )
                .expect("collision owner preserved"),
            collision_owner
        );
    }

    #[test]
    fn attachment_id_node_namespace_collision_rolls_back_the_whole_merge() {
        let mut connection = test_connection();
        let collision_id = deterministic_attachment_id(NODE_ID);
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, hlc\
                 ) VALUES (?1, NULL, 1024, 'namespace owner', ?2, ?2, ?3)",
                params![collision_id, SYNC_TIMESTAMP_FALLBACK, HIGH_HLC],
            )
            .expect("insert namespace collision");
        let image = TopicNode {
            content: TopicContent::Image {
                before: String::new(),
                attachment: TopicAttachment {
                    content_hash: "d".repeat(64),
                    extension: "png".to_string(),
                    encoded_original_name: "target.png".to_string(),
                    display_width: None,
                },
                after: String::new(),
            },
            ..text_node(Some(NODE_ID), NODE_HLC, "")
        };

        assert!(merge_topic_doc(&mut connection, &topic_with(vec![image])).is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id IN (?1, ?2)",
                    params![TOPIC_ID, NODE_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("rolled back merge nodes"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [collision_id],
                    |row| row.get::<_, String>(0),
                )
                .expect("namespace owner survives"),
            "namespace owner"
        );
    }

    #[test]
    fn remote_node_id_attachment_namespace_collision_rolls_back_the_whole_merge() {
        let mut connection = test_connection();
        let owner_id = "44444444-4444-4444-8444-444444444444";
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, hlc\
                 ) VALUES (?1, NULL, 1024, 'attachment owner', ?2, ?2, ?3)",
                params![owner_id, SYNC_TIMESTAMP_FALLBACK, HIGH_HLC],
            )
            .expect("insert attachment owner");
        connection
            .execute(
                "INSERT INTO notes_attachments(\
                   id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                   byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                 ) VALUES (?1, ?2, 1024, ?3, ?4, 'existing.png', 'image/png', 0, 0, 0, 0, ?5, ?5)",
                params![
                    NODE_ID,
                    owner_id,
                    format!("notes-assets/{}.png", "b".repeat(64)),
                    "b".repeat(64),
                    SYNC_TIMESTAMP_FALLBACK,
                ],
            )
            .expect("insert colliding attachment ID");

        assert!(merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Collision")]),
        )
        .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("rolled back topic root"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT node_id FROM notes_attachments WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("colliding attachment preserved"),
            owner_id
        );
    }

    #[test]
    fn attachment_vault_capacity_failure_rolls_back_the_whole_merge() {
        let mut connection = test_connection();
        let owner_id = "44444444-4444-4444-8444-444444444444";
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, hlc\
                 ) VALUES (?1, NULL, 1024, 'capacity owner', ?2, ?2, ?3)",
                params![owner_id, SYNC_TIMESTAMP_FALLBACK, HIGH_HLC],
            )
            .expect("insert capacity owner");
        for index in 0..crate::notes::types::MAX_NOTE_ATTACHMENTS_PER_VAULT {
            let attachment_id = format!("00000000-0000-4000-8000-{index:012x}");
            connection
                .execute(
                    "INSERT INTO notes_attachments(\
                       id, node_id, sort_key, relative_path, content_hash, original_name, mime_type, \
                       byte_size, intrinsic_width, intrinsic_height, display_width, created_at, updated_at\
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 'full.png', 'image/png', 0, 0, 0, 0, ?6, ?6)",
                    params![
                        attachment_id,
                        owner_id,
                        index + 1,
                        format!("notes-assets/{index:064x}.png"),
                        format!("{index:064x}"),
                        SYNC_TIMESTAMP_FALLBACK,
                    ],
                )
                .expect("fill attachment capacity");
        }
        let image = TopicNode {
            content: TopicContent::Image {
                before: String::new(),
                attachment: TopicAttachment {
                    content_hash: "e".repeat(64),
                    extension: "png".to_string(),
                    encoded_original_name: "overflow.png".to_string(),
                    display_width: None,
                },
                after: String::new(),
            },
            ..text_node(Some(NODE_ID), NODE_HLC, "")
        };

        assert!(merge_topic_doc(&mut connection, &topic_with(vec![image])).is_err());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_attachments", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("attachment count"),
            crate::notes::types::MAX_NOTE_ATTACHMENTS_PER_VAULT
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id IN (?1, ?2)",
                    params![TOPIC_ID, NODE_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("rolled back merge nodes"),
            0
        );
    }

    #[test]
    fn duplicate_node_identity_rolls_back_the_whole_document() {
        let mut connection = test_connection();
        let document = topic_with(vec![
            text_node(Some(NODE_ID), NODE_HLC, "First"),
            TopicNode {
                sibling_ordinal: 2,
                sort_key: 2 * crate::notes::repository::SORT_KEY_STEP,
                ..text_node(Some(NODE_ID), HIGH_HLC, "Duplicate")
            },
        ]);

        assert!(merge_topic_doc(&mut connection, &document).is_err());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes_nodes", [], |row| row
                    .get::<_, i64>(0))
                .expect("rolled back node count"),
            0
        );
    }

    #[test]
    fn two_databases_exchanging_documents_converge() {
        let mut first = test_connection();
        let mut second = test_connection();
        let first_only = "55555555-5555-4555-8555-555555555555";
        let second_only = "66666666-6666-4666-8666-666666666666";
        let first_document = rendered_topic(&topic_with(vec![
            text_node(Some(NODE_ID), NODE_HLC, "Shared low"),
            TopicNode {
                sibling_ordinal: 2,
                sort_key: 2 * crate::notes::repository::SORT_KEY_STEP,
                ..text_node(Some(first_only), NODE_HLC, "First only")
            },
        ]));
        let mut second_document = topic_with(vec![
            text_node(Some(NODE_ID), HIGH_HLC, "Shared high"),
            TopicNode {
                sibling_ordinal: 2,
                sort_key: 2 * crate::notes::repository::SORT_KEY_STEP,
                ..text_node(Some(second_only), HIGH_HLC, "Second only")
            },
        ]);
        second_document.max_hlc = HIGH_HLC.to_string();
        let second_document = rendered_topic(&second_document);

        merge_topic_doc(&mut first, &first_document).expect("seed first database");
        merge_topic_doc(&mut second, &second_document).expect("seed second database");
        merge_topic_doc(&mut first, &second_document).expect("first receives second");
        merge_topic_doc(&mut second, &first_document).expect("second receives first");

        assert_eq!(sync_state(&first), sync_state(&second));
        assert_eq!(sync_state(&first).len(), 4);
    }

    #[test]
    fn attachment_ids_are_deterministic_v4_shape_across_databases() {
        let mut first = test_connection();
        let mut second = test_connection();
        let image = TopicNode {
            content: TopicContent::Image {
                before: "A".to_string(),
                attachment: TopicAttachment {
                    content_hash: "c".repeat(64),
                    extension: "webp".to_string(),
                    encoded_original_name: "same.webp".to_string(),
                    display_width: None,
                },
                after: "B".to_string(),
            },
            ..text_node(Some(NODE_ID), NODE_HLC, "")
        };
        let document = topic_with(vec![image]);

        merge_topic_doc(&mut first, &document).expect("merge first image");
        merge_topic_doc(&mut second, &document).expect("merge second image");
        let id = |connection: &Connection| {
            connection
                .query_row(
                    "SELECT id FROM notes_attachments WHERE node_id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("attachment ID")
        };
        let first_id = id(&first);
        assert_eq!(first_id, id(&second));
        crate::notes::types::validate_note_id(&first_id).expect("v4-shaped deterministic ID");
    }

    #[test]
    fn cycle_parks_the_lowest_hlc_move_under_the_lazy_recovery_topic() {
        let mut connection = test_connection();
        let a_id = NODE_ID;
        let b_id = "77777777-7777-4777-8777-777777777777";
        let c_id = "88888888-8888-4888-8888-888888888888";
        let a_high = "0swkd7qz8-00-a3f2";
        let b_move = "0swkd7qz5-00-a3f2";
        let c_move = "0swkd7qz6-00-a3f2";
        let initial = topic_with(vec![
            TopicNode {
                children: vec![text_node(Some(a_id), a_high, "A")],
                ..text_node(Some(c_id), NODE_HLC, "C")
            },
            TopicNode {
                sibling_ordinal: 2,
                sort_key: 2 * crate::notes::repository::SORT_KEY_STEP,
                ..text_node(Some(b_id), NODE_HLC, "B")
            },
        ]);
        let mut initial = initial;
        initial.max_hlc = a_high.to_string();
        merge_topic_doc(&mut connection, &initial).expect("seed cycle fixture");
        let mut remote = topic_with(vec![TopicNode {
            children: vec![TopicNode {
                children: vec![text_node(Some(c_id), c_move, "C")],
                ..text_node(Some(b_id), b_move, "B")
            }],
            ..text_node(Some(a_id), "0swkd7qz7-00-a3f2", "A")
        }]);
        remote.max_hlc = "0swkd7qz7-00-a3f2".to_string();

        let report = merge_topic_doc(&mut connection, &remote).expect("merge cyclic moves");

        assert_eq!(report.parked_cycles, 1);
        assert!(report.needs_write_back);
        let recovery_id = recovery_topic_id();
        let recovery: (Option<String>, String) = connection
            .query_row(
                "SELECT parent_id, title FROM notes_nodes WHERE id = ?1",
                [&recovery_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("recovery topic");
        assert_eq!(recovery, (None, "복구됨".to_string()));
        let parked: (Option<String>, String) = connection
            .query_row(
                "SELECT parent_id, hlc FROM notes_nodes WHERE id = ?1",
                [b_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("parked move");
        assert_eq!(parked.0.as_deref(), Some(recovery_id.as_str()));
        assert!(parked.1.as_str() > remote.max_hlc.as_str());
    }

    #[test]
    fn archived_cycle_parks_a_coherent_active_subtree_without_restoring_trash() {
        let mut connection = test_connection();
        let a_id = NODE_ID;
        let b_id = "77777777-7777-4777-8777-777777777777";
        let c_id = "88888888-8888-4888-8888-888888888888";
        let deleted_id = "99999999-9999-4999-8999-999999999999";
        let a_high = "0swkd7qz8-00-a3f2";
        let b_move = "0swkd7qz5-00-a3f2";
        let c_move = "0swkd7qz6-00-a3f2";
        let archived_at = "2026-07-21T00:00:00.000Z";
        let mut initial = topic_with(vec![
            TopicNode {
                children: vec![text_node(Some(a_id), a_high, "A")],
                ..text_node(Some(c_id), NODE_HLC, "C")
            },
            TopicNode {
                sibling_ordinal: 2,
                sort_key: 2 * SORT_KEY_STEP,
                ..text_node(Some(b_id), NODE_HLC, "B")
            },
        ]);
        initial.root.archived_at = Some(archived_at.to_string());
        initial.max_hlc = a_high.to_string();
        merge_topic_doc(&mut connection, &initial).expect("seed archived cycle fixture");
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, deleted_at, \
                   deleted_batch_id, hlc\
                 ) VALUES (?1, ?2, ?3, 'Deleted child', ?4, ?4, ?4, 'local-delete', ?5)",
                params![
                    deleted_id,
                    c_id,
                    SORT_KEY_STEP,
                    SYNC_TIMESTAMP_FALLBACK,
                    HIGH_HLC
                ],
            )
            .expect("seed deleted descendant");
        let mut remote = topic_with(vec![TopicNode {
            children: vec![TopicNode {
                children: vec![text_node(Some(c_id), c_move, "C")],
                ..text_node(Some(b_id), b_move, "B")
            }],
            ..text_node(Some(a_id), "0swkd7qz7-00-a3f2", "A")
        }]);
        remote.root.archived_at = Some(archived_at.to_string());
        remote.max_hlc = "0swkd7qz7-00-a3f2".to_string();

        merge_topic_doc(&mut connection, &remote).expect("repair archived cycle");

        let recovery_id = recovery_topic_id();
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [b_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .expect("parked archived move"),
            Some(recovery_id)
        );
        for node_id in [a_id, b_id, c_id] {
            let lifecycle = connection
                .query_row(
                    "SELECT deleted_at, archived_at, archive_root_id, hlc \
                     FROM notes_nodes WHERE id = ?1",
                    [node_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .expect("parked subtree lifecycle");
            assert_eq!(lifecycle.0, None);
            assert_eq!(lifecycle.1, None);
            assert_eq!(lifecycle.2, None);
            assert!(lifecycle.3.as_str() > a_high);
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                        [node_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("parked subtree dirtiness"),
                1
            );
        }
        assert!(connection
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM notes_nodes WHERE id = ?1",
                [deleted_id],
                |row| row.get::<_, bool>(0),
            )
            .expect("deleted descendant lifecycle"));
    }

    #[test]
    fn trash_cycle_parks_the_lowest_move_without_restoring_deleted_nodes() {
        let mut connection = test_connection();
        let x_id = NODE_ID;
        let y_id = "77777777-7777-4777-8777-777777777777";
        let x_move_hlc = "0swkd7qz5-00-a3f2";
        let y_move_hlc = "0swkd7qz6-00-a3f2";
        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                max_hlc: NODE_HLC.to_string(),
                purged: Vec::new(),
                nodes: vec![
                    text_node(Some(x_id), NODE_HLC, "X"),
                    TopicNode {
                        sibling_ordinal: 2,
                        sort_key: 2 * SORT_KEY_STEP,
                        ..text_node(Some(y_id), NODE_HLC, "Y")
                    },
                ],
            },
        )
        .expect("seed trash cycle fixture");
        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                max_hlc: x_move_hlc.to_string(),
                purged: Vec::new(),
                nodes: vec![TopicNode {
                    children: vec![text_node(Some(x_id), x_move_hlc, "X")],
                    ..text_node(Some(y_id), NODE_HLC, "Y")
                }],
            },
        )
        .expect("move X below Y");
        let report = merge_trash_doc(
            &mut connection,
            &TrashDoc {
                max_hlc: y_move_hlc.to_string(),
                purged: Vec::new(),
                nodes: vec![TopicNode {
                    children: vec![text_node(Some(y_id), y_move_hlc, "Y")],
                    ..text_node(Some(x_id), x_move_hlc, "X")
                }],
            },
        )
        .expect("repair trash cycle");

        assert_eq!(report.parked_cycles, 1);
        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, deleted_at IS NOT NULL, deleted_batch_id IS NOT NULL \
                     FROM notes_nodes WHERE id = ?1",
                    [x_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, bool>(1)?,
                            row.get::<_, bool>(2)?,
                        ))
                    },
                )
                .expect("parked trash move"),
            (Some(recovery_topic_id()), true, true)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, deleted_at IS NOT NULL FROM notes_nodes WHERE id = ?1",
                    [y_id],
                    |row| { Ok((row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?,)) },
                )
                .expect("deleted trash descendant"),
            (Some(x_id.to_string()), true)
        );
    }

    #[test]
    fn existing_recovery_topic_is_reactivated_before_parking() {
        let mut connection = test_connection();
        let recovery_id = {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("start recovery seed");
            let recovery_id = ensure_recovery_topic(&transaction).expect("create recovery topic");
            transaction.commit().expect("commit recovery seed");
            recovery_id
        };
        connection
            .execute(
                "UPDATE notes_nodes SET \
                   deleted_at = ?1, deleted_batch_id = 'batch', archived_at = ?1, \
                   archive_root_id = id, hlc = ?2 \
                 WHERE id = ?3",
                params!["2026-07-21T00:00:00.000Z", HIGH_HLC, recovery_id],
            )
            .expect("hide recovery topic");

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("start recovery reactivation");
        ensure_recovery_topic(&transaction).expect("reactivate recovery topic");
        transaction.commit().expect("commit recovery reactivation");

        let lifecycle = connection
            .query_row(
                "SELECT deleted_at, deleted_batch_id, archived_at, archive_root_id \
                 FROM notes_nodes WHERE id = ?1",
                [&recovery_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .expect("visible recovery lifecycle");
        assert_eq!(lifecycle, (None, None, None, None));
    }

    #[test]
    fn renamed_recovery_topic_is_normalized_before_reuse() {
        let mut connection = test_connection();
        let recovery_id = {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("start recovery seed");
            let recovery_id = ensure_recovery_topic(&transaction).expect("create recovery topic");
            transaction.commit().expect("commit recovery seed");
            recovery_id
        };
        connection
            .execute(
                "UPDATE notes_nodes SET title = 'Renamed recovery', hlc = ?1 WHERE id = ?2",
                params![HIGH_HLC, recovery_id],
            )
            .expect("rename recovery topic");

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("start recovery normalization");
        ensure_recovery_topic(&transaction).expect("normalize recovery topic");
        transaction.commit().expect("commit recovery normalization");

        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [&recovery_id],
                    |row| row.get::<_, String>(0),
                )
                .expect("normalized recovery title"),
            "복구됨"
        );
    }

    #[test]
    fn recovery_topic_is_restamped_above_a_winning_purge_before_parking() {
        let mut connection = test_connection();
        let recovery_id = {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .expect("start recovery seed");
            let recovery_id = ensure_recovery_topic(&transaction).expect("create recovery topic");
            transaction.commit().expect("commit recovery seed");
            recovery_id
        };
        connection
            .execute(
                "UPDATE notes_nodes SET hlc = ?1 WHERE id = ?2",
                params![ROOT_HLC, recovery_id],
            )
            .expect("age recovery root");
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, hlc\
                 ) VALUES (?1, ?2, 1024, 'survivor', ?3, ?3, ?4)",
                params![NODE_ID, recovery_id, SYNC_TIMESTAMP_FALLBACK, HIGH_HLC],
            )
            .expect("insert newer recovery child");

        let report = merge_trash_doc(
            &mut connection,
            &TrashDoc {
                max_hlc: NODE_HLC.to_string(),
                purged: vec![PurgedTombstone {
                    id: recovery_id.clone(),
                    hlc: NODE_HLC.to_string(),
                }],
                nodes: Vec::new(),
            },
        )
        .expect("protect active recovery root from winning purge");

        assert!(report.needs_write_back);
        assert!(
            connection
                .query_row(
                    "SELECT hlc FROM notes_nodes WHERE id = ?1",
                    [&recovery_id],
                    |row| row.get::<_, String>(0),
                )
                .expect("surviving recovery root")
                .as_str()
                > NODE_HLC
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, Option<String>>(0),
                )
                .expect("surviving recovery child")
                .as_deref(),
            Some(recovery_id.as_str())
        );
    }

    #[test]
    fn concurrent_two_device_cycle_parks_the_same_global_lowest_hlc_edge() {
        let mut first = test_connection();
        let mut second = test_connection();
        let x_id = NODE_ID;
        let y_id = "77777777-7777-4777-8777-777777777777";
        let x_move_hlc = "0swkd7qz5-00-a3f2";
        let y_move_hlc = "0swkd7qz6-00-b4e3";
        let base = topic_with(vec![
            text_node(Some(x_id), NODE_HLC, "X"),
            TopicNode {
                sibling_ordinal: 2,
                sort_key: 2 * SORT_KEY_STEP,
                ..text_node(Some(y_id), NODE_HLC, "Y")
            },
        ]);
        merge_topic_doc(&mut first, &base).expect("seed first cycle database");
        merge_topic_doc(&mut second, &base).expect("seed second cycle database");
        let mut x_under_y = topic_with(vec![TopicNode {
            children: vec![text_node(Some(x_id), x_move_hlc, "X")],
            ..text_node(Some(y_id), NODE_HLC, "Y")
        }]);
        x_under_y.max_hlc = x_move_hlc.to_string();
        let mut y_under_x = topic_with(vec![TopicNode {
            children: vec![text_node(Some(y_id), y_move_hlc, "Y")],
            ..text_node(Some(x_id), NODE_HLC, "X")
        }]);
        y_under_x.max_hlc = y_move_hlc.to_string();

        merge_topic_doc(&mut first, &x_under_y).expect("first local move");
        merge_topic_doc(&mut second, &y_under_x).expect("second local move");
        merge_topic_doc(&mut first, &y_under_x).expect("first receives concurrent move");
        merge_topic_doc(&mut second, &x_under_y).expect("second receives concurrent move");

        let recovery_id = recovery_topic_id();
        for connection in [&first, &second] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                        [x_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .expect("parked global-lowest edge")
                    .as_deref(),
                Some(recovery_id.as_str())
            );
        }
    }

    #[test]
    fn stale_document_for_a_purged_topic_root_is_a_successful_no_op() {
        let mut connection = test_connection();
        let document = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Child")]);
        merge_topic_doc(&mut connection, &document).expect("seed purged topic");
        let trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: vec![
                PurgedTombstone {
                    id: TOPIC_ID.to_string(),
                    hlc: HIGH_HLC.to_string(),
                },
                PurgedTombstone {
                    id: NODE_ID.to_string(),
                    hlc: HIGH_HLC.to_string(),
                },
            ],
            nodes: Vec::new(),
        };
        merge_trash_doc(&mut connection, &trash).expect("purge topic tree");

        let report = merge_topic_doc(&mut connection, &document).expect("merge stale topic");

        assert_eq!(report.applied, 0);
        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id IN (?1, ?2)",
                    params![TOPIC_ID, NODE_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("stale topic rows"),
            0
        );
    }

    #[test]
    fn newer_topic_descendant_survives_a_previously_purged_parent() {
        let mut connection = test_connection();
        let child_hlc = "0swkd7qz8-00-a3f2";
        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                max_hlc: HIGH_HLC.to_string(),
                purged: vec![PurgedTombstone {
                    id: TOPIC_ID.to_string(),
                    hlc: HIGH_HLC.to_string(),
                }],
                nodes: Vec::new(),
            },
        )
        .expect("record prior topic-root purge");
        let mut stale_parent = topic_with(vec![text_node(
            Some(NODE_ID),
            child_hlc,
            "Newer descendant",
        )]);
        stale_parent.max_hlc = child_hlc.to_string();

        let report = merge_topic_doc(&mut connection, &stale_parent)
            .expect("merge newer descendant below purged topic root");

        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, Option<String>>(0),
                )
                .expect("recovered topic descendant")
                .as_deref(),
            Some(recovery_topic_id().as_str())
        );
    }

    #[test]
    fn equal_hlc_local_root_is_not_reparented_for_a_missing_remote_parent() {
        let mut connection = test_connection();
        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                max_hlc: HIGH_HLC.to_string(),
                purged: vec![PurgedTombstone {
                    id: TOPIC_ID.to_string(),
                    hlc: HIGH_HLC.to_string(),
                }],
                nodes: Vec::new(),
            },
        )
        .expect("record missing remote parent purge");
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, hlc\
                 ) VALUES (?1, NULL, 1024, 'Local root', ?2, ?2, ?3)",
                params![NODE_ID, SYNC_TIMESTAMP_FALLBACK, NODE_HLC],
            )
            .expect("insert equal-HLC local root");
        let document = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Local root")]);

        let report = merge_topic_doc(&mut connection, &document)
            .expect("preserve equal-HLC local root placement");

        assert_eq!(report.applied, 0);
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, hlc FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| { Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?,)) },
                )
                .expect("equal-HLC local root"),
            (None, NODE_HLC.to_string())
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [recovery_topic_id()],
                    |row| row.get::<_, i64>(0),
                )
                .expect("unexpected recovery topic"),
            0
        );
    }

    #[test]
    fn newer_active_descendant_of_a_soft_deleted_parent_is_recovered() {
        let mut connection = test_connection();
        let child_id = "77777777-7777-4777-8777-777777777777";
        let child_hlc = "0swkd7qz8-00-a3f2";
        merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Parent")]),
        )
        .expect("seed active parent");
        connection
            .execute(
                "UPDATE notes_nodes SET deleted_at = ?1, deleted_batch_id = 'local-delete', hlc = ?2 \
                 WHERE id = ?3",
                params!["2026-07-21T00:00:00.000Z", HIGH_HLC, NODE_ID],
            )
            .expect("soft-delete parent with newer HLC");
        let mut stale_parent = topic_with(vec![TopicNode {
            children: vec![text_node(Some(child_id), child_hlc, "Visible child")],
            ..text_node(Some(NODE_ID), NODE_HLC, "Parent")
        }]);
        stale_parent.max_hlc = child_hlc.to_string();

        merge_topic_doc(&mut connection, &stale_parent)
            .expect("merge child below losing soft-deleted parent");

        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, deleted_at, archived_at FROM notes_nodes WHERE id = ?1",
                    [child_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .expect("visible recovered child"),
            (Some(recovery_topic_id()), None, None)
        );
    }

    #[test]
    fn newer_active_descendant_of_an_archived_parent_is_recovered() {
        let mut connection = test_connection();
        let child_id = "77777777-7777-4777-8777-777777777777";
        let child_hlc = "0swkd7qz8-00-a3f2";
        merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Parent")]),
        )
        .expect("seed active parent");
        connection
            .execute(
                "UPDATE notes_nodes SET \
                   parent_id = NULL, archived_at = ?1, archive_root_id = id, hlc = ?2 \
                 WHERE id = ?3",
                params!["2026-07-21T00:00:00.000Z", HIGH_HLC, NODE_ID],
            )
            .expect("archive parent with newer HLC");
        let mut stale_parent = topic_with(vec![TopicNode {
            children: vec![text_node(Some(child_id), child_hlc, "Visible child")],
            ..text_node(Some(NODE_ID), NODE_HLC, "Parent")
        }]);
        stale_parent.max_hlc = child_hlc.to_string();

        merge_topic_doc(&mut connection, &stale_parent)
            .expect("merge child below losing archived parent");

        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, deleted_at, archived_at FROM notes_nodes WHERE id = ?1",
                    [child_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .expect("visible recovered child"),
            (Some(recovery_topic_id()), None, None)
        );
    }

    #[test]
    fn newer_trash_descendant_keeps_trash_semantics_under_a_deleted_parent() {
        let mut connection = test_connection();
        let child_id = "77777777-7777-4777-8777-777777777777";
        let child_hlc = "0swkd7qz8-00-a3f2";
        connection
            .execute(
                "INSERT INTO notes_nodes(\
                   id, parent_id, sort_key, title, created_at, updated_at, deleted_at, \
                   deleted_batch_id, hlc\
                 ) VALUES (?1, NULL, 1024, 'Deleted parent', ?2, ?2, ?2, 'local-delete', ?3)",
                params![NODE_ID, SYNC_TIMESTAMP_FALLBACK, HIGH_HLC],
            )
            .expect("seed newer deleted parent");
        let trash = TrashDoc {
            max_hlc: child_hlc.to_string(),
            purged: Vec::new(),
            nodes: vec![TopicNode {
                children: vec![text_node(Some(child_id), child_hlc, "Deleted child")],
                ..text_node(Some(NODE_ID), NODE_HLC, "Deleted parent")
            }],
        };

        merge_trash_doc(&mut connection, &trash)
            .expect("merge trash child below winning deleted parent");

        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, deleted_at IS NOT NULL FROM notes_nodes WHERE id = ?1",
                    [child_id],
                    |row| { Ok((row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?,)) },
                )
                .expect("deleted child lifecycle"),
            (Some(NODE_ID.to_string()), true)
        );
    }

    #[test]
    fn nested_newer_descendant_below_a_purged_archived_root_loses_archive_context() {
        let mut connection = test_connection();
        let grandchild_id = "77777777-7777-4777-8777-777777777777";
        let child_hlc = "0swkd7qz8-00-a3f2";
        let grandchild_hlc = "0swkd7qz9-00-a3f2";
        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                max_hlc: HIGH_HLC.to_string(),
                purged: vec![PurgedTombstone {
                    id: TOPIC_ID.to_string(),
                    hlc: HIGH_HLC.to_string(),
                }],
                nodes: Vec::new(),
            },
        )
        .expect("record archived-root purge");
        let mut stale_archived = topic_with(vec![TopicNode {
            children: vec![text_node(Some(grandchild_id), grandchild_hlc, "Grandchild")],
            ..text_node(Some(NODE_ID), child_hlc, "Recovered child")
        }]);
        stale_archived.root.archived_at = Some("2026-07-21T00:00:00.000Z".to_string());
        stale_archived.max_hlc = grandchild_hlc.to_string();

        merge_topic_doc(&mut connection, &stale_archived)
            .expect("recover nested archived descendants");

        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, archived_at, archive_root_id \
                     FROM notes_nodes WHERE id = ?1",
                    [grandchild_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .expect("active recovered grandchild"),
            (Some(NODE_ID.to_string()), None, None)
        );
    }

    #[test]
    fn purging_an_older_parent_parks_a_newer_child_before_delete() {
        let mut connection = test_connection();
        let child_hlc = "0swkd7qz8-00-a3f2";
        let mut document = topic_with(vec![text_node(Some(NODE_ID), child_hlc, "New child")]);
        document.max_hlc = child_hlc.to_string();
        merge_topic_doc(&mut connection, &document).expect("seed mixed-HLC tree");
        let trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: vec![PurgedTombstone {
                id: TOPIC_ID.to_string(),
                hlc: HIGH_HLC.to_string(),
            }],
            nodes: Vec::new(),
        };

        let report = merge_trash_doc(&mut connection, &trash).expect("purge older parent");

        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("purged parent count"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, Option<String>>(0),
                )
                .expect("parked child parent")
                .as_deref(),
            Some(recovery_topic_id().as_str())
        );
    }

    #[test]
    fn purging_an_archived_root_clears_a_newer_survivors_archive_reference() {
        let mut connection = test_connection();
        let child_hlc = "0swkd7qz8-00-a3f2";
        let mut document = topic_with(vec![text_node(Some(NODE_ID), child_hlc, "Archived child")]);
        document.root.archived_at = Some("2026-07-21T00:00:00.000Z".to_string());
        document.max_hlc = child_hlc.to_string();
        merge_topic_doc(&mut connection, &document).expect("seed archived mixed-HLC tree");
        let trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: vec![PurgedTombstone {
                id: TOPIC_ID.to_string(),
                hlc: HIGH_HLC.to_string(),
            }],
            nodes: Vec::new(),
        };

        let report = merge_trash_doc(&mut connection, &trash).expect("purge archived root");

        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id, archived_at, archive_root_id FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .expect("recovered archived child"),
            (Some(recovery_topic_id()), None, None)
        );
    }

    #[test]
    fn prior_parent_purge_does_not_block_a_newer_trash_descendant() {
        let mut connection = test_connection();
        let child_id = "77777777-7777-4777-8777-777777777777";
        let child_hlc = "0swkd7qz8-00-a3f2";
        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                max_hlc: HIGH_HLC.to_string(),
                purged: vec![PurgedTombstone {
                    id: NODE_ID.to_string(),
                    hlc: HIGH_HLC.to_string(),
                }],
                nodes: Vec::new(),
            },
        )
        .expect("record prior parent purge");
        let stale_tree = TrashDoc {
            max_hlc: child_hlc.to_string(),
            purged: Vec::new(),
            nodes: vec![TopicNode {
                children: vec![text_node(Some(child_id), child_hlc, "Newer descendant")],
                ..text_node(Some(NODE_ID), NODE_HLC, "Purged parent")
            }],
        };

        let report = merge_trash_doc(&mut connection, &stale_tree)
            .expect("merge newer trash descendant after parent purge");

        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("purged parent count"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [child_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .expect("recovered descendant parent")
                .as_deref(),
            Some(recovery_topic_id().as_str())
        );
    }

    #[test]
    fn trash_before_topic_preserves_from_parent_and_converges_with_topic_first() {
        let mut topic_first = test_connection();
        let mut trash_first = test_connection();
        let topic = topic_with(Vec::new());
        let mut deleted = text_node(Some(NODE_ID), HIGH_HLC, "Deleted");
        deleted.from = Some((TOPIC_ID.to_string(), 2 * SORT_KEY_STEP));
        let trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![deleted],
        };

        merge_topic_doc(&mut topic_first, &topic).expect("topic first");
        merge_trash_doc(&mut topic_first, &trash).expect("trash second");
        merge_trash_doc(&mut trash_first, &trash).expect("trash first");
        merge_topic_doc(&mut trash_first, &topic).expect("topic second");

        assert_eq!(sync_state(&topic_first), sync_state(&trash_first));
        assert_eq!(
            trash_first
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, Option<String>>(0),
                )
                .expect("restorable parent")
                .as_deref(),
            Some(TOPIC_ID)
        );
    }

    #[test]
    fn canonical_stamped_reapplication_after_external_assignment_is_a_no_op() {
        let mut connection = test_connection();
        let document = topic_with(vec![text_node(None, "", "External")]);

        let first = merge_topic_doc(&mut connection, &document).expect("first external merge");
        let (assigned_id, assigned_hlc) = connection
            .query_row(
                "SELECT id, hlc FROM notes_nodes WHERE parent_id = ?1",
                [TOPIC_ID],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("assigned external identity");
        let mut stamped = topic_with(vec![text_node(
            Some(&assigned_id),
            &assigned_hlc,
            "External",
        )]);
        stamped.max_hlc = assigned_hlc;
        let stamped = rendered_topic(&stamped);

        let second = merge_topic_doc(&mut connection, &stamped).expect("reapply stamped export");

        assert_eq!(first.new_ids_assigned, 1);
        assert_eq!(second.new_ids_assigned, 0);
        assert_eq!(second.applied, 0);
        assert!(!second.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE parent_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("external child count"),
            1
        );
    }

    #[test]
    fn repeated_unstamped_external_document_assigns_distinct_uuidv4_nodes() {
        let mut connection = test_connection();
        let document = topic_with(vec![text_node(None, "", "External")]);

        let first = merge_topic_doc(&mut connection, &document).expect("first external merge");
        let second = merge_topic_doc(&mut connection, &document).expect("repeat external merge");

        assert_eq!(first.new_ids_assigned, 1);
        assert_eq!(second.new_ids_assigned, 1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE parent_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("distinct external child count"),
            2
        );
    }

    #[test]
    fn repeated_unstamped_external_trash_document_assigns_distinct_uuidv4_nodes() {
        let mut connection = test_connection();
        let trash = TrashDoc {
            max_hlc: NODE_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![text_node(None, "", "External trash")],
        };

        let first = merge_trash_doc(&mut connection, &trash).expect("first external trash merge");
        let second = merge_trash_doc(&mut connection, &trash).expect("repeat external trash merge");

        assert_eq!(first.new_ids_assigned, 1);
        assert_eq!(second.new_ids_assigned, 1);
        assert!(second.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("external trash node count"),
            2
        );
    }

    #[test]
    fn independent_cycle_parks_have_order_independent_recovery_sort_keys() {
        let mut first = test_connection();
        let mut second = test_connection();
        let a_id = NODE_ID;
        let b_id = "77777777-7777-4777-8777-777777777777";
        let c_id = "88888888-8888-4888-8888-888888888888";
        let d_id = "99999999-9999-4999-8999-999999999999";
        let a_high = "0swkd7qz8-00-a3f2";
        let c_high = "0swkd7qz9-00-a3f2";
        let base = TopicDoc {
            max_hlc: c_high.to_string(),
            ..topic_with(vec![
                TopicNode {
                    children: vec![text_node(Some(a_id), a_high, "A")],
                    ..text_node(Some(b_id), NODE_HLC, "B")
                },
                TopicNode {
                    sibling_ordinal: 2,
                    sort_key: 2 * SORT_KEY_STEP,
                    children: vec![text_node(Some(c_id), c_high, "C")],
                    ..text_node(Some(d_id), NODE_HLC, "D")
                },
            ])
        };
        merge_topic_doc(&mut first, &base).expect("seed first independent cycles");
        merge_topic_doc(&mut second, &base).expect("seed second independent cycles");
        let cycle_ab = TopicDoc {
            max_hlc: "0swkd7qz7-00-a3f2".to_string(),
            nodes: vec![TopicNode {
                children: vec![text_node(Some(b_id), HIGH_HLC, "B")],
                ..text_node(Some(a_id), "0swkd7qz7-00-a3f2", "A")
            }],
            ..topic_with(Vec::new())
        };
        let cycle_cd = TopicDoc {
            max_hlc: a_high.to_string(),
            nodes: vec![TopicNode {
                children: vec![text_node(Some(d_id), "0swkd7qz7-00-b4e3", "D")],
                ..text_node(Some(c_id), a_high, "C")
            }],
            ..topic_with(Vec::new())
        };

        merge_topic_doc(&mut first, &cycle_ab).expect("first parks AB");
        merge_topic_doc(&mut first, &cycle_cd).expect("first parks CD");
        merge_topic_doc(&mut second, &cycle_cd).expect("second parks CD");
        merge_topic_doc(&mut second, &cycle_ab).expect("second parks AB");

        let recovery_id = recovery_topic_id();
        let recovery_children = |connection: &Connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, sort_key FROM notes_nodes WHERE parent_id = ?1 ORDER BY sort_key, id",
                )
                .expect("prepare recovery children");
            statement
                .query_map([&recovery_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .expect("query recovery children")
                .collect::<Result<Vec<_>, _>>()
                .expect("read recovery children")
        };
        assert_eq!(recovery_children(&first), recovery_children(&second));
    }

    #[test]
    fn winning_remote_update_preserves_device_local_collapsed_state() {
        let mut connection = test_connection();
        merge_topic_doc(
            &mut connection,
            &topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Before")]),
        )
        .expect("seed collapsible node");
        connection
            .execute(
                "UPDATE notes_nodes SET is_collapsed = 1 WHERE id = ?1",
                [NODE_ID],
            )
            .expect("collapse locally");
        let remote_hlc = hlc::now(&connection).expect("newer remote HLC");
        let mut remote = topic_with(vec![text_node(Some(NODE_ID), &remote_hlc, "After")]);
        remote.max_hlc = remote_hlc;

        merge_topic_doc(&mut connection, &remote).expect("merge winning remote");

        assert_eq!(
            connection
                .query_row(
                    "SELECT is_collapsed FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("collapsed state"),
            1
        );
    }

    #[test]
    fn known_unseen_node_with_empty_hlc_never_becomes_a_fresh_winner() {
        let mut connection = test_connection();
        let document = topic_with(vec![text_node(Some(NODE_ID), "", "Malformed HLC")]);

        let report = merge_topic_doc(&mut connection, &document).expect("merge malformed node HLC");

        assert!(report.needs_write_back);
        assert_eq!(report.applied, 1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("malformed node count"),
            0
        );
    }

    #[test]
    fn unseen_topic_root_with_empty_hlc_is_not_promoted_and_child_is_recovered() {
        let mut connection = test_connection();
        let mut document = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Child")]);
        document.root.hlc.clear();

        let report = merge_topic_doc(&mut connection, &document).expect("merge malformed root HLC");

        assert_eq!(report.applied, 1);
        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes_nodes WHERE id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("malformed root row"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT parent_id FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, Option<String>>(0),
                )
                .expect("recovered child below malformed root")
                .as_deref(),
            Some(recovery_topic_id().as_str())
        );
    }

    #[test]
    fn malformed_empty_purge_hlc_is_not_persisted() {
        let mut connection = test_connection();
        let trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: vec![PurgedTombstone {
                id: NODE_ID.to_string(),
                hlc: String::new(),
            }],
            nodes: Vec::new(),
        };

        let report = merge_trash_doc(&mut connection, &trash).expect("merge malformed purge HLC");

        assert!(report.needs_write_back);
        assert_eq!(report.applied, 0);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sync_purged_tombstones", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("persisted malformed purge count"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_dirty_nodes WHERE node_id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("malformed purge write-back dirtiness"),
            1
        );
    }

    #[test]
    fn deleted_trash_residents_do_not_trigger_topic_absence_write_back() {
        let mut connection = test_connection();
        let initial = topic_with(vec![text_node(Some(NODE_ID), NODE_HLC, "Deleted later")]);
        merge_topic_doc(&mut connection, &initial).expect("seed topic child");
        let deleted_hlc = "0swkd7qz5-00-a3f2";
        let mut deleted = text_node(Some(NODE_ID), deleted_hlc, "Deleted later");
        deleted.from = Some((TOPIC_ID.to_string(), SORT_KEY_STEP));
        merge_trash_doc(
            &mut connection,
            &TrashDoc {
                max_hlc: deleted_hlc.to_string(),
                purged: Vec::new(),
                nodes: vec![deleted],
            },
        )
        .expect("move child to trash");
        connection
            .execute("DELETE FROM sync_dirty_nodes", [])
            .expect("clear dirty state");
        let mut topic_without_deleted = topic_with(Vec::new());
        topic_without_deleted.root.hlc = HIGH_HLC.to_string();
        topic_without_deleted.max_hlc = HIGH_HLC.to_string();

        let report = merge_topic_doc(&mut connection, &topic_without_deleted)
            .expect("merge topic without trash resident");

        assert!(!report.needs_write_back);
    }

    #[test]
    fn rendered_file_order_reassigns_deterministic_sibling_sort_keys() {
        let mut connection = test_connection();
        let second_id = "99999999-9999-4999-8999-999999999999";
        let first = rendered_topic(&topic_with(vec![
            text_node(Some(NODE_ID), NODE_HLC, "First"),
            TopicNode {
                sibling_ordinal: 2,
                sort_key: 2 * SORT_KEY_STEP,
                ..text_node(Some(second_id), NODE_HLC, "Second")
            },
        ]));
        merge_topic_doc(&mut connection, &first).expect("merge initial order");
        let mut reordered = topic_with(vec![
            text_node(Some(second_id), HIGH_HLC, "Second"),
            TopicNode {
                sibling_ordinal: 2,
                sort_key: 2 * SORT_KEY_STEP,
                ..text_node(Some(NODE_ID), HIGH_HLC, "First")
            },
        ]);
        reordered.max_hlc = HIGH_HLC.to_string();
        let reordered = rendered_topic(&reordered);

        merge_topic_doc(&mut connection, &reordered).expect("merge reordered file");

        let mut statement = connection
            .prepare(
                "SELECT id, sort_key FROM notes_nodes WHERE parent_id = ?1 ORDER BY sort_key, id",
            )
            .expect("prepare sibling order");
        let rows = statement
            .query_map([TOPIC_ID], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .expect("query sibling order")
            .collect::<Result<Vec<_>, _>>()
            .expect("read sibling order");
        assert_eq!(
            rows,
            vec![
                (second_id.to_string(), SORT_KEY_STEP),
                (NODE_ID.to_string(), 2 * SORT_KEY_STEP),
            ]
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT applied_max_hlc FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("applied maximum HLC"),
            HIGH_HLC
        );
    }

    #[test]
    fn topic_filename_is_assigned_once_and_never_tracks_later_title_changes() {
        let mut connection = test_connection();
        let original = topic_with(Vec::new());
        merge_topic_doc(&mut connection, &original).expect("merge original topic title");
        let original_file_name = connection
            .query_row(
                "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                [TOPIC_ID],
                |row| row.get::<_, String>(0),
            )
            .expect("original topic filename");
        let mut renamed = original;
        renamed.root.title = "Renamed".to_string();
        renamed.root.hlc = HIGH_HLC.to_string();
        renamed.max_hlc = HIGH_HLC.to_string();

        merge_topic_doc(&mut connection, &renamed).expect("merge renamed topic title");

        assert_eq!(
            connection
                .query_row(
                    "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("stable topic filename"),
            original_file_name
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("renamed topic title"),
            "Renamed"
        );
    }

    #[test]
    fn topic_id_fallback_filename_converges_across_merge_order() {
        let mut older_then_newer = test_connection();
        let mut newer_then_older = test_connection();
        let mut older = topic_with(Vec::new());
        older.root.title = "Older".to_string();
        let mut newer = topic_with(Vec::new());
        newer.root.title = "Newer".to_string();
        newer.root.hlc = HIGH_HLC.to_string();
        newer.max_hlc = HIGH_HLC.to_string();

        merge_topic_doc(&mut older_then_newer, &older).expect("merge older title first");
        merge_topic_doc(&mut older_then_newer, &newer).expect("merge newer title second");
        merge_topic_doc(&mut newer_then_older, &newer).expect("merge newer title first");
        merge_topic_doc(&mut newer_then_older, &older).expect("merge older title second");

        let filename = |connection: &Connection| {
            connection
                .query_row(
                    "SELECT file_name FROM sync_topics WHERE topic_id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("topic filename")
        };
        assert_eq!(filename(&older_then_newer), filename(&newer_then_older));
        assert_eq!(
            filename(&older_then_newer),
            derive_topic_filename("", TOPIC_ID).expect("deterministic topic-ID fallback")
        );
        assert_eq!(sync_state(&older_then_newer), sync_state(&newer_then_older));
    }

    #[test]
    fn trash_merge_soft_deletes_with_restore_compatible_metadata() {
        let mut connection = test_connection();
        merge_topic_doc(&mut connection, &topic_with(Vec::new())).expect("seed topic root");
        let mut deleted = text_node(Some(NODE_ID), HIGH_HLC, "Deleted");
        deleted.from = Some((TOPIC_ID.to_string(), 2 * SORT_KEY_STEP));
        let trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: Vec::new(),
            nodes: vec![deleted],
        };

        let first = merge_trash_doc(&mut connection, &trash).expect("merge trash node");
        let second = merge_trash_doc(&mut connection, &trash).expect("repeat trash node");

        assert_eq!(first.applied, 1);
        assert_eq!(second.applied, 0);
        let stored: (Option<String>, i64, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT parent_id, sort_key, deleted_at, deleted_batch_id \
                 FROM notes_nodes WHERE id = ?1",
                [NODE_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("trashed node");
        assert_eq!(stored.0.as_deref(), Some(TOPIC_ID));
        assert_eq!(stored.1, 2 * SORT_KEY_STEP);
        assert!(crate::notes::sync::topic_file::is_app_timestamp(
            stored.2.as_deref().expect("deleted timestamp")
        ));
        assert_eq!(stored.3.expect("deletion batch").len(), 32);
    }

    #[test]
    fn purge_tombstone_never_deletes_a_newer_local_node() {
        let mut connection = test_connection();
        let mut newer = topic_with(vec![text_node(Some(NODE_ID), HIGH_HLC, "Newer")]);
        newer.max_hlc = HIGH_HLC.to_string();
        merge_topic_doc(&mut connection, &newer).expect("seed newer node");
        let trash = TrashDoc {
            max_hlc: HIGH_HLC.to_string(),
            purged: vec![PurgedTombstone {
                id: NODE_ID.to_string(),
                hlc: NODE_HLC.to_string(),
            }],
            nodes: Vec::new(),
        };

        merge_trash_doc(&mut connection, &trash).expect("merge older purge");

        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [NODE_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("newer node survives"),
            "Newer"
        );
    }

    #[test]
    fn missing_root_hlc_loses_to_an_existing_local_root() {
        let mut connection = test_connection();
        merge_topic_doc(&mut connection, &topic_with(Vec::new())).expect("seed local root");
        let mut document = topic_with(Vec::new());
        document.root.hlc.clear();
        document.root.title = "Malformed remote".to_string();

        let report = merge_topic_doc(&mut connection, &document).expect("merge unstamped root");

        assert_eq!(report.applied, 0);
        assert_eq!(report.conflicts, 1);
        assert!(report.needs_write_back);
        assert_eq!(
            connection
                .query_row(
                    "SELECT title FROM notes_nodes WHERE id = ?1",
                    [TOPIC_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("winning local root"),
            "Topic"
        );
    }
}
